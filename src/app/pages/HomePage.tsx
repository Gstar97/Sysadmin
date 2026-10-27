import { Link } from 'react-router'
import { allModules, content, getLesson, getModule } from '@/content'
import { cn, formatDuration, percent } from '@/lib/cn'
import {
  careerFraction,
  dueCards,
  isModuleComplete,
  lastDaysSeconds,
  levelFraction,
  nextStep,
  pendingRecommendations,
  strongTopics,
  totalSeconds,
  weakTopics,
} from '@/progress/rules'
import { useProgress } from '@/progress/store'
import type { Attempt } from '@/progress/types'
import { Badge, ButtonLink, Callout, Card, EmptyState, Icon, ProgressBar, Stat } from '@/ui'

const KIND_LABEL: Record<Attempt['kind'], string> = {
  mini_test: 'Mini test',
  examen: 'Examen de módulo',
  salteo: 'Examen de salteo',
  diagnostico: 'Diagnóstico',
  simulacro: 'Simulacro',
}

function scopeTitle(a: Attempt): string {
  if (a.kind === 'mini_test') return getLesson(a.scopeId)?.titulo ?? a.scopeId
  if (a.kind === 'diagnostico') return content.levels.find((l) => l.id === a.scopeId)?.titulo ?? a.scopeId
  const m = getModule(a.scopeId)
  return m ? `${m.numero} ${m.titulo}` : a.scopeId
}

