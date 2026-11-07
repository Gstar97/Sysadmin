import { useState } from 'react'
import { CANALES_24, CANALES_5, DFS, OFICINA_APS, anchoValido, choque, espectro, sugerir24, vecinos, type Ancho, type Ap, type Banda } from '@/engines/redes/wifi'
import { cn } from '@/lib/cn'
import { Button } from '@/ui'
import { Chip, Feedback, Frame } from '../fundamentos/Frame'

const ALCANCE = 200
const COLORS = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2', '#db2777', '#65a30d', '#7c3aed', '#ea580c', '#0d9488', '#4f46e5', '#b45309']

function color(ap: Ap): string {
  const list = ap.banda === '2.4' ? CANALES_24 : CANALES_5
  return COLORS[list.indexOf(ap.canal) % COLORS.length]
}

/** Planificar canales: puntos de acceso en una planta, con choques entre vecinos y el espectro. */
export function WifiPlanner() {
  const [banda, setBanda] = useState<Banda>('2.4')
  const [aps, setAps] = useState<Ap[]>(() => structuredClone(OFICINA_APS))
  const [sel, setSel] = useState(0)
  const pares = vecinos(aps, ALCANCE)
  const malos = pares.map(([a, b]) => ({ a, b, c: choque(aps[a], aps[b]) })).filter((x) => x.c !== 'ninguno')
  const solapados = malos.filter((x) => x.c === 'solapado').length
  const cocanal = malos.filter((x) => x.c === 'cocanal').length
  const ap = aps[sel]
  const update = (patch: Partial<Ap>) => setAps(aps.map((x, i) => (i === sel ? { ...x, ...patch } : x)))
  const cambiarBanda = (b: Banda) => {
    setBanda(b)
    setAps(aps.map((x, i) => ({ ...x, banda: b, canal: b === '2.4' ? OFICINA_APS[i].canal : [36, 36, 40, 44, 40, 36][i], ancho: b === '2.4' ? 20 : 80 })))
  }
  const espectroMin = banda === '2.4' ? 2400 : 5170
  const espectroMax = banda === '2.4' ? 2484 : 5835
  const xf = (f: number) => ((f - espectroMin) / (espectroMax - espectroMin)) * 460 + 10

  return (
    <Frame
      titulo="Planificar canales Wi-Fi"
      acciones={
        <>
          <Chip active={banda === '2.4'} onClick={() => cambiarBanda('2.4')}>
            2,4 GHz
          </Chip>
          <Chip active={banda === '5'} onClick={() => cambiarBanda('5')}>
            5 GHz
          </Chip>
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
        <div className="space-y-2">
          <svg viewBox="0 0 500 310" className="h-auto w-full max-w-[520px]" role="img" aria-label="Planta de oficina con seis puntos de acceso; las líneas entre vecinos se ven rojas si los canales se pisan y amarillas si comparten canal">
            <defs>
              <clipPath id="wifi-planta">
                <rect x="10" y="10" width="480" height="290" rx="8" />
              </clipPath>
            </defs>
            <rect x="10" y="10" width="480" height="290" rx="8" fill="var(--surface-2)" stroke="var(--line)" />
            <g clipPath="url(#wifi-planta)">
              {aps.map((a) => (
                <circle key={`r${a.id}`} cx={a.x} cy={a.y} r={(ALCANCE * (a.banda === '2.4' ? 1 : 0.85)) / 2} fill={color(a)} opacity={0.09} />
              ))}
            </g>
            {pares.map(([i, j]) => {
              const c = choque(aps[i], aps[j])
              return <line key={`${i}-${j}`} x1={aps[i].x} y1={aps[i].y} x2={aps[j].x} y2={aps[j].y} stroke={c === 'solapado' ? 'var(--bad)' : c === 'cocanal' ? 'var(--warn)' : 'var(--ok)'} strokeWidth={c === 'ninguno' ? 2 : 4} strokeDasharray={c === 'ninguno' ? '5 5' : undefined} />
            })}
            {aps.map((a, i) => (
              <g key={a.id} className="cursor-pointer" onClick={() => setSel(i)}>
                <circle cx={a.x} cy={a.y} r={22} fill="var(--surface)" stroke={color(a)} strokeWidth={sel === i ? 5 : 3} />
                <text x={a.x} y={a.y - 2} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--fg)" fontFamily="system-ui">
                  {a.id}
                </text>
                <text x={a.x} y={a.y + 11} textAnchor="middle" fontSize={10} fill="var(--fg)" fontFamily="system-ui">
                  c{a.canal}
                  {a.banda === '5' && a.ancho > 20 ? `/${a.ancho}` : ''}
                </text>
              </g>
            ))}
          </svg>
          <svg viewBox="0 0 480 90" className="h-auto w-full max-w-[520px]" role="img" aria-label={`Espectro de ${banda === '2.4' ? '2,4' : '5'} GHz con lo que ocupa cada punto de acceso`}>
            <line x1="10" y1="70" x2="470" y2="70" stroke="var(--line)" />
            {aps.map((a, i) => {
              const [f1, f2] = espectro(a)
              const x1 = xf(f1)
              const x2 = xf(f2)
              const h = 46 - (i % 3) * 8
              return <path key={a.id} d={`M${x1} 70 Q${(x1 + x2) / 2} ${70 - h * 2} ${x2} 70`} fill={color(a)} fillOpacity={0.18} stroke={color(a)} strokeWidth={sel === i ? 3 : 1.5} />
            })}
            {(banda === '2.4' ? [1, 6, 11, 13] : [36, 52, 100, 149, 165]).map((c) => {
              const f = banda === '2.4' ? 2412 + 5 * (c - 1) : 5000 + 5 * c
              return (
                <text key={c} x={xf(f)} y={84} textAnchor="middle" fontSize={9.5} fill="var(--muted)" fontFamily="system-ui">
                  {c}
                </text>
              )
            })}
          </svg>
          <p className={cn('text-sm font-medium', solapados ? 'text-bad' : cocanal ? 'text-warn' : 'text-ok')} aria-live="polite">
            {solapados ? `${solapados} par${solapados > 1 ? 'es' : ''} de vecinos con canales que se pisan (interferencia).` : cocanal ? `Sin interferencia, pero ${cocanal} par${cocanal > 1 ? 'es' : ''} de vecinos comparte${cocanal > 1 ? 'n' : ''} canal: se turnan para hablar.` : 'Ningún vecino choca: cada uno tiene el aire para él.'}
          </p>
        </div>
        <div className="space-y-3 text-sm">
          <h4 className="font-semibold">{ap.id}</h4>
          <label className="flex items-center justify-between gap-2">
            <span>Canal</span>
            <select
              className="min-h-9 rounded-lg border border-line bg-bg px-2"
              value={ap.canal}
              onChange={(e) => {
                const canal = Number(e.target.value)
                update({ canal, ancho: anchoValido(canal, ap.ancho) ? ap.ancho : 20 })
              }}
            >
              {(banda === '2.4' ? CANALES_24 : CANALES_5).map((c) => (
                <option key={c} value={c}>
                  {c}
                  {banda === '5' && DFS(c) ? ' (DFS)' : ''}
                </option>
              ))}
            </select>
          </label>
          {banda === '5' && (
            <label className="flex items-center justify-between gap-2">
              <span>Ancho</span>
              <select className="min-h-9 rounded-lg border border-line bg-bg px-2" value={ap.ancho} onChange={(e) => update({ ancho: Number(e.target.value) as Ancho })}>
                {([20, 40, 80] as Ancho[]).map((w) => (
                  <option key={w} value={w} disabled={!anchoValido(ap.canal, w)}>
                    {w} MHz
                  </option>
                ))}
              </select>
            </label>
          )}
          {banda === '2.4' && (
            <Button variant="secondary" onClick={() => setAps(aps.map((a, i) => ({ ...a, canal: sugerir24(aps, ALCANCE)[i] })))}>
              Ver una solución con 1, 6 y 11
            </Button>
          )}
          {!solapados && !cocanal && (
            <Feedback
              ok
              titulo="Plan sin choques"
              pasos={
                banda === '2.4'
                  ? ['En 2,4 GHz solo hay tres canales que no se pisan: 1, 6 y 11. Con eso, y alternándolos, se cubre una planta.']
                  : ['En 5 GHz hay muchos más canales. Con 80 MHz quedan pocos bloques sin DFS (36 y 149): por eso en oficinas densas se usan 20 o 40 MHz.']
              }
            />
          )}
          <p className="text-xs text-muted">
            {banda === '2.4'
              ? 'Cada canal ocupa 20 MHz y están separados 5 MHz: el 1 y el 3 se pisan. Mismo canal: se turnan. Canales cercanos: se hacen ruido, que es peor.'
              : 'DFS: canales compartidos con radares; el AP tiene que escuchar antes de usarlos y abandonarlos si detecta uno. Más ancho = más velocidad para un AP, pero menos canales para repartir.'}
          </p>
        </div>
      </div>
    </Frame>
  )
}
