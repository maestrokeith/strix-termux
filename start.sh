#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

echo "STRIX Termux node"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Installing Node.js..."
  pkg update -y
  pkg install -y nodejs-lts
fi

npm install --omit=dev

if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo "Created .env from .env.example"
  echo "Simulation mode is enabled by default."
  echo "Edit local settings with: nano .env"
fi

# Never print secrets.
if grep -q '^STRIX_DRY=0' .env 2>/dev/null; then
  echo "Live execution is disabled in this setup."
  echo "Set STRIX_DRY=1 in .env and run again."
  exit 1
fi

command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true

echo "Starting STRIX in simulation mode..."
echo "Ctrl+C to stop."
node strix-node.mjs
