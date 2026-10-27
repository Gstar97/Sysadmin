import { Link } from 'react-router'
import { allLessons, getLesson } from '@/content'
import { formatDate } from '@/lib/cn'
import { useProgress } from '@/progress/store'
import { Button, Card, EmptyState, Icon, PageHeader } from '@/ui'

export default function NotesPage() {
  const notes = useProgress((s) => s.snap.notes)
  const saveNote = useProgress((s) => s.saveNote)
  const order = new Map(allLessons.map((l, i) => [l.id, i]))
  const list = Object.values(notes).sort((a, b) => (order.get(a.lessonId) ?? 1e9) - (order.get(b.lessonId) ?? 1e9))

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader eyebrow="Notas personales" title="Mis notas">
        Las notas se escriben al final de cada lección y quedan guardadas en este navegador.
      </PageHeader>
      {list.length === 0 ? (
        <EmptyState title="Todavía no hay notas">Al final de cada lección hay un espacio para anotar lo que convenga recordar.</EmptyState>
      ) : (
        <div className="space-y-4">
          {list.map((n) => {
            const lesson = getLesson(n.lessonId)
            return (
              <Card key={n.lessonId}>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <Link to={`/leccion/${n.lessonId}#notas`} className="font-semibold text-accent">
                    {lesson ? `${lesson.numero} ${lesson.titulo}` : n.lessonId}
                  </Link>
                  <span className="text-xs text-muted">Actualizada el {formatDate(n.updatedAt)}</span>
                </div>
                <p className="whitespace-pre-wrap">{n.text}</p>
                <div className="mt-3 text-right">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (confirm('¿Borrar esta nota?')) void saveNote(n.lessonId, '')
                    }}
                  >
                    <Icon name="trash" className="h-4 w-4" /> Borrar
                  </Button>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
