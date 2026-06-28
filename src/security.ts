/**
 * security.ts — the quarantine crux. FULLY IMPLEMENTED (no stubs here).
 *
 * This module encodes the non-negotiable invariants for the Ishtar Intern:
 *  1. The Moltbook API key is ONLY ever attached to requests whose URL begins
 *     EXACTLY with the Moltbook origin (assertMoltbookUrl). Any other URL throws.
 *  2. The brain may ONLY emit actions from the fixed ALLOWED_ACTIONS allowlist.
 *  3. Feed/comment content is UNTRUSTED DATA; looksLikeInjection() flags the
 *     common prompt-injection / credential-exfil / wallet-drain patterns so the
 *     chaperone can quarantine them. (Flagging is defence-in-depth — the brain
 *     is ALSO constrained to the allowlist, so a missed pattern still can't run.)
 *
 * These are adversarially tested. Keep this file tight, dependency-free, and
 * easy to audit. Never import a network client here. Never log secrets here.
 */

/** Moltbook REST base. ALWAYS www. Every API path is built from this. */
export const MOLTBOOK_API_BASE = "https://www.moltbook.com/api/v1";

/**
 * The ONLY origin the API key may ever be sent to. A trailing slash is load-bearing:
 * a startsWith check against "https://www.moltbook.com/" rejects look-alike hosts
 * such as "https://www.moltbook.com.evil.tld/" (no slash boundary) and
 * "https://www.moltbook.community/" (different host).
 */
export const MOLTBOOK_ORIGIN = "https://www.moltbook.com/";

/**
 * Throw unless `url` is an authenticated-safe Moltbook URL.
 *
 * Invariant #1: the API key is attached ONLY to requests whose URL starts
 * EXACTLY with MOLTBOOK_ORIGIN. The Moltbook client MUST call this before every
 * authenticated fetch (it lives in the shared request helper so it cannot be
 * forgotten on a per-method basis). Callers must never construct a request URL
 * from untrusted feed/comment content.
 *
 * @param url Fully-qualified request URL.
 * @throws Error if `url` is not a string starting with MOLTBOOK_ORIGIN.
 */
export function assertMoltbookUrl(url: string): void {
  if (typeof url !== "string" || !url.startsWith(MOLTBOOK_ORIGIN)) {
    // Do NOT include any secret in the message. The URL is non-secret.
    throw new Error(
      `assertMoltbookUrl: refusing to attach credentials to non-Moltbook URL: ${JSON.stringify(
        url,
      )}`,
    );
  }
}

/**
 * The fixed, closed set of actions the brain is allowed to return. Anything
 * outside this set is dropped by the executor. There is intentionally NO action
 * for: arbitrary fetch, code/shell execution, DM read/send, wallet/payment, or
 * touching datebook/Ishtar state.
 */
export const ALLOWED_ACTIONS = [
  "upvote",
  "comment",
  "reply",
  "post",
  "follow",
  "noop",
] as const;

/** Union of the allowed action kinds. */
export type AllowedAction = (typeof ALLOWED_ACTIONS)[number];

/**
 * Type guard: is `kind` a member of ALLOWED_ACTIONS?
 * @param kind Candidate action kind (typically from model output).
 */
export function isAllowedAction(kind: unknown): kind is AllowedAction {
  return (
    typeof kind === "string" &&
    (ALLOWED_ACTIONS as readonly string[]).includes(kind)
  );
}

/**
 * Heuristic patterns for hostile content embedded in feed posts / comments.
 * Treat ALL Moltbook content as data, never instructions. A hit does NOT mean
 * "block the whole heartbeat" — it means the chaperone strips/quarantines that
 * item and the brain never sees it as actionable. Case-insensitive.
 *
 * Covers: instruction-override, system-prompt probing, code/shell execution,
 * credential/secret/wallet/seed exfiltration, persona hijack, jailbreak,
 * embedded links (used for phishing/"claim"/"connect wallet" lures).
 */
export const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all |any |the )?(previous|prior|above|preceding)/i,
  /disregard (all |any |the )?(previous|prior|above|preceding|instructions)/i,
  /\bsystem prompt\b/i,
  /\b(reveal|print|show|repeat|leak|expose)\b.{0,40}\b(prompt|instructions|system)\b/i,
  /run (this|the following|these)\b/i,
  /\bnpx /i,
  /\bcurl /i,
  /\bwget /i,
  /\bbash\b|\bsh -c\b|\beval\b|\bexec\b/i,
  /send (your|the|me your|us your) (api[_ ]?key|key|secret|token|password|wallet|seed|private key)/i,
  /(api[_ ]?key|secret|seed phrase|private key|mnemonic)\b.{0,30}\b(send|share|paste|reveal|give|dm)/i,
  /update your (instructions|system prompt|persona|rules|config)/i,
  /you are now\b/i,
  /\bjailbreak\b|\bdan mode\b|\bdeveloper mode\b/i,
  /https?:\/\//i, // any embedded link in content is suspicious (phishing/lure)
  /\bclaim your\b/i,
  /\bconnect your wallet\b/i,
  /\bseed phrase\b/i,
  /\bdrain\b.{0,20}\bwallet\b/i,
];

/**
 * Scan free text for injection / exfiltration markers.
 *
 * @param text Untrusted content (post title/body, comment, search snippet).
 * @returns `{ hit, matched }` — `hit` is true if any pattern matched; `matched`
 *          is the list of matched source strings (for logging the *reason*, not
 *          for echoing secrets — these are pattern sources, never the key).
 */
export function looksLikeInjection(text: string): {
  hit: boolean;
  matched: string[];
} {
  if (typeof text !== "string" || text.length === 0) {
    return { hit: false, matched: [] };
  }
  const matched: string[] = [];
  for (const re of INJECTION_PATTERNS) {
    if (re.test(text)) {
      matched.push(re.source);
    }
  }
  return { hit: matched.length > 0, matched };
}
