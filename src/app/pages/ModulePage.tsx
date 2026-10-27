import { Link, useParams } from 'react-router'
import { content, getLesson, getModule } from '@/content'
import { cn, formatHours, percent } from '@/lib/cn'
import {
  examKindFor,
  isExamAvailable,
  isModuleComplete,
  lessonsToReview,
  missingRequirements,
  moduleRequirements,
  moduleStatus,
} from '@/progress/rules'
import { useProgress } from '@/progress/store'
import { Badge, ButtonLink, Callout, Card, Icon, PageHeader } from '@/ui'
import { DiagnosticBadge, LessonStatusIcon, ModuleStatusBadge } from '../components/status'
import NotFoundPage from './NotFoundPage'

export default function ModulePage() {
  const { moduleId = '' } = useParams()
  const mod = getModule(moduleId)
  const snap = useProgress((s) => s.snap)
  if (!mod) return <NotFoundPage message="Ese módulo no existe." />
  const level = content.levels.find((l) => l.id === mod.levelId)!
  const state = snap.modules[mod.id]
  const status = moduleStatus(mod, snap)
  const missing = missingRequirements(mod, content, snap)
  const reqs = moduleRequirements(mod, snap)
  const examAvailable = isExamAvailable(mod)
  const kind = examKindFor(mod, snap)
  const lastExam = [...snap.attempts]
    .filter((a) => a.scopeId === mod.id && (a.kind === 'examen' || a.kind === 'salteo'))
    .sort((a, b) => a.date.localeCompare(b.date))
    .at(-1)
  const toReview = lastExam && !lastExam.passed ? lessonsToReview(lastExam) : []

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link to={`/nivel/${level.id}`} className="text-accent">
            Nivel {level.numero}: {level.titulo}
          </Link>
        }
        title={`${mod.numero} ${mod.titulo}`}
      >
        <span className="flex flex-wrap items-center gap-2">
          <ModuleStatusBadge status={status} />
          <DiagnosticBadge label={state?.diagnostic} />
          <span className="text-sm">Duración estimada: {formatHours(mod.horas)}</span>
        </span>
        {mod.descripcion && <p className="mt-2">{mod.descripcion}</p>}
      </PageHeader>

      {missing.length > 0 && (
        <Callout tone="warn" title="Conviene haber visto antes">
          <ul className="list-disc pl-5">
            {missing.map((m) => (
              <li key={m.id}>
                <Link to={`/modulo/${m.id}`} className="text-accent">
                  {m.numero} {m.titulo}
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-1">Es una recomendación: se puede avanzar igual.</p>
        </Callout>
      )}

      {state?.diagnostic === 'dominado' && !isModuleComplete(mod, snap) && examAvailable && (
        <Callout tone="ok" title="El diagnóstico marcó este módulo como dominado">
          Se puede rendir directamente el examen de salteo: con 85% o más el módulo queda completado.{' '}
          <Link to={`/examen/${mod.id}`} className="font-medium text-accent">
            Rendir el examen
          </Link>
        </Callout>
      )}

      {toReview.length > 0 && !isModuleComplete(mod, snap) && (
        <Callout tone="info" title="Recomendado después del último examen">
          Repasar solo estas lecciones antes de volver a rendir:
          <ul className="mt-1 list-disc pl-5">
            {toReview.map((id) => (
              <li key={id}>
                <Link to={`/leccion/${id}`} className="text-accent">
                  {getLesson(id)?.titulo ?? id}
                </Link>
              </li>
            ))}
          </ul>
        </Callout>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="space-y-3 lg:col-span-2">
          <h2 className="text-lg font-semibold">Lecciones</h2>
          <Card className="p-0 sm:p-0">
            <ol className="divide-y divide-line">
              {mod.lessons.map((lesson) => {
                const lp = snap.lessons[lesson.id]
                return (
                  <li key={lesson.id}>
                    <Link to={`/leccion/${lesson.id}`} className="flex items-center gap-3 px-4 py-3 no-underline hover:bg-surface-2">
                      <LessonStatusIcon status={lp?.status} />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-fg">
                          {lesson.numero} {lesson.titulo}
                        </span>
                        <span className="block text-xs text-muted">
                          {lesson.minutos} min
                          {lp && lp.attempts > 0 && ` · mejor mini test: ${percent(lp.bestScore)}`}
                        </span>
                      </span>
                      <Icon name="arrowRight" className="h-4 w-4 text-muted" />
                    </Link>
                  </li>
                )
              })}
              {mod.planned.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-4 py-3 opacity-70">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-line" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{p.titulo}</span>
                    <span className="block text-xs text-muted">{formatHours(p.horas)} · se publica en una próxima etapa</span>
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        </section>

        <aside className="space-y-4">
          <Card>
            <h2 className="mb-3 font-semibold">Para completar el módulo</h2>
            <ul className="space-y-2 text-sm">
              {reqs.map((r) => (
                <li key={r.key} className="flex items-start gap-2">
                  <Icon name={r.done ? 'check' : 'clock'} className={cn('mt-0.5 h-4 w-4', r.done ? 'text-ok' : 'text-muted')} />
                  <span>
                    {r.label}
                    {r.detail && <span className="text-muted"> ({r.detail})</span>}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted">O aprobar el examen de salteo con 85% o más.</p>
          </Card>

          {mod.lab && (
            <Card>
              <div className="mb-1 flex items-center gap-2 text-sm text-muted">
                <Icon name="lab" className="h-4 w-4" /> Laboratorio guiado · {formatHours(mod.lab.horas)}
              </div>
              <p className="text-sm">{mod.lab.titulo}</p>
              <div className="mt-3">
                {mod.lab.publicado ? (
                  <ButtonLink to={`/laboratorio/${mod.id}`} variant="secondary">
                    {state?.labDone ? 'Ver laboratorio (hecho)' : 'Abrir laboratorio'}
                  </ButtonLink>
                ) : (
                  <Badge>Se publica con las lecciones del módulo</Badge>
                )}
              </div>
            </Card>
          )}

          {mod.caso && (
            <Card>
              <div className="mb-1 flex items-center gap-2 text-sm text-muted">
                <Icon name="alert" className="h-4 w-4" /> Caso real · {formatHours(mod.caso.horas)}
              </div>
              <p className="text-sm">{mod.caso.titulo}</p>
              <div className="mt-3">
                {mod.caso.publicado ? (
                  <ButtonLink to={`/caso/${mod.id}`} variant="secondary">
                    {state?.caseSolved ? 'Resolver otra vez' : 'Resolver el caso'}
                  </ButtonLink>
                ) : (
                  <Badge>Se publica con las lecciones del módulo</Badge>
                )}
              </div>
            </Card>
          )}

          <Card>
            <div className="mb-1 flex items-center gap-2 text-sm text-muted">
              <Icon name="target" className="h-4 w-4" /> Examen del módulo · {mod.examen.preguntas} preguntas
            </div>
            {examAvailable ? (
              <>
                <p className="text-sm">
                  {kind === 'examen'
                    ? 'Todas las lecciones están completas: se aprueba con 70%.'
                    : 'Todavía faltan lecciones: rendirlo ahora cuenta como examen de salteo y se aprueba con 85%.'}
                </p>
                {state?.examBest !== undefined && <p className="mt-1 text-sm text-muted">Mejor resultado: {percent(state.examBest)}</p>}
                <div className="mt-3">
                  <ButtonLink to={`/examen/${mod.id}`}>{kind === 'examen' ? 'Rendir el examen' : 'Rendir examen de salteo'}</ButtonLink>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted">Se habilita cuando el módulo esté publicado completo.</p>
            )}
          </Card>
        </aside>
      </div>
    </div>
  )
}
