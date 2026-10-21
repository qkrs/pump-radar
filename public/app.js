const BOARDS = [
  { id: "score", label: "Score", desc: "Las que ahora mismo muestran más presión de compra, momentum y espacio en la curva. Es una lectura del flujo, no una promesa de profit." },
  { id: "trending", label: "Trending", desc: "Lo que GeckoTerminal marca caliente en pump.fun y PumpSwap, refresco continuo." },
  { id: "movers", label: "Movers", desc: "Mayor movimiento de precio con volumen detrás. Cambiá la ventana arriba a la derecha." },
  { id: "new", label: "Nuevas", desc: "Lanzamientos que entran por el websocket. El papel no compra el create quieto: solo si el precio ya subió y aguantó unos segundos." },
  { id: "graduating", label: "Graduando", desc: "Siguen en la bonding curve y van más cerca de migrar. La meta se ve en dólares en la ficha." },
  { id: "graduated", label: "Graduadas", desc: "Ya migraron a PumpSwap." },
  { id: "mayhem", label: "Mayhem", desc: "Lanzadas con mayhem mode." },
  { id: "boosted", label: "Boosted", desc: "Con impulso activo en Dexscreener." },
]

const state = { coins: [], solPrice: 0, targetUsd: 0, serverTime: 0, status: {}, paper: null, bot: null, at: 0 }
const ui = { board: "score", q: "", window: "m5", sort: null, mint: null, tf: "1" }
let detail = null
let hover = null
let armedMint = null
const prevPx = new Map()

const $ = (id) => document.getElementById(id)

const nav = $("nav")
const rowsEl = $("rows")
const windows = $("windows")

nav.innerHTML = BOARDS.map((b) => `<button data-board="${b.id}"><strong>${b.label}</strong><em data-count="${b.id}">0</em></button>`).join("")
nav.addEventListener("click", (e) => {
  const btn = e.target.closest("button")
  if (!btn) return
  ui.board = btn.dataset.board
  ui.sort = null
  render()
})
windows.addEventListener("click", (e) => {
  const btn = e.target.closest("button")
  if (!btn) return
  ui.window = btn.dataset.w
  render()
})
document.querySelector(".thead").addEventListener("click", (e) => {
  const btn = e.target.closest("button")
  if (!btn) return
  const key = btn.dataset.sort
  if (ui.sort?.key === key) ui.sort.dir *= -1
  else ui.sort = { key, dir: key === "name" || key === "age" ? 1 : -1 }
  render()
})
$("q").addEventListener("input", (e) => {
  ui.q = e.target.value
  render()
})
function rejectAddress(secret) {
  const compact = String(secret || "").replace(/\s+/g, "")
  if (compact.startsWith("[")) return ""
  if (compact.length >= 80) return ""
  return "Eso es la dirección, no la clave. En pump apretá el botón verde Copy key, no el Copy chico que está al lado de Gq4."
}

$("bot-key").addEventListener("submit", async (e) => {
  e.preventDefault()
  const input = $("bot-secret")
  const secret = input.value
  const host = $("bot-state")
  const refused = rejectAddress(secret)
  if (refused) {
    botNote = refused
    paintBot()
    return
  }
  try {
    const data = await postBot("/api/bot/key", { secret })
    input.value = ""
    rememberKey(data.publicKey)
    paintBot()
  } catch (err) {
    botNote = err.message
    paintBot()
  }
})
$("bot-run").addEventListener("submit", async (e) => {
  e.preventDefault()
  const host = $("bot-state")
  try {
    const pending = $("bot-secret").value.trim()
    const refused = rejectAddress(pending)
    if (pending && refused) {
      botNote = refused
      paintBot()
      return
    }
    if (pending) {
      const saved = await postBot("/api/bot/key", { secret: pending })
      $("bot-secret").value = ""
      rememberKey(saved.publicKey)
    }
    const data = await postBot("/api/bot/start", {
      minutes: Number($("bot-minutes").value),
      budgetUsd: Number($("bot-budget").value),
      maxLossUsd: Number($("bot-loss").value),
      targetUsd: Number($("bot-target").value),
    })
    state.bot = { ...(state.bot || {}), ...data }
    botNote = ""
    monitorDismissed = 0
    openMonitor()
  } catch (err) {
    const saved = botNote.startsWith("Clave guardada") ? `${botNote} ` : ""
    botNote = saved + err.message
    paintBot()
  }
})
$("bot-monitor").addEventListener("click", () => {
  monitorDismissed = 0
  openMonitor()
})
$("monitor-close").addEventListener("click", closeMonitor)
$("monitor").addEventListener("click", (e) => {
  if (e.target === $("monitor")) closeMonitor()
})
$("bot-stop").addEventListener("click", async () => {
  try {
    await postBot("/api/bot/stop", {})
    botNote = ""
  } catch (err) {
    botNote = err.message
    paintBot()
  }
})
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== $("q")) {
    e.preventDefault()
    $("q").focus()
  }
})

