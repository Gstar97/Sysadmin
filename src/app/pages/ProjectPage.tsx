import { useEffect, useState, type ComponentType } from 'react'
import { Link, useParams } from 'react-router'
import { getLevel, loadProjectComponent } from '@/content'
import { formatHours } from '@/lib/cn'
import { useProgress } from '@/progress/store'
import { Badge, Callout, Card, EmptyState, Icon, PageHeader, Spinner } from '@/ui'
import { Checklist } from '../components/Checklist'
import { mdxComponents } from '../mdx/components'
import NotFoundPage from './NotFoundPage'

type Mdx = ComponentType<{ components?: Record<string, unknown> }>

export default function ProjectPage() {
  const { levelId = '' } = useParams()
  const level = getLevel(levelId)
  const state = useProgress((s) => s.snap.levels[levelId])
  const setProjectChecklist = useProgress((s) => s.setProjectChecklist)
  const [Body, setBody] = useState<Mdx | null | undefined>(undefined)

  useEffect(() => {
    if (!level?.proyecto?.publicado) return
    let cancelled = false
    void loadProjectComponent(level).then((c) => !cancelled && setBody(() => c ?? null))
    return () => {
      cancelled = true
    }
  }, [level])

  if (!level) return <NotFoundPage message="Ese nivel no existe." />
  const project = level.proyecto
  const header = (
    <PageHeader
      eyebrow={
        <Link to={`/nivel/${level.id}`} className="text-accent">
          Nivel {level.numero}: {level.titulo}
        </Link>
      }
      title={project?.titulo ?? 'Proyecto integrador'}
    >
      <span className="flex flex-wrap gap-2">
        <Badge>
          <Icon name="award" className="h-3.5 w-3.5" />
          Proyecto integrador del nivel
        </Badge>
        {project && <Badge>{formatHours(project.horas)}</Badge>}
        {state?.projectDone && <Badge tone="ok">Entregado</Badge>}
      </span>
    </PageHeader>
  )
  if (!project?.publicado) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title="El proyecto de este nivel todavía no está publicado" />
      </div>
    )
  }
  const checked = state?.projectChecklist ?? []
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-6">
        {header}
        <article className="prosa max-w-none">{Body === undefined ? <Spinner label="Cargando el proyecto…" /> : Body ? <Body components={mdxComponents} /> : <Callout tone="bad">No se encontró el archivo del proyecto.</Callout>}</article>
      </div>
      <aside>
        <Card className="space-y-3 lg:sticky lg:top-20">
          <h2 className="font-semibold">Entregables</h2>
          <p className="text-sm text-muted">Marca cada entregable cuando lo tengas listo. Con todos marcados y los módulos completos, se otorga la insignia del nivel.</p>
          <Checklist items={project.entregables} checked={checked} label="Entregables del proyecto" onChange={(c) => void setProjectChecklist(level.id, c, project.entregables.length)} />
        </Card>
      </aside>
    </div>
  )
}
