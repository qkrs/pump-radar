import { GRADUATION_MCAP_SOL, scoreCoin } from "./score.mjs"

const GECKO = "https://api.geckoterminal.com/api/v2"
const DEX = "https://api.dexscreener.com"
const SOL_MINT = "So11111111111111111111111111111111111111112"
const UA = "pump-radar"

const coins = new Map()
let solPrice = 0
let portalState = "cerrado"
let lastError = ""
let geckoOk = false
let version = 0
let onUpdate = () => {}

const geckoQ = []
let geckoBusy = false
let geckoGap = 6500
let lastGecko = 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

function zeroWin() {
  return { m5: 0, m15: 0, m30: 0, h1: 0, h6: 0, h24: 0 }
}
function zeroTx() {
  const z = () => ({ buys: 0, sells: 0, buyers: 0, sellers: 0 })
  return { m5: z(), m15: z(), m30: z(), h1: z(), h6: z(), h24: z() }
}

function blank(mint) {
  return {
    mint,
    pool: null,
    name: "Nuevo",
    symbol: "",
    image: null,
    dex: "pump-fun",
    graduated: false,
    mayhem: false,
    boosted: false,
    boostAmount: 0,
    priceUsd: 0,
    fdvUsd: 0,
    mcapUsd: 0,
    reserveUsd: 0,
    marketCapSol: 0,
    createdAt: Date.now(),
    change: zeroWin(),
    volume: zeroWin(),
    tx: zeroTx(),
    spark: [],
    bars: [],
    barBasis: null,
    score: 0,
    progress: 0,
    parts: {},
    flags: [],
    trendingRank: null,
    trendingAt: 0,
    updatedAt: Date.now(),
    dexAt: 0,
    creator: null,
    metaUri: null,
  }
}

function noteSol(px) {
  if (px > 5 && px < 100000) solPrice = solPrice ? solPrice * 0.8 + px * 0.2 : px
}

function rescore(coin) {
  if (!coin.fdvUsd && coin.marketCapSol && solPrice) {
    coin.fdvUsd = coin.marketCapSol * solPrice
    coin.mcapUsd = coin.fdvUsd
  }
  const scored = scoreCoin(coin, solPrice)
  coin.score = scored.score
  coin.progress = scored.progress
  coin.parts = scored.parts
  coin.flags = scored.flags
  noteSeries(coin)
}

function noteSeries(coin) {
  const usePrice = coin.priceUsd > 0
  const basis = usePrice ? "price" : "fdv"
  const px = usePrice ? coin.priceUsd : coin.fdvUsd
  if (!px) return
  if (coin.barBasis && coin.barBasis !== basis) coin.bars = []
  coin.barBasis = basis
  const t = Math.floor(Date.now() / 60000) * 60000
  const last = coin.bars[coin.bars.length - 1]
  if (!last || last.t !== t) {
    coin.bars.push({ t, o: px, h: px, l: px, c: px, v: coin.volume.m5 || 0 })
    if (coin.bars.length > 240) coin.bars.splice(0, coin.bars.length - 240)
  } else {
    last.h = Math.max(last.h, px)
    last.l = Math.min(last.l, px)
    last.c = px
  }
  if (coin.spark.at(-1) !== px) coin.spark.push(px)
  if (coin.spark.length > 24) coin.spark.shift()
}

function touch() {
  version += 1
  onUpdate()
}

export function startMarket(cb) {
  onUpdate = cb
  connectPortal()
  void primeSol()
  setInterval(() => {
    if (geckoQ.length < 1) discovery[discI++ % discovery.length]()
  }, 8000)
  setInterval(() => void refreshDexBatch(), 4000)
  setInterval(() => void pullBoosts(), 30000)
  void pullBoosts()
  setInterval(() => {
    const now = Date.now()
    for (const c of coins.values()) {
      if (c.marketCapSol && solPrice && c.fdvUsd === 0) rescore(c)
      if (c.trendingAt && now - c.trendingAt > 4 * 60 * 1000) c.trendingRank = null
    }
    evict()
  }, 5000)
}