const stream = new EventSource("/api/stream")
stream.onmessage = (ev) => {
  const data = JSON.parse(ev.data)
  state.coins = data.coins || []
  state.solPrice = data.solPrice || 0
  state.targetUsd = data.targetUsd || 0
  state.serverTime = data.serverTime || Date.now()
  state.status = data.status || {}
  state.paper = data.paper || null
  state.bot = data.bot || null
  state.at = Date.now()
  if (!ui.mint && state.coins.length) ui.mint = pick(listFor("score"))?.mint || state.coins[0].mint
  render()
  tickLiveCandle()
}
stream.onerror = () => setLive(false)
stream.onopen = () => setLive(true)

setInterval(() => {
  if (!state.at) return
  $("ago").textContent = age(state.at)
  if (!$("monitor").hidden) paintMonitor()
}, 1000)
setInterval(() => { if (ui.mint) void loadDetail(false) }, 12000)

function setLive(on) {
  $("live").classList.toggle("on", on)
  $("live-label").textContent = on ? "en vivo" : "reconectando"
}

function render() {
  const board = BOARDS.find((b) => b.id === ui.board)
  $("board-title").textContent = board.label
  $("board-desc").textContent = board.desc
  $("sol").textContent = state.solPrice ? usd(state.solPrice) : "—"
  windows.hidden = ui.board !== "movers"
  for (const btn of windows.querySelectorAll("button")) btn.classList.toggle("on", btn.dataset.w === ui.window)
  for (const btn of nav.querySelectorAll("button")) btn.classList.toggle("on", btn.dataset.board === ui.board)
  for (const b of BOARDS) {
    const el = nav.querySelector(`[data-count="${b.id}"]`)
    el.textContent = String(listFor(b.id).length)
  }
  for (const btn of document.querySelectorAll(".thead button")) {
    btn.classList.toggle("on", ui.sort?.key === btn.dataset.sort)
  }
  const list = view()
  if (!list.some((c) => c.mint === ui.mint) && list[0] && !ui.q) {
    /* keep the open coin even if it falls off the board */
  }
  const scroll = rowsEl.scrollTop
  rowsEl.innerHTML = list.length ? list.map(rowHtml).join("") : `<div class="empty">Nada en esta categoría todavía. El radar sigue escuchando.</div>`
  rowsEl.scrollTop = scroll
  rowsEl.querySelectorAll(".row").forEach((el) => {
    el.addEventListener("click", () => {
      if (ui.mint === el.dataset.mint) return
      ui.mint = el.dataset.mint
      detail = null
      render()
    })
  })
  if (ui.mint && ui.mint !== armedMint) {
    armedMint = ui.mint
    void loadDetail(true)
  }
  const st = state.status
  $("status-line").textContent = `${st.tracked || 0} en memoria · portal ${st.portal || "…"} · ${st.gecko ? "tableros ok" : "tableros arrancando"}${st.lastError ? " · " + st.lastError : ""}`
  paintHealth()
  paintBalance()
  paintDetail()
  paintPaper()
  paintBot()
}

function paintPaper() {
  const p = state.paper
  const host = $("paper")
  if (!host) return
  if (!p) {
    host.innerHTML = `<div class="muted">Cuenta de papel esperando el primer precio real.</div>`
    return
  }
  const left = Math.max(0, p.endsAt - Date.now())
  const px = state.solPrice || 0
  const money = (sol) => (!px ? "—" : sol ? usd(sol * px) : "$0.00")
  const pnl = p.equitySol - p.startSol
  host.innerHTML = `
    <div>
      <h2>Cuenta de papel</h2>
      <div class="paper-kpis">
        <span>efectivo <b>${money(p.cashSol)}</b></span>
        <span>equity <b class="${pnl >= 0 ? "up" : "down"}">${money(p.equitySol)}</b></span>
        <span>PnL <b class="${pnl >= 0 ? "up" : "down"}">${pnl >= 0 ? "+" : ""}${money(pnl)}</b></span>
        <span>fees <b>${money(p.feesSol)}</b></span>
      </div>
      <small>${p.phase === "cerrada" ? "sesión cerrada" : "quedan " + fmtLeft(left)} · arranque ${money(p.startSol)} · fee 1%</small>
    </div>
    <div class="paper-cols">
      <strong>Abiertas ${p.positions.length}</strong>
      ${p.positions.length ? p.positions.map((pos) => `<div class="paper-line"><span>${esc(pos.symbol)}</span><span class="${pos.pnlPct >= 0 ? "up" : "down"}">${pos.pnlPct >= 0 ? "+" : ""}${pos.pnlPct.toFixed(1)}%</span><span>${esc(pos.book || "")}</span><span>${pos.ageSec}s</span></div>`).join("") : `<small>sin posiciones</small>`}
    </div>
    <div class="paper-cols">
      <strong>Operaciones ${p.tradeCount}</strong>
      ${p.trades.slice(0, 4).map((t) => `<div class="paper-line"><span class="${t.side === "sell" ? "down" : "up"}">${t.side === "sell" ? "venta" : "compra"}</span><span>${esc(t.symbol)}</span><span>${esc(t.book || "")} ${esc(t.reason)}</span><span>${t.pnlSol != null ? (t.pnlSol >= 0 ? "+" : "") + money(t.pnlSol) : money(t.sizeSol)}</span></div>`).join("") || `<small>todavía no opera</small>`}
    </div>`
}

