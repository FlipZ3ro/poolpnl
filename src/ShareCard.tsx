import { useRef, useState } from 'react'
import { toPng } from 'html-to-image'
import { WalletPnL } from './lib/pnl'
import { fmtEth, signEth } from './App'

const THEMES = [
  { name: 'Aqua', bg: 'linear-gradient(145deg,#0b2a2e,#08131a 55%,#0a1f2e)', glow: '#5eead4' },
  { name: 'Sunset', bg: 'linear-gradient(145deg,#2e1065,#1a0b2e 55%,#3b0764)', glow: '#c084fc' },
  { name: 'Ember', bg: 'linear-gradient(145deg,#3b0d0d,#1a0b0b 55%,#451a03)', glow: '#fb923c' },
  { name: 'Mono', bg: 'linear-gradient(145deg,#1a1d24,#0b0d12 55%,#14171d)', glow: '#94a3b8' },
]

const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4)

// Turn an ETH PnL into a playful real-world comparison.
function funLine(pnl: number): string {
  const a = Math.abs(pnl)
  const win = pnl >= 0
  if (a < 0.001) return win ? 'Basically flat — degen zen mode 🧘' : 'A rounding error. You’ll live.'
  if (a < 0.02) return win ? `≈ ${Math.max(1, Math.round(a / 0.004))} coffees on-chain ☕` : 'Tuition for the LP academy 📚'
  if (a < 0.1) return win ? `≈ a nice dinner, paid in fees 🍣` : 'Down bad but still farming 🌾'
  if (a < 0.5) return win ? `≈ ${(a).toFixed(2)} ETH — real yield, real chad 💪` : 'Impermanent loss said hi 👋'
  if (a < 2) return win ? 'LP wizardry detected 🧙' : 'Big range, bigger lessons 📉'
  return win ? 'Absolute unit. Whale mode 🐋' : 'That’s a story for the group chat 🫠'
}

export function ShareCard({ data, onClose }: { data: WalletPnL; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [theme, setTheme] = useState(0)
  const [busy, setBusy] = useState('')
  const t = data.totals
  const th = THEMES[theme]

  const render = async () => {
    if (!ref.current) return null
    return toPng(ref.current, { pixelRatio: 2, cacheBust: true, backgroundColor: '#08131a' })
  }
  const save = async () => {
    setBusy('save')
    try {
      const url = await render(); if (!url) return
      const a = document.createElement('a'); a.href = url; a.download = `poolpnl-${short(data.address)}.png`; a.click()
    } finally { setBusy('') }
  }
  const copy = async () => {
    setBusy('copy')
    try {
      const url = await render(); if (!url) return
      const blob = await (await fetch(url)).blob()
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      setBusy('copied')
      setTimeout(() => setBusy(''), 1200)
    } catch { setBusy('') }
  }

  const win = t.pnl >= 0

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,12,.8)', backdropFilter: 'blur(6px)', zIndex: 50, display: 'grid', placeItems: 'center', padding: 20, overflow: 'auto' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center' }}>
        {/* the card */}
        <div ref={ref} style={{ width: 520, borderRadius: 22, padding: 34, background: th.bg, position: 'relative', overflow: 'hidden', border: '1px solid rgba(255,255,255,.08)', fontFamily: 'var(--font-sans)' }}>
          <div style={{ position: 'absolute', top: -80, right: -60, width: 260, height: 260, borderRadius: '50%', background: th.glow, opacity: 0.16, filter: 'blur(50px)' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <div style={{ width: 26, height: 26, borderRadius: 7, background: `linear-gradient(135deg,${th.glow},#3b82f6)`, display: 'grid', placeItems: 'center', fontWeight: 800, color: '#08131a', fontSize: 14 }}>P</div>
              <span style={{ fontWeight: 800, fontSize: 15, color: '#fff' }}>PoolPnL</span>
            </div>
            <span className="mono" style={{ fontSize: 12, color: 'rgba(255,255,255,.55)' }}>{short(data.address)}</span>
          </div>

          <div style={{ marginTop: 30, position: 'relative' }}>
            <div style={{ fontSize: 12, letterSpacing: 1.5, textTransform: 'uppercase', color: 'rgba(255,255,255,.5)', fontWeight: 600 }}>Uniswap V4 Total PnL</div>
            <div style={{ fontSize: 58, fontWeight: 800, letterSpacing: -2, marginTop: 6, fontFamily: 'var(--font-mono)', color: win ? '#4ade80' : '#f87171', lineHeight: 1 }}>
              {signEth(t.pnl)}
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'rgba(255,255,255,.75)', marginTop: 2 }}>ETH</div>
            <div style={{ marginTop: 12, fontSize: 14, color: 'rgba(255,255,255,.7)', fontWeight: 500 }}>{funLine(t.pnl)}</div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 26, position: 'relative' }}>
            <Cell label="Realized" v={signEth(t.realized)} pos={t.realized >= 0} />
            <Cell label="Unrealized" v={signEth(t.unrealized)} pos={t.unrealized >= 0} />
            <Cell label="Unclaimed fees" v={fmtEth(t.unclaimed)} glow={th.glow} />
            <Cell label="Collected fees" v={fmtEth(t.collectedFees)} glow={th.glow} />
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24, fontSize: 12, color: 'rgba(255,255,255,.45)', position: 'relative' }}>
            <span>{t.open} open · {t.closed} closed positions</span>
            <span>Robinhood Chain · Uniswap V4</span>
          </div>
        </div>

        {/* controls */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
          {THEMES.map((x, i) => (
            <button key={x.name} onClick={() => setTheme(i)} style={{
              width: 30, height: 30, borderRadius: 8, background: x.bg, border: `2px solid ${i === theme ? x.glow : 'transparent'}`,
            }} title={x.name} />
          ))}
          <div style={{ width: 1, height: 24, background: 'var(--border)', margin: '0 4px' }} />
          <button onClick={save} disabled={!!busy} style={btn(true)}>{busy === 'save' ? 'Rendering…' : '💾 Save PNG'}</button>
          <button onClick={copy} disabled={!!busy} style={btn(false)}>{busy === 'copied' ? '✓ Copied' : busy === 'copy' ? '…' : '📋 Copy'}</button>
          <button onClick={onClose} style={btn(false)}>Close</button>
        </div>
      </div>
    </div>
  )
}

function Cell({ label, v, pos, glow }: { label: string; v: string; pos?: boolean; glow?: string }) {
  return (
    <div style={{ padding: '12px 14px', borderRadius: 12, background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.07)' }}>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,.5)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, marginTop: 4, fontFamily: 'var(--font-mono)', color: glow ? glow : pos ? '#4ade80' : '#f87171' }}>{v}<span style={{ fontSize: 11, opacity: 0.6, marginLeft: 3 }}>ETH</span></div>
    </div>
  )
}

const btn = (primary: boolean) => ({
  padding: '9px 16px', borderRadius: 10, fontWeight: 700, fontSize: 13,
  background: primary ? 'linear-gradient(135deg,#5eead4,#3b82f6)' : 'var(--panel)',
  color: primary ? '#08131a' : 'var(--text)', border: primary ? 'none' : '1px solid var(--border)',
})
