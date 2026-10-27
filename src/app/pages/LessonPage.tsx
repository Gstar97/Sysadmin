import { useEffect, useRef, useState, type ComponentType } from 'react'
import { Link, useParams } from 'react-router'
import { getLevel, getModule, getLesson, lessonNeighbors, loadFlashcards, loadLessonComponent, loadQuestionBank, type LessonEntry } from '@/content'
import { pickMiniTest, type ExamQuestion } from '@/engines/assessment/sampling'
import { QuizReview, QuizRunner, type QuizResult } from '@/interactive/quiz/QuizRunner'
import { cn, percent } from '@/lib/cn'
import { createRng } from '@/lib/random'
import { LESSON_PASS } from '@/progress/rules'
import { useProgress } from '@/progress/store'
import { useActiveTime } from '@/progress/useActiveTime'
import { Badge, Button, ButtonLink, Callout, Card, Icon, Spinner } from '@/ui'
import { LessonStatusIcon } from '../components/status'
import { LessonContext, mdxComponents } from '../mdx/components'
import NotFoundPage from './NotFoundPage'

type Mdx = ComponentType<{ components?: Record<string, unknown> }>

function newSeed() {
  return Date.now()
}

export default function LessonPage() {
  const { lessonId = '' } = useParams()
  const lesson = getLesson(lessonId)
  if (!lesson) return <NotFoundPage message="Esa lección no existe o todavía no está publicada." />
  return <Lesson key={lesson.id} lesson={lesson} />
}

function Lesson({ lesson }: { lesson: LessonEntry }) {
  const mod = getModule(lesson.moduleId)!
  const level = getLevel(lesson.levelId)!
  const progress = useProgress((s) => s.snap.lessons[lesson.id])
  const touchLesson = useProgress((s) => s.touchLesson)
  const [Body, setBody] = useState<Mdx | null>(null)
  const [loadError, setLoadError] = useState<string>()
  const { prev, next } = lessonNeighbors(lesson.id)
  useActiveTime(lesson.id)

  useEffect(() => {
    void touchLesson(lesson.id)
    let cancelled = false
    loadLessonComponent(lesson)
      .then((c) => !cancelled && setBody(() => c))
      .catch((e: Error) => !cancelled && setLoadError(e.message))
    return () => {
      cancelled = true
    }
  }, [lesson, touchLesson])

  const toc = [
    ...lesson.secciones,
    { titulo: 'Errores comunes', slug: 'errores-comunes' },
    { titulo: 'Resumen', slug: 'resumen' },
    { titulo: 'Mini test', slug: 'mini-test' },
    { titulo: 'Mis notas', slug: 'notas' },
  ].filter((s, i, arr) => arr.findIndex((x) => x.slug === s.slug) === i)

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_15rem]">
      <div className="min-w-0">
        <nav className="mb-3 flex flex-wrap items-center gap-1 text-sm text-muted" aria-label="Ubicación">
          <Link to={`/nivel/${level.id}`} className="hover:text-accent">
            Nivel {level.numero}
          </Link>
          <Icon name="arrowRight" className="h-3.5 w-3.5" />
          <Link to={`/modulo/${mod.id}`} className="hover:text-accent">
            {mod.numero} {mod.titulo}
          </Link>
        </nav>
        <header className="mb-6">
          <h1 className="text-2xl font-bold leading-tight sm:text-3xl">
            {lesson.numero} {lesson.titulo}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="flex items-center gap-1.5">
              <LessonStatusIcon status={progress?.status} />
              {progress?.status === 'completada' ? 'Completada' : progress ? 'En curso' : 'Sin empezar'}
            </span>
            <Badge>
              <Icon name="clock" className="h-3.5 w-3.5" />
              {lesson.minutos} min
            </Badge>
            <Badge tone="info">Contenido verificado: {lesson.verificado}</Badge>
            {progress && progress.bestScore > 0 && <Badge tone={progress.bestScore >= LESSON_PASS ? 'ok' : 'warn'}>Mejor mini test: {percent(progress.bestScore)}</Badge>}
          </div>
          <Card className="mt-4">
            <div className="mb-2 flex items-center gap-2 font-semibold">
              <Icon name="target" className="text-accent" />
              Al terminar esta lección podrás:
            </div>
            <ul className="list-disc space-y-1 pl-5">
              {lesson.objetivos.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          </Card>
        </header>

        <details className="mb-6 rounded-xl border border-line lg:hidden">
          <summary className="cursor-pointer px-4 py-2 text-sm font-semibold">Contenido de la lección</summary>
          <Toc items={toc} />
        </details>

        <article className="prosa max-w-none" id="contenido-leccion">
          {loadError ? (
            <Callout tone="bad" title="No se pudo cargar la lección">
              {loadError}
            </Callout>
          ) : Body ? (
            <LessonContext.Provider value={{ lesson }}>
              <Body components={mdxComponents} />
            </LessonContext.Provider>
          ) : (
            <Spinner label="Cargando la lección…" />
          )}
        </article>

        <MiniTest lesson={lesson} />
        <NotesPanel lessonId={lesson.id} />

        <nav className="mt-10 grid gap-3 border-t border-line pt-6 sm:grid-cols-2" aria-label="Lecciones vecinas">
          {prev ? (
            <Link to={`/leccion/${prev.id}`} className="rounded-xl border border-line p-3 hover:border-accent">
              <div className="text-xs text-muted">Anterior</div>
              <div className="font-medium">
                {prev.numero} {prev.titulo}
              </div>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link to={`/leccion/${next.id}`} className="rounded-xl border border-line p-3 text-right hover:border-accent">
              <div className="text-xs text-muted">Siguiente</div>
              <div className="font-medium">
                {next.numero} {next.titulo}
              </div>
            </Link>
          ) : (
            <Link to={`/modulo/${mod.id}`} className="rounded-xl border border-line p-3 text-right hover:border-accent">
              <div className="text-xs text-muted">Fin del módulo</div>
              <div className="font-medium">Volver al módulo</div>
            </Link>
          )}
        </nav>
      </div>
      <aside className="hidden lg:block">
        <div className="sticky top-20">
          <div className="mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-muted">En esta lección</div>
          <Toc items={toc} />
        </div>
      </aside>
    </div>
  )
}