function lessonFor(coin) {
  const m5 = coin.change?.m5 || 0
  const vol = coin.volume?.m5 || 0
  const liq = coin.reserveUsd || 0
  const age = coin.createdAt ? Date.now() - coin.createdAt : 0
  if (m5 > 30) return "5m por encima de 30%. FORKIUS (+34%) y ASH (+40%) saltaron el stop de −12% en 16s y 9s."
  if (liq > 0 && liq < 8000) return "Liquidez bajo $8,000. FLOPPY ($3,627) salió a −47% y COLLECTIBLE ($4,436) a −26%. Gumshoos ($7,600) sí cerró en −12.5%."
  if (age > 0 && age < 90_000 && vol < 1000) return "Volumen 5m bajo $1,000. VET.O y ORVIX no pasaron de un print. MUK, con $887, estaba en −14% a los 13s."
  return ""
}

let botNote = ""

function rememberKey(publicKey) {
  const shown = `${publicKey.slice(0, 4)}…${publicKey.slice(-4)}`
  botNote = `Clave guardada. La billetera es ${shown}.`
  if (state.bot) {
    state.bot.publicKey = publicKey
    state.bot.armed = true
  }
}
let monitorDismissed = 0

function sessionOn(bot) {
  return bot && (bot.phase === "operando" || bot.phase === "cerrando" || bot.phase === "frenado")
}

function openMonitor() {
  $("monitor").hidden = false
  paintMonitor()
}

function closeMonitor() {
  $("monitor").hidden = true
  if (state.bot?.startedAt) monitorDismissed = state.bot.startedAt
}

function paintHealth() {
  const host = $("stale")
  if (!host) return
  const st = state.status || {}
  const quiet = state.at && Date.now() - state.at > 12_000
  const broken = st.lastError && !/gecko limitado/i.test(st.lastError)
  const dead = Boolean(broken) || quiet || (st.tracked > 30 && (st.fresh || 0) < 8)
  if (!dead) {
    host.hidden = true
    host.textContent = ""
    return
  }
  const why = st.lastError || (quiet ? "el escritorio perdió la conexión" : "casi ninguna moneda se actualizó en el último minuto")
  host.hidden = false
  host.textContent = `Los precios están congelados. ${why}. Lo que ves puede ser de hace rato.`
}

function paintBalance() {
  const bot = state.bot
  const total = $("balance-total")
  const split = $("balance-split")
  if (!total || !split) return
  if (!bot?.armed) {
    total.textContent = "—"
    split.textContent = "sin clave"
    return
  }
  const solUsd = bot.solUsd || bot.walletUsd || 0
  const bags = bot.holdings || []
  const sum = bot.totalUsd || solUsd
  const money = (n) => (n ? usd(n) : "$0.00")
  total.textContent = money(sum)
  const parts = [`SOL ${money(solUsd)}`]
  for (const bag of bags.slice(0, 3)) {
    parts.push(bag.market ? `${bag.symbol} ${usd(bag.usd)}` : `${bag.symbol} sin mercado`)
  }
  if (bags.length > 3) parts.push(`+${bags.length - 3}`)
  split.textContent = parts.join(" · ")
}

function paintBot() {
  const host = $("bot-state")
  const bot = state.bot
  if (!host || !bot) return
  const pnl = bot.pnlUsd || 0
  const left = bot.phase === "operando" ? botLeft(bot) : ""
  const open = (bot.positions || []).map((p) => `${p.symbol} ${p.book} ${p.pnlPct >= 0 ? "+" : ""}${p.pnlPct.toFixed(1)}%`).join(" · ")
  const wallet = bot.walletUsd > 0 ? ` · billetera ${usd(bot.walletUsd)}` : ""
  host.innerHTML = `
    ${botNote ? `<span class="bot-note">${esc(botNote)}</span>` : ""}
    <b>${esc(bot.phase)}</b>
    ${bot.publicKey ? `<span>billetera ${esc(bot.publicKey.slice(0, 4))}…${esc(bot.publicKey.slice(-4))}${wallet}</span>` : "<span>sin clave</span>"}
    <span>presupuesto ${usd(bot.budgetUsd || 15)}</span>
    ${sessionOn(bot) ? `<span class="${pnl >= 0 ? "up" : "down"}">PnL ${pnl > 0 ? "+" : ""}${pnl ? usd(pnl) : "$0.00"}</span>` : ""}
    ${left ? `<span>quedan ${left}</span>` : ""}
    ${bot.phase === "cerrando" ? `<span class="bot-note">${esc(bot.closeBlock ? `Parar no puede terminar: ${bot.closeBlock}` : "Parar está cerrando lo que queda abierto.")}</span>` : ""}
    ${bot.reason ? `<span>${esc(bot.reason)}</span>` : ""}
    <span>${esc(bot.rules || "")}</span>
    ${open ? `<span>abiertas: ${esc(open)}</span>` : ""}`
  if ((bot.phase === "operando" || bot.phase === "cerrando") && bot.startedAt && monitorDismissed !== bot.startedAt) openMonitor()
  else if (!$("monitor").hidden) paintMonitor()
}

