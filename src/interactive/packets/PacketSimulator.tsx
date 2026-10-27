import { useEffect, useRef, useState } from 'react'
import type { PacketScenario } from '@/content/exercise-schemas'
import { cn } from '@/lib/cn'
import { Button, Icon, RichText } from '@/ui'
import { DeviceIcon } from '../topology/DeviceIcon'

interface Props {
  scenario: PacketScenario
}

type Step = PacketScenario['pasos'][number]
type Layers = Step['capas']

const STEP_MS = 1400

const LAYER_INFO: { key: keyof Layers; name: string; pdu: string; color: string }[] = [
  { key: 'enlace', name: 'Capa 2 · Enlace', pdu: 'Trama', color: 'var(--info)' },
  { key: 'red', name: 'Capa 3 · Red', pdu: 'Paquete', color: 'var(--accent)' },
  { key: 'transporte', name: 'Capa 4 · Transporte', pdu: 'Segmento', color: 'var(--warn)' },
  { key: 'aplicacion', name: 'Capa 7 · Aplicación', pdu: 'Datos', color: 'var(--ok)' },
]

function fields(layers: Layers, key: keyof Layers): [string, string][] {
  const l = layers[key]
  if (!l) return []
  switch (key) {
    case 'enlace': {
      const e = l as NonNullable<Layers['enlace']>
      return [
        ['MAC origen', e.origen],
        ['MAC destino', e.destino],
        ['Tipo', e.tipo],
      ]
    }
    case 'red': {
      const r = l as NonNullable<Layers['red']>
      return [
        ['IP origen', r.origen],
        ['IP destino', r.destino],
        ...(r.ttl !== undefined ? ([['TTL', String(r.ttl)]] as [string, string][]) : []),
        ...(r.protocolo ? ([['Protocolo', r.protocolo]] as [string, string][]) : []),
      ]
    }
    case 'transporte': {
      const t = l as NonNullable<Layers['transporte']>
      return [
        ['Protocolo', t.protocolo],
        ['Puerto origen', String(t.origen)],
        ['Puerto destino', String(t.destino)],
        ...(t.flags ? ([['Flags', t.flags]] as [string, string][]) : []),
      ]
    }
    case 'aplicacion': {
      const a = l as NonNullable<Layers['aplicacion']>
      return [
        ['Protocolo', a.protocolo],
        ['Datos', a.datos],
      ]
    }
  }
}

