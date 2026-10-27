import { useId, useState } from 'react'
import type { DiagramSpec } from '@/content/exercise-schemas'
import { cn } from '@/lib/cn'
import { Icon, RichText } from '@/ui'

interface DiagramProps {
  /** SVG en texto (importado con ?raw): se inserta en la página y toma los colores del tema. */
  svg?: string
  /** O bien una URL de imagen (SVG o PNG importado). */
  src?: string
  alt: string
  pie?: string
  className?: string
}

/** Diagrama estático con pie de figura. Los SVG propios usan currentColor y variables del tema. */
export function Diagram({ svg, src, alt, pie, className }: DiagramProps) {
  return (
    <figure className={cn('my-6', className)}>
      <div className="overflow-x-auto rounded-xl border border-line bg-surface p-3 text-fg">
        {svg ? <div role="img" aria-label={alt} className="diagram-svg mx-auto max-w-full [&_svg]:h-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} /> : <img src={src} alt={alt} className="mx-auto h-auto max-w-full" loading="lazy" />}
      </div>
      {pie && <figcaption className="mt-2 text-center text-sm text-muted">{pie}</figcaption>}
    </figure>
  )
}

interface InteractiveProps {
  datos: DiagramSpec
  svg?: string
  src?: string
  alt: string
}

/**
 * Diagrama con zonas clicables: cada punto abre su explicación.
 * Las áreas se expresan en porcentaje del ancho y alto de la imagen.
 */
export function InteractiveDiagram({ datos, svg, src, alt }: InteractiveProps) {
  const [active, setActive] = useState<string | undefined>(datos.puntos[0]?.id)
  const [visited, setVisited] = useState<Set<string>>(() => new Set(datos.puntos[0] ? [datos.puntos[0].id] : []))
  const panelId = useId()
  const current = datos.puntos.find((p) => p.id === active)
  const open = (id: string) => {
    setActive(id)
    setVisited((v) => new Set(v).add(id))
  }
  const withAreas = datos.puntos.some((p) => p.area)

  return (
    <div className="my-6 overflow-hidden rounded-xl border border-line bg-surface shadow-card">
      {datos.titulo && <div className="border-b border-line px-4 py-2 font-semibold">{datos.titulo}</div>}
      <div className="grid gap-0 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="self-start p-3 text-fg">
          {/* Las zonas se ubican en porcentaje sobre la imagen, sin contar el relleno del contenedor. */}
          <div className="relative">
            {svg ? <div role="img" aria-label={alt} className="[&_svg]:block [&_svg]:h-auto [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} /> : src ? <img src={src} alt={alt} className="block h-auto w-full" /> : null}
            {withAreas &&
              datos.puntos.map((p, i) =>
                p.area ? (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => open(p.id)}
                    aria-controls={panelId}
                    aria-pressed={active === p.id}
                    aria-label={p.titulo}
                    className={cn('absolute rounded-md border-2 transition', active === p.id ? 'border-accent bg-accent/15' : 'border-transparent hover:border-accent/60 hover:bg-accent/10')}
                    style={{ left: `${p.area.x}%`, top: `${p.area.y}%`, width: `${p.area.ancho}%`, height: `${p.area.alto}%` }}
                  >
                    <span className={cn('absolute -left-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold', visited.has(p.id) ? 'bg-accent text-accent-fg' : 'bg-warn text-white')}>{i + 1}</span>
                  </button>
                ) : null,
              )}
          </div>
        </div>
        <div className="border-t border-line p-4 lg:border-l lg:border-t-0">
          <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Partes del diagrama">
            {datos.puntos.map((p, i) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={active === p.id}
                aria-controls={panelId}
                onClick={() => open(p.id)}
                className={cn('flex min-h-8 items-center gap-1 rounded-full border px-2.5 text-xs', active === p.id ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-surface-2')}
              >
                {visited.has(p.id) && active !== p.id && <Icon name="check" className="h-3 w-3 text-ok" />}
                {i + 1}. {p.titulo}
              </button>
            ))}
          </div>
          <div id={panelId} role="tabpanel" aria-live="polite">
            {current && (
              <>
                <h4 className="font-semibold">{current.titulo}</h4>
                <RichText text={current.texto} className="mt-1 text-sm" />
              </>
            )}
          </div>
          <p className="mt-3 text-xs text-muted">
            Exploraste {visited.size} de {datos.puntos.length} partes.
          </p>
        </div>
      </div>
    </div>
  )
}
