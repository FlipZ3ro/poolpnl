// PnL reconstruction (ETH-denominated), POOL-level, for a wallet's Uniswap V4 LP.
//
// This chain has no working event-log endpoint and its PoolManager is a singleton
// that also routes swaps — so "flows to the PoolManager" alone can't tell LP from
// swaps. The reliable signal is the modifyLiquidities selector (0xdd46508f), which
// appears (directly, or nested inside execute()/multicall calldata) only for LP
// operations. We:
//   1. find every owner tx whose calldata contains that selector (LP ops),
//   2. decode each action → (DECREASE liq==0 = fee collect, DECREASE liq>0 / BURN =
//      principal withdrawal, MINT / INCREASE = deposit),
//   3. read that tx's native (internal-txns) + ERC20 flows vs the PoolManager,
//   4. aggregate per pool (pair token), valuing the non-ETH side at the pool's
//      current price. Live open positions add exact current value + unclaimed fees.
// Blockscout on this chain load-balances inconsistent indexers, so every fetch
// retries and results are de-duplicated by hash.
import { CHAIN, POOL_MANAGER, lc, WETH } from './config'
import { Position, currency1ToEth } from './positions'

const PM = lc(POOL_MANAGER)
const WETHlc = lc(WETH)
const isEthSide = (t: string) => t === WETHlc || /^0x0+$/.test(t)

// ---- resilient Blockscout fetch ----------------------------------------------
async function bsRetry(path: string, tries = 4): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`${CHAIN.blockscoutApi}${path}`); if (r.ok) return await r.json() } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250 * (i + 1)))
  }
  return null
}
async function bsPaged(path: string, cap = 30): Promise<any[]> {
  const items: any[] = []
  let np: any = null
  for (let p = 0; p < cap; p++) {
    const sep = path.includes('?') ? '&' : '?'
    const res = await bsRetry(np ? `${path}${sep}${new URLSearchParams(np)}` : path)
    if (!res) break
    items.push(...(res.items || []))
    np = res.next_page_params
    if (!np) break
  }
  return items
}

// ---- modifyLiquidities calldata decode ---------------------------------------
const SEL = 'dd46508f'
const ACT = { INCREASE: 0x00, DECREASE: 0x01, MINT: 0x02, BURN: 0x03 }
const readWord = (hex: string, i: number) => BigInt('0x' + (hex.slice(i * 64, i * 64 + 64) || '0'))

interface LpAction { action: number; tokenId: bigint; liquidity: bigint }
// Decode one modifyLiquidities(bytes unlockData, uint256) body (selector stripped).
function decodeModLiq(body: string): LpAction[] {
  const acts: LpAction[] = []
  try {
    const uOff = Number(readWord(body, 0)) * 2
    const uLen = Number(readWord(body, uOff / 64)) * 2
    const u = body.slice(uOff + 64, uOff + 64 + uLen)
    const actionsOff = Number(readWord(u, 0)) * 2
    const paramsOff = Number(readWord(u, 1)) * 2
    const actionsLen = Number(readWord(u, actionsOff / 64))
    const actionsHex = u.slice(actionsOff + 64, actionsOff + 64 + actionsLen * 2)
    const paramsLen = Number(readWord(u, paramsOff / 64))
    const base = paramsOff + 64
    for (let i = 0; i < actionsLen && i < paramsLen; i++) {
      const action = parseInt(actionsHex.slice(i * 2, i * 2 + 2), 16)
      const pOff = Number(readWord(u, (base + i * 64) / 64)) * 2
      const pStart = base + pOff + 64
      // DECREASE/INCREASE/BURN params start with (uint256 tokenId, uint256 liquidity, …)
      if (action === ACT.DECREASE || action === ACT.INCREASE || action === ACT.BURN) {
        acts.push({ action, tokenId: readWord(u, pStart / 64), liquidity: readWord(u, pStart / 64 + 1) })
      } else if (action === ACT.MINT) {
        acts.push({ action, tokenId: 0n, liquidity: 0n }) // tokenId assigned on mint; not in calldata
      }
    }
  } catch { /* best-effort */ }
  return acts
}
// Find every modifyLiquidities call in a tx's calldata (direct, or wrapped in
// execute()/multicall) and decode them all.
function lpActionsForTx(input: string): LpAction[] {
  const hex = (input.startsWith('0x') ? input.slice(2) : input).toLowerCase()
  const out: LpAction[] = []
  let from = 0
  while (true) {
    const at = hex.indexOf(SEL, from)
    if (at < 0) break
    // align to a 4-byte boundary relative to a plausible calldata start
    out.push(...decodeModLiq(hex.slice(at + 8)))
    from = at + 8
  }
  return out
}

