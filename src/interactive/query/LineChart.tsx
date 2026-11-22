import { useEffect, useId, useMemo, useRef, useState } from 'react'

export interface ChartSeries {
  name: string
  samples: { t: number; v: number }[]
}

const COLORS = ['var(--accent)', 'var(--info)', 'var(--warn)', 'var(--bad)', 'var(--ok)', '#a855f7', '#ec4899', '#64748b', '#0ea5e9', '#f97316']
export const seriesColor = (i: number) => COLORS[i % COLORS.length]

const PAD = { l: 56, r: 12, t: 10, b: 26 }

/** 1234567 → 1.23M; 0.000123 → 123µ (como las unidades cortas de Grafana). */
export function shortNumber(v: number): string {
  if (!Number.isFinite(v)) return String(v)
  const a = Math.abs(v)
  if (a === 0) return '0'
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'G'],
    [1e6, 'M'],
    [1e3, 'k'],
  ]
  for (const [f, u] of units) if (a >= f) return `${+(v / f).toPrecision(3)}${u}`
  if (a >= 1) return String(+v.toPrecision(4))
  if (a >= 0.001) return String(+v.toPrecision(3))
  return `${+(v * 1e6).toPrecision(3)}µ`
}

function niceTicks(min: number, max: number, n = 4): number[] {
  if (min === max) {
    min -= 1
    max += 1
  }
  const raw = (max - min) / n
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let v = Math.floor(min / step) * step; v <= max + step * 0.001; v += step) out.push(+v.toPrecision(12))
  return out
}

const hhmm = (t: number) => new Date(t * 1000).toISOString().slice(11, 16)

/** Gráfico de líneas de series de tiempo, con eje de horas (UTC) y valores al pasar el puntero. */
export function LineChart({ series, start, end, step, label }: { series: ChartSeries[]; start: number; end: number; step: number; label: string }) {
  const id = useId()
  const svg = useRef<SVGSVGElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number>()
  // El ancho del dibujo es el ancho real (así el texto queda siempre del mismo tamaño).
  const [W, setW] = useState(640)
  const H = W < 480 ? 200 : 240
  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const { ticks, y, x, paths } = useMemo(() => {
    const vals = series.flatMap((s) => s.samples.map((p) => p.v)).filter(Number.isFinite)
    let min = vals.length ? Math.min(...vals) : 0
    let max = vals.length ? Math.max(...vals) : 1
    if (min > 0 && min < max * 0.3) min = 0
    if (max === min) max = min + 1
    const ticks = niceTicks(min, max)
    const lo = Math.min(min, ticks[0])
    const hi = Math.max(max, ticks[ticks.length - 1])
    const x = (t: number) => PAD.l + ((t - start) / Math.max(1, end - start)) * (W - PAD.l - PAD.r)
    const y = (v: number) => H - PAD.b - ((v - lo) / (hi - lo || 1)) * (H - PAD.t - PAD.b)
    const paths = series.map((s) => {
      let d = ''
      let prev: number | undefined
      for (const p of s.samples) {
        if (!Number.isFinite(p.v)) {
          prev = undefined
          continue
        }
        d += `${prev === undefined || p.t - prev > step * 2.5 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`
        prev = p.t
      }
      return d
    })
    return { ticks: ticks.filter((t) => t >= lo && t <= hi), y, x, paths }
  }, [series, start, end, step, W, H])

  const hours: number[] = []
  const span = end - start
  const every = span > 12 * 3600 ? 3 * 3600 : span > 4 * 3600 ? (W < 480 ? 7200 : 3600) : span > 3600 ? 1800 : 600
  for (let t = Math.ceil(start / every) * every; t <= end; t += every) hours.push(t)

  const hoverT = hover !== undefined ? start + ((hover - PAD.l) / (W - PAD.l - PAD.r)) * (end - start) : undefined
  const near = (s: ChartSeries) => {
    if (hoverT === undefined || !s.samples.length) return undefined
    let best = s.samples[0]
    for (const p of s.samples) if (Math.abs(p.t - hoverT) < Math.abs(best.t - hoverT)) best = p
    return Math.abs(best.t - hoverT) <= step * 2 ? best : undefined
  }

  return (
    <div className="relative" ref={box}>
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full touch-none select-none"
        role="img"
        aria-labelledby={`${id}-t`}
        onPointerMove={(e) => {
          const r = svg.current!.getBoundingClientRect()
          const px = ((e.clientX - r.left) / r.width) * W
          setHover(px >= PAD.l && px <= W - PAD.r ? px : undefined)
        }}
        onPointerLeave={() => setHover(undefined)}
      >
        <title id={`${id}-t`}>{label}</title>
        <g fontSize="11" fill="var(--muted)">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeDasharray={t === 0 ? undefined : '3 3'} />
              <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end">
                {shortNumber(t)}
              </text>
            </g>
          ))}
          {hours.map((t) => (
            <text key={t} x={x(t)} y={H - 8} textAnchor="middle">
              {hhmm(t)}
            </text>
          ))}
        </g>
        {paths.map((d, i) => (
          <path key={i} d={d} fill="none" stroke={seriesColor(i)} strokeWidth="1.6" strokeLinejoin="round" />
        ))}
        {hover !== undefined && <line x1={hover} x2={hover} y1={PAD.t} y2={H - PAD.b} stroke="var(--muted)" strokeDasharray="2 2" />}
      </svg>
      {hoverT !== undefined && (
        <div className="pointer-events-none absolute right-2 top-2 max-w-[70%] rounded-md border border-line bg-surface/95 p-2 text-xs shadow-card">
          <div className="mb-1 font-mono text-muted">{hhmm(hoverT)} UTC</div>
          {series.slice(0, 8).map((s, i) => {
            const p = near(s)
            return (
              p && (
                <div key={i} className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: seriesColor(i) }} />
                  <span className="truncate font-mono">{s.name}</span>
                  <span className="ml-auto pl-2 font-mono">{shortNumber(p.v)}</span>
                </div>
              )
            )
          })}
        </div>
      )}
    </div>
  )
}
