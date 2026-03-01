#!/bin/bash
# Restart one or all RemoteLab services.
# Usage:
#   restart.sh          — restart all services
#   restart.sh chat     — restart only chat-server
#   restart.sh proxy    — restart only auth-proxy
#   restart.sh tunnel   — restart only cloudflared

set -e

SERVICE="${1:-all}"

restart_service() {
  local label="$1"
  local plist="$HOME/Library/LaunchAgents/${label}.plist"
  local name="$2"

  if [ ! -f "$plist" ]; then
    echo "  $name: plist not found, skipping"
    return
  fi

  if launchctl list | grep -q "$label"; then
    launchctl stop "$label" 2>/dev/null || true
    # KeepAlive will auto-restart; wait for new process
    sleep 1
    echo "  $name: restarted ($(launchctl list | grep "$label" | awk '{print "pid="$1}'))"
  else
    launchctl load "$plist" 2>/dev/null
    echo "  $name: loaded"
  fi
}

case "$SERVICE" in
  chat)
    echo "Restarting chat-server..."
    restart_service "com.chatserver.claude" "chat-server"
    ;;
  proxy)
    echo "Restarting auth-proxy..."
    restart_service "com.authproxy.claude" "auth-proxy"
    ;;
  tunnel)
    echo "Restarting cloudflared..."
    restart_service "com.cloudflared.tunnel" "cloudflared"
    ;;
  all)
    echo "Restarting all services..."
    restart_service "com.authproxy.claude" "auth-proxy"
    restart_service "com.chatserver.claude" "chat-server"
    restart_service "com.cloudflared.tunnel" "cloudflared"
    ;;
  *)
    echo "Unknown service: $SERVICE"
    echo "Usage: restart.sh [chat|proxy|tunnel|all]"
    exit 1
    ;;
esac

echo "Done!"