function paintMonitor() {
  const body = $("monitor-body")
  const phase = $("monitor-phase")
  const bot = state.bot
  if (!body || !phase) return
  if (!bot) {
    phase.textContent = ""
    body.innerHTML = `<small>El monitoreo se abre cuando el bot empieza.</small>`
    return
  }
  const left = bot.phase === "operando" ? botLeft(bot) : ""
  phase.textContent = [bot.phase, left ? `quedan ${left}` : "", bot.phase === "cerrando" && bot.closeBlock ? `Parar no puede terminar: ${bot.closeBlock}` : "", bot.reason || ""].filter(Boolean).join(" · ")
  const pnl = bot.pnlUsd || 0
  const picks = bot.picks || []
  const positions = bot.positions || []
  const closed = (bot.trades || []).filter((t) => t.side === "sell")
  const feed = bot.feed || []
  body.innerHTML = `
    <div class="monitor-kpis">
      <span>PnL <b class="${pnl >= 0 ? "up" : "down"}">${pnl > 0 ? "+" : ""}${pnl ? usd(pnl) : "$0.00"}</b></span>
      <span>efectivo <b>${bot.cashUsd ? usd(bot.cashUsd) : "$0.00"}</b></span>
      <span>presupuesto <b>${usd(bot.budgetUsd || 15)}</b></span>
      <span>frena <b>−${usd(bot.maxLossUsd || 5).replace("-", "")} / +${usd(bot.targetUsd || 3)}</b></span>
    </div>
    <div class="monitor-cols">
      <section>
        <h3>Eligiendo ${picks.length}</h3>
        ${picks.map((p) => `<div class="monitor-line"><span><b>${esc(p.symbol)}</b> <small>${esc(p.book)} · score ${p.score}</small></span><span>${esc(p.status)}</span><small>5m ${(p.m5 || 0) >= 0 ? "+" : ""}${Number(p.m5 || 0).toFixed(1)}% · pool ${usd(p.liq)}</small></div>`).join("")}
        ${(bot.blocked || []).map((p) => `<div class="monitor-line"><span><b>${esc(p.symbol)}</b> <small>score ${p.score}</small></span><span>${esc(p.why)}</span><small>5m ${(p.m5 || 0) >= 0 ? "+" : ""}${Number(p.m5 || 0).toFixed(1)}% · 1h ${(p.h1 || 0) >= 0 ? "+" : ""}${Number(p.h1 || 0).toFixed(0)}%</small></div>`).join("")}
        ${picks.length || (bot.blocked || []).length ? "" : `<small>Ninguna pasa el filtro ahora.</small>`}
      </section>
      <section>
        <h3>Abiertas ${positions.length}</h3>
        ${positions.map((p) => `<div class="monitor-line"><span><b>${esc(p.symbol)}</b> <small>${esc(p.book)} · score ${Math.round(p.score || 0)} · ${usd(p.sizeUsd)}</small></span><span class="${p.pnlUsd >= 0 ? "up" : "down"}">${p.pnlUsd > 0 ? "+" : ""}${p.pnlUsd ? usd(p.pnlUsd) : "$0.00"}</span><small>${p.pnlPct >= 0 ? "+" : ""}${Number(p.pnlPct).toFixed(1)}% · ${p.ageSec}s</small></div>`).join("") || `<small>Todavía no compró.</small>`}
      </section>
      <section>
        <h3>Cerradas ${closed.length}</h3>
        ${closed.map((t) => `<div class="monitor-line"><span><b>${esc(t.symbol)}</b> <small>${esc(t.book || "")} · ${esc(t.reason || "")}</small></span><span class="${(t.pnlUsd || 0) >= 0 ? "up" : "down"}">${(t.pnlUsd || 0) > 0 ? "+" : ""}${t.pnlUsd ? usd(t.pnlUsd) : "$0.00"}</span></div>`).join("") || `<small>Todavía no cerró ninguna.</small>`}
      </section>
    </div>
    <section class="monitor-feed">
      <h3>Qué está haciendo</h3>
      ${feed.map((f) => `<div class="monitor-line"><span>${esc(kindLabel(f.kind))}</span><span>${esc([f.symbol, f.book, f.detail].filter(Boolean).join(" · "))}</span><span class="${(f.pnlUsd || 0) > 0 ? "up" : (f.pnlUsd || 0) < 0 ? "down" : ""}">${f.pnlUsd ? ((f.pnlUsd > 0 ? "+" : "") + usd(f.pnlUsd)) : ""}</span></div>`).join("") || `<small>Todavía no eligió ninguna.</small>`}
    </section>`
}

function kindLabel(kind) {
  if (kind === "elige") return "elige"
  if (kind === "compra") return "compra"
  if (kind === "venta") return "venta"
  if (kind === "fallo") return "falló"
  if (kind === "freno") return "frena"
  if (kind === "arranque") return "arranque"
  return kind || ""
}

function botLeft(bot) {
  const ms = bot.endsAt ? bot.endsAt - Date.now() : (bot.leftSec || 0) * 1000
  return fmtLeft(Math.max(0, ms))
}

async function postBot(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || "no se pudo")
  return data
}

function fmtLeft(ms) {
  const s = Math.ceil(ms / 1000)
  const m = Math.floor(s / 60)
  return `${m}m ${String(s % 60).padStart(2, "0")}s`
}

function view() {
  const q = ui.q.trim().toLowerCase()
  let list = q
    ? state.coins.filter((c) =>
        c.name?.toLowerCase().includes(q) ||
        c.symbol?.toLowerCase().includes(q) ||
        c.mint?.toLowerCase().includes(q))
    : listFor(ui.board)
  const { key, dir } = ui.sort || defaultSort()
  list = [...list].sort((a, b) => cmp(a, b, key) * dir)
  return list.slice(0, 80)
}

