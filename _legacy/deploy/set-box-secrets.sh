#!/usr/bin/env bash
# Push the intern box's secrets into /etc/ishtar-intern/env securely.
# Values are read SILENTLY and sent over the (encrypted) SSH channel via stdin —
# never echoed, never in argv, never in shell history. Run this on your Mac.
#
# Usage:  ./set-box-secrets.sh <host>
#   <host> is REQUIRED: the box's public IP before lockdown, or its tailnet name
#   (e.g. ishtar-intern) after lockdown. No default — pass it explicitly.
set -euo pipefail

HOST="${1:?usage: set-box-secrets.sh <host>   (public IP pre-lockdown, or tailnet name after)}"
KEY="$HOME/.ssh/gokhan-agent"

# Cloudflare account id — non-secret but not committed. Provide via env, e.g.
#   CF_ACCOUNT_ID=<your-account-id> ./set-box-secrets.sh <host>
CF_ACCOUNT_ID="${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID in the environment before running (Cloudflare account id)}"

read -rs -p "CF_AI_TOKEN (scoped Workers-AI Read token): " CF; echo
read -rs -p "SLACK_SIGNING_SECRET: " SS; echo
read -rs -p "SLACK_BOT_TOKEN (xoxb-...): " BT; echo
read -r  -p "SLACK_FOUNDER_USER_ID (U..., optional — Enter to skip): " FU
read -r  -p "SLACK_TEAM_ID (T..., optional — Enter to skip): " TM

[ -n "$CF" ] && [ -n "$SS" ] && [ -n "$BT" ] || { echo "CF_AI_TOKEN + both Slack secrets are required." >&2; exit 1; }

cat <<EOF | ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "root@$HOST" \
  'umask 077; cat > /etc/ishtar-intern/env && chmod 600 /etc/ishtar-intern/env && systemctl restart ishtar-intern 2>/dev/null; printf "env written; service=%s\n" "$(systemctl is-active ishtar-intern 2>/dev/null || echo staged)"'
CF_ACCOUNT_ID=$CF_ACCOUNT_ID
AI_GATEWAY_ID=ishtar-intern
CHAT_MODEL=@cf/nvidia/nemotron-3-120b-a12b
FALLBACK_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast
DAILY_USD_BUDGET=5
MAX_TOKENS=1024
PORT=8787
DB_PATH=/opt/ishtar-intern/data/intern.db
CF_AI_TOKEN=$CF
SLACK_SIGNING_SECRET=$SS
SLACK_BOT_TOKEN=$BT
SLACK_TEAM_ID=$TM
SLACK_FOUNDER_USER_ID=$FU
EOF

unset CF SS BT
echo "Done. Tell Claude to continue (start ingress + verify)."
