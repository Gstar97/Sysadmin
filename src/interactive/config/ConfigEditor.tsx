import { indentWithTab } from '@codemirror/commands'
import { yaml } from '@codemirror/lang-yaml'
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { nginx } from '@codemirror/legacy-modes/mode/nginx'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { linter, lintGutter, type Diagnostic as CmDiagnostic } from '@codemirror/lint'
import type { Extension, Text } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { basicSetup, EditorView } from 'codemirror'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConfigExercise, ConfigLanguage } from '@/content/exercise-schemas'
import { evaluateRules, validateConfig, type Diagnostic, type RuleResult } from '@/engines/config'
import { cn } from '@/lib/cn'
import { Button, Callout, Icon, RichText } from '@/ui'

interface Props {
  exercise: ConfigExercise
  onComplete?: () => void
}

const FILE_NAMES: Record<ConfigLanguage, string> = {
  nginx: '/etc/nginx/conf.d/sitio.conf',
  compose: 'compose.yaml',
  ansible: 'playbook.yml',
  yaml: 'archivo.yaml',
  sshd: '/etc/ssh/sshd_config',
  fstab: '/etc/fstab',
  texto: 'archivo.txt',
}

function languageFor(lang: ConfigLanguage): Extension {
  switch (lang) {
    case 'nginx':
      return StreamLanguage.define(nginx)
    case 'compose':
    case 'ansible':
    case 'yaml':
      return yaml()
    case 'sshd':
      return StreamLanguage.define(properties)
    case 'fstab':
      return StreamLanguage.define(shell)
    case 'texto':
      return []
  }
}

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.definitionKeyword, tags.modifier], color: 'var(--info)' },
  { tag: [tags.propertyName, tags.attributeName, tags.variableName], color: 'var(--accent)' },
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
  '.cm-tooltip': { backgroundColor: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--line)' },
  '&.cm-focused': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
})

function toCm(diags: Diagnostic[], doc: Text): CmDiagnostic[] {
  return diags.map((d) => {
    const line = doc.line(Math.min(Math.max(1, d.line), doc.lines))
    const from = d.column ? Math.min(line.to, line.from + d.column - 1) : line.from
    return { from, to: Math.max(from, line.to), severity: d.severity, message: d.message }
  })
}

export function ConfigEditor({ exercise, onComplete }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const [text, setText] = useState(exercise.archivo_inicial)
  const [results, setResults] = useState<RuleResult[]>()
  const [showSolution, setShowSolution] = useState(false)
  const lang = exercise.lenguaje
  const validation = useMemo(() => validateConfig(lang, text), [lang, text])
  const errors = validation.diagnostics.filter((d) => d.severity === 'error')

  useEffect(() => {
    if (!host.current) return
    const v = new EditorView({
      parent: host.current,
      doc: exercise.archivo_inicial,
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        languageFor(lang),
        syntaxHighlighting(highlight),
        lintGutter(),
        linter((ev) => toCm(validateConfig(lang, ev.state.doc.toString()).diagnostics, ev.state.doc), { delay: 400 }),
        theme,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': `Editor de ${FILE_NAMES[lang]}`, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            setText(u.state.doc.toString())
            setResults(undefined)
          }
        }),
      ],
    })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
  }, [lang, exercise.archivo_inicial])

  const replace = (content: string) => {
    const v = view.current
    if (!v) return
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content } })
  }

  const goTo = (lineNo: number) => {
    const v = view.current
    if (!v) return
    const line = v.state.doc.line(Math.min(Math.max(1, lineNo), v.state.doc.lines))
    v.dispatch({ selection: { anchor: line.from, head: line.to }, scrollIntoView: true })
    v.focus()
  }

  const check = () => {
    const r = evaluateRules(lang, text, exercise.reglas, validation)
    setResults(r)
    if (r.every((x) => x.ok)) onComplete?.()
  }

  const allOk = results?.every((r) => r.ok)

  return (
    <div className="my-6 space-y-3">
      {exercise.titulo && <h3 className="text-lg font-semibold">{exercise.titulo}</h3>}
      <RichText text={exercise.consigna} />
      <div className="overflow-hidden rounded-xl border border-line shadow-card">
        <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-3 py-1.5 text-xs text-muted">
          <Icon name="note" className="h-4 w-4" />
          <span className="font-mono">{exercise.nombre_archivo ?? FILE_NAMES[lang]}</span>
          <span className={cn('ml-auto', errors.length ? 'text-bad' : 'text-ok')}>{errors.length ? `${errors.length} ${errors.length === 1 ? 'error' : 'errores'}` : 'sin errores de sintaxis'}</span>
        </div>
        <div ref={host} className="max-h-[480px] min-h-[180px] overflow-auto" />
      </div>
      {validation.diagnostics.length > 0 && (
        <ul className="space-y-1 text-sm" aria-label="Problemas encontrados">
          {validation.diagnostics.map((d, i) => (
            <li key={i}>
              <button type="button" onClick={() => goTo(d.line)} className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left hover:bg-surface-2">
                <Icon name={d.severity === 'error' ? 'x' : 'alert'} className={cn('mt-0.5 h-4 w-4', d.severity === 'error' ? 'text-bad' : 'text-warn')} />
                <span className="font-mono text-xs text-muted">línea {d.line}</span>
                <span className="flex-1">{d.message}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={check}>
          <Icon name="check" className="h-4 w-4" />
          Comprobar
        </Button>
        <Button variant="ghost" onClick={() => replace(exercise.archivo_inicial)}>
          <Icon name="refresh" className="h-4 w-4" />
          Volver al archivo original
        </Button>
        {exercise.solucion && (
          <Button variant="ghost" onClick={() => setShowSolution((s) => !s)}>
            {showSolution ? 'Ocultar solución' : 'Ver una solución'}
          </Button>
        )}
      </div>
      {results && (
        <div className={cn('rounded-xl border p-4', allOk ? 'border-ok bg-ok-soft' : 'border-line bg-surface')}>
          <div className="mb-2 font-semibold">{allOk ? '¡El archivo cumple todo lo pedido!' : 'Revisión del archivo'}</div>
          <ul className="space-y-1 text-sm">
            {results.map((r, i) => (
              <li key={i} className={cn('flex items-start gap-2', r.ok ? 'text-ok' : 'text-bad')}>
                <Icon name={r.ok ? 'check' : 'x'} className="mt-0.5 h-4 w-4" />
                <span className="text-fg">{r.mensaje}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {showSolution && exercise.solucion && (
        <Callout tone="info" title="Una solución posible">
          <pre className="my-2 overflow-x-auto rounded-lg p-3 font-mono text-xs sm:text-sm" style={{ background: 'var(--term-bg)', color: 'var(--term-fg)' }}>
            {exercise.solucion}
          </pre>
          <Button variant="secondary" onClick={() => replace(exercise.solucion!)}>
            Cargarla en el editor
          </Button>
        </Callout>
      )}
    </div>
  )
}
