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
// This chain's indexer is slow and returns 500s intermittently, so retry hard.
async function bsRetry(path: string, tries = 6): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`${CHAIN.blockscoutApi}${path}`); if (r.ok) return await r.json() } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300 * (i + 1)))
  }
  return null
}
// Paginate, reporting whether we saw the full history. `complete` is false if a
// page failed after all retries or we hit the cap with more pages remaining — so
// callers never mistake a truncated fetch for "no more data".
async function bsPagedC(path: string, cap = 40): Promise<{ items: any[]; complete: boolean }> {
  const items: any[] = []
  let np: any = null
  let p = 0
  for (; p < cap; p++) {
    const sep = path.includes('?') ? '&' : '?'
    const res = await bsRetry(np ? `${path}${sep}${new URLSearchParams(np)}` : path)
    if (!res) return { items, complete: false } // a page genuinely failed → truncated
    items.push(...(res.items || []))
    np = res.next_page_params
    if (!np) return { items, complete: true }   // natural end of history
  }
  return { items, complete: !np }               // hit cap: complete only if no more pages
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
  approx: boolean         // any pool priced ETH-side only
  historyComplete: boolean // false → indexer truncated history; realized/collected may be understated
}

const wei = (n: bigint) => Number(n) / 1e18

interface Transfer { token: string; symbol: string; from: string; to: string; value: bigint }
export interface LpActivity {
  lpTxs: { hash: string; value: bigint; input: string; ts: number }[]
  transfersByTx: Map<string, Transfer[]>
  internalsByTx: Map<string, any[]>
  complete: boolean   // false if the indexer truncated the tx list or any per-tx fetch failed
}

// Fetch every Blockscout record PnL needs. Independent of on-chain position reads,
// so the caller can run this in parallel with loadPositions() — the two slow,
// unrelated phases (RPC reads ∥ indexer history) then overlap instead of stacking.
export async function fetchLpActivity(owner: string): Promise<LpActivity> {
  // 1) find LP txs by scanning the owner's tx calldata for the modifyLiquidities
  //    selector. This pagination is cursor-based (sequential) and unavoidable.
  const { items: txItems, complete: txComplete } = await bsPagedC(`/addresses/${owner}/transactions?filter=from`, 40)
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

  // 2) this chain's indexer is ~4s/request, so paging the full address token-transfer
  //    history (many sequential pages) dominates. We only need transfers for the LP
  //    txs, so fetch native (internal-txns) + ERC20 (token-transfers) PER LP TX and
  //    fan out with bounded concurrency — turning N sequential pages into ~⌈2N/12⌉
  //    parallel rounds.
  const transfersByTx = new Map<string, Transfer[]>()
  const internalsByTx = new Map<string, any[]>()
  let perTxFail = 0
  const CONC = 12
  for (let i = 0; i < lpTxs.length; i += CONC) {
    const chunk = lpTxs.slice(i, i + CONC)
    await Promise.all(chunk.map(async (tx) => {
      const [intl, tt] = await Promise.all([
        bsRetry(`/transactions/${tx.hash}/internal-transactions`),
        bsRetry(`/transactions/${tx.hash}/token-transfers`),
      ])
      if (intl == null || tt == null) perTxFail++ // a leg failed after all retries → this tx's flow is incomplete
      internalsByTx.set(lc(tx.hash), intl?.items || [])
      const trs: Transfer[] = []
      for (const x of (tt?.items || [])) {
        trs.push({
          token: lc(x.token?.address || x.token?.address_hash || ''),
          symbol: x.token?.symbol || '',
          from: lc(x.from?.hash || ''), to: lc(x.to?.hash || ''),
          value: BigInt(x.total?.value || x.value || '0'),
        })
      }
      transfersByTx.set(lc(tx.hash), trs)
    }))
  }
  return { lpTxs, transfersByTx, internalsByTx, complete: txComplete && perTxFail === 0 }
}

export async function loadWalletPnL(owner: string, positions: Position[]): Promise<WalletPnL> {
  return computeWalletPnL(owner, positions, await fetchLpActivity(owner))
}

export function computeWalletPnL(owner: string, positions: Position[], act: LpActivity): WalletPnL {
  const ownerLc = lc(owner)
  const { lpTxs, transfersByTx, internalsByTx } = act
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

  // classify + aggregate per pool
  const pools = new Map<string, PoolPnL>()
  const ensure = (token: string): PoolPnL => {
    if (!pools.has(token)) pools.set(token, {
      token, symbol: symByToken.get(token) || '', cost: 0, withdrawn: 0, collectedFees: 0,
      currentValue: 0, unclaimed: 0, pnl: 0, open: 0, positions: [], hasPrice: true, events: [],
    })
    return pools.get(token)!
  }
  const calendar = new Map<string, number>()

  {
    for (const tx of lpTxs) {
      const acts = lpActionsForTx(tx.input)
      if (!acts.length) continue
      const isCollect = acts.some((a) => a.action === ACT.DECREASE && a.liquidity === 0n)
      const isRemove = acts.some((a) => (a.action === ACT.DECREASE && a.liquidity > 0n) || a.action === ACT.BURN)
      const isAdd = acts.some((a) => a.action === ACT.MINT || a.action === ACT.INCREASE)

      // native ETH vs PoolManager
      const it = internalsByTx.get(lc(tx.hash)) || []
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
      if (!pairToken) { pool.symbol = 'Unknown pair'; pool.hasPrice = false }
      else if (!pool.symbol) pool.symbol = symByToken.get(pairToken) || pairToken.slice(0, 6)
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
    }
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
  return { address: owner, pools: out, totals: t, calendar, approx, historyComplete: act.complete }
}
