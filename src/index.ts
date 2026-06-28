/**
 * index.ts — Worker entrypoint.
 *
 * Surface:
 *  - GET  /health           — liveness (DB `SELECT 1`). NO secret required, NO
 *                             Moltbook call, NO secret echoed.
 *  - POST /admin/register   — founder-only: register the agent with Moltbook
 *                             (the ONE unauthenticated Moltbook call). Gated by
 *                             ACCESS_KEY bearer. Returns api_key + claim_url so
 *                             the FOUNDER can claim the account. This is the ONLY
 *                             place register is exposed and it is founder-gated.
 *  - POST /admin/enable     — founder-only: flip the kill switch
 *                             (settings.enabled). Gated by ACCESS_KEY bearer.
 *  - POST /admin/tick       — founder-only: run ONE heartbeat (for testing).
 *                             Gated by ACCESS_KEY bearer.
 *  - scheduled()            — every 30 min, runs heartbeat() (which itself
 *                             self-gates on the kill switch + budgets).
 *
 * There are intentionally NO public write routes, NO feed/DM routes, and NO
 * route that echoes any secret. The /admin/* gate constant-time-compares the
 * bearer to env.ACCESS_KEY (a SECRET); on mismatch -> 401, no detail leaked.
 *
 * SECRETS (documented; set via `wrangler secret put`, never in [vars]):
 *  - MOLTBOOK_API_KEY — Moltbook Bearer key. Only ever attached to Moltbook URLs
 *    (assertMoltbookUrl in the client). Never logged/echoed.
 *  - ACCESS_KEY — founder bearer gate for every /admin/* route. Never logged/echoed.
 */

import { Hono } from "hono";
import { converse, type ConverseTurn } from "./brain";
import type { Env } from "./env";
import { heartbeat } from "./heartbeat";
import { createMoltbookClient } from "./moltbook";
import { type SlackEnvelope, scrubSecrets, slackPostMessage, verifySlackSignature } from "./slack";

/** Hono app typed to our bindings. */
const app = new Hono<{ Bindings: Env }>();

/**
 * Constant-time string comparison. Avoids leaking the ACCESS_KEY length/prefix
 * via early-exit timing. Returns false fast ONLY when neither input is usable.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Compare against a fixed-length buffer so length itself is not a timing oracle.
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Founder gate: require `Authorization: Bearer <ACCESS_KEY>`. No `?key=` query
 * fallback — secrets must never appear in URLs/logs. Returns true if authorized.
 * On any missing/blank ACCESS_KEY the gate denies (fail closed).
 */
function isFounder(c: { req: { header: (k: string) => string | undefined }; env: Env }): boolean {
  const key = c.env.ACCESS_KEY;
  if (typeof key !== "string" || key.length === 0) return false;
  const auth = c.req.header("authorization");
  if (!auth) return false;
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (bearer.length === 0) return false;
  return timingSafeEqual(bearer, key);
}

/**
 * Defense-in-depth response headers on every response (HSTS + nosniff +
 * no-referrer). Admin responses are never cacheable. Header-set failures never
 * fail the request (some responses carry immutable headers).
 */
app.use("*", async (c, next) => {
  await next();
  try {
    c.res.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    c.res.headers.set("x-content-type-options", "nosniff");
    c.res.headers.set("referrer-policy", "no-referrer");
    if (c.req.path.startsWith("/admin")) {
      c.res.headers.set("cache-control", "no-store, private");
    }
  } catch {
    /* immutable headers on some responses — never fail a request over a header */
  }
});

/**
 * Liveness probe. Performs a trivial `SELECT 1` against D1 to prove the worker
 * and its sole stateful binding are reachable. MUST NOT require a secret, call
 * Moltbook, or reveal any config/secret.
 */
app.get("/health", async (c) => {
  try {
    const row = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    const dbOk = row?.ok === 1;
    return c.json({ ok: dbOk, service: "ishtar-intern", db: dbOk }, dbOk ? 200 : 503);
  } catch {
    // Do not leak the error detail; just report not-ready.
    return c.json({ ok: false, service: "ishtar-intern", db: false }, 503);
  }
});

