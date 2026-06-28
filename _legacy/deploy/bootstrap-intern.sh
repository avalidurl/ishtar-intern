#!/usr/bin/env bash
# Ishtar Intern VPS bootstrap — Hetzner + Tailscale, hardened, tailnet-only.
# Mirrors the lockdown in vault projects/intel/infra-hetzner-openclaw.md, but with a LEAN
# setup: Node + Tailscale + Squid egress-allowlist only — NO Docker, NO OpenClaw (the intern
# runs a small Node service, not an OpenClaw gateway).
#
# Usage (as root on fresh Ubuntu 24.04):
#   bash bootstrap-intern.sh setup
#   tailscale up --authkey=<key> --ssh --hostname=ishtar-intern   # join the tailnet
#   # verify `ssh ishtar-intern` from the Mac over the tailnet, attach zero-inbound cloud fw, THEN:
#   bash bootstrap-intern.sh lockdown
set -euo pipefail

AGENT_USER="${AGENT_USER:-intern}"
NODE_MAJOR="22"
APP_DIR="/opt/ishtar-intern"

phase="${1:-}"
[[ "$phase" == "setup" || "$phase" == "lockdown" ]] || { echo "usage: bootstrap-intern.sh setup|lockdown"; exit 1; }
[[ "$(id -u)" -eq 0 ]] || { echo "run as root"; exit 1; }

# ---------------------------------------------------------------- setup
if [[ "$phase" == "setup" ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y && apt-get upgrade -y
  apt-get install -y curl git ca-certificates ufw unattended-upgrades openssl squid jq

  # security patches apply themselves
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

  # dedicated non-root user for the service
  id "$AGENT_USER" &>/dev/null || adduser --disabled-password --gecos "" "$AGENT_USER"

  # tailscale (auth is done separately — authkey or interactive)
  command -v tailscale &>/dev/null || curl -fsSL https://tailscale.com/install.sh | sh

  # node (no docker, no openclaw — the intern is a plain Node service)
  if ! command -v node &>/dev/null || [[ "$(node -v 2>/dev/null | sed 's/v//;s/\..*//')" -lt "$NODE_MAJOR" ]]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
  fi

  install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 750 "$APP_DIR"

  # Squid — deny-by-default egress allowlist (app-level domain filter; the cloud firewall
  # is the network-level control). The Node service points HTTPS_PROXY at this. Mirrors the
  # INTEL box's minimal squid.conf (replace, don't layer over the distro default).
  [[ -f /etc/squid/squid.conf.orig ]] || cp /etc/squid/squid.conf /etc/squid/squid.conf.orig 2>/dev/null || true
  [[ -f /etc/squid/allowed-domains.txt ]] || cat >/etc/squid/allowed-domains.txt <<'EOF'
slack.com
.slack.com
api.anthropic.com
EOF
  cat >/etc/squid/squid.conf <<'EOF'
http_port 127.0.0.1:3128
acl allowed dstdomain "/etc/squid/allowed-domains.txt"
http_access allow allowed
http_access deny all
cache deny all
EOF
  systemctl restart squid || true

  cat <<'NEXT'

== setup done — DO THESE IN ORDER ==
1. tailscale up --authkey=<key> --ssh --hostname=ishtar-intern
2. Attach the zero-inbound Hetzner cloud firewall
3. From the Mac: ssh ishtar-intern   (tailnet / Tailscale SSH)
4. bash bootstrap-intern.sh lockdown
NEXT
fi

# ------------------------------------------------------------- lockdown
if [[ "$phase" == "lockdown" ]]; then
  # refuse unless tailscale is up — prevents locking ourselves out
  tailscale status &>/dev/null || { echo "tailscale not up — aborting lockdown"; exit 1; }

  ufw default deny incoming
  ufw default allow outgoing
  ufw allow in on tailscale0
  ufw --force enable

  cat >/etc/ssh/sshd_config.d/99-intern-hardening.conf <<'EOF'
PasswordAuthentication no
PermitRootLogin prohibit-password
EOF
  systemctl restart ssh || systemctl restart sshd

  echo "== locked down: inbound = tailnet only (cloud-fw zero-inbound + ufw deny-in; key-only) =="
fi
