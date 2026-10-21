import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { getSolPrice, listTracked } from "./market.mjs"
import { gateCoin, observeCoins, positionExit } from "./paper.mjs"
import { encodeBase58, listHoldings, loadWallet, poolSolUi, saveWallet, settledExit, solBalance, tokenHolding, tokenUi, walletPath } from "./solana.mjs"
import { assertExit, swap } from "./swap.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const STATE = join(ROOT, "data", "live-bot.json")
const KEY = walletPath(ROOT)
const RESERVE_USD = 1
const FLOW_USD = 5
const SNIPE_USD = 3
const BUDGET_USD = 15
const FLOW_M5_MAX = 22
const FLOW_H1_MAX = 160
const REENTRY_MS = 3 * 60_000
const SELL_SLIPPAGE = 12

const state = {
  phase: "espera",
  reason: "",
  startedAt: 0,
  endsAt: 0,
  stoppedAt: 0,
  budgetUsd: BUDGET_USD,
  maxLossUsd: 5,
  targetUsd: 3,
  minutes: 45,
  cashUsd: 0,
  walletUsd: 0,
  solUsd: 0,
  totalUsd: 0,
  holdings: [],
  closeBlock: "",
  realizedUsd: 0,
  pnlUsd: 0,
  locking: false,
  positions: [],
  exits: {},
  rejects: {},
  rejectWhy: {},
  trades: [],
  picks: [],
  feed: [],
}

const inflight = new Set()
let wallet = null
let running = false
let lastBalance = 0

function log(line) {
  console.log(line)
}

async function save() {
  await mkdir(dirname(STATE), { recursive: true })
  const tmp = STATE + ".tmp"
  const pub = wallet ? encodeBase58(wallet.pubkey) : ""
  await writeFile(tmp, JSON.stringify({ ...state, publicKey: pub }))
  await rename(tmp, STATE)
}

export async function loadLive() {
  try {
    const raw = JSON.parse(await readFile(STATE, "utf8"))
    state.positions = raw.positions || []
    state.exits = raw.exits || {}
    state.rejects = {}
    state.rejectWhy = {}
    state.trades = raw.trades || []
    const stillGoing = raw.phase === "operando" && raw.endsAt > Date.now()
    const active = raw.phase === "operando" || raw.phase === "cerrando"
    if (stillGoing || active || raw.phase === "frenado") {
      state.phase = stillGoing ? "operando" : active ? "cerrando" : "frenado"
      state.locking = Boolean(raw.locking) && stillGoing
      state.reason = stillGoing
        ? (state.locking ? (raw.reason || "profit aceptable") : "")
        : active
          ? (raw.reason || "se reinició el servidor")
          : (raw.reason || "")
      state.startedAt = raw.startedAt || 0
      state.endsAt = raw.endsAt || 0
      state.stoppedAt = raw.stoppedAt || 0
      state.budgetUsd = raw.budgetUsd || state.budgetUsd
      state.maxLossUsd = raw.maxLossUsd || state.maxLossUsd
      state.targetUsd = raw.targetUsd || state.targetUsd
      state.minutes = raw.minutes || state.minutes
      state.cashUsd = raw.cashUsd || 0
      state.realizedUsd = raw.realizedUsd || 0
      state.pnlUsd = raw.pnlUsd || 0
      state.feed = raw.feed || []
      state.picks = raw.picks || []
    }
  } catch (err) {
    if (err.code !== "ENOENT") log(`estado del bot ilegible: ${err.message}`)
  }
  try {
    wallet = await loadWallet(KEY)
    log(`Billetera lista ${encodeBase58(wallet.pubkey)}`)
  } catch (err) {
    if (err.code !== "ENOENT") log(`clave no cargada: ${err.message}`)
  }
}

export async function storeKey(text) {
  wallet = await saveWallet(KEY, text)
  return encodeBase58(wallet.pubkey)
}

export function forgetKey() {
  wallet = null
}

function limits(input) {
  const minutes = Math.min(180, Math.max(5, Number(input.minutes) || 45))
  const budgetUsd = Math.min(BUDGET_USD, Math.max(5, Number(input.budgetUsd) || BUDGET_USD))
  const maxLossUsd = Math.min(budgetUsd, Math.max(1, Number(input.maxLossUsd) || 5))
  const targetUsd = Math.min(budgetUsd, Math.max(1, Number(input.targetUsd) || 3))
  return { minutes, budgetUsd, maxLossUsd, targetUsd }
}

