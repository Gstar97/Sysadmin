/**
 * curl y wget sobre el motor HTTP del laboratorio.
 */
import { fetchHttp, openSslVersion, REASON, type FetchOpts, type FetchResult, type HttpResponse } from '../http'
import { routeFor } from './net'
import { register, type CommandContext } from '../shell'
import { gmt } from '../tls'

interface CurlOpts {
  url?: string
  method?: string
  headers: Record<string, string>
  data?: string
  head: boolean
  include: boolean
  silent: boolean
  showError: boolean
  verbose: boolean
  location: boolean
  insecure: boolean
  fail: boolean
  output?: string
  writeOut?: string
  user?: string
  resolve: Record<string, string>
  cacert?: string
  tlsMin?: string
  tlsMax?: string
  http1: boolean
  agent?: string
  remoteName: boolean
  maxRedirs: number
  error?: string
  /** -G: los datos van en la URL (?a=b) con GET. */
  get: boolean
}

const TLS_FLAG: Record<string, string> = { '--tlsv1.2': 'TLSv1.2', '--tlsv1.3': 'TLSv1.3', '--tlsv1.1': 'TLSv1.1', '--tlsv1': 'TLSv1' }

function parseCurl(args: string[]): CurlOpts {
  const o: CurlOpts = { headers: {}, head: false, include: false, silent: false, showError: false, verbose: false, location: false, insecure: false, fail: false, resolve: {}, http1: false, remoteName: false, maxRedirs: 50, get: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const val = () => {
      const eq = a.indexOf('=')
      if (a.startsWith('--') && eq > 0) return a.slice(eq + 1)
      if (!a.startsWith('--') && a.length > 2) return a.slice(2)
      return args[++i]
    }
    const name = a.startsWith('--') ? a.split('=')[0] : a.slice(0, 2)
    if (!a.startsWith('-') || a === '-') {
      o.url ??= a
      continue
    }
    // Opciones cortas combinadas sin valor: -sSL, -kv, -sI
    if (/^-[sSLkvIifOG]{2,}$/.test(a)) {
      for (const ch of a.slice(1)) args.splice(i + 1, 0, `-${ch}`)
      continue
    }
    switch (name) {
      case '-X':
      case '--request':
        o.method = val()
        break
      case '-H':
      case '--header': {
        const h = val() ?? ''
        const idx = h.indexOf(':')
        if (idx > 0) o.headers[h.slice(0, idx).trim().toLowerCase()] = h.slice(idx + 1).trim()
        break
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-binary':
      case '--json':
        o.data = (o.data ? o.data + '&' : '') + (val() ?? '')
        if (name === '--json') o.headers['content-type'] = 'application/json'
        break
      case '--data-urlencode': {
        // nombre=contenido: se codifica solo el contenido (como curl).
        const raw = val() ?? ''
        const eq = raw.indexOf('=')
        const enc = eq >= 0 ? `${raw.slice(0, eq)}=${encodeURIComponent(raw.slice(eq + 1))}` : encodeURIComponent(raw)
        o.data = (o.data ? o.data + '&' : '') + enc
        break
      }
      case '-G':
      case '--get':
        o.get = true
        break
      case '-I':
      case '--head':
        o.head = true
        break
      case '-i':
      case '--include':
        o.include = true
        break
      case '-s':
      case '--silent':
        o.silent = true
        break
      case '-S':
      case '--show-error':
        o.showError = true
        break
      case '-v':
      case '--verbose':
        o.verbose = true
        break
      case '-L':
      case '--location':
        o.location = true
        break
      case '-k':
      case '--insecure':
        o.insecure = true
        break
      case '-f':
      case '--fail':
        o.fail = true
        break
      case '-o':
      case '--output':
        o.output = val()
        break
      case '-O':
      case '--remote-name':
        o.remoteName = true
        break
      case '-w':
      case '--write-out':
        o.writeOut = val()
        break
      case '-u':
      case '--user':
        o.user = val()
        break
      case '-A':
      case '--user-agent':
        o.agent = val()
        break
      case '-m':
      case '--max-time':
      case '--connect-timeout':
      case '--max-redirs':
        if (name === '--max-redirs') o.maxRedirs = Number(val())
        else val()
        break
      case '--resolve': {
        const r = val() ?? ''
        const m = /^([^:]+):(\d+):(.+)$/.exec(r)
        if (m) o.resolve[`${m[1].toLowerCase()}:${m[2]}`] = m[3]
        break
      }
      case '--cacert':
        o.cacert = val()
        break
      case '--http1.1':
      case '--http1.0':
        o.http1 = true
        break
      case '--http2':
      case '--compressed':
      case '-q':
        break
      case '--tls-max':
        o.tlsMax = `TLSv${val()}`.replace('TLSv1.0', 'TLSv1')
        break
      default:
        if (TLS_FLAG[name]) o.tlsMin = TLS_FLAG[name]
        else o.error ??= a
    }
  }
  if (o.get && o.data !== undefined && o.url) {
    o.url += (o.url.includes('?') ? '&' : '?') + o.data
    o.data = undefined
    o.method ??= 'GET'
  }
  return o
}

function statusLine(res: HttpResponse): string {
  return res.h2 ? `HTTP/2 ${res.status}` : `HTTP/1.1 ${res.status} ${REASON[res.status] ?? ''}`.trimEnd()
}

function headerBlock(res: HttpResponse): string {
  const lines = [statusLine(res), ...res.headers.map(([k, v]) => (res.h2 ? `${k.toLowerCase()}: ${v}` : `${k}: ${v}`))]
  return lines.join('\r\n') + '\r\n\r\n'
}

function verboseRequest(ctx: CommandContext, r: Extract<FetchResult, { ok: true }>, method: string) {
  const u = r.req
  const lines: string[] = []
  lines.push(`* Host ${u.host}:${r.port} was resolved.`, '* IPv6: (none)', `* IPv4: ${r.ip}`, `*   Trying ${r.ip}:${r.port}...`)
  if (r.tls) {
    const leaf = r.tls.chain[0]
    lines.push(
      `* ALPN: curl offers h2,http/1.1`,
      `* TLSv1.3 (OUT), TLS handshake, Client hello (1):`,
      `* SSL connection using ${r.tls.version} / ${r.tls.cipher} / X25519MLKEM768 / ${leaf?.keyAlg === 'EC' ? 'id-ecPublicKey' : 'RSASSA-PSS'}`,
      `* ALPN: server accepted ${r.tls.h2 ? 'h2' : 'http/1.1'}`,
      '* Server certificate:',
      `*  subject: ${leaf ? Object.entries(leaf.subject).map(([k, v]) => `${k}=${v}`).join('; ') : ''}`,
      `*  start date: ${leaf ? gmt(leaf.notBefore) : ''}`,
      `*  expire date: ${leaf ? gmt(leaf.notAfter) : ''}`,
      r.tls.verify.code === 'ok' ? `*  subjectAltName: host "${u.host}" matched cert's "${leaf?.san.find((s) => s.includes(u.host.split('.').slice(1).join('.')))?.replace('DNS:', '') ?? u.host}"` : `*  subjectAltName does not match ${u.host}`,
      `*  issuer: ${leaf ? Object.entries(leaf.issuer).map(([k, v]) => `${k}=${v}`).join('; ') : ''}`,
      r.tls.verify.code === 'ok' ? '*  SSL certificate verify ok.' : '*  SSL certificate verify result: ignored because of -k (insecure)',
    )
  }
  lines.push(`* Connected to ${u.host} (${r.ip}) port ${r.port}`)
  if (r.tls?.h2) lines.push('* using HTTP/2')
  lines.push(`> ${method} ${u.path} ${r.tls?.h2 ? 'HTTP/2' : 'HTTP/1.1'}`)
  for (const [k, v] of Object.entries(u.headers)) lines.push(`> ${k.replace(/(^|-)\w/g, (m) => m.toUpperCase()).replace('User-Agent', 'User-Agent')}: ${v}`)
  lines.push('>')
  ctx.err(lines.join('\n') + '\n')
}

function verboseResponse(ctx: CommandContext, res: HttpResponse) {
  ctx.err(headerBlock(res).trimEnd().split('\r\n').map((l) => `< ${l}`).join('\n') + '\n<\n')
}

const TLS_HINT = `More details here: https://curl.se/docs/sslcerts.html

curl failed to verify the legitimacy of the server and therefore could not
establish a secure connection to it. To learn more about this situation and
how to fix it, please visit the webpage mentioned above.
`

register(['curl', 'wget'], {
  usage: 'curl [options] <url>',
  summary:
    '  -I  only headers  -i  include headers  -s  silent  -v  verbose  -L  follow redirects\n  -X METHOD  -H "Name: value"  -d DATA  -u user:pass  -k  insecure  -o FILE  -w FORMAT\n  --resolve host:port:ip  --cacert FILE  --tlsv1.2 --tlsv1.3 --tls-max V  --http1.1',
  run(ctx) {
    const isWget = ctx.name === 'wget'
    const o = isWget ? parseWget(ctx.args) : parseCurl([...ctx.args])
    if (!o.url) {
      ctx.err(isWget ? 'wget: missing URL\n' : "curl: try 'curl --help' for more information\n")
      return isWget ? 1 : 2
    }
    if (o.error && !isWget) {
      ctx.err(`curl: option ${o.error}: is unknown\ncurl: try 'curl --help' or 'curl --manual' for more information\n`)
      return 2
    }
    const headers = { ...o.headers }
    if (o.user) headers['authorization'] = `Basic ${btoa(o.user.includes(':') ? o.user : `${o.user}:`)}`
    const method = o.head ? 'HEAD' : o.method ?? (o.data !== undefined ? 'POST' : 'GET')
    const fo: FetchOpts = { method, headers, body: o.data, resolve: o.resolve, insecure: o.insecure, caFile: o.cacert ? ctx.sh.resolve(o.cacert) : undefined, tlsMin: o.tlsMin, tlsMax: o.tlsMax, http1: o.http1, userAgent: isWget ? 'Wget/1.24.5' : o.agent }
    let url = o.url
    let r = fetchHttp(ctx.sys, url, fo)
    let hops = 0
    const shown: string[] = []
    while (r.ok && o.location && [301, 302, 303, 307, 308].includes(r.res.status) && hops < o.maxRedirs) {
      const loc = r.res.headers.find(([k]) => k.toLowerCase() === 'location')?.[1]
      if (!loc) break
      if (o.verbose) {
        verboseRequest(ctx, r, method)
        verboseResponse(ctx, r.res)
        ctx.err(`* Ignoring the response-body\n* Connection #0 to host ${r.req.host} left intact\n* Issue another request to this URL: '${loc}'\n`)
      }
      if (o.include || o.head) shown.push(headerBlock(r.res))
      url = loc.startsWith('/') ? `${r.req.scheme}://${r.req.headers['host']}${loc}` : loc
      if (r.res.status === 303) fo.method = 'GET'
      r = fetchHttp(ctx.sys, url, fo)
      hops++
    }
    if (!r.ok) {
      if (o.verbose && r.ip) ctx.err(`*   Trying ${r.ip}:${r.port}...\n`)
      if (isWget) {
        ctx.err(r.code === 6 ? `wget: unable to resolve host address '${url.replace(/^https?:\/\//, '').split(/[/:]/)[0]}'\n` : r.code === 60 ? `ERROR: cannot verify certificate: ${r.message.replace('SSL certificate problem: ', '')}\n` : `Connecting to ${r.ip}:${r.port}... failed: ${r.code === 28 ? 'Connection timed out' : r.message.includes('No route') ? 'No route to host' : 'Connection refused'}.\n`)
        return r.code === 6 ? 4 : r.code === 60 ? 5 : 4
      }
      if (!o.silent || o.showError) ctx.err(`curl: (${r.code}) ${r.message}\n${r.code === 60 ? TLS_HINT : ''}`)
      writeOut(ctx, o, r, 0)
      return r.code
    }
    const res = r.res
    if (o.verbose) {
      verboseRequest(ctx, r, method)
      verboseResponse(ctx, res)
    }
    if (isWget) {
      const file = o.output ?? (r.req.path.split('?')[0].split('/').pop() || 'index.html')
      ctx.err(`--${new Date().toISOString().slice(0, 19).replace('T', ' ')}--  ${url}\nResolving ${r.req.host}... ${r.ip}\nConnecting to ${r.req.host}|${r.ip}|:${r.port}... connected.\nHTTP request sent, awaiting response... ${res.status} ${REASON[res.status] ?? ''}\n`)
      if (res.status >= 400) {
        ctx.err(`${new Date().toISOString().slice(0, 19).replace('T', ' ')} ERROR ${res.status}: ${REASON[res.status] ?? ''}.\n\n`)
        return 8
      }
      ctx.sys.vfs.writeFile(ctx.sh.resolve(file), res.body, ctx.sh.cred, { mode: 0o666, umask: ctx.sh.umask })
      ctx.err(`Length: ${res.body.length} [${res.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? 'text/html'}]\nSaving to: '${file}'\n\n'${file}' saved [${res.body.length}/${res.body.length}]\n\n`)
      return 0
    }
    if (o.fail && res.status >= 400) {
      if (!o.silent || o.showError) ctx.err(`curl: (22) The requested URL returned error: ${res.status}\n`)
      writeOut(ctx, o, r, res.status)
      return 22
    }
    for (const s of shown) ctx.out(s)
    if (o.head) {
      ctx.out(headerBlock(res))
      writeOut(ctx, o, r, res.status)
      return 0
    }
    const text = (o.include ? headerBlock(res) : '') + res.body
    if (o.output || o.remoteName) {
      const file = o.output ?? (r.req.path.split('?')[0].split('/').pop() || 'index.html')
      ctx.sys.vfs.writeFile(ctx.sh.resolve(file), text, ctx.sh.cred, { mode: 0o666, umask: ctx.sh.umask })
      if (!o.silent) ctx.err(`  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n                                 Dload  Upload   Total   Spent    Left  Speed\n100  ${String(text.length).padStart(4)}  100  ${String(text.length).padStart(4)}    0     0  ${String(text.length * 9).padStart(6)}      0 --:--:-- --:--:-- --:--:-- ${String(text.length * 9).padStart(6)}\n`)
    } else ctx.out(text)
    writeOut(ctx, o, r, res.status)
    return 0
  },
})

function writeOut(ctx: CommandContext, o: CurlOpts, r: FetchResult, code: number) {
  if (o.writeOut === undefined) return
  const ip = r.ip ?? ''
  const local = ip.startsWith('127.') || ctx.sys.ownIps().includes(ip)
  const via = ip && !local ? routeFor(ctx.sys, ip).via : undefined
  const rtt = local ? 0.00005 : via ? (ctx.sys.remoteNets.some((n) => inNet(ip, n.net)) ? 0.012 : 0.024) : 0.0006
  const host = r.ok ? r.req.host : ''
  const tn = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? 0.00002 : 0.0021
  const tc = tn + rtt
  const ta = r.ok && r.tls ? tc + 2 * rtt + 0.003 : 0
  const ts = (ta || tc) + rtt + 0.0042 + (ctx.sys.serverDelay[host] ?? ctx.sys.serverDelay[ip] ?? 0)
  const varsMap: Record<string, string> = {
    http_code: String(code).padStart(3, '0'),
    response_code: String(code).padStart(3, '0'),
    time_namelookup: tn.toFixed(6),
    time_connect: tc.toFixed(6),
    time_appconnect: ta.toFixed(6),
    time_pretransfer: (ta || tc).toFixed(6),
    time_starttransfer: ts.toFixed(6),
    time_total: (ts + 0.0004).toFixed(6),
    remote_ip: ip,
    remote_port: String(r.port ?? ''),
    size_download: String(r.ok ? r.res.body.length : 0),
    url_effective: o.url ?? '',
    ssl_verify_result: r.ok && r.tls ? (r.tls.verify.code === 'ok' ? '0' : '20') : '0',
    http_version: r.ok && r.res.h2 ? '2' : '1.1',
    redirect_url: r.ok ? (r.res.headers.find(([k]) => k.toLowerCase() === 'location')?.[1] ?? '') : '',
    content_type: r.ok ? (r.res.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '') : '',
  }
  ctx.out(o.writeOut.replace(/%\{(\w+)\}/g, (m0, k) => varsMap[k] ?? m0).replace(/\\n/g, '\n').replace(/\\t/g, '\t'))
}

function inNet(ip: string, cidr: string): boolean {
  const n = (x: string) => x.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0
  const [base, bits] = cidr.split('/')
  const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0
  return ((n(ip) & mask) >>> 0) === ((n(base) & mask) >>> 0)
}

function parseWget(args: string[]): CurlOpts {
  const o: CurlOpts = { headers: {}, head: false, include: false, silent: false, showError: false, verbose: false, location: true, insecure: false, fail: false, resolve: {}, http1: true, remoteName: true, maxRedirs: 20, get: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-O') o.output = args[++i]
    else if (a.startsWith('--output-document=')) o.output = a.slice(18)
    else if (a === '-q' || a === '--quiet') o.silent = true
    else if (a === '--no-check-certificate') o.insecure = true
    else if (a.startsWith('--ca-certificate=')) o.cacert = a.slice(17)
    else if (!a.startsWith('-')) o.url ??= a
  }
  return o
}

export { openSslVersion }