async function primeSol() {
  try {
    const res = await fetch(`${DEX}/latest/dex/tokens/${SOL_MINT}`, {
      headers: { accept: "application/json", "user-agent": UA },
    })
    const json = await res.json()
    const pair = (json.pairs || []).find((p) => num(p.priceUsd) > 5)
    if (pair) noteSol(num(pair.priceUsd))
    touch()
  } catch (err) {
    lastError = "sol: " + err.message
  }
}

function connectPortal() {
  let ws
  let backoff = 1000
  const open = () => {
    portalState = "conectando"
    try {
      ws = new WebSocket("wss://pumpportal.fun/api/data")
    } catch (err) {
      portalState = "error"
      lastError = err.message
      setTimeout(open, backoff)
      backoff = Math.min(backoff * 2, 20000)
      return
    }
    ws.addEventListener("open", () => {
      portalState = "en vivo"
      backoff = 1000
      ws.send(JSON.stringify({ method: "subscribeNewToken" }))
      ws.send(JSON.stringify({ method: "subscribeMigration" }))
      touch()
    })
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data))
        if (msg.txType === "create" && msg.mint) applyCreate(msg)
        else if (msg.mint && String(msg.txType || "").toLowerCase().includes("migrat")) {
          const coin = coins.get(msg.mint) || blank(msg.mint)
          coin.graduated = true
          coin.dex = "pumpswap"
          coin.updatedAt = Date.now()
          coins.set(msg.mint, coin)
          rescore(coin)
          touch()
        }
      } catch {
        /* ignore malformed frames */
      }
    })
    ws.addEventListener("close", () => {
      portalState = "reconectando"
      touch()
      setTimeout(open, backoff)
      backoff = Math.min(backoff * 2, 20000)
    })
    ws.addEventListener("error", () => {
      try { ws.close() } catch { /* already closing */ }
    })
  }
  open()
}

function applyCreate(msg) {
  const coin = coins.get(msg.mint) || blank(msg.mint)
  coin.name = msg.name || coin.name
  coin.symbol = msg.symbol || coin.symbol
  coin.mayhem = Boolean(msg.is_mayhem_mode)
  coin.creator = msg.traderPublicKey || coin.creator
  coin.metaUri = msg.uri || coin.metaUri
  coin.marketCapSol = num(msg.marketCapSol) || coin.marketCapSol
  coin.dex = coin.dex || "pump-fun"
  coin.createdAt = coin.createdAt || Date.now()
  coin.updatedAt = Date.now()
  if (solPrice && coin.marketCapSol) {
    coin.fdvUsd = coin.marketCapSol * solPrice
    coin.mcapUsd = coin.fdvUsd
  }
  coins.set(msg.mint, coin)
  rescore(coin)
  enqueueMeta(coin)
  touch()
}

const metaQ = []
let metaBusy = false
function enqueueMeta(coin) {
  if (!coin.metaUri || coin.image || metaQ.includes(coin.mint)) return
  metaQ.push(coin.mint)
  if (metaQ.length > 40) metaQ.splice(0, metaQ.length - 40)
  void drainMeta()
}
async function drainMeta() {
  if (metaBusy) return
  metaBusy = true
  while (metaQ.length) {
    const mint = metaQ.shift()
    const coin = coins.get(mint)
    if (!coin || coin.image || !coin.metaUri) continue
    try {
      const res = await fetch(coin.metaUri, { signal: AbortSignal.timeout(4000) })
      if (!res.ok) continue
      const meta = await res.json()
      const img = normalizeImage(meta.image || meta.image_uri)
      if (img) {
        coin.image = img
        touch()
      }
    } catch {
      /* metadata is best-effort */
    }
    await sleep(250)
  }
  metaBusy = false
}

