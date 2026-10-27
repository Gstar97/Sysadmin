import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { ANSI_PALETTE, parseAnsi } from './ansi'
import type { EditorState, TermSession } from './sessions'

interface Line {
  id: number
  text: string
  kind: 'out' | 'err' | 'cmd' | 'info'
}

interface Props {
  session: TermSession
  /** Se llama después de cada comando ejecutado. */
  onCommand?: (line: string) => void
  /** Texto de bienvenida. */
  banner?: string
  className?: string
  /** Contenido extra en la barra superior (por ejemplo, el selector de equipo). */
  toolbar?: ReactNode
  title?: string
  autoFocus?: boolean
}

const MAX_LINES = 1500

function Ansi({ text }: { text: string }) {
  return (
    <>
      {parseAnsi(text).map((s, i) => (
        <span
          key={i}
          style={{
            color: s.fg ? ANSI_PALETTE[s.fg] : undefined,
            backgroundColor: s.bg ? ANSI_PALETTE[s.bg] : undefined,
            fontWeight: s.bold ? 700 : undefined,
          }}
        >
          {s.text}
        </span>
      ))}
    </>
  )
}

const HELPER_KEYS: Record<TermSession['kind'], string[]> = {
  bash: ['|', '-', '/', '~', '>', '$', '*'],
  powershell: ['|', '-', '\\', '$', '{', '}', '"'],
  ios: ['?', '-', '/', '.'],
}

