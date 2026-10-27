/**
 * Analizador de configuración de nginx con tabla de directivas y contextos, para dar errores
 * parecidos a los de "nginx -t" pero explicados.
 */
import type { Diagnostic, NginxDirective } from './types'

type Ctx = 'main' | 'events' | 'http' | 'server' | 'location' | 'upstream' | 'stream' | 'if' | 'map' | 'types' | 'limit_except'

interface Spec {
  ctx: Ctx[]
  /** Cantidad de argumentos: [mínimo, máximo] (máximo Infinity = sin límite). */
  args: [number, number]
  block?: Ctx
}

const ANY_HTTP: Ctx[] = ['http', 'server', 'location']
const D: Record<string, Spec> = {
  user: { ctx: ['main'], args: [1, 2] },
  worker_processes: { ctx: ['main'], args: [1, 1] },
  worker_rlimit_nofile: { ctx: ['main'], args: [1, 1] },
  pid: { ctx: ['main'], args: [1, 1] },
  load_module: { ctx: ['main'], args: [1, 1] },
  error_log: { ctx: ['main', 'http', 'server', 'location', 'stream'], args: [1, 2] },
  include: { ctx: ['main', 'events', 'http', 'server', 'location', 'upstream', 'stream', 'types'], args: [1, 1] },
  events: { ctx: ['main'], args: [0, 0], block: 'events' },
  worker_connections: { ctx: ['events'], args: [1, 1] },
  use: { ctx: ['events'], args: [1, 1] },
  multi_accept: { ctx: ['events'], args: [1, 1] },
  http: { ctx: ['main'], args: [0, 0], block: 'http' },
  stream: { ctx: ['main'], args: [0, 0], block: 'stream' },
  server: { ctx: ['http', 'stream', 'upstream'], args: [0, Infinity] },
  upstream: { ctx: ['http', 'stream'], args: [1, 1], block: 'upstream' },
  location: { ctx: ['server', 'location'], args: [1, 2], block: 'location' },
  if: { ctx: ['server', 'location'], args: [1, Infinity], block: 'if' },
  map: { ctx: ['http', 'stream'], args: [2, 2], block: 'map' },
  types: { ctx: ['http', 'server', 'location'], args: [0, 0], block: 'types' },
  limit_except: { ctx: ['location'], args: [1, Infinity], block: 'limit_except' },
  listen: { ctx: ['server'], args: [1, Infinity] },
  server_name: { ctx: ['server'], args: [1, Infinity] },
  root: { ctx: [...ANY_HTTP, 'if'], args: [1, 1] },
  alias: { ctx: ['location'], args: [1, 1] },
  index: { ctx: ANY_HTTP, args: [1, Infinity] },
  try_files: { ctx: ['server', 'location'], args: [2, Infinity] },
  return: { ctx: ['server', 'location', 'if'], args: [1, 2] },
  rewrite: { ctx: ['server', 'location', 'if'], args: [2, 3] },
  default_type: { ctx: ANY_HTTP, args: [1, 1] },
  sendfile: { ctx: [...ANY_HTTP, 'if'], args: [1, 1] },
  tcp_nopush: { ctx: ANY_HTTP, args: [1, 1] },
  tcp_nodelay: { ctx: ANY_HTTP, args: [1, 1] },
  keepalive_timeout: { ctx: ANY_HTTP, args: [1, 2] },
  keepalive: { ctx: ['upstream'], args: [1, 1] },
  client_max_body_size: { ctx: ANY_HTTP, args: [1, 1] },
  server_tokens: { ctx: ANY_HTTP, args: [1, 1] },
  log_format: { ctx: ['http'], args: [2, Infinity] },
  access_log: { ctx: [...ANY_HTTP, 'if', 'limit_except', 'stream'], args: [1, Infinity] },
  gzip: { ctx: [...ANY_HTTP, 'if'], args: [1, 1] },
  gzip_types: { ctx: ANY_HTTP, args: [1, Infinity] },
  gzip_comp_level: { ctx: ANY_HTTP, args: [1, 1] },
  gzip_min_length: { ctx: ANY_HTTP, args: [1, 1] },
  add_header: { ctx: [...ANY_HTTP, 'if'], args: [2, 3] },
  autoindex: { ctx: ANY_HTTP, args: [1, 1] },
  expires: { ctx: [...ANY_HTTP, 'if'], args: [1, 2] },
  error_page: { ctx: [...ANY_HTTP, 'if'], args: [2, Infinity] },
  allow: { ctx: [...ANY_HTTP, 'limit_except'], args: [1, 1] },
  deny: { ctx: [...ANY_HTTP, 'limit_except'], args: [1, 1] },
  auth_basic: { ctx: [...ANY_HTTP, 'limit_except'], args: [1, 1] },
  auth_basic_user_file: { ctx: [...ANY_HTTP, 'limit_except'], args: [1, 1] },
  ssl_certificate: { ctx: ['http', 'server', 'stream'], args: [1, 1] },
  ssl_certificate_key: { ctx: ['http', 'server', 'stream'], args: [1, 1] },
  ssl_protocols: { ctx: ['http', 'server', 'stream'], args: [1, Infinity] },
  ssl_ciphers: { ctx: ['http', 'server', 'stream'], args: [1, 1] },
  ssl_prefer_server_ciphers: { ctx: ['http', 'server', 'stream'], args: [1, 1] },
  ssl_session_cache: { ctx: ['http', 'server', 'stream'], args: [1, 2] },
  ssl_session_timeout: { ctx: ['http', 'server', 'stream'], args: [1, 1] },
  http2: { ctx: ['http', 'server'], args: [1, 1] },
  proxy_pass: { ctx: ['location', 'if', 'server', 'limit_except'], args: [1, 1] },
  proxy_set_header: { ctx: ANY_HTTP, args: [2, 2] },
  proxy_http_version: { ctx: ANY_HTTP, args: [1, 1] },
  proxy_read_timeout: { ctx: ANY_HTTP, args: [1, 1] },
  proxy_connect_timeout: { ctx: ANY_HTTP, args: [1, 1] },
  proxy_buffering: { ctx: ANY_HTTP, args: [1, 1] },
  proxy_redirect: { ctx: ANY_HTTP, args: [1, 2] },
  fastcgi_pass: { ctx: ['location', 'if'], args: [1, 1] },
  fastcgi_param: { ctx: ANY_HTTP, args: [2, 3] },
  fastcgi_index: { ctx: ANY_HTTP, args: [1, 1] },
  least_conn: { ctx: ['upstream'], args: [0, 0] },
  ip_hash: { ctx: ['upstream'], args: [0, 0] },
  limit_req_zone: { ctx: ['http'], args: [3, 4] },
  limit_req: { ctx: ANY_HTTP, args: [1, 3] },
  resolver: { ctx: ANY_HTTP, args: [1, Infinity] },
  charset: { ctx: [...ANY_HTTP, 'if'], args: [1, 1] },
  set: { ctx: ['server', 'location', 'if'], args: [2, 2] },
  break: { ctx: ['server', 'location', 'if'], args: [0, 0] },
  internal: { ctx: ['location'], args: [0, 0] },
}