function Toc({ items }: { items: { titulo: string; slug: string }[] }) {
  const [active, setActive] = useState<string>()
  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActive(visible[0].target.id)
      },
      { rootMargin: '-80px 0px -60% 0px' },
    )
    const timer = window.setTimeout(() => {
      for (const it of items) {
        const el = document.getElementById(it.slug)
        if (el) obs.observe(el)
      }
    }, 500)
    return () => {
      window.clearTimeout(timer)
      obs.disconnect()
    }
  }, [items])
  return (
    <ul className="space-y-0.5 px-1 pb-2 text-sm">
      {items.map((it) => (
        <li key={it.slug}>
          <a href={`#${it.slug}`} className={cn('block rounded-md px-2 py-1 hover:bg-surface-2', active === it.slug ? 'font-medium text-accent' : 'text-muted')}>
            {it.titulo}
          </a>
        </li>
      ))}
    </ul>
  )
}

type MiniPhase = { name: 'intro' } | { name: 'loading' } | { name: 'running'; questions: ExamQuestion[]; seed: number } | { name: 'done'; result: QuizResult; passed: boolean; newlyCompleted: boolean; cards: number }

function MiniTest({ lesson }: { lesson: LessonEntry }) {
  const [phase, setPhase] = useState<MiniPhase>({ name: 'intro' })
  const recordMiniTest = useProgress((s) => s.recordMiniTest)
  const best = useProgress((s) => s.snap.lessons[lesson.id]?.bestScore ?? 0)
  const attempts = useProgress((s) => s.snap.lessons[lesson.id]?.attempts ?? 0)
  const section = useRef<HTMLElement>(null)

  const start = async () => {
    setPhase({ name: 'loading' })
    const bank = await loadQuestionBank(lesson)
    const seed = newSeed()
    setPhase({ name: 'running', seed, questions: pickMiniTest(createRng(seed), { lessonId: lesson.id, weight: lesson.minutos, bank }, lesson.miniTest) })
  }

  const finish = async (result: QuizResult) => {
    const cards = await loadFlashcards(lesson)
    const { passed, newlyCompleted } = await recordMiniTest({
      lessonId: lesson.id,
      score: result.score,
      durationSeconds: result.durationSeconds,
      cardIds: cards.map((c) => c.id),
      answers: result.answers.map((a) => ({ questionKey: a.key, lessonId: a.lessonId, correct: a.result.correct, tags: a.question.etiquetas })),
    })
    setPhase({ name: 'done', result, passed, newlyCompleted, cards: cards.length })
    section.current?.scrollIntoView({ block: 'start' })
  }

  return (
    <section ref={section} id="mini-test" className="mt-12 scroll-mt-20" aria-labelledby="mini-test-titulo">
      <h2 id="mini-test-titulo" className="mb-3 flex items-center gap-2 text-[1.45rem] font-bold">
        <Icon name="check" className="text-accent" />
        Mini test
      </h2>
      {phase.name === 'intro' && (
        <Card className="space-y-3">
          <p>
            {lesson.miniTest} preguntas del banco de la lección, mezcladas en cada intento. Cada respuesta se corrige en el momento y muestra por qué cada opción es correcta o
            incorrecta. Con {percent(LESSON_PASS)} o más la lección queda completada y sus tarjetas de repaso se suman al mazo.
          </p>
          {attempts > 0 && (
            <p className="text-sm text-muted">
              Intentos: {attempts} · mejor resultado: {percent(best)}
            </p>
          )}
          <Button onClick={() => void start()}>{attempts > 0 ? 'Hacer otro intento' : 'Empezar el mini test'}</Button>
        </Card>
      )}
      {phase.name === 'loading' && <Spinner label="Preparando las preguntas…" />}
      {phase.name === 'running' && <QuizRunner questions={phase.questions} mode="practica" seed={phase.seed} onFinish={(r) => void finish(r)} finishLabel="Terminar el mini test" />}
      {phase.name === 'done' && (
        <div className="space-y-4">
          <Card className={cn('border-2 text-center', phase.passed ? 'border-ok' : 'border-warn')}>
            <div className={cn('text-4xl font-extrabold', phase.passed ? 'text-ok' : 'text-warn')}>{percent(phase.result.score)}</div>
            <div className="mt-1 font-semibold">{phase.passed ? (phase.newlyCompleted ? '¡Lección completada!' : 'Aprobado') : `Hace falta ${percent(LESSON_PASS)} para completar la lección`}</div>
            {phase.newlyCompleted && phase.cards > 0 && <p className="mt-1 text-sm text-muted">Se sumaron {phase.cards} tarjetas de esta lección a tu mazo de repaso.</p>}
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button variant="secondary" onClick={() => void start()}>
                <Icon name="refresh" className="h-4 w-4" />
                Otro intento
              </Button>
              {phase.passed && phase.cards > 0 && (
                <ButtonLink to="/repaso" variant="ghost">
                  <Icon name="cards" className="h-4 w-4" />
                  Ir al repaso
                </ButtonLink>
              )}
            </div>
          </Card>
          <details>
            <summary className="cursor-pointer font-medium">Revisar las respuestas</summary>
            <div className="mt-3">
              <QuizReview answers={phase.result.answers} />
            </div>
          </details>
        </div>
      )}
    </section>
  )
}

