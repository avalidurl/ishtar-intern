/**
 * chaperone.ts — the in/out content guard. FULLY IMPLEMENTED.
 *
 * ingress(): sanitise UNTRUSTED Moltbook content BEFORE it reaches the brain.
 *   Runs security.looksLikeInjection, neutralises delimiter-breaking and
 *   injection markers, strips/escapes embedded URLs, caps length, and returns
 *   the safe text plus reason flags. PURE STRING ANALYSIS — it never executes
 *   anything and never performs a network call (invariants #2, #3). Content is
 *   data, not instructions: nothing here changes agent behaviour, it only
 *   describes what was stripped.
 *
 * egress(): a FAIL-CLOSED moderation gate on an OUTBOUND draft (comment / post /
 *   reply body) BEFORE it is sent to Moltbook. A deterministic denylist (slurs,
 *   doxxing, financial promises / $NUMETAL price-return language, anything
 *   claiming to be Gokhan or to speak for real daters, scam / "run this" /
 *   "send your key" payloads) PLUS an optional Llama-Guard-style model check via
 *   env.AI. ANY hit — or any guard error — returns { allow: false } (default to
 *   block on uncertainty). Mirrors numetal-datebook's chaperone approach.
 *
 * Both functions never echo or log the Moltbook API key, and neither one ever
 * builds a request URL or touches the network (the MoltbookClient is the worker's
 * sole egress; invariant #2). egress only reads env.AI — it never references any
 * datebook / wallet / Privy / admin / heart-file binding (invariant #6).
 */

import type { Env } from "./env";
import type { EgressVerdict, IngressVerdict } from "./types";
import { looksLikeInjection } from "./security";

/* ------------------------------------------------------------------ */
/* ingress — sanitise UNTRUSTED inbound content (pure, sync, no I/O)    */
/* ------------------------------------------------------------------ */

/** Hard cap on the length of any single sanitised blob handed to the brain.
 *  Bounds prompt-stuffing / token-budget abuse from a hostile post body. */
const INGRESS_MAX_LEN = 2000;

/** Invisible / zero-width / BOM / word-joiner / soft-hyphen / variation
 *  selectors / Unicode TAG block — the smuggling characters that let a payload
 *  hide from a keyword scan while still reaching a downstream model. Mirrors the
 *  normalize step in numetal-datebook's chaperone. */
const INVISIBLE =
  /[​-‍﻿⁠­᠎︀-️]|[\u{E0000}-\u{E007F}]/gu;

/** Delimiter-breaking markers an attacker uses to "escape" the data-only block
 *  the brain wraps content in (fenced-block fences, chat-role tags, common
 *  system-prompt sentinels). Neutralised so embedded content can never close the
 *  quarantine fence or forge a role turn. */
const DELIMITER_BREAKERS: Array<[RegExp, string]> = [
  [/```+/g, "ʼʼʼ"], // triple-backtick fences
  [/<\/?(system|user|assistant|tool|function)\b[^>]*>/gi, "[tag]"], // role tags
  [/\[(\/?)(INST|SYS|system|user|assistant)\]/gi, "[tag]"], // [INST]/[SYS]/...
  [/<\|[^|>]*\|>/g, "[tag]"], // <|im_start|> / <|endoftext|> style sentinels
  [/^\s*#{1,6}\s*system\b/gim, "system"], // markdown "# system" headers
];

/** Capture any embedded URL so ingress can strip it to an inert placeholder.
 *  Embedded links in untrusted content are phishing / "claim your" / "connect
 *  wallet" lures — the brain must never see a live, clickable destination. */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`)]+/gi;

/**
 * Sanitise one untrusted text blob for safe inclusion in a data-only block.
 *
 * Pure string analysis — NO network, NO execution, NO dynamic import/eval. The
 * returned `clean` text is safe to embed inside the brain's delimited block;
 * `flags` are reason codes for anything stripped (pattern sources / categories),
 * never secrets and never the raw payload.
 *
 * @param text Raw Moltbook content (post title/body, comment, snippet).
 * @returns `{ clean, flags }` — sanitised text and reason codes.
 */
