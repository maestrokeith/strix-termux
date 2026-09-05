import http from "node:http";
import fs from "node:fs";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

const SOL = "So11111111111111111111111111111111111111112";
const JUP = "https://lite-api.jup.ag/swap/v1";
const RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const ENGINES = [
  "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles",
];
const KNOWN = new Set(["SOL", "BTC", "ETH", "USDC", "USDT", "BONK", "WIF", "JUP", "TRUMP", "XRP", "PEPE", "DOGE"]);

function loadEnv() {
  const raw = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
  for (const line of raw.split("\n")) {
    const i = line.indexOf("=");
    if (i < 1 || line.trim().startsWith("#")) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();

const SECRET = (process.env.STRIX_SECRET || "").trim();
const PORT = Number(process.env.PORT || 8787);
const RESERVE = Number(process.env.STRIX_RESERVE || 0.015);
const MAX_ORDER = Number(process.env.STRIX_MAX_ORDER || 0.055);
const AUTOPILOT = (process.env.STRIX_AUTOPILOT || "1") !== "0";
const DRY = (process.env.STRIX_DRY || "0") === "1";

if (!SECRET) {
  console.error("STRIX_SECRET missing in .env");
  process.exit(1);
}

function parseKey(s) {
  const t = s.trim();
  if (t.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(t)));
  return Keypair.fromSecretKey(bs58.decode(t));
}
const kp = parseKey(SECRET);
const pubkey = kp.publicKey.toBase58();

const state = {
  armed: AUTOPILOT,
  sol: 0,
  lastScanAt: 0,
  lastError: null,
  positions: [],
  attempted: new Set(),
  events: [],
  busy: false,
};

function log(title, detail = "") {
  const row = { at: Date.now(), title, detail };
  state.events.unshift(row);
  state.events = state.events.slice(0, 40);
  console.log(`${new Date().toISOString().slice(11, 19)}  ${title}${detail ? " · " + detail : ""}`);
}

async function fetchJson(url, ms = 6000, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { accept: "application/json", ...(init?.headers || {}) } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function rpc(method, params) {
  for (const url of RPCS) {
    const json = await fetchJson(url, 7000, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (json?.result !== undefined) return json.result;
  }
  return null;
}

async function refreshSol() {
  const r = await rpc("getBalance", [pubkey]);
  if (r?.value != null) state.sol = r.value / 1e9;
}

async function tokenRaw(mint) {
  const r = await rpc("getTokenAccountsByOwner", [pubkey, { mint }, { encoding: "jsonParsed" }]);
  return r?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.amount ?? "0";
}

async function tipLamports() {
  const rows = await fetchJson("https://bundles.jito.wtf/api/v1/bundles/tip_floor", 2500);
  const p75 = Number(rows?.[0]?.landed_tips_75th_percentile) || 0.001;
  return Math.round(Math.min(0.05, Math.max(0.001, p75 + 0.0002)) * 1e9);
}

async function sendBundle(signedB64) {
  const raw = Buffer.from(signedB64, "base64");
  const encoded = bs58.encode(raw);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendBundle", params: [[encoded]] });
  for (const url of ENGINES) {
    const json = await fetchJson(url, 2500, { method: "POST", headers: { "content-type": "application/json" }, body });
    const id = json?.result?.[0] || json?.result;
    if (typeof id === "string" && id.length > 20) return id;
  }
  const sig = await rpc("sendTransaction", [encoded, { encoding: "base58", skipPreflight: true }]);
  if (typeof sig === "string") return sig;
  throw new Error("Bundle did not land");
}

function signB64(swapTransaction) {
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([kp]);
  return Buffer.from(tx.serialize()).toString("base64");
}

async function jupSwap({ inputMint, outputMint, amount, slippageBps }) {
  const tip = await tipLamports();
  const quote = await fetchJson(
    `${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`,
  );
  if (!quote?.outAmount) throw new Error("No Jupiter route");
  const impact = Number(quote.priceImpactPct) || 0;
  if (impact > 3.2) throw new Error(`Impact ${impact.toFixed(2)}%`);
  const swap = await fetchJson(`${JUP}/swap`, 8000, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userPublicKey: pubkey,
      quoteResponse: quote,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      skipUserAccountsRpcCalls: true,
      prioritizationFeeLamports: { jitoTipLamports: tip },
    }),
  });
  if (!swap?.swapTransaction) throw new Error("Jupiter did not return a transaction");
  return { swapTransaction: swap.swapTransaction, outAmount: String(quote.outAmount), inAmount: String(quote.inAmount) };
}