export async function startLive(input) {
  if (!wallet) throw new Error("primero guardá la clave en la página")
  if (state.phase === "operando" || state.phase === "cerrando") throw new Error("ya está operando")
  const cfg = limits(input || {})
  const sol = getSolPrice()
  if (!(sol > 0)) throw new Error("todavía no hay precio del dólar")
  const walletUsd = (await solBalance(wallet.pubkey)) * sol
  if (walletUsd < cfg.budgetUsd) {
    throw new Error(`hacen falta $${cfg.budgetUsd.toFixed(0)} en la billetera. Hay $${walletUsd.toFixed(2)}.`)
  }
  state.phase = "operando"
  state.reason = ""
  state.startedAt = Date.now()
  state.endsAt = state.startedAt + cfg.minutes * 60_000
  state.stoppedAt = 0
  state.budgetUsd = cfg.budgetUsd
  state.maxLossUsd = cfg.maxLossUsd
  state.targetUsd = cfg.targetUsd
  state.minutes = cfg.minutes
  state.cashUsd = cfg.budgetUsd
  state.walletUsd = walletUsd
  state.realizedUsd = 0
  state.pnlUsd = 0
  state.locking = false
  state.positions = []
  state.exits = {}
  state.rejects = {}
  state.rejectWhy = {}
  state.closeBlock = ""
  state.trades = []
  state.picks = []
  state.feed = [{ t: Date.now(), kind: "arranque", detail: `presupuesto $${cfg.budgetUsd.toFixed(0)}` }]
  await save()
  log(`BOT operando $${cfg.budgetUsd} por ${cfg.minutes} min, frena en -$${cfg.maxLossUsd} o +$${cfg.targetUsd}`)
  return publicStatus()
}

export function stopLive(reason = "parada manual") {
  if (state.phase !== "operando" && state.phase !== "cerrando") return publicStatus()
  state.phase = "cerrando"
  state.reason = reason
  void save()
  return publicStatus()
}

function safeFlow(coin, now, sol) {
  const gate = gateCoin(coin, now, sol).flow
  if (!gate.ok) return gate
  if ((coin.change?.m5 || 0) > FLOW_M5_MAX) return { ok: false, why: `5m por encima de ${FLOW_M5_MAX}%` }
  if ((coin.change?.h1 || 0) > FLOW_H1_MAX) return { ok: false, why: `la hora ya va por encima de ${FLOW_H1_MAX}%` }
  if ((coin.reserveUsd || 0) < 8000) return { ok: false, why: "pool bajo $8,000" }
  return gate
}

function bookSize(book) {
  const cap = book === "snipe" ? SNIPE_USD : FLOW_USD
  return Math.min(cap, state.cashUsd - RESERVE_USD)
}

function openPnl(haircut) {
  let pnl = 0
  for (const pos of state.positions) {
    const cost = pos.costUsd || pos.sizeUsd || 0
    const mark = pos.lastPx > 0 && pos.tokens > 0 ? pos.tokens * pos.lastPx * haircut : 0
    pnl += mark - cost
  }
  return pnl
}

function applyHalt(now) {
  state.pnlUsd = state.realizedUsd + openPnl(1)
  const halt = haltReason(now)
  if (halt === "profit aceptable" && state.phase === "operando") {
    if (!state.locking) {
      state.locking = true
      state.reason = halt
      note({ kind: "freno", detail: "ganancia hecha: deja salir la moneda con su propio trailing" })
      log(`BOT deja de abrir: ${halt}`)
    }
  } else if (halt && state.phase === "operando") {
    state.phase = "cerrando"
    state.locking = false
    state.reason = halt
    note({ kind: "freno", detail: halt })
    log(`BOT frena: ${halt}`)
  }
}

function haltReason(now) {
  if (state.endsAt && now >= state.endsAt) return "se acabó el tiempo"
  if (state.realizedUsd + openPnl(0.75) <= -state.maxLossUsd) return "pérdida máxima"
  if (state.realizedUsd >= state.targetUsd) return "profit aceptable"
  return ""
}