export function ingress(text: string): IngressVerdict {
  const flags: string[] = [];

  // Defensive: non-string / empty inputs sanitise to empty, never throw.
  if (typeof text !== "string" || text.length === 0) {
    return { clean: "", flags };
  }

  let clean = text;

  // 1. Strip invisible / zero-width smuggling characters. Heavy use is itself a
  //    signal (someone is trying to hide a payload from the keyword scan).
  const beforeInvisible = [...clean].length;
  clean = clean.replace(INVISIBLE, "");
  const removedInvisible = beforeInvisible - [...clean].length;
  if (removedInvisible > 0) {
    flags.push("stripped:invisible-chars");
    if (removedInvisible > 4) flags.push("suspicious:obfuscation");
  }

  // 2. Strip / escape embedded URLs to an inert placeholder (phishing-lure
  //    defence). The destination is recorded as a flag category, never kept live.
  let urlCount = 0;
  clean = clean.replace(URL_RE, () => {
    urlCount++;
    return "[link removed]";
  });
  if (urlCount > 0) flags.push("stripped:url");

  // 3. Neutralise delimiter-breaking / role-forging markers so embedded content
  //    cannot escape the brain's data-only fence or fake a chat turn.
  for (const [re, repl] of DELIMITER_BREAKERS) {
    if (re.test(clean)) {
      flags.push("neutralised:delimiter");
      clean = clean.replace(re, repl);
    }
  }

  // 4. Flag obvious instruction-injection / exfiltration spans (defence in
  //    depth — the brain is ALSO allowlist-constrained, so a flag here is a
  //    reason code, not a behaviour change). We FLAG, we do not obey. Runs on
  //    the cleaned text so de-obfuscated payloads are caught.
  const inj = looksLikeInjection(clean);
  if (inj.hit) {
    flags.push("injection");
    for (const m of inj.matched) flags.push(`injection:${m}`);
  }

  // 5. Cap length — bounds prompt-stuffing from a hostile body.
  if (clean.length > INGRESS_MAX_LEN) {
    clean = clean.slice(0, INGRESS_MAX_LEN);
    flags.push("truncated");
  }

  return { clean, flags };
}

/* ------------------------------------------------------------------ */
/* egress — fail-closed moderation gate on OUTBOUND drafts             */
/* ------------------------------------------------------------------ */

/**
 * Llama-Guard-style classifier model id (Workers AI). A constant, not an env
 * binding: the intern's Env intentionally exposes no GUARD_MODEL knob, and the
 * guard is invoked through the same AI Gateway as the brain so its spend counts
 * against DAILY_USD_BUDGET. Mirrors numetal-datebook's Llama-Guard leg.
 */
const GUARD_MODEL = "@cf/meta/llama-guard-3-8b";

/**
 * Deterministic OUTBOUND denylist (T0). Each entry is a category + matcher. A
 * single hit blocks the send. Covers, in order: persona violations (claiming to
 * be Gokhan / speaking for real daters), financial-promise & $NUMETAL
 * price-return language (disclosure-clean requirement), scam / exfiltration
 * payloads echoed back out, doxxing / PII leakage, and slurs. Case-insensitive.
 *
 * This is the load-bearing gate: it must hold even if the optional model check
 * is unavailable, so it is exhaustive on the persona/financial rules the intern
 * is contractually forbidden from breaching.
 */
