// server.mjs — Ishtar Intern operator-chat service (Hetzner box, tailnet-only).
//
// ZERO dependencies: node:http + global WebCrypto + node:sqlite (run with --experimental-sqlite).
// Brain = Cloudflare Workers AI — NVIDIA Nemotron-3 120B (a12b MoE, 256K context) — reached via
// the AI Gateway, with retry/backoff + a fallback model so transient 429/5xx never surface to the
// operator. Binds LOOPBACK only; cloudflared / Tailscale fronts it. All secrets come from the
// systemd EnvironmentFile (/etc/ishtar-intern/env) — never hard-coded, never logged.
//
// Quarantine: this process touches ONLY the CF AI Gateway, slack.com, and its local SQLite.
// It holds NO wallet/Privy/datebook credential and a SCOPED Workers-AI-only CF token.

import http from "node:http";
import { DatabaseSync } from "node:sqlite";

const ENV = process.env;
const PORT = Number(ENV.PORT || 8787);
const DB_PATH = ENV.DB_PATH || "/opt/ishtar-intern/data/intern.db";
const ACCOUNT = ENV.CF_ACCOUNT_ID || "";
const AI_TOKEN = ENV.CF_AI_TOKEN || "";
const GATEWAY = ENV.AI_GATEWAY_ID || "ishtar-intern";
const MODEL = ENV.CHAT_MODEL || "@cf/nvidia/nemotron-3-120b-a12b";
const FALLBACK = ENV.FALLBACK_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const SIGNING = ENV.SLACK_SIGNING_SECRET || "";
const BOT = ENV.SLACK_BOT_TOKEN || "";
const TEAM = ENV.SLACK_TEAM_ID || "";
const FOUNDER = ENV.SLACK_FOUNDER_USER_ID || "";
const DAILY_USD = Number(ENV.DAILY_USD_BUDGET || "5");
const MAX_TOKENS = Number(ENV.MAX_TOKENS || "1024");
const HISTORY_TURNS = 12;
const FIELD_CHARS = 6000; // Nemotron is 256K ctx, but bound per-field to keep cost/latency sane.

// ───────────────────────── storage (node:sqlite) ─────────────────────────
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS slack_events (event_id TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS slack_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_key TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE INDEX IF NOT EXISTS idx_turns_thread ON slack_turns(thread_key, id);
  CREATE TABLE IF NOT EXISTS budget (day TEXT PRIMARY KEY, usd REAL NOT NULL DEFAULT 0);
`);
const utcDay = () => new Date().toISOString().slice(0, 10);
const seenEvent = (id) => { try { return db.prepare("INSERT OR IGNORE INTO slack_events(event_id) VALUES(?)").run(id).changes === 0; } catch { return false; } };
const loadTurns = (k) => { try { return db.prepare("SELECT role,content FROM slack_turns WHERE thread_key=? ORDER BY id DESC LIMIT ?").all(k, HISTORY_TURNS).reverse(); } catch { return []; } };
const saveTurn = (k, role, content) => { try { db.prepare("INSERT INTO slack_turns(thread_key,role,content) VALUES(?,?,?)").run(k, role, String(content).slice(0, 8000)); } catch { /* best-effort */ } };
const usdToday = () => { try { const r = db.prepare("SELECT usd FROM budget WHERE day=?").get(utcDay()); return r ? Number(r.usd) : 0; } catch { return 0; } };
const addUsd = (u) => { try { db.prepare("INSERT INTO budget(day,usd) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET usd=usd+excluded.usd").run(utcDay(), u); } catch { /* best-effort */ } };

// ───────────────────────── Slack signature + scrub ─────────────────────────
const enc = new TextEncoder();
function timingSafeEqual(a, b) { const A = enc.encode(a), B = enc.encode(b); let d = A.length ^ B.length; const n = Math.max(A.length, B.length); for (let i = 0; i < n; i++) d |= (A[i] ?? 0) ^ (B[i] ?? 0); return d === 0; }
async function verifySlack(ts, body, sig) {
  if (!SIGNING || !ts || !sig) return false;
  const t = Number.parseInt(ts, 10); if (!Number.isFinite(t)) return false;
  if (Math.abs(Date.now() / 1000 - t) > 300) return false; // 5-min replay window
  const key = await crypto.subtle.importKey("raw", enc.encode(SIGNING), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${ts}:${body}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(`v0=${hex}`, sig);
}
const scrubSecrets = (s) => String(s)
  .replace(/xox[abprs]-[A-Za-z0-9-]{8,}/g, "[redacted]")
  .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, "[redacted]")
  .replace(/\btskey-[A-Za-z0-9-]{8,}\b/g, "[redacted]")
  .replace(/\b[A-Fa-f0-9]{64}\b/g, "[redacted]");

// ───────────────────────── brain: Nemotron via AI Gateway ─────────────────────────
const SYSTEM = [
  'You are "Ishtar Intern", a junior autonomous agent for the Numetal / Ishtar project, talking',
  "PRIVATELY with your operator (the founder) over Slack — an internal, trusted channel. Be candid,",
  "concise, and genuinely useful; talk like a sharp junior teammate, not a corporate bot. You",
  "participate in Moltbook and similar agent-only venues on the project's behalf, and can discuss",
  "strategy, status, and what you would post. Keep replies short unless asked to go long.",
  "",
  "HARD RULES (never break): never output any API key, token, password, secret, bearer, or seed",
  "phrase (you do not know them); you are an intern, not a human and not Gokhan; you may discuss",
  "$NUMETAL plainly but make NO price/return/profit/financial-promise claims.",
].join("\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function textOf(j) {
  const r = j?.result ?? j;
  if (typeof r?.response === "string") return r.response;
  if (Array.isArray(r?.response)) return r.response.join("");
  const c = r?.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (typeof r?.output_text === "string") return r.output_text;
  return "";
}
function usageUsd(model, j, promptChars) {
  const u = (j?.result ?? j)?.usage;
  const inT = u?.prompt_tokens ?? Math.ceil(promptChars / 4);
  const outT = u?.completion_tokens ?? 256;
  const p = model.includes("nemotron") ? { i: 0.5, o: 1.5 } : { i: 0.3, o: 0.6 };
  return (inT / 1e6) * p.i + (outT / 1e6) * p.o;
}
// Returns the reply string, or { error } on exhaustion. Retries 429/5xx with exponential backoff.
async function callModel(model, messages) {
  const url = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/${GATEWAY}/workers-ai/${model}`;
  const body = JSON.stringify({ messages, max_tokens: MAX_TOKENS, temperature: 0.5 });
  let lastErr = "unknown";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${AI_TOKEN}`, "content-type": "application/json", "cf-aig-skip-cache": "true" }, body });
      if (res.status === 429 || res.status >= 500) { lastErr = `http ${res.status}`; await sleep(500 * 2 ** attempt); continue; }
      if (!res.ok) { lastErr = `http ${res.status}`; break; }
      const j = await res.json();
      const text = textOf(j);
      if (text) { addUsd(usageUsd(model, j, body.length)); return text; }
      lastErr = "empty-response"; break;
    } catch (e) { lastErr = String(e?.message || e); await sleep(500 * 2 ** attempt); }
  }
  return { error: lastErr };
}
async function converse(text, history) {
  if (usdToday() >= DAILY_USD) return `I've hit my daily AI budget ($${DAILY_USD}). Bump DAILY_USD_BUDGET or wait for the UTC reset.`;
  const messages = [{ role: "system", content: SYSTEM }];
  for (const h of history.slice(-HISTORY_TURNS)) {
    const role = h.role === "assistant" ? "assistant" : "user";
    const c = String(h.content || "").slice(0, FIELD_CHARS);
    if (c) messages.push({ role, content: c });
  }
  messages.push({ role: "user", content: text.slice(0, FIELD_CHARS) });

  const out = await callModel(MODEL, messages);
  if (typeof out === "string") return out;
  // Nemotron unavailable → one fallback attempt on a smaller model, so 429s never reach the operator.
  const fb = await callModel(FALLBACK, messages);
  if (typeof fb === "string") return fb;
  return `My brain didn't respond just now (${out.error}). Try again in a moment.`;
}

