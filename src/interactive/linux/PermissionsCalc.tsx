import { useMemo, useState } from 'react'
import { applyUmask, checkPermAnswer, explainMode, fromSymbolic, generatePermExercise, parseOctal, toOctal, toSymbolic, type PermExercise, type PermExerciseKind } from '@/engines/linux/permissions'
import { cn } from '@/lib/cn'
import { createRng } from '@/lib/random'
import { Button } from '@/ui'
import { Chip, Feedback, Frame, inputClass, Score } from '../fundamentos/Frame'

const CLASSES = [
  { label: 'Dueño', shift: 6 },
  { label: 'Grupo', shift: 3 },
  { label: 'Resto', shift: 0 },
]
const BITS = [
  { label: 'r', name: 'leer', value: 4 },
  { label: 'w', name: 'escribir', value: 2 },
  { label: 'x', name: 'ejecutar', value: 1 },
]
const SPECIAL = [
  { label: 'SUID', value: 0o4000 },
  { label: 'SGID', value: 0o2000 },
  { label: 'Sticky', value: 0o1000 },
]

function Calculator() {
  const [mode, setMode] = useState(0o640)
  const [isDir, setIsDir] = useState(false)
  const [text, setText] = useState('640')
  const [umask, setUmask] = useState('0022')
  const sym = toSymbolic(mode)
  const umaskValue = parseOctal(umask)
  const update = (m: number) => {
    setMode(m)
    setText(toOctal(m))
  }
  const fromText = (t: string) => {
    setText(t)
    const n = parseOctal(t) ?? fromSymbolic(t)
    if (n !== null) setMode(n)
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Permisos de</span>
        <Chip active={!isDir} onClick={() => setIsDir(false)}>
          un archivo
        </Chip>
        <Chip active={isDir} onClick={() => setIsDir(true)}>
          una carpeta
        </Chip>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[320px] text-center text-sm">
          <thead>
            <tr>
              <th className="p-1 text-left text-muted" />
              {BITS.map((b) => (
                <th key={b.label} className="p-1 font-mono">
                  {b.label} <span className="font-sans text-xs font-normal text-muted">({b.value})</span>
                </th>
              ))}
              <th className="p-1 text-muted">Octal</th>
            </tr>
          </thead>
          <tbody>
            {CLASSES.map((c) => (
              <tr key={c.label} className="border-t border-line">
                <th className="p-1 text-left font-medium">{c.label}</th>
                {BITS.map((b) => {
                  const bit = b.value << c.shift
                  const on = (mode & bit) !== 0
                  return (
                    <td key={b.label} className="p-1">
                      <button
                        type="button"
                        aria-pressed={on}
                        aria-label={`${c.label}: ${b.name}`}
                        onClick={() => update(mode ^ bit)}
                        className={cn('h-10 w-12 rounded-lg border font-mono font-semibold transition', on ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface-2 text-muted hover:border-accent')}
                      >
                        {on ? b.label : '-'}
                      </button>
                    </td>
                  )
                })}
                <td className="p-1 font-mono text-lg font-bold">{(mode >> c.shift) & 7}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Bits especiales:</span>
        {SPECIAL.map((s) => (
          <Chip key={s.label} active={(mode & s.value) !== 0} onClick={() => update(mode ^ s.value)}>
            {s.label}
          </Chip>
        ))}
      </div>
      <label className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">O escribe los permisos (640 o rw-r-----):</span>
        <input value={text} onChange={(e) => fromText(e.target.value)} className={`${inputClass} w-40`} aria-label="Permisos en octal o en notación de ls" />
      </label>
      <dl className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg bg-surface-2 px-3 py-2">
          <dt className="text-xs text-muted">Octal</dt>
          <dd className="font-mono text-lg font-semibold">{toOctal(mode)}</dd>
        </div>
        <div className="rounded-lg bg-surface-2 px-3 py-2">
          <dt className="text-xs text-muted">Como lo muestra ls -l</dt>
          <dd className="font-mono text-lg font-semibold">
            {isDir ? 'd' : '-'}
            {sym}
          </dd>
        </div>
        <div className="rounded-lg bg-surface-2 px-3 py-2">
          <dt className="text-xs text-muted">Comando</dt>
          <dd className="break-all font-mono font-semibold">chmod {toOctal(mode)} {isDir ? 'carpeta' : 'archivo'}</dd>
        </div>
      </dl>
      <ul className="list-disc space-y-0.5 pl-5 text-sm">
        {explainMode(mode, isDir).map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      <div className="rounded-lg border border-line p-3 text-sm">
        <label className="flex flex-wrap items-center gap-2">
          <span className="font-medium">umask</span>
          <input value={umask} onChange={(e) => setUmask(e.target.value)} className={`${inputClass} w-24`} aria-label="umask" />
        </label>
        {umaskValue === null ? (
          <p className="mt-2 text-bad">Escribe una umask en octal, por ejemplo 0022.</p>
        ) : (
          <p className="mt-2">
            Un archivo nuevo se crea con <b className="font-mono">{toOctal(applyUmask(umaskValue, false))}</b> ({toSymbolic(applyUmask(umaskValue, false))}) y una carpeta nueva con{' '}
            <b className="font-mono">{toOctal(applyUmask(umaskValue, true))}</b> ({toSymbolic(applyUmask(umaskValue, true))}).
          </p>
        )}
      </div>
    </div>
  )
}

const KIND_NAMES: Record<PermExerciseKind, string> = {
  'sim-oct': 'De rwx a octal',
  'oct-sim': 'De octal a rwx',
  umask: 'umask',
  acceso: '¿Quién puede?',
}

function Practice({ tipos }: { tipos: PermExerciseKind[] }) {
  const rng = useMemo(() => createRng(), [])
  const [kinds, setKinds] = useState<PermExerciseKind[]>(tipos)
  const [ex, setEx] = useState<PermExercise>(() => generatePermExercise(rng, tipos))
  const [answer, setAnswer] = useState('')
  const [result, setResult] = useState<boolean | null>(null)
  const [score, setScore] = useState({ correct: 0, total: 0, streak: 0 })
  const submit = (value = answer) => {
    if (result !== null || !value.trim()) return
    const ok = checkPermAnswer(ex, value)
    setResult(ok)
    setScore((s) => ({ correct: s.correct + (ok ? 1 : 0), total: s.total + 1, streak: ok ? s.streak + 1 : 0 }))
  }
  const next = () => {
    setEx(generatePermExercise(rng, kinds))
    setAnswer('')
    setResult(null)
  }
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        {tipos.map((k) => (
          <Chip key={k} active={kinds.includes(k)} onClick={() => setKinds((ks) => (ks.includes(k) ? (ks.length > 1 ? ks.filter((x) => x !== k) : ks) : [...ks, k]))}>
            {KIND_NAMES[k]}
          </Chip>
        ))}
      </div>
      <p className="font-medium">{ex.pregunta}</p>
      {ex.contexto && (
        <pre className="mt-2 overflow-x-auto rounded-lg p-3 font-mono text-sm" style={{ background: 'var(--term-bg)', color: 'var(--term-fg)' }}>
          {ex.contexto}
        </pre>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {ex.opciones ? (
          ex.opciones.map((o) => (
            <Button
              key={o}
              variant={result !== null && o === ex.respuesta ? 'primary' : 'secondary'}
              disabled={result !== null}
              onClick={() => {
                setAnswer(o)
                submit(o)
              }}
            >
              {o === 'si' ? 'Sí, puede' : 'No puede'}
            </Button>
          ))
        ) : (
          <>
            <input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (result === null ? submit() : next())}
              className={`${inputClass} w-40`}
              aria-label="Tu respuesta"
              disabled={result !== null}
            />
            {result === null && <Button onClick={() => submit()}>Comprobar</Button>}
          </>
        )}
        {result !== null && (
          <Button variant="secondary" onClick={next}>
            Otro ejercicio
          </Button>
        )}
      </div>
      {result !== null && <Feedback ok={result} titulo={result ? 'Correcto' : `La respuesta era ${ex.respuesta === 'si' ? 'sí' : ex.respuesta}`} pasos={ex.pasos} />}
      <div className="mt-3">
        <Score {...score} />
      </div>
    </div>
  )
}

/** Calculadora de permisos de Linux con modo práctica. */
export function PermissionsCalc({ modo = 'calcular', tipos = ['sim-oct', 'oct-sim', 'umask', 'acceso'] }: { modo?: 'calcular' | 'practicar'; tipos?: PermExerciseKind[] }) {
  const [tab, setTab] = useState(modo)
  return (
    <Frame
      titulo="Calculadora de permisos"
      acciones={
        <>
          <Chip active={tab === 'calcular'} onClick={() => setTab('calcular')}>
            Calcular
          </Chip>
          <Chip active={tab === 'practicar'} onClick={() => setTab('practicar')}>
            Practicar
          </Chip>
        </>
      }
    >
      {tab === 'calcular' ? <Calculator /> : <Practice tipos={tipos} />}
    </Frame>
  )
}
