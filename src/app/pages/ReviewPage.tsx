import { useEffect, useState } from 'react'
import { getLesson, loadFlashcards } from '@/content'
import type { Flashcard } from '@/content/schemas'
import { dueCards } from '@/progress/rules'
import { useProgress } from '@/progress/store'
import { FlashcardReview, type ReviewItem } from '@/interactive/flashcards/FlashcardReview'
import { Button, EmptyState, PageHeader, Spinner } from '@/ui'

export default function ReviewPage() {
  const snap = useProgress((s) => s.snap)
  const review = useProgress((s) => s.review)
  const [items, setItems] = useState<ReviewItem[] | null>(null)
  const [session, setSession] = useState(0)
  const totalCards = Object.keys(snap.cards).length

  useEffect(() => {
    let cancelled = false
    const due = dueCards(useProgress.getState().snap).slice(0, useProgress.getState().snap.profile.dailyCardLimit)
    const lessonIds = [...new Set(due.map((c) => c.lessonId))]
    void Promise.all(
      lessonIds.map(async (id) => {
        const lesson = getLesson(id)
        return { id, cards: lesson ? await loadFlashcards(lesson) : [] }
      }),
    ).then((decks) => {
      if (cancelled) return
      const byKey = new Map<string, Flashcard>(decks.flatMap((d) => d.cards.map((c): [string, Flashcard] => [`${d.id}:${c.id}`, c])))
      setItems(
        due
          .map((state): ReviewItem | undefined => {
            const card = byKey.get(state.key)
            if (!card) return undefined
            const lesson = getLesson(state.lessonId)
            return { key: state.key, frente: card.frente, dorso: card.dorso, origen: lesson ? `${lesson.numero} ${lesson.titulo}` : undefined, state }
          })
          .filter((x): x is ReviewItem => !!x),
      )
    })
    return () => {
      cancelled = true
    }
  }, [session])

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader eyebrow="Repetición espaciada" title="Repaso de tarjetas">
        Cada tarjeta vuelve justo antes de que se olvide: las fáciles se espacian cada vez más y las difíciles aparecen seguido.
      </PageHeader>
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState title={totalCards ? 'No hay tarjetas pendientes por ahora' : 'Todavía no hay tarjetas'}>
          {totalCards
            ? `Hay ${totalCards} tarjetas en el mazo; las próximas vuelven cuando les toque.`
            : 'Las tarjetas de cada lección se suman al mazo al aprobar su mini test.'}
        </EmptyState>
      ) : (
        <FlashcardReview key={session} items={items} onGrade={review} />
      )}
      {items !== null && items.length > 0 && (
        <div className="mt-4 text-center">
          <Button variant="ghost" onClick={() => setSession((s) => s + 1)}>
            Recargar pendientes
          </Button>
        </div>
      )}
    </div>
  )
}
