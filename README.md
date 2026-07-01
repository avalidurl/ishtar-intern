<div align="center">

# ishtar-intern

**A quarantined, budget-capped social agent — the archived Cloudflare-Worker step of a longer migration.**

<br />

[![last commit](https://img.shields.io/github/last-commit/gokhan-vc/ishtar-intern?style=flat-square)](https://github.com/gokhan-vc/ishtar-intern/commits)
[![stars](https://img.shields.io/github/stars/gokhan-vc/ishtar-intern?style=social)](https://github.com/gokhan-vc/ishtar-intern/stargazers)

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Hono](https://img.shields.io/badge/Hono-E36002?style=flat-square&logo=hono&logoColor=white)](https://hono.dev/)
[![Workers AI](https://img.shields.io/badge/Workers%20AI-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers-ai/)
[![D1](https://img.shields.io/badge/Cloudflare%20D1-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/d1/)
[![Vitest](https://img.shields.io/badge/Vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev/)

</div>

---

> ### ⚠️ ARCHIVED / SUPERSEDED — never the source of truth
>
> This repository is a **historical snapshot** of one intermediate step in a migration.
> It is **not deployed**, **not maintained**, and **not** the live runtime. It is kept
> purely as a reference artifact. The production system runs elsewhere and is
> deliberately not described here. No secrets, real hosts, or account identifiers are
> committed — every account id, database id, workspace/user id, host, and token has been
> replaced with a `<PLACEHOLDER>` or is required from the environment at run time.

---

## What this was

`ishtar-intern` was a small, **quarantined "intern" agent** built to participate in an
agent-only social feed on its own account, entirely on its own. On a cron heartbeat it
would read a slice of the feed, decide (via a hosted LLM) whether to upvote / comment /
reply / post / follow / do-nothing, and act — all under hard budget caps and a default-off
kill switch. A separate Slack channel let its operator chat with it directly.

The design goal was not "a clever bot" but a **security-first envelope**: an autonomous
agent that reads fully-untrusted, adversarial content from strangers and can still only
ever do a fixed, tiny set of safe things — no arbitrary fetch, no code execution, no DMs,
no wallet, no access to any neighbouring system's data.

This is the **Cloudflare-Worker implementation** of that idea (100% Cloudflare, no
third-party inference key). It has since been superseded; the code is retained so the
security architecture and its adversarial tests stay legible.

## Highlights

- **Closed action allowlist.** The model may emit *only* `upvote · comment · reply · post ·
  follow · noop`. There is deliberately no action for arbitrary fetch, shell/code
  execution, DM read/send, payments, or touching any neighbouring system — those
  capabilities do not exist in the worker. Enforced at three layers (brain, type system,
  executor).
- **Untrusted-content chaperone (ingress).** Every piece of feed content is treated as
  *data, never instructions*: zero-width / smuggling characters stripped, embedded URLs
  removed, delimiter- and role-forging markers neutralised, prompt-injection patterns
  flagged, length capped — all before the model ever sees it.
- **Fail-closed moderation gate (egress).** Every outbound draft passes a deterministic
  denylist (scam/exfil payloads, impersonation, financial-promise language) **plus** an
  optional Llama-Guard-style classifier. Any hit — or any guard error — blocks the send.
- **Default-off kill switch + hard budgets.** The loop is disabled by default; a daily
  action cap and a daily USD spend ceiling gate *every* write. A cron firing never means
  the agent acts.
- **Single, pinned network egress.** One typed API client is the only thing that talks to
  the network, and it refuses to attach credentials to any URL outside the exact expected
  origin (a slash-boundary check that rejects look-alike hosts).
- **Operator chat over Slack**, gated by request-signature verification (HMAC over the raw
  body), a replay window, an operator/workspace allowlist, and event de-duplication.
- **Adversarially tested.** The security-critical client and challenge logic ship with a
  Vitest suite that stubs `fetch` and asserts the credential-attachment invariant.

## Architecture

```
cron (every 30 min)  ─▶  heartbeat()
                          │  1. kill switch (default OFF)  ── off ─▶ do nothing
                          │  2. daily budgets (actions + USD) ─ spent ─▶ do nothing
                          │  3. read feed slice   ── the ONE network egress
                          │  4. ingress chaperone ── sanitise every untrusted field
                          │  5. brain (Workers AI) ── allowlist-only ActionPlan
                          │  6. executor           ── egress gate + caps + rate limits
                          ▼
                    Workers Logs (counts only — never secrets, never raw content)

POST /slack/events  ─▶  signature-verify ─▶ allowlist ─▶ brain ─▶ chat.postMessage
POST /admin/{register,enable,tick}  ─▶  constant-time bearer gate (fail-closed)
GET  /health        ─▶  SELECT 1  (no secret, no external call)
```

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | Worker entrypoint — Hono routes, admin bearer gate, Slack events, cron |
| `src/heartbeat.ts` | One guarded cron tick: kill switch → budgets → feed → chaperone → brain → executor |
| `src/brain.ts` | LLM decision module; wraps untrusted content in a data-only block, validates output, fails closed to `noop` |
| `src/executor.ts` | Applies the plan under kill switch, budgets, per-type rate limits, egress gate, de-dup |
| `src/chaperone.ts` | `ingress()` sanitiser + `egress()` fail-closed moderation gate |
| `src/security.ts` | The invariants: credential-origin check, action allowlist, injection heuristics |
| `src/moltbook.ts` | Typed API client — the sole network egress; pins the credential origin |
| `src/slack.ts` | Operator-chat transport + signature crypto |
| `src/db/migrations/` | D1 schema (settings, seen posts, budget counters, action log, Slack turns) |
| `_legacy/` | Earlier, now-retired runtimes + deploy scaffolding — **not deployed**, reference only |

## Stack

| Layer | Technology |
| --- | --- |
| Runtime | [Cloudflare Workers](https://developers.cloudflare.com/workers/) (cron + fetch handlers) |
| HTTP router | [Hono](https://hono.dev/) |
| Inference | [Workers AI](https://developers.cloudflare.com/workers-ai/) via an [AI Gateway](https://developers.cloudflare.com/ai-gateway/) (spend cap) |
| State | [Cloudflare D1](https://developers.cloudflare.com/d1/) (the sole stateful binding) |
| Validation | [Zod](https://zod.dev/) |
| Language | [TypeScript](https://www.typescriptlang.org/) (strict, `noUncheckedIndexedAccess`) |
| Tests | [Vitest](https://vitest.dev/) |
| Tooling | [Wrangler](https://developers.cloudflare.com/workers/wrangler/), [pnpm](https://pnpm.io/) |

## Working with the code

> Reference only — this is not a deployment guide. If you ever run any of this, provide
> your own account, database, keys, and secrets; nothing real is committed.

```bash
pnpm install

pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm dry-run      # wrangler deploy --dry-run  (bundle check, no deploy)
pnpm dev          # wrangler dev               (local worker)
```

Runtime configuration lives in `wrangler.toml` (bindings, cron trigger, non-secret vars).
Secrets are set out-of-band and are **never** committed or placed in `[vars]`:

```bash
wrangler secret put MOLTBOOK_API_KEY      # API bearer for the social service
wrangler secret put ACCESS_KEY            # operator bearer gate for /admin/*
wrangler secret put SLACK_SIGNING_SECRET  # verifies POST /slack/events
wrangler secret put SLACK_BOT_TOKEN       # bot OAuth token for chat.postMessage
```

## Security

The whole point of this repo is the security envelope described above: an allowlisted
action set, untrusted-content chaperones on both ingress and egress, a pinned single
network egress with an origin check, a default-off kill switch, hard daily budgets, and
constant-time credential comparison on the operator gate. The load-bearing invariants live
in `src/security.ts` and `src/chaperone.ts` and are covered by the test suite.

There is no dedicated `SECURITY.md` in this archived repo. As it is not deployed, please do
not file operational security reports against it.

## Credits & third-party

Built on open-source work — thanks to the maintainers of each:

- **[Cloudflare Workers](https://developers.cloudflare.com/workers/) · [Workers AI](https://developers.cloudflare.com/workers-ai/) · [D1](https://developers.cloudflare.com/d1/) · [Wrangler](https://developers.cloudflare.com/workers/wrangler/)** — runtime, inference, storage, and tooling (`@cloudflare/workers-types`, `@cloudflare/vitest-pool-workers`).
- **[Hono](https://hono.dev/)** — the HTTP router (MIT).
- **[Zod](https://zod.dev/)** — schema validation of model output (MIT).
- **[Vitest](https://vitest.dev/)** — test runner (MIT).
- **[TypeScript](https://www.typescriptlang.org/)** (Apache-2.0) and **[pnpm](https://pnpm.io/)** (MIT).
- **[Meta Llama Guard](https://ai.meta.com/llama/)** — the classifier model the egress gate optionally invokes via Workers AI.

The chaperone / fail-closed-gate pattern mirrors the approach used in a sibling
Cloudflare-Worker project by the same author. Slack integration follows the public
[Slack Events API](https://api.slack.com/apis/events-api) request-signing convention.

## License

**License: TBD.** This archived artifact does not currently ship a `LICENSE` file — usage
terms are at the discretion of the repo owner. No support, no guarantees.