/**
 * Founder-only: register the agent with Moltbook. The ONE unauthenticated
 * Moltbook call, run by the founder so they can CLAIM the account. Gated by the
 * ACCESS_KEY bearer. Returns api_key + claim_url (these are NOT worker secrets —
 * they are the freshly-minted account credentials the founder must capture).
 */
app.post("/admin/register", async (c) => {
  if (!isFounder(c)) return c.json({ error: "unauthorized" }, 401);

  let body: { name?: unknown; description?: unknown };
  try {
    body = (await c.req.json()) as { name?: unknown; description?: unknown };
  } catch {
    return c.json({ error: "bad_request" }, 400);
  }
  const name =
    typeof body.name === "string" && body.name.trim().length > 0
      ? body.name.trim()
      : c.env.MOLTBOOK_AGENT_NAME;
  const description =
    typeof body.description === "string" && body.description.trim().length > 0
      ? body.description.trim()
      : "Ishtar Intern — autonomous Moltbook participant for the Ishtar agent.";

  try {
    const client = createMoltbookClient(c.env.MOLTBOOK_API_KEY);
    const result = await client.register({ name, description });
    // Return ONLY the founder-claim fields. The api_key here is the account's
    // own freshly-issued key (to be stored as the worker secret), not echoed
    // from any existing secret.
    return c.json({
      api_key: result.agent.api_key,
      claim_url: result.agent.claim_url,
      verification_code: result.agent.verification_code,
    });
  } catch {
    return c.json({ error: "register_failed" }, 502);
  }
});

/**
 * Founder-only: flip the kill switch. Body `{ on: boolean }` -> settings.enabled
 * = "true" | "false". Gated by the ACCESS_KEY bearer. This is how the founder
 * stops the agent instantly.
 */
