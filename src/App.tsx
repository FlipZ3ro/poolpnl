import { useState, useCallback } from 'react'
import { CHAIN, isAddr } from './lib/config'
import { loadPositions } from './lib/positions'
import { fetchLpActivity, computeWalletPnL, resolveCurvePrices, WalletPnL, LpActivity } from './lib/pnl'
import { ShareCard } from './ShareCard'
import { Calendar } from './Calendar'
import { Pools } from './Pools'

const EMPTY_ACTIVITY: LpActivity = { lpTxs: [], transfersByTx: new Map(), nativeByTx: new Map(), complete: true }

const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4)
export const fmtEth = (n: number, dp = 4) => {
  const s = Math.abs(n) < 1e-9 ? '0' : n.toFixed(Math.abs(n) < 1 ? dp : Math.max(2, dp - 2))
  return s
}
export const signEth = (n: number) => (n >= 0 ? '+' : '−') + fmtEth(Math.abs(n))

export default function App() {
  const [addr, setAddr] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<WalletPnL | null>(null)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [tab, setTab] = useState<'pools' | 'calendar'>('pools')
  const [showCard, setShowCard] = useState(false)

  const run = useCallback(async (address: string) => {
    const a = address.trim()
    if (!isAddr(a)) { setStatus('Enter a valid 0x address'); return }
    setLoading(true); setData(null); setShowCard(false); setLoadingHistory(false)
    try {
      // Kick off the slow history fetch (indexer) in the background right away…
      const activityP = fetchLpActivity(a)
      // …but read positions first (fast, batched) and render them immediately so the
      // user sees current value + unclaimed fees in ~2s instead of waiting on history.
      setStatus('Reading your positions…')
      const positions = await loadPositions(a, (s, t, f) => setStatus(`Reading positions ${s}/${t} · ${f} found`))

      if (positions.length) {
        const curve0 = await resolveCurvePrices(positions.flatMap((p) => [p.token0.address, p.token1.address]))
        setData(computeWalletPnL(a, positions, EMPTY_ACTIVITY, curve0)) // positions-only view
        setLoadingHistory(true); setStatus('')
      } else {
        setStatus('Loading trade history…')
      }

      // Bring in trade history (realized / collected / calendar) when it arrives.
      const activity = await activityP
      if (!positions.length && !activity.lpTxs.length) { setStatus('No Uniswap V4 positions or LP activity found for this address.'); return }
      const toks = [...positions.flatMap((p) => [p.token0.address, p.token1.address]), ...[...activity.transfersByTx.values()].flat().map((t) => t.token)]
      const curve = await resolveCurvePrices(toks)
      setData(computeWalletPnL(a, positions, activity, curve))
      setStatus('')
    } catch (e: any) {
      setStatus('Error: ' + (e?.message || e))
    } finally { setLoading(false); setLoadingHistory(false) }
  }, [])

  const t = data?.totals

  return (
    <div style={{ position: 'relative', zIndex: 1, maxWidth: 940, margin: '0 auto', padding: '32px 20px 80px' }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: 'linear-gradient(135deg,#5eead4,#3b82f6)', display: 'grid', placeItems: 'center', fontWeight: 800, color: '#08131a' }}>P</div>
        <div>
          <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: -0.4 }}>PoolPnL</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Uniswap V4 · {CHAIN.name} · read-only PnL, ETH-native</div>
        </div>
      </div>

      {/* search */}
      <div style={{ display: 'flex', gap: 8, marginTop: 22 }}>
        <input
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run(addr)}
          placeholder="Paste any wallet address (0x…)"
          spellCheck={false}
          style={{
            flex: 1, padding: '13px 15px', borderRadius: 11, border: '1px solid var(--border)',
            background: 'var(--panel-2)', fontSize: 14, outline: 'none', fontFamily: 'var(--font-mono)',
          }}
        />
        <button
          onClick={() => run(addr)} disabled={loading}
          style={{
            padding: '0 22px', borderRadius: 11, fontWeight: 700, fontSize: 14,
            background: loading ? 'var(--border)' : 'linear-gradient(135deg,#5eead4,#3b82f6)',
            color: loading ? 'var(--muted)' : '#08131a', opacity: loading ? 0.7 : 1,
          }}
        >{loading ? '…' : 'Scan'}</button>
      </div>

      {status && (
        <div style={{ marginTop: 14, fontSize: 13, color: loading ? 'var(--accent)' : 'var(--muted-2)', animation: loading ? 'pulse 1.4s infinite' : 'none' }}>{status}</div>
      )}

      {data && t && (
        <div style={{ animation: 'fadeIn .3s ease' }}>
          {/* address bar + share */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 26, marginBottom: 14 }}>
            <a href={`${CHAIN.explorer}/address/${data.address}`} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 13, color: 'var(--muted-2)' }}>{short(data.address)}</a>
            <button onClick={() => setShowCard(true)} style={{ padding: '8px 15px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--panel)', fontWeight: 600, fontSize: 13 }}>📸 Share PnL card</button>
          </div>

          {loadingHistory && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 15px', borderRadius: 11, border: '1px solid rgba(94,234,212,.3)', background: 'var(--accent-dim)', marginBottom: 14 }}>
              <span style={{ animation: 'pulse 1.2s infinite' }}>⏳</span>
              <span style={{ fontSize: 13, color: 'var(--accent)' }}>Positions &amp; unclaimed fees are ready — reconstructing <b>realized PnL, collected fees &amp; calendar</b> from trade history…</span>
            </div>
          )}

          {!loadingHistory && !data.historyComplete && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '11px 15px', borderRadius: 11, border: '1px solid rgba(245,158,11,.35)', background: 'rgba(245,158,11,.08)', marginBottom: 14 }}>
              <span style={{ fontSize: 13, color: 'var(--amber)' }}>
                ⚠️ Trade history was truncated by the chain indexer — <b>deposited / realized / collected may be understated</b>. Current value &amp; unclaimed fees are exact.
              </span>
              <button onClick={() => run(data.address)} disabled={loading} style={{ padding: '7px 14px', borderRadius: 8, fontWeight: 700, fontSize: 12.5, background: 'var(--amber)', color: '#1a1206', whiteSpace: 'nowrap' }}>↻ Retry history</button>
            </div>
          )}

          {/* hero PnL */}
          <div style={{ padding: '22px 24px', borderRadius: 16, border: '1px solid var(--border)', background: 'linear-gradient(160deg,var(--panel),var(--panel-2))', marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>{loadingHistory ? 'Open value + unclaimed' : 'Total PnL'}</div>
            <div className={t.pnl >= 0 ? 'pos' : 'neg'} style={{ fontSize: 40, fontWeight: 800, letterSpacing: -1, marginTop: 4, fontFamily: 'var(--font-mono)' }}>
              {signEth(t.pnl)} <span style={{ fontSize: 20, opacity: 0.7 }}>ETH</span>
            </div>
            <div style={{ display: 'flex', gap: 20, marginTop: 12, flexWrap: 'wrap', fontSize: 13 }}>
              <span style={{ color: 'var(--muted-2)' }}>{t.open} open · {loadingHistory ? '…' : t.closed} closed</span>
              <span style={{ color: 'var(--muted-2)' }}>Deposited <b className="mono">{loadingHistory ? '…' : fmtEth(t.deposited)}</b></span>
              <span style={{ color: 'var(--muted-2)' }}>Current value <b className="mono">{fmtEth(t.currentValue)}</b></span>
            </div>
          </div>

          {/* stat grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginBottom: 22 }}>
            <Stat label="Realized" v={t.realized} sign loading={loadingHistory} />
            <Stat label="Unrealized" v={t.unrealized} sign loading={loadingHistory} />
            <Stat label="Unclaimed fees" v={t.unclaimed} accent />
            <Stat label="Collected fees" v={t.collectedFees} accent loading={loadingHistory} />
          </div>

          {/* tabs */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {(['pools', 'calendar'] as const).map((x) => (
              <button key={x} onClick={() => setTab(x)} style={{
                padding: '7px 15px', borderRadius: 9, fontWeight: 600, fontSize: 13, textTransform: 'capitalize',
                background: tab === x ? 'var(--accent-dim)' : 'transparent', color: tab === x ? 'var(--accent)' : 'var(--muted)',
                border: `1px solid ${tab === x ? 'transparent' : 'var(--border-soft)'}`,
              }}>{x === 'pools' ? `Pools (${data.pools.length})` : 'Calendar'}</button>
            ))}
          </div>

          {tab === 'pools' ? <Pools data={data} loadingHistory={loadingHistory} /> : <Calendar calendar={data.calendar} historyComplete={data.historyComplete} loadingHistory={loadingHistory} />}
        </div>
      )}

      {!data && !loading && !status && (
        <div style={{ marginTop: 60, textAlign: 'center', color: 'var(--muted)' }}>
          <div style={{ fontSize: 44, marginBottom: 10 }}>📊</div>
          <div style={{ fontSize: 15, color: 'var(--muted-2)' }}>Paste any wallet to see its Uniswap V4 PnL</div>
          <div style={{ fontSize: 13, marginTop: 6 }}>Realized · unrealized · unclaimed & collected fees — all in ETH. No wallet connect.</div>
        </div>
      )}

      {showCard && data && <ShareCard data={data} onClose={() => setShowCard(false)} />}
    </div>
  )
}

function Stat({ label, v, sign, accent, loading }: { label: string; v: number; sign?: boolean; accent?: boolean; loading?: boolean }) {
  const cls = accent ? '' : v >= 0 ? 'pos' : 'neg'
  return (
    <div style={{ padding: '15px 17px', borderRadius: 13, border: '1px solid var(--border)', background: 'var(--panel)' }}>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 600 }}>{label}</div>
      {loading ? (
        <div style={{ fontSize: 21, fontWeight: 800, marginTop: 5, fontFamily: 'var(--font-mono)', color: 'var(--muted)', animation: 'pulse 1.2s infinite' }}>···</div>
      ) : (
        <div className={cls} style={{ fontSize: 21, fontWeight: 800, marginTop: 5, fontFamily: 'var(--font-mono)', color: accent ? 'var(--accent)' : undefined }}>
          {sign ? signEth(v) : fmtEth(v)}<span style={{ fontSize: 12, opacity: 0.6, marginLeft: 3 }}>ETH</span>
        </div>
      )}
    </div>
  )
}