interface Token {
  text: string
  line: number
  col: number
  quoted: boolean
}

function tokenize(src: string): { tokens: Token[]; diags: Diagnostic[] } {
  const tokens: Token[] = []
  const diags: Diagnostic[] = []
  let line = 1
  let col = 1
  let i = 0
  const advance = (c: string) => {
    if (c === '\n') {
      line++
      col = 1
    } else col++
  }
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      advance(c)
      i++
      continue
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '{' || c === '}' || c === ';') {
      tokens.push({ text: c, line, col, quoted: false })
      advance(c)
      i++
      continue
    }
    if (c === '"' || c === "'") {
      const startLine = line
      const startCol = col
      let j = i + 1
      let text = ''
      advance(c)
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          text += src[j + 1]
          advance(src[j])
          advance(src[j + 1])
          j += 2
          continue
        }
        text += src[j]
        advance(src[j])
        j++
      }
      if (j >= src.length) {
        diags.push({ line: startLine, column: startCol, severity: 'error', message: 'Comillas sin cerrar: nginx lee todo el resto del archivo como parte de este valor.' })
        return { tokens, diags }
      }
      advance(src[j])
      tokens.push({ text, line: startLine, col: startCol, quoted: true })
      i = j + 1
      continue
    }
    const startCol = col
    let text = ''
    while (i < src.length && !/[\s;{}#]/.test(src[i])) {
      text += src[i]
      advance(src[i])
      i++
    }
    tokens.push({ text, line, col: startCol, quoted: false })
  }
  return { tokens, diags }
}

