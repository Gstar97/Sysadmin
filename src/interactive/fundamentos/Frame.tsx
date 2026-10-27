import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/** Marco común de los interactivos del Nivel 0. */
export function Frame({ titulo, children, className, acciones }: { titulo: string; children: ReactNode; className?: string; acciones?: ReactNode }) {
  return (
    <div className={cn('my-6 overflow-hidden rounded-xl border border-line bg-surface shadow-card', className)}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <h3 className="text-base font-semibold">{titulo}</h3>
        <div className="ml-auto flex flex-wrap gap-2">{acciones}</div>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

export function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={cn('min-h-9 rounded-full border px-3 text-sm', active ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-surface-2')}>
      {children}
    </button>
  )
}

/** Resultado de una respuesta de práctica, con los pasos de la explicación. */
export function Feedback({ ok, titulo, pasos }: { ok: boolean; titulo: string; pasos: string[] }) {
  return (
    <div role="status" className={cn('mt-3 rounded-lg border p-3 text-sm', ok ? 'border-ok bg-ok-soft' : 'border-bad bg-bad-soft')}>
      <div className={cn('font-semibold', ok ? 'text-ok' : 'text-bad')}>{titulo}</div>
      {pasos.length > 0 && (
        <ol className="mt-1 list-decimal space-y-0.5 pl-5">
          {pasos.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ol>
      )}
    </div>
  )
}

/** Racha y aciertos de una práctica. */
export function Score({ correct, total, streak }: { correct: number; total: number; streak: number }) {
  return (
    <div className="flex gap-3 text-xs text-muted" aria-live="polite">
      <span>
        Aciertos: <b className="text-fg">{correct}</b> de {total}
      </span>
      <span>
        Racha: <b className="text-fg">{streak}</b>
      </span>
    </div>
  )
}

export const inputClass = 'min-h-10 rounded-lg border border-line bg-bg px-3 font-mono'