function normalizeImage(url) {
  if (!url || typeof url !== "string") return null
  if (url.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + url.slice("ipfs://".length)
  return url
}

function gecko(path, priority = false) {
  return new Promise((resolve) => {
    const job = { path, resolve }
    if (priority) geckoQ.unshift(job)
    else geckoQ.push(job)
    void drainGecko()
  })
}

async function drainGecko() {
  if (geckoBusy) return
  geckoBusy = true
  while (geckoQ.length) {
    const wait = geckoGap - (Date.now() - lastGecko)
    if (wait > 0) await sleep(wait)
    const job = geckoQ.shift()
    lastGecko = Date.now()
    try {
      const res = await fetch(GECKO + job.path, {
        headers: { accept: "application/json", "user-agent": UA },
      })
      if (res.status === 429) {
        geckoGap = 12000
        setTimeout(() => { geckoGap = 6500 }, 50000)
        lastError = "gecko limitado, bajando ritmo"
        geckoOk = false
        job.resolve(null)
      } else if (!res.ok) {
        job.resolve(null)
      } else {
        geckoOk = true
        if (lastError.startsWith("gecko")) lastError = ""
        job.resolve(await res.json())
      }
    } catch (err) {
      lastError = err.message
      job.resolve(null)
    }
  }
  geckoBusy = false
}

function indexIncluded(json) {
  const map = new Map()
  for (const item of json?.included || []) map.set(item.id, item.attributes || {})
  return map
}

function ingestPools(json, { trending = false } = {}) {
  const included = indexIncluded(json)
  let rank = 0
  let n = 0
  for (const pool of json?.data || []) {
    const dex = pool.relationships?.dex?.data?.id
    if (dex !== "pump-fun" && dex !== "pumpswap") continue
    const baseId = pool.relationships?.base_token?.data?.id || ""
    const mint = baseId.split("_").pop()
    if (!mint) continue
    const quoteId = pool.relationships?.quote_token?.data?.id || ""
    const a = pool.attributes || {}
    if (quoteId.endsWith(SOL_MINT)) noteSol(num(a.quote_token_price_usd))
    const token = included.get(baseId) || {}
    const coin = coins.get(mint) || blank(mint)
    coin.pool = a.address || coin.pool
    coin.name = token.name || String(a.name || coin.name).split(" / ")[0]
    coin.symbol = token.symbol || coin.symbol
    coin.image = token.image_url || coin.image
    coin.dex = dex
    coin.graduated = dex === "pumpswap" || coin.graduated
    const px = num(a.base_token_price_usd)
    if (px) coin.priceUsd = px
    const fdv = num(a.fdv_usd) || num(a.market_cap_usd)
    if (fdv) {
      coin.fdvUsd = fdv
      coin.mcapUsd = num(a.market_cap_usd) || fdv
    }
    if (a.reserve_in_usd != null && a.reserve_in_usd !== "") coin.reserveUsd = num(a.reserve_in_usd)
    const created = Date.parse(a.pool_created_at)
    if (created && (!coin.createdAt || created < coin.createdAt)) coin.createdAt = created
    const ch = a.price_change_percentage || {}
    const vol = a.volume_usd || {}
    const tx = a.transactions || {}
    for (const w of ["m5", "m15", "m30", "h1", "h6", "h24"]) {
      if (ch[w] != null) coin.change[w] = num(ch[w])
      if (vol[w] != null) coin.volume[w] = num(vol[w])
      if (tx[w]) {
        coin.tx[w] = {
          buys: tx[w].buys || 0,
          sells: tx[w].sells || 0,
          buyers: tx[w].buyers || 0,
          sellers: tx[w].sellers || 0,
        }
      }
    }
    if (trending) {
      coin.trendingRank = rank++
      coin.trendingAt = Date.now()
    }
    coin.updatedAt = Date.now()
    coins.set(mint, coin)
    rescore(coin)
    n += 1
  }
  if (n) touch()
}

const discovery = [
  () => gecko("/networks/solana/new_pools?page=1&include=base_token").then((j) => j && ingestPools(j)),
  () => gecko("/networks/solana/trending_pools?page=1&include=base_token&duration=5m").then((j) => j && ingestPools(j, { trending: true })),
  () => gecko("/networks/solana/dexes/pump-fun/pools?page=1&include=base_token&sort=h24_volume_usd_desc").then((j) => j && ingestPools(j)),
  () => gecko("/networks/solana/dexes/pumpswap/pools?page=1&include=base_token&sort=h24_tx_count_desc").then((j) => j && ingestPools(j)),
  () => gecko("/networks/solana/trending_pools?page=1&include=base_token&duration=1h").then((j) => j && ingestPools(j)),
]
let discI = 0

async function refreshDexBatch() {
  const nowMs = Date.now()
  const fresh = [...coins.values()]
    .filter((c) => nowMs - c.createdAt < 4 * 60 * 1000)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 12)
  const hot = [...coins.values()].sort((a, b) => b.score - a.score).slice(0, 10)
  const rest = [...coins.values()].sort((a, b) => (a.dexAt || 0) - (b.dexAt || 0))
  const batch = []
  const seen = new Set()
  for (const coin of [...fresh, ...hot, ...rest]) {
    if (seen.has(coin.mint)) continue
    seen.add(coin.mint)
    batch.push(coin)
    if (batch.length === 30) break
  }
  if (!batch.length) return
  const ids = batch.map((c) => c.mint).join(",")
  try {
    const res = await fetch(`${DEX}/latest/dex/tokens/${ids}`, {
      headers: { accept: "application/json", "user-agent": UA },
    })
    if (!res.ok) return
    const json = await res.json()
    const best = new Map()
    const pairRank = (pair) =>
      (pair.dexId === "pumpfun" || pair.dexId === "pumpswap" ? 1e15 : 0) + num(pair.liquidity?.usd)
    for (const pair of json.pairs || []) {
      if (pair.chainId !== "solana") continue
      const mint = pair.baseToken?.address
      if (!mint) continue
      const prev = best.get(mint)
      if (!prev || pairRank(pair) > pairRank(prev)) best.set(mint, pair)
    }
    const now = Date.now()
    for (const coin of batch) coin.dexAt = now
    for (const pair of best.values()) applyDex(pair)
    touch()
  } catch (err) {
    lastError = "dex: " + err.message
  }
}

