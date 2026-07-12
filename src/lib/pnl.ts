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
import { CHAIN, POOL_MANAGER, lc, WETH, BONDING_CURVE, CURVE_SEL, ERC20_SEL } from './config'
import { Position, currency1ToEth } from './positions'
import { batchCall, batchRpc, rpc, hexToBig } from './rpc'

const PM = lc(POOL_MANAGER)
const WETHlc = lc(WETH)
const isEthSide = (t: string) => t === WETHlc || /^0x0+$/.test(t)
const E18 = 10n ** 18n
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const topicAddr = (a: string) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0')

// eth_getLogs over a block range, auto-splitting if the node rejects the span/size.
async function getLogsSplit(topics: (string | null)[], from: number, to: number, depth = 0): Promise<any[]> {
  try {
    return await rpc('eth_getLogs', [{ fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics }])
  } catch (e) {
    if (from >= to || depth > 24) return []
    const mid = Math.floor((from + to) / 2)
    const [a, b] = await Promise.all([getLogsSplit(topics, from, mid, depth + 1), getLogsSplit(topics, mid + 1, to, depth + 1)])
    return [...a, ...b]
  }
}

// Query the launchpad bonding curve for the ETH price of each token (wei per whole
// token). Tokens not on the curve return 0 → caller falls back to the V4 pool price.
export async function resolveCurvePrices(tokens: string[]): Promise<Map<string, bigint>> {
  const uniq = [...new Set(tokens.map(lc).filter((t) => t && !isEthSide(t)))]
  const out = new Map<string, bigint>()
  if (!uniq.length) return out
  const padAddr = (a: string) => a.replace(/^0x/, '').padStart(64, '0')
  const res = await batchCall(uniq.map((t) => ({ to: BONDING_CURVE, data: CURVE_SEL.currentPrice + padAddr(t) })))
  res.forEach((r, i) => { const v = hexToBig(r); if (v > 0n) out.set(uniq[i], v) })
  return out
}

// ---- resilient Blockscout fetch ----------------------------------------------
// This chain's indexer is slow and returns 500s intermittently, so retry hard.
async function bsRetry(path: string, tries = 6): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`${CHAIN.blockscoutApi}${path}`); if (r.ok) return await r.json() } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300 * (i + 1)))
  }
  return null
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

// Reconstruct LP history primarily from eth_getLogs (reliable on this chain, unlike
// the Blockscout indexer). Two log queries (ERC20 Transfers to/from the owner over
// the full chain) give every token flow + the exact set of LP tx hashes in ~1s.
// Per LP tx we then batch eth_getTransactionByHash (calldata to classify the action,
// native value in) and eth_getBlockByNumber (timestamps). Native ETH *out* (V4 pays
// native, which isn't logged and this node exposes no trace) is the one piece still
// read from Blockscout internal-txns — best-effort, and only for LP txs.
export async function fetchLpActivity(owner: string): Promise<LpActivity> {
  const ot = topicAddr(owner)
  const head = Number(hexToBig(await rpc('eth_blockNumber', []).catch(() => '0x0')))
  if (!head) return { lpTxs: [], transfersByTx: new Map(), internalsByTx: new Map(), complete: false }

  // 1) all ERC20 transfers involving the owner (reliable, full history)
  const [toLogs, fromLogs] = await Promise.all([
    getLogsSplit([TRANSFER_TOPIC, null, ot], 0, head),
    getLogsSplit([TRANSFER_TOPIC, ot, null], 0, head),
  ])
  const transfersByTx = new Map<string, Transfer[]>()
  const lpHashes = new Set<string>()
  const seenLog = new Set<string>()
  const tokens = new Set<string>()
  for (const l of [...toLogs, ...fromLogs]) {
    if (!l || !l.topics || l.topics.length < 3) continue
    const key = lc(l.transactionHash) + ':' + l.logIndex
    if (seenLog.has(key)) continue
    seenLog.add(key)
    const from = lc('0x' + l.topics[1].slice(26)), to = lc('0x' + l.topics[2].slice(26))
    const tr: Transfer = { token: lc(l.address), symbol: '', from, to, value: hexToBig(l.data) }
    const h = lc(l.transactionHash)
    if (!transfersByTx.has(h)) transfersByTx.set(h, [])
    transfersByTx.get(h)!.push(tr)
    if (from === PM || to === PM) { lpHashes.add(h); tokens.add(tr.token) } // LP: PoolManager is the counterparty
  }

  // 2) calldata + native-in + block for each candidate LP tx (batched, reliable)
  const hashes = [...lpHashes]
  const txRes = await batchRpc(hashes.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] })))
  const blocks = new Set<number>()
  const cand = hashes.map((h, i) => {
    const t = txRes[i]; if (!t) return null
    const block = Number(hexToBig(t.blockNumber))
    blocks.add(block)
    return { hash: h, value: hexToBig(t.value), input: (t.input || '').toLowerCase(), block, ts: 0 }
  }).filter(Boolean) as { hash: string; value: bigint; input: string; block: number; ts: number }[]

  const blkList = [...blocks]
  const blkRes = await batchRpc(blkList.map((b) => ({ method: 'eth_getBlockByNumber', params: ['0x' + b.toString(16), false] })))
  const tsByBlock = new Map<number, number>()
  blkList.forEach((b, i) => { if (blkRes[i]) tsByBlock.set(b, Number(hexToBig(blkRes[i].timestamp))) })

  // keep only true LP ops (modifyLiquidities selector present) — excludes swaps
  const lpTxs = cand.filter((t) => t.input.includes(SEL)).map((t) => ({ hash: t.hash, value: t.value, input: t.input, ts: tsByBlock.get(t.block) || 0 }))

  // 3) symbols for every pair token (batched eth_call) — so closed-only pools show names
  const tokList = [...tokens].filter((t) => !isEthSide(t))
  const symRes = await batchCall(tokList.map((t) => ({ to: t, data: ERC20_SEL.symbol })))
  const symByTok = new Map<string, string>()
  tokList.forEach((t, i) => { const s = decodeSymbol(symRes[i]); if (s) symByTok.set(t, s) })
  for (const trs of transfersByTx.values()) for (const tr of trs) if (!tr.symbol && symByTok.has(tr.token)) tr.symbol = symByTok.get(tr.token)!

  // 4) native ETH out (PoolManager → owner): only Blockscout has it. Best-effort, and
  //    only for txs that actually pay native out (DECREASE/BURN); pure deposits get
  //    their native side from tx.value already.
  const internalsByTx = new Map<string, any[]>()
  const needNative = lpTxs.filter((tx) => {
    const a = lpActionsForTx(tx.input)
    return a.some((x) => (x.action === ACT.DECREASE) || x.action === ACT.BURN)
  })
  let natFail = 0
  const CONC = 12
  for (let i = 0; i < needNative.length; i += CONC) {
    const chunk = needNative.slice(i, i + CONC)
    await Promise.all(chunk.map(async (tx) => {
      const r = await bsRetry(`/transactions/${tx.hash}/internal-transactions`)
      if (r == null) natFail++
      internalsByTx.set(lc(tx.hash), (r?.items || []).filter((x: any) => lc(x.from?.hash) === PM || lc(x.to?.hash) === PM))
    }))
  }
  return { lpTxs, transfersByTx, internalsByTx, complete: natFail === 0 }
}