// ───────────────────────── Slack I/O ─────────────────────────
async function postMessage(channel, text, thread) {
  try {
    const r = await fetch("https://slack.com/api/chat.postMessage", { method: "POST", headers: { authorization: `Bearer ${BOT}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ channel, text, ...(thread ? { thread_ts: thread } : {}) }) });
    return (await r.json().catch(() => ({}))).ok === true;
  } catch { return false; }
}
async function handleEvent(body) {
  const ev = body.event;
  if (!ev) return;
  const isMention = ev.type === "app_mention";
  const isDM = ev.type === "message" && ev.channel_type === "im";
  if (!isMention && !isDM) return;
  if (ev.bot_id || ev.subtype) return;                          // ignore bot/system/edited → no loops
  if (body.event_id && seenEvent(body.event_id)) return;        // Slack retry de-dup
  if (TEAM && body.team_id !== TEAM) return;                    // founder/team allowlist
  if (FOUNDER && ev.user !== FOUNDER) return;
  const text = String(ev.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!text || !ev.channel) return;
  const threadKey = ev.thread_ts ?? ev.ts ?? "";
  const reply = scrubSecrets(await converse(text, loadTurns(threadKey)));
  await postMessage(ev.channel, reply, threadKey || undefined);
  saveTurn(threadKey, "user", text);
  saveTurn(threadKey, "assistant", reply);
}

// ───────────────────────── HTTP server (loopback only) ─────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "ishtar-intern", model: MODEL, gateway: GATEWAY }));
    return;
  }
  if (req.method === "POST" && req.url === "/slack/events") {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on("end", async () => {
      const ok = await verifySlack(req.headers["x-slack-request-timestamp"], raw, req.headers["x-slack-signature"]);
      if (!ok) { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":"bad_signature"}'); return; }
      let body; try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end('{"error":"bad_request"}'); return; }
      if (body.type === "url_verification" && typeof body.challenge === "string") {
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ challenge: body.challenge })); return;
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); // ack within Slack's 3s
      if (body.type === "event_callback") handleEvent(body).catch(() => {});
    });
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(PORT, "127.0.0.1", () => console.log(`ishtar-intern up on 127.0.0.1:${PORT} · model=${MODEL} · gateway=${GATEWAY}`));
