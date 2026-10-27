import { useState } from 'react'
import { Link } from 'react-router'
import { content, loadQuestionBank } from '@/content'
import type { LevelEntry } from '@/content/types'
import { DIAGNOSTIC_LABELS, labelModules, levelStops, shouldStopEarly } from '@/engines/assessment/diagnostic'
import { buildDiagnosticLevel, type ExamQuestion } from '@/engines/assessment/sampling'
import { percent } from '@/lib/cn'
import { createRng } from '@/lib/random'
import { QuizRunner, type QuizResult } from '@/interactive/quiz/QuizRunner'
import { useProgress } from '@/progress/store'
import type { DiagnosticLabel } from '@/progress/types'
import { Badge, Button, ButtonLink, Callout, Card, EmptyState, PageHeader, Spinner } from '@/ui'

type Phase =
  | { name: 'intro' }
  | { name: 'loading'; level: LevelEntry }
  | { name: 'running'; level: LevelEntry; questions: (ExamQuestion & { moduleId: string })[]; seed: number }
  | { name: 'levelDone'; level: LevelEntry; score: number; stopped: boolean; labels: Record<string, DiagnosticLabel> }

const eligibleLevels = content.levels.filter((l) => l.modules.some((m) => m.lessons.some((x) => x.diagnosticas > 0)))

export default function DiagnosticPage() {
  const snap = useProgress((s) => s.snap)
  const { recordDiagnosticLevel, labelModules: saveLabels, resetDiagnostic } = useProgress.getState()
  const [phase, setPhase] = useState<Phase>({ name: 'intro' })
  const diag = snap.diagnostic
  const nextLevel = eligibleLevels.find((l) => !diag?.completedLevels.includes(l.id))
  const finished = !!diag?.finishedAt || (diag && !nextLevel)

  const startLevel = async (level: LevelEntry) => {
    setPhase({ name: 'loading', level })
    const modules = await Promise.all(
      level.modules.map(async (m) => ({
        moduleId: m.id,
        weight: m.horas,
        banks: await Promise.all(m.lessons.map(async (l) => ({ lessonId: l.id, weight: l.minutos, bank: await loadQuestionBank(l) }))),
      })),
    )
    const seed = Date.now()
    setPhase({ name: 'running', level, seed, questions: buildDiagnosticLevel(createRng(seed), modules, 10) })
  }

  const finishLevel = async (level: LevelEntry, questions: (ExamQuestion & { moduleId: string })[], result: QuizResult) => {
    const answers = result.answers.map((a, i) => ({ ...a, moduleId: questions[i].moduleId }))
    const results = answers.map((a) => a.result.correct)
    const stopped = levelStops(results)
    const labels = labelModules(answers.map((a) => ({ moduleId: a.moduleId, correct: a.result.correct })))
    const isLast = eligibleLevels.at(-1)?.id === level.id
    await recordDiagnosticLevel({
      levelId: level.id,
      score: result.score,
      stopped,
      finished: isLast,
      labels,
      answers: answers.map((a) => ({ questionKey: a.key, lessonId: a.lessonId, correct: a.result.correct, tags: a.question.etiquetas })),
    })
    if (stopped) {
      // Los niveles siguientes quedan como "estudiar".
      const idx = content.levels.findIndex((l) => l.id === level.id)
      const rest: Record<string, DiagnosticLabel> = {}
      for (const l of content.levels.slice(idx + 1)) for (const m of l.modules) rest[m.id] = 'estudiar'
      await saveLabels(rest)
    }
    setPhase({ name: 'levelDone', level, score: result.score, stopped, labels })
    window.scrollTo(0, 0)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader eyebrow="Opcional" title="Diagnóstico inicial">
        Un test corto por nivel (unas 10 preguntas) para no perder tiempo con lo que ya se sabe. Marca cada módulo como dominado,
        a repasar o a estudiar. No aprueba módulos: a los dominados les sugiere rendir el examen de salteo.
      </PageHeader>

      {eligibleLevels.length === 0 ? (
        <EmptyState title="El diagnóstico se habilita con las primeras lecciones publicadas">
          Usa las mismas preguntas de las lecciones, así que aparece en cuanto haya contenido.
        </EmptyState>
      ) : phase.name === 'intro' ? (
        <>
          {finished ? (
            <Callout tone="ok" title="Diagnóstico terminado">
              Los resultados están en el mapa y en cada módulo.{' '}
              <Link to="/mapa" className="font-medium text-accent">
                Ver el mapa
              </Link>
            </Callout>
          ) : (
            <Card className="space-y-3">
              <ul className="list-disc space-y-1 pl-5 text-[0.95rem]">
                <li>Avanza nivel por nivel, empezando por los fundamentos.</li>
                <li>Si en un nivel hay muchos errores (4 de las primeras 5, o menos de 40% al final), se detiene ahí.</li>
                <li>Cada respuesta muestra su explicación, así que también sirve para aprender.</li>
                <li>Se puede dejar a mitad de camino y retomar desde el nivel siguiente.</li>
              </ul>
              {nextLevel && (
                <Button onClick={() => void startLevel(nextLevel)}>
                  {diag ? 'Continuar' : 'Empezar'} con el nivel {nextLevel.numero}: {nextLevel.titulo}
                </Button>
              )}
            </Card>
          )}
          {diag && <DiagnosticSummary />}
          {diag && (
            <Button variant="ghost" onClick={() => confirm('¿Borrar el resultado del diagnóstico?') && void resetDiagnostic()}>
              Reiniciar el diagnóstico
            </Button>
          )}
        </>
      ) : phase.name === 'loading' ? (
        <Spinner label="Preparando preguntas…" />
      ) : phase.name === 'running' ? (
        <>
          <h2 className="text-lg font-semibold">
            Nivel {phase.level.numero}: {phase.level.titulo}
          </h2>
          {phase.questions.length === 0 ? (
            <EmptyState title="Este nivel no tiene preguntas de diagnóstico todavía" />
          ) : (
            <QuizRunner
              questions={phase.questions}
              mode="practica"
              seed={phase.seed}
              shouldStop={shouldStopEarly}
              finishLabel="Terminar el nivel"
              onFinish={(r) => void finishLevel(phase.level, phase.questions, r)}
            />
          )}
        </>
      ) : (
        <Card className="space-y-4">
          <div>
            <div className="text-sm text-muted">
              Nivel {phase.level.numero}: {phase.level.titulo}
            </div>
            <div className="text-3xl font-bold">{percent(phase.score)}</div>
          </div>
          {phase.stopped ? (
            <Callout tone="warn" title="El diagnóstico se detiene en este nivel">
              Lo mejor es empezar a estudiar desde acá: los niveles siguientes quedaron marcados como "estudiar".
            </Callout>
          ) : (
            <p className="text-muted">Resultado por módulo:</p>
          )}
          <LabelsList level={phase.level} labels={phase.labels} />
          <div className="flex flex-wrap gap-2">
            {!phase.stopped && eligibleLevels.find((l) => !useProgress.getState().snap.diagnostic?.completedLevels.includes(l.id)) ? (
              <Button onClick={() => setPhase({ name: 'intro' })}>Seguir con el próximo nivel</Button>
            ) : (
              <ButtonLink to="/">Ir al panel</ButtonLink>
            )}
            <ButtonLink to="/mapa" variant="secondary">
              Ver el mapa
            </ButtonLink>
          </div>
        </Card>
      )}
    </div>
  )
}

