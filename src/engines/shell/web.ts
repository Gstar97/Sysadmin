/**
 * nginx en el servidor simulado: lee nginx.conf con sus include, sabe en qué puertos escucha y
 * desde qué carpeta sirve, y al servir un archivo respeta los permisos y SELinux, igual que el
 * de verdad (403 con "Permission denied" en error.log).
 */
import { parseNginx, validateNginx } from '../config/nginx'
import type { NginxDirective } from '../config/types'
import { httpdCanRead, portAllowed } from './selinux'
import type { System } from './system'
import { ROOT_CRED } from './vfs'

interface ConfFile {
  path: string
  tree: NginxDirective[]
}

function readFiles(sys: System, pattern: string): string[] {
  const abs = pattern.startsWith('/') ? pattern : `/etc/nginx/${pattern}`
  if (!abs.includes('*')) return sys.vfs.exists(abs) ? [abs] : []
  const dir = abs.slice(0, abs.lastIndexOf('/'))
  const glob = abs.slice(abs.lastIndexOf('/') + 1)
  const re = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  try {
    return sys.vfs
      .readdir(dir, ROOT_CRED)
      .filter((n) => re.test(n) && !n.startsWith('.'))
      .sort()
      .map((n) => `${dir}/${n}`)
  } catch {
    return []
  }
}

/** nginx.conf con los include ya reemplazados por el contenido de cada archivo. */
function expanded(sys: System, path = '/etc/nginx/nginx.conf', files: ConfFile[] = []): NginxDirective[] {
  let text: string
  try {
    text = sys.vfs.readFile(path, ROOT_CRED)
  } catch {
    return []
  }
  const tree = parseNginx(text).tree
  files.push({ path, tree })
  const walk = (list: NginxDirective[]): NginxDirective[] =>
    list.flatMap((d) => {
      if (d.name === 'include' && d.args[0] && !d.args[0].endsWith('mime.types')) return readFiles(sys, d.args[0]).flatMap((f) => expanded(sys, f, files))
      return d.block ? [{ ...d, block: walk(d.block) }] : [d]
    })
  return walk(tree)
}

export interface NginxServer {
  ports: number[]
  defaultServer: boolean
  root: string
  index: string[]
  names: string[]
}

export function nginxServers(sys: System): NginxServer[] {
  const tree = expanded(sys)
  const http = tree.find((d) => d.name === 'http')?.block ?? []
  const httpRoot = http.find((d) => d.name === 'root')?.args[0]
  const httpIndex = http.find((d) => d.name === 'index')?.args
  const out: NginxServer[] = []
  for (const s of http.filter((d) => d.name === 'server')) {
    const b = s.block ?? []
    const listens = b.filter((d) => d.name === 'listen')
    const ports = listens.map((l) => Number((/(\d+)$/.exec(l.args[0].replace(/^\[.*\]:/, '')) ?? ['', '80'])[1])).filter((p) => p > 0)
    out.push({
      ports: ports.length ? [...new Set(ports)] : [80],
      defaultServer: listens.some((l) => l.args.includes('default_server')),
      root: b.find((d) => d.name === 'root')?.args[0] ?? httpRoot ?? '/usr/share/nginx/html',
      index: b.find((d) => d.name === 'index')?.args ?? httpIndex ?? ['index.html'],
      names: b.find((d) => d.name === 'server_name')?.args ?? [],
    })
  }
  return out
}

/** Errores como los de nginx -t (vacío si está bien). */
export function nginxTest(sys: System): string[] {
  const files: ConfFile[] = []
  expanded(sys, '/etc/nginx/nginx.conf', files)
  if (!files.length) return ['nginx: [emerg] open() "/etc/nginx/nginx.conf" failed (2: No such file or directory)']
  const errs: string[] = []
  for (const f of files) {
    const text = sys.vfs.readFile(f.path, ROOT_CRED)
    for (const d of validateNginx(text).diagnostics) {
      if (d.severity !== 'error') continue
      const eng = /\(nginx: ([^)]+)\)/.exec(d.message)?.[1]
      const name = /"([^"]+)"/.exec(d.message)?.[1]
      const msg = eng === 'unknown directive' ? `unknown directive "${name}"` : eng ?? d.message
      errs.push(`nginx: [emerg] ${msg} in ${f.path}:${d.line}`)
    }
  }
  // Un root que no existe no es error de sintaxis: falla al pedir la página.
  return errs
}

function workerUser(sys: System): string {
  const m = /^\s*user\s+([^;\s]+)/m.exec((() => {
    try {
      return sys.vfs.readFile('/etc/nginx/nginx.conf', ROOT_CRED)
    } catch {
      return ''
    }
  })())
  return m?.[1] ?? (sys.distro === 'rocky' ? 'nginx' : 'www-data')
}