async function execute(swapTransaction) {
  if (DRY) return "dry_" + Date.now();
  const signed = signB64(swapTransaction);
  return sendBundle(signed);
}

function cloneOf(symbol) {
  const key = String(symbol || "").replace(/[^\w$]/g, "").toUpperCase().slice(0, 12);
  return KNOWN.has(key) && key !== "UNK" ? key : null;
}

function bestBook(t) {
  if (!t?.mint || t.honeypot || t.mintAuth || t.freezeAuth) return false;
  if (cloneOf(t.symbol)) return false;
  if ((t.liq || 0) < 1800) return false;
  if (t.chg != null && t.chg < -22) return false;
  const n = (t.buys || 0) + (t.sells || 0);
  if (n >= 8 && t.sells > t.buys * 1.7) return false;
  if ((t.conv || 0) >= 76) return true;
  return (t.conv || 0) >= 72 && (t.vol || 0) >= 6000 && (t.buys || 0) >= (t.sells || 0);
}

function score(t) {
  let s = 40;
  if (!t.mintAuth) s += 10;
  if (!t.freezeAuth) s += 10;
  if (t.liq >= 40000) s += 8;
  else if (t.liq >= 8000) s += 5;
  else if (t.liq < 1800) s -= 12;
  if (cloneOf(t.symbol) || t.honeypot) s = 8;
  const n = (t.buys || 0) + (t.sells || 0);
  if (n >= 8 && t.sells / n < 0.42) s += 6;
  if (t.vol >= 25000) s += 5;
  return Math.max(0, Math.min(99, s));
}