function listFor(board) {
  const now = Date.now()
  if (board === "score") {
    return state.coins.filter((c) => txCount(c, ["m5", "m15", "h1"]) >= 4)
  }
  if (board === "trending") {
    return state.coins.filter((c) => c.trendingRank != null || (c.volume?.m5 || 0) >= 150 || (c.volume?.h1 || 0) >= 2500)
  }
  if (board === "movers") {
    const w = ui.window
    return state.coins.filter((c) => (c.volume?.[w] || 0) > (w === "m5" ? 40 : 150) && (c.change?.[w] || 0) !== 0)
  }
  if (board === "new") return state.coins.filter((c) => now - c.createdAt < 6 * 3600 * 1000)
  if (board === "graduating") {
    const near = state.coins.filter((c) => !c.graduated && c.progress >= 0.15)
    if (near.length >= 6) return near
    return state.coins.filter((c) => !c.graduated && c.progress > 0.04)
  }
  if (board === "graduated") return state.coins.filter((c) => c.graduated || c.dex === "pumpswap")
  if (board === "mayhem") return state.coins.filter((c) => c.mayhem)
  if (board === "boosted") return state.coins.filter((c) => c.boosted)
  return state.coins
}

function defaultSort() {
  if (ui.board === "trending") return { key: "trend", dir: -1 }
  if (ui.board === "movers") return { key: "change", dir: -1 }
  if (ui.board === "new" || ui.board === "mayhem") return { key: "age", dir: 1 }
  if (ui.board === "graduating") return { key: "progress", dir: -1 }
  if (ui.board === "graduated") return { key: "vol", dir: -1 }
  return { key: "score", dir: -1 }
}

function cmp(a, b, key) {
  const w = ui.board === "movers" ? ui.window : "m5"
  if (key === "name") return (a.symbol || a.name || "").localeCompare(b.symbol || b.name || "")
  if (key === "mcap") return (a.mcapUsd || a.fdvUsd || 0) - (b.mcapUsd || b.fdvUsd || 0)
  if (key === "change") return (a.change?.[w] || 0) - (b.change?.[w] || 0)
  if (key === "vol") return (a.volume?.[w] || a.volume?.h1 || 0) - (b.volume?.[w] || b.volume?.h1 || 0)
  if (key === "buy") return buyRatio(a) - buyRatio(b)
  if (key === "progress") return (a.progress || 0) - (b.progress || 0)
  if (key === "age") return (b.createdAt || 0) - (a.createdAt || 0)
  if (key === "trend") {
    const heat = (c) => (c.trendingRank == null ? 0 : (80 - c.trendingRank) * 1e7) + (c.volume?.m5 || 0)
    return heat(a) - heat(b)
  }
  if (key === "rank") return (a.trendingRank ?? 999) - (b.trendingRank ?? 999)
  return (a.score || 0) - (b.score || 0)
}

function rowHtml(c) {
  const px = c.fdvUsd || c.mcapUsd || 0
  const prev = prevPx.get(c.mint)
  prevPx.set(c.mint, px)
  const flash = prev == null || prev === px ? "" : px > prev ? "flash-up" : "flash-down"
  const w = ui.board === "movers" ? ui.window : "m5"
  const ch = c.change?.[w] || 0
  const ratio = buyRatio(c)
  const tags = [
    c.graduated ? `<span class="tag done">grad</span>` : `<span class="tag">${Math.round((c.progress || 0) * 100)}%</span>`,
    c.mayhem ? `<span class="tag hot">mayhem</span>` : "",
    c.boosted ? `<span class="tag hot">boost</span>` : "",
    c.gate?.flow?.ok ? `<span class="tag done">flujo</span>` : "",
    c.gate?.snipe?.ok ? `<span class="tag hot">snipe</span>` : "",
  ].join("")
  return `<button class="row ${c.mint === ui.mint ? "sel" : ""} ${flash}" data-mint="${esc(c.mint)}">
    <span class="score ${scoreClass(c.score)}">${c.score}</span>
    <span class="coin">
      ${avatar(c)}
      <span class="id">
        <b>${esc(c.symbol || c.name || "—")}</b>
        <small>${esc(c.name && c.name !== c.symbol ? c.name : c.symbol || "")} · ${age(c.createdAt)}</small>
        <span class="tags">${tags}</span>
        ${c.live && !c.live.ok && c.live.why ? `<small class="why">${esc(c.live.why)}</small>` : ""}
      </span>
    </span>
    <span class="mcap">
      <span class="mono">${usd(c.mcapUsd || c.fdvUsd)}</span>
      ${spark(c.spark)}
    </span>
    <span class="right mono ${ch > 0 ? "up" : ch < 0 ? "down" : ""}">${pct(ch)}</span>
    <span class="right mono hide-sm">${usd(c.volume?.[w] || 0)}</span>
    <span class="right hide-sm">
      <span class="mono">${totalTx(c) ? Math.round(ratio * 100) + "%" : "—"}</span>
      <span class="buybar"><span style="width:${Math.round(ratio * 100)}%"></span></span>
    </span>
  </button>`
}

