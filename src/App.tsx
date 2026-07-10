import { useState, useCallback } from 'react'
import { CHAIN, isAddr } from './lib/config'
import { loadPositions } from './lib/positions'
import { fetchLpActivity, computeWalletPnL, WalletPnL } from './lib/pnl'
import { ShareCard } from './ShareCard'
import { Calendar } from './Calendar'
import { Pools } from './Pools'

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
  const [tab, setTab] = useState<'pools' | 'calendar'>('pools')
  const [showCard, setShowCard] = useState(false)

  const run = useCallback(async (address: string) => {
    const a = address.trim()
    if (!isAddr(a)) { setStatus('Enter a valid 0x address'); return }
    setLoading(true); setData(null); setShowCard(false)
    try {
      // Positions (RPC reads) and history (Blockscout) are independent — fetch both
      // at once so the two slow phases overlap instead of running back-to-back.
      setStatus('Scanning positions + trade history…')
      const [positions, activity] = await Promise.all([
        loadPositions(a, (s, t, f) => setStatus(`Reading positions ${s}/${t} · ${f} found`)),
        fetchLpActivity(a),
      ])
      if (!positions.length && !activity.lpTxs.length) { setStatus('No Uniswap V4 positions or LP activity found for this address.'); setLoading(false); return }
      setStatus('Reconstructing PnL…')
      const pnl = computeWalletPnL(a, positions, activity)
      setData(pnl); setStatus('')
    } catch (e: any) {
      setStatus('Error: ' + (e?.message || e))
    } finally { setLoading(false) }
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

          {/* hero PnL */}
          <div style={{ padding: '22px 24px', borderRadius: 16, border: '1px solid var(--border)', background: 'linear-gradient(160deg,var(--panel),var(--panel-2))', marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>Total PnL</div>
            <div className={t.pnl >= 0 ? 'pos' : 'neg'} style={{ fontSize: 40, fontWeight: 800, letterSpacing: -1, marginTop: 4, fontFamily: 'var(--font-mono)' }}>
              {signEth(t.pnl)} <span style={{ fontSize: 20, opacity: 0.7 }}>ETH</span>
            </div>
            <div style={{ display: 'flex', gap: 20, marginTop: 12, flexWrap: 'wrap', fontSize: 13 }}>
              <span style={{ color: 'var(--muted-2)' }}>{t.open} open · {t.closed} closed</span>
              <span style={{ color: 'var(--muted-2)' }}>Deposited <b className="mono">{fmtEth(t.deposited)}</b></span>
              <span style={{ color: 'var(--muted-2)' }}>Current value <b className="mono">{fmtEth(t.currentValue)}</b></span>
            </div>
          </div>

          {/* stat grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginBottom: 22 }}>
            <Stat label="Realized" v={t.realized} sign />
            <Stat label="Unrealized" v={t.unrealized} sign />
            <Stat label="Unclaimed fees" v={t.unclaimed} accent />
            <Stat label="Collected fees" v={t.collectedFees} accent />
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

          {tab === 'pools' ? <Pools data={data} /> : <Calendar calendar={data.calendar} />}
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

function Stat({ label, v, sign, accent }: { label: string; v: number; sign?: boolean; accent?: boolean }) {
  const cls = accent ? '' : v >= 0 ? 'pos' : 'neg'
  return (
    <div style={{ padding: '15px 17px', borderRadius: 13, border: '1px solid var(--border)', background: 'var(--panel)' }}>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 600 }}>{label}</div>
      <div className={cls} style={{ fontSize: 21, fontWeight: 800, marginTop: 5, fontFamily: 'var(--font-mono)', color: accent ? 'var(--accent)' : undefined }}>
        {sign ? signEth(v) : fmtEth(v)}<span style={{ fontSize: 12, opacity: 0.6, marginLeft: 3 }}>ETH</span>
      </div>
    </div>
  )
}
