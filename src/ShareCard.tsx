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
const CARD_W = 520
const REC_MS = 6000
const canRecord = typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream

const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4)
const tick = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 40)))
const loadImg = (src: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src })
function drawCover(ctx: CanvasRenderingContext2D, src: HTMLVideoElement | HTMLImageElement, W: number, H: number) {
  const sw = (src as HTMLVideoElement).videoWidth || (src as HTMLImageElement).naturalWidth || W
  const sh = (src as HTMLVideoElement).videoHeight || (src as HTMLImageElement).naturalHeight || H
  const s = Math.max(W / sw, H / sh), dw = sw * s, dh = sh * s
  ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh)
}

function funLine(pnl: number): string {
  const a = Math.abs(pnl), win = pnl >= 0
  if (a < 0.001) return win ? 'Basically flat — degen zen mode 🧘' : 'A rounding error. You’ll live.'
  if (a < 0.02) return win ? `≈ ${Math.max(1, Math.round(a / 0.004))} coffees on-chain ☕` : 'Tuition for the LP academy 📚'
  if (a < 0.1) return win ? `≈ a nice dinner, paid in fees 🍣` : 'Down bad but still farming 🌾'
  if (a < 0.5) return win ? `≈ ${(a).toFixed(2)} ETH — real yield, real chad 💪` : 'Impermanent loss said hi 👋'
  if (a < 2) return win ? 'LP wizardry detected 🧙' : 'Big range, bigger lessons 📉'
  return win ? 'Absolute unit. Whale mode 🐋' : 'That’s a story for the group chat 🫠'
}