export default function HomePage() {
  const snap = useProgress((s) => s.snap)
  const step = nextStep(content, snap)
  const week = lastDaysSeconds(snap, 7)
  const weekTotal = week.reduce((s, d) => s + d.seconds, 0)
  const maxDay = Math.max(1, ...week.map((d) => d.seconds))
  const weak = weakTopics(snap).slice(0, 5)
  const strong = strongTopics(snap).slice(0, 5)
  const recs = pendingRecommendations(content, snap)
  const recent = [...snap.attempts].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6)
  const published = allModules.some((m) => m.lessons.length > 0)
  const completedModules = allModules.filter((m) => isModuleComplete(m, snap)).length

  return (
    <div className="space-y-6">
      <section>
        <p className="text-sm font-medium text-muted">{snap.profile.name ? `Hola, ${snap.profile.name}` : 'Hola'}</p>
        <h1 className="text-2xl font-bold sm:text-3xl">Panel de estudio</h1>
      </section>

      <Card className="border-accent/40 bg-accent-soft/40">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-accent">
              <Icon name="target" className="h-4 w-4" /> Próximo paso recomendado
            </div>
            <h2 className="text-xl font-bold">{step.title}</h2>
            <p className="mt-1 text-muted">{step.description}</p>
            {step.warning && (
              <p className="mt-2 flex items-start gap-1.5 text-sm text-warn">
                <Icon name="alert" className="mt-0.5 h-4 w-4" /> {step.warning} Igual se puede avanzar.
              </p>
            )}
          </div>
          <ButtonLink to={step.url} className="shrink-0">
            Ir <Icon name="arrowRight" className="h-4 w-4" />
          </ButtonLink>
        </div>
      </Card>

      {published && !snap.diagnostic && (
        <Callout tone="info" title="¿Ya hay experiencia en IT? Diagnóstico inicial opcional">
          Un test corto por nivel que marca cada módulo como dominado, a repasar o a estudiar, para no perder tiempo con lo que ya se sabe.{' '}
          <Link to="/diagnostico" className="font-medium text-accent">
            Hacer el diagnóstico
          </Link>
        </Callout>
      )}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Avance de la carrera" value={percent(careerFraction(content, snap))} hint={`${completedModules} de ${allModules.length} módulos`} />
        <Stat label="Esta semana" value={formatDuration(weekTotal)} hint="Tiempo de estudio activo" />
        <Stat label="Tiempo total" value={formatDuration(totalSeconds(snap))} />
        <Stat
          label="Tarjetas para hoy"
          value={dueCards(snap).length}
          hint={<Link to="/repaso" className="text-accent">Ir al repaso</Link>}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" as="section">
          <h2 className="mb-4 text-lg font-semibold">Avance por nivel</h2>
          <ul className="space-y-3">
            {content.levels.map((level) => {
              const f = levelFraction(level, snap)
              const done = level.modules.filter((m) => isModuleComplete(m, snap)).length
              return (
                <li key={level.id}>
                  <Link to={`/nivel/${level.id}`} className="block rounded-lg p-1 no-underline hover:bg-surface-2">
                    <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                      <span className="font-medium text-fg">
                        {level.numero}. {level.titulo}
                      </span>
                      <span className="shrink-0 text-muted">
                        {done}/{level.modules.length} módulos · {percent(f)}
                      </span>
                    </div>
                    <ProgressBar value={f} label={`Avance del nivel ${level.titulo}`} tone={f >= 1 ? 'ok' : 'accent'} />
                  </Link>
                </li>
              )
            })}
          </ul>
        </Card>

        <Card as="section">
          <h2 className="mb-4 text-lg font-semibold">Últimos 7 días</h2>
          <div className="flex h-32 items-end justify-between gap-1.5" role="img" aria-label="Minutos de estudio por día">
            {week.map((d) => (
              <div key={d.date} className="flex flex-1 flex-col items-center gap-1">
                <div
                  className="w-full rounded-t bg-accent"
                  style={{ height: `${Math.max(2, (d.seconds / maxDay) * 100)}%`, opacity: d.seconds ? 1 : 0.25 }}
                  title={`${d.date}: ${formatDuration(d.seconds)}`}
                />
                <span className="text-[0.7rem] text-muted">
                  {new Date(`${d.date}T12:00:00`).toLocaleDateString('es', { weekday: 'narrow' })}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card as="section">
          <h2 className="mb-3 text-lg font-semibold">Temas débiles</h2>
          {weak.length === 0 ? (
            <p className="text-sm text-muted">Todavía no hay suficientes respuestas para detectarlos (hacen falta al menos 3 por tema).</p>
          ) : (
            <TopicList items={weak} tone="bad" />
          )}
          {recs.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <h3 className="mb-2 text-sm font-semibold">Recomendadas por el último examen</h3>
              <ul className="space-y-1 text-sm">
                {recs.slice(0, 5).map((r) => (
                  <li key={r.lessonId}>
                    <Link to={`/leccion/${r.lessonId}`} className="text-accent">
                      {getLesson(r.lessonId)?.titulo ?? r.lessonId}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
        <Card as="section">
          <h2 className="mb-3 text-lg font-semibold">Fortalezas</h2>
          {strong.length === 0 ? (
            <p className="text-sm text-muted">Aparecen cuando un tema se responde bien de forma sostenida.</p>
          ) : (
            <TopicList items={strong} tone="ok" />
          )}
        </Card>
      </div>

      <Card as="section">
        <h2 className="mb-3 text-lg font-semibold">Evaluaciones recientes</h2>
        {recent.length === 0 ? (
          <EmptyState title="Todavía no hay evaluaciones">Los mini tests, exámenes y el diagnóstico aparecen aquí.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {recent.map((a) => (
              <li key={a.id ?? a.date} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm text-muted">{KIND_LABEL[a.kind]}</div>
                  <div className="font-medium">{scopeTitle(a)}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{percent(a.score)}</span>
                  <Badge tone={a.passed ? 'ok' : 'bad'}>{a.passed ? 'Aprobado' : a.kind === 'diagnostico' ? 'Corte' : 'No aprobado'}</Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function TopicList({ items, tone }: { items: { lessonId: string; accuracy: number; answers: number }[]; tone: 'ok' | 'bad' }) {
  return (
    <ul className="space-y-2">
      {items.map((t) => {
        const lesson = getLesson(t.lessonId)
        return (
          <li key={t.lessonId} className="flex items-center justify-between gap-2 text-sm">
            <Link to={`/leccion/${t.lessonId}`} className="min-w-0 truncate text-accent">
              {lesson ? `${lesson.numero} ${lesson.titulo}` : t.lessonId}
            </Link>
            <span className={cn('shrink-0 font-semibold', tone === 'ok' ? 'text-ok' : 'text-bad')}>
              {percent(t.accuracy)} <span className="font-normal text-muted">({t.answers})</span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}
