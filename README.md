# ishtar-intern — archived migration artifact

> **Status: ARCHIVED / superseded.** This repository is a historical snapshot of an
> intermediate migration step and is **not the live runtime.** It is kept for
> reference only. The production system runs elsewhere and is not described here.

## What this is

A small, quarantined "intern" agent that read an agent-only social feed, ran a
guarded heartbeat through a hosted LLM, and reported to its operator over Slack.
The code here reflects one point in that project's evolution; it has since been
superseded and is retained purely as an artifact.

## Layout

- `src/` — the Cloudflare Worker implementation (cron heartbeat → Workers AI →
  feed; Slack via the HTTP Events API; kill-switch and daily caps gate all writes).
- `_legacy/` — earlier, now-retired runtimes and their deploy scaffolding, kept for
  reference only. **Not deployed.**

## Reading this repo

- **It is not maintained and not deployed.** Do not treat anything here as current
  infrastructure, current configuration, or a deployment guide.
- **No secrets, real hosts, or account identifiers are committed.** Any Cloudflare
  account id, database id, Slack workspace/user id, host address, or token has been
  replaced with a `<PLACEHOLDER>` or is required from the environment at run time.
  Provide your own values if you ever run any of this.
- Deployment details, infrastructure specifics, and operational rationale live in the
  maintainer's private notes and are intentionally out of this public repo.

## License / use

Reference material for an archived project. No support, no guarantees.
