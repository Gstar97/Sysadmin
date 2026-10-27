import { useState } from 'react'
import type { OrderExercise as Exercise } from '@/content/exercise-schemas'
import { createRng, shuffle } from '@/lib/random'
import { Button, Callout, Icon, RichText } from '@/ui'
import { SortableList } from './SortableList'

function shuffledOrder(n: number): number[] {
  const ids = Array.from({ length: n }, (_, i) => i)
  const rng = createRng(Date.now())
  let order = shuffle(rng, ids)
  // Que nunca empiece ya ordenado.
  while (order.every((v, i) => v === i)) order = shuffle(rng, ids)
  return order
}

/** Ordenar pasos arrastrando. Los pasos se escriben en el orden correcto y se mezclan al mostrarse. */
export function OrderExercise({ exercise, onComplete }: { exercise: Exercise; onComplete?: () => void }) {
  const [order, setOrder] = useState(() => shuffledOrder(exercise.pasos.length))
  const [checked, setChecked] = useState(false)
  const [attempts, setAttempts] = useState(0)
  const correct = order.every((v, i) => v === i)

  return (
    <div className="my-6 rounded-xl border border-line bg-surface p-4 shadow-card">
      <div className="mb-3 flex items-start gap-2">
        <Icon name="layers" className="mt-0.5 text-accent" />
        <RichText text={exercise.consigna} className="font-medium" />
      </div>
      <SortableList
        order={order}
        disabled={checked && correct}
        onChange={(o) => {
          setOrder(o)
          setChecked(false)
        }}
        itemClassName={(id, index) => (checked ? (id === index ? 'border-ok bg-ok-soft' : 'border-bad bg-bad-soft') : undefined)}
        render={(id) => <span>{exercise.pasos[id]}</span>}
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!(checked && correct) && (
          <Button
            onClick={() => {
              setChecked(true)
              setAttempts((a) => a + 1)
              if (correct) onComplete?.()
            }}
          >
            Comprobar
          </Button>
        )}
        {checked && !correct && (
          <Button
            variant="ghost"
            onClick={() => {
              setOrder(exercise.pasos.map((_, i) => i))
              setChecked(true)
            }}
          >
            Ver el orden correcto
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => {
            setOrder(shuffledOrder(exercise.pasos.length))
            setChecked(false)
          }}
        >
          <Icon name="refresh" className="h-4 w-4" />
          Mezclar de nuevo
        </Button>
      </div>
      {checked && (
        <Callout tone={correct ? 'ok' : 'warn'} className="mt-3" title={correct ? (attempts === 1 ? '¡Perfecto al primer intento!' : '¡Ordenado correctamente!') : 'Todavía hay pasos fuera de lugar'}>
          {correct ? exercise.explicacion ? <RichText text={exercise.explicacion} /> : 'Ese es el orden correcto.' : 'Los pasos en rojo no están en su lugar. Puedes moverlos y volver a comprobar.'}
        </Callout>
      )}
    </div>
  )
}