export function ShareCard({ data, onClose }: { data: WalletPnL; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const imgInput = useRef<HTMLInputElement>(null)
  const vidInput = useRef<HTMLInputElement>(null)
  const [theme, setTheme] = useState(0)
  const [busy, setBusy] = useState('')
  const [bgImage, setBgImage] = useState<string | null>(() => { try { return localStorage.getItem('poolpnl_bg') } catch { return null } })
  const [bgVideo, setBgVideo] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false) // hide bg media → render content on transparency
  const t = data.totals
  const th = THEMES[theme]
  const hasBg = !!(bgImage || bgVideo)
  const win = t.pnl >= 0

  const pickImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return
    if (f.size > 50 * 1024 * 1024) { setBusy('too big'); setTimeout(() => setBusy(''), 1500); return }
    const r = new FileReader()
    r.onload = () => { const url = r.result as string; setBgVideo(null); setBgImage(url); try { localStorage.setItem('poolpnl_bg', url) } catch { /* quota */ } }
    r.readAsDataURL(f)
  }
  const pickVideo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return
    if (f.size > 50 * 1024 * 1024) { setBusy('too big'); setTimeout(() => setBusy(''), 1500); return }
    setBgImage(null); setBgVideo(URL.createObjectURL(f)); try { localStorage.removeItem('poolpnl_bg') } catch { /* */ }
  }
  const clearBg = () => { setBgImage(null); setBgVideo(null); try { localStorage.removeItem('poolpnl_bg') } catch { /* */ } }

  // Render the card content on transparency (bg media hidden) for canvas compositing.
  const renderOverlay = async (): Promise<HTMLImageElement | null> => {
    if (!ref.current) return null
    setCapturing(true); await tick()
    let url: string | null = null
    try { url = await toPng(ref.current, { pixelRatio: 2, cacheBust: true }) } finally { setCapturing(false); await tick() }
    return url ? loadImg(url) : null
  }
  // A single PNG frame (handles gradient/image via html-to-image, video via canvas composite).
  const renderPng = async (): Promise<string | null> => {
    if (!ref.current) return null
    if (!bgVideo) return toPng(ref.current, { pixelRatio: 2, cacheBust: true, backgroundColor: bgImage ? undefined : '#08131a' })
    const overlay = await renderOverlay(); if (!overlay) return null
    const W = CARD_W * 2, H = ref.current.offsetHeight * 2
    const c = document.createElement('canvas'); c.width = W; c.height = H
    const ctx = c.getContext('2d')!
    roundClip(ctx, W, H, 44)
    if (videoRef.current) drawCover(ctx, videoRef.current, W, H)
    ctx.drawImage(overlay, 0, 0, W, H)
    return c.toDataURL('image/png')
  }

  const save = async () => {
    setBusy('save')
    try { const url = await renderPng(); if (!url) return; const a = document.createElement('a'); a.href = url; a.download = `poolpnl-${short(data.address)}.png`; a.click() }
    finally { setBusy('') }
  }
  const copy = async () => {
    setBusy('copy')
    try {
      const url = await renderPng(); if (!url) return
      const blob = await (await fetch(url)).blob()
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      setBusy('copied'); setTimeout(() => setBusy(''), 1200)
    } catch { setBusy('') }
  }

  // Record the card (with its video background) to a webm the user can share.
  const record = async () => {
    if (!bgVideo || !videoRef.current || !ref.current) return
    setBusy('rec')
    try {
      const overlay = await renderOverlay(); if (!overlay) { setBusy(''); return }
      const W = CARD_W * 2, H = ref.current.offsetHeight * 2
      const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H
      const ctx = canvas.getContext('2d')!
      const video = videoRef.current; video.currentTime = 0; try { await video.play() } catch { /* */ }
      const stream = canvas.captureStream(30)
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm'
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 })
      const chunks: BlobPart[] = []
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      const stopped = new Promise<void>((res) => { rec.onstop = () => res() })
      rec.start()
      const start = performance.now()
      const draw = () => {
        ctx.clearRect(0, 0, W, H)
        ctx.save(); roundClip(ctx, W, H, 44)
        drawCover(ctx, video, W, H)
        ctx.drawImage(overlay, 0, 0, W, H)
        ctx.restore()
        if (performance.now() - start < REC_MS) requestAnimationFrame(draw); else rec.stop()
      }
      draw()
      await stopped
      const blob = new Blob(chunks, { type: 'video/webm' })
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `poolpnl-${short(data.address)}.webm`; a.click()
    } finally { setBusy('') }
  }

  const cardBg = capturing ? 'transparent' : (hasBg ? '#08131a' : th.bg)

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,12,.8)', backdropFilter: 'blur(6px)', zIndex: 50, display: 'grid', placeItems: 'center', padding: 20, overflow: 'auto' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center' }}>
        {/* the card */}
        <div ref={ref} style={{ width: CARD_W, borderRadius: 22, padding: 34, background: cardBg, position: 'relative', overflow: 'hidden', border: '1px solid rgba(255,255,255,.08)', fontFamily: 'var(--font-sans)' }}>
          {/* background media */}
          {!capturing && bgVideo && <video ref={videoRef} src={bgVideo} autoPlay loop muted playsInline style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
          {!capturing && bgImage && <div style={{ position: 'absolute', inset: 0, backgroundImage: `url(${bgImage})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />}
          {hasBg && <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg,rgba(4,8,14,.35),rgba(4,8,14,.74))' }} />}
          {!hasBg && <div style={{ position: 'absolute', top: -80, right: -60, width: 260, height: 260, borderRadius: '50%', background: th.glow, opacity: 0.16, filter: 'blur(50px)' }} />}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <div style={{ width: 26, height: 26, borderRadius: 7, background: `linear-gradient(135deg,${th.glow},#3b82f6)`, display: 'grid', placeItems: 'center', fontWeight: 800, color: '#08131a', fontSize: 14 }}>P</div>
              <span style={{ fontWeight: 800, fontSize: 15, color: '#fff' }}>PoolPnL</span>
            </div>
            <span className="mono" style={{ fontSize: 12, color: 'rgba(255,255,255,.7)' }}>{short(data.address)}</span>
          </div>

          <div style={{ marginTop: 30, position: 'relative' }}>
            <div style={{ fontSize: 12, letterSpacing: 1.5, textTransform: 'uppercase', color: 'rgba(255,255,255,.6)', fontWeight: 600 }}>Uniswap V4 Total PnL</div>
            <div style={{ fontSize: 58, fontWeight: 800, letterSpacing: -2, marginTop: 6, fontFamily: 'var(--font-mono)', color: win ? '#4ade80' : '#f87171', lineHeight: 1, textShadow: hasBg ? '0 2px 18px rgba(0,0,0,.5)' : 'none' }}>
              {signEth(t.pnl)}
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'rgba(255,255,255,.85)', marginTop: 2 }}>ETH</div>
            <div style={{ marginTop: 12, fontSize: 14, color: 'rgba(255,255,255,.8)', fontWeight: 500 }}>{funLine(t.pnl)}</div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 26, position: 'relative' }}>
            <Cell label="Realized" v={signEth(t.realized)} pos={t.realized >= 0} glass={hasBg} />
            <Cell label="Unrealized" v={signEth(t.unrealized)} pos={t.unrealized >= 0} glass={hasBg} />
            <Cell label="Unclaimed fees" v={fmtEth(t.unclaimed)} glow={th.glow} glass={hasBg} />
            <Cell label="Collected fees" v={fmtEth(t.collectedFees)} glow={th.glow} glass={hasBg} />
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24, fontSize: 12, color: 'rgba(255,255,255,.6)', position: 'relative' }}>
            <span>{t.open} open · {t.closed} closed positions</span>
            <span>Robinhood Chain · Uniswap V4</span>
          </div>
        </div>

        {/* controls */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center', maxWidth: 560 }}>
          {THEMES.map((x, i) => (
            <button key={x.name} onClick={() => { setTheme(i); }} style={{
              width: 30, height: 30, borderRadius: 8, background: x.bg, border: `2px solid ${i === theme && !hasBg ? x.glow : 'transparent'}`, opacity: hasBg ? 0.5 : 1,
            }} title={x.name} />
          ))}
          <button onClick={() => imgInput.current?.click()} style={chip(!!bgImage)} title="Upload background image">🖼</button>
          <button onClick={() => vidInput.current?.click()} style={chip(!!bgVideo)} title="Upload background video">🎬</button>
          {hasBg && <button onClick={clearBg} style={chip(false)} title="Remove custom background">✕</button>}
          <input ref={imgInput} type="file" accept="image/*" onChange={pickImage} style={{ display: 'none' }} />
          <input ref={vidInput} type="file" accept="video/*" onChange={pickVideo} style={{ display: 'none' }} />
          <div style={{ width: 1, height: 24, background: 'var(--border)', margin: '0 2px' }} />
          <button onClick={save} disabled={!!busy} style={btn(true)}>{busy === 'save' ? 'Rendering…' : busy === 'too big' ? 'Max 50MB' : '💾 PNG'}</button>
          <button onClick={copy} disabled={!!busy} style={btn(false)}>{busy === 'copied' ? '✓ Copied' : busy === 'copy' ? '…' : '📋 Copy'}</button>
          {canRecord && bgVideo && <button onClick={record} disabled={!!busy} style={btn(false)}>{busy === 'rec' ? '● Recording…' : '📹 Video'}</button>}
          <button onClick={onClose} style={btn(false)}>Close</button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>Upload your own image/video background{canRecord ? ' — then 📹 records it as a shareable clip' : ''}. Cached in your browser.</div>
      </div>
    </div>
  )
}