async function buy(coin, book, exits, sizeUsd, sol) {
  if (inflight.has(coin.mint) || rejected(coin.mint, Date.now())) return
  inflight.add(coin.mint)
  try {
    const solAmount = Number((sizeUsd / sol).toFixed(4))
    await assertExit(coin.mint, solAmount)
    if (coin.pool) {
      const pooled = await poolSolUi(coin.pool)
      if (!(pooled * sol >= 8000)) throw new Error("pool en la cadena bajo $8,000")
    }
    const before = await tokenUi(wallet.pubkey, coin.mint)
    const solBefore = await solBalance(wallet.pubkey)
    const signature = await swap(wallet, {
      action: "buy",
      mint: coin.mint,
      amount: solAmount,
      denominatedInSol: true,
    })
    let got = 0
    for (let i = 0; i < 6; i++) {
      got = (await tokenUi(wallet.pubkey, coin.mint)) - before
      if (got > 0) break
      await new Promise((r) => setTimeout(r, 1500))
    }
    if (!(got > 0)) throw new Error("la compra confirmó y el token no apareció")
    const solAfter = await solBalance(wallet.pubkey)
    const spentUsd = solBefore > solAfter ? (solBefore - solAfter) * sol : sizeUsd
    state.positions.push({
      mint: coin.mint,
      symbol: coin.symbol || coin.name,
      book,
      tokens: got,
      entryPx: coin.priceUsd,
      lastPx: coin.priceUsd,
      lastAt: Date.now(),
      openedAt: Date.now(),
      score: coin.score,
      flags: coin.flags || [],
      peakPct: 0,
      sizeUsd: spentUsd,
      costUsd: spentUsd,
      pool: coin.pool || "",
      signature,
      ...exits,
    })
    state.trades.push({ t: Date.now(), side: "buy", book, mint: coin.mint, symbol: coin.symbol, sizeUsd: spentUsd, signature })
    state.cashUsd = Math.max(0, state.cashUsd - spentUsd)
    note({ kind: "compra", symbol: coin.symbol, book, detail: `$${spentUsd.toFixed(2)}`, sizeUsd: spentUsd })
    await save()
    log(`BUY ${book} ${coin.symbol} $${sizeUsd.toFixed(2)} ${signature}`)
  } catch (err) {
    const hard = /bad request|no encuentra pool|no devolvería|sin liquidez|pool en la cadena/i.test(err.message)
    if (hard) {
      state.rejects[coin.mint] = Date.now() + 15 * 60_000
      state.rejectWhy[coin.mint] = detail
    }
    const detail = /bad request/i.test(err.message) ? "PumpPortal no arma la orden de esta moneda" : err.message
    note({
      kind: "fallo",
      symbol: coin.symbol,
      book,
      detail,
    })
    log(`BUY falló ${coin.symbol}: ${err.message}`)
  } finally {
    inflight.delete(coin.mint)
  }
}

async function closeAlreadyGone(pos) {
  const found = await settledExit(wallet.pubkey, pos.mint).catch(() => null)
  const price = getSolPrice() || 0
  const proceeds = found && found.solDelta > 0 && price > 0 ? found.solDelta * price : 0
  const pnlUsd = proceeds - (pos.costUsd || pos.sizeUsd || 0)
  state.positions = state.positions.filter((p) => p.mint !== pos.mint)
  state.realizedUsd += pnlUsd
  state.pnlUsd = state.realizedUsd + openPnl(1)
  state.cashUsd += proceeds
  state.exits[pos.mint] = Date.now()
  if (!state.positions.some((p) => p.stuck)) state.closeBlock = ""
  state.trades.push({
    t: Date.now(),
    side: "sell",
    book: pos.book,
    mint: pos.mint,
    symbol: pos.symbol,
    reason: "ya estaba vendida",
    signature: found?.signature || "",
    pnlUsd,
    sizeUsd: pos.sizeUsd,
  })
  note({ kind: "venta", symbol: pos.symbol, book: pos.book, detail: "ya estaba vendida", pnlUsd })
  await save()
  log(`SELL ${pos.book} ${pos.symbol} ya estaba vendida ${found?.signature || ""}`)
}

