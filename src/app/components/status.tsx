import { DIAGNOSTIC_LABELS } from '@/engines/assessment/diagnostic'
import { cn } from '@/lib/cn'
import type { ModuleStatus } from '@/progress/rules'
import type { DiagnosticLabel } from '@/progress/types'
import { Badge, Icon } from '@/ui'

export const MODULE_STATUS: Record<ModuleStatus, { texto: string; tono: 'neutral' | 'accent' | 'ok' }> = {
  sin_empezar: { texto: 'Sin empezar', tono: 'neutral' },
  en_curso: { texto: 'En curso', tono: 'accent' },
  completado: { texto: 'Completado', tono: 'ok' },
  completado_por_salteo: { texto: 'Completado por examen', tono: 'ok' },
}

export function ModuleStatusBadge({ status }: { status: ModuleStatus }) {
  const s = MODULE_STATUS[status]
  return (
    <Badge tone={s.tono}>
      {status.startsWith('completado') && <Icon name="check" className="h-3 w-3" />}
      {s.texto}
    </Badge>
  )
}

export function DiagnosticBadge({ label }: { label?: DiagnosticLabel }) {
  if (!label) return null
  const d = DIAGNOSTIC_LABELS[label]
  return (
    <Badge tone={d.tono} className="whitespace-nowrap">
      Diagnóstico: {d.texto}
    </Badge>
  )
}

export function ProgressRing({ value, size = 44, stroke = 5, label }: { value: number; size?: number; stroke?: number; label?: string }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(1, value))
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label ?? `${Math.round(pct * 100)}%`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={pct >= 1 ? 'var(--ok)' : 'var(--accent)'}
        strokeWidth={stroke}
        strokeDasharray={`${c * pct} ${c}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fontSize={size * 0.27} fill="currentColor" fontWeight={600}>
        {Math.round(pct * 100)}%
      </text>
    </svg>
  )
}

export function LessonStatusIcon({ status }: { status?: 'en_curso' | 'completada' }) {
  return (
    <span
      className={cn(
        'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2',
        status === 'completada' && 'border-ok bg-ok text-white',
        status === 'en_curso' && 'border-accent text-accent',
        !status && 'border-line',
      )}
      aria-label={status === 'completada' ? 'Completada' : status === 'en_curso' ? 'En curso' : 'Sin empezar'}
    >
      {status === 'completada' && <Icon name="check" className="h-3.5 w-3.5" />}
      {status === 'en_curso' && <span className="h-2 w-2 rounded-full bg-accent" />}
    </span>
  )
}
