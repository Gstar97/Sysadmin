import { useMemo, useState } from 'react'
import { CHALLENGES, curlFor, explain, handle, HOST, rawRequest, REASONS, rawResponse, type Method, type SimRequest, type SimResponse, type Version } from '@/engines/web/httpsim'
import { cn } from '@/lib/cn'
import { Badge, Button, Icon } from '@/ui'
import { Chip, Frame, inputClass } from '../fundamentos/Frame'

const METHODS: Method[] = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']
const VERSIONS: Version[] = ['HTTP/1.1', 'HTTP/2', 'HTTP/3']

const START: [string, string][] = [
  ['Host', HOST],
  ['User-Agent', 'curl/8.12.1'],
  ['Accept', '*/*'],
]

const SUGERIDOS: [string, string][] = [
  ['Content-Type', 'application/json'],
  ['Authorization', 'Bearer '],
  ['Cookie', 'sesion='],
  ['If-None-Match', ''],
  ['Accept-Encoding', 'gzip'],
]

const VERSION_NOTE: Record<Version, string> = {
  'HTTP/1.1': 'Texto plano sobre TCP: una solicitud por vez en cada conexión. Es lo que se ve con curl -v.',
  'HTTP/2': 'Binario sobre TCP con TLS: muchas solicitudes a la vez en la misma conexión, encabezados comprimidos y en minúsculas, y pseudoencabezados (:method, :path, :authority).',
  'HTTP/3': 'Lo mismo que HTTP/2 pero sobre QUIC, que va por UDP (puerto 443): menos espera al conectar y no se traba si se pierde un paquete. Necesita que el firewall deje pasar UDP 443.',
}

function statusTone(s: number): 'ok' | 'info' | 'warn' | 'bad' {
  return s < 300 ? 'ok' : s < 400 ? 'info' : s < 500 ? 'warn' : 'bad'
}

interface Sent {
  req: SimRequest
  res: SimResponse
}

