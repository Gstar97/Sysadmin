import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { allModules, content, levelHours } from '@/content'
import type { ModuleEntry } from '@/content/types'
import { cn, formatHours } from '@/lib/cn'
import { isLevelComplete, isModuleComplete, levelFraction, moduleFraction, moduleStatus, type ModuleStatus } from '@/progress/rules'
import { useProgress } from '@/progress/store'
import { Badge, Icon, PageHeader } from '@/ui'
import { DiagnosticBadge, ProgressRing } from '../components/status'

const NODE_STYLE: Record<ModuleStatus, string> = {
  sin_empezar: 'border-line bg-surface',
  en_curso: 'border-accent bg-accent-soft/50',
  completado: 'border-ok bg-ok-soft/60',
  completado_por_salteo: 'border-ok bg-ok-soft/60',
}

export default function MapPage() {
  const snap = useProgress((s) => s.snap)
  const [focus, setFocus] = useState<string | null>(null)
  const focused = focus ? allModules.find((m) => m.id === focus) : undefined
  const related = new Set<string>(focused ? [...focused.requiere, ...allModules.filter((m) => m.requiere.includes(focused.id)).map((m) => m.id)] : [])

  return (
    <div>
      <PageHeader eyebrow="Mapa de la carrera" title={content.career.nombre}>
        {content.levels.length} niveles y {allModules.length} módulos. Tocar un módulo para ver sus requisitos; ningún requisito
        bloquea el avance.
      </PageHeader>

      <LevelOverview />

      <div className="mt-6 flex flex-wrap gap-2 text-xs" aria-label="Referencias">
        <Badge>Sin empezar</Badge>
        <Badge tone="accent">En curso</Badge>
        <Badge tone="ok">Completado</Badge>
        <Badge tone="warn">Conviene antes / depende de este</Badge>
      </div>

      <ol className="relative mt-6 space-y-8 border-l-2 border-line pl-5 sm:pl-8">
        {content.levels.map((level) => {
          const complete = isLevelComplete(level, snap)
          return (
            <li key={level.id} className="relative">
              <span
                className={cn(
                  'absolute -left-[33px] top-0.5 flex h-8 w-8 items-center justify-center rounded-full border-2 text-sm font-bold sm:-left-[45px]',
                  complete ? 'border-ok bg-ok text-white' : 'border-line bg-surface',
                )}
                style={complete ? undefined : { borderColor: level.insignia.color, color: level.insignia.color }}
              >
                {level.numero}
              </span>
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <Link to={`/nivel/${level.id}`} className="text-lg font-bold text-fg no-underline hover:text-accent">
                  Nivel {level.numero}: {level.titulo}
                </Link>
                <span className="text-sm text-muted">
                  {formatHours(levelHours(level))} · {Math.round(levelFraction(level, snap) * 100)}%
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {level.modules.map((mod) => (
                  <ModuleNode
                    key={mod.id}
                    mod={mod}
                    status={moduleStatus(mod, snap)}
                    fraction={moduleFraction(mod, snap)}
                    highlighted={related.has(mod.id)}
                    focused={focus === mod.id}
                    onFocus={() => setFocus((f) => (f === mod.id ? null : mod.id))}
                    diagnostic={snap.modules[mod.id]?.diagnostic}
                    missing={mod.requiere.filter((r) => {
                      const req = allModules.find((m) => m.id === r)
                      return req && !isModuleComplete(req, snap)
                    })}
                  />
                ))}
                {level.proyecto && (
                  <Link
                    to={`/proyecto/${level.id}`}
                    className="flex items-center gap-3 rounded-xl border border-dashed border-line bg-surface p-3 no-underline hover:border-accent"
                  >
                    <Icon name="flag" className="text-muted" />
                    <span className="min-w-0">
                      <span className="block text-xs text-muted">Proyecto integrador</span>
                      <span className="block truncate font-medium text-fg">{level.proyecto.titulo}</span>
                    </span>
                  </Link>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function ModuleNode({
  mod,
  status,
  fraction,
  highlighted,
  focused,
  onFocus,
  diagnostic,
  missing,
}: {
  mod: ModuleEntry
  status: ModuleStatus
  fraction: number
  highlighted: boolean
  focused: boolean
  onFocus: () => void
  diagnostic?: 'dominado' | 'repasar' | 'estudiar'
  missing: string[]
}) {
  const published = mod.lessons.length
  const total = mod.lessons.length + mod.planned.length
  return (
    <div
      className={cn(
        'rounded-xl border-2 p-3 transition',
        NODE_STYLE[status],
        highlighted && 'ring-2 ring-warn',
        focused && 'ring-2 ring-accent',
      )}
    >
      <div className="flex items-start gap-3">
        <ProgressRing value={fraction} size={42} label={`Avance del módulo ${mod.titulo}`} />
        <div className="min-w-0 flex-1">
          <Link to={`/modulo/${mod.id}`} className="font-semibold text-fg no-underline hover:text-accent">
            {mod.numero} {mod.titulo}
          </Link>
          <div className="mt-0.5 text-xs text-muted">
            {formatHours(mod.horas)} · {published === total ? `${total} lecciones` : `${published} de ${total} lecciones publicadas`}
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <DiagnosticBadge label={diagnostic} />
        {mod.requiere.length > 0 && (
          <button
            type="button"
            onClick={onFocus}
            className={cn('rounded-full px-2 py-0.5 text-xs', missing.length ? 'bg-warn-soft text-warn' : 'bg-surface-2 text-muted')}
            aria-pressed={focused}
            title="Resaltar requisitos y módulos que dependen de este"
          >
            Requiere {mod.requiere.map((r) => r.replace(/^n(\d+)-m(\d+)$/, '$1.$2')).join(', ')}
          </button>
        )}
      </div>
    </div>
  )
}

/** Vista general: los 10 niveles como un recorrido con el avance de cada uno. */
function LevelOverview() {
  const snap = useProgress((s) => s.snap)
  const navigate = useNavigate()
  const levels = content.levels
  if (levels.length === 0) return null
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface p-4">
      <svg viewBox={`0 0 ${levels.length * 80} 90`} className="min-w-[640px]" role="img" aria-label="Avance por nivel">
        <line x1={40} y1={34} x2={levels.length * 80 - 40} y2={34} stroke="var(--line)" strokeWidth={3} />
        {levels.map((level, i) => {
          const f = levelFraction(level, snap)
          const cx = i * 80 + 40
          const r = 22
          const c = 2 * Math.PI * r
          return (
            <g key={level.id}>
              <g
                role="link"
                tabIndex={0}
                aria-label={`Nivel ${level.numero}: ${level.titulo}, ${Math.round(f * 100)}%`}
                className="cursor-pointer"
                onClick={() => navigate(`/nivel/${level.id}`)}
                onKeyDown={(e) => e.key === 'Enter' && navigate(`/nivel/${level.id}`)}
              >
                <circle cx={cx} cy={34} r={r} fill="var(--surface)" stroke="var(--surface-2)" strokeWidth={6} />
                <circle
                  cx={cx}
                  cy={34}
                  r={r}
                  fill="none"
                  stroke={f >= 1 ? 'var(--ok)' : level.insignia.color}
                  strokeWidth={6}
                  strokeDasharray={`${c * f} ${c}`}
                  transform={`rotate(-90 ${cx} 34)`}
                />
                <text x={cx} y={34} textAnchor="middle" dominantBaseline="central" fontSize={16} fontWeight={700} fill="var(--fg)">
                  {level.numero}
                </text>
              </g>
              <text x={cx} y={76} textAnchor="middle" fontSize={10.5} fill="var(--muted)">
                {level.titulo.length > 14 ? `${level.titulo.slice(0, 13)}…` : level.titulo}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
