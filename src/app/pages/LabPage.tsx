import { useEffect, useState, type ComponentType } from 'react'
import { Link, useParams } from 'react-router'
import { getLevel, getModule, loadLabComponent } from '@/content'
import { formatHours } from '@/lib/cn'
import { useProgress } from '@/progress/store'
import { Badge, Callout, Card, EmptyState, Icon, PageHeader, Spinner } from '@/ui'
import { Checklist } from '../components/Checklist'
import { mdxComponents } from '../mdx/components'
import NotFoundPage from './NotFoundPage'

type Mdx = ComponentType<{ components?: Record<string, unknown> }>

export default function LabPage() {
  const { moduleId = '' } = useParams()
  const mod = getModule(moduleId)
  const state = useProgress((s) => s.snap.modules[moduleId])
  const setLabChecklist = useProgress((s) => s.setLabChecklist)
  const [Body, setBody] = useState<Mdx | null | undefined>(undefined)

  useEffect(() => {
    if (!mod?.lab?.publicado) return
    let cancelled = false
    void loadLabComponent(mod).then((c) => !cancelled && setBody(() => c ?? null))
    return () => {
      cancelled = true
    }
  }, [mod])

  if (!mod) return <NotFoundPage message="Ese módulo no existe." />
  const level = getLevel(mod.levelId)!
  if (!mod.lab?.publicado) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow={<Link to={`/modulo/${mod.id}`} className="text-accent">{mod.numero} {mod.titulo}</Link>} title="Laboratorio guiado" />
        <EmptyState title="El laboratorio de este módulo todavía no está publicado">{mod.lab ? `Está planificado: "${mod.lab.titulo}" (${formatHours(mod.lab.horas)}).` : 'Este módulo no tiene laboratorio.'}</EmptyState>
      </div>
    )
  }
  const lab = mod.lab
  const checked = state?.labChecklist ?? []

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-6">
        <PageHeader
          eyebrow={
            <Link to={`/modulo/${mod.id}`} className="text-accent">
              Nivel {level.numero} · {mod.numero} {mod.titulo}
            </Link>
          }
          title={lab.titulo}
        >
          <span className="flex flex-wrap gap-2">
            <Badge>
              <Icon name="lab" className="h-3.5 w-3.5" />
              Laboratorio guiado
            </Badge>
            <Badge>
              <Icon name="clock" className="h-3.5 w-3.5" />
              {formatHours(lab.horas)}
            </Badge>
            {state?.labDone && <Badge tone="ok">Hecho</Badge>}
          </span>
        </PageHeader>
        <article className="prosa max-w-none">{Body === undefined ? <Spinner label="Cargando el laboratorio…" /> : Body ? <Body components={mdxComponents} /> : <Callout tone="bad">No se encontró el archivo del laboratorio.</Callout>}</article>
      </div>
      <aside>
        <Card className="space-y-3 lg:sticky lg:top-20">
          <h2 className="font-semibold">Lista de verificación</h2>
          <p className="text-sm text-muted">Marca cada punto cuando lo hayas comprobado en tu laboratorio. Al completar todos, el laboratorio cuenta como hecho para el módulo.</p>
          <Checklist items={lab.verificacion} checked={checked} label="Verificación del laboratorio" onChange={(c) => void setLabChecklist(mod.id, c, lab.verificacion.length)} />
          {state?.labDone && (
            <Callout tone="ok" title="¡Laboratorio completo!">
              <Link to={`/modulo/${mod.id}`} className="text-accent">
                Volver al módulo
              </Link>
            </Callout>
          )}
        </Card>
      </aside>
    </div>
  )
}