function LabelsList({ level, labels }: { level: LevelEntry; labels: Record<string, DiagnosticLabel | undefined> }) {
  return (
    <ul className="divide-y divide-line">
      {level.modules.map((m) => {
        const label = labels[m.id]
        return (
          <li key={m.id} className="flex items-center justify-between gap-2 py-2">
            <Link to={`/modulo/${m.id}`} className="min-w-0 truncate text-fg">
              {m.numero} {m.titulo}
            </Link>
            {label ? <Badge tone={DIAGNOSTIC_LABELS[label].tono}>{DIAGNOSTIC_LABELS[label].texto}</Badge> : <Badge>Sin preguntas</Badge>}
          </li>
        )
      })}
    </ul>
  )
}

function DiagnosticSummary() {
  const snap = useProgress((s) => s.snap)
  const levels = content.levels.filter((l) => l.modules.some((m) => snap.modules[m.id]?.diagnostic))
  if (levels.length === 0) return null
  return (
    <Card>
      <h2 className="mb-2 font-semibold">Resultados hasta ahora</h2>
      {levels.map((level) => (
        <div key={level.id} className="mt-3">
          <div className="text-sm font-semibold text-muted">
            Nivel {level.numero}: {level.titulo}
          </div>
          <LabelsList level={level} labels={Object.fromEntries(level.modules.map((m) => [m.id, snap.modules[m.id]?.diagnostic]))} />
        </div>
      ))}
    </Card>
  )
}
