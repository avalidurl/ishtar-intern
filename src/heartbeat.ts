/**
 * heartbeat.ts — one cron tick of the agent loop.
 *
 * Orchestration (these guarantees hold):
 *  1. Read settings.enabled — if not "true", return { ran:false, actions:0 }
 *     WITHOUT reading the feed or spending any AI budget (kill switch, inv. #5).
 *  2. Check daily budgets (actions + usd); if exhausted, return ran:false
 *     WITHOUT reading the feed or spending AI budget.
 *  3. Read a feed slice (FEED_SLICE) via MoltbookClient (DMs are OFF — never
 *     poll/read/send DMs, invariant #4). The client is the ONLY egress.
 *  4. Run each item through chaperone.ingress (invariant #3) and drop already-
 *     seen ids (seen_posts).
 *  5. brain.decide() -> validated ActionPlan (allowlist-only).
 *  6. executor.execute() applies it under all guards.
 *  7. Log a single summary line (NO secrets, NO key) and return.
 *
 * The MoltbookClient is the ONLY network egress. There is no fetch()/eval/
 * import/exec in this module. All untrusted feed content is treated as DATA.
 */

import type { Env } from "./env";
import type { BrainContext } from "./brain";
import { decide } from "./brain";
import { ingress } from "./chaperone";
import { execute } from "./executor";
import { createMoltbookClient } from "./moltbook";
import type { FeedItem, HomeSummary } from "./types";

/** Summary of one heartbeat tick. */
export interface HeartbeatResult {
  /** Whether the loop actually ran (false if kill switch off or budget spent). */
  ran: boolean;
  /** Number of write actions applied this tick. */
  actions: number;
}

/** The safe "did nothing" result. Re-used at every short-circuit. */
const IDLE: HeartbeatResult = { ran: false, actions: 0 };