// Rounded-rect clip so the composited video keeps the card's rounded corners.
function roundClip(ctx: CanvasRenderingContext2D, W: number, H: number, r: number) {
  ctx.beginPath()
  if ((ctx as any).roundRect) (ctx as any).roundRect(0, 0, W, H, r)
  else { ctx.moveTo(r, 0); ctx.arcTo(W, 0, W, H, r); ctx.arcTo(W, H, 0, H, r); ctx.arcTo(0, H, 0, 0, r); ctx.arcTo(0, 0, W, 0, r) }
  ctx.closePath(); ctx.clip()
}

function Cell({ label, v, pos, glow, glass }: { label: string; v: string; pos?: boolean; glow?: string; glass?: boolean }) {
  return (
    <div style={{ padding: '12px 14px', borderRadius: 12, background: glass ? 'rgba(8,14,22,.42)' : 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.09)', backdropFilter: glass ? 'blur(3px)' : undefined }}>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,.6)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, marginTop: 4, fontFamily: 'var(--font-mono)', color: glow ? glow : pos ? '#4ade80' : '#f87171' }}>{v}<span style={{ fontSize: 11, opacity: 0.6, marginLeft: 3 }}>ETH</span></div>
    </div>
  )
}

const btn = (primary: boolean) => ({
  padding: '9px 16px', borderRadius: 10, fontWeight: 700, fontSize: 13,
  background: primary ? 'linear-gradient(135deg,#5eead4,#3b82f6)' : 'var(--panel)',
  color: primary ? '#08131a' : 'var(--text)', border: primary ? 'none' : '1px solid var(--border)',
})
const chip = (active: boolean) => ({
  width: 34, height: 30, borderRadius: 8, fontSize: 15,
  background: active ? 'var(--accent-dim)' : 'var(--panel)', border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
})
