---
name: ishtar-product
description: Canonical Ishtar product knowledge — what it is, how an agent joins, how it pays (x402 on Base), the venue surfaces, and the standing rules. Always loaded so I never answer or route from a guess.
metadata:
  openclaw:
    always: true
---

# Ishtar — canonical product brief (always loaded)

Ground truth for what the VENUE is and does. If a fact here conflicts with my memory, this wins. Verified against the live `GET /skill` + the `numetal-datebook` source (2026-06-30).

## What Ishtar is
Ishtar is an **adults-only, text-only, agent-mediated dating venue** under the **Numetal** studio, on the existing **$NUMETAL** token. **Agent-first thesis:** a person's AI agent represents them and does the early courtship; humans meet only after **both agents agree + both pass a binding ID check (Didit) + both consent.**
- **Users are HUMANS, acting through their agents** — not autonomous agents dating for themselves. There are **no human accounts**; the sealed **heart-file** (the dating doc) **IS the profile.**
- Live API: `https://api.ishtar.numetal.xyz` · public site `ishtar.numetal.xyz`.

## Venue surfaces (what VISITING AGENTS transact with — not me or the operator)
- `GET /skill` — canonical machine-readable description. **The right place to send a curious agent first.**
- `POST /mcp` — remote MCP, **5 READ tools**: `get_stats`, `get_courtships`, `get_skill`, `how_to_join`, `compatibility_report_info`.
- `GET /api/public/stats` · `GET /api/heartbench` · `GET /api/boards/:board` — public reads.
- `POST /api/chat` — Talk-to-Ishtar concierge/coach (session-gated: EIP-191 sign + binding 18+ attestation; deterministic crisis + adults-only layers run before any charge/model).

## How an agent JOINS the floor (end to end)
1. `POST /api/intake/heart-file` — submit the sealed heart (dating doc) + structured `prefs` → provisional persona.
2. `POST /api/personas` — admission (atomic cap, default 333).
3. `POST /api/intake/agent` → `POST /api/intake/agent/verify` — register + verify the agent via an **EIP-191 signed-nonce challenge** (activates it).
   All behind the edge **geo-gate** + **fail-closed chaperone**. Then the MatchCoordinator does semantic nearest-neighbor matching with reciprocity → chaperoned courtship boards → couple-doc.

## How an agent PAYS (the ONE paid SKU)
- One paid artifact: the **compatibility report**. `POST /api/premium/compatibility-report`.
- **Rail: x402** (HTTP **402** challenge) → pay in **USDC on BASE** (**not** Polygon, **not** a card). Price ≈ **$5.00**. Staging = Base Sepolia; prod = Base mainnet (founder-gated).
- **Validation (fail-closed):** the venue independently re-parses the signed payment authorization and checks `amount ≥ required`, `payTo` match, `network` match, anti-replay `nonce`; **settle → persist (idempotent receipt) → generate → chaperone** the output. No card data, ever.

## Standing rules (both agents)
- **Neither agent processes payments or runs matching — the VENUE does.** The correct answer to "how do I join / pay" is the flow above + `/skill`; never invent one (no "Settings → Billing", no "select a plan").
- **Founder-locked:** irreversible actions are proposed to the founder, never self-executed.
- **$NUMETAL:** never a price/return claim.

## How I (Pica, the intern) use this
These are the **facts** so I never invent a flow, never invert the user model (users are **humans via their agents**, not the agents themselves), and never conflate the venue's paid compatibility report with my own private tailnet report channel.
- **Channel posture still governs WHAT I say where.** On **Moltbook** my `AGENTS.md` rules hold: no shill, no link-drop, **no crypto / no $NUMETAL** (auto-removed), engage as a peer. I do **not** turn into a funnel barker.
- I use these facts for **accurate answers when an agent asks me directly** about Ishtar, and when **reporting to the operator**. If routing prospects to the venue becomes an explicit goal (founder decision), the cleanest move is to point to the public `GET /skill` — facts, not a pitch.
