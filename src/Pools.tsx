import { CHAIN } from './lib/config'
import { WalletPnL, PoolPnL } from './lib/pnl'
import { fmtEth, signEth } from './App'

export function Pools({ data }: { data: WalletPnL }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {data.pools.map((p) => <Row key={p.token || 'eth'} p={p} />)}
      {data.approx && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
          * Pools without a live position are priced ETH-side only; PnL there is approximate.
        </div>
      )}
    </div>
  )
}

function Row({ p }: { p: PoolPnL }) {
  const openBadge = p.open > 0
  return (
    <div style={{ padding: '14px 16px', borderRadius: 13, border: '1px solid var(--border)', background: 'var(--panel)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>ETH / {p.symbol || 'token'}</span>
          {openBadge
            ? <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--green)', background: 'rgba(52,211,153,.12)', padding: '2px 9px', borderRadius: 20 }}>{p.open} open</span>
            : <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', background: 'var(--border-soft)', padding: '2px 9px', borderRadius: 20 }}>closed</span>}
          {!p.hasPrice && <span title="Priced ETH-side only" style={{ fontSize: 11, color: 'var(--amber)' }}>~approx</span>}
        </div>
        {p.token && <a href={`${CHAIN.explorer}/token/${p.token}`} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>{p.token.slice(0, 6)}…</a>}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 11, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 18, fontSize: 12, color: 'var(--muted-2)', flexWrap: 'wrap' }}>
          {p.currentValue > 1e-9 && <Field k="Value" v={fmtEth(p.currentValue)} />}
          {p.cost > 1e-9 && <Field k="Deposited" v={fmtEth(p.cost)} />}
          {p.withdrawn > 1e-9 && <Field k="Withdrawn" v={fmtEth(p.withdrawn)} />}
          {p.unclaimed > 1e-9 && <Field k="Unclaimed" v={fmtEth(p.unclaimed)} accent />}
          {p.collectedFees > 1e-9 && <Field k="Collected" v={fmtEth(p.collectedFees)} accent />}
        </div>
        <div className={p.pnl >= 0 ? 'pos' : 'neg'} style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: 18 }}>
          {signEth(p.pnl)}<span style={{ fontSize: 11, opacity: 0.6, marginLeft: 3 }}>ETH</span>
        </div>
      </div>
    </div>
  )
}

function Field({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return <span>{k} <b className="mono" style={{ color: accent ? 'var(--accent)' : 'var(--text)' }}>{v}</b></span>
}