function paintDetail() {
  const coin = state.coins.find((c) => c.mint === ui.mint)
  const host = $("detail")
  if (!coin) {
    if (!host.querySelector(".empty-detail")) host.innerHTML = `<div class="empty-detail">Elegí una moneda para ver el score, el gráfico y la cinta.</div>`
    return
  }
  if (host.dataset.mint !== coin.mint) {
    host.dataset.mint = coin.mint
    host.innerHTML = detailShell(coin)
    host.querySelectorAll(".tfs button").forEach((btn) => {
      btn.addEventListener("click", () => {
        ui.tf = btn.dataset.tf
        void loadDetail(true)
      })
    })
    const copy = host.querySelector("[data-copy]")
    copy?.addEventListener("click", async () => {
      await navigator.clipboard.writeText(coin.mint)
      copy.textContent = "copiado"
      setTimeout(() => { copy.textContent = "copiar" }, 900)
    })
    const canvas = host.querySelector("canvas")
    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect()
      hover = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      drawChart()
    })
    canvas.addEventListener("mouseleave", () => { hover = null; drawChart() })
  }
  patchDetail(coin)
  drawChart()
}

function detailShell(coin) {
  return `
    <div class="d-top">
      ${avatar(coin, true)}
      <div>
        <h2 id="d-title"></h2>
        <p id="d-sub"></p>
      </div>
    </div>
    <div class="mint"><span id="d-mint"></span><button data-copy type="button">copiar</button></div>
    <div class="links">
      <a class="primary" id="d-pump" target="_blank" rel="noreferrer">Operar en pump.fun</a>
      <a id="d-dex" target="_blank" rel="noreferrer">Dexscreener</a>
    </div>
    <div class="score-row">
      <div class="ring" id="d-ring"><span id="d-score">0</span></div>
      <div class="meters" id="d-meters"></div>
    </div>
    <div class="flags" id="d-flags"></div>
    <div class="gates" id="d-gates"></div>
    <p class="lesson" id="d-lesson" hidden></p>
    <div class="stats" id="d-stats"></div>
    <div class="chart-wrap">
      <div class="tfs">
        ${["1", "5", "15", "60"].map((tf) => `<button data-tf="${tf}" class="${tf === ui.tf ? "on" : ""}">${tf === "60" ? "1h" : tf + "m"}</button>`).join("")}
      </div>
      <canvas id="chart" width="760" height="460"></canvas>
      <div class="legend"><span id="d-ohlc">cargando velas…</span><span id="d-basis"></span></div>
    </div>
    <div class="tape">
      <h3>Cinta</h3>
      <div id="d-tape" class="note">esperando trades…</div>
    </div>
    <p class="note" id="d-note"></p>`
}

function patchDetail(coin) {
  $("d-title").textContent = coin.symbol || coin.name
  $("d-sub").textContent = coin.name && coin.name !== coin.symbol ? coin.name : (coin.dex === "pumpswap" ? "PumpSwap" : "bonding curve")
  $("d-mint").textContent = coin.mint
  $("d-pump").href = `https://pump.fun/coin/${coin.mint}`
  $("d-dex").href = `https://dexscreener.com/solana/${coin.mint}`
  $("d-score").textContent = String(coin.score)
  const ring = $("d-ring")
  ring.style.setProperty("--p", String(coin.score))
  ring.style.background = `conic-gradient(${coin.score >= 75 ? "#3ee08f" : coin.score >= 55 ? "#f0b429" : "#8b9690"} calc(var(--p) * 1%), #222 0)`
  const parts = [
    ["Presión", coin.parts?.pressure || 0, 25],
    ["Momentum", coin.parts?.momentum || 0, 25],
    ["Actividad", coin.parts?.activity || 0, 20],
    ["Curva", coin.parts?.curve || 0, 15],
    ["Frescura", coin.parts?.fresh || 0, 10],
  ]
  $("d-meters").innerHTML = parts.map(([name, value, max]) =>
    `<div class="meter"><span>${name}</span><i><span style="width:${Math.round(value / max * 100)}%"></span></i><b>${value}</b></div>`).join("")
  $("d-flags").innerHTML = (coin.flags || []).map((f) => `<span class="flag">${esc(f)}</span>`).join("")
  const gate = coin.gate
  $("d-gates").innerHTML = gate
    ? `<div><b class="${gate.flow.ok ? "up" : ""}">Flujo</b> ${esc(gate.flow.why)}</div><div><b class="${gate.snipe.ok ? "up" : ""}">Snipe</b> ${esc(gate.snipe.why)}</div>`
    : ""
  const lesson = lessonFor(coin)
  const lessonEl = $("d-lesson")
  lessonEl.hidden = !lesson
  lessonEl.textContent = lesson || ""
  const ch = coin.change?.m5 || 0
  const target = state.targetUsd ? usd(state.targetUsd) : "—"
  $("d-stats").innerHTML = [
    ["Market cap", usd(coin.mcapUsd || coin.fdvUsd)],
    ["Liquidez", usd(coin.reserveUsd)],
    ["5m", pct(ch)],
    ["Vol 5m", usd(coin.volume?.m5 || 0)],
    ["Curva", `${Math.round((coin.progress || 0) * 100)}% · meta ${target}`],
    ["Edad", age(coin.createdAt)],
  ].map(([k, v]) => `<div class="stat"><span>${k}</span><b class="${k === "5m" ? (ch > 0 ? "up" : ch < 0 ? "down" : "") : ""}">${esc(v)}</b></div>`).join("")
  $("d-note").textContent = coin.creator
    ? `Creador ${shortAddr(coin.creator)}. Penalización del score: ${coin.parts?.penalty || 0}.`
    : `Penalización del score: ${coin.parts?.penalty || 0}.`
  for (const btn of document.querySelectorAll(".tfs button")) btn.classList.toggle("on", btn.dataset.tf === ui.tf)
  if (detail?.trades) renderTape(detail.trades)
}