export function PacketSimulator({ scenario }: Props) {
  const [index, setIndex] = useState(0)
  const [progress, setProgress] = useState(1)
  const [playing, setPlaying] = useState(false)
  const frame = useRef<number>(0)
  const steps = scenario.pasos
  const step = steps[index]
  const prev = index > 0 ? steps[index - 1] : undefined

  const nodes = new Map(scenario.nodos.map((n) => [n.id, n]))
  const xs = scenario.nodos.map((n) => n.x)
  const ys = scenario.nodos.map((n) => n.y)
  const pad = 60
  const minX = Math.min(...xs) - pad
  const minY = Math.min(...ys) - pad
  const width = Math.max(...xs) - minX + pad
  const height = Math.max(...ys) - minY + pad + 20

  // Animación del paquete a lo largo del enlace.
  useEffect(() => {
    if (progress >= 1) return
    const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
    const start = performance.now() - progress * STEP_MS
    const tick = (now: number) => {
      const p = reduce ? 1 : Math.min(1, (now - start) / STEP_MS)
      setProgress(p)
      if (p < 1) frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [index, progress])

  // Reproducción automática: al terminar un paso, pasa al siguiente.
  useEffect(() => {
    if (!playing || progress < 1) return
    const t = setTimeout(() => {
      if (index + 1 < steps.length) {
        setIndex(index + 1)
        setProgress(0)
      } else setPlaying(false)
    }, 900)
    return () => clearTimeout(t)
  }, [playing, progress, index, steps.length])

  const go = (i: number) => {
    setPlaying(false)
    setIndex(i)
    setProgress(0)
  }

  const from = nodes.get(step.desde)
  const to = nodes.get(step.hacia)
  const px = from && to ? from.x + (to.x - from.x) * progress : 0
  const py = from && to ? from.y + (to.y - from.y) * progress : 0

  return (
    <div className="my-6 overflow-hidden rounded-xl border border-line bg-surface shadow-card">
      <div className="border-b border-line p-4">
        <h3 className="text-lg font-semibold">{scenario.titulo}</h3>
        {scenario.descripcion && <RichText text={scenario.descripcion} className="text-muted" />}
      </div>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="p-2">
          <svg viewBox={`${minX} ${minY} ${width} ${height}`} className="h-auto max-h-[380px] w-full" role="img" aria-label={`Diagrama de ${scenario.titulo}. Paso ${index + 1}: ${step.titulo}`}>
            {scenario.enlaces.map((l, i) => {
              const a = nodes.get(l.a)
              const b = nodes.get(l.b)
              if (!a || !b) return null
              const active = (l.a === step.desde && l.b === step.hacia) || (l.b === step.desde && l.a === step.hacia)
              return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={active ? 'var(--accent)' : 'var(--line)'} strokeWidth={active ? 4 : 2.5} />
            })}
            {!scenario.enlaces.some((l) => (l.a === step.desde && l.b === step.hacia) || (l.b === step.desde && l.a === step.hacia)) && from && to && (
              <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="var(--accent)" strokeWidth={2} strokeDasharray="6 5" />
            )}
            {scenario.nodos.map((n) => (
              <g key={n.id} transform={`translate(${n.x - 24}, ${n.y - 24})`} className={n.id === step.desde || n.id === step.hacia ? 'text-accent' : 'text-muted'}>
                <rect x={-4} y={-4} width={56} height={56} rx={10} fill="var(--surface)" stroke={n.id === step.desde || n.id === step.hacia ? 'var(--accent)' : 'transparent'} />
                <DeviceIcon type={n.tipo} size={48} />
                <text x={24} y={66} textAnchor="middle" fontSize={12} fill="var(--fg)" fontFamily="system-ui, sans-serif">
                  {n.etiqueta}
                </text>
              </g>
            ))}
            {from && to && (
              <g transform={`translate(${px}, ${py})`} aria-hidden>
                <rect x={-13} y={-9} width={26} height={18} rx={3} fill="var(--accent)" />
                <path d="M-13 -9 L0 2 L13 -9" stroke="var(--accent-fg)" strokeWidth={1.5} fill="none" />
              </g>
            )}
          </svg>
          <div className="flex flex-wrap items-center justify-center gap-2 pb-2">
            <Button variant="secondary" onClick={() => go(Math.max(0, index - 1))} disabled={index === 0} aria-label="Paso anterior">
              <Icon name="arrowLeft" className="h-4 w-4" />
            </Button>
            <Button
              onClick={() => {
                if (playing) setPlaying(false)
                else {
                  if (index === steps.length - 1 && progress >= 1) setIndex(0)
                  setProgress(0)
                  setPlaying(true)
                }
              }}
            >
              <Icon name={playing ? 'pause' : 'play'} className="h-4 w-4" />
              {playing ? 'Pausa' : 'Reproducir'}
            </Button>
            <Button variant="secondary" onClick={() => go(Math.min(steps.length - 1, index + 1))} disabled={index === steps.length - 1} aria-label="Paso siguiente">
              <Icon name="arrowRight" className="h-4 w-4" />
            </Button>
            <span className="text-sm text-muted">
              Paso {index + 1} de {steps.length}
            </span>
          </div>
        </div>
        <div className="border-t border-line p-4 lg:border-l lg:border-t-0" aria-live="polite">
          <h4 className="font-semibold">{step.titulo}</h4>
          <p className="text-xs text-muted">
            {nodes.get(step.desde)?.etiqueta} → {nodes.get(step.hacia)?.etiqueta}
          </p>
          <RichText text={step.explicacion} className="mt-2 text-sm" />
          <div className="mt-3 space-y-1.5" aria-label="Encabezados del paquete en este tramo">
            {LAYER_INFO.filter((l) => step.capas[l.key]).map((l, depth) => (
              <div key={l.key} className="rounded-lg border-l-4 bg-surface-2 p-2" style={{ borderColor: l.color, marginLeft: depth * 6 }}>
                <div className="mb-1 flex items-center justify-between text-xs font-semibold">
                  <span>{l.name}</span>
                  <span className="font-normal text-muted">{l.pdu}</span>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                  {fields(step.capas, l.key).map(([k, v]) => {
                    const before = prev ? fields(prev.capas, l.key).find(([pk]) => pk === k)?.[1] : undefined
                    const changedField = prev !== undefined && before !== undefined && before !== v
                    return (
                      <div key={k} className="contents">
                        <dt className="text-muted">{k}</dt>
                        <dd className={cn('break-all font-mono', changedField && 'font-semibold text-accent')}>
                          {v}
                          {changedField && <span className="ml-1 font-sans text-[10px] font-normal">(cambió: antes {before})</span>}
                        </dd>
                      </div>
                    )
                  })}
                </dl>
              </div>
            ))}
          </div>
        </div>
      </div>
      <ol className="flex gap-1 overflow-x-auto border-t border-line p-2" aria-label="Pasos">
        {steps.map((s, i) => (
          <li key={i}>
            <button type="button" onClick={() => go(i)} className={cn('min-h-8 whitespace-nowrap rounded-md px-2 text-xs', i === index ? 'bg-accent-soft font-semibold text-accent' : 'text-muted hover:bg-surface-2')} aria-current={i === index ? 'step' : undefined}>
              {i + 1}. {s.titulo}
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}
