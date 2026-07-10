import { fmtEth } from './App'

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Heat calendar of ETH flowing back to the wallet (removals + fee collects) per day.
export function Calendar({ calendar }: { calendar: Map<string, number> }) {
  if (calendar.size === 0) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', border: '1px solid var(--border-soft)', borderRadius: 13 }}>No realized flow yet — all positions still open.</div>
  }
  const days = [...calendar.keys()].sort()
  const first = new Date(days[0] + 'T00:00:00Z')
  const last = new Date(days[days.length - 1] + 'T00:00:00Z')
  const max = Math.max(...[...calendar.values()].map(Math.abs), 1e-9)

  // build month buckets from first→last
  const months: { y: number; m: number }[] = []
  const cur = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1))
  while (cur <= last) { months.push({ y: cur.getUTCFullYear(), m: cur.getUTCMonth() }); cur.setUTCMonth(cur.getUTCMonth() + 1) }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {months.map(({ y, m }) => (
        <MonthGrid key={`${y}-${m}`} y={y} m={m} calendar={calendar} max={max} />
      ))}
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>Daily ETH returned to wallet (liquidity removals + fee collects). Green = inflow.</div>
    </div>
  )
}

function MonthGrid({ y, m, calendar, max }: { y: number; m: number; calendar: Map<string, number>; max: number }) {
  const firstDow = new Date(Date.UTC(y, m, 1)).getUTCDay()
  const nDays = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  const cells: (string | null)[] = Array(firstDow).fill(null)
  for (let d = 1; d <= nDays; d++) cells.push(`${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`)

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 13, padding: '14px 16px', background: 'var(--panel)' }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>{MON[m]} {y}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
        {DOW.map((d, i) => <div key={i} style={{ textAlign: 'center', fontSize: 10, color: 'var(--muted)', fontWeight: 600 }}>{d}</div>)}
        {cells.map((day, i) => {
          if (!day) return <div key={i} />
          const v = calendar.get(day) || 0
          const intensity = v ? Math.min(1, Math.abs(v) / max) : 0
          const bg = v > 0 ? `rgba(52,211,153,${0.15 + intensity * 0.7})` : v < 0 ? `rgba(248,113,113,${0.15 + intensity * 0.7})` : 'var(--panel-2)'
          const dnum = parseInt(day.slice(-2))
          return (
            <div key={i} title={v ? `${day}: ${fmtEth(v)} ETH` : day}
              style={{ aspectRatio: '1', borderRadius: 6, background: bg, display: 'grid', placeItems: 'center', fontSize: 10, color: v ? '#08131a' : 'var(--muted)', fontWeight: v ? 700 : 400, border: '1px solid var(--border-soft)' }}>
              {dnum}
            </div>
          )
        })}
      </div>
    </div>
  )
}
