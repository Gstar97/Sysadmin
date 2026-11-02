import { useMemo, useState } from 'react'
import { ADDRESS_KINDS, randomAddress, type AddressKind } from '@/engines/redes/addressing'
import { createRng } from '@/lib/random'
import { Button } from '@/ui'
import { Feedback, Frame, Score } from '../fundamentos/Frame'

/** ¿Qué tipo de dirección es? Ejercicios al azar con las trampas de siempre. */
export function AddressClassifier() {
  const rng = useMemo(() => createRng(), [])
  const [q, setQ] = useState(() => randomAddress(rng))
  const [answer, setAnswer] = useState<AddressKind>()
  const [stats, setStats] = useState({ correct: 0, total: 0, streak: 0 })
  const info = ADDRESS_KINDS.find((k) => k.id === q.kind)!
  const choose = (k: AddressKind) => {
    if (answer) return
    setAnswer(k)
    const ok = k === q.kind
    setStats((s) => ({ correct: s.correct + (ok ? 1 : 0), total: s.total + 1, streak: ok ? s.streak + 1 : 0 }))
  }
  return (
    <Frame titulo="¿Qué tipo de dirección es?">
      <div className="space-y-3">
        <Score {...stats} />
        <p className="text-center font-mono text-2xl font-semibold" aria-live="polite">
          {q.ip}
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {ADDRESS_KINDS.map((k) => (
            <Button key={k.id} variant={answer === k.id ? 'primary' : 'secondary'} onClick={() => choose(k.id)} disabled={!!answer}>
              {k.nombre}
            </Button>
          ))}
        </div>
        {answer && (
          <>
            <Feedback ok={answer === q.kind} titulo={answer === q.kind ? `¡Correcto! Es ${info.nombre.toLowerCase()}.` : `Es ${info.nombre.toLowerCase()}.`} pasos={[`Rango: ${info.rango}.`, info.explicacion, ...(q.ip.startsWith('172.') && q.kind === 'publica' ? ['Ojo: el rango privado 172.16.0.0/12 va de 172.16 a 172.31. 172.15 o 172.32 ya son públicas.'] : []), ...(q.ip.startsWith('100.') && q.kind === 'publica' ? ['Ojo: CGNAT es 100.64.0.0/10, o sea de 100.64 a 100.127. Fuera de eso, 100.x es pública.'] : [])]} />
            <Button
              onClick={() => {
                setQ(randomAddress(rng))
                setAnswer(undefined)
              }}
            >
              Otra dirección
            </Button>
          </>
        )}
      </div>
    </Frame>
  )
}