/** Constructor de solicitudes HTTP contra un servidor de práctica, con desafíos. */
export function HttpBuilder() {
  const [method, setMethod] = useState<Method>('GET')
  const [path, setPath] = useState('/')
  const [version, setVersion] = useState<Version>('HTTP/1.1')
  const [headers, setHeaders] = useState<[string, string][]>(START)
  const [body, setBody] = useState('')
  const [history, setHistory] = useState<Sent[]>([])
  const [done, setDone] = useState<Set<string>>(new Set())

  const last = history[0]
  const req: SimRequest = useMemo(() => ({ method, path: path.startsWith('/') ? path : `/${path}`, version, headers, body: method === 'GET' || method === 'HEAD' ? '' : body }), [method, path, version, headers, body])

  const send = () => {
    const res = handle(req)
    setHistory((h) => [{ req, res }, ...h].slice(0, 8))
    const next = new Set(done)
    for (const c of CHALLENGES) if (c.ok(req, res)) next.add(c.id)
    setDone(next)
  }

  const setHeader = (i: number, k: number, v: string) => setHeaders((hs) => hs.map((h, j) => (j === i ? ((k === 0 ? [v, h[1]] : [h[0], v]) as [string, string]) : h)))
  const addHeader = (h: [string, string]) => setHeaders((hs) => (hs.some(([k]) => k.toLowerCase() === h[0].toLowerCase()) ? hs : [...hs, h]))

  return (
    <Frame titulo="Constructor de solicitudes HTTP" acciones={<Badge tone="info">{HOST}</Badge>}>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Método">
            {METHODS.map((m) => (
              <Chip key={m} active={method === m} onClick={() => setMethod(m)}>
                {m}
              </Chip>
            ))}
          </div>
          <label className="block text-sm">
            <span className="text-muted">Ruta</span>
            <input className={cn(inputClass, 'mt-1 w-full')} value={path} onChange={(e) => setPath(e.target.value)} aria-label="Ruta" spellCheck={false} />
          </label>
          <div className="flex flex-wrap gap-1 text-xs">
            {['/', '/productos', '/productos/7', '/productos/99', '/login', '/perfil', '/viejo', '/admin', '/error', '/mantenimiento'].map((p) => (
              <button key={p} type="button" className="rounded border border-line px-2 py-1 font-mono hover:bg-surface-2" onClick={() => setPath(p)}>
                {p}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Versión de HTTP">
            {VERSIONS.map((v) => (
              <Chip key={v} active={version === v} onClick={() => setVersion(v)}>
                {v}
              </Chip>
            ))}
          </div>
          <p className="text-xs text-muted">{VERSION_NOTE[version]}</p>
          <fieldset className="space-y-2">
            <legend className="text-sm text-muted">Encabezados</legend>
            {headers.map(([k, v], i) => (
              <div key={i} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] gap-1">
                <input className={cn(inputClass, 'min-w-0 text-sm')} value={k} onChange={(e) => setHeader(i, 0, e.target.value)} aria-label={`Nombre del encabezado ${i + 1}`} spellCheck={false} />
                <input className={cn(inputClass, 'min-w-0 text-sm')} value={v} onChange={(e) => setHeader(i, 1, e.target.value)} aria-label={`Valor del encabezado ${i + 1}`} spellCheck={false} />
                <button type="button" className="rounded-lg border border-line px-2 hover:bg-surface-2" aria-label={`Quitar ${k || 'encabezado'}`} onClick={() => setHeaders((hs) => hs.filter((_, j) => j !== i))}>
                  <Icon name="x" className="h-4 w-4" />
                </button>
              </div>
            ))}
            <div className="flex flex-wrap gap-1 text-xs">
              {SUGERIDOS.map((h) => (
                <button key={h[0]} type="button" className="rounded border border-line px-2 py-1 hover:bg-surface-2" onClick={() => addHeader(h)}>
                  + {h[0]}
                </button>
              ))}
              <button type="button" className="rounded border border-line px-2 py-1 hover:bg-surface-2" onClick={() => setHeaders((hs) => [...hs, ['', '']])}>
                + otro
              </button>
            </div>
          </fieldset>
          {(method === 'POST' || method === 'PUT') && (
            <label className="block text-sm">
              <span className="text-muted">Cuerpo</span>
              <textarea className={cn(inputClass, 'mt-1 min-h-20 w-full py-2 text-sm')} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Cuerpo" spellCheck={false} placeholder='{"nombre":"Termo","precio":30000}' />
            </label>
          )}
          <Button onClick={send}>
            <Icon name="play" className="h-4 w-4" /> Enviar
          </Button>
          <div className="rounded-lg bg-surface-2 p-2">
            <div className="text-xs text-muted">Lo mismo con curl</div>
            <code className="block break-all font-mono text-xs">{curlFor(req)}</code>
          </div>
        </div>

        <div className="min-w-0 space-y-3">
          {last ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={statusTone(last.res.status)}>
                  {last.res.status} {REASONS[last.res.status] ?? ''}
                </Badge>
                <span className="text-sm">{explain(last.req, last.res)}</span>
              </div>
              <div>
                <div className="text-xs text-muted">Solicitud que viajó ({last.req.version})</div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-2 p-2 font-mono text-xs">{rawRequest(last.req)}</pre>
              </div>
              <div>
                <div className="text-xs text-muted">Respuesta</div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-2 p-2 font-mono text-xs" aria-live="polite">
                  {rawResponse(last.res, last.req.version)}
                </pre>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted">Armá una solicitud y tocá Enviar. Arriba, a la izquierda, está lo que se manda; acá vas a ver la respuesta tal cual llega.</p>
          )}
          <div>
            <div className="mb-1 text-sm font-medium">
              Desafíos ({done.size} de {CHALLENGES.length})
            </div>
            <ul className="space-y-1 text-sm">
              {CHALLENGES.map((c) => (
                <li key={c.id} className="flex items-start gap-2">
                  <Icon name={done.has(c.id) ? 'check' : 'target'} className={cn('mt-0.5 h-4 w-4 shrink-0', done.has(c.id) ? 'text-ok' : 'text-muted')} />
                  <span>
                    {c.texto}{' '}
                    {!done.has(c.id) && (
                      <details className="inline">
                        <summary className="inline cursor-pointer text-xs text-accent">pista</summary>
                        <span className="text-xs text-muted"> {c.pista}</span>
                      </details>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {history.length > 1 && (
            <div>
              <div className="text-xs text-muted">Anteriores</div>
              <ul className="text-xs">
                {history.slice(1).map((h, i) => (
                  <li key={i} className="font-mono">
                    {h.req.method} {h.req.path} → {h.res.status}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </Frame>
  )
}
