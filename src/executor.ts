/**
 * executor.ts — turns a validated ActionPlan into Moltbook writes.
 *
 * SECURITY CONTRACT (enforced below; adversarially tested):
 *  - Re-validate EVERY action against security.isAllowedAction (defence in
 *    depth — never trust the plan blindly). Drop anything off-allowlist.
 *  - Kill switch: read settings.enabled; if not "true", perform NO writes.
 *  - Budget: enforce DAILY_ACTION_BUDGET (count) and DAILY_USD_BUDGET (spend)
 *    via budget_counters; stop the moment either cap is hit.
 *  - Per-action-type rate limits from action_log timestamps:
 *      post    : 1 / 30 min,
 *      comment : 1 / 20 s   (replies are comments),
 *      writes  : 50 / day per type.
 *  - Run every outbound body (post/comment/reply) through chaperone.egress;
 *    block on allow:false.
 *  - De-dup via seen_posts so the same item is not acted on twice.
 *  - If a write returns a verification challenge, solve the math and POST
 *    /verify (each verify attempt counts toward budget; bail after a few
 *    consecutive failures so we never trip Moltbook's auto-suspend).
 *  - Append every attempt to action_log. Never log the API key.
 *  - The MoltbookClient is the ONLY egress; do not fetch() here, no eval, no
 *    dynamic import, no shell. There is intentionally no DM path (invariant #4).
 *  - ZERO datebook/Ishtar/wallet/Privy access — the worker has no such bindings
 *    and this module references none.
 */

import type { Env } from "./env";
import type { Action, ActionPlan, VerificationChallenge } from "./types";
import { isAllowedAction } from "./security";
import { createMoltbookClient, MoltbookClient } from "./moltbook";
import type { WriteResult } from "./moltbook";
import * as chaperone from "./chaperone";

/** Per-action outcome record (mirrors a row appended to action_log). */
export interface ExecLogEntry {
  kind: string;
  target?: string;
  ok: boolean;
  detail?: string;
}

/** Aggregate result of executing a plan. */
export interface ExecResult {
  /** Count of actions successfully applied. */
  done: number;
  /** Count of actions skipped (kill switch, budget, de-dup, egress block, allowlist). */
  skipped: number;
  /** Ordered per-action log entries. */
  log: ExecLogEntry[];
}

/* ------------------------------------------------------------------ */
/* Rate-limit windows (ms) and per-day per-type cap                    */
/* ------------------------------------------------------------------ */

/** Minimum gap between two of OUR posts. */
const POST_MIN_INTERVAL_MS = 30 * 60 * 1000;
/** Minimum gap between two of OUR comments/replies. */
const COMMENT_MIN_INTERVAL_MS = 20 * 1000;
/** Per-write-type daily ceiling (independent of the global action budget). */
const PER_TYPE_DAILY_CAP = 50;
/** Bail after this many consecutive verification failures to dodge auto-suspend. */
const MAX_VERIFY_FAILURES = 3;
/** Per-write verify attempt ceiling (one challenge should be one solve). */
const MAX_VERIFY_ATTEMPTS_PER_WRITE = 2;

/** Write-type discriminants we rate-limit / count. `noop` is never a write. */
type WriteKind = "upvote" | "comment" | "reply" | "post" | "follow";

/** UTC day key 'YYYY-MM-DD' (matches budget_counters.day and SQLite date('now')). */
function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* D1 helpers — the ONLY state this worker touches                     */
/* ------------------------------------------------------------------ */

/** Read settings.enabled; true ONLY when the stored value is exactly "true". */
async function killSwitchOn(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'enabled'",
  ).first<{ value: string }>();
  return row?.value === "true";
}

/** Current per-UTC-day budget counters (defaults to zeroes if no row yet). */
async function readBudget(
  env: Env,
  day: string,
): Promise<{ actions: number; usd: number }> {
  const row = await env.DB.prepare(
    "SELECT actions, usd FROM budget_counters WHERE day = ?1",
  )
    .bind(day)
    .first<{ actions: number; usd: number }>();
  return { actions: row?.actions ?? 0, usd: row?.usd ?? 0 };
}

