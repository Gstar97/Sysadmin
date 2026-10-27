import { useMemo, useRef, useState } from 'react'
import { emptyResponse, gradeQuestion, isAnswered, type GradeResult, type Response } from '@/engines/assessment/grading'
import { presentationFor, type ExamQuestion } from '@/engines/assessment/sampling'
import { cn } from '@/lib/cn'
import { createRng } from '@/lib/random'
import { Button, Card, Icon, ProgressBar } from '@/ui'
import { QuestionView } from './QuestionView'

export interface AnsweredQuestion extends ExamQuestion {
  response: Response
  result: GradeResult
}

export interface QuizResult {
  answers: AnsweredQuestion[]
  score: number
  durationSeconds: number
}

interface Props {
  questions: ExamQuestion[]
  /** práctica: corrige cada pregunta al responderla; examen: corrige todo al entregar. */
  mode: 'practica' | 'examen'
  seed?: number
  onFinish: (result: QuizResult) => void
  /** Corta el cuestionario antes de terminar (lo usa el diagnóstico). */
  shouldStop?: (results: boolean[]) => boolean
  finishLabel?: string
}

export function QuizRunner({ questions, mode, seed, onFinish, shouldStop, finishLabel }: Props) {
  const rng = useMemo(() => createRng(seed ?? Date.now()), [seed])
  const presentations = useMemo(() => questions.map((q) => presentationFor(rng, q.question)), [questions, rng])
  const [responses, setResponses] = useState<Response[]>(() =>
    questions.map((q, i) => emptyResponse(q.question, presentations[i].stepOrder)),
  )
  const [results, setResults] = useState<(GradeResult | undefined)[]>(() => questions.map(() => undefined))
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [confirmSubmit, setConfirmSubmit] = useState(false)
  const started = useRef(Date.now())

  const current = questions[index]
  const answeredCount = responses.filter(isAnswered).length

  const setResponse = (r: Response) => setResponses((rs) => rs.map((x, i) => (i === index ? r : x)))

  const finish = (graded: GradeResult[], upTo = questions.length) => {
    const answers = questions.slice(0, upTo).map((q, i) => ({ ...q, response: responses[i], result: graded[i] }))
    const correct = answers.filter((a) => a.result.correct).length
    onFinish({
      answers,
      score: answers.length ? correct / answers.length : 0,
      durationSeconds: Math.round((Date.now() - started.current) / 1000),
    })
  }

  const checkCurrent = async () => {
    setBusy(true)
    const result = await gradeQuestion(current.question, responses[index])
    setBusy(false)
    const next = results.map((r, i) => (i === index ? result : r))
    setResults(next)
    const done = next.slice(0, index + 1).map((r) => !!r?.correct)
    if (shouldStop?.(done)) finish(next as GradeResult[], index + 1)
  }

  const submitAll = async () => {
    setBusy(true)
    const graded = await Promise.all(questions.map((q, i) => gradeQuestion(q.question, responses[i])))
    setBusy(false)
    finish(graded)
  }

  if (!current) return null
  const result = results[index]
  const isLast = index === questions.length - 1

  return (
    <Card className="space-y-5">
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm text-muted">
          <span>
            {index + 1} de {questions.length}
          </span>
          {mode === 'examen' && <span>{answeredCount} respondidas</span>}
        </div>
        <ProgressBar value={(index + (result ? 1 : 0)) / questions.length} label="Avance del cuestionario" />
      </div>

      {mode === 'examen' && questions.length > 1 && (
        <nav className="flex flex-wrap gap-1.5" aria-label="Ir a la pregunta">
          {questions.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setIndex(i)}
              aria-current={i === index ? 'step' : undefined}
              className={cn(
                'h-8 w-8 rounded-md border text-xs font-medium',
                i === index ? 'border-accent bg-accent text-accent-fg' : isAnswered(responses[i]) ? 'border-accent text-accent' : 'border-line text-muted',
              )}
            >
              {i + 1}
            </button>
          ))}
        </nav>
      )}

      <QuestionView
        key={current.key}
        question={current.question}
        presentation={presentations[index]}
        response={responses[index]}
        onChange={setResponse}
        onSubmit={mode === 'practica' && !result ? checkCurrent : undefined}
        result={mode === 'practica' ? result : undefined}
        number={index + 1}
      />

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
        {mode === 'examen' ? (
          <>
            <Button variant="secondary" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0}>
              <Icon name="arrowLeft" /> Anterior
            </Button>
            <div className="flex flex-wrap gap-2">
              {!isLast && (
                <Button variant="secondary" onClick={() => setIndex((i) => i + 1)}>
                  Siguiente <Icon name="arrowRight" />
                </Button>
              )}
              {confirmSubmit ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-warn">Quedan {questions.length - answeredCount} sin responder.</span>
                  <Button onClick={submitAll} disabled={busy}>
                    Entregar igual
                  </Button>
                </span>
              ) : (
                <Button
                  onClick={() => (answeredCount < questions.length ? setConfirmSubmit(true) : void submitAll())}
                  disabled={busy}
                  variant={isLast ? 'primary' : 'secondary'}
                >
                  {finishLabel ?? 'Entregar examen'}
                </Button>
              )}
            </div>
          </>
        ) : (
          <>
            <span className="text-sm text-muted">{result ? (result.correct ? 'Bien.' : 'Revisar la explicación.') : ' '}</span>
            {!result ? (
              <Button onClick={checkCurrent} disabled={busy || !isAnswered(responses[index])}>
                Comprobar
              </Button>
            ) : isLast ? (
              <Button onClick={() => finish(results as GradeResult[])}>{finishLabel ?? 'Ver resultado'}</Button>
            ) : (
              <Button onClick={() => setIndex((i) => i + 1)}>
                Siguiente <Icon name="arrowRight" />
              </Button>
            )}
          </>
        )}
      </div>
    </Card>
  )
}

/** Revisión de un cuestionario ya corregido: cada pregunta con su explicación. */
export function QuizReview({ answers }: { answers: AnsweredQuestion[] }) {
  return (
    <div className="space-y-4">
      {answers.map((a, i) => (
        <Card key={a.key}>
          <QuestionView
            question={a.question}
            presentation={{ optionOrder: [], stepOrder: [] }}
            response={a.response}
            onChange={() => undefined}
            result={a.result}
            number={i + 1}
          />
        </Card>
      ))}
    </div>
  )
}
