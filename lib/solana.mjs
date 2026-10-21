import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex")
const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com"

export function encodeBase58(buf) {
  const bytes = Buffer.from(buf)
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1
  const digits = [0]
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let out = "1".repeat(zeros)
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]]
  return out
}

export function decodeBase58(text) {
  const str = String(text).trim()
  let zeros = 0
  while (zeros < str.length && str[zeros] === "1") zeros += 1
  const bytes = [0]
  for (let i = zeros; i < str.length; i++) {
    const value = ALPHABET.indexOf(str[i])
    if (value < 0) throw new Error("la clave no es base58")
    let carry = value
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  const body = Buffer.from(bytes.reverse())
  return Buffer.concat([Buffer.alloc(zeros), body])
}

function ed25519Key(seed) {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  })
}

function publicFromSeed(seed) {
  const spki = createPublicKey(ed25519Key(seed)).export({ format: "der", type: "spki" })
  return Buffer.from(spki.subarray(spki.length - 32))
}

export function keypairFromSecret(raw) {
  const buf = Buffer.from(raw)
  const seed = buf.length === 64 ? buf.subarray(0, 32) : buf
  if (seed.length !== 32) throw new Error("la clave tiene que ser de 32 o 64 bytes")
  const pubkey = publicFromSeed(seed)
  if (buf.length === 64 && !pubkey.equals(buf.subarray(32))) {
    throw new Error("la clave pública no coincide con la semilla")
  }
  return { seed, pubkey, secret: Buffer.concat([seed, pubkey]) }
}

export function walletFromText(text) {
  const trimmed = String(text || "").trim()
  if (!trimmed) throw new Error("falta la clave")
  let raw
  if (trimmed.startsWith("[")) {
    const nums = JSON.parse(trimmed)
    if (!Array.isArray(nums)) throw new Error("la clave json no es una lista")
    raw = Buffer.from(nums)
  } else {
    const compact = trimmed.replace(/\s+/g, "").replace(/^solana:/i, "").replace(/^"|"$/g, "")
    const words = trimmed.split(/\s+/).filter(Boolean)
    if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(compact) && compact.length >= 32) raw = decodeBase58(compact)
    else if (words.length >= 12) throw new Error("eso es la frase semilla, no la clave privada")
    else raw = decodeBase58(words[0] || "")
  }
  return keypairFromSecret(raw)
}

export async function loadWallet(file) {
  const wallet = walletFromText(await readFile(file, "utf8"))
  await chmod(file, 0o600).catch(() => {})
  return wallet
}

export async function saveWallet(file, text) {
  const wallet = walletFromText(text)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, String(text).trim() + "\n", { mode: 0o600 })
  await chmod(file, 0o600).catch(() => {})
  return wallet
}

function readCompact(buf, offset) {
  let len = 0
  let size = 0
  for (;;) {
    if (offset + size >= buf.length) throw new Error("transacción cortada")
    const elem = buf[offset + size]
    len |= (elem & 0x7f) << (size * 7)
    size += 1
    if ((elem & 0x80) === 0) break
    if (size > 3) throw new Error("longitud inválida")
  }
  return [len, size]
}

export function signVersioned(raw, wallet) {
  const buf = Buffer.from(raw)
  const [sigCount, sigCountLen] = readCompact(buf, 0)
  const messageStart = sigCountLen + sigCount * 64
  if (messageStart >= buf.length) throw new Error("transacción sin mensaje")
  const message = buf.subarray(messageStart)
  let off = message[0] & 0x80 ? 1 : 0
  const numRequired = message[off]
  off += 3
  const [, keyLen] = readCompact(message, off)
  off += keyLen
  let index = -1
  for (let i = 0; i < numRequired; i++) {
    const key = message.subarray(off + i * 32, off + (i + 1) * 32)
    if (key.equals(wallet.pubkey)) {
      index = i
      break
    }
  }
  if (index < 0) throw new Error("la transacción no pide esta billetera")
  const signature = sign(null, message, ed25519Key(wallet.seed))
  if (signature.length !== 64) throw new Error("firma de largo inesperado")
  signature.copy(buf, sigCountLen + index * 64)
  return buf
}

export function verifySigned(raw, wallet) {
  const buf = Buffer.from(raw)
  const [sigCount, sigCountLen] = readCompact(buf, 0)
  const message = buf.subarray(sigCountLen + sigCount * 64)
  const signature = buf.subarray(sigCountLen, sigCountLen + 64)
  return verify(null, message, ed25519Key(wallet.seed), signature)
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const body = await res.json()
  if (body.error) {
    const logs = body.error.data?.logs || []
    if (logs.some((line) => String(line).includes("ExceededSlippage"))) {
      throw new Error("el precio se movió más de lo permitido")
    }
    throw new Error(body.error.message || "rpc")
  }
  return body.result
}

const WSOL = "So11111111111111111111111111111111111111112"