async function scan() {
  const [pump, boosts] = await Promise.all([
    fetchJson("https://frontend-api-v3.pump.fun/coins?offset=0&limit=30&sort=last_trade_timestamp&order=DESC&includeNsfw=false", 4000),
    fetchJson("https://api.dexscreener.com/token-boosts/latest/v1", 3000),
  ]);
  const mints = [];
  const pumpBy = new Map();
  const coins = Array.isArray(pump) ? pump : pump?.coins || [];
  for (const c of coins) {
    if (!c?.mint) continue;
    pumpBy.set(c.mint, c);
    mints.push(c.mint);
  }
  if (Array.isArray(boosts)) {
    for (const b of boosts) if (b.chainId === "solana" && b.tokenAddress) mints.push(b.tokenAddress);
  }
  const uniq = [...new Set(mints)].slice(0, 24);
  const rows = [];
  for (let i = 0; i < uniq.length; i += 12) {
    const chunk = uniq.slice(i, i + 12);
    const dex = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`, 4000);
    const by = new Map();
    for (const p of dex?.pairs || []) {
      if (p.chainId !== "solana" || !p.baseToken?.address) continue;
      const prev = by.get(p.baseToken.address);
      if (!prev || (p.liquidity?.usd || 0) > (prev.liquidity?.usd || 0)) by.set(p.baseToken.address, p);
    }
    for (const mint of chunk) {
      const p = by.get(mint);
      const c = pumpBy.get(mint);
      const t = {
        mint,
        symbol: p?.baseToken?.symbol || c?.symbol || "UNK",
        liq: p?.liquidity?.usd || (Number(c?.virtual_sol_reserves) > 1e6 ? (Number(c.virtual_sol_reserves) / 1e9) * 150 : Number(c?.usd_market_cap) || 0),
        vol: p?.volume?.h1 || 0,
        buys: p?.txns?.h1?.buys || 0,
        sells: p?.txns?.h1?.sells || 0,
        chg: typeof p?.priceChange?.h1 === "number" ? p.priceChange.h1 : null,
        price: Number(p?.priceUsd) || 0.00001,
        mintAuth: false,
        freezeAuth: false,
        honeypot: false,
      };
      t.conv = score(t);
      rows.push(t);
    }
  }
  state.lastScanAt = Date.now();
  return rows.sort((a, b) => b.conv - a.conv);
}

function orderLamports() {
  const spendable = Math.max(0, state.sol - RESERVE);
  if (spendable < 0.025) return 0;
  return Math.floor(Math.min(MAX_ORDER, spendable * 0.08, spendable - 0.002) * 1e9);
}

async function buy(t) {
  const lamports = orderLamports();
  if (lamports < 12_000_000) throw new Error("Need more SOL above reserve");
  const built = await jupSwap({ inputMint: SOL, outputMint: t.mint, amount: lamports, slippageBps: 700 });
  const sig = await execute(built.swapTransaction);
  const pos = {
    mint: t.mint,
    symbol: t.symbol,
    entrySol: lamports / 1e9,
    entryPrice: t.price,
    price: t.price,
    peak: t.price,
    remaining: 1,
    openedAt: Date.now(),
    tokenRaw: built.outAmount,
    status: "open",
  };
  state.positions.unshift(pos);
  state.attempted.add(t.mint);
  log("BUY " + t.symbol, `${(lamports / 1e9).toFixed(3)} SOL · ${sig.slice(0, 8)}`);
  await refreshSol();
}

async function sell(p, frac, reason) {
  let raw = p.tokenRaw;
  if (!raw || raw === "0") raw = await tokenRaw(p.mint);
  const total = BigInt(raw || "0");
  if (total <= 0n) throw new Error("No tokens");
  const sold = (total * BigInt(Math.round(frac * 1000))) / 1000n;
  const built = await jupSwap({
    inputMint: p.mint,
    outputMint: SOL,
    amount: (sold <= 0n ? total : sold).toString(),
    slippageBps: 1100,
  });
  const sig = await execute(built.swapTransaction);
  p.remaining = Math.max(0, p.remaining - frac);
  if (p.remaining <= 0.05) p.status = "closed";
  log("SELL " + p.symbol, `${reason} · ${sig.slice(0, 8)}`);
  await refreshSol();
}

async function manage() {
  for (const p of state.positions.filter((x) => x.status === "open")) {
    const roi = ((p.price - p.entryPrice) / Math.max(1e-12, p.entryPrice)) * 100;
    const age = Date.now() - p.openedAt;
    try {
      if (roi <= -6) await sell(p, 1, "stop");
      else if (age > 90_000 && roi < 10) await sell(p, 1, "timer");
      else if (p.remaining > 0.4 && roi >= 10) await sell(p, 0.7, "tp1");
      else if (roi >= 18) {
        const floor = p.peak * 0.94;
        if (p.price <= floor) await sell(p, 1, "trail");
      }
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : "sell failed";
      log("SELL FAIL " + p.symbol, state.lastError);
    }
  }
}

async function hunt() {
  if (!state.armed || state.busy) return;
  state.busy = true;
  try {
    await refreshSol();
    const tape = await scan();
    const open = state.positions.filter((p) => p.status === "open");
    for (const p of open) {
      const hit = tape.find((t) => t.mint === p.mint);
      if (hit?.price) {
        p.price = hit.price;
        p.peak = Math.max(p.peak, hit.price);
      }
    }
    await manage();
    if (open.length >= 3) return;
    if (state.sol < RESERVE + 0.025) return;
    const next = tape.find((t) => bestBook(t) && !state.attempted.has(t.mint) && !open.some((p) => p.mint === t.mint));
    if (!next) return;
    await buy(next);
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : "hunt failed";
    log("HUNT", state.lastError);
  } finally {
    state.busy = false;
  }
}

function cors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        pubkey,
        sol: state.sol,
        armed: state.armed,
        dry: DRY,
        positions: state.positions.slice(0, 8),
        events: state.events.slice(0, 12),
        lastError: state.lastError,
        lastScanAt: state.lastScanAt,
      }),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/arm") {
    const body = await new Promise((resolve) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => resolve(s));
    });
    try {
      const j = JSON.parse(body || "{}");
      if (typeof j.armed === "boolean") state.armed = j.armed;
    } catch {
      /* ignore */
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, armed: state.armed }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/sign") {
    const body = await new Promise((resolve) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => resolve(s));
    });
    try {
      const j = JSON.parse(body || "{}");
      if (!j.swapTransaction) throw new Error("Missing swapTransaction");
      const sig = await execute(j.swapTransaction);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, signature: sig, pubkey }));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "sign failed" }));
    }
    return;
  }
  res.writeHead(404);
  res.end("strix");
});

server.listen(PORT, "0.0.0.0", async () => {
  await refreshSol();
  log("ONLINE", `${pubkey.slice(0, 4)}…${pubkey.slice(-4)} · ${state.sol.toFixed(3)} SOL · :${PORT}`);
  log(AUTOPILOT ? "AUTOPILOT ON" : "SIGNER ONLY", DRY ? "dry" : "live");
  if (AUTOPILOT) void hunt();
  setInterval(() => void hunt(), 3000);
});
