import { Link, useParams } from 'react-router'
import { getLevel, levelHours } from '@/content'
import { formatHours } from '@/lib/cn'
import { isLevelComplete, levelFraction, moduleFraction, moduleStatus } from '@/progress/rules'
import { useProgress } from '@/progress/store'
import { Badge, ButtonLink, Card, Icon, PageHeader, ProgressBar } from '@/ui'
import { DiagnosticBadge, ModuleStatusBadge } from '../components/status'
import NotFoundPage from './NotFoundPage'

export default function LevelPage() {
  const { levelId = '' } = useParams()
  const level = getLevel(levelId)
  const snap = useProgress((s) => s.snap)
  if (!level) return <NotFoundPage message="Ese nivel no existe." />
  const state = snap.levels[level.id]
  const complete = isLevelComplete(level, snap)

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link to="/mapa" className="text-accent">
            Mapa
          </Link>
        }
        title={`Nivel ${level.numero}: ${level.titulo}`}
        actions={complete && state?.certificateCode ? <ButtonLink to={`/certificado/${level.id}`}>Ver certificado</ButtonLink> : undefined}
      >
        {level.descripcion}
      </PageHeader>

      <Card>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <div className="text-sm font-semibold">Al terminar el nivel vas a poder</div>
            <p className="mt-1 text-muted">{level.perfil_salida}</p>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted">Avance</span>
              <span className="font-semibold">{Math.round(levelFraction(level, snap) * 100)}%</span>
            </div>
            <ProgressBar value={levelFraction(level, snap)} />
            <div className="text-sm text-muted">Duración estimada: {formatHours(levelHours(level))}</div>
            <div className="flex items-center gap-2 text-sm">
              <span className="inline-block h-3 w-3 rounded-full" style={{ background: level.insignia.color }} />
              Insignia: {complete ? <Badge tone="ok">obtenida</Badge> : <span className="text-muted">pendiente</span>}
            </div>
          </div>
        </div>
      </Card>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Módulos</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {level.modules.map((mod) => {
            const total = mod.lessons.length + mod.planned.length
            return (
              <Link key={mod.id} to={`/modulo/${mod.id}`} className="block no-underline">
                <Card className="h-full transition hover:border-accent">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm text-muted">Módulo {mod.numero}</div>
                      <div className="font-semibold text-fg">{mod.titulo}</div>
                    </div>
                    <ModuleStatusBadge status={moduleStatus(mod, snap)} />
                  </div>
                  <div className="mt-3">
                    <ProgressBar value={moduleFraction(mod, snap)} label={`Avance de ${mod.titulo}`} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span>{formatHours(mod.horas)}</span>
                    <span>·</span>
                    <span>
                      {mod.lessons.length === total ? `${total} lecciones` : `${mod.lessons.length} de ${total} lecciones publicadas`}
                    </span>
                    <DiagnosticBadge label={snap.modules[mod.id]?.diagnostic} />
                  </div>
                </Card>
              </Link>
            )
          })}
        </div>
      </section>

      {level.proyecto && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Proyecto integrador</h2>
          <Card>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="font-semibold">{level.proyecto.titulo}</div>
                <div className="text-sm text-muted">
                  {formatHours(level.proyecto.horas)} · {level.proyecto.entregables.length} entregables
                  {state?.projectDone && ' · entregado'}
                </div>
              </div>
              <ButtonLink to={`/proyecto/${level.id}`} variant="secondary">
                <Icon name="flag" className="h-4 w-4" /> Ver proyecto
              </ButtonLink>
            </div>
          </Card>
        </section>
      )}
    </div>
  )
}
