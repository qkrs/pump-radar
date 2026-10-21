import { confirmSig, encodeBase58, mintOwner, sendRaw, signVersioned, tokenHolding } from "./solana.mjs"

const TRADE = "https://pumpportal.fun/api/trade-local"
const JUP = "https://lite-api.jup.ag/swap/v1"
const SOL_MINT = "So11111111111111111111111111111111111111112"
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
const SLIPPAGE = 25
const PRIORITY_FEE = 0.0002

export async function swap(wallet, opts) {
  let program = ""
  try {
    program = await mintOwner(opts.mint)
  } catch {
    program = ""
  }
  if (program === TOKEN_2022) return jupiterSwap(wallet, opts)
  try {
    return await portalSwap(wallet, opts)
  } catch (err) {
    if (!/bad request/i.test(err.message)) throw err
    return jupiterSwap(wallet, opts)
  }
}

async function portalSwap(wallet, { action, mint, amount, denominatedInSol, slippage }) {
  const res = await fetch(TRADE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      publicKey: encodeBase58(wallet.pubkey),
      action,
      mint,
      amount,
      denominatedInSol: denominatedInSol ? "true" : "false",
      slippage: slippage ?? SLIPPAGE,
      priorityFee: PRIORITY_FEE,
      pool: "auto",
    }),
  })
  const buf = Buffer.from(await res.arrayBuffer())
  if (!res.ok || buf[0] === 0x7b) {
    const text = buf.toString("utf8").slice(0, 180)
    throw new Error(text || `trade-local ${res.status}`)
  }
  return land(buf, wallet)
}

async function jupiterSwap(wallet, { action, mint, amount, denominatedInSol, slippage }) {
  const buying = action === "buy" && denominatedInSol
  const raw = buying ? BigInt(Math.round(Number(amount) * 1e9)) : await sellRaw(wallet, mint, amount)
  if (raw <= 0n) throw new Error("monto inválido")
  const quote = await jupQuote({
    inputMint: buying ? SOL_MINT : mint,
    outputMint: buying ? mint : SOL_MINT,
    amount: raw.toString(),
    slippageBps: Math.round((slippage ?? SLIPPAGE) * 100),
    instructionVersion: "V2",
  })
  const res = await fetch(`${JUP}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "pump-radar" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: encodeBase58(wallet.pubkey),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: Math.round(PRIORITY_FEE * 1e9),
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (res.status === 429) throw new Error("Jupiter está saturado, reintento")
  if (!res.ok || !body.swapTransaction) {
    throw new Error(body.error || body.message || `Jupiter ${res.status}`)
  }
  return land(Buffer.from(body.swapTransaction, "base64"), wallet)
}

async function sellRaw(wallet, mint, amount) {
  const holding = await tokenHolding(wallet.pubkey, mint)
  if (holding.raw <= 0n) throw new Error("no hay tokens para vender")
  const ui = Number(amount)
  if (!(holding.ui > 0) || !(ui > 0) || ui >= holding.ui * 0.99) return holding.raw
  const part = BigInt(Math.round(ui * 1e6))
  const full = BigInt(Math.round(holding.ui * 1e6))
  return full > 0n ? (holding.raw * part) / full : holding.raw
}

async function jupQuote(params) {
  const url = new URL(`${JUP}/quote`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  let res
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(url, { headers: { "user-agent": "pump-radar" } })
    if (res.status !== 429) break
    await new Promise((r) => setTimeout(r, 800))
  }
  const body = await res.json().catch(() => ({}))
  if (res.status === 429) throw new Error("Jupiter está saturado, reintento")
  if (!res.ok || !body.outAmount) {
    const msg = String(body.error || body.message || `Jupiter ${res.status}`)
    if (/other amount threshold/i.test(msg)) throw new Error("el pool quedó sin liquidez")
    if (/route|find/i.test(msg)) throw new Error("Jupiter no encuentra pool para esta moneda")
    throw new Error(msg)
  }
  return body
}

export async function assertExit(mint, solAmount, slippage = SLIPPAGE) {
  const lamports = BigInt(Math.round(Number(solAmount) * 1e9))
  if (lamports <= 0n) throw new Error("monto inválido")
  const buy = await jupQuote({
    inputMint: SOL_MINT,
    outputMint: mint,
    amount: lamports.toString(),
    slippageBps: Math.round(slippage * 100),
    instructionVersion: "V2",
  })
  const sell = await jupQuote({
    inputMint: mint,
    outputMint: SOL_MINT,
    amount: buy.outAmount,
    slippageBps: 1200,
    instructionVersion: "V2",
  })
  const back = Number(sell.outAmount) / 1e9
  if (!(back >= Number(solAmount) * 0.75)) throw new Error("la venta no devolvería la plata")
  return back
}

async function land(raw, wallet) {
  const signed = signVersioned(raw, wallet)
  const signature = await sendRaw(signed)
  const ok = await confirmSig(signature)
  if (!ok) throw new Error("la red no confirmó a tiempo")
  return signature
}
