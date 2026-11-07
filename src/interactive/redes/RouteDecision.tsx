import { useMemo, useState } from 'react'
import { DISTANCIAS, contains, randomInstalada, randomSalida, routeText } from '@/engines/redes/rutas'
import { createRng } from '@/lib/random'
import { cn } from '@/lib/cn'
import { Button } from '@/ui'
import { Chip, Feedback, Frame, Score } from '../fundamentos/Frame'

type Modo = 'salida' | 'instalada'

/** ¿Por dónde sale este paquete? y ¿qué ruta se instala?, con tablas al azar. */
export function RouteDecision() {
  const rng = useMemo(() => createRng(), [])
  const [modo, setModo] = useState<Modo>('salida')
  const [qs, setQs] = useState(() => randomSalida(rng))
  const [qi, setQi] = useState(() => randomInstalada(rng))
  const [answer, setAnswer] = useState<number | 'descarta'>()
  const [stats, setStats] = useState({ correct: 0, total: 0, streak: 0 })
  const correct = modo === 'salida' ? (qs.answer ?? 'descarta') : qi.answer
  const choose = (a: number | 'descarta') => {
    if (answer !== undefined) return
    setAnswer(a)
    const ok = a === correct
    setStats((s) => ({ correct: s.correct + (ok ? 1 : 0), total: s.total + 1, streak: ok ? s.streak + 1 : 0 }))
  }
  const next = (m: Modo = modo) => {
    setModo(m)
    if (m === 'salida') setQs(randomSalida(rng))
    else setQi(randomInstalada(rng))
    setAnswer(undefined)
  }
  const ok = answer === correct

  let pasos: string[] = []
  if (answer !== undefined && modo === 'salida') {
    const matches = qs.table.filter((r) => contains(r, qs.dest))
    pasos = [
      matches.length ? `Contienen a ${qs.dest}: ${matches.map((r) => `${r.net}/${r.prefix}`).join(', ')}.` : `Ninguna ruta contiene a ${qs.dest}, y no hay ruta por defecto.`,
      qs.answer !== undefined
        ? `Gana la más específica (el prefijo más largo): /${qs.table[qs.answer].prefix}. Sale por ${qs.table[qs.answer].iface}${qs.table[qs.answer].via ? ` hacia ${qs.table[qs.answer].via}` : ', directo al destino'}.`
        : 'El router descarta el paquete y avisa al origen con un ICMP "destino inalcanzable".',
      'La distancia administrativa y la métrica no se comparan acá: solo deciden entre rutas a la misma red con el mismo prefijo.',
    ]
  }
  if (answer !== undefined && modo === 'instalada') {
    const w = qi.candidatas[qi.answer]
    const sameAd = qi.candidatas.filter((c) => c.ad === w.ad).length > 1
    pasos = [
      `Las tres ofrecen la misma red (${qi.red}), así que el prefijo empata y decide la distancia administrativa: la más baja es la más confiable.`,
      sameAd ? `Dos fuentes de ${w.fuente} empatan en distancia (${w.ad}): decide la métrica, y gana la menor (${w.metric}).` : `${w.fuente} tiene distancia ${w.ad}, la más baja de las tres.`,
      'Las métricas de protocolos distintos no se comparan entre sí: un costo de OSPF y un salto de RIP no se miden en la misma unidad.',
    ]
  }

  return (
    <Frame
      titulo="¿Cómo decide el router?"
      acciones={
        <>
          <Chip active={modo === 'salida'} onClick={() => next('salida')}>
            ¿Por dónde sale?
          </Chip>
          <Chip active={modo === 'instalada'} onClick={() => next('instalada')}>
            ¿Qué ruta se instala?
          </Chip>
        </>
      }
    >
      <div className="space-y-3">
        <Score {...stats} />
        {modo === 'salida' ? (
          <>
            <p className="text-sm">
              Llega un paquete para <strong className="font-mono">{qs.dest}</strong>. ¿Qué ruta usa el router? Tocá una línea de la tabla.
            </p>
            <div className="overflow-x-auto rounded-lg p-2 font-mono text-xs sm:text-sm" style={{ background: 'var(--term-bg)', color: 'var(--term-fg)' }}>
              <p className="px-2 opacity-70">R1# show ip route</p>
              {qs.table.map((r, i) => (
                <button
                  key={i}
                  type="button"
                  disabled={answer !== undefined}
                  onClick={() => choose(i)}
                  className={cn('block w-full whitespace-pre rounded px-2 py-1 text-left hover:bg-white/10', answer !== undefined && i === correct && 'bg-[var(--ok)]/30', answer === i && i !== correct && 'bg-[var(--bad)]/30')}
                >
                  {routeText(r)}
                </button>
              ))}
            </div>
            <Button variant={answer === 'descarta' ? 'primary' : 'secondary'} disabled={answer !== undefined} onClick={() => choose('descarta')}>
              Ninguna: se descarta
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm">
              El router aprendió la red <strong className="font-mono">{qi.red}</strong> de tres fuentes. ¿Cuál instala en la tabla de rutas?
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
              {qi.candidatas.map((c, i) => (
                <Button key={i} variant={answer === i ? 'primary' : 'secondary'} disabled={answer !== undefined} onClick={() => choose(i)} className={cn('h-auto flex-col items-start py-2 text-left', answer !== undefined && i === correct && 'ring-2 ring-[var(--ok)]')}>
                  <span className="font-semibold">{c.fuente}</span>
                  <span className="font-mono text-xs">
                    distancia {c.ad} · métrica {c.metric} · via {c.via}
                  </span>
                </Button>
              ))}
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer text-muted">Tabla de distancias administrativas</summary>
              <ul className="mt-1 grid grid-cols-2 gap-x-4 font-mono text-xs sm:grid-cols-4">
                {DISTANCIAS.map((d) => (
                  <li key={d.fuente}>
                    {d.fuente}: {d.ad}
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
        {answer !== undefined && (
          <>
            <div aria-live="polite">
              <Feedback ok={ok} titulo={ok ? '¡Correcto!' : modo === 'salida' ? (qs.answer === undefined ? 'Se descarta.' : `Usa ${qs.table[qs.answer].net}/${qs.table[qs.answer].prefix}.`) : `Se instala la de ${qi.candidatas[qi.answer].fuente}.`} pasos={pasos} />
            </div>
            <Button onClick={() => next()}>Otro paquete</Button>
          </>
        )}
      </div>
    </Frame>
  )
}
