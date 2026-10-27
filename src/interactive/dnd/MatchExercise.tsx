import { useState } from 'react'
import type { MatchExercise as Exercise } from '@/content/exercise-schemas'
import { cn } from '@/lib/cn'
import { createRng, shuffle } from '@/lib/random'
import { Button, Callout, Icon, RichText } from '@/ui'

const PAIR_COLORS = ['#0ea5e9', '#f59e0b', '#8b5cf6', '#10b981', '#ef4444', '#ec4899', '#14b8a6', '#6366f1', '#84cc16', '#f97316']

/**
 * Emparejar conceptos: se toca un elemento de la izquierda y luego su pareja de la derecha.
 * Funciona igual con mouse, pantalla táctil y teclado.
 */
export function MatchExercise({ exercise, onComplete }: { exercise: Exercise; onComplete?: () => void }) {
  const n = exercise.pares.length
  const [rightOrder, setRightOrder] = useState(() => shuffle(createRng(Date.now()), Array.from({ length: n }, (_, i) => i)))
  // pairs[izquierda] = derecha
  const [pairs, setPairs] = useState<(number | undefined)[]>(() => Array(n).fill(undefined))
  const [selectedLeft, setSelectedLeft] = useState<number | undefined>()
  const [checked, setChecked] = useState(false)

  const colorOf = (left: number) => PAIR_COLORS[left % PAIR_COLORS.length]
  const leftOfRight = (right: number) => pairs.findIndex((p) => p === right)
  const allPaired = pairs.every((p) => p !== undefined)
  const correctCount = pairs.filter((p, i) => p === i).length

  const pickRight = (right: number) => {
    if (selectedLeft === undefined) return
    setPairs((ps) => ps.map((p, i) => (i === selectedLeft ? right : p === right ? undefined : p)))
    setSelectedLeft(undefined)
    setChecked(false)
  }

  return (
    <div className="my-6 rounded-xl border border-line bg-surface p-4 shadow-card">
      <div className="mb-3 flex items-start gap-2">
        <Icon name="layers" className="mt-0.5 text-accent" />
        <RichText text={exercise.consigna} className="font-medium" />
      </div>
      <p className="mb-3 text-xs text-muted">Toca un elemento de la izquierda y después su pareja de la derecha. Para deshacer, vuelve a tocarlo.</p>
      <div className="grid grid-cols-2 gap-3">
        <ul className="space-y-2">
          {exercise.pares.map((p, i) => {
            const paired = pairs[i] !== undefined
            const ok = checked && pairs[i] === i
            const bad = checked && paired && pairs[i] !== i
            return (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => {
                    if (paired && selectedLeft !== i) {
                      setPairs((ps) => ps.map((x, j) => (j === i ? undefined : x)))
                      setChecked(false)
                    }
                    setSelectedLeft(selectedLeft === i ? undefined : i)
                  }}
                  aria-pressed={selectedLeft === i}
                  className={cn(
                    'flex min-h-11 w-full items-center gap-2 rounded-lg border-2 px-3 py-2 text-left text-sm transition',
                    selectedLeft === i ? 'border-accent bg-accent-soft' : ok ? 'border-ok bg-ok-soft' : bad ? 'border-bad bg-bad-soft' : 'border-line hover:bg-surface-2',
                  )}
                >
                  {paired && <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: colorOf(i) }} aria-hidden />}
                  <span className="flex-1">{p.a}</span>
                </button>
              </li>
            )
          })}
        </ul>
        <ul className="space-y-2">
          {rightOrder.map((r) => {
            const left = leftOfRight(r)
            return (
              <li key={r}>
                <button
                  type="button"
                  onClick={() => pickRight(r)}
                  disabled={selectedLeft === undefined}
                  className={cn('flex min-h-11 w-full items-center gap-2 rounded-lg border-2 px-3 py-2 text-left text-sm transition disabled:cursor-default', selectedLeft !== undefined ? 'border-dashed border-accent/60 hover:bg-accent-soft' : 'border-line')}
                >
                  {left !== -1 && <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: colorOf(left) }} aria-label={`emparejado con ${exercise.pares[left].a}`} />}
                  <span className="flex-1">{exercise.pares[r].b}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          disabled={!allPaired}
          onClick={() => {
            setChecked(true)
            if (correctCount === n) onComplete?.()
          }}
        >
          Comprobar
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setPairs(Array(n).fill(undefined))
            setRightOrder(shuffle(createRng(Date.now()), Array.from({ length: n }, (_, i) => i)))
            setChecked(false)
          }}
        >
          <Icon name="refresh" className="h-4 w-4" />
          Empezar de nuevo
        </Button>
        {checked && correctCount < n && (
          <Button variant="ghost" onClick={() => setPairs(exercise.pares.map((_, i) => i))}>
            Ver las parejas correctas
          </Button>
        )}
      </div>
      {checked && (
        <Callout tone={correctCount === n ? 'ok' : 'warn'} className="mt-3" title={correctCount === n ? '¡Todas las parejas son correctas!' : `${correctCount} de ${n} parejas correctas`}>
          {correctCount === n ? exercise.explicacion ? <RichText text={exercise.explicacion} /> : 'Bien hecho.' : 'Las parejas en rojo no coinciden. Tócalas para deshacerlas y probar otra vez.'}
        </Callout>
      )}
    </div>
  )
}
