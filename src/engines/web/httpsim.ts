/**
 * Un servidor web de práctica (la API de una tienda) para el constructor de solicitudes HTTP:
 * métodos, códigos de estado, encabezados, cookies, ETag, redirecciones y hosts virtuales.
 * Es lógica pura, sin interfaz, para poder probarla.
 */

export type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE'
export type Version = 'HTTP/1.1' | 'HTTP/2' | 'HTTP/3'

export interface SimRequest {
  method: Method
  path: string
  version: Version
  headers: [string, string][]
  body: string
}

export interface SimResponse {
  status: number
  headers: [string, string][]
  body: string
}

export const HOST = 'tienda.ejemplo.com'
export const TOKEN = 'abc123'
export const SESSION = 's3c10n-7f2a'
const ETAG = '"v2-8c1f"'

export const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  415: 'Unsupported Media Type',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
}

const PRODUCTOS = [
  { id: 7, nombre: 'Mate de calabaza', precio: 12500 },
  { id: 8, nombre: 'Bombilla de alpaca', precio: 8900 },
  { id: 9, nombre: 'Yerbera de lata', precio: 6400 },
]

function h(req: SimRequest, name: string): string | undefined {
  return req.headers.find(([k]) => k.trim().toLowerCase() === name.toLowerCase())?.[1].trim()
}

function json(status: number, data: unknown, extra: [string, string][] = []): SimResponse {
  const body = JSON.stringify(data, null, 2) + '\n'
  return { status, headers: [['Content-Type', 'application/json; charset=utf-8'], ...extra], body }
}

function html(status: number, body: string, extra: [string, string][] = []): SimResponse {
  return { status, headers: [['Content-Type', 'text/html; charset=utf-8'], ...extra], body }
}

function cookie(req: SimRequest, name: string): string | undefined {
  const c = h(req, 'cookie')
  if (!c) return undefined
  for (const part of c.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return undefined
}

function authorized(req: SimRequest): 'ok' | 'missing' | 'wrong' {
  const a = h(req, 'authorization')
  if (!a) return 'missing'
  return a === `Bearer ${TOKEN}` ? 'ok' : 'wrong'
}

function need401(req: SimRequest): SimResponse {
  return json(401, { error: authorized(req) === 'missing' ? 'Falta el encabezado Authorization' : 'Token inválido' }, [['WWW-Authenticate', 'Bearer realm="tienda"']])
}

/** Lo que responde el servidor. */
export function handle(req: SimRequest): SimResponse {
  const res = route(req)
  const out: SimResponse = { ...res, headers: [['Server', 'nginx'], ['Date', new Date().toUTCString()], ...res.headers] }
  // En HEAD se informa el tamaño que tendría el cuerpo, pero no se manda.
  out.headers.push(['Content-Length', String(new TextEncoder().encode(out.body).length)])
  if (req.method === 'HEAD') out.body = ''
  return out
}

function route(req: SimRequest): SimResponse {
  const host = (h(req, 'host') ?? '').replace(/:\d+$/, '').toLowerCase()
  if (req.version === 'HTTP/1.1' && !h(req, 'host')) return html(400, '<h1>400 Bad Request</h1>\n<p>En HTTP/1.1 el encabezado Host es obligatorio.</p>\n')
  if (req.version !== 'HTTP/1.1' && !host) return html(400, '<h1>400 Bad Request</h1>\n')
  if (host && host !== HOST) return html(200, '<h1>Sitio por defecto</h1>\n<p>Este servidor no tiene un sitio con ese nombre: respondió el sitio por defecto.</p>\n')
  const [path, query = ''] = req.path.split('?')
  const m = req.method

  if (path === '/' || path === '/index.html') {
    if (m !== 'GET' && m !== 'HEAD') return html(405, '<h1>405 Method Not Allowed</h1>\n', [['Allow', 'GET, HEAD']])
    const inm = h(req, 'if-none-match')
    if (inm === ETAG) return { status: 304, headers: [['ETag', ETAG], ['Cache-Control', 'max-age=60']], body: '' }
    const gz = (h(req, 'accept-encoding') ?? '').includes('gzip')
    return html(200, '<!doctype html>\n<h1>Tienda de mates</h1>\n<p>Mirá los productos en /productos</p>\n', [['ETag', ETAG], ['Cache-Control', 'max-age=60'], ...(gz ? ([['Content-Encoding', 'gzip'], ['Vary', 'Accept-Encoding']] as [string, string][]) : [])])
  }
  if (path === '/viejo' || path === '/catalogo') return html(301, '<h1>301 Moved Permanently</h1>\n', [['Location', `https://${HOST}/productos`]])
  if (path === '/admin') return html(403, '<h1>403 Forbidden</h1>\n<p>Solo desde la red de la oficina.</p>\n')
  if (path === '/error') return html(500, '<h1>500 Internal Server Error</h1>\n')
  if (path === '/mantenimiento') return html(503, '<h1>503 Service Unavailable</h1>\n<p>Volvemos en un rato.</p>\n', [['Retry-After', '120']])

  if (path === '/login') {
    if (m !== 'POST') return html(405, '<h1>405 Method Not Allowed</h1>\n', [['Allow', 'POST']])
    const params = new URLSearchParams(req.body)
    if (params.get('usuario') === 'ana' && params.get('clave') === 'mate2026') return json(200, { mensaje: 'Bienvenida, Ana' }, [['Set-Cookie', `sesion=${SESSION}; Path=/; HttpOnly; Secure; SameSite=Lax`]])
    return json(401, { error: 'Usuario o clave incorrectos (probá usuario=ana&clave=mate2026)' })
  }
  if (path === '/perfil') {
    if (cookie(req, 'sesion') === SESSION) return json(200, { usuario: 'ana', compras: 3 })
    return html(302, '<h1>302 Found</h1>\n', [['Location', '/login']])
  }

  const one = /^\/productos\/(\d+)$/.exec(path)
  if (path === '/productos') {
    if (m === 'GET' || m === 'HEAD') {
      const q = new URLSearchParams(query).get('q')?.toLowerCase()
      return json(200, q ? PRODUCTOS.filter((p) => p.nombre.toLowerCase().includes(q)) : PRODUCTOS, [['Cache-Control', 'no-cache']])
    }
    if (m === 'POST') {
      if (authorized(req) !== 'ok') return need401(req)
      if (!(h(req, 'content-type') ?? '').includes('application/json')) return json(415, { error: 'Mandá el cuerpo en JSON (Content-Type: application/json)' })
      let data: { nombre?: string; precio?: number }
      try {
        data = JSON.parse(req.body)
      } catch {
        return json(400, { error: 'El cuerpo no es un JSON válido' })
      }
      if (!data.nombre) return json(400, { error: 'Falta el campo "nombre"' })
      return json(201, { id: 10, nombre: data.nombre, precio: data.precio ?? 0 }, [['Location', '/productos/10']])
    }
    return json(405, { error: `${m} no se permite en /productos` }, [['Allow', 'GET, HEAD, POST']])
  }
  if (one) {
    const p = PRODUCTOS.find((x) => x.id === Number(one[1]))
    if (m === 'GET' || m === 'HEAD') return p ? json(200, p) : json(404, { error: `No existe el producto ${one[1]}` })
    if (m === 'DELETE' || m === 'PUT') {
      if (authorized(req) !== 'ok') return need401(req)
      if (!p) return json(404, { error: `No existe el producto ${one[1]}` })
      if (m === 'DELETE') return { status: 204, headers: [], body: '' }
      return json(200, { ...p, ...safeJson(req.body) })
    }
    return json(405, { error: `${m} no se permite acá` }, [['Allow', 'GET, HEAD, PUT, DELETE']])
  }
  return html(404, '<h1>404 Not Found</h1>\n')
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text)
    return typeof v === 'object' && v ? v : {}
  } catch {
    return {}
  }
}

