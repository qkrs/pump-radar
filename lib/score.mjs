/** Market cap en SOL al completar la bonding curve clásica de pump.fun. */
export const GRADUATION_MCAP_SOL = 410

const clamp = (n, a, b) => Math.min(b, Math.max(a, n))

export function progressOf({ graduated, marketCapSol, fdvUsd, solPrice }) {
  if (graduated) return 1
  if (marketCapSol > 0) return clamp(marketCapSol / GRADUATION_MCAP_SOL, 0, 0.995)
  if (fdvUsd > 0 && solPrice > 0) {
    return clamp(fdvUsd / (GRADUATION_MCAP_SOL * solPrice), 0, 0.995)
  }
  return 0
}

function txSum(coin, keys) {
  return keys.reduce(
    (acc, key) => {
      const w = coin.tx?.[key] || {}
      acc.buys += w.buys || 0
      acc.sells += w.sells || 0
      acc.buyers += w.buyers || 0
      acc.sellers += w.sellers || 0
      return acc
    },
    { buys: 0, sells: 0, buyers: 0, sellers: 0 },
  )
}

/**
 * Heurística 0–100 de flujo a favor.
 * No es una probabilidad estadística de profit.
 */
export function scoreCoin(coin, solPrice) {
  const short = txSum(coin, ["m5", "m15"])
  const flow = short.buys + short.sells > 0 ? short : txSum(coin, ["m5", "h1"])
  const total = flow.buys + flow.sells
  const buyRatio = total ? flow.buys / total : 0
  const change = coin.change || {}
  const volume = coin.volume || {}
  const p5 = change.m5 || 0
  const p15 = change.m15 || 0
  const p1 = change.h1 || 0
  const vol5 = volume.m5 || 0
  const vol15 = volume.m15 || 0
  const ageMin = coin.createdAt ? (Date.now() - coin.createdAt) / 60000 : 9999
  const progress = progressOf({ ...coin, solPrice })

  let pressure = 0
  if (total >= 4) pressure = clamp((buyRatio - 0.45) / 0.4, 0, 1) * 25

  let momentum = 0
  if (p5 > 0) momentum += (Math.min(p5, 40) / 40) * 12
  if (p15 > 0) momentum += (Math.min(p15, 80) / 80) * 10
  else if (p1 > 0 && p15 === 0) momentum += (Math.min(p1, 80) / 80) * 6
  if (p5 > 150) momentum -= 6
  if (p1 > 350) momentum -= 5
  if (p5 < -15) momentum -= 8
  momentum = clamp(momentum, 0, 25)

  const accel = vol15 > 0 ? vol5 / (vol15 / 3) : vol5 > 0 ? 2 : 0
  let activity = 0
  activity += Math.min(vol5 / 2500, 1) * 8
  activity += Math.min(Math.log10(total + 1) / 2, 1) * 6
  activity += clamp((accel - 0.8) / 1.5, 0, 1) * 6
  activity = clamp(activity, 0, 20)

  let curve = 0
  if (coin.graduated) curve = 8
  else if (progress < 0.05) curve = 3
  else if (progress < 0.2) curve = 9
  else if (progress < 0.7) curve = 15
  else if (progress < 0.9) curve = 11
  else curve = 6

  let fresh = 2
  if (ageMin < 2) fresh = 4
  else if (ageMin < 45) fresh = 10
  else if (ageMin < 180) fresh = 7
  else if (ageMin < 60 * 24) fresh = 4

  const flags = []
  let penalty = 0
  if (flow.buyers > 0 && flow.buyers <= 2 && total > 20) {
    penalty += 12
    flags.push("pocos compradores")
  }
  if (total >= 6 && buyRatio < 0.35) {
    penalty += 10
    flags.push("presión de venta")
  }
  if (vol5 < 80 && ageMin > 8 && !coin.graduated) {
    penalty += 6
    flags.push("sin volumen reciente")
  }
  if (coin.reserveUsd > 0 && coin.reserveUsd < 700 && ageMin > 5) {
    penalty += 5
    flags.push("poca liquidez")
  }
  if (p5 < -25) flags.push("cayendo")
  if (p1 > 400 && p5 < 8) {
    penalty += 6
    flags.push("ya extendida")
  }
  if (total < 4 && ageMin < 3) flags.push("recién lanzada")

  const raw = pressure + momentum + activity + curve + fresh - penalty
  return {
    score: Math.round(clamp(raw, 0, 100)),
    progress,
    parts: {
      pressure: Math.round(pressure),
      momentum: Math.round(momentum),
      activity: Math.round(activity),
      curve: Math.round(curve),
      fresh: Math.round(fresh),
      penalty: Math.round(penalty),
    },
    flags,
  }
}