function NotesPanel({ lessonId }: { lessonId: string }) {
  const saved = useProgress((s) => s.snap.notes[lessonId]?.text ?? '')
  const saveNote = useProgress((s) => s.saveNote)
  const [text, setText] = useState(saved)
  const [status, setStatus] = useState<'guardado' | 'escribiendo' | undefined>()
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const onChange = (value: string) => {
    setText(value)
    setStatus('escribiendo')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void saveNote(lessonId, value).then(() => setStatus('guardado'))
    }, 700)
  }

  return (
    <section id="notas" className="mt-12 scroll-mt-20" aria-labelledby="notas-titulo">
      <h2 id="notas-titulo" className="mb-3 flex items-center gap-2 text-[1.45rem] font-bold">
        <Icon name="note" className="text-accent" />
        Mis notas
      </h2>
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        rows={5}
        className="w-full rounded-xl border border-line bg-surface p-3 text-[0.97rem]"
        placeholder="Escribe lo que quieras recordar de esta lección: comandos, dudas, ideas. Se guarda solo en este navegador."
        aria-label="Notas personales de esta lección"
      />
      <div className="mt-1 flex justify-between text-xs text-muted">
        <span>{status === 'escribiendo' ? 'Guardando…' : status === 'guardado' ? 'Guardado' : ''}</span>
        <Link to="/notas" className="hover:text-accent">
          Ver todas mis notas
        </Link>
      </div>
    </section>
  )
}