/** La solicitud como viaja (en HTTP/2 y HTTP/3, con pseudoencabezados y en minúsculas). */
export function rawRequest(req: SimRequest): string {
  const hdrs = req.headers.filter(([k]) => k.trim())
  if (req.version === 'HTTP/1.1') {
    return [`${req.method} ${req.path} HTTP/1.1`, ...hdrs.map(([k, v]) => `${k}: ${v}`), '', req.body].join('\n').replace(/\n$/, '')
  }
  const host = hdrs.find(([k]) => k.toLowerCase() === 'host')?.[1] ?? ''
  return [`:method: ${req.method}`, `:scheme: https`, `:authority: ${host}`, `:path: ${req.path}`, ...hdrs.filter(([k]) => k.toLowerCase() !== 'host').map(([k, v]) => `${k.toLowerCase()}: ${v}`), '', req.body].join('\n').replace(/\n$/, '')
}

export function rawResponse(res: SimResponse, version: Version): string {
  const line = version === 'HTTP/1.1' ? `HTTP/1.1 ${res.status} ${REASONS[res.status] ?? ''}` : `:status: ${res.status}`
  const hdrs = res.headers.map(([k, v]) => (version === 'HTTP/1.1' ? `${k}: ${v}` : `${k.toLowerCase()}: ${v}`))
  return [line, ...hdrs, '', res.body].join('\n').replace(/\n$/, '')
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** El mismo pedido con curl. */
export function curlFor(req: SimRequest): string {
  const parts = ['curl -i']
  if (req.method === 'HEAD') parts[0] = 'curl -I'
  else if (req.method !== 'GET' && !(req.method === 'POST' && req.body)) parts.push(`-X ${req.method}`)
  if (req.version === 'HTTP/1.1') parts.push('--http1.1')
  if (req.version === 'HTTP/3') parts.push('--http3')
  for (const [k, v] of req.headers) {
    if (!k.trim() || k.toLowerCase() === 'host' || k.toLowerCase() === 'user-agent' || k.toLowerCase() === 'accept') continue
    parts.push(`-H ${shq(`${k}: ${v}`)}`)
  }
  const host = req.headers.find(([k]) => k.toLowerCase() === 'host')?.[1]
  if (host && host !== HOST) parts.push(`-H ${shq(`Host: ${host}`)}`)
  if (req.body && req.method !== 'GET' && req.method !== 'HEAD') parts.push(`-d ${shq(req.body)}`)
  parts.push(`https://${HOST}${req.path}`)
  return parts.join(' ')
}

/** Qué significa la respuesta, en criollo. */
export function explain(req: SimRequest, res: SimResponse): string {
  const loc = res.headers.find(([k]) => k === 'Location')?.[1]
  const fam = Math.floor(res.status / 100)
  const base: Record<number, string> = {
    2: 'Familia 2xx: salió bien.',
    3: 'Familia 3xx: el recurso está en otro lado o no cambió.',
    4: 'Familia 4xx: el problema está en el pedido (el cliente).',
    5: 'Familia 5xx: el problema está en el servidor.',
  }
  const specific: Record<number, string> = {
    200: req.method === 'HEAD' ? 'HEAD trae solo los encabezados: sirve para ver tamaño, tipo o fechas sin bajar el contenido.' : 'El servidor devolvió lo que pediste.',
    201: `Se creó un recurso nuevo; el encabezado Location dice dónde quedó (${loc ?? ''}).`,
    204: 'Salió bien y no hay nada para devolver (típico de un DELETE).',
    301: `Se mudó para siempre a ${loc}. Los navegadores y curl -L siguen el Location solos.`,
    302: `Redirección temporal a ${loc}: acá, porque no hay sesión iniciada.`,
    304: 'No cambió desde la versión que ya tenés (mandaste el mismo ETag en If-None-Match): no hace falta bajarla de nuevo.',
    400: 'El pedido está mal formado (falta un dato obligatorio o el formato no es el esperado).',
    401: 'Falta autenticarse o las credenciales no sirven. Mirá WWW-Authenticate: dice cómo hay que autenticarse.',
    403: 'El servidor sabe quién sos (o no le importa) y aun así no te deja: no es un problema de credenciales.',
    404: 'Ese recurso no existe en el servidor.',
    405: `El recurso existe, pero no acepta ${req.method}. El encabezado Allow lista los métodos permitidos.`,
    415: 'El tipo de contenido que mandaste no es el que el servidor espera (mirá Content-Type).',
    500: 'Algo falló adentro de la aplicación. El detalle no está en la respuesta: está en los logs del servidor.',
    503: 'El servicio no está disponible por ahora; Retry-After dice en cuántos segundos volver a probar.',
  }
  return `${base[fam] ?? ''} ${specific[res.status] ?? ''}`.trim()
}

export interface Challenge {
  id: string
  texto: string
  pista: string
  ok: (req: SimRequest, res: SimResponse) => boolean
}

export const CHALLENGES: Challenge[] = [
  { id: 'lista', texto: 'Traé la lista de productos.', pista: 'GET /productos', ok: (q, r) => q.method === 'GET' && q.path.split('?')[0] === '/productos' && r.status === 200 },
  { id: 'head', texto: 'Mirá solo los encabezados de la portada, sin bajar el contenido.', pista: 'El método HEAD.', ok: (q, r) => q.method === 'HEAD' && r.status === 200 },
  { id: '405', texto: 'Provocá un 405 y fijate qué métodos acepta el recurso.', pista: 'PUT o DELETE sobre /productos.', ok: (_q, r) => r.status === 405 },
  { id: 'crear', texto: `Creá un producto (201). El token es ${TOKEN}.`, pista: 'POST /productos con Content-Type: application/json, Authorization: Bearer … y un cuerpo como {"nombre":"Termo"}.', ok: (q, r) => q.method === 'POST' && r.status === 201 },
  { id: 'cookie', texto: 'Iniciá sesión y entrá a /perfil con la cookie que te dan.', pista: 'POST /login con usuario=ana&clave=mate2026; después GET /perfil con Cookie: sesion=…', ok: (q, r) => q.path === '/perfil' && r.status === 200 },
  { id: 'host', texto: 'Pedí la portada con otro nombre de sitio, como si el servidor tuviera varios.', pista: 'Cambiá el encabezado Host.', ok: (q, r) => r.status === 200 && r.body.includes('Sitio por defecto') && q.method !== 'HEAD' },
  { id: '304', texto: 'Conseguí un 304 usando el ETag de la portada.', pista: 'Pedí la portada, copiá el ETag y mandalo en If-None-Match.', ok: (_q, r) => r.status === 304 },
]