function applyDex(pair) {
  const mint = pair.baseToken.address
  const coin = coins.get(mint) || blank(mint)
  const dex = pair.dexId === "pumpswap" ? "pumpswap" : pair.dexId === "pumpfun" ? "pump-fun" : coin.dex
  if (pair.dexId === "pumpfun" || pair.dexId === "pumpswap" || coin.dex) coin.dex = dex
  if (pair.dexId === "pumpswap") coin.graduated = true
  coin.pool = pair.pairAddress || coin.pool
  coin.name = pair.baseToken.name || coin.name
  coin.symbol = pair.baseToken.symbol || coin.symbol
  coin.image = pair.info?.imageUrl || coin.image
  if (num(pair.priceUsd)) coin.priceUsd = num(pair.priceUsd)
  if (num(pair.fdv)) coin.fdvUsd = num(pair.fdv)
  if (num(pair.marketCap)) coin.mcapUsd = num(pair.marketCap)
  else if (coin.fdvUsd) coin.mcapUsd = coin.fdvUsd
  if (pair.liquidity && pair.liquidity.usd != null) coin.reserveUsd = num(pair.liquidity.usd)
  if (pair.pairCreatedAt && (!coin.createdAt || pair.pairCreatedAt < coin.createdAt)) {
    coin.createdAt = pair.pairCreatedAt
  }
  if (pair.quoteToken?.address === SOL_MINT && num(pair.priceUsd) && num(pair.priceNative)) {
    noteSol(num(pair.priceUsd) / num(pair.priceNative))
  }
  for (const w of ["m5", "h1", "h6", "h24"]) {
    if (pair.priceChange?.[w] != null) coin.change[w] = num(pair.priceChange[w])
    if (pair.volume?.[w] != null) coin.volume[w] = num(pair.volume[w])
    if (pair.txns?.[w]) {
      coin.tx[w] = {
        buys: pair.txns[w].buys || 0,
        sells: pair.txns[w].sells || 0,
        buyers: coin.tx[w]?.buyers || 0,
        sellers: coin.tx[w]?.sellers || 0,
      }
    }
  }
  if (pair.boosts?.active) {
    coin.boosted = true
    coin.boostAmount = pair.boosts.active
  }
  coin.updatedAt = Date.now()
  coins.set(mint, coin)
  rescore(coin)
}

