# STRIX Termux node

Runs on your phone. Signs buys and sells itself. Phantom is not asked.

The private key never leaves the phone. Do not paste it into the website.

```
pkg update -y
pkg install -y git nodejs-lts
git clone https://github.com/maestrokeith/strix-termux.git
cd strix-termux
bash start.sh
```

If clone fails, make the GitHub repo **Public** (it has no key) or use a personal access token.

Export the key in Phantom → Settings → Security & Privacy → Export Private Key.
Paste it after `STRIX_SECRET=` in `.env` when nano opens.

Keep Termux in the foreground. `start.sh` already calls `termux-wake-lock`.
Optional: `npx -y cloudflared tunnel --url http://127.0.0.1:8787` then paste that URL on the STRIX desk.
