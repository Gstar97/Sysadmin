/**
 * Componentes disponibles dentro de las lecciones (MDX). Los interactivos pesados se cargan
 * solo cuando la lección los usa.
 */
import { Children, createContext, isValidElement, lazy, Suspense, useContext, useEffect, useId, useMemo, useState, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { Link } from 'react-router'
import type { z } from 'zod'
import { content, loadQuestionBank, type LessonEntry } from '@/content'
import { exerciseSchemas, terminalExerciseSchema } from '@/content/exercise-schemas'
import type { Question } from '@/content/schemas'
import { emptyResponse, gradeQuestion, isAnswered, type GradeResult, type Response } from '@/engines/assessment/grading'
import { presentationFor } from '@/engines/assessment/sampling'
import { QuestionView } from '@/interactive/quiz/QuestionView'
import { cn } from '@/lib/cn'
import { createRng } from '@/lib/random'
import { slugify } from '@/lib/slug'
import { Button, Callout, Icon, Spinner } from '@/ui'

export interface LessonContextValue {
  lesson?: LessonEntry
}

export const LessonContext = createContext<LessonContextValue>({})

const TerminalExercise = lazy(() => import('@/interactive/terminal/TerminalExercise').then((m) => ({ default: m.TerminalExercise })))
const TopologyBuilder = lazy(() => import('@/interactive/topology/TopologyBuilder').then((m) => ({ default: m.TopologyBuilder })))
const ConfigEditor = lazy(() => import('@/interactive/config/ConfigEditor').then((m) => ({ default: m.ConfigEditor })))
const SubnettingTool = lazy(() => import('@/interactive/subnetting/Subnetting').then((m) => ({ default: m.Subnetting })))
const PacketSimulator = lazy(() => import('@/interactive/packets/PacketSimulator').then((m) => ({ default: m.PacketSimulator })))
const OrderExercise = lazy(() => import('@/interactive/dnd/OrderExercise').then((m) => ({ default: m.OrderExercise })))
const MatchExercise = lazy(() => import('@/interactive/dnd/MatchExercise').then((m) => ({ default: m.MatchExercise })))
const TroubleshootingRunner = lazy(() => import('@/interactive/troubleshooting/Troubleshooting').then((m) => ({ default: m.Troubleshooting })))
const InteractiveDiagram = lazy(() => import('@/interactive/diagrams/Diagram').then((m) => ({ default: m.InteractiveDiagram })))
const StaticDiagram = lazy(() => import('@/interactive/diagrams/Diagram').then((m) => ({ default: m.Diagram })))

function Loading() {
  return <Spinner label="Cargando el ejercicio…" />
}

/** Valida los datos de un ejercicio con su esquema y muestra un aviso claro si están mal. */
function useExercise<T extends keyof typeof exerciseSchemas>(tipo: T, data: unknown): { value?: z.infer<(typeof exerciseSchemas)[T]>; error?: string } {
  return useMemo(() => {
    const r = exerciseSchemas[tipo].safeParse(data)
    if (r.success) return { value: r.data as z.infer<(typeof exerciseSchemas)[T]> }
    return { error: r.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; ') }
  }, [tipo, data])
}

function ExerciseError({ error }: { error: string }) {
  return (
    <Callout tone="bad" title="Este ejercicio tiene un error en sus datos">
      <code className="text-xs">{error}</code>
    </Callout>
  )
}

// ---------------------------------------------------------------------------------------
// Texto y estructura
// ---------------------------------------------------------------------------------------

export function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children)
  return ''
}

function Heading({ level, children, ...rest }: { level: 2 | 3 } & ComponentProps<'h2'>) {
  const id = slugify(textOf(children))
  const Tag = level === 2 ? 'h2' : 'h3'
  return (
    <Tag id={id} {...rest} className="group">
      {children}
      <a href={`#${id}`} className="ml-2 text-muted no-underline opacity-0 transition group-hover:opacity-100 focus:opacity-100" aria-label="Enlace a esta sección">
        #
      </a>
    </Tag>
  )
}

