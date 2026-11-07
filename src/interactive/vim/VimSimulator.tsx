import { useMemo, useRef, useState } from 'react'
import type { VimExercise } from '@/content/exercise-schemas'
import { createVim, isModified, statusLine, verifyVim, vimKey, type VimCheck, type VimState } from '@/engines/vim'
import { cn } from '@/lib/cn'
import { Badge, Button, Callout, Icon, RichText } from '@/ui'

const VISIBLE_ROWS = 14
const SPECIAL = new Set(['Escape', 'Enter', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'])

/** Muestra las teclas de una solución de forma legible: <Esc> como Esc, <CR> como Enter. */
function prettyKeys(keys: string): string {
  return keys.replace(/<esc>/gi, ' Esc ').replace(/<cr>/gi, ' Enter ').replace(/<bs>/gi, ' Retroceso ').replace(/<c-r>/gi, ' Ctrl+R ').replace(/\s+/g, ' ').trim()
}

export function VimSimulator({ exercise }: { exercise: VimExercise }) {
  const initial = useMemo(() => createVim(exercise.archivo.contenido, exercise.archivo.nombre), [exercise])
  const [vim, setVim] = useState<VimState>(initial)
  const [step, setStep] = useState(0)
  const [done, setDone] = useState(false)
  const [hints, setHints] = useState(0)
  const [showSolution, setShowSolution] = useState(false)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Copias al día del estado, para procesar varias teclas seguidas dentro del mismo evento.
  const live = useRef({ vim: initial, step: 0, done: false })
  const pasos = exercise.pasos
  const current = pasos[step]
  const checks = current ? current.verificar.map((c) => verifyVim(vim, c as VimCheck)) : []

  const press = (key: string) => {
    const l = live.current
    l.vim = vimKey(l.vim, key)
    setVim(l.vim)
    // Avanza de paso cuando se cumplen todas las verificaciones del actual.
    const paso = pasos[l.step]
    if (!l.done && paso && paso.verificar.every((c) => verifyVim(l.vim, c as VimCheck).ok)) {
      if (l.step + 1 < pasos.length) {
        l.step++
        setStep(l.step)
        setHints(0)
        setShowSolution(false)
      } else {
        l.done = true
        setDone(true)
      }
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.ctrlKey && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault()
      press('C-r')
      return
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (SPECIAL.has(e.key) || e.key.length === 1) {
      e.preventDefault()
      press(e.key)
    }
  }

  // Teclados de celulares: llegan como texto en el evento input en lugar de keydown.
  const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const text = e.currentTarget.value
    e.currentTarget.value = ''
    for (const ch of text) press(ch === '\n' ? 'Enter' : ch)
  }

  const restart = () => {
    live.current = { vim: initial, step: 0, done: false }
    setVim(initial)
    setStep(0)
    setDone(false)
    setHints(0)
    setShowSolution(false)
  }

  const reopen = () => {
    const s = live.current.vim
    live.current.vim = { ...createVim(s.saved.join('\n') + '\n', s.filename), writes: s.writes, log: s.log }
    setVim(live.current.vim)
  }

  const top = Math.max(0, Math.min(vim.row - Math.floor(VISIBLE_ROWS / 2), vim.lines.length - VISIBLE_ROWS))
  const shown = vim.lines.slice(top, top + VISIBLE_ROWS)
  const status = statusLine(vim)
  const numberWidth = String(vim.lines.length).length + 1

  return (
    <div className="my-6 space-y-3">
      {(exercise.titulo || exercise.descripcion) && (
        <div>
          {exercise.titulo && <h3 className="text-lg font-semibold">{exercise.titulo}</h3>}
          {exercise.descripcion && <RichText text={exercise.descripcion} className="text-muted" />}
        </div>
      )}
      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge tone={done ? 'ok' : 'accent'}>{done ? 'Ejercicio completado' : `Paso ${step + 1} de ${pasos.length}`}</Badge>
          <div className="flex gap-1" aria-hidden>
            {pasos.map((_, i) => (
              <span key={i} className={cn('h-1.5 w-6 rounded-full', i < step || done ? 'bg-ok' : i === step ? 'bg-accent' : 'bg-surface-2')} />
            ))}
          </div>
        </div>
        {done ? (
          <div className="flex items-start gap-2 text-ok">
            <Icon name="check" />
            <p>Completaste todos los pasos. Podés seguir practicando en el editor o reiniciarlo para empezar de nuevo.</p>
          </div>
        ) : (
          current && (
            <>
              <RichText text={current.consigna} />
              <ul className="mt-3 space-y-1 text-sm" aria-label="Verificaciones del paso">
                {checks.map((c, i) => (
                  <li key={i} className={cn('flex items-start gap-2', c.ok ? 'text-ok' : 'text-muted')}>
                    <Icon name={c.ok ? 'check' : 'target'} className="mt-0.5 h-4 w-4" />
                    <span>{c.label}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap gap-2">
                {current.pistas.length > 0 && hints < current.pistas.length && (
                  <Button variant="secondary" onClick={() => setHints((h) => h + 1)}>
                    <Icon name="lightbulb" className="h-4 w-4" />
                    {hints === 0 ? 'Ver una pista' : 'Otra pista'}
                  </Button>
                )}
                {current.solucion && (
                  <Button variant="ghost" onClick={() => setShowSolution((v) => !v)}>
                    {showSolution ? 'Ocultar solución' : 'Ver solución'}
                  </Button>
                )}
              </div>
              {hints > 0 && (
                <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
                  {current.pistas.slice(0, hints).map((p, i) => (
                    <li key={i}>
                      <RichText text={p} />
                    </li>
                  ))}
                </ol>
              )}
              {showSolution && current.solucion && (
                <p className="mt-3 text-sm">
                  Teclas, en orden: <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono">{prettyKeys(current.solucion)}</code>
                </p>
              )}
            </>
          )
        )}
        {step > 0 && !done && pasos[step - 1].explicacion && (
          <Callout tone="ok" title="Sobre el paso anterior" className="mt-3">
            <RichText text={pasos[step - 1].explicacion!} />
          </Callout>
        )}
        {done && pasos[pasos.length - 1].explicacion && (
          <Callout tone="ok" className="mt-3">
            <RichText text={pasos[pasos.length - 1].explicacion!} />
          </Callout>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-line shadow-card" style={{ background: 'var(--term-bg)', color: 'var(--term-fg)' }}>
        <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-1.5 text-xs opacity-80">
          <span className="font-mono">
            vim {vim.filename}
            {isModified(vim) && !vim.quit ? ' [+]' : ''}
          </span>
          <button type="button" onClick={restart} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/10" title="Volver al archivo original y al primer paso">
            <Icon name="refresh" className="h-3.5 w-3.5" />
            Reiniciar
          </button>
        </div>
        {vim.quit ? (
          <div className="space-y-3 p-4 font-mono text-sm">
            <p>[ana@rocky01 ~]$ <span className="opacity-60"># saliste de vim</span></p>
            <p className="font-sans text-xs opacity-80">{isModified(vim) ? 'Saliste sin guardar: los cambios se descartaron.' : vim.writes ? 'Los cambios quedaron guardados en el archivo.' : 'Saliste sin cambios.'}</p>
            <Button variant="secondary" onClick={reopen}>
              Volver a abrir {vim.filename}
            </Button>
          </div>
        ) : (
          <div className="relative cursor-text" onClick={() => inputRef.current?.focus()}>
            <textarea
              ref={inputRef}
              aria-label={`Editor vim con ${vim.filename}. Modo ${vim.mode === 'insert' ? 'inserción' : vim.mode === 'normal' ? 'normal' : 'línea de comandos'}.`}
              className="absolute inset-0 h-full w-full resize-none opacity-0"
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              onKeyDown={onKeyDown}
              onInput={onInput}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
            />
            <pre className="m-0 overflow-x-auto p-3 font-mono text-sm leading-6" aria-hidden>
              {Array.from({ length: VISIBLE_ROWS }, (_, i) => {
                const r = top + i
                const line = shown[i]
                if (line === undefined) return <div key={i} className="opacity-40">~</div>
                const isCursorRow = r === vim.row && (vim.mode === 'normal' || vim.mode === 'insert')
                const text = line.replace(/\t/g, '    ')
                const c = Math.min(vim.col, text.length)
                return (
                  <div key={i} className="whitespace-pre">
                    {vim.numbers && <span className="mr-2 inline-block text-right opacity-50" style={{ width: `${numberWidth}ch` }}>{r + 1}</span>}
                    {isCursorRow ? (
                      <>
                        {text.slice(0, c)}
                        <span className={cn(focused ? 'animate-pulse' : 'opacity-70', vim.mode === 'insert' ? 'border-l-2 border-current' : 'bg-[var(--term-fg)] text-[var(--term-bg)]')}>
                          {vim.mode === 'insert' ? text[c] ?? ' ' : text[c] ?? ' '}
                        </span>
                        {text.slice(c + 1)}
                      </>
                    ) : (
                      text || ' '
                    )}
                  </div>
                )
              })}
            </pre>
            <div className="flex justify-between gap-3 border-t border-white/10 px-3 py-1 font-mono text-sm">
              <span className={cn('truncate', status.error && 'text-red-400', vim.mode === 'insert' && 'font-bold')}>{status.left || ' '}</span>
              <span className="shrink-0 opacity-70">
                {vim.pending && <span className="mr-4">{vim.pending}</span>}
                {vim.row + 1},{vim.col + 1}
              </span>
            </div>
            {!focused && (
              <div className="pointer-events-none absolute right-3 top-2 rounded bg-white/10 px-2 py-0.5 font-sans text-xs">Hacé clic acá para escribir</div>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-1.5 border-t border-white/10 px-3 py-2" aria-label="Teclas de ayuda">
          {[
            ['Esc', 'Escape'],
            [':', ':'],
            ['/', '/'],
            ['Enter', 'Enter'],
            ['←', 'ArrowLeft'],
            ['↓', 'ArrowDown'],
            ['↑', 'ArrowUp'],
            ['→', 'ArrowRight'],
          ].map(([label, key]) => (
            <button
              key={key}
              type="button"
              className="min-h-8 min-w-9 rounded-md bg-white/10 px-2 font-mono text-xs hover:bg-white/20"
              onClick={() => {
                press(key)
                inputRef.current?.focus()
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
