import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { getCoinDetail, getSnapshot, startMarket } from "./lib/market.mjs"
import { gateCoin, getPaper, tickPaper } from "./lib/paper.mjs"
import { explainCoin, loadLive, publicStatus, startLive, stopLive, storeKey, tickLive } from "./lib/live.mjs"

const root = fileURLToPath(new URL("./public/", import.meta.url))
const port = Number(process.env.PORT) || 4317
const clients = new Set()
let timer = null

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
}

function livePayload() {
  tickPaper()
  const snap = getSnapshot()
  const now = Date.now()
  const sol = snap.solPrice || 0
  return {
    ...snap,
    coins: snap.coins.map((c) => ({ ...c, gate: gateCoin(c, now, sol), live: explainCoin(c, now, sol) })),
    paper: getPaper(),
    bot: publicStatus(),
  }
}

function broadcast() {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    const payload = `data: ${JSON.stringify(livePayload())}\n\n`
    for (const res of clients) res.write(payload)
  }, 350)
}

startMarket(broadcast)
setInterval(() => {
  tickLive().catch((err) => console.error("bot", err.message))
  broadcast()
}, 4000)

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost")
  try {
    if (url.pathname === "/api/snapshot") {
      return json(res, livePayload())
    }
    if (url.pathname === "/api/paper") {
      tickPaper()
      return json(res, getPaper())
    }
    if (url.pathname === "/api/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      })
      res.write(`data: ${JSON.stringify(livePayload())}\n\n`)
      clients.add(res)
      const ping = setInterval(() => res.write(": ping\n\n"), 15000)
      req.on("close", () => {
        clearInterval(ping)
        clients.delete(res)
      })
      return
    }
    if (url.pathname === "/api/bot/key" && req.method === "POST") {
      const body = JSON.parse(await readBody(req))
      const publicKey = await storeKey(body.secret || "")
      return json(res, { ok: true, publicKey })
    }
    if (url.pathname === "/api/bot/start" && req.method === "POST") {
      const body = JSON.parse(await readBody(req))
      return json(res, await startLive(body))
    }
    if (url.pathname === "/api/bot/stop" && req.method === "POST") {
      return json(res, stopLive("parada manual"))
    }
    if (url.pathname === "/api/bot") {
      return json(res, publicStatus())
    }
    if (url.pathname === "/api/coin") {
      const mint = url.searchParams.get("mint") || ""
      const tf = url.searchParams.get("tf") || "1"
      const detail = await getCoinDetail(mint, tf)
      if (!detail) return json(res, { error: "no está en el radar" }, 404)
      return json(res, detail)
    }
    const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "")
    if (rel.includes("..")) return json(res, { error: "no" }, 400)
    const file = join(root, rel)
    const body = await readFile(file)
    res.writeHead(200, {
      "content-type": types[extname(file)] || "application/octet-stream",
      "cache-control": "no-cache",
    })
    res.end(body)
  } catch (err) {
    if (err.code === "ENOENT") return json(res, { error: "not found" }, 404)
    return json(res, { error: err.message }, 500)
  }
})

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 8192) throw new Error("demasiado grande")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8") || "{}"
}

function json(res, body, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  res.end(JSON.stringify(body))
}

await loadLive()
server.listen(port, "127.0.0.1", () => {
  console.log(`Pump Radar en http://127.0.0.1:${port}`)
})
