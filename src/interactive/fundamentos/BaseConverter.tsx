import { useMemo, useState } from 'react'
import { BASE_NAMES, checkNumberAnswer, CONVERSIONS, explainConversion, fromBase, generateNumberExercise, groupBits, toBase, type Base, type ConversionKind } from '@/engines/fundamentos/numbers'
import { createRng } from '@/lib/random'
import { Button } from '@/ui'
import { Chip, Feedback, Frame, inputClass, Score } from './Frame'

const BASES: Base[] = [2, 8, 10, 16]
const LEVELS = [
  { id: 1, nombre: 'Fácil (hasta 31)' },
  { id: 2, nombre: 'Media (hasta 255)' },
  { id: 3, nombre: 'Difícil (hasta 65535)' },
] as const

function Converter() {
  const [text, setText] = useState('192')
  const [from, setFrom] = useState<Base>(10)
  const [explainTo, setExplainTo] = useState<Base>(2)
  const n = fromBase(text, from)
  const tooBig = n !== undefined && n > 0xffffffff
  const target = explainTo === from ? (BASES.find((b) => b !== from) as Base) : explainTo
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="Número a convertir" value={text} onChange={(e) => setText(e.target.value)} className={`${inputClass} w-48`} />
        <span className="text-sm text-muted">escrito en</span>
        {BASES.map((b) => (
          <Chip key={b} active={b === from} onClick={() => setFrom(b)}>
            {BASE_NAMES[b]}
          </Chip>
        ))}
      </div>
      {n === undefined ? (
        <p className="mt-3 text-sm text-bad">{text.trim() ? `"${text}" no es un número ${BASE_NAMES[from]} válido: en base ${from} solo existen los dígitos ${'0123456789ABCDEF'.slice(0, from).split('').join(', ')}.` : 'Escribe un número.'}</p>
      ) : tooBig ? (
        <p className="mt-3 text-sm text-bad">Usa números de hasta 32 bits (4.294.967.295).</p>
      ) : (
        <>
          <dl className="mt-4 grid gap-2 sm:grid-cols-2">
            {BASES.map((b) => (
              <div key={b} className="rounded-lg bg-surface-2 px-3 py-2">
                <dt className="text-xs text-muted">
                  {BASE_NAMES[b]} (base {b})
                </dt>
                <dd className="break-all font-mono font-semibold">{b === 2 ? groupBits(toBase(n, 2)) : toBase(n, b)}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Ver cómo se pasa a</span>
            {BASES.filter((b) => b !== from).map((b) => (
              <Chip key={b} active={b === target} onClick={() => setExplainTo(b)}>
                {BASE_NAMES[b]}
              </Chip>
            ))}
          </div>
          <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-sm">
            {explainConversion(n, from, target).map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ol>
        </>
      )}
    </div>
  )
}

function Practice({ tipos }: { tipos?: ConversionKind[] }) {
  const kinds = CONVERSIONS.filter((c) => !tipos || tipos.includes(c.id))
  const [kind, setKind] = useState<ConversionKind>(kinds[0].id)
  const [level, setLevel] = useState<1 | 2 | 3>(1)
  const [seed, setSeed] = useState(() => Date.now())
  const ex = useMemo(() => generateNumberExercise(createRng(seed), kind, level), [seed, kind, level])
  const [answer, setAnswer] = useState('')
  const [checked, setChecked] = useState<boolean>()
  const [score, setScore] = useState({ correct: 0, total: 0, streak: 0 })

  const check = () => {
    if (!answer.trim() || checked !== undefined) return
    const ok = checkNumberAnswer(ex, answer)
    setChecked(ok)
    setScore((s) => ({ correct: s.correct + (ok ? 1 : 0), total: s.total + 1, streak: ok ? s.streak + 1 : 0 }))
  }
  const next = () => {
    setSeed(Date.now())
    setAnswer('')
    setChecked(undefined)
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <select aria-label="Tipo de conversión" value={kind} onChange={(e) => (setKind(e.target.value as ConversionKind), next())} className="min-h-9 rounded-lg border border-line bg-bg px-2 text-sm">
          {kinds.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nombre}
            </option>
          ))}
        </select>
        {LEVELS.map((l) => (
          <Chip key={l.id} active={l.id === level} onClick={() => (setLevel(l.id), next())}>
            {l.nombre}
          </Chip>
        ))}
      </div>
      <p className="mt-4 text-base font-medium">{ex.pregunta}</p>
      <form
        className="mt-2 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (checked === undefined) check()
          else next()
        }}
      >
        <input aria-label="Tu respuesta" value={answer} onChange={(e) => setAnswer(e.target.value)} readOnly={checked !== undefined} className={`${inputClass} w-56`} autoComplete="off" spellCheck={false} />
        <Button type="submit">{checked === undefined ? 'Comprobar' : 'Siguiente'}</Button>
        <Score {...score} />
      </form>
      {checked !== undefined && <Feedback ok={checked} titulo={checked ? 'Correcto' : `La respuesta es ${ex.to === 2 ? groupBits(ex.respuesta) : ex.respuesta}`} pasos={ex.pasos} />}
    </div>
  )
}

/** Conversor entre binario, octal, decimal y hexadecimal, con explicación y práctica. */
export function BaseConverter({ modo = 'convertir', tipos }: { modo?: 'convertir' | 'practicar'; tipos?: ConversionKind[] }) {
  const [mode, setMode] = useState(modo)
  return (
    <Frame
      titulo="Sistemas numéricos"
      acciones={
        <>
          <Chip active={mode === 'convertir'} onClick={() => setMode('convertir')}>
            Convertir
          </Chip>
          <Chip active={mode === 'practicar'} onClick={() => setMode('practicar')}>
            Practicar
          </Chip>
        </>
      }
    >
      {mode === 'convertir' ? <Converter /> : <Practice tipos={tipos} />}
    </Frame>
  )
}