export async function poolSolUi(pool) {
  if (!pool) return null
  const rows = await rpc("getTokenAccountsByOwner", [pool, { mint: WSOL }, { encoding: "jsonParsed", commitment: "confirmed" }])
  let ui = 0
  for (const row of rows?.value || []) {
    const n = Number(row.account?.data?.parsed?.info?.tokenAmount?.uiAmount)
    if (Number.isFinite(n)) ui += n
  }
  if (ui > 0) return ui
  const info = await rpc("getBalance", [pool, { commitment: "confirmed" }])
  const lamports = typeof info === "number" ? info : info?.value
  return lamports > 0 ? lamports / 1e9 : 0
}

export async function settledExit(owner, mint) {
  const owner58 = encodeBase58(owner)
  const sigs = await rpc("getSignaturesForAddress", [owner58, { limit: 8 }])
  const list = Array.isArray(sigs) ? sigs : sigs?.value || []
  for (const row of list) {
    if (!row?.signature || row.err) continue
    const tx = await rpc("getTransaction", [row.signature, { encoding: "json", maxSupportedTransactionVersion: 1 }])
    const meta = tx?.meta
    if (!meta) continue
    const keys = []
    for (const key of tx.transaction?.message?.accountKeys || []) keys.push(typeof key === "string" ? key : key.pubkey)
    for (const key of meta.loadedAddresses?.writable || []) keys.push(key)
    for (const key of meta.loadedAddresses?.readonly || []) keys.push(key)
    const pre = (meta.preTokenBalances || []).find((b) => b.owner === owner58 && b.mint === mint)
    const post = (meta.postTokenBalances || []).find((b) => b.owner === owner58 && b.mint === mint)
    const preUi = Number(pre?.uiTokenAmount?.uiAmount || 0)
    const postUi = Number(post?.uiTokenAmount?.uiAmount || 0)
    if (!(preUi > 0) || postUi > 0) continue
    const idx = keys.indexOf(owner58)
    if (idx < 0) continue
    return { signature: row.signature, solDelta: (meta.postBalances[idx] - meta.preBalances[idx]) / 1e9 }
  }
  return null
}

export async function mintOwner(mint) {
  const result = await rpc("getAccountInfo", [mint, { encoding: "base64", commitment: "confirmed" }])
  const owner = result?.value?.owner
  if (!owner) throw new Error("no pude leer la moneda")
  return owner
}

export async function solBalance(pubkey) {
  const result = await rpc("getBalance", [encodeBase58(pubkey), { commitment: "confirmed" }])
  const lamports = typeof result === "number" ? result : result?.value
  if (!(lamports >= 0)) throw new Error("no pude leer el saldo")
  return lamports / 1e9
}

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

async function accountsByOwner(owner, filter) {
  const result = await rpc("getTokenAccountsByOwner", [
    encodeBase58(owner),
    filter,
    { encoding: "jsonParsed", commitment: "confirmed" },
  ])
  return result?.value || []
}

const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"

export async function listHoldings(owner) {
  const seen = new Set()
  const out = []
  for (const programId of [SPL, TOKEN_2022]) {
    const rows = await accountsByOwner(owner, { programId })
    for (const row of rows) {
      if (seen.has(row.pubkey)) continue
      seen.add(row.pubkey)
      const info = row.account?.data?.parsed?.info
      const mint = info?.mint
      const ui = Number(info?.tokenAmount?.uiAmount)
      if (!mint || mint === WSOL || !(ui > 0)) continue
      seen.add(row.pubkey)
      out.push({ mint, ui })
    }
  }
  return out
}

export async function tokenHolding(owner, mint) {
  const rows = await accountsByOwner(owner, { mint })
  const seen = new Set(rows.map((row) => row.pubkey))
  for (const row of await accountsByOwner(owner, { programId: TOKEN_2022 })) {
    if (seen.has(row.pubkey)) continue
    if (row.account?.data?.parsed?.info?.mint !== mint) continue
    rows.push(row)
  }
  let ui = 0
  let raw = 0n
  for (const row of rows) {
    const info = row.account?.data?.parsed?.info?.tokenAmount
    if (!info) continue
    const n = Number(info.uiAmount)
    if (Number.isFinite(n)) ui += n
    if (info.amount) raw += BigInt(info.amount)
  }
  return { ui, raw }
}

export async function tokenUi(owner, mint) {
  const holding = await tokenHolding(owner, mint)
  return holding.ui
}

export async function sendRaw(raw) {
  return rpc("sendTransaction", [
    Buffer.from(raw).toString("base64"),
    { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 },
  ])
}

export async function confirmSig(signature, timeoutMs = 25_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }])
    const row = result?.value?.[0]
    if (row?.err) throw new Error("la transacción falló en la red")
    if (row && (row.confirmationStatus === "confirmed" || row.confirmationStatus === "finalized")) return true
    await new Promise((r) => setTimeout(r, 1500))
  }
  return false
}

export function walletPath(root) {
  return process.env.PUMP_KEY_FILE || join(root, "data", "wallet.key")
}