export function Terminal({ session, onCommand, banner, className, toolbar, title, autoFocus }: Props) {
  const [lines, setLines] = useState<Line[]>(() => (banner ? [{ id: 0, text: banner, kind: 'info' }] : []))
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<EditorState | undefined>()
  const historyIndex = useRef<number | null>(null)
  const draft = useRef('')
  const nextId = useRef(1)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const append = useCallback((items: Omit<Line, 'id'>[]) => {
    setLines((prev) => {
      const next = [...prev, ...items.map((l) => ({ ...l, id: nextId.current++ }))]
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
    })
  }, [])

  // La sesión es un objeto externo y mutable: el prompt se lee en cada render.
  const prompt = session.prompt()
  const secret = session.secret()

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines, pending])

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus({ preventScroll: true })
  }, [autoFocus])

  const submit = async () => {
    if (busy) return
    const shownPrompt = pending.length ? session.continuation : prompt
    const echo = `${shownPrompt}${secret ? '' : input}`
    const source = [...pending, input].join('\n')
    setInput('')
    historyIndex.current = null
    setBusy(true)
    try {
      const res = await session.run(secret ? input : source)
      if (res.incomplete) {
        append([{ text: echo, kind: 'cmd' }])
        setPending((p) => [...p, input])
        return
      }
      setPending([])
      if (session.takeClear()) {
        setLines([])
      } else {
        const out: Omit<Line, 'id'>[] = [{ text: echo, kind: 'cmd' }, ...res.chunks.map((c) => ({ text: c.text.replace(/\n$/, ''), kind: c.stream }))]
        append(out.filter((l) => l.text !== '' || l.kind === 'cmd'))
      }
      if (res.refill !== undefined) setInput(res.refill)
      const ed = session.takeEditor()
      if (ed) setEditor(ed)
      if (!secret && source.trim()) onCommand?.(source)
    } catch (e) {
      append([{ text: echo, kind: 'cmd' }, { text: `Error del simulador: ${(e as Error).message}`, kind: 'err' }])
    } finally {
      setBusy(false)
      requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
    }
  }

  const navigateHistory = (dir: -1 | 1) => {
    const hist = session.history()
    if (!hist.length) return
    if (historyIndex.current === null) {
      if (dir === 1) return
      draft.current = input
      historyIndex.current = hist.length - 1
    } else {
      historyIndex.current += dir
    }
    if (historyIndex.current >= hist.length) {
      historyIndex.current = null
      setInput(draft.current)
      return
    }
    historyIndex.current = Math.max(0, historyIndex.current)
    setInput(hist[historyIndex.current])
  }

  const complete = () => {
    const res = session.complete(input)
    if (!res) return
    if ('line' in res) setInput(res.line)
    else append([{ text: `${prompt}${input}`, kind: 'cmd' }, { text: res.options.join('  '), kind: 'out' }])
  }

  const cancel = () => {
    append([{ text: `${pending.length ? session.continuation : prompt}${input}^C`, kind: 'cmd' }])
    setInput('')
    setPending([])
    historyIndex.current = null
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      navigateHistory(-1)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      navigateHistory(1)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      complete()
    } else if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && !window.getSelection()?.toString()) {
      e.preventDefault()
      cancel()
    } else if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault()
      setLines([])
    } else if (e.ctrlKey && (e.key === 'u' || e.key === 'U')) {
      e.preventDefault()
      setInput('')
    }
  }

  const insert = (text: string) => {
    setInput((v) => v + text)
    inputRef.current?.focus({ preventScroll: true })
  }

  const closeEditor = (message?: string) => {
    setEditor(undefined)
    if (message) append([{ text: message, kind: 'out' }])
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
  }

  return (
    <div className={cn('relative overflow-hidden rounded-xl border border-line shadow-card', className)} style={{ background: 'var(--term-bg)', color: 'var(--term-fg)' }}>
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5 text-xs" style={{ color: 'var(--term-muted)' }}>
        <span className="flex gap-1.5" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        </span>
        <span className="truncate font-medium">{title ?? (session.kind === 'bash' ? 'Terminal Linux (simulada)' : session.kind === 'powershell' ? 'Windows PowerShell (simulada)' : 'Consola Cisco IOS (simulada)')}</span>
        <div className="ml-auto flex items-center gap-2">{toolbar}</div>
      </div>
      <div
        ref={scrollRef}
        className="h-80 overflow-y-auto px-3 py-2 font-mono text-[13px] leading-[1.45] sm:h-96 sm:text-sm"
        onClick={() => {
          if (!window.getSelection()?.toString()) inputRef.current?.focus({ preventScroll: true })
        }}
        role="log"
        aria-live="polite"
        aria-label="Salida de la terminal"
      >
        {lines.map((l) => (
          <div key={l.id} className="whitespace-pre-wrap break-words" style={{ color: l.kind === 'err' ? 'var(--term-err)' : l.kind === 'info' ? 'var(--term-muted)' : undefined }}>
            <Ansi text={l.text} />
          </div>
        ))}
        <div className="flex items-start">
          <span className="whitespace-pre">
            <Ansi text={pending.length ? session.continuation : prompt} />
          </span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              historyIndex.current = null
            }}
            onKeyDown={onKeyDown}
            type={secret ? 'password' : 'text'}
            className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-inherit outline-none focus:outline-none focus-visible:outline-none"
            style={{ caretColor: 'var(--term-accent)' }}
            aria-label={secret ? 'Contraseña' : 'Comando'}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="send"
            disabled={!!editor}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-1 border-t border-white/10 px-2 py-1.5" aria-label="Teclas de ayuda">
        <HelperKey label="Tab" onClick={() => complete()} />
        <HelperKey label="↑" onClick={() => navigateHistory(-1)} />
        <HelperKey label="↓" onClick={() => navigateHistory(1)} />
        <HelperKey label="Ctrl+C" onClick={() => cancel()} />
        {HELPER_KEYS[session.kind].map((k) => (
          <button key={k} type="button" onClick={() => insert(k)} className="min-h-8 min-w-8 rounded-md bg-white/5 px-2 font-mono text-xs hover:bg-white/15">
            {k}
          </button>
        ))}
      </div>
      {editor && <EditorOverlay state={editor} session={session} onClose={closeEditor} />}
    </div>
  )
}

function HelperKey({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="min-h-8 rounded-md bg-white/10 px-2.5 font-mono text-xs hover:bg-white/20">
      {label}
    </button>
  )
}