export function parseNginx(src: string): { tree: NginxDirective[]; diagnostics: Diagnostic[] } {
  const { tokens, diags } = tokenize(src)
  const diagnostics = [...diags]
  let pos = 0
  const parseBlock = (depth: number, openLine: number): NginxDirective[] => {
    const out: NginxDirective[] = []
    while (pos < tokens.length) {
      const t = tokens[pos]
      if (t.text === '}' && !t.quoted) {
        if (depth === 0) {
          diagnostics.push({ line: t.line, column: t.col, severity: 'error', message: 'Sobra una llave "}": no hay ningún bloque abierto para cerrar (nginx: unexpected "}").' })
          pos++
          continue
        }
        pos++
        return out
      }
      if ((t.text === ';' || t.text === '{') && !t.quoted) {
        diagnostics.push({ line: t.line, column: t.col, severity: 'error', message: `"${t.text}" inesperado: falta el nombre de la directiva.` })
        pos++
        continue
      }
      const words: Token[] = []
      while (pos < tokens.length && !(['{', '}', ';'].includes(tokens[pos].text) && !tokens[pos].quoted)) words.push(tokens[pos++])
      const end = tokens[pos]
      const d: NginxDirective = { name: words[0].text, args: words.slice(1).map((w) => w.text), line: words[0].line, endLine: words[words.length - 1].line }
      if (!end) {
        diagnostics.push({ line: d.line, severity: 'error', message: `Falta ";" al final de "${d.name}" (nginx: unexpected end of file, expecting ";" or "}").` })
        out.push(d)
        break
      }
      if (end.text === ';') {
        pos++
      } else if (end.text === '{') {
        pos++
        d.block = parseBlock(depth + 1, end.line)
      } else {
        // "}" sin ";" antes
        diagnostics.push({ line: d.endLine, severity: 'error', message: `Falta ";" al final de "${d.name}" antes de cerrar el bloque.` })
      }
      // Una directiva que ocupa varias líneas y donde la línea siguiente empieza con otra directiva conocida: falta ";".
      if (end.text !== '}' && d.endLine > d.line) {
        const idx = words.findIndex((w, k) => k > 0 && w.line > d.line && D[w.text] !== undefined && !w.quoted)
        if (idx > 0) {
          diagnostics.push({ line: d.line, severity: 'error', message: `Falta ";" al final de la línea ${d.line}: nginx juntó "${d.name}" con "${words[idx].text}" de la línea ${words[idx].line}.` })
          d.args = words.slice(1, idx).map((w) => w.text)
        }
      }
      out.push(d)
    }
    if (depth > 0) diagnostics.push({ line: openLine, severity: 'error', message: 'Falta cerrar el bloque que se abre en esta línea con "}" (nginx: unexpected end of file, expecting "}").' })
    return out
  }
  const tree = parseBlock(0, 1)
  return { tree, diagnostics }
}

function checkListen(d: NginxDirective, diags: Diagnostic[]) {
  const [addr, ...params] = d.args
  const port = /^(?:\[[^\]]+\]:|[^:]+:)?(\d+)$/.exec(addr ?? '')?.[1] ?? (/^\d+$/.test(addr ?? '') ? addr : undefined)
  if (!addr || (!port && !/^unix:/.test(addr) && !/^[\w.-]+$/.test(addr))) {
    diags.push({ line: d.line, severity: 'error', message: `"listen ${d.args.join(' ')}": el primer valor tiene que ser un puerto (80) o dirección:puerto (0.0.0.0:443).` })
    return
  }
  if (port && (Number(port) < 1 || Number(port) > 65535)) diags.push({ line: d.line, severity: 'error', message: `Puerto ${port} inválido: tiene que estar entre 1 y 65535.` })
  const valid = /^(ssl|http2|quic|default_server|default|reuseport|deferred|proxy_protocol|ipv6only=(on|off)|backlog=\d+|so_keepalive=\S+|bind|udp)$/
  for (const p of params) if (!valid.test(p)) diags.push({ line: d.line, severity: 'error', message: `Parámetro inválido "${p}" en listen (nginx: invalid parameter "${p}").` })
}

