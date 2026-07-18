import { fmtEth } from './App'

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Heat calendar of ETH flowing back to the wallet (removals + fee collects) per day.
export function Calendar({ calendar, historyComplete = true, loadingHistory }: { calendar: Map<string, number>; historyComplete?: boolean; loadingHistory?: boolean }) {
  if (loadingHistory) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--accent)', border: '1px solid var(--border-soft)', borderRadius: 13, animation: 'pulse 1.2s infinite' }}>⏳ Loading trade history…</div>
  }
  if (calendar.size === 0) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', border: '1px solid var(--border-soft)', borderRadius: 13 }}>
      {historyComplete ? 'No realized flow yet — all positions still open.' : 'Trade history unavailable (indexer truncated) — retry from the banner above.'}
    </div>
  }
  const days = [...calendar.keys()].sort()
  const first = new Date(days[0] + 'T00:00:00Z')
  const last = new Date(days[days.length - 1] + 'T00:00:00Z')
  const max = Math.max(...[...calendar.values()].map(Math.abs), 1e-9)
  const total = [...calendar.values()].reduce((s, v) => s + v, 0)

  const months: { y: number; m: number }[] = []
  const cur = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1))
  while (cur <= last) { months.push({ y: cur.getUTCFullYear(), m: cur.getUTCMonth() }); cur.setUTCMonth(cur.getUTCMonth() + 1) }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {months.map(({ y, m }) => <MonthGrid key={`${y}-${m}`} y={y} m={m} calendar={calendar} max={max} />)}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: 'var(--muted)', flexWrap: 'wrap', gap: 8 }}>
        <span>Daily ETH returned to wallet (removals + fee collects).</span>
        <span>Total returned <b className="mono" style={{ color: 'var(--green)' }}>{fmtEth(total)} ETH</b></span>
      </div>
    </div>
  )
}

function MonthGrid({ y, m, calendar, max }: { y: number; m: number; calendar: Map<string, number>; max: number }) {
  const firstDow = new Date(Date.UTC(y, m, 1)).getUTCDay()
  const nDays = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  const cells: (string | null)[] = Array(firstDow).fill(null)
  let monthSum = 0, activeDays = 0
  for (let d = 1; d <= nDays; d++) {
    const key = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    cells.push(key)
    const v = calendar.get(key) || 0
    if (Math.abs(v) > 1e-9) { monthSum += v; activeDays++ }
  }

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 13, padding: '14px 16px', background: 'var(--panel)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>{MON[m]} {y}</div>
        {activeDays > 0 && <div style={{ fontSize: 12, color: 'var(--muted-2)' }}>{activeDays} active · <b className="mono" style={{ color: monthSum >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmtEth(monthSum)} ETH</b></div>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 5 }}>
        {DOW.map((d, i) => <div key={i} style={{ textAlign: 'center', fontSize: 10, color: 'var(--muted)', fontWeight: 600, paddingBottom: 2 }}>{d}</div>)}
        {cells.map((day, i) => {
          if (!day) return <div key={i} />
          const v = calendar.get(day) || 0
          const on = Math.abs(v) > 1e-9
          const intensity = on ? Math.min(1, Math.abs(v) / max) : 0
          const bg = v > 0 ? `rgba(52,211,153,${0.16 + intensity * 0.72})` : v < 0 ? `rgba(248,113,113,${0.16 + intensity * 0.72})` : 'var(--panel-2)'
          const dark = on && intensity > 0.35
          return (
            <div key={i} title={on ? `${day}: ${fmtEth(v)} ETH` : day}
              style={{ minHeight: 52, borderRadius: 8, background: bg, border: '1px solid var(--border-soft)', padding: '5px 7px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: on ? (dark ? 'rgba(8,19,26,.7)' : 'var(--text)') : 'var(--muted)' }}>{parseInt(day.slice(-2))}</span>
              {on && <span className="mono" style={{ fontSize: 11.5, fontWeight: 800, alignSelf: 'flex-end', color: dark ? '#08131a' : (v > 0 ? 'var(--green)' : 'var(--red)') }}>{v > 0 ? '+' : ''}{fmtEth(v)}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
