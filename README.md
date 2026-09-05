# STRIX Termux node

A Termux-friendly STRIX research/simulation node.

## Install

```bash
pkg update -y
pkg install -y git nodejs-lts
git clone https://github.com/maestrokeith/strix-termux.git
cd strix-termux
cp .env.example .env
nano .env
bash start.sh
```

The repository is configured for **simulation mode by default**.

- `.env` is ignored by Git and stays on the phone.
- Do not commit passwords, API keys, seed phrases, or wallet private keys.
- `node_modules` is ignored.
- The local service listens on port `8787` by default.

## Quick verification

```bash
cd ~/strix-termux
git status
grep '^STRIX_DRY=' .env
bash start.sh
```

Expected setting:

```
STRIX_DRY=1
```
