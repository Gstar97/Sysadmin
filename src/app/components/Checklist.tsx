import { cn } from '@/lib/cn'
import { Icon, ProgressBar } from '@/ui'

/** Lista de verificación con casillas grandes (sirve para laboratorios y proyectos). */
export function Checklist({ items, checked, onChange, label }: { items: string[]; checked: string[]; onChange: (checked: string[]) => void; label: string }) {
  const done = items.filter((i) => checked.includes(i)).length
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-sm">
        <span className="whitespace-nowrap font-medium">
          {done} de {items.length}
        </span>
        <ProgressBar value={items.length ? done / items.length : 0} tone={done === items.length ? 'ok' : 'accent'} label={label} />
      </div>
      <ul className="space-y-2" aria-label={label}>
        {items.map((item) => {
          const on = checked.includes(item)
          return (
            <li key={item}>
              <label className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition', on ? 'border-ok bg-ok-soft' : 'border-line hover:bg-surface-2')}>
                <input type="checkbox" className="sr-only" checked={on} onChange={() => onChange(on ? checked.filter((c) => c !== item) : [...checked, item])} />
                <span className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border-2', on ? 'border-ok bg-ok text-white' : 'border-line')} aria-hidden>
                  {on && <Icon name="check" className="h-3.5 w-3.5" />}
                </span>
                <span>{item}</span>
              </label>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
