import { useState } from 'react'
import { formatInterval, GRADE_LABELS, previewIntervals, type ReviewGrade } from '@/engines/srs'
import type { CardState } from '@/progress/types'
import { Button, Card, RichText } from '@/ui'

export interface ReviewItem {
  key: string
  frente: string
  dorso: string
  origen?: string
  state: CardState
}

const GRADES: ReviewGrade[] = ['otra_vez', 'dificil', 'bien', 'facil']

/** Repaso de tarjetas: frente, mostrar respuesta y calificar qué tan fácil fue recordarla. */
export function FlashcardReview({
  items,
  onGrade,
  onDone,
}: {
  items: ReviewItem[]
  onGrade: (key: string, grade: ReviewGrade) => void | Promise<void>
  onDone?: () => void
}) {
  const [index, setIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [reviewed, setReviewed] = useState(0)
  const item = items[index]

  if (!item) {
    return (
      <Card className="text-center">
        <div className="text-lg font-semibold">Repaso terminado</div>
        <p className="mt-1 text-muted">
          {reviewed} {reviewed === 1 ? 'tarjeta repasada' : 'tarjetas repasadas'}. Las próximas aparecen cuando les toque.
        </p>
        {onDone && (
          <Button className="mt-4" onClick={onDone}>
            Volver
          </Button>
        )}
      </Card>
    )
  }

  const intervals = previewIntervals(item.state)
  const grade = async (g: ReviewGrade) => {
    await onGrade(item.key, g)
    setReviewed((r) => r + 1)
    setFlipped(false)
    setIndex((i) => i + 1)
  }

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted">
        Tarjeta {index + 1} de {items.length}
        {item.origen && <> · {item.origen}</>}
      </div>
      <Card className="min-h-48">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Pregunta</div>
        <RichText text={item.frente} className="mt-2 text-lg" />
        {flipped && (
          <div className="mt-5 border-t border-line pt-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">Respuesta</div>
            <RichText text={item.dorso} className="mt-2" />
          </div>
        )}
      </Card>
      {!flipped ? (
        <Button className="w-full" onClick={() => setFlipped(true)}>
          Mostrar respuesta
        </Button>
      ) : (
        <div>
          <p className="mb-2 text-sm text-muted">¿Qué tan fácil fue recordarla?</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {GRADES.map((g) => (
              <Button key={g} variant={g === 'bien' ? 'primary' : 'secondary'} onClick={() => void grade(g)} className="flex-col gap-0">
                <span>{GRADE_LABELS[g]}</span>
                <span className="text-xs opacity-80">{formatInterval(intervals[g])}</span>
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