// Decode an ERC20 symbol() return (handles both string and bytes32 encodings).
function decodeSymbol(hex: string | null): string {
  if (!hex || hex === '0x') return ''
  try {
    const b = hex.slice(2)
    const toStr = (h: string) => (h.match(/.{2}/g) || []).map((x) => parseInt(x, 16)).filter((c) => c > 0).map((c) => String.fromCharCode(c)).join('')
    if (b.length === 64) { const s = toStr(b); return /^[\x20-\x7e]+$/.test(s) ? s : '' } // bytes32
    const off = parseInt(b.slice(0, 64), 16) * 2
    const len = parseInt(b.slice(off, off + 64), 16)
    if (!len || len > 200) return ''
    const s = toStr(b.slice(off + 64, off + 64 + len * 2))
    return /^[\x20-\x7e]+$/.test(s) ? s : ''
  } catch { return '' }
}

export async function loadWalletPnL(owner: string, positions: Position[]): Promise<WalletPnL> {
  const act = await fetchLpActivity(owner)
  const toks = [...positions.flatMap((p) => [p.token0.address, p.token1.address]), ...[...act.transfersByTx.values()].flat().map((t) => t.token)]
  const curve = await resolveCurvePrices(toks)
  return computeWalletPnL(owner, positions, act, curve)
}

export function computeWalletPnL(owner: string, positions: Position[], act: LpActivity, curvePrice: Map<string, bigint> = new Map()): WalletPnL {
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
  // Value a raw token amount in ETH. Preference: bonding-curve price (accurate for
  // launchpad tokens still on the curve) → V4 pool price → unpriced.
  const tokenToEth = (token: string, amt: bigint): { eth: number; priced: boolean } => {
    if (isEthSide(token)) return { eth: wei(amt), priced: true }
    const cp = curvePrice.get(token) // wei ETH per whole token (18-dec launchpad tokens)
    if (cp) return { eth: Number((amt * cp) / E18) / 1e18, priced: true }
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

  // 4) merge live open positions (exact current value + unclaimed). The ETH side is
  //    1:1; the pair side is valued via curve price (fallback: the pool's own sqrtPrice).
  for (const [token, list] of posByToken) {
    const pool = ensure(token)
    pool.positions = list
    for (const p of list) {
      const t0Eth = isEthSide(lc(p.token0.address))
      const ethAmt = t0Eth ? p.amount0 : p.amount1
      const ethFee = t0Eth ? p.fee0 : p.fee1
      const pairAmt = t0Eth ? p.amount1 : p.amount0
      const pairFee = t0Eth ? p.fee1 : p.fee0
      // if pair token isn't on the curve, fall back to the pool's sqrtPrice valuation
      const valPair = (amt: bigint): number => {
        const cp = curvePrice.get(token)
        if (cp) return Number((amt * cp) / E18) / 1e18
        return t0Eth ? currency1ToEth(amt, p.sqrtPriceX96) / 1e18 : (p.sqrtPriceX96 ? (Number(amt) * Number(p.sqrtPriceX96) * Number(p.sqrtPriceX96)) / Number(1n << 192n) / 1e18 : 0)
      }
      pool.currentValue += wei(ethAmt) + valPair(pairAmt)
      pool.unclaimed += wei(ethFee) + valPair(pairFee)
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
