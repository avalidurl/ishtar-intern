/**
 * env.ts — the Worker's binding & variable surface.
 *
 * QUARANTINE INVARIANT: this is the COMPLETE set of bindings. There is NO
 * datebook D1, NO Vectorize, NO Durable Object, NO wallet/Privy/admin binding,
 * and NO heart-file/PII access. If a later change needs one of those, it does
 * NOT belong in this worker.
 */

/**
 * Bindings + vars available to the Ishtar Intern worker.
 *
 * Secrets (set via `wrangler secret put`, never in wrangler.toml [vars]):
 *  - MOLTBOOK_API_KEY: Bearer token for www.moltbook.com. Never logged/echoed.
 *  - ACCESS_KEY: founder bearer gate for /admin/* routes.
 */
export interface Env {
  /** Workers AI binding (the ONLY model/inference surface). */
  AI: Ai;

  /** Sole stateful binding: the intern's own D1 (settings, seen_posts, logs, budgets). */
  DB: D1Database;

  /** SECRET — Moltbook Bearer API key. Attach ONLY to MOLTBOOK_ORIGIN URLs. Never log. */
  MOLTBOOK_API_KEY: string;

  /** SECRET — founder bearer gate for POST /admin/* routes. Never log. */
  ACCESS_KEY: string;

  /** SECRET — Slack app signing secret. Verifies POST /slack/events authenticity. Never log. */
  SLACK_SIGNING_SECRET: string;

  /** SECRET — Slack bot OAuth token (xoxb-…) used for chat.postMessage replies. Never log. */
  SLACK_BOT_TOKEN: string;

  /** Optional var — lock Slack chat to one workspace (team_id, e.g. "T0123…"). Empty = any. */
  SLACK_TEAM_ID?: string;

  /** Optional var — lock Slack chat to the founder's Slack member id ("U0123…"). Empty = any user in the team. */
  SLACK_FOUNDER_USER_ID?: string;

  /** Public display / registration name, e.g. "IshtarIntern". */
  MOLTBOOK_AGENT_NAME: string;

  /** Workers-AI chat model id used for drafting (general instruct model). */
  CHAT_MODEL: string;

  /** AI Gateway id; all env.AI.run calls route through it (dollar cap in dashboard). */
  AI_GATEWAY_ID: string;

  /** Hard daily cap on write actions (string int, parse at use site). */
  DAILY_ACTION_BUDGET: string;

  /** Hard daily AI spend ceiling in USD (string float, parse at use site). */
  DAILY_USD_BUDGET: string;

  /** How many feed items per heartbeat to hand the brain (string int). */
  FEED_SLICE: string;
}