async function sell(pos, reason) {
  if (inflight.has(pos.mint)) return
  inflight.add(pos.mint)
  try {
    const holding = await tokenHolding(wallet.pubkey, pos.mint)
    if (holding.raw <= 0n) {
      await closeAlreadyGone(pos)
      return
    }
    const solBefore = await solBalance(wallet.pubkey)
    const signature = await swap(wallet, {
      action: "sell",
      mint: pos.mint,
      amount: pos.tokens,
      denominatedInSol: false,
      slippage: SELL_SLIPPAGE,
    })
    const solAfter = await solBalance(wallet.pubkey)
    const price = getSolPrice() || 0
    const proceeds = solAfter > solBefore && price > 0 ? (solAfter - solBefore) * price : 0
    const pnlUsd = proceeds - (pos.costUsd || pos.sizeUsd || 0)
    state.realizedUsd += pnlUsd
    state.pnlUsd = state.realizedUsd + openPnl(1)
    state.cashUsd += proceeds
    state.positions = state.positions.filter((p) => p.mint !== pos.mint)
    state.exits[pos.mint] = Date.now()
    if (!state.positions.some((p) => p.stuck)) state.closeBlock = ""
    state.trades.push({ t: Date.now(), side: "sell", book: pos.book, mint: pos.mint, symbol: pos.symbol, reason, signature, pnlUsd, sizeUsd: pos.sizeUsd })
    note({ kind: "venta", symbol: pos.symbol, book: pos.book, detail: reason, pnlUsd })
    await save()
    log(`SELL ${pos.book} ${pos.symbol} ${reason} ${signature}`)
  } catch (err) {
    const dry = /sin liquidez|other amount threshold/i.test(err.message)
    if (dry) {
      pos.stuck = true
      pos.lastPx = 0
      state.closeBlock = `${pos.symbol} no se puede vender: el pool quedó sin liquidez`
      note({ kind: "fallo", symbol: pos.symbol, book: pos.book, detail: "el pool quedó sin liquidez, no se puede vender" })
      log(`SELL ${pos.symbol}: pool sin liquidez`)
      await save()
    } else {
      state.closeBlock = `${pos.symbol} no se puede vender: ${err.message}`
      note({ kind: "fallo", symbol: pos.symbol, book: pos.book, detail: err.message })
      log(`SELL falló ${pos.symbol}: ${err.message}`)
    }
  } finally {
    inflight.delete(pos.mint)
  }
}

async function refreshBalance() {
  if (!wallet || Date.now() - lastBalance < 15_000) return
  lastBalance = Date.now()
  try {
    const sol = getSolPrice()
    if (!(sol > 0)) return
    await syncWallet(sol)
  } catch (err) {
    log(`saldo: ${err.message}`)
  }
}

let lastHoldings = 0
const holdingNames = new Map()

async function tokenName(mint) {
  if (holdingNames.has(mint)) return holdingNames.get(mint)
  let symbol = ""
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`)
    if (res.ok) {
      const json = await res.json()
      const pair = (json.pairs || []).find((p) => p.baseToken?.address === mint)
      symbol = pair?.baseToken?.symbol || ""
    }
  } catch {}
  if (!symbol) {
    try {
      const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`)
      if (res.ok) {
        const rows = await res.json()
        symbol = rows.find((row) => row.id === mint)?.symbol || ""
      }
    } catch {}
  }
  holdingNames.set(mint, symbol)
  return symbol
}

async function syncWallet(sol) {
  const solUsd = (await solBalance(wallet.pubkey)) * sol
  state.solUsd = solUsd
  state.walletUsd = solUsd
  if (Date.now() - lastHoldings > 20_000) {
    lastHoldings = Date.now()
    const rows = await listHoldings(wallet.pubkey)
    const byMint = new Map(listTracked().map((c) => [c.mint, c]))
    state.holdings = []
    for (const row of rows) {
      const coin = byMint.get(row.mint)
      const known = state.positions.find((p) => p.mint === row.mint) || state.trades.find((t) => t.mint === row.mint)
      const market = Boolean(coin && coin.priceUsd > 0 && coin.reserveUsd > 50)
      const symbol = coin?.symbol || coin?.name || known?.symbol || (await tokenName(row.mint)) || `${row.mint.slice(0, 4)}…`
      state.holdings.push({ mint: row.mint, symbol, ui: row.ui, usd: market ? row.ui * coin.priceUsd : 0, market })
    }
    state.holdings.sort((a, b) => (b.market - a.market) || b.ui - a.ui)
    state.holdings = state.holdings.slice(0, 8)
  }
  const bags = (state.holdings || []).reduce((sum, row) => sum + (row.usd || 0), 0)
  state.totalUsd = solUsd + bags
}

