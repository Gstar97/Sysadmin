import '@xyflow/react/dist/style.css'
import {
  Background,
  BaseEdge,
  ConnectionMode,
  Controls,
  EdgeLabelRenderer,
  getStraightPath,
  Handle,
  Position,
  ReactFlow,
  useInternalNode,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { checkObjective, IosSession, Network, runningConfig } from '@/engines/network'
import { formatIpv4 } from '@/engines/network/ip'
import { isSwitch, shortIfName, type Device, type PingResult, type Port } from '@/engines/network/model'
import { deviceSpecSchema, type DeviceType, type TopologyExercise } from '@/engines/network/schema'
import { cn } from '@/lib/cn'
import { useIsDark } from '@/lib/theme'
import { Badge, Button, Callout, Icon, RichText } from '@/ui'
import { wrapIos } from '../terminal/ios-term'
import { Terminal } from '../terminal/Terminal'
import { DeviceIcon, deviceLabel } from './DeviceIcon'
import { DeviceForm } from './DeviceForm'

interface Props {
  exercise: TopologyExercise
  onComplete?: () => void
}

type Selection = { kind: 'device'; id: string } | { kind: 'link'; index: number } | undefined

interface DeviceNodeData extends Record<string, unknown> {
  dev: Device
  ips: string[]
  connectable: boolean
  version: number
}

const TYPE_COLORS: Record<DeviceType, string> = {
  pc: 'text-info',
  servidor: 'text-accent',
  switch: 'text-ok',
  switch_l3: 'text-ok',
  router: 'text-warn',
}

function DeviceNode({ data, selected }: NodeProps<Node<DeviceNodeData>>) {
  const d = data.dev
  return (
    <div className={cn('flex w-28 flex-col items-center rounded-lg px-1 py-1 text-center', selected && 'bg-accent-soft ring-2 ring-accent')}>
      {[Position.Top, Position.Right, Position.Bottom, Position.Left].map((p) => (
        <Handle key={p} id={p} type="source" position={p} isConnectable={data.connectable} className={cn('!h-2.5 !w-2.5 !border-0 !bg-muted/60', !data.connectable && '!opacity-0')} />
      ))}
      <DeviceIcon type={d.type} className={TYPE_COLORS[d.type]} />
      <div className="max-w-full truncate text-xs font-semibold text-fg">{d.hostname}</div>
      {data.ips.slice(0, 2).map((ip) => (
        <div key={ip} className="max-w-full truncate font-mono text-[10px] text-muted">
          {ip}
        </div>
      ))}
    </div>
  )
}

interface LinkEdgeData extends Record<string, unknown> {
  aLabel: string
  bLabel: string
  up: boolean
  highlighted: boolean
}

function LinkEdge({ id, source, target, data, selected }: EdgeProps<Edge<LinkEdgeData>>) {
  const s = useInternalNode(source)
  const t = useInternalNode(target)
  if (!s || !t || !data) return null
  const sx = s.internals.positionAbsolute.x + (s.measured.width ?? 0) / 2
  const sy = s.internals.positionAbsolute.y + (s.measured.height ?? 0) / 2 - 8
  const tx = t.internals.positionAbsolute.x + (t.measured.width ?? 0) / 2
  const ty = t.internals.positionAbsolute.y + (t.measured.height ?? 0) / 2 - 8
  const [path] = getStraightPath({ sourceX: sx, sourceY: sy, targetX: tx, targetY: ty })
  const at = (f: number) => ({ x: sx + (tx - sx) * f, y: sy + (ty - sy) * f })
  const a = at(0.27)
  const b = at(0.73)
  const color = data.highlighted ? 'var(--accent)' : data.up ? 'var(--ok)' : 'var(--bad)'
  return (
    <>
      <BaseEdge id={id} path={path} className={data.highlighted ? 'topo-flow' : undefined} style={{ stroke: color, strokeWidth: selected || data.highlighted ? 3.5 : 2, strokeDasharray: data.up || data.highlighted ? undefined : '5 4' }} />
      <EdgeLabelRenderer>
        {[
          { p: a, text: data.aLabel },
          { p: b, text: data.bLabel },
        ].map(({ p, text }, i) => (
          <div key={i} className="nodrag nopan pointer-events-none absolute rounded bg-surface/90 px-1 font-mono text-[10px] text-muted" style={{ transform: `translate(-50%, -50%) translate(${p.x}px, ${p.y}px)` }}>
            {text}
          </div>
        ))}
      </EdgeLabelRenderer>
    </>
  )
}

const nodeTypes = { device: DeviceNode }
const edgeTypes = { link: LinkEdge }

const ID_PREFIX: Record<DeviceType, string> = { pc: 'PC', servidor: 'SRV', switch: 'SW', switch_l3: 'MLS', router: 'R' }

/** Elige un puerto libre, prefiriendo los Gigabit para enlaces entre equipos de red. */
function freePort(net: Network, d: Device, peer: Device): Port | undefined {
  const free = d.ports.filter((p) => p.kind === 'phys' && !net.linkOf(d.id, p.name))
  if (isSwitch(d) && (isSwitch(peer) || peer.type === 'router')) {
    const uplink = [...free].reverse().find((p) => p.name.startsWith('Gigabit'))
    if (uplink) return uplink
  }
  return free[0]
}

function pathLinks(net: Network, result: PingResult | undefined): Set<number> {
  const out = new Set<number>()
  if (!result) return out
  for (const h of [...result.forward, ...result.back]) {
    const chain = [h.from, ...h.via, h.to]
    for (let i = 0; i + 1 < chain.length; i++) {
      const idx = net.links.findIndex((l) => (l.a.dev === chain[i] && l.b.dev === chain[i + 1]) || (l.b.dev === chain[i] && l.a.dev === chain[i + 1]))
      if (idx !== -1) out.add(idx)
    }
  }
  return out
}

export function TopologyBuilder({ exercise, onComplete }: Props) {
  const [net, setNet] = useState(() => new Network(exercise))
  const [version, bump] = useReducer((x: number) => x + 1, 0)
  const [selection, setSelection] = useState<Selection>()
  const [ping, setPing] = useState<{ from: string; to: string; result?: PingResult }>(() => {
    const hosts = exercise.dispositivos.filter((d) => d.tipo === 'pc' || d.tipo === 'servidor')
    return { from: hosts[0]?.id ?? exercise.dispositivos[0]?.id ?? '', to: hosts[1]?.id ?? '' }
  })
  const [consoleFor, setConsoleFor] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [whyOpen, setWhyOpen] = useState<number | undefined>()
  const isDark = useIsDark()
  const editable = exercise.editable
  const completed = useRef(false)

  const changed = () => {
    bump()
    setPing((p) => ({ ...p, result: undefined }))
  }

  const highlighted = useMemo(() => pathLinks(net, ping.result?.ok ? ping.result : undefined), [net, ping.result])

  const nodes: Node<DeviceNodeData>[] = useMemo(
    () =>
      [...net.devices.values()].map((d) => ({
        id: d.id,
        type: 'device',
        position: { x: d.x, y: d.y },
        selected: selection?.kind === 'device' && selection.id === d.id,
        data: {
          dev: d,
          version,
          connectable: editable.enlaces,
          ips: d.ports.filter((p) => p.ip).map((p) => `${formatIpv4(p.ip!.ip)}/${p.ip!.prefix}`),
        },
      })),
    [net, version, selection, editable.enlaces],
  )

  const edges: Edge<LinkEdgeData>[] = useMemo(
    () =>
      net.links.map((l, i) => {
        const a = net.devices.get(l.a.dev)!
        const b = net.devices.get(l.b.dev)!
        const pa = net.port(a, l.a.port)
        const pb = net.port(b, l.b.port)
        return {
          id: `link-${i}-${version}`,
          source: l.a.dev,
          target: l.b.dev,
          type: 'link',
          selected: selection?.kind === 'link' && selection.index === i,
          data: { aLabel: shortIfName(l.a.port), bLabel: shortIfName(l.b.port), up: !!pa && !!pb && net.physUp(a, pa), highlighted: highlighted.has(i) },
        }
      }),
    [net, version, selection, highlighted],
  )

  const objectives = useMemo(() => {
    void version
    return exercise.objetivos.map((o) => checkObjective(net, o))
  }, [net, version, exercise.objetivos])
  const allOk = objectives.length > 0 && objectives.every((o) => o.ok)

  useEffect(() => {
    if (allOk && !completed.current) {
      completed.current = true
      onComplete?.()
    }
  }, [allOk, onComplete])

  const onNodesChange = (changes: NodeChange<Node<DeviceNodeData>>[]) => {
    let moved = false
    for (const c of changes) {
      if (c.type === 'position' && c.position) {
        const d = net.devices.get(c.id)
        if (d) {
          d.x = c.position.x
          d.y = c.position.y
          moved = true
        }
      } else if (c.type === 'select' && c.selected) setSelection({ kind: 'device', id: c.id })
    }
    if (moved) bump()
  }

  const onConnect = (c: Connection) => {
    if (!editable.enlaces || c.source === c.target) return
    const a = net.devices.get(c.source)!
    const b = net.devices.get(c.target)!
    const pa = freePort(net, a, b)
    const pb = freePort(net, b, a)
    if (!pa || !pb) {
      setNotice(`${!pa ? a.hostname : b.hostname} no tiene puertos libres. Quita otro cable antes de conectar este.`)
      return
    }
    net.connect({ dev: a.id, port: pa.name }, { dev: b.id, port: pb.name })
    setNotice(`Cable conectado: ${a.hostname} ${shortIfName(pa.name)} ↔ ${b.hostname} ${shortIfName(pb.name)}. Puedes cambiar los puertos tocando el cable.`)
    changed()
  }

  const addDevice = (type: DeviceType) => {
    let n = 1
    while (net.device(`${ID_PREFIX[type]}${n}`)) n++
    const id = `${ID_PREFIX[type]}${n}`
    const count = net.devices.size
    net.addDevice(deviceSpecSchema.parse({ id, tipo: type, x: 80 + (count % 5) * 140, y: 60 + Math.floor(count / 5) * 140 }))
    setSelection({ kind: 'device', id })
    changed()
  }

  const removeDevice = (id: string) => {
    net.removeDevice(id)
    setSelection(undefined)
    changed()
  }

  const reset = () => {
    setNet(new Network(exercise))
    setSelection(undefined)
    setPing((p) => ({ ...p, result: undefined }))
    setNotice(undefined)
    completed.current = false
    bump()
  }

  const runPing = () => {
    const result = net.ping(ping.from, ping.to)
    setPing({ ...ping, result })
    bump()
  }

  const hostOptions = [...net.devices.values()].filter((d) => d.ports.some((p) => p.ip))
  const selectedDevice = selection?.kind === 'device' ? net.devices.get(selection.id) : undefined
  const selectedLink = selection?.kind === 'link' ? net.links[selection.index] : undefined

  return (
    <div className="my-6 space-y-3">
      {(exercise.titulo || exercise.consigna) && (
        <div>
          {exercise.titulo && <h3 className="text-lg font-semibold">{exercise.titulo}</h3>}
          {exercise.consigna && <RichText text={exercise.consigna} />}
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line p-2">
          {editable.equipos &&
            exercise.paleta.map((t) => (
              <button key={t} type="button" onClick={() => addDevice(t)} className="flex min-h-9 items-center gap-1 rounded-lg border border-line px-2 text-xs hover:bg-surface-2" title={`Agregar ${deviceLabel(t)}`}>
                <DeviceIcon type={t} size={22} className={TYPE_COLORS[t]} />
                <span className="hidden sm:inline">{deviceLabel(t)}</span>
                <span className="sm:hidden">+</span>
              </button>
            ))}
          <button type="button" onClick={reset} className="ml-auto flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs text-muted hover:bg-surface-2">
            <Icon name="refresh" className="h-4 w-4" />
            Reiniciar
          </button>
        </div>
        <div className="h-[380px] sm:h-[460px]">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onEdgeClick={(_, e) => setSelection({ kind: 'link', index: Number(e.id.split('-')[1]) })}
            onPaneClick={() => setSelection(undefined)}
            connectionMode={ConnectionMode.Loose}
            colorMode={isDark ? 'dark' : 'light'}
            nodesDraggable
            fitView
            fitViewOptions={{ padding: 0.25 }}
            minZoom={0.3}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={null}
          >
            <Background gap={20} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        {notice && (
          <div className="flex items-start gap-2 border-t border-line px-3 py-2 text-sm text-muted">
            <Icon name="info" className="mt-0.5 h-4 w-4" />
            <span className="flex-1">{notice}</span>
            <button type="button" onClick={() => setNotice(undefined)} aria-label="Cerrar aviso">
              <Icon name="close" className="h-4 w-4" />
            </button>
          </div>
        )}
        {editable.enlaces && !notice && <p className="border-t border-line px-3 py-2 text-xs text-muted">Para conectar un cable, arrastra desde uno de los puntos de un equipo hasta otro equipo. Toca un equipo o un cable para configurarlo.</p>}
      </div>

      {selectedDevice && (
        <DeviceForm
          key={`${selectedDevice.id}-${version}`}
          net={net}
          dev={selectedDevice}
          editable={editable.configuracion}
          onChange={changed}
          onDelete={editable.equipos ? () => removeDevice(selectedDevice.id) : undefined}
          onConsole={selectedDevice.type === 'router' || isSwitch(selectedDevice) ? () => setConsoleFor(selectedDevice.id) : undefined}
          config={selectedDevice.type === 'router' || isSwitch(selectedDevice) ? runningConfig(selectedDevice) : undefined}
        />
      )}
      {selectedLink && selection?.kind === 'link' && (
        <LinkForm
          net={net}
          index={selection.index}
          editable={editable.enlaces}
          onChange={changed}
          onDelete={() => {
            net.removeLink(selection.index)
            setSelection(undefined)
            changed()
          }}
        />
      )}

      <div className="rounded-xl border border-line bg-surface p-4">
        <h4 className="mb-2 font-semibold">Probar conectividad (ping)</h4>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="mb-1 block text-muted">Desde</span>
            <select className="min-h-10 rounded-lg border border-line bg-bg px-2" value={ping.from} onChange={(e) => setPing({ ...ping, from: e.target.value, result: undefined })}>
              {hostOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.hostname}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted">Hacia (equipo o IP)</span>
            <input list="topo-targets" className="min-h-10 w-40 rounded-lg border border-line bg-bg px-2 font-mono" value={ping.to} onChange={(e) => setPing({ ...ping, to: e.target.value, result: undefined })} />
            <datalist id="topo-targets">
              {hostOptions.map((d) => (
                <option key={d.id} value={d.id} />
              ))}
            </datalist>
          </label>
          <Button onClick={runPing} disabled={!ping.from || !ping.to}>
            <Icon name="play" className="h-4 w-4" />
            Ping
          </Button>
        </div>
        {ping.result && (
          <div className="mt-3">
            {ping.result.ok ? (
              <Callout tone="ok" title="Responde">
                Recorrido de ida:{' '}
                <span className="font-mono text-sm">
                  {[ping.from, ...ping.result.forward.flatMap((h) => [...h.via, h.to])].map((id) => net.devices.get(id)?.hostname ?? id).join(' → ') || 'el mismo equipo'}
                </span>
                . El camino queda resaltado en el diagrama.
              </Callout>
            ) : (
              <Callout tone="bad" title="No responde">
                {ping.result.reason}
              </Callout>
            )}
          </div>
        )}
      </div>

      {exercise.objetivos.length > 0 && (
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-2 flex items-center gap-2">
            <h4 className="font-semibold">Objetivos</h4>
            <Badge tone={allOk ? 'ok' : 'neutral'}>
              {objectives.filter((o) => o.ok).length}/{objectives.length}
            </Badge>
          </div>
          <ul className="space-y-1.5 text-sm">
            {objectives.map((o, i) => (
              <li key={i}>
                <div className={cn('flex items-start gap-2', o.ok ? 'text-ok' : 'text-fg')}>
                  <Icon name={o.ok ? 'check' : 'target'} className="mt-0.5 h-4 w-4" />
                  <span className="flex-1">{o.label}</span>
                  {!o.ok && (o.reason || exercise.objetivos[i].resultado === 'falla') && (
                    <button type="button" className="text-xs text-accent underline" onClick={() => setWhyOpen(whyOpen === i ? undefined : i)}>
                      {whyOpen === i ? 'Ocultar' : '¿Por qué no se cumple?'}
                    </button>
                  )}
                </div>
                {whyOpen === i && !o.ok && <p className="ml-6 mt-1 text-muted">{o.reason ?? 'El tráfico llega, pero este objetivo pide que esté bloqueado.'}</p>}
              </li>
            ))}
          </ul>
          {allOk && (
            <Callout tone="ok" className="mt-3" title="¡Topología funcionando!">
              Se cumplen todos los objetivos.
            </Callout>
          )}
        </div>
      )}

      {consoleFor && (
        <ConsoleDialog
          net={net}
          deviceId={consoleFor}
          onCommand={changed}
          onClose={() => {
            setConsoleFor(undefined)
            changed()
          }}
        />
      )}
    </div>
  )
}

function ConsoleDialog({ net, deviceId, onCommand, onClose }: { net: Network; deviceId: string; onCommand: () => void; onClose: () => void }) {
  const session = useMemo(() => {
    const s = new IosSession(net, deviceId)
    return wrapIos(s)
  }, [net, deviceId])
  const name = net.devices.get(deviceId)?.hostname ?? deviceId
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-2 sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label={`Consola de ${name}`}>
      <div className="w-full max-w-3xl">
        <div className="mb-2 flex items-center justify-between text-white">
          <span className="font-medium">Consola de {name}</span>
          <Button variant="secondary" onClick={onClose}>
            Cerrar
          </Button>
        </div>
        <Terminal session={session} onCommand={onCommand} autoFocus banner={`Conectado por consola a ${name}. Los cambios se ven en el diagrama al instante.`} />
      </div>
    </div>
  )
}

function LinkForm({ net, index, editable, onChange, onDelete }: { net: Network; index: number; editable: boolean; onChange: () => void; onDelete: () => void }) {
  const link = net.links[index]
  const ends = [link.a, link.b]
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="font-semibold">Cable</h4>
        {editable && (
          <Button variant="ghost" onClick={onDelete}>
            <Icon name="trash" className="h-4 w-4" />
            Quitar cable
          </Button>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {ends.map((end, i) => {
          const d = net.devices.get(end.dev)!
          const options = d.ports.filter((p) => p.kind === 'phys' && (p.name === end.port || !net.linkOf(d.id, p.name)))
          return (
            <label key={i} className="text-sm">
              <span className="mb-1 block text-muted">Puerto en {d.hostname}</span>
              <select
                className="min-h-10 w-full rounded-lg border border-line bg-bg px-2 font-mono"
                value={end.port}
                disabled={!editable}
                onChange={(e) => {
                  end.port = e.target.value
                  onChange()
                }}
              >
                {options.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )
        })}
      </div>
    </div>
  )
}