/** Valida la configuración y devuelve errores y advertencias con número de línea. */
export function validateNginx(src: string): { tree: NginxDirective[]; diagnostics: Diagnostic[] } {
  const { tree, diagnostics } = parseNginx(src)
  const hasHttp = tree.some((d) => d.name === 'http')
  // Un archivo de conf.d/sites-available se incluye dentro de http: si no hay "http", se asume ese contexto.
  const rootCtx: Ctx = hasHttp || tree.some((d) => d.name === 'events') ? 'main' : 'http'
  const walk = (list: NginxDirective[], ctx: Ctx) => {
    const names = new Map<string, number>()
    for (const d of list) {
      const spec = D[d.name]
      if (!spec) {
        if (!/^(proxy|fastcgi|uwsgi|ssl|gzip|limit|open_file|client|large_client|real_ip|set_real_ip|sub_filter)_/.test(d.name) && !d.name.startsWith('$')) {
          diagnostics.push({ line: d.line, severity: 'error', message: `Directiva desconocida "${d.name}" (nginx: unknown directive). Revisa si está bien escrita.` })
        }
      } else {
        const allowed = spec.ctx.includes(ctx) || (ctx === 'map' || ctx === 'types')
        if (!allowed) diagnostics.push({ line: d.line, severity: 'error', message: `"${d.name}" no se puede usar dentro de "${ctx}" (nginx: "${d.name}" directive is not allowed here). Va en: ${spec.ctx.join(', ')}.` })
        const [min, max] = spec.args
        if (ctx !== 'map' && ctx !== 'types' && (d.args.length < min || d.args.length > max)) {
          diagnostics.push({ line: d.line, severity: 'error', message: `"${d.name}" tiene una cantidad de valores incorrecta (${d.args.length}); espera ${min === max ? min : `entre ${min} y ${max === Infinity ? 'varios' : max}`} (nginx: invalid number of arguments).` })
        }
        const needsBlock = spec.block !== undefined || (d.name === 'server' && ctx === 'http')
        if (needsBlock && !d.block) diagnostics.push({ line: d.line, severity: 'error', message: `"${d.name}" necesita un bloque { ... } (nginx: directive "${d.name}" has no opening "{").` })
        if (!needsBlock && d.block && !(d.name === 'server' && ctx !== 'upstream')) diagnostics.push({ line: d.line, severity: 'error', message: `"${d.name}" no lleva bloque { }: termina con ";".` })
        if (d.name === 'listen') checkListen(d, diagnostics)
        if (d.name === 'proxy_pass' && d.args[0] && !/^(https?:\/\/|\$|unix:)/.test(d.args[0]) && ctx !== 'server') {
          diagnostics.push({ line: d.line, severity: 'error', message: `proxy_pass necesita la URL completa con http:// o https:// (nginx: invalid URL prefix in "${d.args[0]}").` })
        }
        if (['sendfile', 'gzip', 'autoindex', 'server_tokens', 'tcp_nopush', 'tcp_nodelay'].includes(d.name) && d.args[0] && !/^(on|off)$/.test(d.args[0])) {
          diagnostics.push({ line: d.line, severity: 'error', message: `"${d.name}" acepta solo "on" u "off" (nginx: invalid value "${d.args[0]}").` })
        }
        if (d.name === 'return' && d.args[0] && !/^\d{3}$/.test(d.args[0]) && !/^https?:\/\//.test(d.args[0])) {
          diagnostics.push({ line: d.line, severity: 'error', message: `return espera un código HTTP (301, 404...) o una URL (nginx: invalid return code "${d.args[0]}").` })
        }
      }
      const unique = ['root', 'alias', 'proxy_pass', 'try_files']
      if (unique.includes(d.name)) {
        if (names.has(d.name)) diagnostics.push({ line: d.line, severity: 'error', message: `"${d.name}" está repetida en el mismo bloque (la primera está en la línea ${names.get(d.name)}) (nginx: "${d.name}" directive is duplicate).` })
        else names.set(d.name, d.line)
      }
      if (d.block) {
        const inner: Ctx = d.name === 'server' ? (ctx === 'stream' ? 'stream' : 'server') : (spec?.block ?? ctx)
        if (d.name === 'location' && d.block.some((x) => x.name === 'root') && d.block.some((x) => x.name === 'alias')) {
          diagnostics.push({ line: d.line, severity: 'error', message: 'En un mismo location no se pueden usar root y alias a la vez.' })
        }
        walk(d.block, inner)
      }
    }
  }
  walk(tree, rootCtx)
  // Advertencias útiles
  const servers: NginxDirective[] = []
  const collect = (list: NginxDirective[]) => list.forEach((d) => (d.name === 'server' && d.block ? servers.push(d) : d.block && collect(d.block)))
  collect(tree)
  for (const s of servers) {
    const listens = s.block!.filter((d) => d.name === 'listen')
    const sslListen = listens.some((l) => l.args.includes('ssl'))
    if (sslListen && !s.block!.some((d) => d.name === 'ssl_certificate')) diagnostics.push({ line: s.line, severity: 'error', message: 'Este server escucha con ssl pero no tiene ssl_certificate (nginx: no "ssl_certificate" is defined for the "listen ... ssl" directive).' })
  }
  return { tree, diagnostics: diagnostics.sort((a, b) => a.line - b.line) }
}

/** Busca directivas por ruta de bloques, por ejemplo "http>server" o "server>location /api". */
export function findDirectives(tree: NginxDirective[], context: string, name: string): NginxDirective[] {
  const path = context
    .split('>')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'main')
  const out: NginxDirective[] = []
  const matches = (d: NginxDirective, seg: string) => {
    const [n, ...args] = seg.split(/\s+/)
    return d.name === n && (args.length === 0 || args.join(' ') === d.args.join(' '))
  }
  const search = (list: NginxDirective[], depth: number) => {
    if (depth === path.length) {
      out.push(...list.filter((d) => d.name === name))
      return
    }
    for (const d of list) {
      if (!d.block) continue
      if (matches(d, path[depth])) search(d.block, depth + 1)
      else if (d.name === 'http' && depth === 0) search(d.block, depth)
    }
  }
  search(tree, 0)
  return out
}