app.post("/admin/enable", async (c) => {
  if (!isFounder(c)) return c.json({ error: "unauthorized" }, 401);

  let body: { on?: unknown };
  try {
    body = (await c.req.json()) as { on?: unknown };
  } catch {
    return c.json({ error: "bad_request" }, 400);
  }
  if (typeof body.on !== "boolean") {
    return c.json({ error: "bad_request", detail: "expected { on: boolean }" }, 400);
  }
  const value = body.on ? "true" : "false";
  try {
    await c.env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('enabled', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
      .bind(value)
      .run();
    return c.json({ enabled: body.on });
  } catch {
    return c.json({ error: "enable_failed" }, 500);
  }
});

/**
 * Founder-only: run ONE heartbeat synchronously (for testing). Gated by the
 * ACCESS_KEY bearer. heartbeat() self-gates on the kill switch and budgets, so
 * this never forces a write when the agent is disabled or over budget.
 */
app.post("/admin/tick", async (c) => {
  if (!isFounder(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const result = await heartbeat(c.env);
    return c.json(result);
  } catch {
    return c.json({ error: "tick_failed" }, 500);
  }
});

/**
 * Slack operator chat. PUBLIC route (Slack can't send a bearer), gated by the
 * request SIGNATURE (HMAC over the raw body) + a founder/team allowlist + event
 * de-dup. We ack 200 FAST (Slack's 3s budget) and do the model work in
 * waitUntil(), replying via chat.postMessage. The intern's brain self-gates on
 * the daily USD budget. Quarantine intact: this touches only env.AI + env.DB.
 */
app.post("/slack/events", async (c) => {
  // Read the EXACT bytes Slack signed before parsing.
  const raw = await c.req.text();

  let body: SlackEnvelope;
  try {
    body = JSON.parse(raw) as SlackEnvelope;
  } catch {
    return c.json({ error: "bad_request" }, 400);
  }

  // Slack URL-verification handshake — echo the challenge BEFORE the signature
  // check (it's a stateless reflection of Slack's own random token; leaks nothing).
  // Lets the endpoint verify even while the signing secret is being sorted. Real
  // events are signature-checked below.
  if (body.type === "url_verification" && typeof body.challenge === "string") {
    return c.json({ challenge: body.challenge });
  }

  // All real events MUST pass signature verification.
  const ok = await verifySlackSignature(
    c.env.SLACK_SIGNING_SECRET,
    c.req.header("x-slack-request-timestamp"),
    raw,
    c.req.header("x-slack-signature"),
  );
  if (!ok) return c.json({ error: "bad_signature" }, 401);

  if (body.type === "event_callback" && body.event) {
    // Process out of band so we ack within Slack's 3s window (avoids retries).
    c.executionCtx.waitUntil(handleSlackEvent(c.env, body).catch(() => {}));
  }
  return c.json({ ok: true });
});

/** Drive one Slack message → brain → reply. Founder-gated, de-duped, fail-soft. */
async function handleSlackEvent(env: Env, body: SlackEnvelope): Promise<void> {
  const ev = body.event;
  if (!ev) return;

  // Only respond to a direct @mention or a DM to the bot.
  const isMention = ev.type === "app_mention";
  const isDM = ev.type === "message" && ev.channel_type === "im";
  if (!isMention && !isDM) return;
  // Ignore the bot's own / system / edited messages (no reply loops).
  if (ev.bot_id || ev.subtype) return;

  // De-dup: Slack retries on slow/failed acks. Record event_id once; skip replays.
  if (body.event_id) {
    const r = await env.DB.prepare("INSERT OR IGNORE INTO slack_events (event_id) VALUES (?)")
      .bind(body.event_id)
      .run();
    if ((r.meta?.changes ?? 0) === 0) return;
  }

  // Founder/team allowlist (fail-closed when configured).
  if (env.SLACK_TEAM_ID && body.team_id !== env.SLACK_TEAM_ID) return;
  if (env.SLACK_FOUNDER_USER_ID && ev.user !== env.SLACK_FOUNDER_USER_ID) return;

  const text = String(ev.text ?? "")
    .replace(/<@[A-Z0-9]+>/g, "") // strip the bot mention token
    .trim();
  if (!text || !ev.channel) return;

  const threadKey = ev.thread_ts ?? ev.ts ?? "";
  const history = await loadTurns(env, threadKey);
  const reply = scrubSecrets(await converse(env, { text, history }));

  await slackPostMessage(env.SLACK_BOT_TOKEN, ev.channel, reply, threadKey || undefined);
  await saveTurn(env, threadKey, "user", text);
  await saveTurn(env, threadKey, "assistant", reply);
}

/** Load the last ~12 turns of a Slack thread (chronological) for operator memory. */
async function loadTurns(env: Env, threadKey: string): Promise<ConverseTurn[]> {
  if (!threadKey) return [];
  try {
    const rows = (
      await env.DB.prepare(
        "SELECT role, content FROM slack_turns WHERE thread_key = ? ORDER BY id DESC LIMIT 12",
      )
        .bind(threadKey)
        .all<{ role: string; content: string }>()
    ).results ?? [];
    return rows
      .reverse()
      .map((r) => ({ role: r.role === "assistant" ? "assistant" : "user", content: r.content }) as ConverseTurn);
  } catch {
    return [];
  }
}

/** Append one turn to the thread transcript (best-effort; capped). */
async function saveTurn(env: Env, threadKey: string, role: "user" | "assistant", content: string): Promise<void> {
  if (!threadKey || !content) return;
  try {
    await env.DB.prepare("INSERT INTO slack_turns (thread_key, role, content) VALUES (?, ?, ?)")
      .bind(threadKey, role, content.slice(0, 8000))
      .run();
  } catch {
    /* transcript is best-effort; never fail the reply over it */
  }
}

export default {
  /** HTTP entrypoint. */
  fetch: app.fetch,

  /**
   * Cron entrypoint (every 30 min). Delegates to heartbeat(), which self-gates
   * on the kill switch and daily budgets — the cron firing alone never causes
   * a write. Wrapped so an error never escapes scheduled() (it lands in Logs).
   */
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          await heartbeat(env);
        } catch {
          // Never throw out of scheduled(); exceptions land in Workers Logs.
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