async function step() {
  const now = Date.now()
  const sol = getSolPrice()
  const coins = listTracked()
  observeCoins(coins, now)
  if (!wallet) return
  if (state.phase !== "operando" && state.phase !== "cerrando") {
    await refreshBalance()
    return
  }
  if (!(sol > 0)) return
  const byMint = new Map(coins.map((c) => [c.mint, c]))
  try {
    await syncWallet(sol)
    lastBalance = now
  } catch (err) {
    log(`saldo: ${err.message}`)
    return
  }
  applyHalt(now)

  for (const pos of [...state.positions]) {
    if (pos.stuck) {
      pos.lastPx = 0
      continue
    }
    const coin = byMint.get(pos.mint)
    if (coin && coin.dexAt && !(coin.reserveUsd > 0)) {
      pos.stuck = true
      pos.lastPx = 0
      state.closeBlock = `${pos.symbol} no se puede vender: el pool quedó sin liquidez`
      note({ kind: "fallo", symbol: pos.symbol, book: pos.book, detail: "el pool quedó sin liquidez, no se puede vender" })
      log(`SELL ${pos.symbol}: pool sin liquidez`)
      continue
    }
    const pool = pos.pool || coin?.pool
    if (pool && now - (pos.lastPoolAt || 0) > 8_000) {
      pos.lastPoolAt = now
      try {
        pos.poolSol = await poolSolUi(pool)
      } catch (err) {
        log(`pool ${pos.symbol}: ${err.message}`)
      }
    }
    if (pos.poolSol != null && pos.poolSol * sol < Math.max(1000, (pos.costUsd || 0) * 3)) {
      await sell(pos, "el pool se está vaciando")
      continue
    }
    const plan = positionExit(pos, coin, now)
    if (state.phase === "cerrando" || plan.reason) await sell(pos, plan.reason || state.reason)
  }
  applyHalt(now)
    if (state.phase === "cerrando") {
    if (state.positions.every((p) => p.stuck) && inflight.size === 0) {
      state.phase = "frenado"
      state.closeBlock = ""
      state.stoppedAt = Date.now()
      await save()
      log(`BOT frenado: ${state.reason}`)
    } else if (state.positions.some((p) => p.stuck)) {
      const stuck = state.positions.find((p) => p.stuck)
      state.closeBlock = `${stuck.symbol} sigue en la billetera y no se puede vender`
    }
    return
  }
  if (state.locking && state.positions.length === 0 && inflight.size === 0) {
    state.phase = "frenado"
    state.locking = false
    state.closeBlock = ""
    state.stoppedAt = Date.now()
    await save()
    log(`BOT frenado: ${state.reason}`)
    return
  }

  rememberPicks(coins, now, sol)
  if (state.locking || now - lastExitAt() < REENTRY_MS || state.positions.length >= 1) {
    await save()
    return
  }

  const flow = coins.filter((c) => safeFlow(c, now, sol).ok).sort((a, b) => b.score - a.score)
  for (const coin of flow) {
    if (state.phase !== "operando") break
    if (state.positions.length >= 1) break
    if (state.positions.some((p) => p.mint === coin.mint)) continue
    if (rejected(coin.mint, now)) continue
    if (now - (state.exits[coin.mint] || 0) < 15 * 60_000) continue
    const size = bookSize("flow")
    if (size < 2) break
    await buy(coin, "flow", { stop: -12, take: 25, timeStop: 8 * 60_000, timeMin: 8 }, size, sol)
  }
  await save()
}

export async function tickLive() {
  if (running) return
  running = true
  try {
    await step()
  } catch (err) {
    log(`bot: ${err.message}`)
  } finally {
    running = false
  }
}