function EditorOverlay({ state, session, onClose }: { state: EditorState; session: TermSession; onClose: (message?: string) => void }) {
  const [text, setText] = useState(state.content)
  const [saved, setSaved] = useState(state.content)
  const [status, setStatus] = useState<string | undefined>(state.error)
  const [confirmExit, setConfirmExit] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const dirty = text !== saved
  const label = state.editor === 'crontab' ? 'crontab -e' : state.editor === 'visudo' ? 'visudo' : state.editor === 'systemctl edit' ? 'systemctl edit' : state.editor

  useEffect(() => ref.current?.focus(), [])

  const save = (): boolean => {
    const res = session.saveEditor(state, text)
    if (!res.ok) {
      setStatus(res.message ?? 'No se pudo guardar')
      return false
    }
    setSaved(text)
    setStatus(`[ Wrote ${text.split('\n').length - (text.endsWith('\n') ? 1 : 0)} lines ]`)
    if (res.message) setStatus(res.message)
    return true
  }

  const exit = () => {
    if (dirty) {
      setConfirmExit(true)
      return
    }
    onClose()
  }

  return (
    <div className="absolute inset-0 z-10 flex flex-col" style={{ background: 'var(--term-bg)' }} role="dialog" aria-label={`Editor ${label}: ${state.path}`}>
      <div className="flex items-center justify-between bg-white/90 px-3 py-1 font-mono text-xs text-black">
        <span>{state.editor === 'nano' ? 'GNU nano 7.2' : label}</span>
        <span className="truncate">{state.path}{dirty ? ' (modificado)' : ''}</span>
      </div>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setConfirmExit(false)
        }}
        onKeyDown={(e) => {
          if (e.ctrlKey && (e.key === 'o' || e.key === 'O' || e.key === 's' || e.key === 'S')) {
            e.preventDefault()
            save()
          } else if (e.ctrlKey && (e.key === 'x' || e.key === 'X')) {
            e.preventDefault()
            exit()
          } else if (e.key === 'Tab') {
            e.preventDefault()
            const el = e.currentTarget
            const { selectionStart: a, selectionEnd: b } = el
            setText(text.slice(0, a) + '    ' + text.slice(b))
            requestAnimationFrame(() => el.setSelectionRange(a + 4, a + 4))
          }
        }}
        className="flex-1 resize-none border-0 bg-transparent p-3 font-mono text-[13px] leading-[1.45] outline-none sm:text-sm"
        style={{ color: 'var(--term-fg)', caretColor: 'var(--term-accent)' }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label="Contenido del archivo"
      />
      {status && (
        <div className="whitespace-pre-wrap px-3 py-1 font-mono text-xs" style={{ color: status.startsWith('[ Wrote') || status.startsWith('crontab: installing') ? 'var(--term-accent)' : 'var(--term-err)' }}>
          {status}
        </div>
      )}
      <div className="flex flex-wrap gap-2 border-t border-white/10 px-3 py-2 text-xs">
        {confirmExit ? (
          <>
            <span className="self-center" style={{ color: 'var(--term-muted)' }}>
              ¿Guardar los cambios antes de salir?
            </span>
            <button type="button" className="min-h-8 rounded-md bg-white/15 px-3 hover:bg-white/25" onClick={() => save() && onClose(state.editor === 'crontab' ? 'crontab: installing new crontab' : undefined)}>
              Sí, guardar
            </button>
            <button type="button" className="min-h-8 rounded-md bg-white/10 px-3 hover:bg-white/20" onClick={() => onClose(state.editor === 'crontab' ? 'crontab: no changes made to crontab' : undefined)}>
              No, descartar
            </button>
            <button type="button" className="min-h-8 rounded-md px-3 hover:bg-white/10" onClick={() => setConfirmExit(false)}>
              Cancelar
            </button>
          </>
        ) : (
          <>
            <button type="button" className="min-h-8 rounded-md bg-white/15 px-3 font-mono hover:bg-white/25" onClick={save}>
              ^O Guardar
            </button>
            <button type="button" className="min-h-8 rounded-md bg-white/10 px-3 font-mono hover:bg-white/20" onClick={exit}>
              ^X Salir
            </button>
            <span className="self-center" style={{ color: 'var(--term-muted)' }}>
              Ctrl+O guarda · Ctrl+X sale
            </span>
          </>
        )}
      </div>
    </div>
  )
}
