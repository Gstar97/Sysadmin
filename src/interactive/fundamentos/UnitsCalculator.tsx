import { useMemo, useState } from 'react'
import { advertisedToBinary, formatDuration, formatNumber, fromBytes, SIZE_UNITS, SPEED_UNITS, toBytes, transferTime, type SizeUnit, type SpeedUnit } from '@/engines/fundamentos/units'
import { createRng, pick, type Rng } from '@/lib/random'
import { Button } from '@/ui'
import { Chip, Feedback, Frame, inputClass, Score } from './Frame'

const DECIMAL: SizeUnit[] = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
const BINARY: SizeUnit[] = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB']
const selectClass = 'min-h-10 rounded-lg border border-line bg-bg px-2 text-sm'

function parseNumber(text: string): number | undefined {
  const t = text.trim().replace(/\s/g, '')
  if (!t) return undefined
  // Acepta "1.5", "1,5" y "1.000,5".
  const normalized = /,\d{1,3}$/.test(t) && !/\.\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')
  const n = Number(normalized)
  return Number.isFinite(n) ? n : undefined
}

function Capacity() {
  const [text, setText] = useState('2')
  const [unit, setUnit] = useState<SizeUnit>('TB')
  const value = parseNumber(text)
  const bytes = value === undefined ? undefined : toBytes(value, unit)
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <input aria-label="Cantidad" value={text} onChange={(e) => setText(e.target.value)} className={`${inputClass} w-36`} inputMode="decimal" />
        <select aria-label="Unidad" value={unit} onChange={(e) => setUnit(e.target.value as SizeUnit)} className={selectClass}>
          {Object.keys(SIZE_UNITS).map((u) => (
            <option key={u}>{u}</option>
          ))}
        </select>
      </div>
      {bytes === undefined ? (
        <p className="mt-3 text-sm text-bad">Escribe un número.</p>
      ) : (
        <>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {[
              { titulo: 'Unidades decimales (potencias de 1000)', units: DECIMAL, nota: 'Las usan los fabricantes de discos, las redes y macOS.' },
              { titulo: 'Unidades binarias (potencias de 1024)', units: BINARY, nota: 'Las usan Linux (free, df -h), la RAM y Windows (aunque Windows escribe "GB").' },
            ].map((g) => (
              <div key={g.titulo}>
                <div className="text-sm font-medium">{g.titulo}</div>
                <table className="mt-1 w-full text-sm">
                  <tbody>
                    {g.units.map((u) => (
                      <tr key={u} className="border-t border-line">
                        <td className="py-1 pr-2 font-mono text-muted">{u}</td>
                        <td className="py-1 text-right font-mono">{formatNumber(fromBytes(bytes, u), 3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-1 text-xs text-muted">{g.nota}</p>
              </div>
            ))}
          </div>
          {(unit === 'GB' || unit === 'TB') && value! > 0 && (
            <div className="mt-4 rounded-lg bg-surface-2 p-3 text-sm">
              <div className="font-medium">
                ¿Por qué un disco de {formatNumber(value!)} {unit} aparece como {formatNumber(advertisedToBinary(value!, unit).gib)} "GB"?
              </div>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5">
                {advertisedToBinary(value!, unit).pasos.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Transfer() {
  const [size, setSize] = useState('10')
  const [sizeUnit, setSizeUnit] = useState<SizeUnit>('GB')
  const [speed, setSpeed] = useState('100')
  const [speedUnit, setSpeedUnit] = useState<SpeedUnit>('Mbps')
  const s = parseNumber(size)
  const v = parseNumber(speed)
  const result = s !== undefined && v ? transferTime(s, sizeUnit, v, speedUnit) : undefined
  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Tamaño del archivo
          <div className="mt-1 flex gap-2">
            <input value={size} onChange={(e) => setSize(e.target.value)} className={`${inputClass} w-28`} inputMode="decimal" />
            <select aria-label="Unidad del tamaño" value={sizeUnit} onChange={(e) => setSizeUnit(e.target.value as SizeUnit)} className={selectClass}>
              {Object.keys(SIZE_UNITS).map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </div>
        </label>
        <label className="text-sm">
          Velocidad
          <div className="mt-1 flex gap-2">
            <input value={speed} onChange={(e) => setSpeed(e.target.value)} className={`${inputClass} w-28`} inputMode="decimal" />
            <select aria-label="Unidad de la velocidad" value={speedUnit} onChange={(e) => setSpeedUnit(e.target.value as SpeedUnit)} className={selectClass}>
              {Object.keys(SPEED_UNITS).map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </div>
        </label>
      </div>
      {result ? (
        <div className="mt-4">
          <div className="text-2xl font-bold">{formatDuration(result.seconds)}</div>
          <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-sm">
            {result.pasos.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ol>
        </div>
      ) : (
        <p className="mt-3 text-sm text-bad">Escribe un tamaño y una velocidad mayor que 0.</p>
      )}
    </div>
  )
}

interface UnitQuestion {
  pregunta: string
  respuesta: number
  unidad: string
  pasos: string[]
}

const GENERATORS: ((rng: Rng) => UnitQuestion)[] = [
  (rng) => {
    const mbps = pick(rng, [50, 100, 200, 300, 500, 600, 1000])
    return {
      pregunta: `Tu conexión es de ${mbps} Mbps. ¿Cuántos MB/s verás como máximo en una descarga?`,
      respuesta: mbps / 8,
      unidad: 'MB/s',
      pasos: [`Mbps son megabits por segundo y MB/s son megabytes por segundo.`, `Un byte tiene 8 bits: ${mbps} ÷ 8 = ${formatNumber(mbps / 8)} MB/s.`],
    }
  },
  (rng) => {
    const tb = pick(rng, [1, 2, 4, 8, 12, 16])
    const r = advertisedToBinary(tb, 'TB')
    return { pregunta: `Compras un disco de ${tb} TB. ¿Cuántos GiB mostrará el sistema operativo (aproximado)?`, respuesta: r.gib, unidad: 'GiB', pasos: r.pasos }
  },
  (rng) => {
    const gb = pick(rng, [1, 5, 10, 25, 50, 100])
    const mbps = pick(rng, [100, 200, 500, 1000])
    const r = transferTime(gb, 'GB', mbps, 'Mbps')
    return { pregunta: `¿Cuántos segundos tarda en copiarse un archivo de ${gb} GB por una red de ${mbps} Mbps, sin contar la sobrecarga de los protocolos?`, respuesta: r.seconds, unidad: 's', pasos: r.pasos.slice(0, -1) }
  },
  (rng) => {
    const gib = pick(rng, [2, 4, 8, 16, 32, 64])
    return { pregunta: `Un servidor tiene ${gib} GiB de RAM. ¿Cuántos MiB son?`, respuesta: gib * 1024, unidad: 'MiB', pasos: [`En unidades binarias cada escalón es × 1024: ${gib} × 1024 = ${gib * 1024} MiB.`] }
  },
  (rng) => {
    const mb = pick(rng, [3, 15, 250, 700, 1500])
    return { pregunta: `Un archivo pesa ${mb} MB. ¿Cuántos KB son?`, respuesta: mb * 1000, unidad: 'KB', pasos: [`En unidades decimales cada escalón es × 1000: ${mb} × 1000 = ${formatNumber(mb * 1000)} KB.`] }
  },
  (rng) => {
    const mbs = pick(rng, [125, 250, 550, 1100])
    return {
      pregunta: `Un disco copia a ${mbs} MB/s. ¿A cuántos Mbps equivale esa velocidad?`,
      respuesta: mbs * 8,
      unidad: 'Mbps',
      pasos: [`Para pasar de bytes a bits se multiplica por 8: ${mbs} × 8 = ${formatNumber(mbs * 8)} Mbps.`, mbs * 8 > 1000 ? 'Es más de lo que entrega una red de 1 Gbps: en ese caso el límite sería la red, no el disco.' : 'Una red de 1 Gbps alcanza para esa velocidad.'],
    }
  },
]

function Practice() {
  const [seed, setSeed] = useState(() => Date.now())
  const q = useMemo(() => {
    const rng = createRng(seed)
    return pick(rng, GENERATORS)(rng)
  }, [seed])
  const [answer, setAnswer] = useState('')
  const [checked, setChecked] = useState<boolean>()
  const [score, setScore] = useState({ correct: 0, total: 0, streak: 0 })
  const value = parseNumber(answer)

  const check = () => {
    if (value === undefined) return
    const ok = Math.abs(value - q.respuesta) <= Math.max(0.01, Math.abs(q.respuesta) * 0.01)
    setChecked(ok)
    setScore((s) => ({ correct: s.correct + (ok ? 1 : 0), total: s.total + 1, streak: ok ? s.streak + 1 : 0 }))
  }

  return (
    <div>
      <p className="text-base font-medium">{q.pregunta}</p>
      <form
        className="mt-2 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (checked === undefined) check()
          else {
            setSeed(Date.now())
            setAnswer('')
            setChecked(undefined)
          }
        }}
      >
        <input aria-label="Tu respuesta" value={answer} onChange={(e) => setAnswer(e.target.value)} readOnly={checked !== undefined} className={`${inputClass} w-36`} inputMode="decimal" autoComplete="off" />
        <span className="text-sm text-muted">{q.unidad}</span>
        <Button type="submit">{checked === undefined ? 'Comprobar' : 'Siguiente'}</Button>
        <Score {...score} />
      </form>
      <p className="mt-1 text-xs text-muted">Se acepta un margen del 1%. Puedes usar coma o punto para los decimales.</p>
      {checked !== undefined && <Feedback ok={checked} titulo={checked ? 'Correcto' : `La respuesta es ${formatNumber(q.respuesta)} ${q.unidad}`} pasos={q.pasos} />}
    </div>
  )
}

const TABS = [
  { id: 'capacidad', nombre: 'Capacidad' },
  { id: 'transferencia', nombre: 'Tiempo de transferencia' },
  { id: 'practica', nombre: 'Practicar' },
] as const

/** Calculadora de unidades de almacenamiento y velocidad (decimales y binarias). */
export function UnitsCalculator({ modo = 'capacidad' }: { modo?: (typeof TABS)[number]['id'] }) {
  const [tab, setTab] = useState(modo)
  return (
    <Frame
      titulo="Unidades de almacenamiento y velocidad"
      acciones={TABS.map((t) => (
        <Chip key={t.id} active={t.id === tab} onClick={() => setTab(t.id)}>
          {t.nombre}
        </Chip>
      ))}
    >
      {tab === 'capacidad' ? <Capacity /> : tab === 'transferencia' ? <Transfer /> : <Practice />}
    </Frame>
  )
}