async function loadDetail(force) {
  if (!ui.mint) return
  const mint = ui.mint
  const res = await fetch(`/api/coin?mint=${encodeURIComponent(mint)}&tf=${ui.tf}`)
  if (!res.ok || mint !== ui.mint) return
  detail = await res.json()
  if ($("detail").dataset.mint !== mint) paintDetail()
  renderTape(detail.trades || [])
  const label = $("d-basis")
  if (label) label.textContent = detail.basis === "fdv" ? "eje: market cap" : "eje: precio"
  drawChart()
  if (force) { /* shell already patched */ }
}

function renderTape(trades) {
  const el = $("d-tape")
  if (!el) return
  if (!trades?.length) {
    el.className = "note"
    el.textContent = "Sin trades en la fuente todavía. La cinta aparece cuando el pool ya está indexado."
    return
  }
  el.className = ""
  el.innerHTML = trades.slice(0, 18).map((t) =>
    `<div class="trade"><span>${clock(t.ts)}</span><span class="${t.side === "sell" ? "down" : "up"}">${t.side === "sell" ? "venta" : "compra"}</span><span>${usd(t.usd)}</span><span>${shortAddr(t.wallet)}</span></div>`).join("")
}

function tickLiveCandle() {
  if (!detail?.candles?.length || detail.coin?.mint !== ui.mint) return
  const coin = state.coins.find((c) => c.mint === ui.mint)
  if (!coin) return
  const px = detail.basis === "fdv" ? (coin.fdvUsd || coin.mcapUsd) : coin.priceUsd
  if (!px) return
  const ms = { 1: 60000, 5: 300000, 15: 900000, 60: 3600000 }[ui.tf] || 60000
  const t = Math.floor(Date.now() / ms) * ms
  const last = detail.candles[detail.candles.length - 1]
  if (Math.abs(last.c - px) / px < 0.0000001 && last.t === t) return
  if (last.t === t) {
    last.h = Math.max(last.h, px)
    last.l = Math.min(last.l, px)
    last.c = px
  } else if (t > last.t) {
    detail.candles.push({ t, o: last.c, h: Math.max(last.c, px), l: Math.min(last.c, px), c: px, v: 0 })
    if (detail.candles.length > 180) detail.candles.shift()
  }
  drawChart()
}

function drawChart() {
  const canvas = $("chart")
  if (!canvas) return
  const series = detail?.candles || []
  const spark = sparkCandles()
  const candles = series.length >= 2 ? series : spark.length > series.length ? spark : series
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth || 380
  const h = canvas.clientHeight || 230
  canvas.width = Math.floor(w * dpr)
  canvas.height = Math.floor(h * dpr)
  const ctx = canvas.getContext("2d")
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = "#080a0c"
  ctx.fillRect(0, 0, w, h)
  if (!candles || candles.length < 1) {
    ctx.fillStyle = "#8b9690"
    ctx.font = "13px Outfit, sans-serif"
    ctx.fillText("Todavía no hay velas. Se arman con cada tick.", 16, 28)
    const ohlc = $("d-ohlc")
    if (ohlc) ohlc.textContent = "sin velas"
    return
  }
  const pad = { l: 8, r: 64, t: 12, b: 18 }
  const volH = 46
  const plotH = h - pad.t - pad.b - volH
  const highs = candles.map((c) => c.h)
  const lows = candles.map((c) => c.l)
  let max = Math.max(...highs)
  let min = Math.min(...lows)
  if (max === min) { max *= 1.01; min *= 0.99 }
  const span = max - min || 1
  const slot = (w - pad.l - pad.r) / candles.length
  const y = (v) => pad.t + (max - v) / span * plotH
  ctx.strokeStyle = "#1c242b"
  ctx.lineWidth = 1
  ctx.font = "11px 'IBM Plex Mono', monospace"
  for (let i = 0; i < 4; i++) {
    const gy = pad.t + (plotH / 3) * i
    ctx.beginPath()
    ctx.moveTo(pad.l, gy)
    ctx.lineTo(w - pad.r, gy)
    ctx.stroke()
    const val = max - (span / 3) * i
    ctx.fillStyle = "#8b9690"
    ctx.fillText(axis(val), w - pad.r + 6, gy + 4)
  }
  const maxVol = Math.max(...candles.map((c) => c.v || 0), 1)
  candles.forEach((c, i) => {
    const x = pad.l + i * slot + slot / 2
    const up = c.c >= c.o
    ctx.strokeStyle = up ? "#3ee08f" : "#ff5d73"
    ctx.fillStyle = up ? "#3ee08f" : "#ff5d73"
    ctx.beginPath()
    ctx.moveTo(x, y(c.h))
    ctx.lineTo(x, y(c.l))
    ctx.stroke()
    const top = y(Math.max(c.o, c.c))
    const bot = y(Math.min(c.o, c.c))
    const bw = Math.max(slot * 0.62, 1.5)
    ctx.globalAlpha = 0.9
    ctx.fillRect(x - bw / 2, top, bw, Math.max(bot - top, 1))
    ctx.globalAlpha = 0.35
    const vh = ((c.v || 0) / maxVol) * (volH - 8)
    ctx.fillRect(x - bw / 2, h - pad.b - vh, bw, vh)
    ctx.globalAlpha = 1
  })
  const last = candles.at(-1)
  ctx.strokeStyle = last.c >= last.o ? "#3ee08f" : "#ff5d73"
  ctx.setLineDash([3, 3])
  ctx.beginPath()
  ctx.moveTo(pad.l, y(last.c))
  ctx.lineTo(w - pad.r, y(last.c))
  ctx.stroke()
  ctx.setLineDash([])
  let shown = last
  if (hover) {
    const idx = Math.min(candles.length - 1, Math.max(0, Math.floor((hover.x - pad.l) / slot)))
    shown = candles[idx]
    const x = pad.l + idx * slot + slot / 2
    ctx.strokeStyle = "#445"
    ctx.beginPath()
    ctx.moveTo(x, pad.t)
    ctx.lineTo(x, h - pad.b)
    ctx.stroke()
  }
  const ohlc = $("d-ohlc")
  if (ohlc) {
    ohlc.textContent = `O ${axis(shown.o)}  H ${axis(shown.h)}  L ${axis(shown.l)}  C ${axis(shown.c)}`
  }
}