async function pullBoosts() {
  try {
    const [top, latest] = await Promise.all([
      fetch(`${DEX}/token-boosts/top/v1`, { headers: { "user-agent": UA } }).then((r) => r.json()),
      fetch(`${DEX}/token-boosts/latest/v1`, { headers: { "user-agent": UA } }).then((r) => r.json()),
    ])
    const rows = [...(Array.isArray(top) ? top : []), ...(Array.isArray(latest) ? latest : [])]
    let n = 0
    for (const row of rows) {
      if (row.chainId !== "solana") continue
      const mint = row.tokenAddress
      if (!mint || !mint.toLowerCase().endsWith("pump")) continue
      const coin = coins.get(mint) || blank(mint)
      coin.boosted = true
      coin.boostAmount = Math.max(coin.boostAmount || 0, row.amount || row.totalAmount || 1)
      if (!coin.image && typeof row.icon === "string" && row.icon.startsWith("http")) {
        coin.image = row.icon
      }
      coins.set(mint, coin)
      rescore(coin)
      n += 1
    }
    if (n) touch()
  } catch (err) {
    lastError = "boosts: " + err.message
  }
}

function evict() {
  if (coins.size <= 450) return
  const ranked = [...coins.values()].sort((a, b) => keepScore(a) - keepScore(b))
  for (const coin of ranked.slice(0, coins.size - 400)) coins.delete(coin.mint)
}

function keepScore(c) {
  let s = c.score
  if (c.trendingRank != null) s += 40
  if (Date.now() - c.createdAt < 15 * 60 * 1000) s += 25
  if (c.boosted) s += 15
  if (c.mayhem) s += 15
  return s
}

function publicCoin(c) {
  return {
    mint: c.mint,
    pool: c.pool,
    name: c.name,
    symbol: c.symbol,
    image: c.image,
    dex: c.dex,
    graduated: c.graduated,
    mayhem: c.mayhem,
    boosted: c.boosted,
    priceUsd: c.priceUsd,
    fdvUsd: c.fdvUsd || c.mcapUsd,
    mcapUsd: c.mcapUsd || c.fdvUsd,
    reserveUsd: c.reserveUsd,
    marketCapSol: c.marketCapSol,
    createdAt: c.createdAt,
    change: {
      m5: c.change.m5, m15: c.change.m15, h1: c.change.h1, h24: c.change.h24,
    },
    volume: { m5: c.volume.m5, m15: c.volume.m15, h1: c.volume.h1 },
    tx: { m5: c.tx.m5, m15: c.tx.m15, h1: c.tx.h1 },
    progress: c.progress,
    score: c.score,
    parts: c.parts,
    flags: c.flags,
    spark: c.spark,
    trendingRank: c.trendingRank,
    updatedAt: c.updatedAt,
    creator: c.creator,
    barBasis: c.barBasis,
  }
}

export function getSolPrice() {
  return solPrice
}

export function listTracked() {
  return [...coins.values()].map(publicCoin)
}

export function getSnapshot() {
  const ranked = [...coins.values()].sort((a, b) => keepScore(b) - keepScore(a)).slice(0, 280)
  return {
    version,
    serverTime: Date.now(),
    solPrice,
    graduationSol: GRADUATION_MCAP_SOL,
    targetUsd: solPrice ? solPrice * GRADUATION_MCAP_SOL : 0,
    status: {
      portal: portalState,
      gecko: geckoOk,
      tracked: coins.size,
      fresh: [...coins.values()].filter((c) => Date.now() - (c.updatedAt || 0) < 90_000).length,
      lastError,
    },
    coins: ranked.map(publicCoin),
  }
}

const TF = {
  "1": { kind: "minute", agg: 1, limit: 120, ms: 60_000 },
  "5": { kind: "minute", agg: 5, limit: 120, ms: 300_000 },
  "15": { kind: "minute", agg: 15, limit: 96, ms: 900_000 },
  "60": { kind: "hour", agg: 1, limit: 72, ms: 3_600_000 },
}

const candleCache = new Map()
const tradeCache = new Map()

