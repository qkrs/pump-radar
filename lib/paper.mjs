import { readFileSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { getSolPrice, listTracked } from "./market.mjs"

const ROOT = fileURLToPath(new URL("../data/", import.meta.url))
const FILE = join(ROOT, "session.json")

const START_SOL = 10
const FEE = 0.01
const SESSION_MS = 45 * 60 * 1000
const FLATTEN_AFTER_MS = 42 * 60 * 1000
const HARD_STOP_MS = 49 * 60 * 1000
const QUOTE_MAX_AGE_MS = 25_000
const MIN_LIQ = 400
const SNIPE_LIQ = 2200
const NEXT_RULES = "flow: score>=66, m5 0-40, liq>=2500, dos precios en 15s. snipe: 12-75s, +4% a +18% del create, m5 2-25, liq>=2200, aguanta 10s, 0.15 SOL"

const session = {
  startedAt: Date.now(),
  startSol: START_SOL,
  feeRate: FEE,
  cashSol: START_SOL,
  positions: [],
  trades: [],
  equity: [],
  solAtStart: 0,
  feesSol: 0,
  phase: "operando",
  closedAt: 0,
  rules: NEXT_RULES,
}

const lastExit = new Map()
const quotes = new Map()
let lastTick = 0
let lastSave = 0
let saveQueue = Promise.resolve()

function fresh(coin, now) {
  return coin.priceUsd > 0 && now - coin.updatedAt <= QUOTE_MAX_AGE_MS
}

function sanePrice(coin) {
  const px = coin.priceUsd
  if (!(px > 0) || px > 10000) return false
  const mcap = coin.mcapUsd || coin.fdvUsd || 0
  if (mcap > 0) {
    const supply = mcap / px
    if (supply < 1e6 || supply > 1e13) return false
  }
  return true
}

function liquid(coin) {
  return coin.reserveUsd >= MIN_LIQ
}

function flowStats(coin) {
  const m5 = coin.tx?.m5 || {}
  const m15 = coin.tx?.m15 || {}
  const a = (m5.buys || 0) + (m5.sells || 0)
  const b = (m15.buys || 0) + (m15.sells || 0)
  const use = a >= 6 ? m5 : b >= 12 ? m15 : null
  if (!use) return null
  const total = (use.buys || 0) + (use.sells || 0)
  if (!total) return null
  return { ratio: use.buys / total }
}

function blocked(coin) {
  const bad = ["pocos compradores", "presión de venta", "poca liquidez", "ya extendida", "cayendo"]
  return (coin.flags || []).some((f) => bad.includes(f))
}

function noteQuote(coin, now) {
  if (!fresh(coin, now) || !sanePrice(coin) || coin.reserveUsd < SNIPE_LIQ) return
  const arr = quotes.get(coin.mint) || []
  const last = arr.at(-1)
  if (last && now - last.t < 8000 && Math.abs(last.px - coin.priceUsd) / last.px < 0.008) return
  arr.push({ t: now, px: coin.priceUsd })
  if (arr.length > 6) arr.shift()
  quotes.set(coin.mint, arr)
}

function held(mint, now, spanMs, maxDown, maxUp) {
  const arr = quotes.get(mint) || []
  const latest = arr.at(-1)
  if (!latest || now - latest.t > 20_000) return false
  const earlier = [...arr].reverse().find((q) => latest.t - q.t >= spanMs)
  if (!earlier) return false
  if (latest.px < earlier.px * (1 - maxDown)) return false
  if (latest.px > earlier.px * (1 + maxUp)) return false
  return true
}

function judgeFlow(coin, now) {
  if (!fresh(coin, now)) return { ok: false, why: "sin precio fresco" }
  if (!sanePrice(coin)) return { ok: false, why: "precio no usable" }
  if (coin.score < 66) return { ok: false, why: "score bajo" }
  if (now - coin.createdAt < 120_000) return { ok: false, why: "todavía muy nueva para flujo" }
  const ch = coin.change?.m5 || 0
  if (ch <= 0) return { ok: false, why: "5m no está subiendo" }
  if (ch > 40) return { ok: false, why: "5m ya va demasiado arriba" }
  if ((coin.volume?.m5 || 0) < 800) return { ok: false, why: "poco volumen en 5m" }
  if (coin.reserveUsd < 2500) return { ok: false, why: "liquidez bajo $2,500" }
  if (blocked(coin)) return { ok: false, why: "flujo en contra" }
  const f = flowStats(coin)
  if (!f || f.ratio < 0.55) return { ok: false, why: "pocas compras contra ventas" }
  if (!held(coin.mint, now, 15_000, 0.08, 0.35)) return { ok: false, why: "no hay dos precios que aguanten 15s" }
  return { ok: true, why: "score, liquidez y precio firme" }
}

function judgeSnipe(coin, now, sol) {
  if (!fresh(coin, now)) return { ok: false, why: "sin precio fresco" }
  if (!sanePrice(coin) || !(sol > 0)) return { ok: false, why: "precio no usable" }
  const age = now - coin.createdAt
  if (age < 12_000) return { ok: false, why: "recién creada, todavía no se confirma" }
  if (age > 75_000) return { ok: false, why: "ya pasó la ventana" }
  if (!(coin.marketCapSol > 0)) return { ok: false, why: "no llegó el market cap de create" }
  if (coin.reserveUsd < SNIPE_LIQ) return { ok: false, why: "sin liquidez real" }
  const createUsd = coin.marketCapSol * sol
  const nowUsd = coin.mcapUsd || coin.fdvUsd || 0
  if (!(nowUsd > 0) || !(createUsd > 0)) return { ok: false, why: "sin market cap para comparar" }
  const ratio = nowUsd / createUsd
  if (ratio < 1.04) return { ok: false, why: "sigue en el precio de create" }
  if (ratio > 1.18) return { ok: false, why: "ya se alejó del create" }
  const ch = coin.change?.m5 || 0
  if (ch <= 2) return { ok: false, why: "no despegó" }
  if (ch > 25) return { ok: false, why: "vela demasiado vertical" }
  if ((coin.flags || []).some((f) => f === "cayendo" || f === "presión de venta" || f === "ya extendida")) {
    return { ok: false, why: "el flujo ya se dio vuelta" }
  }
  if (!held(coin.mint, now, 10_000, 0.06, 0.22)) return { ok: false, why: "el precio no aguantó 10s" }
  return { ok: true, why: "despegó del create y aguantó" }
}

function flowOk(coin, now) {
  return judgeFlow(coin, now).ok
}

function snipeOk(coin, now, sol) {
  return judgeSnipe(coin, now, sol).ok
}

export function gateCoin(coin, now, sol) {
  return { flow: judgeFlow(coin, now), snipe: judgeSnipe(coin, now, sol) }
}

export function observeCoins(list, now = Date.now()) {
  for (const coin of list) noteQuote(coin, now)
}

export function positionExit(pos, coin, now = Date.now()) {
  const px = markUsd(pos, coin, now)
  if (!(px > 0)) return { px: 0, reason: "" }
  const heldMs = now - pos.openedAt
  const pct = pnlPct(pos, px)
  pos.peakPct = Math.max(pos.peakPct || pct, pct)
  let reason = ""
  if (pct <= pos.stop) reason = `stop ${pos.stop}%`
  else if (pct >= pos.take) reason = `toma +${pos.take}%`
  else if (pos.book === "flow" && pos.peakPct >= 18 && pct <= pos.peakPct - 10) reason = "trailing desde el máximo"
  else if (pos.book === "flow" && heldMs >= 60_000 && (coin?.score ?? pos.score) <= 45) reason = "el score cayó"
  else if (pos.book === "flow" && heldMs >= 30_000 && (pos.flags || []).some((f) => f === "presión de venta" || f === "cayendo")) {
    reason = "el flujo se dio vuelta"
  } else if (heldMs >= pos.timeStop && pct < pos.timeMin) {
    reason = pos.book === "snipe" ? "snipe: sin continuidad" : "tiempo: 8 min sin +8%"
  }
  if (!reason) return { px, reason: "" }
  const quoteOk = coin && fresh(coin, now) && sanePrice(coin) && liquid(coin)
  const timedOut = heldMs >= pos.timeStop && pct < pos.timeMin
  const markOk = now - (pos.lastAt || 0) <= 90_000
  if (!(quoteOk || (timedOut && markOk))) return { px, reason: "" }
  return { px, reason }
}

function markUsd(pos, coin, now) {
  if (coin && fresh(coin, now) && sanePrice(coin) && liquid(coin)) {
    const jump = pos.lastPx > 0 ? coin.priceUsd / pos.lastPx : 1
    if (jump <= 2.2) {
      pos.lastPx = coin.priceUsd
      pos.lastAt = now
      pos.score = coin.score
      pos.flags = coin.flags || []
    }
  }
  return pos.lastPx
}

function pnlPct(pos, px) {
  if (!pos.entryPx || !px) return 0
  return (px / pos.entryPx - 1) * 100
}

function exitReason(pos, pct, held, elapsed, coin) {
  if (pct <= pos.stop) return `stop ${pos.stop}%`
  if (pct >= pos.take) return `toma +${pos.take}%`
  if (pos.book === "flow" && pos.peakPct >= 18 && pct <= pos.peakPct - 10) return "trailing desde el máximo"
  if (pos.book === "flow" && held >= 60_000 && (coin?.score ?? pos.score) <= 45) return "el score cayó"
  if (pos.book === "flow" && held >= 30_000 && (pos.flags || []).some((f) => f === "presión de venta" || f === "cayendo")) {
    return "el flujo se dio vuelta"
  }
  if (held >= pos.timeStop && pct < pos.timeMin) {
    return pos.book === "snipe" ? "snipe: sin continuidad" : "tiempo: 8 min sin +8%"
  }
  if (elapsed >= SESSION_MS) return "cierre de los 45 min"
  if (elapsed >= HARD_STOP_MS) return "cierre de sesión"
  return ""
}

export function tickPaper() {
  const now = Date.now()
  if (session.phase === "cerrada") return
  if (now - lastTick < 2000) return
  lastTick = now
  const sol = getSolPrice()
  if (sol > 0 && !session.solAtStart) session.solAtStart = sol
  const elapsed = now - session.startedAt
  if (elapsed >= FLATTEN_AFTER_MS && session.phase === "operando") session.phase = "cerrando"
  if (elapsed >= SESSION_MS && session.phase !== "cerrada") session.phase = "cerrando"

  const byMint = new Map(listTracked().map((c) => [c.mint, c]))
  for (const coin of byMint.values()) noteQuote(coin, now)

  for (const pos of [...session.positions]) {
    const coin = byMint.get(pos.mint)
    const px = markUsd(pos, coin, now)
    if (!(px > 0) || !(sol > 0)) continue
    const held = now - pos.openedAt
    const pct = pnlPct(pos, px)
    pos.peakPct = Math.max(pos.peakPct || pct, pct)
    const reason = exitReason(pos, pct, held, elapsed, coin)
    const quoteOk = coin && fresh(coin, now) && sanePrice(coin) && liquid(coin)
    const timedOut = held >= pos.timeStop && pct < pos.timeMin
    const markOk = px > 0 && now - (pos.lastAt || 0) <= 90_000
    if (!reason) continue
    if (quoteOk || (timedOut && markOk) || elapsed >= HARD_STOP_MS) sell(pos, px, sol, now, reason, coin)
  }

  if (session.phase === "operando" && sol > 0) {
    const flow = [...byMint.values()].filter((c) => flowOk(c, now)).sort((a, b) => b.score - a.score)
    for (const coin of flow) {
      if (session.positions.filter((p) => p.book === "flow").length >= 3) break
      if (session.positions.some((p) => p.mint === coin.mint)) continue
      if (now - (lastExit.get(coin.mint) || 0) < 15 * 60_000) continue
      const size = Math.min(0.4, equitySol(sol) * 0.1)
      if (session.cashSol < size + 0.05) break
      buy(coin, size, sol, now, "flow", { stop: -12, take: 25, timeStop: 8 * 60_000, timeMin: 8 })
    }
    const snipes = [...byMint.values()].filter((c) => snipeOk(c, now, sol)).sort((a, b) => a.createdAt - b.createdAt)
    for (const coin of snipes) {
      if (session.positions.filter((p) => p.book === "snipe").length >= 1) break
      if (session.positions.some((p) => p.mint === coin.mint)) continue
      if (lastExit.has(coin.mint)) continue
      const size = Math.min(0.15, equitySol(sol) * 0.04)
      if (session.cashSol < size + 0.05) break
      buy(coin, size, sol, now, "snipe", { stop: -8, take: 15, timeStop: 40_000, timeMin: 6 })
    }
  }

  if (session.phase === "cerrando" && session.positions.length === 0 && elapsed >= SESSION_MS) finish(now)

  if (sol > 0 && (session.equity.length === 0 || now - session.equity.at(-1).t >= 20_000)) {
    session.equity.push({
      t: now,
      equitySol: round(equitySol(sol)),
      cashSol: round(session.cashSol),
      solPrice: sol,
      open: session.positions.length,
    })
    if (session.equity.length > 200) session.equity.shift()
  }
  if (now - lastSave > 15_000) void persist()
}

function buy(coin, sizeSol, sol, now, book, exits) {
  const notionalUsd = sizeSol * sol
  const tokens = (notionalUsd * (1 - FEE)) / coin.priceUsd
  session.cashSol -= sizeSol
  session.feesSol += sizeSol * FEE
  const pos = {
    mint: coin.mint,
    symbol: coin.symbol || coin.name,
    name: coin.name,
    book,
    tokens,
    costSol: sizeSol,
    entryPx: coin.priceUsd,
    lastPx: coin.priceUsd,
    lastAt: now,
    openedAt: now,
    score: coin.score,
    flags: coin.flags || [],
    peakPct: 0,
    entrySol: sol,
    reserveUsd: coin.reserveUsd,
    ...exits,
  }
  session.positions.push(pos)
  session.trades.push({
    t: now,
    side: "buy",
    book,
    mint: coin.mint,
    symbol: pos.symbol,
    priceUsd: coin.priceUsd,
    solPrice: sol,
    sizeSol,
    feeSol: sizeSol * FEE,
    score: coin.score,
    m5: coin.change?.m5 ?? null,
    volM5: coin.volume?.m5 ?? null,
    reserveUsd: coin.reserveUsd,
    marketCapSol: coin.marketCapSol || null,
    reason: book === "snipe" ? "snipe cerca del create" : `score ${coin.score}`,
  })
  console.log(`PAPER BUY ${book} ${pos.symbol} score ${coin.score} $${coin.priceUsd} liq ${Math.round(coin.reserveUsd)} size ${sizeSol}`)
  void persist()
}

function sell(pos, priceUsd, sol, now, reason, coin) {
  const proceedsSol = (pos.tokens * priceUsd * (1 - FEE)) / sol
  const feeSol = (pos.tokens * priceUsd * FEE) / sol
  session.cashSol += proceedsSol
  session.feesSol += feeSol
  const pnlSol = proceedsSol - pos.costSol
  session.positions = session.positions.filter((p) => p.mint !== pos.mint)
  lastExit.set(pos.mint, now)
  session.trades.push({
    t: now,
    side: "sell",
    book: pos.book,
    mint: pos.mint,
    symbol: pos.symbol,
    priceUsd,
    solPrice: sol,
    sizeSol: proceedsSol,
    feeSol,
    pnlSol,
    pnlPct: pnlPct(pos, priceUsd),
    score: coin?.score ?? pos.score,
    holdSec: Math.round((now - pos.openedAt) / 1000),
    reserveUsd: coin?.reserveUsd ?? null,
    reason,
  })
  console.log(`PAPER SELL ${pos.book} ${pos.symbol} ${reason} pnl ${pnlSol.toFixed(4)} SOL (${pnlPct(pos, priceUsd).toFixed(1)}%)`)
  if (session.phase === "cerrando" && session.positions.length === 0 && now - session.startedAt >= SESSION_MS) finish(now)
  void persist()
}

function equitySol(sol) {
  let eq = session.cashSol
  for (const pos of session.positions) {
    eq += pos.lastPx > 0 && sol > 0 ? (pos.tokens * pos.lastPx) / sol : pos.costSol
  }
  return eq
}

function finish(now) {
  session.phase = "cerrada"
  session.closedAt = now
  void persist()
  console.log("PAPER session closed")
}

function round(n) {
  return Math.round(n * 1e6) / 1e6
}

export function getPaper() {
  const now = Date.now()
  const sol = getSolPrice()
  const sells = session.trades.filter((t) => t.side === "sell")
  return {
    startedAt: session.startedAt,
    endsAt: session.startedAt + SESSION_MS,
    phase: session.phase,
    startSol: START_SOL,
    cashSol: session.cashSol,
    equitySol: sol > 0 ? equitySol(sol) : session.cashSol,
    realizedSol: sells.reduce((s, t) => s + (t.pnlSol || 0), 0),
    feesSol: session.feesSol,
    solPrice: sol,
    solAtStart: session.solAtStart,
    rules: session.rules,
    nextRules: NEXT_RULES,
    positions: session.positions.map((p) => ({
      mint: p.mint,
      symbol: p.symbol,
      book: p.book,
      entryPx: p.entryPx,
      lastPx: p.lastPx,
      score: p.score,
      pnlPct: pnlPct(p, p.lastPx),
      ageSec: Math.round((now - p.openedAt) / 1000),
    })),
    trades: session.trades.slice(-12).reverse(),
    tradeCount: session.trades.length,
    equityCurve: session.equity,
  }
}

async function persist() {
  lastSave = Date.now()
  const snap = { ...getPaper(), closedAt: session.closedAt, tradesAll: session.trades, equityAll: session.equity }
  saveQueue = saveQueue.then(async () => {
    await mkdir(dirname(FILE), { recursive: true })
    const tmp = FILE + ".tmp"
    await writeFile(tmp, JSON.stringify(snap))
    await rename(tmp, FILE)
  }).catch((err) => console.error("paper save", err.message))
}

function boot() {
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8"))
    if (raw?.phase !== "cerrada" || !Array.isArray(raw.tradesAll)) return
    session.startedAt = raw.startedAt
    session.cashSol = raw.cashSol
    session.feesSol = raw.feesSol || 0
    session.solAtStart = raw.solAtStart || 0
    session.phase = "cerrada"
    session.closedAt = raw.closedAt || 0
    session.trades = raw.tradesAll
    session.equity = raw.equityAll || raw.equityCurve || []
    session.positions = []
    session.rules = raw.rules || session.rules
  } catch (err) {
    if (err.code !== "ENOENT") {
      session.phase = "cerrada"
      console.error("paper ledger unreadable, not starting a new session", err.message)
    }
  }
}

boot()