export function publicStatus() {
  const now = Date.now()
  return {
    armed: Boolean(wallet),
    publicKey: wallet ? encodeBase58(wallet.pubkey) : "",
    phase: state.phase,
    reason: state.reason,
    startedAt: state.startedAt,
    endsAt: state.endsAt,
    stoppedAt: state.stoppedAt,
    leftSec: state.endsAt && state.phase === "operando" ? Math.max(0, Math.ceil((state.endsAt - now) / 1000)) : 0,
    minutes: state.minutes,
    budgetUsd: state.budgetUsd,
    maxLossUsd: state.maxLossUsd,
    targetUsd: state.targetUsd,
    cashUsd: state.cashUsd,
    walletUsd: state.walletUsd,
    solUsd: state.solUsd || state.walletUsd || 0,
    totalUsd: state.totalUsd || state.walletUsd || 0,
    holdings: state.holdings || [],
    closeBlock: state.phase === "cerrando" ? state.closeBlock : "",
    pnlUsd: state.pnlUsd,
    rules: "presupuesto $15. una moneda por vez, flujo hasta $5. pool en la cadena ≥ $8,000, m5 hasta 22%, hora hasta 160%. no compra si la venta no devuelve al menos el 75%. espera 3 min después de cerrar. la venta tolera 12%. deja $1 para fees.",
    picks: state.picks,
    blocked: blockedRows(now, getSolPrice() || 0),
    feed: state.feed.slice(-24).reverse(),
    positions: state.positions.map((p) => ({
      mint: p.mint,
      symbol: p.symbol,
      book: p.book,
      score: p.score,
      sizeUsd: p.sizeUsd || 0,
      pnlPct: p.stuck || (p.tokens > 0 && !(p.lastPx > 0)) ? -100 : p.entryPx > 0 ? (p.lastPx / p.entryPx - 1) * 100 : 0,
      pnlUsd: p.stuck || (p.tokens > 0 && !(p.lastPx > 0)) ? -(p.costUsd || p.sizeUsd || 0) : p.tokens > 0 && p.lastPx > 0 ? p.tokens * p.lastPx - (p.costUsd || p.sizeUsd || 0) : 0,
      ageSec: Math.round((now - p.openedAt) / 1000),
    })),
    trades: state.trades.slice(-24).reverse(),
  }
}

function note(entry) {
  const last = state.feed[state.feed.length - 1]
  if (last && last.kind === entry.kind && last.symbol === entry.symbol && last.detail === entry.detail && Date.now() - last.t < 30_000) return
  state.feed.push({ t: Date.now(), ...entry })
  if (state.feed.length > 40) state.feed.splice(0, state.feed.length - 40)
}

function rejected(mint, now) {
  return (state.rejects[mint] || 0) > now
}

export function explainCoin(coin, now, sol) {
  if (rejected(coin.mint, now)) {
    return { ok: false, why: state.rejectWhy[coin.mint] || "en espera después de un fallo" }
  }
  return safeFlow(coin, now, sol)
}

function blockedRows(now, sol) {
  return listTracked()
    .map((coin) => ({ coin, gate: explainCoin(coin, now, sol) }))
    .filter((row) => !row.gate.ok && (row.coin.score || 0) >= 45)
    .sort((a, b) => (b.coin.score || 0) - (a.coin.score || 0))
    .slice(0, 6)
    .map((row) => ({
      mint: row.coin.mint,
      symbol: row.coin.symbol || row.coin.name || "?",
      score: Math.round(row.coin.score || 0),
      why: row.gate.why,
      m5: row.coin.change?.m5 || 0,
      h1: row.coin.change?.h1 || 0,
    }))
}

function lastExitAt() {
  let t = 0
  for (const v of Object.values(state.exits)) if (v > t) t = v
  return t
}

function rememberPicks(coins, now, sol) {
  const flow = coins.filter((c) => safeFlow(c, now, sol).ok).sort((a, b) => b.score - a.score).slice(0, 4)
  const next = flow.map((c) => pickRow(c, "flow", now))
  const prev = new Set(state.picks.map((p) => p.book + p.mint))
  for (const pick of next) {
    if (prev.has(pick.book + pick.mint) || pick.status !== "elegida") continue
    note({ kind: "elige", symbol: pick.symbol, book: pick.book, detail: `score ${Math.round(pick.score)}` })
  }
  state.picks = next
}

function pickRow(coin, book, now) {
  let status = "elegida"
  if (inflight.has(coin.mint)) status = "comprando"
  else if (state.positions.some((p) => p.mint === coin.mint)) status = "adentro"
  else if (rejected(coin.mint, now)) status = "no se puede comprar"
  else if (state.locking) status = "en espera"
  else if (now - lastExitAt() < REENTRY_MS) status = "en espera"
  else if (book === "flow" && state.positions.length >= 1) status = "sin lugar"
  else if (book === "snipe" && state.positions.some((p) => p.book === "snipe")) status = "sin lugar"
  else if (book === "flow" && now - (state.exits[coin.mint] || 0) < 15 * 60_000) status = "en espera"
  else if (book === "snipe" && state.exits[coin.mint]) status = "en espera"
  else if (bookSize(book) < 2) status = "sin dólares"
  return {
    mint: coin.mint,
    symbol: coin.symbol || coin.name || "?",
    book,
    score: Math.round(coin.score || 0),
    m5: coin.change?.m5 || 0,
    liq: coin.reserveUsd || 0,
    vol: coin.volume?.m5 || 0,
    status,
  }
}