function sparkCandles() {
  const coin = state.coins.find((c) => c.mint === ui.mint)
  if (!coin?.spark || coin.spark.length < 2) return []
  const now = Date.now()
  return coin.spark.map((v, i) => ({
    t: now - (coin.spark.length - 1 - i) * 15000,
    o: coin.spark[i - 1] || v, h: Math.max(coin.spark[i - 1] || v, v),
    l: Math.min(coin.spark[i - 1] || v, v), c: v, v: 0,
  }))
}

function avatar(c, big = false) {
  if (c.image) return `<img alt="" src="${esc(c.image)}" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'avatar',textContent:'${esc((c.symbol || c.name || "?").slice(0, 1))}' }))" />`
  return `<span class="avatar">${esc((c.symbol || c.name || "?").slice(0, 1))}</span>`
}

function spark(values) {
  if (!values || values.length < 2) return ""
  const min = Math.min(...values)
  const max = Math.max(...values)
  const w = 72
  const h = 22
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w
    const y = h - ((v - min) / ((max - min) || 1)) * (h - 2) - 1
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(" ")
  const up = values.at(-1) >= values[0]
  return `<svg class="spark" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="${up ? "#3ee08f" : "#ff5d73"}" stroke-width="1.6" points="${pts}"/></svg>`
}

function txCount(c, keys) {
  return keys.reduce((n, k) => n + (c.tx?.[k]?.buys || 0) + (c.tx?.[k]?.sells || 0), 0)
}
function totalTx(c) {
  const w = ui.board === "movers" ? ui.window : "m5"
  const a = c.tx?.[w] || c.tx?.m5 || {}
  return (a.buys || 0) + (a.sells || 0)
}
function buyRatio(c) {
  const w = ui.board === "movers" ? ui.window : "m5"
  const a = (c.tx?.[w]?.buys || 0) + (c.tx?.[w]?.sells || 0) > 0 ? c.tx[w] : (c.tx?.m15 || c.tx?.m5 || {})
  const t = (a.buys || 0) + (a.sells || 0)
  return t ? a.buys / t : 0
}
function pick(list) { return [...list].sort((a, b) => b.score - a.score)[0] }
function scoreClass(n) { return n >= 75 ? "high" : n >= 55 ? "mid" : "low" }
function usd(n) {
  if (!n) return "—"
  const abs = Math.abs(n)
  const sign = n < 0 ? "-" : ""
  if (abs >= 1e9) return sign + "$" + (abs / 1e9).toFixed(2) + "B"
  if (abs >= 1e6) return sign + "$" + (abs / 1e6).toFixed(2) + "M"
  if (abs >= 1e3) return sign + "$" + (abs / 1e3).toFixed(1) + "K"
  if (abs >= 1) return sign + "$" + abs.toFixed(2)
  return sign + "$" + abs.toPrecision(3)
}
function pct(n) {
  if (!n) return "0%"
  return (n > 0 ? "+" : "") + n.toFixed(1) + "%"
}
function age(ts) {
  if (!ts) return "—"
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return Math.floor(s) + "s"
  if (s < 3600) return Math.floor(s / 60) + "m"
  if (s < 86400) return Math.floor(s / 3600) + "h"
  return Math.floor(s / 86400) + "d"
}
function clock(ts) {
  const d = new Date(ts)
  return d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}
function axis(n) {
  if (!n) return "—"
  if (n >= 1000) return usd(n)
  if (n >= 1) return n.toFixed(3)
  if (n >= 0.01) return n.toFixed(4)
  return n.toExponential(2)
}
function shortAddr(a) { return a ? a.slice(0, 4) + "…" + a.slice(-4) : "—" }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
}
