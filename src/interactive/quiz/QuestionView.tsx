import type { Question } from '@/content/schemas'
import { correctAnswerText, type GradeResult, type Response } from '@/engines/assessment/grading'
import type { Presentation } from '@/engines/assessment/sampling'
import { cn } from '@/lib/cn'
import { Badge, Icon, RichText } from '@/ui'
import { SortableList } from '../dnd/SortableList'

const TYPE_LABEL: Record<Question['tipo'], string> = {
  opcion_multiple: 'Opción múltiple',
  respuesta_multiple: 'Respuesta múltiple',
  completar_comando: 'Completar el comando',
  ordenar_pasos: 'Ordenar los pasos',
  interpretar_salida: 'Interpretar la salida',
  encontrar_error: 'Encontrar el error',
}

interface Props {
  question: Question
  presentation: Presentation
  response: Response
  onChange: (r: Response) => void
  onSubmit?: () => void
  /** Cuando hay resultado, se muestra la corrección con las explicaciones. */
  result?: GradeResult
  number?: number
}

export function QuestionView({ question: q, presentation, response, onChange, onSubmit, result, number }: Props) {
  const reveal = !!result
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {number !== undefined && <span className="text-sm font-semibold text-muted">Pregunta {number}</span>}
        <Badge>{TYPE_LABEL[q.tipo]}</Badge>
      </div>
      <RichText text={q.enunciado} className="text-[1.02rem] font-medium" />

      {(q.tipo === 'opcion_multiple' || q.tipo === 'interpretar_salida' || q.tipo === 'respuesta_multiple') && (
        <>
          {q.tipo === 'interpretar_salida' && (
            <pre className="overflow-x-auto rounded-lg bg-[var(--term-bg)] p-3 font-mono text-sm leading-relaxed text-[var(--term-fg)]">
              {q.salida}
            </pre>
          )}
          {q.tipo === 'respuesta_multiple' && !reveal && <p className="text-sm text-muted">Marcar todas las opciones correctas.</p>}
          <OptionList q={q} presentation={presentation} response={response} onChange={onChange} reveal={reveal} />
        </>
      )}

      {q.tipo === 'completar_comando' && response.tipo === 'completar_comando' && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit?.()
          }}
        >
          <label className="flex items-center gap-2 rounded-lg bg-[var(--term-bg)] px-3 py-2 font-mono text-[var(--term-fg)]">
            <span className="text-[var(--term-accent)]" aria-hidden>
              {q.prompt}
            </span>
            <input
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[var(--term-muted)]"
              value={response.texto}
              onChange={(e) => onChange({ tipo: 'completar_comando', texto: e.target.value })}
              disabled={reveal}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="escribir el comando"
              aria-label="Comando"
            />
          </label>
        </form>
      )}

      {q.tipo === 'ordenar_pasos' && response.tipo === 'ordenar_pasos' && (
        <SortableList
          order={response.orden}
          onChange={(orden) => onChange({ tipo: 'ordenar_pasos', orden })}
          disabled={reveal}
          render={(id) => <span>{q.pasos[id]}</span>}
          itemClassName={(id, index) => (reveal ? (id === index ? 'border-ok' : 'border-bad') : undefined)}
        />
      )}

      {q.tipo === 'encontrar_error' && response.tipo === 'encontrar_error' && (
        <div>
          {!reveal && <p className="mb-2 text-sm text-muted">Tocar la línea (o las líneas) donde está el error.</p>}
          <div className="overflow-x-auto rounded-lg bg-[var(--term-bg)] py-2 font-mono text-sm text-[var(--term-fg)]">
            {q.archivo.replace(/\n$/, '').split('\n').map((line, i) => {
              const n = i + 1
              const selected = response.lineas.includes(n)
              const isError = q.lineas_con_error.includes(n)
              return (
                <button
                  key={n}
                  type="button"
                  disabled={reveal}
                  aria-pressed={selected}
                  onClick={() =>
                    onChange({
                      tipo: 'encontrar_error',
                      lineas: selected ? response.lineas.filter((x) => x !== n) : [...response.lineas, n].sort((a, b) => a - b),
                    })
                  }
                  className={cn(
                    'flex w-full items-start gap-3 px-3 py-0.5 text-left',
                    !reveal && 'hover:bg-white/10',
                    selected && !reveal && 'bg-[color-mix(in_srgb,var(--accent)_35%,transparent)]',
                    reveal && isError && 'bg-[color-mix(in_srgb,var(--ok)_30%,transparent)]',
                    reveal && selected && !isError && 'bg-[color-mix(in_srgb,var(--bad)_35%,transparent)]',
                  )}
                >
                  <span className="w-6 shrink-0 select-none text-right text-[var(--term-muted)]">{n}</span>
                  <span className="whitespace-pre">{line || ' '}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {reveal && result && <Correction q={q} result={result} />}
    </div>
  )
}

function OptionList({
  q,
  presentation,
  response,
  onChange,
  reveal,
}: {
  q: Extract<Question, { opciones: unknown }>
  presentation: Presentation
  response: Response
  onChange: (r: Response) => void
  reveal: boolean
}) {
  const multiple = q.tipo === 'respuesta_multiple'
  const selected = (i: number) =>
    response.tipo === 'respuesta_multiple'
      ? response.seleccion.includes(i)
      : 'seleccion' in response && response.seleccion === i
  const toggle = (i: number) => {
    if (response.tipo === 'respuesta_multiple') {
      const sel = response.seleccion.includes(i) ? response.seleccion.filter((x) => x !== i) : [...response.seleccion, i]
      onChange({ tipo: 'respuesta_multiple', seleccion: sel })
    } else if (response.tipo === 'opcion_multiple' || response.tipo === 'interpretar_salida') {
      onChange({ tipo: response.tipo, seleccion: i })
    }
  }
  const order = presentation.optionOrder.length ? presentation.optionOrder : q.opciones.map((_, i) => i)
  return (
    <ul className="space-y-2" role={multiple ? 'group' : 'radiogroup'}>
      {order.map((i) => {
        const op = q.opciones[i]
        const isSel = selected(i)
        return (
          <li key={i}>
            <button
              type="button"
              role={multiple ? 'checkbox' : 'radio'}
              aria-checked={isSel}
              disabled={reveal}
              onClick={() => toggle(i)}
              className={cn(
                'flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition',
                !reveal && (isSel ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2'),
                reveal && op.correcta && 'border-ok bg-ok-soft',
                reveal && !op.correcta && isSel && 'border-bad bg-bad-soft',
                reveal && !op.correcta && !isSel && 'border-line bg-surface opacity-80',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border-2',
                  multiple ? 'rounded' : 'rounded-full',
                  isSel ? 'border-accent bg-accent text-accent-fg' : 'border-line',
                )}
                aria-hidden
              >
                {isSel && <Icon name="check" className="h-3.5 w-3.5" />}
              </span>
              <span className="min-w-0 flex-1">
                <RichText text={op.texto} />
                {reveal && (
                  <span className="mt-1.5 flex items-start gap-1.5 text-sm text-muted">
                    <Icon
                      name={op.correcta ? 'check' : 'x'}
                      className={cn('mt-0.5 h-4 w-4', op.correcta ? 'text-ok' : 'text-bad')}
                    />
                    <span>{op.explicacion}</span>
                  </span>
                )}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function Correction({ q, result }: { q: Question; result: GradeResult }) {
  const general = 'explicacion' in q && typeof q.explicacion === 'string' ? q.explicacion : undefined
  const showAnswer = q.tipo === 'completar_comando' || q.tipo === 'ordenar_pasos' || q.tipo === 'encontrar_error'
  return (
    <div className={cn('rounded-lg border-l-4 px-4 py-3', result.correct ? 'border-ok bg-ok-soft' : 'border-bad bg-bad-soft')}>
      <div className={cn('flex items-center gap-2 font-semibold', result.correct ? 'text-ok' : 'text-bad')}>
        <Icon name={result.correct ? 'check' : 'x'} />
        {result.correct ? 'Correcto' : 'Incorrecto'}
      </div>
      {result.feedback && <RichText text={result.feedback} className="mt-2" />}
      {showAnswer && !result.correct && (
        <div className="mt-2 text-sm">
          <div className="font-medium">Respuesta esperada:</div>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[0.85rem]">{correctAnswerText(q)}</pre>
        </div>
      )}
      {general && <RichText text={general} className="mt-2 text-[0.95rem]" />}
    </div>
  )
}
