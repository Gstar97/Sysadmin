import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { getLevel, getModule, loadCaseScenario } from '@/content'
import type { TroubleshootingScenario } from '@/content/exercise-schemas'
import { Troubleshooting } from '@/interactive/troubleshooting/Troubleshooting'
import { formatHours } from '@/lib/cn'
import { useProgress } from '@/progress/store'
import { Badge, Callout, EmptyState, Icon, PageHeader, Spinner } from '@/ui'
import NotFoundPage from './NotFoundPage'

export default function CasePage() {
  const { moduleId = '' } = useParams()
  const mod = getModule(moduleId)
  const state = useProgress((s) => s.snap.modules[moduleId])
  const markCaseSolved = useProgress((s) => s.markCaseSolved)
  const [scenario, setScenario] = useState<TroubleshootingScenario | null | undefined>(undefined)

  useEffect(() => {
    if (!mod?.caso?.publicado) return
    let cancelled = false
    void loadCaseScenario(mod).then((s) => !cancelled && setScenario(s ?? null))
    return () => {
      cancelled = true
    }
  }, [mod])

  if (!mod) return <NotFoundPage message="Ese módulo no existe." />
  const level = getLevel(mod.levelId)!
  const header = (
    <PageHeader
      eyebrow={
        <Link to={`/modulo/${mod.id}`} className="text-accent">
          Nivel {level.numero} · {mod.numero} {mod.titulo}
        </Link>
      }
      title={mod.caso?.titulo ?? 'Caso real'}
    >
      <span className="flex flex-wrap gap-2">
        <Badge>
          <Icon name="flag" className="h-3.5 w-3.5" />
          Caso real: problema simulado de producción
        </Badge>
        {mod.caso && <Badge>{formatHours(mod.caso.horas)}</Badge>}
        {state?.caseSolved && <Badge tone="ok">Resuelto · mejor tiempo {state.caseBestMinutes} min simulados</Badge>}
      </span>
    </PageHeader>
  )
  if (!mod.caso?.publicado) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title="El caso real de este módulo todavía no está publicado" />
      </div>
    )
  }
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {header}
      <Callout tone="info">
        Cada decisión suma minutos, como en un incidente real. No hay que acertar todo de una: lo importante es llegar a la causa y entender qué conviene revisar primero.
      </Callout>
      {scenario === undefined ? <Spinner label="Cargando el caso…" /> : scenario ? <Troubleshooting scenario={scenario} onSolved={(m) => void markCaseSolved(mod.id, m)} /> : <Callout tone="bad">No se encontró el archivo del caso.</Callout>}
    </div>
  )
}