export async function getCoinDetail(mint, tfKey) {
  const coin = coins.get(mint)
  if (!coin) return null
  const tf = TF[tfKey] || TF["1"]
  const cacheKey = `${mint}|${tfKey || "1"}`
  const cachedCandles = candleCache.get(cacheKey)
  const cachedTrades = tradeCache.get(mint)
  const now = Date.now()
  const ref = coin.priceUsd || (coin.fdvUsd > 0 ? coin.fdvUsd / 1e9 : 0)
  if (coin.pool && geckoQ.length < 2) {
    const wantCandles = !cachedCandles || now - cachedCandles.at > 50000 || cachedCandles.candles.length < 2
    const wantTrades = !cachedTrades || now - cachedTrades.at > 20000
    if (wantCandles) {
      const ohlcv = await gecko(
        `/networks/solana/pools/${coin.pool}/ohlcv/${tf.kind}?aggregate=${tf.agg}&limit=${tf.limit}&currency=usd`,
        true,
      )
      const parsed = parseCandles(ohlcv)
      candleCache.set(cacheKey, { at: Date.now(), candles: parsed.length ? parsed : (cachedCandles?.candles || []) })
    } else if (wantTrades) {
      const tape = await gecko(`/networks/solana/pools/${coin.pool}/trades`, true)
      const parsed = parseTrades(tape, ref).slice(0, 40)
      if (parsed.length) tradeCache.set(mint, { at: Date.now(), trades: parsed })
    }
  }
  const remote = candleCache.get(cacheKey)?.candles || []
  const trades = tradeCache.get(mint)?.trades || []
  const candles = mergeCandles(remote, aggregate(coin.bars, tf.ms))
  return {
    coin: publicCoin(coin),
    candles,
    trades,
    basis: coin.barBasis || "price",
    targetUsd: solPrice ? solPrice * GRADUATION_MCAP_SOL : 0,
  }
}

function parseCandles(json) {
  const list = json?.data?.attributes?.ohlcv_list || []
  return list.map((row) => {
    const ts = num(row[0])
    return {
      t: ts > 1e12 ? ts : ts * 1000,
      o: num(row[1]),
      h: num(row[2]),
      l: num(row[3]),
      c: num(row[4]),
      v: num(row[5]),
    }
  }).filter((c) => c.t && c.c).sort((a, b) => a.t - b.t)
}

function parseTrades(json, refPrice) {
  return (json?.data || []).map((row) => {
    const a = row.attributes || row
    const kind = String(a.kind || a.side || "").toLowerCase()
    return {
      ts: Date.parse(a.block_timestamp || a.timestamp || "") || Date.now(),
      side: kind.includes("sell") ? "sell" : "buy",
      usd: num(a.volume_in_usd),
      price: closestPrice([num(a.price_from_in_usd), num(a.price_to_in_usd)], refPrice),
      wallet: a.tx_from_address || "",
      tx: a.tx_hash || "",
    }
  }).filter((t) => t.usd || t.price)
}

function closestPrice(candidates, ref) {
  const xs = candidates.filter((n) => n > 0)
  if (!xs.length) return 0
  if (!ref) return Math.min(...xs)
  return xs.reduce((best, n) =>
    Math.abs(Math.log(n / ref)) < Math.abs(Math.log(best / ref)) ? n : best)
}

function aggregate(bars, ms) {
  if (!bars?.length) return []
  const bucket = new Map()
  for (const bar of bars) {
    const t = Math.floor(bar.t / ms) * ms
    const cur = bucket.get(t)
    if (!cur) bucket.set(t, { t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v || 0 })
    else {
      cur.h = Math.max(cur.h, bar.h)
      cur.l = Math.min(cur.l, bar.l)
      cur.c = bar.c
      cur.v = Math.max(cur.v, bar.v || 0)
    }
  }
  return [...bucket.values()].sort((a, b) => a.t - b.t)
}

function mergeCandles(remote, local) {
  const map = new Map()
  for (const c of remote) map.set(c.t, { ...c })
  for (const c of local) {
    const prev = map.get(c.t)
    if (!prev) map.set(c.t, { ...c })
    else {
      map.set(c.t, {
        t: c.t,
        o: prev.o,
        h: Math.max(prev.h, c.h),
        l: Math.min(prev.l, c.l),
        c: c.c,
        v: prev.v || c.v,
      })
    }
  }
  return [...map.values()].sort((a, b) => a.t - b.t).slice(-180)
}
