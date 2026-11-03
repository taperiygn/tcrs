#!/bin/bash
# TCRS public-tunnel supervisor — launchd agent script.
# Keeps a trycloudflare quick tunnel up (restarts it if cloudflared dies),
# and pops one macOS notification every time a NEW url appears.
LOGDIR="$HOME/Library/Logs/tcrs"
SEEN="$HOME/Library/Application Support/TCRS/announced-tunnel-urls.txt"
mkdir -p "$LOGDIR" "$(dirname "$SEEN")" 2>/dev/null
[ -f "$SEEN" ] || touch "$SEEN" 2>/dev/null
RE='https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com'
while :; do
  : > "$LOGDIR/cloudflared.log" 2>/dev/null
  "$HOME/bin/cloudflared" tunnel --url http://127.0.0.1:8000 --no-autoupdate >> "$LOGDIR/cloudflared.log" 2>&1 &
  CF=$!
  u=""
  for i in 1 2 3 4 5 6 8 10 12 15 18 21 24; do
    sleep 5
    u=$(grep -oE "$RE" "$LOGDIR/cloudflared.log" 2>/dev/null | tail -1)
    [ -n "$u" ] && break
  done
  if [ -n "$u" ]; then
    grep -qxF "$u" "$SEEN" 2>/dev/null || {
      echo "$u" >> "$SEEN" 2>/dev/null
      printf '%s' "$u" | pbcopy 2>/dev/null
      (
        afplay /System/Library/Sounds/Ping.aiff 2>/dev/null &
        r=$(osascript -e "button returned of (display alert \"TCRS is live\" message \"$u\" buttons {\"Dismiss\", \"Open\"} default button \"Open\" giving up after 900)" 2>/dev/null)
        [ "$r" = "Open" ] && open "$u"
      ) >/dev/null 2>&1 &
    }
    echo "$(date +%FT%T) url=$u" >> "$LOGDIR/supervisor.log" 2>/dev/null
  else
    echo "$(date +%FT%T) no url from cloudflared — restarting" >> "$LOGDIR/supervisor.log" 2>/dev/null
  fi
  wait $CF 2>/dev/null     # stays here while the tunnel lives; on death, loop restarts it
  echo "$(date +%FT%T) cloudflared exited rc=$? — restarting" >> "$LOGDIR/supervisor.log" 2>/dev/null
done