function CodeBlock({ children }: ComponentProps<'pre'>) {
  const [copied, setCopied] = useState(false)
  const child = Children.only(children) as ReactElement<{ className?: string; children?: ReactNode }>
  const lang = /language-(\S+)/.exec(child?.props?.className ?? '')?.[1]
  const text = textOf(child?.props?.children).replace(/\n$/, '')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="group relative">
      {lang && <span className="absolute left-3 top-1 select-none text-[10px] uppercase tracking-wide" style={{ color: 'var(--term-muted)' }}>{lang}</span>}
      <pre className={cn(lang && 'pt-6')}>{children}</pre>
      <button type="button" onClick={() => void copy()} className="absolute right-2 top-2 rounded-md px-2 py-1 text-xs opacity-70 transition hover:opacity-100" style={{ background: 'rgb(255 255 255 / 10%)', color: 'var(--term-fg)' }} aria-label="Copiar el código">
        {copied ? 'Copiado' : 'Copiar'}
      </button>
    </div>
  )
}

function Anchor({ href = '', children, ...rest }: ComponentProps<'a'>) {
  if (href.startsWith('/')) {
    return (
      <Link to={href} {...rest}>
        {children}
      </Link>
    )
  }
  const external = /^https?:\/\//.test(href)
  return (
    <a href={href} {...rest} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
      {children}
      {external && <span className="sr-only"> (se abre en otra pestaña)</span>}
    </a>
  )
}

function Table(props: ComponentProps<'table'>) {
  return (
    <div className="overflow-x-auto">
      <table {...props} />
    </div>
  )
}

export function Nota({ titulo, children }: { titulo?: string; children: ReactNode }) {
  return (
    <Callout tone="info" title={titulo ?? 'Nota'}>
      {children}
    </Callout>
  )
}

export function Consejo({ titulo, children }: { titulo?: string; children: ReactNode }) {
  return (
    <Callout tone="ok" title={titulo ?? 'Consejo práctico'}>
      {children}
    </Callout>
  )
}

export function Advertencia({ titulo, children }: { titulo?: string; children: ReactNode }) {
  return (
    <Callout tone="warn" title={titulo ?? 'Atención'}>
      {children}
    </Callout>
  )
}

export function Importante({ titulo, children }: { titulo?: string; children: ReactNode }) {
  return (
    <Callout tone="bad" title={titulo ?? 'Importante'}>
      {children}
    </Callout>
  )
}

export function ErroresComunes({ children }: { children: ReactNode }) {
  return (
    <section className="mt-10" aria-labelledby="errores-comunes">
      <h2 id="errores-comunes" className="mb-3 flex items-center gap-2 text-[1.45rem] font-bold">
        <Icon name="alert" className="text-warn" />
        Errores comunes y cómo diagnosticarlos
      </h2>
      <div className="space-y-2">{children}</div>
    </section>
  )
}

export function ErrorComun({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <details className="group rounded-xl border border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-start gap-2 px-4 py-3 font-medium">
        <Icon name="arrowRight" className="mt-0.5 h-4 w-4 text-warn transition group-open:rotate-90" />
        <span>{titulo}</span>
      </summary>
      <div className="prosa space-y-2 px-4 pb-4 text-[0.97rem]">{children}</div>
    </details>
  )
}

export function Resumen({ children }: { children: ReactNode }) {
  return (
    <section className="mt-10" aria-labelledby="resumen">
      <h2 id="resumen" className="mb-3 flex items-center gap-2 text-[1.45rem] font-bold">
        <Icon name="book" className="text-accent" />
        Resumen
      </h2>
      <div className="prosa rounded-xl border-l-4 border-accent bg-accent-soft/40 px-5 py-4">{children}</div>
    </section>
  )
}

const glossaryById = new Map(content.glossary.map((g) => [g.id, g]))

