/**
 * slack.ts — operator chat transport for the Ishtar Intern.
 *
 * The /slack/events endpoint is PUBLIC (Slack can't send a bearer), so its gate is
 * the Slack request SIGNATURE (HMAC-SHA256 of `v0:{timestamp}:{rawBody}` with the
 * app's signing secret) plus a replay window, plus a founder/team allowlist checked
 * in the route. This module is pure transport + crypto: it never touches Moltbook,
 * never reads the Moltbook key, and never logs a secret.
 */

const enc = new TextEncoder();

/** Constant-time string compare (no early-exit length/prefix timing oracle). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/**
 * Verify a Slack request signature. FAIL-CLOSED on any missing input, a stale
 * timestamp (> 5 min — replay defence), or a mismatch. `rawBody` MUST be the exact
 * bytes Slack signed (read the body as text BEFORE JSON.parse).
 */
export async function verifySlackSignature(
  signingSecret: string | undefined,
  timestamp: string | undefined,
  rawBody: string,
  signature: string | undefined,
): Promise<boolean> {
  try {
    if (!signingSecret || !timestamp || !signature) return false;
    const ts = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(ts)) return false;
    // Replay window: reject anything more than 5 minutes from now (either direction).
    if (Math.abs(Date.now() / 1000 - ts) > 60 * 5) return false;

    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${timestamp}:${rawBody}`));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return timingSafeEqual(`v0=${hex}`, signature);
  } catch {
    return false;
  }
}

/**
 * Post a message via chat.postMessage. Best-effort: returns true on Slack `ok`,
 * false otherwise (never throws). `thread_ts` keeps the reply in-thread.
 */
export async function slackPostMessage(
  botToken: string,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<boolean> {
  try {
    if (!botToken || !channel || !text) return false;
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${botToken}` },
      body: JSON.stringify({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return j.ok === true;
  } catch {
    return false;
  }
}

/**
 * Open (idempotent) a DM with a user id and post a message. Used for proactive
 * founder pings (e.g. the daily-budget warning). Returns ok; never throws.
 */
export async function slackDmUser(botToken: string, userId: string, text: string): Promise<boolean> {
  try {
    if (!botToken || !userId || !text) return false;
    const open = await fetch("https://slack.com/api/conversations.open", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${botToken}` },
      body: JSON.stringify({ users: userId }),
    });
    const ch = ((await open.json().catch(() => ({}))) as { channel?: { id?: string } }).channel?.id;
    if (!ch) return false;
    return slackPostMessage(botToken, ch, text);
  } catch {
    return false;
  }
}

/**
 * Defence-in-depth scrub of an outbound reply: redact anything that LOOKS like a
 * secret before it leaves the worker. The model never sees real secrets, so this
 * should never fire — it's a backstop, not the primary control.
 */
export function scrubSecrets(s: string): string {
  return String(s)
    .replace(/xox[abprs]-[A-Za-z0-9-]{8,}/g, "[redacted]") // slack tokens
    .replace(/\bish_[a-f0-9]{8,}\b/gi, "[redacted]") // session-style tokens
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, "[redacted]") // openai-style keys
    .replace(/\b[A-Fa-f0-9]{64}\b/g, "[redacted]") // 32-byte hex (keys/seeds)
    .replace(/\b(?:[a-z]+\s){11,23}[a-z]+\b/gi, (m) => (m.split(/\s+/).length >= 12 ? "[redacted]" : m)); // long lowercase word-runs (mnemonic-ish)
}

/** Minimal shape of the Slack event envelope we accept. */
export interface SlackEnvelope {
  type?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event?: {
    type?: string;
    channel_type?: string;
    bot_id?: string;
    subtype?: string;
    user?: string;
    text?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
  };
}
