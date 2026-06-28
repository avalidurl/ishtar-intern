#!/usr/bin/env bash
# Securely capture the Tailscale auth key into the agent-secrets store.
# You run this; the key is read SILENTLY — never echoed to the screen, never in shell history.
set -euo pipefail

dir="$HOME/.config/agent-secrets/tailscale"
mkdir -p "$dir"

printf 'Paste the Tailscale auth key (tskey-auth-...), then press Enter: '
read -rs KEY
echo

[ -n "$KEY" ] || { echo "No key entered — aborting." >&2; exit 1; }
case "$KEY" in
  tskey-*) ;;
  *) echo "That doesn't look like a tskey-… auth key — aborting to be safe." >&2; exit 1 ;;
esac

umask 077
printf 'TS_AUTHKEY=%s\n' "$KEY" > "$dir/.env"
chmod 600 "$dir/.env"
unset KEY

echo "Stored → $dir/.env (chmod 600). Key not displayed. Tell Claude to continue."