/** Atomically bump today's action counter by `n` (creating the row if needed). */
async function bumpActions(env: Env, day: string, n: number): Promise<void> {
  if (n <= 0) return;
  await env.DB.prepare(
    `INSERT INTO budget_counters (day, actions, usd) VALUES (?1, ?2, 0)
     ON CONFLICT(day) DO UPDATE SET actions = actions + ?2`,
  )
    .bind(day, n)
    .run();
}

/** Append one attempt to the append-only audit log. NEVER pass a secret here. */
async function logAttempt(env: Env, e: ExecLogEntry): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO action_log (kind, target, ok, detail) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(e.kind, e.target ?? null, e.ok ? 1 : 0, e.detail ?? null)
    .run();
}

/** Has this post already been considered/acted on? */
async function alreadySeen(env: Env, postId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS one FROM seen_posts WHERE post_id = ?1",
  )
    .bind(postId)
    .first<{ one: number }>();
  return row != null;
}

/** Mark a post id as seen (idempotent). */
async function markSeen(env: Env, postId: string): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO seen_posts (post_id) VALUES (?1)",
  )
    .bind(postId)
    .run();
}

/**
 * Per-type rate-limit gate from action_log timestamps.
 * Returns null if allowed, or a short reason string if the write must be skipped.
 * Only successful writes (ok=1) count toward intervals and the daily cap.
 */
