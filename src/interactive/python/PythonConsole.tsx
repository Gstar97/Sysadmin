import { indentWithTab } from '@codemirror/commands'
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { Prec } from '@codemirror/state'
import { python } from '@codemirror/legacy-modes/mode/python'
import { keymap } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { basicSetup, EditorView } from 'codemirror'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PythonExercise } from '@/content/exercise-schemas'
import { loadPython, runPython } from '@/engines/python/client'
import { checkLabel, type CheckResult } from '@/engines/python/runner'
import { cn } from '@/lib/cn'
import { Badge, Button, Callout, Icon, RichText } from '@/ui'

interface Props {
  /** Ejercicio con pasos; sin él, la consola queda libre para practicar. */
  exercise?: PythonExercise
  /** Código inicial de la consola libre. */
  codigo?: string
  titulo?: string
}

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.definitionKeyword, tags.controlKeyword, tags.modifier], color: 'var(--info)' },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: 'var(--accent)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--ok)' },
  { tag: [tags.number, tags.bool, tags.atom], color: 'var(--warn)' },
  { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [tags.punctuation, tags.bracket, tags.operator], color: 'var(--muted)' },
])

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--surface)', color: 'var(--fg)', fontSize: '13.5px' },
  '.cm-content': { fontFamily: 'var(--font-mono)', caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'var(--surface-2)', color: 'var(--muted)', borderRight: '1px solid var(--line)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 7%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--accent) 12%, transparent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent) !important' },
  '&.cm-focused': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
})

const LIBRE = { archivos: {}, api: {}, comandos: {}, entorno: {}, argumentos: [], directorio: '/home/estudiante' }

type Chunk = { stream: 'out' | 'err' | 'error' | 'info'; text: string }

/** Agrega salida juntando lo consecutivo del mismo tipo (así no queda un bloque por línea). */
function agregar(prev: Chunk[], nuevos: Chunk[]): Chunk[] {
  const out = [...prev]
  for (const c of nuevos) {
    const last = out[out.length - 1]
    if (last && last.stream === c.stream && (c.stream === 'out' || c.stream === 'err')) out[out.length - 1] = { ...last, text: last.text + c.text }
    else out.push(c)
  }
  return out
}

/**
 * Consola de Python: Python 3 de verdad (Pyodide) corriendo en el navegador, con un editor,
 * archivos de ejemplo, una API y comandos simulados, y pasos que se verifican solos.
 */
