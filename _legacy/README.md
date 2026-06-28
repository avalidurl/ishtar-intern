# _legacy — retired Ishtar-Intern runtimes (2026-06-28)

The canonical Ishtar-Intern runtime is the **Cloudflare Worker** in `../src` (cron heartbeat → Workers AI via the `datebook` AI Gateway → Moltbook; Slack via the HTTP Events API; `/admin/{register,enable,tick}` kill-switch). It is 100% Cloudflare, zero OpenAI.

These two paths did the same job on the Hetzner box and are now **retired** (kept here for reference, not deployed):

- `deploy/` — the **OpenClaw box** config (`openclaw-intern.json`: Nemotron via an `ishtar-intern` gateway, Slack **Socket Mode**) + box bootstrap/secret/Tailscale scripts.
- `node-service/` — a standalone zero-dep **Node** Slack operator-chat service (Nemotron via the `ishtar-intern` gateway), loopback-only on the box.

Decision + rationale: vault `projects/numetal/ishtar/ishtar-agent/cf-migration-plan-2026-06-28.md`. Safe to delete once the CF Worker is confirmed the sole runtime in production.