function errorLog(sys: System, msg: string) {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  try {
    sys.vfs.writeFile('/var/log/nginx/error.log', `${stamp} [error] 1234#1234: *1 ${msg}, client: 192.168.1.10, server: _, request: "GET / HTTP/1.1"\n`, ROOT_CRED, { append: true })
  } catch {
    // sin registro
  }
}

const PAGE = (code: number, text: string) => `<html>\r\n<head><title>${code} ${text}</title></head>\r\n<body>\r\n<center><h1>${code} ${text}</h1></center>\r\n<hr><center>nginx/1.26.3</center>\r\n</body>\r\n</html>\r\n`

/** Respuesta de nginx para un pedido a ese puerto y ruta (undefined si no escucha). */
export function nginxServe(sys: System, port: number, urlPath: string): { status: number; body: string; server: string } | undefined {
  const svc = sys.services.get('nginx')
  if (!svc?.active) return undefined
  if (!sys.vfs.exists('/etc/nginx/nginx.conf')) return { status: 200, body: '<h1>Welcome to nginx!</h1>\n', server: 'nginx/1.26.3' }
  const servers = nginxServers(sys).filter((s) => s.ports.includes(port))
  if (!servers.length) return undefined
  const srv = servers.find((s) => s.defaultServer) ?? servers[0]
  const server = 'nginx/1.26.3'
  const path = decodeURIComponent(urlPath.split('?')[0] || '/')
  const user = workerUser(sys)
  const cred = sys.credFor(sys.users.has(user) ? user : 'root')
  let target = `${srv.root.replace(/\/$/, '')}${path}`
  const forbidden = (why: string) => {
    errorLog(sys, why)
    return { status: 403, body: PAGE(403, 'Forbidden'), server }
  }
  // Cada carpeta del camino tiene que poder atravesarse (x) por el usuario de nginx.
  const parts = target.split('/').filter(Boolean)
  let cur = ''
  for (let i = 0; i < parts.length; i++) {
    cur += `/${parts[i]}`
    if (!sys.vfs.exists(cur)) {
      errorLog(sys, `open() "${target}" failed (2: No such file or directory)`)
      return { status: 404, body: PAGE(404, 'Not Found'), server }
    }
    const node = sys.vfs.stat(cur, ROOT_CRED)
    if (node.type === 'dir' && i < parts.length - 1 && !sys.vfs.can(node, cred, 1)) return forbidden(`open() "${target}" failed (13: Permission denied)`)
  }
  if (sys.vfs.exists(target) && sys.vfs.stat(target, ROOT_CRED).type === 'dir') {
    const dir = target.replace(/\/$/, '')
    if (!sys.vfs.can(sys.vfs.stat(dir, ROOT_CRED), cred, 1)) return forbidden(`open() "${dir}/${srv.index[0]}" failed (13: Permission denied)`)
    const idx = srv.index.map((i) => `${dir}/${i}`).find((f) => sys.vfs.exists(f))
    if (!idx) return forbidden(`directory index of "${dir}/" is forbidden`)
    target = idx
  }
  const node = sys.vfs.stat(target, ROOT_CRED)
  if (!sys.vfs.can(node, cred, 4)) return forbidden(`open() "${target}" failed (13: Permission denied)`)
  if (!httpdCanRead(sys, target)) return forbidden(`open() "${target}" failed (13: Permission denied)`)
  try {
    sys.vfs.writeFile('/var/log/nginx/access.log', `192.168.1.10 - - [${new Date().toUTCString()}] "GET ${path} HTTP/1.1" 200 ${node.data.length} "-" "curl/8.9.1"\n`, ROOT_CRED, { append: true })
  } catch {
    // sin registro
  }
  return { status: 200, body: node.data, server }
}

/** Al arrancar o recargar nginx: sintaxis y puertos (SELinux puede impedir usar uno). */
export function nginxStartCheck(sys: System): string | undefined {
  // Un servicio nginx que el ejercicio declara sin instalar el paquete no tiene configuración que revisar.
  if (!sys.vfs.exists('/etc/nginx/nginx.conf')) return undefined
  const errs = nginxTest(sys)
  if (errs.length) return `${errs[0]}`
  const ports = [...new Set(nginxServers(sys).flatMap((s) => s.ports))]
  for (const p of ports) if (!portAllowed(sys, 'http_port_t', p)) return `nginx: [emerg] bind() to 0.0.0.0:${p} failed (13: Permission denied)`
  const svc = sys.services.get('nginx')
  if (svc) svc.ports = ports
  return undefined
}
