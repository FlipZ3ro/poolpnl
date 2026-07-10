// Detect a wallet's Uniswap V4 positions, read live state (range, liquidity,
// current price) and uncollected fees. PositionManager is NOT enumerable and this
// RPC's eth_getLogs is unreliable, so we detect via Blockscout (else ownerOf scan).
import { encodeAbiParameters, encodePacked, keccak256, type Address } from 'viem'
import { V4, NATIVE, PM_SEL, SV_SEL, ERC20_SEL, CHAIN, lc } from './config'
import { ethCall, batchCall, hexToBig } from './rpc'

export interface PoolKey { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
export interface TokenMeta { address: string; symbol: string; decimals: number }
export interface Position {
  tokenId: number
  poolKey: PoolKey
  poolId: string
  tickLower: number
  tickUpper: number
  liquidity: bigint
  currentTick: number
  sqrtPriceX96: bigint
  inRange: boolean
  token0: TokenMeta
  token1: TokenMeta
  amount0: bigint   // current principal in currency0 base units
  amount1: bigint
  fee0: bigint      // uncollected fee, currency0 base units
  fee1: bigint
}

export const pad = (v: string | bigint | number) =>
  (typeof v === 'string' && v.startsWith('0x') ? v.slice(2) : BigInt(v).toString(16)).toLowerCase().padStart(64, '0')
const sgn24 = (n: number) => (n >= 0x800000 ? n - 0x1000000 : n)
const U256 = 1n << 256n
const Q96 = 1n << 96n

const poolKeyComponents = [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] as const
function derivePoolId(k: PoolKey): string {
  return keccak256(encodeAbiParameters([{ type: 'tuple', components: poolKeyComponents as any }] as any, [k] as any))
}

function decStr(hex: string | null): string | null {
  if (!hex || hex === '0x') return null
  try {
    const off = parseInt(hex.slice(2, 66), 16)
    const len = parseInt(hex.slice(2 + off * 2, 2 + off * 2 + 64), 16)
    if (!len || len > 200) return null
    const s = hex.slice(2 + off * 2 + 64, 2 + off * 2 + 64 + len * 2)
    const d = decodeURIComponent(s.match(/.{2}/g)!.map((b) => '%' + b).join(''))
    return /^[\x20-\x7e]+$/.test(d) ? d : null
  } catch { return null }
}
const metaCache = new Map<string, TokenMeta>()
async function tokenMeta(addr: string): Promise<TokenMeta> {
  if (/^0x0+$/.test(addr)) return { address: NATIVE, symbol: 'ETH', decimals: 18 }
  const k = lc(addr); if (metaCache.has(k)) return metaCache.get(k)!
  const [s, d] = await Promise.all([ethCall(addr, ERC20_SEL.symbol).catch(() => null), ethCall(addr, ERC20_SEL.decimals).catch(() => null)])
  const m = { address: k, symbol: decStr(s) || addr.slice(0, 6), decimals: d && d !== '0x' ? parseInt(d, 16) : 18 }
  metaCache.set(k, m); return m
}

/** Detect an owner's PositionManager tokenIds via Blockscout (instant, no wallet). */
export async function detectViaBlockscout(owner: string): Promise<number[]> {
  const ids: number[] = []
  let url: string | null = `${CHAIN.blockscoutApi}/addresses/${owner}/nft?type=ERC-721`
  for (let page = 0; url && page < 20; page++) {
    const res: any = await fetch(url).then((r) => r.json())
    for (const it of res.items || []) {
      const addr = (it.token?.address || it.token?.address_hash || '').toLowerCase()
      if (addr === lc(V4.positionManager)) ids.push(Number(it.id))
    }
    const np = res.next_page_params
    url = np ? `${CHAIN.blockscoutApi}/addresses/${owner}/nft?type=ERC-721&${new URLSearchParams(np).toString()}` : null
  }
  return ids.sort((a, b) => b - a)
}

/** Fallback: scan ownerOf newest→oldest to find the owner's tokenIds. */
export async function detectTokenIds(owner: string, onProgress?: (scanned: number, total: number, found: number) => void): Promise<number[]> {
  const [balHex, nextHex] = await Promise.all([
    ethCall(V4.positionManager, PM_SEL.balanceOf + pad(owner)),
    ethCall(V4.positionManager, PM_SEL.nextTokenId),
  ])
  const want = Number(hexToBig(balHex))
  const next = Number(hexToBig(nextHex))
  if (want === 0 || next <= 1) return []
  const ownerLc = lc(owner)
  const ids: number[] = []
  const BATCH = 100
  let scanned = 0
  for (let hi = next - 1; hi >= 1 && ids.length < want; hi -= BATCH) {
    const lo = Math.max(1, hi - BATCH + 1)
    const calls = []
    for (let id = hi; id >= lo; id--) calls.push({ to: V4.positionManager, data: PM_SEL.ownerOf + pad(id) })
    const res = await batchCall(calls)
    res.forEach((r, i) => { if (r && r.length >= 66 && lc('0x' + r.slice(26, 66)) === ownerLc) ids.push(hi - i) })
    scanned += (hi - lo + 1)
    onProgress?.(scanned, next - 1, ids.length)
  }
  return ids.sort((a, b) => b - a)
}

function feeOwed(liquidity: bigint, current: bigint, last: bigint): bigint {
  const delta = (current - last + U256) % U256
  return (liquidity * delta) >> 128n
}

// sqrt price at a tick, Q96. Uses float pow — plenty precise for display/value math.
function sqrtAtTick(tick: number): bigint {
  const r = Math.pow(1.0001, tick / 2)
  return BigInt(Math.floor(r * 2 ** 96))
}
// V3 principal amounts from liquidity given current/lower/upper sqrt prices (Q96).
function amountsFromLiquidity(L: bigint, sp: bigint, sa: bigint, sb: bigint): [bigint, bigint] {
  if (sa > sb) [sa, sb] = [sb, sa]
  let amount0 = 0n, amount1 = 0n
  if (sp <= sa) {
    amount0 = (L * Q96 * (sb - sa)) / (sb * sa)
  } else if (sp < sb) {
    amount0 = (L * Q96 * (sb - sp)) / (sb * sp)
    amount1 = (L * (sp - sa)) / Q96
  } else {
    amount1 = (L * (sb - sa)) / Q96
  }
  return [amount0, amount1]
}

export async function readPosition(tokenId: number): Promise<Position | null> {
  const gpi = await ethCall(V4.positionManager, PM_SEL.getPoolAndPositionInfo + pad(tokenId)).catch(() => null)
  if (!gpi || gpi === '0x') return null
  const w = gpi.slice(2).match(/.{64}/g)!
  const poolKey: PoolKey = {
    currency0: ('0x' + w[0].slice(24)) as Address, currency1: ('0x' + w[1].slice(24)) as Address,
    fee: parseInt(w[2], 16), tickSpacing: sgn24(parseInt(w[3].slice(-6), 16)), hooks: ('0x' + w[4].slice(24)) as Address,
  }
  const info = BigInt('0x' + w[5])
  const tickLower = sgn24(Number((info >> 8n) & 0xffffffn))
  const tickUpper = sgn24(Number((info >> 32n) & 0xffffffn))
  const poolId = derivePoolId(poolKey)

  const [liqHex, slot0, token0, token1] = await Promise.all([
    ethCall(V4.positionManager, PM_SEL.getPositionLiquidity + pad(tokenId)).catch(() => null),
    ethCall(V4.stateView, SV_SEL.getSlot0 + poolId.slice(2)).catch(() => null),
    tokenMeta(poolKey.currency0), tokenMeta(poolKey.currency1),
  ])
  const liquidity = hexToBig(liqHex)
  let sqrtPriceX96 = 0n, currentTick = 0
  if (slot0 && slot0 !== '0x') {
    const s = slot0.slice(2).match(/.{64}/g)!
    sqrtPriceX96 = BigInt('0x' + s[0])
    currentTick = sgn24(parseInt(s[1].slice(-6), 16))
  }

  // current principal amounts from liquidity
  let amount0 = 0n, amount1 = 0n
  if (liquidity > 0n && sqrtPriceX96 > 0n) {
    [amount0, amount1] = amountsFromLiquidity(liquidity, sqrtPriceX96, sqrtAtTick(tickLower), sqrtAtTick(tickUpper))
  }

  // pending fees via fee growth
  let fee0 = 0n, fee1 = 0n
  try {
    const positionKey = keccak256(encodePacked(
      ['address', 'int24', 'int24', 'bytes32'],
      [V4.positionManager as Address, tickLower, tickUpper, ('0x' + pad(tokenId)) as `0x${string}`],
    ))
    const [posInfo, growth] = await Promise.all([
      ethCall(V4.stateView, SV_SEL.getPositionInfo + poolId.slice(2) + positionKey.slice(2)),
      ethCall(V4.stateView, SV_SEL.getFeeGrowthInside + poolId.slice(2) + pad(tickLower < 0 ? (BigInt(tickLower) + U256) % U256 : tickLower) + pad(tickUpper < 0 ? (BigInt(tickUpper) + U256) % U256 : tickUpper)),
    ])
    if (posInfo && growth && posInfo !== '0x' && growth !== '0x') {
      const pw = posInfo.slice(2).match(/.{64}/g)!
      const posLiq = BigInt('0x' + pw[0])
      const last0 = BigInt('0x' + pw[1]), last1 = BigInt('0x' + pw[2])
      const gw = growth.slice(2).match(/.{64}/g)!
      const cur0 = BigInt('0x' + gw[0]), cur1 = BigInt('0x' + gw[1])
      fee0 = feeOwed(posLiq, cur0, last0)
      fee1 = feeOwed(posLiq, cur1, last1)
    }
  } catch { /* fee preview best-effort */ }

  return {
    tokenId, poolKey, poolId, tickLower, tickUpper, liquidity, currentTick, sqrtPriceX96,
    inRange: currentTick >= tickLower && currentTick < tickUpper,
    token0, token1, amount0, amount1, fee0, fee1,
  }
}

/** Detect (Blockscout, else ownerOf scan) + read all positions for any address. */
export async function loadPositions(owner: string, onProgress?: (s: number, t: number, f: number) => void): Promise<Position[]> {
  let ids: number[] = []
  try { ids = await detectViaBlockscout(owner) } catch { /* fall back below */ }
  if (ids.length === 0) ids = await detectTokenIds(owner, onProgress)
  const out: Position[] = []
  const B = 8
  for (let i = 0; i < ids.length; i += B) {
    const chunk = ids.slice(i, i + B)
    const res = await Promise.all(chunk.map((id) => readPosition(id).catch(() => null)))
    for (const p of res) if (p) out.push(p)
    onProgress?.(Math.min(i + B, ids.length), ids.length, out.length)
  }
  out.sort((a, b) => b.tokenId - a.tokenId)
  return out
}

// ETH value (in wei, as float) of a raw currency1 amount, priced at the pool's
// current sqrtPrice. Pool token0 is ETH-side (NATIVE sorts first), token1 the pair.
export function currency1ToEth(amount1: bigint, sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 === 0n) return 0
  // token0_raw = amount1_raw * 2^192 / sqrtPriceX96^2
  const num = amount1 * (Q96 * Q96)
  const den = sqrtPriceX96 * sqrtPriceX96
  return Number(num) / Number(den)
}

export { derivePoolId }