/** UTC day key 'YYYY-MM-DD' — matches budget_counters.day in the schema. */
function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Parse a non-negative integer var, falling back to `fallback` on garbage. */
function intVar(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Parse a non-negative float var, falling back to `fallback` on garbage. */
function floatVar(raw: string | undefined, fallback: number): number {
  const n = Number.parseFloat(String(raw ?? ""));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Read settings.value for a key; undefined if missing. */
async function readSetting(env: Env, key: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value;
}

/** Today's budget counters (0/0 if no row yet). */
async function readBudget(
  env: Env,
  day: string,
): Promise<{ actions: number; usd: number }> {
  const row = await env.DB.prepare(
    "SELECT actions, usd FROM budget_counters WHERE day = ?",
  )
    .bind(day)
    .first<{ actions: number; usd: number }>();
  return {
    actions: row ? Number(row.actions) || 0 : 0,
    usd: row ? Number(row.usd) || 0 : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Feed normalisation                                                  */
/*                                                                     */
/* MoltbookClient.feed() returns `unknown` (the wire shape is the      */
/* server's, and it is UNTRUSTED). We defensively project it down to   */
/* the minimal FeedItem fields the brain needs. We NEVER execute,      */
/* eval, follow, or fetch anything from this content — it is data.     */
/* ------------------------------------------------------------------ */

/** Coerce a value to a trimmed string, or undefined. */
function asStr(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

/** Coerce a value to a finite number, or undefined. */
function asNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Project one raw feed record to a FeedItem; null if it has no usable id. */
function toFeedItem(raw: unknown): FeedItem | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = asStr(r.id) ?? asStr(r.post_id);
  if (!id) return null;
  const item: FeedItem = {
    id,
    title: asStr(r.title) ?? "",
  };
  const content = asStr(r.content) ?? asStr(r.body);
  if (content !== undefined) item.content = content;
  const url = asStr(r.url);
  if (url !== undefined) item.url = url;
  const submolt = asStr(r.submolt_name) ?? asStr(r.submolt);
  if (submolt !== undefined) item.submolt_name = submolt;
  const author = asStr(r.author) ?? asStr(r.author_name);
  if (author !== undefined) item.author = author;
  const score = asNum(r.score);
  if (score !== undefined) item.score = score;
  const cc = asNum(r.comment_count);
  if (cc !== undefined) item.comment_count = cc;
  return item;
}

/**
 * Pull the feed array out of whatever envelope Moltbook returns and project to
 * FeedItem[]. Accepts top-level arrays or common `{feed|posts|data|items:[...]}`
 * wrappers. Never throws on a surprising shape — returns [] instead.
 */
function normalizeFeed(raw: unknown): FeedItem[] {
  let arr: unknown;
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (raw && typeof raw === "object") {
    const r = raw as Partial<HomeSummary> & Record<string, unknown>;
    arr = r.feed ?? r.posts ?? r.data ?? r.items;
  }
  if (!Array.isArray(arr)) return [];
  const out: FeedItem[] = [];
  for (const entry of arr) {
    const item = toFeedItem(entry);
    if (item) out.push(item);
  }
  return out;
}

/** Account status, if it can be read off the home/feed envelope. */
function readStatus(raw: unknown): string | undefined {
  if (raw && typeof raw === "object") {
    return asStr((raw as Record<string, unknown>).status);
  }
  return undefined;
}

/** Which of `ids` are NOT already in seen_posts (i.e. fresh to consider). */
async function filterUnseen(env: Env, ids: string[]): Promise<Set<string>> {
  const fresh = new Set<string>(ids);
  if (ids.length === 0) return fresh;
  // Parameterised IN (...) — ids come from the feed (untrusted) so they are
  // ALWAYS bound, never string-concatenated into SQL.
  const placeholders = ids.map(() => "?").join(",");
  const res = await env.DB.prepare(
    `SELECT post_id FROM seen_posts WHERE post_id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{ post_id: string }>();
  for (const row of res.results ?? []) fresh.delete(row.post_id);
  return fresh;
}

/**
 * Run a single guarded heartbeat. Safe to call from scheduled() and from an
 * admin manual trigger; it self-gates on the kill switch and budgets and never
 * throws (callers can rely on a resolved HeartbeatResult).
 *
 * @param env Worker bindings/vars.
 * @returns `{ ran, actions }`.
 */
export async function heartbeat(env: Env): Promise<HeartbeatResult> {
  // 1) KILL SWITCH (invariant #5). Default OFF. Read it FIRST — before any
  //    feed read or AI spend. Any read error => treat as OFF (fail safe).
  let enabled: string | undefined;
  try {
    enabled = await readSetting(env, "enabled");
  } catch {
    return IDLE;
  }
  if (enabled !== "true") return IDLE;

  // 2) DAILY BUDGET HARD-STOP (invariant #5). If today's action count or AI
  //    spend has already hit the cap, do NOT read the feed or spend a cent.
  const day = utcDay();
  const actionBudget = intVar(env.DAILY_ACTION_BUDGET, 0);
  const usdBudget = floatVar(env.DAILY_USD_BUDGET, 0);
  let spent: { actions: number; usd: number };
  try {
    spent = await readBudget(env, day);
  } catch {
    return IDLE;
  }
  const actionsRemaining = actionBudget - spent.actions;
  if (actionsRemaining <= 0 || spent.usd >= usdBudget) return IDLE;

  // 3) READ a feed slice via the Moltbook client — the ONLY network egress.
  //    DMs are never polled/read/sent (invariant #4): we only call feed().
  const feedSlice = intVar(env.FEED_SLICE, 15);
  const client = createMoltbookClient(env.MOLTBOOK_API_KEY);
  let raw: unknown;
  try {
    raw = await client.feed({ sort: "new", limit: feedSlice });
  } catch {
    // Network/auth/parse failure — nothing to act on. Stay silent (no key in logs).
    console.log(
      JSON.stringify({ at: "heartbeat", ran: true, actions: 0, note: "feed_unavailable" }),
    );
    return { ran: true, actions: 0 };
  }
  const status = readStatus(raw);
  const allItems = normalizeFeed(raw).slice(0, feedSlice);

  // 4) DE-DUP + INGRESS CHAPERONE (invariant #3). Drop already-seen ids, then
  //    sanitise every UNTRUSTED text field. Content is DATA, never instructions.
  let unseen: Set<string>;
  try {
    unseen = await filterUnseen(
      env,
      allItems.map((i) => i.id),
    );
  } catch {
    unseen = new Set(allItems.map((i) => i.id));
  }
  const flagsByItem: Record<string, string[]> = {};
  const cleanFeed: FeedItem[] = [];
  for (const item of allItems) {
    if (!unseen.has(item.id)) continue;
    const flags: string[] = [];
    const titleV = ingress(item.title);
    const sanitized: FeedItem = { id: item.id, title: titleV.clean };
    flags.push(...titleV.flags);
    if (item.content !== undefined) {
      const v = ingress(item.content);
      sanitized.content = v.clean;
      flags.push(...v.flags);
    }
    // url/author/submolt are also untrusted; sanitise the free-text-ish ones.
    if (item.url !== undefined) {
      const v = ingress(item.url);
      sanitized.url = v.clean;
      flags.push(...v.flags);
    }
    if (item.author !== undefined) {
      const v = ingress(item.author);
      sanitized.author = v.clean;
      flags.push(...v.flags);
    }
    if (item.submolt_name !== undefined) sanitized.submolt_name = item.submolt_name;
    if (item.score !== undefined) sanitized.score = item.score;
    if (item.comment_count !== undefined) sanitized.comment_count = item.comment_count;
    if (flags.length > 0) flagsByItem[item.id] = flags;
    cleanFeed.push(sanitized);
  }

  // 5) BRAIN — produce a validated, allowlist-only ActionPlan. The brain itself
  //    re-asserts the allowlist; the executor re-validates again (defence in depth).
  const ctx: BrainContext = {
    feed: cleanFeed,
    flagsByItem,
    actionsRemaining,
    ...(status !== undefined ? { status } : {}),
  };
  let plan;
  try {
    plan = await decide(env, ctx);
  } catch {
    // Any brain failure => do nothing this tick (no writes attempted).
    console.log(
      JSON.stringify({
        at: "heartbeat",
        ran: true,
        actions: 0,
        considered: cleanFeed.length,
        flagged: Object.keys(flagsByItem).length,
        note: "brain_unavailable",
      }),
    );
    return { ran: true, actions: 0 };
  }

  // 6) EXECUTOR — apply the plan under all guards (kill switch re-check, budgets,
  //    egress chaperone, de-dup, allowlist re-validation, verification handshake).
  let result;
  try {
    result = await execute(env, plan);
  } catch {
    console.log(
      JSON.stringify({
        at: "heartbeat",
        ran: true,
        actions: 0,
        considered: cleanFeed.length,
        flagged: Object.keys(flagsByItem).length,
        note: "executor_unavailable",
      }),
    );
    return { ran: true, actions: 0 };
  }

  // 7) SUMMARY LINE — operational telemetry only. NEVER the API key, NEVER any
  //    secret, NEVER raw feed content. Just counts the founder can audit.
  console.log(
    JSON.stringify({
      at: "heartbeat",
      ran: true,
      considered: cleanFeed.length,
      flagged: Object.keys(flagsByItem).length,
      planned: plan.actions.length,
      done: result.done,
      skipped: result.skipped,
    }),
  );

  return { ran: true, actions: result.done };
}