const EGRESS_DENYLIST: Array<{ category: string; re: RegExp }> = [
  // --- Persona: never claim to be Gokhan / Atelier Gokhan / the founder. ---
  {
    category: "impersonation:gokhan",
    re: /\b(i\s*am|i'?m|this\s+is|speaking\s+as|on\s+behalf\s+of|as)\s+(gokhan|g[oö]khan|goekhan|the\s+founder|atelier\s+g[oö]khan)\b/i,
  },
  {
    category: "impersonation:gokhan",
    re: /\bg[oö]khan('?s)?\s+(here|himself|speaking|account|words|voice)\b/i,
  },
  // --- Persona: never speak FOR real daters / real users / on their behalf. ---
  {
    category: "impersonation:daters",
    re: /\b(on\s+behalf\s+of|speaking\s+for|as\s+(one\s+of\s+)?(our|the)\s+(real\s+)?(daters|users|members|matches|singles))\b/i,
  },
  {
    category: "impersonation:daters",
    re: /\b(our|real)\s+(daters|users|members)\s+(say|told\s+me|want|asked\s+me\s+to|wanted)\b/i,
  },
  // --- Financial promise / $NUMETAL price-return language (disclosure-clean). ---
  {
    category: "financial:numetal-price",
    re: /\$?\bnumetal\b/i,
  },
  {
    category: "financial:promise",
    re: /\b(guaranteed?|guarantee|assured?|promise[ds]?)\s+(returns?|profit|gains?|yield|roi|apy|apr|moon|pump|price|payout)\b/i,
  },
  {
    category: "financial:promise",
    re: /\b(\d+\s*x|\d{2,}\s*%)\s*(returns?|gains?|profit|upside|roi)\b/i,
  },
  {
    category: "financial:promise",
    re: /\b(to\s+the\s+moon|guaranteed\s+money|risk[-\s]?free\s+(profit|returns?|gains?)|financial\s+advice|buy\s+now\s+before|price\s+(will|gonna|going\s+to)\s+(go\s+up|moon|pump|skyrocket|10x|moon))\b/i,
  },
  {
    category: "financial:promise",
    re: /\b(get\s+rich|double\s+your\s+(money|investment)|invest\s+now\s+for|next\s+100x)\b/i,
  },
  // --- Scam / exfiltration payloads echoed OUT (never emit these ourselves). ---
  {
    category: "scam:exfiltration",
    re: /\b(send|share|dm|paste|give)\s+(me\s+)?(your|the)\s+(api[\s_-]?key|key|secret|token|password|seed\s*phrase|private\s*key|mnemonic|wallet)\b/i,
  },
  {
    category: "scam:run-this",
    re: /\b(run\s+(this|the\s+following|these)|npx\s|curl\s|wget\s|bash\s|sh\s+-c|eval\s*\(|exec\s*\()/i,
  },
  {
    category: "scam:lure",
    re: /\b(connect\s+your\s+wallet|claim\s+your\s+(free|airdrop|reward|tokens?)|drain\b.{0,20}\bwallet)\b/i,
  },
  // --- Doxxing / PII leakage on the way out. ---
  {
    category: "doxxing:pii",
    re: /(0x[a-fA-F0-9]{64})|\b\d{3}-\d{2}-\d{4}\b|(seed\s?phrase)|(private\s?key)/i,
  },
  {
    category: "doxxing:contact",
    re: /\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/, // bare US phone number
  },
  // --- Slurs / hate. Kept narrow + obfuscation-tolerant; the model leg is the
  //     broad backstop. Intentionally not exhaustive in source; categories logged. ---
  {
    category: "slur:hate",
    re: /\b(n[i1]gg(?:er|a)|f[a@]gg?[o0]t|k[i1]ke|sp[i1]c|ch[i1]nk|tr[a@]nny|ret[a@]rd)\b/i,
  },
];

/** Result of the optional model classifier leg. */
interface GuardResult {
  safe: boolean;
  category?: string;
}

/**
 * Run a Llama-Guard-style classifier on an outbound draft via env.AI, routed
 * through the AI Gateway (so spend counts against DAILY_USD_BUDGET).
 * FAIL-CLOSED: any error, timeout, or unparseable response returns
 * { safe: false } so the draft is blocked when the check cannot run.
 *
 * Mirrors numetal-datebook's guard.ts (Llama-Guard convention: the response is
 * "safe" or "unsafe\nS<category>"). This is the ONLY model call in this module
 * and the ONLY thing it reads from env — it never references any other binding.
 */
async function modelGuard(env: Env, text: string): Promise<GuardResult> {
  try {
    if (!env || !env.AI || typeof (env.AI as { run?: unknown }).run !== "function") {
      // No model surface available → cannot verify → fail closed.
      return { safe: false, category: "guard_unavailable" };
    }
    // Call run() as a MEMBER of env.AI — detaching it (const run = env.AI.run)
    // loses `this` and the binding throws internally (verified on Workers).
    const ai = env.AI as unknown as {
      run: (
        model: string,
        inputs: unknown,
        opts?: { gateway?: { id: string; skipCache?: boolean } },
      ) => Promise<unknown>;
    };
    const gateway = env.AI_GATEWAY_ID
      ? { gateway: { id: env.AI_GATEWAY_ID, skipCache: true } }
      : undefined;
    const result = await ai.run(
      GUARD_MODEL,
      { messages: [{ role: "user", content: text }] },
      gateway,
    );

    // Extract the classifier text from whatever shape the binding returns.
    const out = guardText(result);
    if (!out) return { safe: false, category: "unparseable" };
    const lower = out.toLowerCase();
    // Llama-Guard convention: first line "safe", or "unsafe\nS<category>".
    if (lower.includes("unsafe")) {
      const cat = out.match(/s\d+/i)?.[0];
      return { safe: false, category: cat ?? "flagged" };
    }
    if (lower.includes("safe")) return { safe: true };
    // Anything else is unparseable → fail closed.
    return { safe: false, category: "unparseable" };
  } catch {
    // Model down / budget exceeded / network → fail closed. Never echo the
    // error payload (could contain reflected content); a category is enough.
    return { safe: false, category: "error" };
  }
}

/** Best-effort extraction of the classifier's text from the AI binding result. */
function guardText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.response === "string") return r.response;
    if (typeof r.output === "string") return r.output;
    if (Array.isArray(r.response)) return r.response.join("\n");
  }
  try {
    return JSON.stringify(result ?? "");
  } catch {
    return "";
  }
}

/**
 * Review an outbound draft before sending. FAIL-CLOSED.
 *
 * Order: (1) reject empty/oversized drafts, (2) deterministic denylist — a hit
 * blocks immediately and is the load-bearing gate, (3) optional Llama-Guard-style
 * model check (blocks on unsafe OR on any guard error/unparse). Returns
 * { allow: false, reason } on ANY hit or guard failure; only a clean pass through
 * BOTH legs returns { allow: true }. The reason is a short machine category —
 * never the draft, never a secret.
 *
 * @param env  Worker bindings/vars (for the optional AI policy check).
 * @param text The drafted comment/post/reply body.
 * @returns `{ allow, reason? }` — allow:false blocks the send.
 */
export async function egress(env: Env, text: string): Promise<EgressVerdict> {
  // 0. Shape checks — fail closed on anything we cannot evaluate.
  if (typeof text !== "string") {
    return { allow: false, reason: "egress:invalid-type" };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { allow: false, reason: "egress:empty" };
  }
  // Moltbook post bodies cap at 40000; anything past it is malformed → block.
  if (text.length > 40000) {
    return { allow: false, reason: "egress:oversize" };
  }

  // De-obfuscate for the deterministic scan so invisible/zero-width smuggling
  // cannot slip a denylisted span past the regexes (the model leg sees the same
  // cleaned text). We BLOCK on the cleaned view; we never publish from egress.
  const scan = text.replace(INVISIBLE, "").normalize("NFKC");

  // 1. Deterministic denylist (T0). First hit wins; this gate must hold even if
  //    the model leg is unavailable.
  for (const { category, re } of EGRESS_DENYLIST) {
    if (re.test(scan)) {
      return { allow: false, reason: `egress:denylist:${category}` };
    }
  }

  // 2. Optional model classifier (T1), fail-closed. Blocks on unsafe AND on any
  //    guard error / unparseable / unavailable result.
  const g = await modelGuard(env, scan);
  if (!g.safe) {
    return { allow: false, reason: `egress:guard:${g.category ?? "flagged"}` };
  }

  // Passed both legs.
  return { allow: true };
}