// ---- per-pool reconstruction --------------------------------------------------
export interface PoolPnL {
  token: string          // pair (non-ETH) token address; '' for pure-ETH edge
  symbol: string
  cost: number           // ETH deposited (est., pair side priced at current)
  withdrawn: number      // ETH principal removed
  collectedFees: number  // ETH fees already collected
  currentValue: number   // ETH value of live principal
  unclaimed: number      // ETH pending fees
  pnl: number
  open: number           // # open positions
  positions: Position[]
  hasPrice: boolean      // false → pair side couldn't be priced (ETH-side only)
  events: { ts: number; kind: 'add' | 'remove' | 'collect'; eth: number; hash: string }[]
}

export interface WalletPnL {
  address: string
  pools: PoolPnL[]
  totals: {
    pnl: number; realized: number; unrealized: number
    unclaimed: number; collectedFees: number
    currentValue: number; deposited: number; withdrawn: number
    open: number; closed: number
  }
  calendar: Map<string, number>
  approx: boolean        // any pool priced ETH-side only
}

const wei = (n: bigint) => Number(n) / 1e18

export async function loadWalletPnL(owner: string, positions: Position[]): Promise<WalletPnL> {
  const ownerLc = lc(owner)
  // price map: pair token → ETH per 1 token (raw/raw via sqrtPrice), from live pools
  const priceByToken = new Map<string, bigint>() // token → sqrtPriceX96
  const posByToken = new Map<string, Position[]>()
  const symByToken = new Map<string, string>()
  for (const p of positions) {
    const pair = isEthSide(lc(p.token0.address)) ? lc(p.token1.address) : lc(p.token0.address)
    const pairMeta = isEthSide(lc(p.token0.address)) ? p.token1 : p.token0
    if (p.sqrtPriceX96 > 0n) priceByToken.set(pair, p.sqrtPriceX96)
    symByToken.set(pair, pairMeta.symbol)
    if (!posByToken.has(pair)) posByToken.set(pair, [])
    posByToken.get(pair)!.push(p)
  }
  const tokenToEth = (token: string, amt: bigint): { eth: number; priced: boolean } => {
    if (isEthSide(token)) return { eth: wei(amt), priced: true }
    const sp = priceByToken.get(token)
    if (!sp) return { eth: 0, priced: false }
    return { eth: currency1ToEth(amt, sp) / 1e18, priced: true }
  }

  // 1) owner transactions → keep LP txs (calldata contains the modifyLiquidities selector)
  const txItems = await bsPaged(`/addresses/${owner}/transactions?filter=from`, 30)
  const seen = new Set<string>()
  const lpTxs = txItems.filter((t) => {
    const h = lc(t.hash); if (seen.has(h)) return false
    const input = (t.raw_input || t.input || '').toLowerCase()
    if (!input.includes(SEL)) return false
    seen.add(h); return true
  }).map((t) => ({
    hash: t.hash as string,
    value: BigInt(t.value || '0'),
    input: (t.raw_input || t.input || '').toLowerCase(),
    ts: Math.floor(new Date(t.timestamp).getTime() / 1000),
  }))

  // 2) owner ERC20 transfers grouped by tx (dedup by log)
  const ttItems = await bsPaged(`/addresses/${owner}/token-transfers?type=ERC-20`, 30)
  const transfersByTx = new Map<string, { token: string; symbol: string; from: string; to: string; value: bigint }[]>()
  const tseen = new Set<string>()
  for (const t of ttItems) {
    const h = lc(t.transaction_hash || t.tx_hash || '')
    if (!h) continue
    const key = h + ':' + (t.log_index ?? Math.random())
    if (tseen.has(key)) continue
    tseen.add(key)
    const tr = {
      token: lc(t.token?.address || t.token?.address_hash || ''),
      symbol: t.token?.symbol || '',
      from: lc(t.from?.hash || ''), to: lc(t.to?.hash || ''),
      value: BigInt(t.total?.value || t.value || '0'),
    }
    if (!transfersByTx.has(h)) transfersByTx.set(h, [])
    transfersByTx.get(h)!.push(tr)
  }

  // 3) per LP tx: classify + read PoolManager cashflow, aggregate per pool
  const pools = new Map<string, PoolPnL>()
  const ensure = (token: string): PoolPnL => {
    if (!pools.has(token)) pools.set(token, {
      token, symbol: symByToken.get(token) || '', cost: 0, withdrawn: 0, collectedFees: 0,
      currentValue: 0, unclaimed: 0, pnl: 0, open: 0, positions: [], hasPrice: true, events: [],
    })
    return pools.get(token)!
  }
  const calendar = new Map<string, number>()

  const B = 6
  for (let i = 0; i < lpTxs.length; i += B) {
    const chunk = lpTxs.slice(i, i + B)
    const internals = await Promise.all(chunk.map((t) => bsRetry(`/transactions/${t.hash}/internal-transactions`)))
    chunk.forEach((tx, ci) => {
      const acts = lpActionsForTx(tx.input)
      if (!acts.length) return
      const isCollect = acts.some((a) => a.action === ACT.DECREASE && a.liquidity === 0n)
      const isRemove = acts.some((a) => (a.action === ACT.DECREASE && a.liquidity > 0n) || a.action === ACT.BURN)
      const isAdd = acts.some((a) => a.action === ACT.MINT || a.action === ACT.INCREASE)

      // native ETH vs PoolManager
      const it = internals[ci]?.items || []
      let natIn = tx.value // native sent with the tx (deposit)
      let natOut = 0n
      for (const x of it) {
        const f = lc(x.from?.hash || ''), t = lc(x.to?.hash || '')
        const v = BigInt(x.value || '0')
        if (f === PM && t === ownerLc) natOut += v
        else if (t === PM && f === ownerLc) natIn += v
      }

      // ERC20 vs PoolManager → identify the pair token
      const trs = transfersByTx.get(lc(tx.hash)) || []
      let pairToken = ''
      let tokIn = 0n, tokOut = 0n, wethIn = 0n, wethOut = 0n
      for (const t of trs) {
        const toPM = t.to === PM && t.from !== PM
        const fromPM = t.from === PM && t.to !== PM
        if (!toPM && !fromPM) continue
        if (isEthSide(t.token)) { if (toPM) wethIn += t.value; else wethOut += t.value; continue }
        pairToken = t.token
        if (!symByToken.has(t.token) && t.symbol) symByToken.set(t.token, t.symbol)
        if (toPM) tokIn += t.value; else tokOut += t.value
      }

      const pool = ensure(pairToken)
      if (!pool.symbol) pool.symbol = symByToken.get(pairToken) || pairToken.slice(0, 6)
      const vIn = tokenToEth(pairToken, tokIn)
      const vOut = tokenToEth(pairToken, tokOut)
      if (!vIn.priced || !vOut.priced) pool.hasPrice = false

      const ethIn = wei(natIn) + wei(wethIn) + vIn.eth
      const ethOut = wei(natOut) + wei(wethOut) + vOut.eth

      if (isAdd && ethIn > 0) { pool.cost += ethIn; pool.events.push({ ts: tx.ts, kind: 'add', eth: ethIn, hash: tx.hash }) }
      if (ethOut > 0) {
        if (isCollect && !isRemove) { pool.collectedFees += ethOut; pool.events.push({ ts: tx.ts, kind: 'collect', eth: ethOut, hash: tx.hash }) }
        else { pool.withdrawn += ethOut; pool.events.push({ ts: tx.ts, kind: 'remove', eth: ethOut, hash: tx.hash }) }
        const day = new Date(tx.ts * 1000).toISOString().slice(0, 10)
        calendar.set(day, (calendar.get(day) || 0) + ethOut)
      }
      // deposits that weren't tagged isAdd (e.g. mint via router w/o decodable action) still count if only inflow
      if (!isAdd && !isCollect && !isRemove && ethIn > 0) { pool.cost += ethIn; pool.events.push({ ts: tx.ts, kind: 'add', eth: ethIn, hash: tx.hash }) }
    })
  }

  // 4) merge live open positions (exact current value + unclaimed)
  for (const [token, list] of posByToken) {
    const pool = ensure(token)
    pool.positions = list
    for (const p of list) {
      const cv = wei(p.amount0) + currency1ToEth(p.amount1, p.sqrtPriceX96) / 1e18
      const uc = wei(p.fee0) + currency1ToEth(p.fee1, p.sqrtPriceX96) / 1e18
      pool.currentValue += cv
      pool.unclaimed += uc
      if (p.liquidity > 0n) pool.open++
    }
  }

  // 5) totals
  const t = { pnl: 0, realized: 0, unrealized: 0, unclaimed: 0, collectedFees: 0, currentValue: 0, deposited: 0, withdrawn: 0, open: 0, closed: 0 }
  let approx = false
  const out: PoolPnL[] = []
  for (const pool of pools.values()) {
    pool.pnl = pool.withdrawn + pool.collectedFees + pool.currentValue + pool.unclaimed - pool.cost
    t.pnl += pool.pnl
    t.currentValue += pool.currentValue
    t.unclaimed += pool.unclaimed
    t.collectedFees += pool.collectedFees
    t.deposited += pool.cost
    t.withdrawn += pool.withdrawn
    t.open += pool.open
    if (pool.open === 0) t.closed++
    if (!pool.hasPrice) approx = true
    out.push(pool)
  }
  // Realized = cash actually returned net of cost on closed pools + fees/withdrawals
  // booked on open pools; Unrealized is the balance so realized + unrealized == pnl.
  t.realized = out.reduce((s, p) => s + (p.open > 0 ? (p.withdrawn + p.collectedFees - Math.min(p.cost, p.withdrawn + p.collectedFees)) : p.pnl), 0)
  t.unrealized = t.pnl - t.realized
  out.sort((a, b) => b.pnl - a.pnl)
  return { address: owner, pools: out, totals: t, calendar, approx }
}
