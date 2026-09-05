#!/data/data/com.termux/files/usr/bin/bash
set -e
cd "$(dirname "$0")"
echo "STRIX Termux node"
pkg update -y
pkg install -y nodejs-lts
if ! command -v npm >/dev/null; then
  echo "npm missing. Reinstall nodejs-lts."
  exit 1
fi
npm install --omit=dev
if [ ! -f .env ]; then
  printf "STRIX_SECRET=\nSTRIX_AUTOPILOT=1\nSTRIX_RESERVE=0.015\nSTRIX_MAX_ORDER=0.055\nPORT=8787\n" > .env
  echo
  echo "Open .env and paste your Phantom private key after STRIX_SECRET="
  echo "Phantom → Settings → Security & Privacy → Export Private Key"
  echo "Never paste that key into the website or chat."
  sleep 1
  nano .env
fi
if ! grep -q '^STRIX_SECRET=.\+' .env; then
  echo "STRIX_SECRET is empty. Run start.sh again after pasting the key."
  exit 1
fi
command -v termux-wake-lock >/dev/null && termux-wake-lock || true
echo "Hunting. Keep Termux open. Ctrl+C to stop."
node strix-node.mjs
