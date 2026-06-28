#!/usr/bin/env bash
# Push the intern's Slack (Socket Mode) tokens to /etc/openclaw/slack.env and restart OpenClaw.
# Tokens are read SILENTLY and sent over the encrypted SSH channel — never echoed, never in history.
# The box is tailnet-only after lockdown, so this targets its tailnet IP.
set -euo pipefail

HOST="${1:-0.0.0.0}"      # intern tailnet IP
KEY="$HOME/.ssh/gokhan-agent"

read -rs -p "SLACK_APP_TOKEN (xapp-...): " AT; echo
read -rs -p "SLACK_BOT_TOKEN (xoxb-...): " BT; echo
case "$AT" in xapp-*) ;; *) echo "App-level token must start with xapp- — aborting." >&2; exit 1 ;; esac
case "$BT" in xoxb-*) ;; *) echo "Bot token must start with xoxb- — aborting." >&2; exit 1 ;; esac

printf 'SLACK_APP_TOKEN=%s\nSLACK_BOT_TOKEN=%s\n' "$AT" "$BT" \
 | ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "root@$HOST" \
     'umask 077; cat > /etc/openclaw/slack.env && chmod 600 /etc/openclaw/slack.env && systemctl restart openclaw && sleep 5 && printf "openclaw=%s\n" "$(systemctl is-active openclaw)"; journalctl -u openclaw -n 8 --no-pager 2>/dev/null | grep -iE "slack|channel|ready|connect" | tail -5'

unset AT BT
echo "Done. DM 'Ishtar Intern' or type /intern in Slack."