export function PythonConsole({ exercise, codigo, titulo }: Props) {
  const inicial = exercise?.codigo_inicial ?? codigo ?? ''
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const [estado, setEstado] = useState<'sin-cargar' | 'cargando' | 'listo' | 'corriendo' | 'error'>('sin-cargar')
  const [version, setVersion] = useState<string>()
  const [salida, setSalida] = useState<Chunk[]>([])
  const [step, setStep] = useState(0)
  const [done, setDone] = useState(false)
  const [checks, setChecks] = useState<CheckResult[]>()
  const [hints, setHints] = useState(0)
  const [showSolution, setShowSolution] = useState(false)
  const [verArchivos, setVerArchivos] = useState(false)
  const pasos = exercise?.pasos ?? []
  const current = pasos[step]
  const runRef = useRef<() => void>(() => {})

  const cargar = useCallback(() => {
    setEstado((e) => {
      if (e !== 'sin-cargar') return e
      loadPython()
        .then((v) => {
          setVersion(v)
          setEstado((x) => (x === 'cargando' ? 'listo' : x))
        })
        .catch(() => setEstado('error'))
      return 'cargando'
    })
  }, [])

  const correr = async () => {
    const v = view.current
    if (!v || estado === 'corriendo') return
    const code = v.state.doc.toString()
    setEstado('corriendo')
    setSalida([])
    setChecks(undefined)
    void loadPython().then(setVersion, () => {})
    const r = await runPython(exercise ?? LIBRE, code, current?.verificar ?? [], (stream, text) => setSalida((s) => agregar(s, [{ stream, text }])))
    if (r.tipo === 'timeout') {
      setSalida((s) => [...s, { stream: 'error', text: `El programa tardó más de ${r.segundos} segundos y se cortó. ¿Hay un bucle que nunca termina, o una espera (input, sleep) que no hace falta?` }])
      setEstado('sin-cargar')
      return
    }
    if (r.tipo === 'fail') {
      setSalida((s) => [...s, { stream: 'error', text: `No se pudo correr el programa: ${r.message}` }])
      setEstado('error')
      return
    }
    const { result } = r
    setSalida((s) => agregar(s, [...(result.error ? [{ stream: 'error' as const, text: result.error }] : []), ...(result.codigo && !result.error ? [{ stream: 'info' as const, text: `El programa terminó con código de salida ${result.codigo}.` }] : [])]))
    setEstado('listo')
    if (current) {
      setChecks(r.checks)
      if (r.checks.every((c) => c.ok)) {
        if (step + 1 >= pasos.length) setDone(true)
        else {
          setStep(step + 1)
          setHints(0)
          setShowSolution(false)
          setChecks(undefined)
        }
      }
    }
  }
  useEffect(() => {
    runRef.current = () => void correr()
  })

  useEffect(() => {
    if (!host.current) return
    const v = new EditorView({
      parent: host.current,
      doc: inicial,
      extensions: [
        basicSetup,
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                runRef.current()
                return true
              },
            },
          ]),
        ),
        keymap.of([indentWithTab]),
        StreamLanguage.define(python),
        syntaxHighlighting(highlight),
        theme,
        EditorView.contentAttributes.of({ 'aria-label': 'Editor de código Python (Ctrl+Enter para ejecutar)', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }),
        EditorView.domEventHandlers({ focus: () => cargar() }),
      ],
    })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
  }, [inicial, cargar])

  const reemplazar = (content: string) => {
    const v = view.current
    if (!v) return
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content } })
    v.focus()
  }

  const reiniciar = () => {
    reemplazar(inicial)
    setStep(0)
    setDone(false)
    setChecks(undefined)
    setHints(0)
    setShowSolution(false)
    setSalida([])
  }

  const archivos = Object.entries(exercise?.archivos ?? {})
  const nombre = exercise?.titulo ?? titulo

  return (
    <section className="my-6 space-y-3" aria-label={nombre ?? 'Consola de Python'}>
      {(nombre || exercise?.descripcion) && (
        <div>
          {nombre && <h3 className="text-lg font-semibold">{nombre}</h3>}
          {exercise?.descripcion && <RichText text={exercise.descripcion} className="text-muted" />}
        </div>
      )}
      {current && (
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge tone={done ? 'ok' : 'accent'}>{done ? 'Ejercicio completado' : `Paso ${step + 1} de ${pasos.length}`}</Badge>
            <div className="flex min-w-0 flex-wrap gap-1" aria-hidden>
              {pasos.map((_, i) => (
                <span key={i} className={cn('h-1.5 w-6 rounded-full', i < step || done ? 'bg-ok' : i === step ? 'bg-accent' : 'bg-surface-2')} />
              ))}
            </div>
          </div>
          {done ? (
            <div className="flex items-start gap-2 text-ok">
              <Icon name="check" />
              <p>Completaste todos los pasos. Podés seguir probando cambios en el mismo programa o reiniciar el ejercicio.</p>
            </div>
          ) : (
            <>
              <RichText text={current.consigna} />
              <ul className="mt-3 space-y-1 text-sm" aria-label="Verificaciones del paso">
                {current.verificar.map((c, i) => {
                  const r = checks?.[i]
                  return (
                    <li key={i} className={cn('flex items-start gap-2', r ? (r.ok ? 'text-ok' : 'text-bad') : 'text-muted')}>
                      <Icon name={r ? (r.ok ? 'check' : 'x') : 'target'} className="mt-0.5 h-4 w-4 shrink-0" />
                      <span className="text-fg">
                        {checkLabel(c)}
                        {r && !r.ok && r.detalle && <span className="block font-mono text-xs text-muted">{r.detalle}</span>}
                      </span>
                    </li>
                  )
                })}
              </ul>
              <div className="mt-3 flex flex-wrap gap-2">
                {current.pistas.length > 0 && hints < current.pistas.length && (
                  <Button variant="secondary" onClick={() => setHints((h) => h + 1)}>
                    <Icon name="lightbulb" className="h-4 w-4" />
                    {hints === 0 ? 'Ver una pista' : 'Otra pista'}
                  </Button>
                )}
                <Button variant="ghost" onClick={() => setShowSolution((v) => !v)}>
                  {showSolution ? 'Ocultar solución' : 'Ver solución'}
                </Button>
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
              {showSolution && (
                <div className="mt-3 space-y-2">
                  <pre className="overflow-x-auto rounded-lg p-3 font-mono text-xs sm:text-sm" style={{ background: 'var(--term-bg)', color: 'var(--term-fg)' }}>
                    {current.solucion}
                  </pre>
                  <Button variant="secondary" onClick={() => reemplazar(current.solucion)}>
                    Cargarla en el editor
                  </Button>
                </div>
              )}
            </>
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
      )}
      {archivos.length > 0 && (
        <div className="rounded-xl border border-line bg-surface text-sm">
          <button type="button" onClick={() => setVerArchivos((v) => !v)} aria-expanded={verArchivos} className="flex w-full items-center gap-2 px-3 py-2 text-left">
            <Icon name="note" className="h-4 w-4" />
            <span>Archivos de ejemplo ({archivos.length})</span>
            <span className="ml-auto text-xs text-muted">{verArchivos ? 'ocultar' : 'ver'}</span>
          </button>
          {verArchivos && (
            <div className="space-y-2 border-t border-line p-3">
              {archivos.map(([ruta, data]) => (
                <div key={ruta}>
                  <div className="font-mono text-xs text-muted">{ruta}</div>
                  <pre className="max-h-48 overflow-auto rounded-md bg-bg p-2 font-mono text-xs">{data}</pre>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-line shadow-card">
        <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-3 py-1.5 text-xs text-muted">
          <Icon name="terminal" className="h-4 w-4" />
          <span className="font-mono">programa.py</span>
          <span className="ml-auto">{version ? `Python ${version} en tu navegador` : 'Python en tu navegador'}</span>
        </div>
        <div ref={host} className="max-h-[480px] min-h-[160px] overflow-auto" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void correr()} disabled={estado === 'corriendo' || estado === 'cargando'}>
          <Icon name="play" className="h-4 w-4" />
          {estado === 'corriendo' ? 'Corriendo…' : estado === 'cargando' ? 'Cargando Python…' : 'Ejecutar'}
        </Button>
        <Button variant="ghost" onClick={reiniciar}>
          <Icon name="refresh" className="h-4 w-4" />
          {exercise ? 'Reiniciar el ejercicio' : 'Volver al código original'}
        </Button>
        <span className="text-xs text-muted">Ctrl+Enter también ejecuta.{estado === 'cargando' && ' La primera vez se descargan unos 13 MB; después queda guardado en el navegador.'}</span>
      </div>
      <div className="rounded-xl p-3 font-mono text-xs sm:text-sm" style={{ background: 'var(--term-bg)', color: 'var(--term-fg)' }} aria-live="polite" aria-label="Salida del programa">
        {estado === 'error' && salida.length === 0 && <p className="text-bad">No se pudo cargar Python en este navegador. Probá recargar la página.</p>}
        {salida.length === 0 && estado !== 'error' && <p className="opacity-60">{estado === 'corriendo' ? 'Corriendo…' : 'La salida del programa aparece acá.'}</p>}
        {salida.map((c, i) => (
          <pre key={i} className={cn('whitespace-pre-wrap [overflow-wrap:anywhere]', i > 0 && 'mt-1', c.stream === 'err' && 'text-warn', c.stream === 'error' && 'text-bad', c.stream === 'info' && 'opacity-70')}>
            {c.text.replace(/\n$/, '')}
          </pre>
        ))}
      </div>
    </section>
  )
}