async function rateLimitReason(
  env: Env,
  kind: WriteKind,
): Promise<string | null> {
  // post / comment minimum-interval windows.
  const minIntervalMs =
    kind === "post"
      ? POST_MIN_INTERVAL_MS
      : kind === "comment" || kind === "reply"
        ? COMMENT_MIN_INTERVAL_MS
        : 0;

  // For comments and replies we share one "comment" window (a reply IS a comment).
  const intervalKinds: string[] =
    kind === "comment" || kind === "reply"
      ? ["comment", "reply"]
      : [kind];
  const placeholders = intervalKinds.map((_, i) => `?${i + 1}`).join(", ");

  if (minIntervalMs > 0) {
    const last = await env.DB.prepare(
      `SELECT created_at FROM action_log
       WHERE ok = 1 AND kind IN (${placeholders})
       ORDER BY id DESC LIMIT 1`,
    )
      .bind(...intervalKinds)
      .first<{ created_at: string }>();
    if (last?.created_at) {
      // SQLite datetime('now') is UTC 'YYYY-MM-DD HH:MM:SS'; parse as UTC.
      const lastMs = Date.parse(last.created_at.replace(" ", "T") + "Z");
      if (Number.isFinite(lastMs) && Date.now() - lastMs < minIntervalMs) {
        return `rate_limit:${kind}:min_interval`;
      }
    }
  }

  // Per-type daily cap (UTC day), shared across comment/reply.
  const day = utcDay();
  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM action_log
     WHERE ok = 1 AND kind IN (${placeholders})
       AND substr(created_at, 1, 10) = ?${intervalKinds.length + 1}`,
  )
    .bind(...intervalKinds, day)
    .first<{ n: number }>();
  if ((countRow?.n ?? 0) >= PER_TYPE_DAILY_CAP) {
    return `rate_limit:${kind}:daily_cap`;
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Verification handshake (math challenge solver)                      */
/* ------------------------------------------------------------------ */

/**
 * Parse and solve the obfuscated math word-problem. The challenge text is
 * UNTRUSTED — we extract ONLY two integers and one operator, never execute it.
 * Returns the answer formatted to exactly 2 decimals, or null if unparseable.
 */
export function solveChallenge(ch: VerificationChallenge): string | null {
  const text = typeof ch?.challenge_text === "string" ? ch.challenge_text : "";
  if (!text) return null;

  // Find the first arithmetic expression of the form `<int> <op> <int>`.
  // We deliberately match a tight numeric pattern — no eval, no Function.
  const m = text.match(
    /(-?\d{1,9})\s*(\+|-|x|\*|×|÷|\/|plus|minus|times|multiplied by|divided by)\s*(-?\d{1,9})/i,
  );
  if (!m) return null;

  const a = Number(m[1]);
  const b = Number(m[3]);
  const opRaw = (m[2] ?? "").toLowerCase();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  let result: number;
  switch (opRaw) {
    case "+":
    case "plus":
      result = a + b;
      break;
    case "-":
    case "minus":
      result = a - b;
      break;
    case "x":
    case "*":
    case "×":
    case "times":
    case "multiplied by":
      result = a * b;
      break;
    case "/":
    case "÷":
    case "divided by":
      if (b === 0) return null;
      result = a / b;
      break;
    default:
      return null;
  }

  if (!Number.isFinite(result)) return null;
  return result.toFixed(2);
}

/** Discriminate the WriteResult union without trusting structural fields. */
function needsVerification<T>(
  r: WriteResult<T>,
): r is { verification_required: true; post: { verification: VerificationChallenge } } {
  return (
    typeof r === "object" &&
    r !== null &&
    (r as { verification_required?: unknown }).verification_required === true
  );
}

/**
 * Drive one write through the verification handshake under a tight retry cap.
 *
 * @param client   The sole egress client.
 * @param doWrite  Performs the (re)write and returns its WriteResult.
 * @returns `{ ok, verifyAttempts, detail }` — ok=true once the write lands;
 *          verifyAttempts is how many /verify calls we made (counts toward budget).
 */
async function settleWrite<T>(
  client: MoltbookClient,
  doWrite: () => Promise<WriteResult<T>>,
): Promise<{ ok: boolean; verifyAttempts: number; detail?: string }> {
  let verifyAttempts = 0;
  let consecutiveFailures = 0;

  // Initial write.
  let result: WriteResult<T>;
  try {
    result = await doWrite();
  } catch (err) {
    return { ok: false, verifyAttempts, detail: errMsg(err) };
  }

  if (!needsVerification(result)) {
    return { ok: true, verifyAttempts };
  }

  // Verification loop — bounded by attempt cap AND consecutive-failure cap.
  while (
    verifyAttempts < MAX_VERIFY_ATTEMPTS_PER_WRITE &&
    consecutiveFailures < MAX_VERIFY_FAILURES
  ) {
    const challenge = result.post?.verification;
    const answer = challenge ? solveChallenge(challenge) : null;
    if (!challenge || answer === null) {
      return { ok: false, verifyAttempts, detail: "verify:unparseable_challenge" };
    }

    verifyAttempts += 1;
    try {
      await client.verify({
        verification_code: challenge.verification_code,
        answer,
      });
    } catch (err) {
      consecutiveFailures += 1;
      // Stop the moment we risk Moltbook's 10-consecutive-failure auto-suspend.
      if (consecutiveFailures >= MAX_VERIFY_FAILURES) {
        return { ok: false, verifyAttempts, detail: "verify:failed" };
      }
      continue;
    }

    // Verified — replay the write to land it.
    try {
      result = await doWrite();
    } catch (err) {
      return { ok: false, verifyAttempts, detail: errMsg(err) };
    }
    if (!needsVerification(result)) {
      return { ok: true, verifyAttempts };
    }
    // Still challenged: loop again (new challenge), under the same caps.
  }

  return { ok: false, verifyAttempts, detail: "verify:exhausted" };
}

/** Coerce any thrown value to a short, secret-free string for the audit log. */
function errMsg(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Defensive: never let a stray "Bearer ..." reach the log.
  return msg.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 200);
}

/* ------------------------------------------------------------------ */
/* execute()                                                           */
/* ------------------------------------------------------------------ */

/**
 * Execute a plan under all guards (kill switch, budgets, rate limits, egress,
 * de-dup, allowlist, verification handshake).
 *
 * Each attempt is recorded to action_log; budget_counters.actions is bumped per
 * landed write (and per verify attempt). Returns `{ done, skipped, log }`.
 *
 * @param env  Worker bindings/vars.
 * @param plan The brain's validated ActionPlan.
 */
export async function execute(env: Env, plan: ActionPlan): Promise<ExecResult> {
  const log: ExecLogEntry[] = [];
  let done = 0;
  let skipped = 0;

  const actions: Action[] = Array.isArray(plan?.actions) ? plan.actions : [];

  // The MoltbookClient is the ONLY network egress. Constructed once, here.
  const client = createMoltbookClient(env.MOLTBOOK_API_KEY);

  // Kill switch — read ONCE up front. If off, NO writes happen this run.
  const enabled = await killSwitchOn(env);

  // Budget caps — parsed defensively (env vars are strings).
  const actionBudget = clampInt(env.DAILY_ACTION_BUDGET, 0);
  const usdBudget = clampFloat(env.DAILY_USD_BUDGET, 0);
  const day = utcDay();
  let budget = await readBudget(env, day);

  // Track how many writes we've landed this run so the in-memory action count
  // stays consistent even within a single execute() call.
  for (const action of actions) {
    // (1) Defence-in-depth allowlist re-validation. Anything off-list is dropped.
    if (!action || !isAllowedAction(action.kind)) {
      skipped += 1;
      const entry: ExecLogEntry = {
        kind: "invalid",
        ok: false,
        detail: "off_allowlist",
      };
      log.push(entry);
      await logAttempt(env, entry);
      continue;
    }

    // noop is the always-safe terminal: never a write, never gated.
    if (action.kind === "noop") {
      const entry: ExecLogEntry = {
        kind: "noop",
        ok: true,
        detail: action.note ? action.note.slice(0, 200) : undefined,
      };
      log.push(entry);
      await logAttempt(env, entry);
      continue;
    }

    // (2) Kill switch — if off, every write is skipped.
    if (!enabled) {
      skipped += 1;
      const entry = skipEntry(action, "kill_switch_off");
      log.push(entry);
      await logAttempt(env, entry);
      continue;
    }

    // (2b) Global daily action budget hard-stop.
    if (budget.actions >= actionBudget) {
      skipped += 1;
      const entry = skipEntry(action, "budget:actions");
      log.push(entry);
      await logAttempt(env, entry);
      continue;
    }
    // (2c) Global daily USD budget hard-stop (executor never spends, but if the
    // brain/chaperone already exhausted it we stop writing too).
    if (budget.usd >= usdBudget) {
      skipped += 1;
      const entry = skipEntry(action, "budget:usd");
      log.push(entry);
      await logAttempt(env, entry);
      continue;
    }

    // (3) Per-action-type rate limits from action_log timestamps.
    const rlReason = await rateLimitReason(env, action.kind);
    if (rlReason) {
      skipped += 1;
      const entry = skipEntry(action, rlReason);
      log.push(entry);
      await logAttempt(env, entry);
      continue;
    }

    // (4) De-dup for post-targeted actions (upvote/comment/reply on a post).
    const dedupId = dedupKey(action);
    if (dedupId && (await alreadySeen(env, dedupId))) {
      skipped += 1;
      const entry = skipEntry(action, "seen");
      log.push(entry);
      await logAttempt(env, entry);
      continue;
    }

    // (5) Egress chaperone for any outbound body (post/comment/reply).
    const body = outboundBody(action);
    if (body !== null) {
      let verdict;
      try {
        verdict = await chaperone.egress(env, body);
      } catch (err) {
        // Fail closed: a chaperone error must never let a body through.
        skipped += 1;
        const entry = skipEntry(action, "egress:error");
        log.push(entry);
        await logAttempt(env, entry);
        continue;
      }
      if (!verdict.allow) {
        skipped += 1;
        const entry = skipEntry(
          action,
          `egress:blocked${verdict.reason ? ":" + verdict.reason : ""}`,
        );
        log.push(entry);
        await logAttempt(env, entry);
        continue;
      }
    }

    // (6) Execute ONLY via the MoltbookClient allowlist methods + settle any
    //     verification challenge. No other call path exists.
    const target = actionTarget(action);
    let outcome: { ok: boolean; verifyAttempts: number; detail?: string };
    try {
      outcome = await runWrite(client, action);
    } catch (err) {
      outcome = { ok: false, verifyAttempts: 0, detail: errMsg(err) };
    }

    // (7) Budget accounting: each verify attempt + a landed write are "actions".
    const spent = outcome.verifyAttempts + (outcome.ok ? 1 : 0);
    if (spent > 0) {
      await bumpActions(env, day, spent);
      budget = { actions: budget.actions + spent, usd: budget.usd };
    }

    const entry: ExecLogEntry = {
      kind: action.kind,
      target,
      ok: outcome.ok,
      detail: outcome.detail,
    };
    log.push(entry);
    await logAttempt(env, entry);

    // De-dup mark + tally (mark on any attempt so we don't retry a poisoned item).
    if (dedupId) await markSeen(env, dedupId);
    if (outcome.ok) {
      done += 1;
    } else {
      skipped += 1;
    }
  }

  return { done, skipped, log };
}

/* ------------------------------------------------------------------ */
/* Action dispatch — ONLY MoltbookClient allowlist methods            */
/* ------------------------------------------------------------------ */

/**
 * Map a validated Action to its single MoltbookClient call. This switch is the
 * ONLY place the executor performs egress, and it touches ONLY allowlist
 * methods — there is no generic/dynamic dispatch, so content can never name a
 * method to invoke.
 */
async function runWrite(
  client: MoltbookClient,
  action: Action,
): Promise<{ ok: boolean; verifyAttempts: number; detail?: string }> {
  switch (action.kind) {
    case "upvote":
      return settleWrite(client, () => client.upvotePost(action.postId));

    case "comment":
      return settleWrite(client, () =>
        client.createComment(action.postId, { content: action.content }),
      );

    case "reply":
      return settleWrite(client, () =>
        client.createComment(action.postId, {
          content: action.content,
          parent_id: action.parentId,
        }),
      );

    case "post":
      return settleWrite(client, () =>
        client.createPost({
          submolt_name: action.submoltName,
          title: action.title,
          content: action.content,
          url: action.url,
          type: action.type,
        }),
      );

    case "follow":
      return settleWrite(client, () => client.follow(action.agentName));

    // `noop` is handled before dispatch and never reaches here; exhaustiveness
    // is enforced so a new kind cannot silently fall through to a write.
    case "noop":
      return { ok: true, verifyAttempts: 0 };

    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return { ok: false, verifyAttempts: 0, detail: "unhandled_kind" };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Small pure helpers                                                  */
/* ------------------------------------------------------------------ */

/** The outbound text body subject to egress, or null if the action has none. */
function outboundBody(action: Action): string | null {
  switch (action.kind) {
    case "comment":
    case "reply":
      return action.content;
    case "post":
      // Review title + body together; either can carry a policy violation.
      return [action.title, action.content ?? ""].join("\n");
    default:
      return null;
  }
}

/** De-dup key (the post id) for post-targeted actions; null otherwise. */
function dedupKey(action: Action): string | null {
  switch (action.kind) {
    case "upvote":
    case "comment":
    case "reply":
      return action.postId;
    default:
      // `post` (new content) and `follow` are not post-de-duped.
      return null;
  }
}

/** Human-readable target for the audit log. */
function actionTarget(action: Action): string | undefined {
  switch (action.kind) {
    case "upvote":
    case "comment":
    case "reply":
      return action.postId;
    case "post":
      return action.submoltName;
    case "follow":
      return action.agentName;
    default:
      return undefined;
  }
}

/** Build a "skipped" log entry for a write action. */
function skipEntry(action: Action, detail: string): ExecLogEntry {
  return {
    kind: action.kind,
    target: actionTarget(action),
    ok: false,
    detail,
  };
}

/** Parse a non-negative int from an env string; fall back to `dflt`. */
function clampInt(v: string | undefined, dflt: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** Parse a non-negative float from an env string; fall back to `dflt`. */
function clampFloat(v: string | undefined, dflt: number): number {
  const n = Number.parseFloat(v ?? "");
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}