export function Termino({ id, children }: { id: string; children?: ReactNode }) {
  const entry = glossaryById.get(id)
  if (!entry) return <>{children ?? id}</>
  return (
    <Link to={`/glosario#${entry.id}`} title={entry.definicion} className="decoration-dotted underline-offset-4">
      {children ?? entry.termino}
    </Link>
  )
}

/** Pestañas para mostrar diferencias entre distribuciones o versiones. */
export function Distros({ children }: { children: ReactNode }) {
  const items = Children.toArray(children).filter(isValidElement) as ReactElement<{ nombre: string; children: ReactNode }>[]
  const [active, setActive] = useState(0)
  const id = useId()
  return (
    <div className="my-5 rounded-xl border border-line">
      <div className="flex gap-1 overflow-x-auto border-b border-line p-1" role="tablist">
        {items.map((it, i) => (
          <button key={i} type="button" role="tab" id={`${id}-t${i}`} aria-controls={`${id}-p${i}`} aria-selected={active === i} onClick={() => setActive(i)} className={cn('min-h-9 whitespace-nowrap rounded-lg px-3 text-sm font-medium', active === i ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2')}>
            {it.props.nombre}
          </button>
        ))}
      </div>
      {items.map((it, i) => (
        <div key={i} id={`${id}-p${i}`} role="tabpanel" aria-labelledby={`${id}-t${i}`} hidden={active !== i} className="prosa px-4 py-3">
          {it.props.children}
        </div>
      ))}
    </div>
  )
}

export function Distro({ children }: { nombre: string; children: ReactNode }) {
  return <>{children}</>
}

// ---------------------------------------------------------------------------------------
// Interactivos
// ---------------------------------------------------------------------------------------

export function Diagrama(props: { svg?: string; src?: string; alt: string; pie?: string }) {
  return (
    <Suspense fallback={<Loading />}>
      <StaticDiagram {...props} />
    </Suspense>
  )
}

export function DiagramaInteractivo({ datos, svg, src, alt }: { datos: unknown; svg?: string; src?: string; alt: string }) {
  const { value, error } = useExercise('diagrama', datos)
  if (error) return <ExerciseError error={error} />
  return (
    <Suspense fallback={<Loading />}>
      <InteractiveDiagram datos={value!} svg={svg} src={src} alt={alt} />
    </Suspense>
  )
}

export function Terminal({ ejercicio, shell = 'bash', estado, titulo }: { ejercicio?: unknown; shell?: 'bash' | 'powershell' | 'ios'; estado?: unknown; titulo?: string }) {
  const parsed = useMemo(() => terminalExerciseSchema.safeParse(ejercicio ?? { tipo: 'terminal', shell, titulo, ...(estado !== undefined ? { estado_inicial: estado } : {}) }), [ejercicio, shell, titulo, estado])
  if (!parsed.success) return <ExerciseError error={parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')} />
  return (
    <Suspense fallback={<Loading />}>
      <TerminalExercise exercise={parsed.data} />
    </Suspense>
  )
}

export function Subnetting(props: ComponentProps<typeof SubnettingTool>) {
  return (
    <Suspense fallback={<Loading />}>
      <SubnettingTool {...props} />
    </Suspense>
  )
}

export function Topologia({ ejercicio }: { ejercicio: unknown }) {
  const { value, error } = useExercise('topologia', ejercicio)
  if (error) return <ExerciseError error={error} />
  return (
    <Suspense fallback={<Loading />}>
      <TopologyBuilder exercise={value!} />
    </Suspense>
  )
}

export function SimuladorPaquetes({ escenario }: { escenario: unknown }) {
  const { value, error } = useExercise('paquetes', escenario)
  if (error) return <ExerciseError error={error} />
  return (
    <Suspense fallback={<Loading />}>
      <PacketSimulator scenario={value!} />
    </Suspense>
  )
}

export function Ordenar({ ejercicio }: { ejercicio: unknown }) {
  const { value, error } = useExercise('ordenar', ejercicio)
  if (error) return <ExerciseError error={error} />
  return (
    <Suspense fallback={<Loading />}>
      <OrderExercise exercise={value!} />
    </Suspense>
  )
}

export function Emparejar({ ejercicio }: { ejercicio: unknown }) {
  const { value, error } = useExercise('emparejar', ejercicio)
  if (error) return <ExerciseError error={error} />
  return (
    <Suspense fallback={<Loading />}>
      <MatchExercise exercise={value!} />
    </Suspense>
  )
}

export function Troubleshooting({ escenario }: { escenario: unknown }) {
  const { value, error } = useExercise('troubleshooting', escenario)
  if (error) return <ExerciseError error={error} />
  return (
    <Suspense fallback={<Loading />}>
      <TroubleshootingRunner scenario={value!} />
    </Suspense>
  )
}

export function EditorConfig({ ejercicio }: { ejercicio: unknown }) {
  const { value, error } = useExercise('configuracion', ejercicio)
  if (error) return <ExerciseError error={error} />
  return (
    <Suspense fallback={<Loading />}>
      <ConfigEditor exercise={value!} />
    </Suspense>
  )
}

/** Una pregunta del banco de la lección, para practicar en medio de la explicación. */
export function Pregunta({ id }: { id: string }) {
  const { lesson } = useContext(LessonContext)
  const [question, setQuestion] = useState<Question | null | undefined>(undefined)
  const [response, setResponse] = useState<Response>()
  const [result, setResult] = useState<GradeResult>()
  const presentation = useMemo(() => (question ? presentationFor(createRng(id.length * 7919), question) : undefined), [question, id])

  useEffect(() => {
    if (!lesson) return
    let cancelled = false
    void loadQuestionBank(lesson).then((bank) => {
      if (cancelled) return
      const q = bank.find((x) => x.id === id) ?? null
      setQuestion(q)
      if (q) setResponse(emptyResponse(q, presentationFor(createRng(id.length * 7919), q).stepOrder))
    })
    return () => {
      cancelled = true
    }
  }, [lesson, id])

  if (!lesson) return null
  if (question === null) return <ExerciseError error={`No existe la pregunta "${id}" en preguntas.yaml`} />
  if (question === undefined || !presentation || !response) return <Loading />
  const q: Question = question
  const check = async () => setResult(await gradeQuestion(q, response))
  return (
    <div className="my-6 rounded-xl border border-line bg-surface p-4 shadow-card">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-accent">
        <Icon name="target" className="h-4 w-4" />
        Para practicar
      </div>
      <QuestionView question={q} presentation={presentation} response={response} onChange={setResponse} onSubmit={() => void check()} result={result} />
      <div className="mt-3 flex gap-2">
        {!result ? (
          <Button onClick={() => void check()} disabled={!isAnswered(response)}>
            Comprobar
          </Button>
        ) : (
          <Button
            variant="ghost"
            onClick={() => {
              setResult(undefined)
              setResponse(emptyResponse(q, presentation.stepOrder))
            }}
          >
            Intentar de nuevo
          </Button>
        )}
      </div>
    </div>
  )
}

export const mdxComponents = {
  h2: (props: ComponentProps<'h2'>) => <Heading level={2} {...props} />,
  h3: (props: ComponentProps<'h3'>) => <Heading level={3} {...props} />,
  pre: CodeBlock,
  a: Anchor,
  table: Table,
  Nota,
  Consejo,
  Advertencia,
  Importante,
  ErroresComunes,
  ErrorComun,
  Resumen,
  Termino,
  Distros,
  Distro,
  Diagrama,
  DiagramaInteractivo,
  Terminal,
  Subnetting,
  Topologia,
  SimuladorPaquetes,
  Ordenar,
  Emparejar,
  Troubleshooting,
  EditorConfig,
  Pregunta,
}
