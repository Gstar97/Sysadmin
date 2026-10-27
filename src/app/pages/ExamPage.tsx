import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { content, getLesson, getModule, loadQuestionBank } from '@/content'
import { buildModuleExam, type ExamQuestion } from '@/engines/assessment/sampling'
import { cn, percent } from '@/lib/cn'
import { createRng } from '@/lib/random'
import { QuizReview, QuizRunner, type QuizResult } from '@/interactive/quiz/QuizRunner'
import { accuracyByLesson, examKindFor, isExamAvailable, lessonsToReview, passThreshold } from '@/progress/rules'
import { useProgress } from '@/progress/store'
import { Button, ButtonLink, Callout, Card, EmptyState, Icon, PageHeader, Spinner } from '@/ui'
import NotFoundPage from './NotFoundPage'

type Phase = { name: 'intro' } | { name: 'loading' } | { name: 'running'; questions: ExamQuestion[]; seed: number } | { name: 'done'; result: QuizResult; passed: boolean }

export default function ExamPage() {
  const { moduleId = '' } = useParams()
  const mod = getModule(moduleId)
  const snap = useProgress((s) => s.snap)
  const recordExam = useProgress((s) => s.recordExam)
  const [phase, setPhase] = useState<Phase>({ name: 'intro' })
  const [kindAtStart, setKindAtStart] = useState<'examen' | 'salteo'>('examen')
  if (!mod) return <NotFoundPage message="Ese módulo no existe." />
  const level = content.levels.find((l) => l.id === mod.levelId)!
  const kind = phase.name === 'intro' ? examKindFor(mod, snap) : kindAtStart
  const threshold = passThreshold(kind)

  const start = async () => {
    setKindAtStart(examKindFor(mod, snap))
    setPhase({ name: 'loading' })
    const banks = await Promise.all(
      mod.lessons.map(async (l) => ({ lessonId: l.id, weight: l.minutos, bank: await loadQuestionBank(l) })),
    )
    const seen = new Set(snap.attempts.flatMap((a) => a.answers.map((x) => x.questionKey)))
    const seed = Date.now()
    setPhase({ name: 'running', seed, questions: buildModuleExam(createRng(seed), banks, mod.examen.preguntas, seen) })
  }

  const finish = async (result: QuizResult) => {
    const { passed } = await recordExam({
      moduleId: mod.id,
      kind: kindAtStart,
      score: result.score,
      durationSeconds: result.durationSeconds,
      answers: result.answers.map((a) => ({
        questionKey: a.key,
        lessonId: a.lessonId,
        correct: a.result.correct,
        tags: a.question.etiquetas,
      })),
    })
    setPhase({ name: 'done', result, passed })
    window.scrollTo(0, 0)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        eyebrow={
          <Link to={`/modulo/${mod.id}`} className="text-accent">
            {mod.numero} {mod.titulo}
          </Link>
        }
        title={kind === 'salteo' ? 'Examen de salteo' : 'Examen del módulo'}
      >
        Nivel {level.numero}: {level.titulo}
      </PageHeader>

      {!isExamAvailable(mod) ? (
        <EmptyState title="El examen todavía no está disponible">Se habilita cuando el módulo esté publicado completo.</EmptyState>
      ) : phase.name === 'intro' ? (
        <Card className="space-y-4">
          <ul className="space-y-2">
            <li className="flex gap-2">
              <Icon name="target" className="mt-0.5 h-4 w-4 text-accent" />
              {mod.examen.preguntas} preguntas tomadas al azar de las {mod.lessons.length} lecciones del módulo, con prioridad para las
              que todavía no se vieron.
            </li>
            <li className="flex gap-2">
              <Icon name="check" className="mt-0.5 h-4 w-4 text-accent" />
              Se aprueba con {percent(threshold)} o más.
            </li>
            <li className="flex gap-2">
              <Icon name="clock" className="mt-0.5 h-4 w-4 text-accent" />
              Sin límite de tiempo. Se puede ir y volver entre preguntas antes de entregar.
            </li>
          </ul>
          {kind === 'salteo' && (
            <Callout tone="warn" title="Cuenta como examen de salteo">
              Como todavía no están completas todas las lecciones, este examen sirve para saltear el módulo: con 85% o más queda
              completado. Si no se alcanza, la plataforma recomienda solo las lecciones de los temas que fallaron.
            </Callout>
          )}
          <Button onClick={() => void start()}>Empezar el examen</Button>
        </Card>
      ) : phase.name === 'loading' ? (
        <Spinner label="Armando el examen…" />
      ) : phase.name === 'running' ? (
        <QuizRunner questions={phase.questions} mode="examen" seed={phase.seed} onFinish={(r) => void finish(r)} />
      ) : (
        <ExamResults result={phase.result} passed={phase.passed} threshold={passThreshold(kindAtStart)} kind={kindAtStart} moduleId={mod.id} onRetry={() => setPhase({ name: 'intro' })} />
      )}
    </div>
  )
}

function ExamResults({
  result,
  passed,
  threshold,
  kind,
  moduleId,
  onRetry,
}: {
  result: QuizResult
  passed: boolean
  threshold: number
  kind: 'examen' | 'salteo'
  moduleId: string
  onRetry: () => void
}) {
  const byLesson = accuracyByLesson({
    answers: result.answers.map((a) => ({ questionKey: a.key, lessonId: a.lessonId, correct: a.result.correct, tags: [] })),
  })
  const review = lessonsToReview({
    answers: result.answers.map((a) => ({ questionKey: a.key, lessonId: a.lessonId, correct: a.result.correct, tags: [] })),
  })
  return (
    <div className="space-y-6">
      <Card className={cn('border-2 text-center', passed ? 'border-ok' : 'border-bad')}>
        <div className={cn('text-5xl font-extrabold', passed ? 'text-ok' : 'text-bad')}>{percent(result.score)}</div>
        <div className="mt-2 text-lg font-semibold">
          {passed ? (kind === 'salteo' ? 'Aprobado: el módulo quedó completado' : 'Examen aprobado') : 'Todavía no alcanza'}
        </div>
        <p className="mt-1 text-muted">
          {result.answers.filter((a) => a.result.correct).length} de {result.answers.length} correctas · se necesitaba {percent(threshold)}
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <ButtonLink to={`/modulo/${moduleId}`}>Volver al módulo</ButtonLink>
          {!passed && (
            <Button variant="secondary" onClick={onRetry}>
              Rendir de nuevo
            </Button>
          )}
        </div>
      </Card>

      {!passed && review.length > 0 && (
        <Callout tone="info" title="Lecciones recomendadas antes de volver a rendir">
          <ul className="list-disc pl-5">
            {review.map((id) => (
              <li key={id}>
                <Link to={`/leccion/${id}`} className="text-accent">
                  {getLesson(id)?.titulo ?? id}
                </Link>
              </li>
            ))}
          </ul>
        </Callout>
      )}

      <Card>
        <h2 className="mb-3 font-semibold">Resultado por lección</h2>
        <ul className="space-y-2 text-sm">
          {byLesson.map((s) => (
            <li key={s.lessonId} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate">{getLesson(s.lessonId)?.titulo ?? s.lessonId}</span>
              <span className={cn('shrink-0 font-semibold', s.ratio >= 0.7 ? 'text-ok' : 'text-bad')}>
                {s.correct}/{s.total}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Corrección con explicaciones</h2>
        <QuizReview answers={result.answers} />
      </section>
    </div>
  )
}
