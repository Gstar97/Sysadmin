import { parseArgs } from '../args'
import { register, type CommandContext } from '../shell'
import { ROOT_CRED } from '../vfs'

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0
}

function inSubnet(ip: string, cidr: string): boolean {
  const [net, prefixStr] = cidr.split('/')
  const prefix = Number(prefixStr)
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  return (ipToInt(ip) & mask) === (ipToInt(net) & mask)
}

function networkOf(cidr: string): string {
  const [ip, p] = cidr.split('/')
  const prefix = Number(p)
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  const n = ipToInt(ip) & mask
  return `${[24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.')}/${prefix}`
}

function broadcastOf(cidr: string): string {
  const [ip, p] = cidr.split('/')
  const prefix = Number(p)
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  const b = (ipToInt(ip) | ~mask) >>> 0
  return [24, 16, 8, 0].map((s) => (b >>> s) & 255).join('.')
}

/** Decide cómo llegaría el servidor a una IP: directo, por la puerta de enlace o sin ruta. */
function route(ctx: CommandContext, ip: string): { ok: boolean; reason?: 'no_route' | 'down'; via?: string; src?: string } {
  const sys = ctx.sys
  if (ip.startsWith('127.')) return { ok: true, src: '127.0.0.1' }
  const up = sys.interfaces.filter((i) => i.up && i.ip)
  const direct = up.find((i) => inSubnet(ip, i.ip!))
  if (direct) return { ok: true, src: direct.ip!.split('/')[0] }
  if (!sys.gateway) return { ok: false, reason: 'no_route' }
  const gwIf = up.find((i) => inSubnet(sys.gateway!, i.ip!))
  if (!gwIf) return { ok: false, reason: 'no_route' }
  return { ok: true, via: sys.gateway, src: gwIf.ip!.split('/')[0] }
}

function canReach(ctx: CommandContext, ip: string): boolean {
  const r = route(ctx, ip)
  if (!r.ok) return false
  if (ctx.sys.ownIps().includes(ip) || ip.startsWith('127.')) return true
  if (r.via && !ctx.sys.isReachable(r.via)) return false
  return ctx.sys.isReachable(ip)
}

register('ip', {
  usage: 'ip [ OPTIONS ] OBJECT { COMMAND | help }',
  summary: '  ip addr [show|add|del]  ip link [show|set DEV up|down]  ip route [show|add|del]  ip neigh',
  path: '/usr/sbin',
  run(ctx) {
    const brief = ctx.args.includes('-br') || ctx.args.includes('-brief')
    const args = ctx.args.filter((a) => !a.startsWith('-'))
    const obj = args[0] ?? 'help'
    const cmd = args[1] ?? 'show'
    const sys = ctx.sys
    const objName = /^a(d(dr?)?)?$|^address$/.test(obj) ? 'addr' : /^r(o(u(te?)?)?)?$/.test(obj) ? 'route' : /^l(i(nk?)?)?$/.test(obj) ? 'link' : /^n(e(i(gh?)?)?)?$/.test(obj) ? 'neigh' : obj
    const needRoot = () => {
      if (ctx.sh.user === 'root') return false
      ctx.err('RTNETLINK answers: Operation not permitted\n')
      return true
    }
    if (objName === 'addr' || objName === 'link') {
      if (cmd === 'add' || cmd === 'del') {
        if (needRoot()) return 2
        const cidr = args[2]
        const dev = args[args.indexOf('dev') + 1]
        const iface = sys.interfaces.find((i) => i.name === dev)
        if (!iface) {
          ctx.err(`Cannot find device "${dev}"\n`)
          return 1
        }
        if (cmd === 'add') {
          if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(cidr ?? '')) {
            ctx.err(`Error: any valid prefix is expected rather than "${cidr}".\n`)
            return 1
          }
          iface.ip = cidr
        } else iface.ip = undefined
        return 0
      }
      if (cmd === 'set') {
        if (needRoot()) return 2
        const dev = args[2] === 'dev' ? args[3] : args[2]
        const iface = sys.interfaces.find((i) => i.name === dev)
        if (!iface) {
          ctx.err(`Cannot find device "${dev}"\n`)
          return 1
        }
        if (args.includes('up')) iface.up = true
        if (args.includes('down')) iface.up = false
        return 0
      }
      const devIdx = args.indexOf('dev')
      const devFilter = devIdx >= 0 ? args[devIdx + 1] : cmd === 'show' && args[2] ? args[2] : undefined
      const all = [{ name: 'lo', ip: '127.0.0.1/8', mac: '00:00:00:00:00:00', up: true }, ...sys.interfaces].filter((i) => !devFilter || i.name === devFilter)
      if (devFilter && !all.length) {
        ctx.err(`Device "${devFilter}" does not exist.\n`)
        return 1
      }
      all.forEach((i, idx) => {
        const state = i.name === 'lo' ? 'UNKNOWN' : i.up ? 'UP' : 'DOWN'
        if (brief) {
          ctx.out(`${i.name.padEnd(16)} ${state.padEnd(14)} ${objName === 'link' ? i.mac : (i.ip ?? '')}\n`)
          return
        }
        const flags = i.name === 'lo' ? '<LOOPBACK,UP,LOWER_UP>' : i.up ? '<BROADCAST,MULTICAST,UP,LOWER_UP>' : '<BROADCAST,MULTICAST>'
        ctx.out(`${idx + 1}: ${i.name}: ${flags} mtu ${i.name === 'lo' ? 65536 : 1500} qdisc ${i.name === 'lo' ? 'noqueue' : 'fq_codel'} state ${state} group default qlen 1000\n`)
        ctx.out(`    link/${i.name === 'lo' ? 'loopback' : 'ether'} ${i.mac} brd ${i.name === 'lo' ? '00:00:00:00:00:00' : 'ff:ff:ff:ff:ff:ff'}\n`)
        if (objName === 'addr' && i.ip) {
          ctx.out(i.name === 'lo' ? `    inet 127.0.0.1/8 scope host lo\n       valid_lft forever preferred_lft forever\n    inet6 ::1/128 scope host noprefixroute \n       valid_lft forever preferred_lft forever\n` : `    inet ${i.ip} brd ${broadcastOf(i.ip)} scope global noprefixroute ${i.name}\n       valid_lft forever preferred_lft forever\n`)
        }
      })
      return 0
    }
    if (objName === 'route') {
      if (cmd === 'add' || cmd === 'del' || cmd === 'replace') {
        if (needRoot()) return 2
        if (args[2] === 'default') {
          if (cmd === 'del') sys.gateway = undefined
          else {
            const via = args[args.indexOf('via') + 1]
            if (cmd === 'add' && sys.gateway) {
              ctx.err('RTNETLINK answers: File exists\n')
              return 2
            }
            const reachableIf = sys.interfaces.find((i) => i.up && i.ip && inSubnet(via, i.ip))
            if (!reachableIf) {
              ctx.err('Error: Nexthop has invalid gateway.\n')
              return 2
            }
            sys.gateway = via
            sys.reachable.add(via)
          }
        }
        return 0
      }
      for (const i of sys.interfaces.filter((x) => x.up && x.ip)) {
        if (sys.gateway && inSubnet(sys.gateway, i.ip!)) ctx.out(`default via ${sys.gateway} dev ${i.name} proto static metric 100 \n`)
      }
      for (const i of sys.interfaces.filter((x) => x.up && x.ip)) ctx.out(`${networkOf(i.ip!)} dev ${i.name} proto kernel scope link src ${i.ip!.split('/')[0]} metric 100 \n`)
      return 0
    }
    if (objName === 'neigh') {
      if (sys.gateway && sys.isReachable(sys.gateway)) {
        const iface = sys.interfaces.find((i) => i.up && i.ip && inSubnet(sys.gateway!, i.ip))
        ctx.out(`${sys.gateway} dev ${iface?.name ?? 'eth0'} lladdr 52:54:00:12:35:02 REACHABLE\n`)
      }
      return 0
    }
    ctx.err(`Object "${obj}" is unknown, try "ip help".\n`)
    return 1
  },
})

register('ping', {
  usage: 'ping [-c count] [-i interval] destination',
  async run(ctx) {
    const a = parseArgs(ctx.args, { flags: { q: ['q'], n: ['n'] }, values: { c: ['c'], i: ['i'], W: ['W'], w: ['w'] } })
    const host = a.rest[0]
    if (!host) {
      ctx.err('ping: usage error: Destination address required\n')
      return 2
    }
    const ip = ctx.sys.resolveHost(host)
    if (!ip) {
      ctx.err(`ping: ${host}: Name or service not known\n`)
      return 2
    }
    const count = a.values.has('c') ? Number(a.values.get('c')) : 4
    const r = route(ctx, ip)
    if (!r.ok) {
      ctx.err('ping: connect: Network is unreachable\n')
      return 2
    }
    const ok = canReach(ctx, ip)
    ctx.out(`PING ${host} (${ip}) 56(84) bytes of data.\n`)
    const times: number[] = []
    const base = ip.startsWith('127.') || ctx.sys.ownIps().includes(ip) ? 0.04 : r.via ? 12 : 0.6
    for (let i = 1; i <= count; i++) {
      if (ok) {
        const t = +(base + Math.random() * base * 0.2).toFixed(base < 1 ? 3 : 1)
        times.push(t)
        if (!a.flags.has('q')) ctx.out(`64 bytes from ${ip}: icmp_seq=${i} ttl=${r.via ? 116 : 64} time=${t} ms\n`)
      } else if (!r.via && !a.flags.has('q')) {
        ctx.out(`From ${r.src} icmp_seq=${i} Destination Host Unreachable\n`)
      }
    }
    const lost = ok ? 0 : count
    ctx.out(`\n--- ${host} ping statistics ---\n${count} packets transmitted, ${count - lost} received, ${!ok && !r.via ? `+${count} errors, ` : ''}${Math.round((lost / count) * 100)}% packet loss, time ${(count - 1) * 1001}ms\n`)
    if (times.length) {
      const min = Math.min(...times)
      const max = Math.max(...times)
      const avg = times.reduce((s, x) => s + x, 0) / times.length
      ctx.out(`rtt min/avg/max/mdev = ${min.toFixed(3)}/${avg.toFixed(3)}/${max.toFixed(3)}/${((max - min) / 2).toFixed(3)} ms\n`)
    }
    if (!a.values.has('c') && ctx.isTTY) ctx.err('[simulador] Sin -c, ping sigue enviando paquetes hasta cortarlo con Ctrl+C; aquí se envían 4.\n')
    return ok ? 0 : 1
  },
})

function listeningSockets(ctx: CommandContext) {
  const out: { proto: string; local: string; port: number; proc: string; pid: number }[] = []
  for (const s of ctx.sys.services.values()) {
    if (!s.active) continue
    for (const p of s.ports) {
      const proto = p === 53 || p === 123 ? 'udp' : 'tcp'
      out.push({ proto, local: p === 323 ? '127.0.0.1' : '0.0.0.0', port: p, proc: s.name, pid: s.pid ?? 1 })
      if (p === 53) out.push({ proto: 'tcp', local: '0.0.0.0', port: p, proc: s.name, pid: s.pid ?? 1 })
    }
  }
  return out.sort((a, b) => a.port - b.port)
}

register('ss', {
  usage: 'ss [options]',
  summary: '  -t tcp  -u udp  -l listening  -n numeric  -p processes  -a all',
  path: '/usr/sbin',
  run(ctx) {
    const f = ctx.args.filter((a) => a.startsWith('-')).join('')
    const tcp = f.includes('t') || (!f.includes('u'))
    const udp = f.includes('u')
    const showProc = f.includes('p')
    const socks = listeningSockets(ctx).filter((s) => (s.proto === 'tcp' && tcp) || (s.proto === 'udp' && udp))
    ctx.out(`Netid State  Recv-Q Send-Q Local Address:Port  Peer Address:Port${showProc ? 'Process' : ''}\n`)
    for (const s of socks) {
      const proc = showProc ? (ctx.sh.user === 'root' ? ` users:(("${s.proc}",pid=${s.pid},fd=6))` : '') : ''
      ctx.out(`${s.proto.padEnd(5)} ${s.proto === 'udp' ? 'UNCONN' : 'LISTEN'} 0      ${s.proto === 'udp' ? '0     ' : '511   '} ${`${s.local}:${f.includes('n') ? s.port : s.port}`.padEnd(18)} 0.0.0.0:*${proc}\n`)
    }
    return 0
  },
})

register('netstat', {
  usage: 'netstat -tulpn',
  run(ctx) {
    ctx.out('Active Internet connections (only servers)\nProto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name\n')
    for (const s of listeningSockets(ctx)) ctx.out(`${s.proto.padEnd(5)}      0      0 ${`${s.local}:${s.port}`.padEnd(23)} 0.0.0.0:*               ${s.proto === 'tcp' ? 'LISTEN     ' : '           '} ${ctx.sh.user === 'root' ? `${s.pid}/${s.proc}` : '-'}\n`)
    return 0
  },
})

register('ifconfig', {
  usage: 'ifconfig [interface]',
  run(ctx) {
    for (const i of ctx.sys.interfaces) {
      ctx.out(`${i.name}: flags=${i.up ? '4163<UP,BROADCAST,RUNNING,MULTICAST>' : '4098<BROADCAST,MULTICAST>'}  mtu 1500\n${i.ip ? `        inet ${i.ip.split('/')[0]}  netmask 255.255.255.0  broadcast ${broadcastOf(i.ip)}\n` : ''}        ether ${i.mac}  txqueuelen 1000  (Ethernet)\n\n`)
    }
    ctx.out('lo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536\n        inet 127.0.0.1  netmask 255.0.0.0\n\n')
    return 0
  },
})

function dnsServerReachable(ctx: CommandContext, server?: string): string | undefined {
  const s = server ?? ctx.sys.dns[0]
  if (!s) return undefined
  return canReach(ctx, s) || ctx.sys.ownIps().includes(s) ? s : undefined
}

function lookup(ctx: CommandContext, name: string, type: string): string[] {
  const recs = ctx.sys.dnsRecords
  const key = type === 'A' ? name : `${type} ${name}`
  const v = recs[key] ?? recs[key.replace(/\.$/, '')]
  return v ? v.split(/\s*;\s*/) : []
}

register('dig', {
  usage: 'dig [@server] name [type] [+short]',
  run(ctx) {
    const short = ctx.args.includes('+short')
    let server: string | undefined
    let reverse = false
    const words: string[] = []
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i]
      if (a.startsWith('@')) server = a.slice(1)
      else if (a === '-x') reverse = true
      else if (!a.startsWith('+')) words.push(a)
    }
    let name = words[0] ?? '.'
    let type = (words[1] ?? 'A').toUpperCase()
    if (reverse) {
      type = 'PTR'
      name = name.split('.').reverse().join('.') + '.in-addr.arpa'
    }
    const srv = dnsServerReachable(ctx, server)
    if (!srv) {
      ctx.out(`;; communications error to ${server ?? ctx.sys.dns[0] ?? '127.0.0.53'}#53: timed out\n;; communications error to ${server ?? ctx.sys.dns[0] ?? '127.0.0.53'}#53: timed out\n\n; <<>> DiG 9.18.33 <<>> ${ctx.args.join(' ')}\n;; global options: +cmd\n;; no servers could be reached\n`)
      return 9
    }
    const answers = lookup(ctx, name.replace(/\.$/, ''), type)
    if (short) {
      if (answers.length) ctx.out(answers.join('\n') + '\n')
      return 0
    }
    const fq = name.endsWith('.') ? name : `${name}.`
    ctx.out(`\n; <<>> DiG 9.18.33 <<>> ${ctx.args.filter((a) => !a.startsWith('+')).join(' ')}\n;; global options: +cmd\n;; Got answer:\n;; ->>HEADER<<- opcode: QUERY, status: ${answers.length ? 'NOERROR' : 'NXDOMAIN'}, id: ${1000 + Math.floor(Math.random() * 60000)}\n;; flags: qr rd ra; QUERY: 1, ANSWER: ${answers.length}, AUTHORITY: 0, ADDITIONAL: 1\n\n;; QUESTION SECTION:\n;${fq}\t\t\tIN\t${type}\n\n`)
    if (answers.length) {
      ctx.out(';; ANSWER SECTION:\n')
      for (const ans of answers) ctx.out(`${fq}\t\t300\tIN\t${type}\t${ans}\n`)
      ctx.out('\n')
    }
    ctx.out(`;; Query time: 14 msec\n;; SERVER: ${srv}#53(${srv}) (UDP)\n;; WHEN: ${new Date().toUTCString()}\n;; MSG SIZE  rcvd: ${40 + answers.length * 16}\n\n`)
    return 0
  },
})

register('nslookup', {
  usage: 'nslookup name [server]',
  run(ctx) {
    const [name, server] = ctx.args.filter((a) => !a.startsWith('-'))
    const srv = dnsServerReachable(ctx, server)
    if (!srv) {
      ctx.out(';; communications error to ' + (server ?? ctx.sys.dns[0]) + '#53: timed out\n;; no servers could be reached\n\n')
      return 1
    }
    ctx.out(`Server:\t\t${srv}\nAddress:\t${srv}#53\n\n`)
    const answers = lookup(ctx, name ?? '', 'A')
    if (!answers.length) {
      ctx.out(`** server can't find ${name}: NXDOMAIN\n\n`)
      return 1
    }
    ctx.out(`Non-authoritative answer:\n${answers.map((a) => `Name:\t${name}\nAddress: ${a}`).join('\n')}\n\n`)
    return 0
  },
})

register('host', {
  usage: 'host name',
  run(ctx) {
    const name = ctx.args.find((a) => !a.startsWith('-'))
    if (!name) {
      ctx.err('Usage: host [-aCdilrTvVw] [-c class] [-N ndots] [-t type] [-W time] hostname [server]\n')
      return 1
    }
    if (!dnsServerReachable(ctx)) {
      ctx.out(';; communications error to ' + ctx.sys.dns[0] + '#53: timed out\n;; no servers could be reached\n')
      return 1
    }
    const answers = lookup(ctx, name, 'A')
    if (!answers.length) {
      ctx.out(`Host ${name} not found: 3(NXDOMAIN)\n`)
      return 1
    }
    for (const a of answers) ctx.out(`${name} has address ${a}\n`)
    for (const mx of lookup(ctx, name, 'MX')) ctx.out(`${name} mail is handled by ${mx}\n`)
    return 0
  },
})

function localWebContent(ctx: CommandContext, port: number): { status: number; body: string; server: string } | undefined {
  const svc = [...ctx.sys.services.values()].find((s) => s.active && s.ports.includes(port))
  if (!svc) return undefined
  const isNginx = svc.name === 'nginx'
  const candidates =
    ctx.sys.distro === 'rocky'
      ? isNginx
        ? ['/usr/share/nginx/html/index.html']
        : ['/var/www/html/index.html']
      : ['/var/www/html/index.html', '/var/www/html/index.nginx-debian.html']
  for (const c of candidates) {
    if (ctx.sys.vfs.exists(c)) return { status: 200, body: ctx.sys.vfs.readFile(c, ROOT_CRED), server: isNginx ? 'nginx/1.26.3' : 'Apache/2.4.63' }
  }
  return { status: 403, body: '<html><head><title>403 Forbidden</title></head><body><h1>403 Forbidden</h1></body></html>\n', server: isNginx ? 'nginx/1.26.3' : 'Apache/2.4.63' }
}

register(['curl', 'wget'], {
  usage: 'curl [options] <url>',
  summary: '  -I  only headers  -s  silent  -o FILE  write output to FILE  -v  verbose  -L  follow redirects',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { I: ['I', 'head'], s: ['s', 'silent'], v: ['v', 'verbose'], L: ['L', 'location'], k: ['k', 'insecure'], f: ['f', 'fail'], q: ['q'], O: ['O'] }, values: { o: ['o', 'output'], m: ['m', 'max-time'] } })
    const url = a.rest[0]
    if (!url) {
      ctx.err(ctx.name === 'wget' ? 'wget: missing URL\n' : "curl: try 'curl --help' for more information\n")
      return ctx.name === 'wget' ? 1 : 2
    }
    const m = /^(?:(https?):\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url)
    if (!m) {
      ctx.err(`curl: (3) URL rejected: Malformed input to a URL function\n`)
      return 3
    }
    const scheme = m[1] ?? 'http'
    const host = m[2]
    const port = m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 80
    const ip = ctx.sys.resolveHost(host)
    if (!ip) {
      ctx.err(ctx.name === 'wget' ? `wget: unable to resolve host address '${host}'\n` : `curl: (6) Could not resolve host: ${host}\n`)
      return ctx.name === 'wget' ? 4 : 6
    }
    let res: { status: number; body: string; server: string } | undefined
    if (ip.startsWith('127.') || ctx.sys.ownIps().includes(ip)) {
      res = localWebContent(ctx, port)
      if (!res) {
        ctx.err(ctx.name === 'wget' ? `Connecting to ${host} (${host})|${ip}|:${port}... failed: Connection refused.\n` : `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Couldn't connect to server\n`)
        return ctx.name === 'wget' ? 4 : 7
      }
    } else if (canReach(ctx, ip)) {
      const body = ctx.sys.sites[host] ?? ctx.sys.sites[ip] ?? `<!doctype html>\n<html><head><title>${host}</title></head><body><h1>${host}</h1></body></html>\n`
      res = { status: 200, body, server: 'nginx' }
    } else {
      ctx.err(ctx.name === 'wget' ? `Connecting to ${host}|${ip}|:${port}... failed: Connection timed out.\n` : `curl: (28) Failed to connect to ${host} port ${port} after 3002 ms: Timeout was reached\n`)
      return ctx.name === 'wget' ? 4 : 28
    }
    const statusText = res.status === 200 ? 'OK' : res.status === 403 ? 'Forbidden' : 'Not Found'
    const headers = `HTTP/1.1 ${res.status} ${statusText}\nServer: ${res.server}\nDate: ${new Date().toUTCString()}\nContent-Type: text/html\nContent-Length: ${res.body.length}\nConnection: keep-alive\n\n`
    if (ctx.name === 'wget') {
      const file = a.values.get('o') ?? (m[4] && m[4] !== '/' ? m[4].split('/').pop()! : 'index.html')
      ctx.sys.vfs.writeFile(ctx.sh.resolve(file), res.body, ctx.sh.cred, { mode: 0o666 & ~ctx.sh.umask })
      ctx.err(`--${new Date().toISOString().slice(0, 19).replace('T', ' ')}--  ${url}\nResolving ${host}... ${ip}\nConnecting to ${host}|${ip}|:${port}... connected.\nHTTP request sent, awaiting response... ${res.status} ${statusText}\nLength: ${res.body.length} [text/html]\nSaving to: '${file}'\n\n'${file}' saved [${res.body.length}/${res.body.length}]\n\n`)
      return res.status >= 400 ? 8 : 0
    }
    if (a.flags.has('v')) {
      // Formato de OpenSSL: "Oct  1 16:55:24 2026 GMT" (día rellenado con espacio)
      const gmt = (d: Date) => `${d.toUTCString().slice(8, 11)} ${String(d.getUTCDate()).padStart(2, ' ')} ${d.toISOString().slice(11, 19)} ${d.getUTCFullYear()} GMT`
      const now = Date.now()
      const tls =
        scheme === 'https'
          ? `* ALPN: curl offers h2,http/1.1\n* SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384 / X25519 / RSASSA-PSS\n* ALPN: server accepted http/1.1\n* Server certificate:\n*  subject: CN=${host}\n*  start date: ${gmt(new Date(now - 26 * 86400000))}\n*  expire date: ${gmt(new Date(now + 64 * 86400000))}\n*  subjectAltName: host "${host}" matched cert's "${host}"\n*  SSL certificate verify ok.\n`
          : ''
      ctx.err(`* Host ${host}:${port} was resolved.\n* IPv6: (none)\n* IPv4: ${ip}\n*   Trying ${ip}:${port}...\n${tls}* Connected to ${host} (${ip}) port ${port}\n> GET ${m[4] ?? '/'} HTTP/1.1\n> Host: ${host}\n> User-Agent: curl/8.9.1\n> Accept: */*\n>\n< ${headers.trim().split('\n').join('\n< ')}\n<\n`)
    }
    if (a.flags.has('I')) {
      ctx.out(headers.replace(/\n/g, '\r\n').replace(/\r\n\r\n$/, '\r\n\r\n'))
      return 0
    }
    if (a.flags.has('f') && res.status >= 400) {
      ctx.err(`curl: (22) The requested URL returned error: ${res.status}\n`)
      return 22
    }
    if (a.values.has('o')) {
      ctx.sys.vfs.writeFile(ctx.sh.resolve(a.values.get('o')!), res.body, ctx.sh.cred, { mode: 0o666 & ~ctx.sh.umask })
      if (!a.flags.has('s')) ctx.err(`  % Total    % Received % Xferd  Average Speed   Time\n100  ${res.body.length}  100  ${res.body.length}    0     0   ${res.body.length * 10}      0 --:--:--\n`)
      return 0
    }
    ctx.out(res.body)
    return 0
  },
})

const FW_SERVICES: Record<string, string> = { ssh: '22/tcp', http: '80/tcp', https: '443/tcp', 'dhcpv6-client': '546/udp', cockpit: '9090/tcp', dns: '53/udp', mysql: '3306/tcp', postgresql: '5432/tcp', samba: '445/tcp', nfs: '2049/tcp', ntp: '123/udp', smtp: '25/tcp', ftp: '21/tcp' }

register('firewall-cmd', {
  usage: 'firewall-cmd [OPTIONS...]',
  summary: '  --state  --get-default-zone  --get-active-zones  --list-all  --list-services  --list-ports\n  --add-service=SERVICE  --remove-service=SERVICE  --add-port=PORT/PROTO  --remove-port=PORT/PROTO\n  --permanent  --reload  --runtime-to-permanent  --get-services  --query-service=SERVICE',
  run(ctx) {
    const fw = ctx.sys.firewall
    const running = ctx.sys.services.get('firewalld')?.active ?? false
    const perm = ctx.args.includes('--permanent')
    const opts = ctx.args.filter((a) => a !== '--permanent' && !a.startsWith('--zone'))
    if (opts[0] === '--state') {
      ctx.out(running ? 'running\n' : 'not running\n')
      return running ? 0 : 252
    }
    if (ctx.sh.user !== 'root') {
      ctx.err('Authorization failed.\n    Make sure polkit agent is running or run the application as superuser.\n')
      return 1
    }
    if (!running && !perm) {
      ctx.err('FirewallD is not running\n')
      return 252
    }
    const services = perm ? fw.permServices : fw.services
    const ports = perm ? fw.permPorts : fw.ports
    const iface = ctx.sys.interfaces[0]?.name ?? 'eth0'
    let code = 0
    for (const opt of opts) {
      const [key, value] = opt.split('=')
      switch (key) {
        case '--get-default-zone':
          ctx.out('public\n')
          break
        case '--get-active-zones':
          ctx.out(`public\n  interfaces: ${iface}\n`)
          break
        case '--get-services':
          ctx.out(Object.keys(FW_SERVICES).sort().join(' ') + '\n')
          break
        case '--list-services':
          ctx.out([...services].sort().join(' ') + '\n')
          break
        case '--list-ports':
          ctx.out([...ports].sort().join(' ') + '\n')
          break
        case '--list-all':
          ctx.out(`public (active)\n  target: default\n  icmp-block-inversion: no\n  interfaces: ${iface}\n  sources: \n  services: ${[...services].sort().join(' ')}\n  ports: ${[...ports].sort().join(' ')}\n  protocols: \n  forward: yes\n  masquerade: no\n  forward-ports: \n  source-ports: \n  icmp-blocks: \n  rich rules: \n`)
          break
        case '--add-service':
        case '--remove-service':
          if (!value || !FW_SERVICES[value]) {
            ctx.err(`Error: INVALID_SERVICE: '${value}' not among existing services\n`)
            return 101
          }
          if (key === '--add-service') {
            if (services.has(value)) ctx.err(`Warning: ALREADY_ENABLED: ${value}\n`)
            services.add(value)
          } else {
            if (!services.has(value)) ctx.err(`Warning: NOT_ENABLED: ${value}\n`)
            services.delete(value)
          }
          ctx.out('success\n')
          break
        case '--add-port':
        case '--remove-port':
          if (!value || !/^\d+(-\d+)?\/(tcp|udp|sctp|dccp)$/.test(value)) {
            ctx.err(`Error: INVALID_PORT: '${value}'\n`)
            return 102
          }
          if (key === '--add-port') ports.add(value)
          else ports.delete(value)
          ctx.out('success\n')
          break
        case '--query-service':
          ctx.out(services.has(value) ? 'yes\n' : 'no\n')
          code = services.has(value) ? 0 : 1
          break
        case '--reload':
          fw.services = new Set(fw.permServices)
          fw.ports = new Set(fw.permPorts)
          ctx.out('success\n')
          break
        case '--runtime-to-permanent':
          fw.permServices = new Set(fw.services)
          fw.permPorts = new Set(fw.ports)
          ctx.out('success\n')
          break
        default:
          ctx.err(`usage: see firewall-cmd man page\nfirewall-cmd: error: unrecognized arguments: ${opt}\n`)
          return 2
      }
    }
    return code
  },
})

register('ufw', {
  usage: 'ufw COMMAND',
  summary: '  enable | disable | status [verbose|numbered] | allow RULE | deny RULE | delete RULE|NUM | reset',
  path: '/usr/sbin',
  run(ctx) {
    if (ctx.sh.user !== 'root') {
      ctx.err('ERROR: You need to be root to run this script\n')
      return 1
    }
    const u = ctx.sys.ufw
    const [verb, ...rest] = ctx.args
    const normalize = (t: string) => (/^(ssh|openssh)$/i.test(t) ? 'OpenSSH' : t)
    switch (verb) {
      case 'enable':
        ctx.out('Command may disrupt existing ssh connections. Proceed with operation (y|n)? y\nFirewall is active and enabled on system startup\n')
        if (!u.rules.some((r) => r.target === 'OpenSSH' || r.target === '22' || r.target === '22/tcp')) ctx.err('[simulador] Atención: no hay ninguna regla que permita SSH. En un servidor remoto, esto corta el acceso.\n')
        u.active = true
        return 0
      case 'disable':
        u.active = false
        ctx.out('Firewall stopped and disabled on system startup\n')
        return 0
      case 'status':
        if (!u.active) {
          ctx.out('Status: inactive\n')
          return 0
        }
        ctx.out(`Status: active\n${rest[0] === 'verbose' ? 'Logging: on (low)\nDefault: deny (incoming), allow (outgoing), disabled (routed)\nNew profiles: skip\n' : ''}\n${rest[0] === 'numbered' ? '     ' : ''}To                         Action      From\n${rest[0] === 'numbered' ? '     ' : ''}--                         ------      ----\n`)
        u.rules.forEach((r, i) => ctx.out(`${rest[0] === 'numbered' ? `[${String(i + 1).padStart(2)}] ` : ''}${r.target.padEnd(26)} ${r.action.toUpperCase().padEnd(11)} Anywhere\n`))
        return 0
      case 'allow':
      case 'deny': {
        const target = normalize(rest.join(' ').replace(/^in on \S+ /, ''))
        if (!target) {
          ctx.err('ERROR: Invalid syntax\n')
          return 1
        }
        if (u.rules.some((r) => r.target === target && r.action === verb)) ctx.out('Skipping adding existing rule\nSkipping adding existing rule (v6)\n')
        else {
          u.rules.push({ action: verb, target })
          ctx.out(u.active ? 'Rule added\nRule added (v6)\n' : 'Rules updated\nRules updated (v6)\n')
        }
        return 0
      }
      case 'delete': {
        if (/^\d+$/.test(rest[0] ?? '')) {
          const idx = Number(rest[0]) - 1
          if (!u.rules[idx]) {
            ctx.err('ERROR: Could not find rule\n')
            return 1
          }
          ctx.out(`Deleting:\n ${u.rules[idx].action} ${u.rules[idx].target}\nProceed with operation (y|n)? y\nRule deleted\n`)
          u.rules.splice(idx, 1)
          return 0
        }
        const [action, ...t] = rest
        const target = normalize(t.join(' '))
        const before = u.rules.length
        u.rules = u.rules.filter((r) => !(r.action === action && r.target === target))
        ctx.out(before === u.rules.length ? 'Could not delete non-existent rule\n' : 'Rule deleted\nRule deleted (v6)\n')
        return 0
      }
      case 'reset':
        u.rules = []
        u.active = false
        ctx.out('Resetting all rules to installed defaults. Proceed with operation (y|n)? y\n')
        return 0
      default:
        ctx.err(`ERROR: Invalid syntax\n\nUsage: ufw COMMAND\n`)
        return 1
    }
  },
})

register('nmcli', {
  usage: 'nmcli [OPTIONS] OBJECT { COMMAND | help }',
  summary: '  device status | connection show | connection modify NAME ipv4.addresses X/Y ipv4.gateway G ipv4.dns D ipv4.method manual | connection up NAME',
  run(ctx) {
    if (ctx.sys.distro !== 'rocky') {
      ctx.err('bash: nmcli: command not found\n')
      return 127
    }
    const [obj, cmd, name, ...props] = ctx.args
    const sys = ctx.sys
    if (/^d(ev(ice)?)?$/.test(obj ?? '')) {
      ctx.out('DEVICE  TYPE      STATE                   CONNECTION \n')
      for (const i of sys.interfaces) ctx.out(`${i.name.padEnd(7)} ethernet  ${(i.up ? 'connected' : 'disconnected').padEnd(23)} ${i.up ? i.name : '--'}     \n`)
      ctx.out('lo      loopback  connected (externally)  lo         \n')
      return 0
    }
    if (/^c(on(nection)?)?$/.test(obj ?? '')) {
      if (!cmd || cmd === 'show' || cmd === 's') {
        if (name) {
          const i = sys.interfaces.find((x) => x.name === name)
          if (!i) {
            ctx.err(`Error: ${name} - no such connection profile.\n`)
            return 10
          }
          ctx.out(`connection.id:                          ${i.name}\nconnection.interface-name:              ${i.name}\nipv4.method:                            manual\nipv4.addresses:                         ${i.ip ?? '--'}\nipv4.gateway:                           ${sys.gateway ?? '--'}\nipv4.dns:                               ${sys.dns.join(',') || '--'}\n`)
          return 0
        }
        ctx.out('NAME    UUID                                  TYPE      DEVICE \n')
        for (const i of sys.interfaces) ctx.out(`${i.name.padEnd(7)} 3c1f0d2a-8b4e-4f6a-9e21-6d0b7a5c4e19  ethernet  ${i.up ? i.name : '--'}  \n`)
        return 0
      }
      if (ctx.sh.user !== 'root') {
        ctx.err('Error: Failed to modify connection: Insufficient privileges\n')
        return 1
      }
      const iface = sys.interfaces.find((x) => x.name === name)
      if (!iface) {
        ctx.err(`Error: unknown connection '${name}'.\n`)
        return 10
      }
      if (cmd === 'modify' || cmd === 'mod' || cmd === 'm') {
        const pending = sys.nmPending.get(name!) ?? {}
        for (let i = 0; i < props.length; i += 2) {
          const key = props[i].replace(/^\+/, '')
          const val = props[i + 1] ?? ''
          if (key === 'ipv4.addresses') pending.address = val
          else if (key === 'ipv4.gateway') pending.gateway = val
          else if (key === 'ipv4.dns') pending.dns = val.split(/[ ,]+/).filter(Boolean)
          else if (key === 'ipv4.method' || key === 'connection.autoconnect') continue
          else {
            ctx.err(`Error: invalid property '${key}'.\n`)
            return 2
          }
        }
        sys.nmPending.set(name!, pending)
        return 0
      }
      if (cmd === 'up' || cmd === 'reload') {
        const p = sys.nmPending.get(name!)
        if (p?.address) iface.ip = p.address
        if (p?.gateway) {
          sys.gateway = p.gateway
          sys.reachable.add(p.gateway)
        }
        if (p?.dns) {
          sys.dns = p.dns
          sys.vfs.writeFile('/etc/resolv.conf', `# Generated by NetworkManager\n${p.dns.map((d) => `nameserver ${d}`).join('\n')}\n`, ROOT_CRED)
        }
        iface.up = true
        sys.nmPending.delete(name!)
        ctx.out(`Connection successfully activated (D-Bus active path: /org/freedesktop/NetworkManager/ActiveConnection/${sys.interfaces.indexOf(iface) + 2})\n`)
        return 0
      }
      if (cmd === 'down') {
        iface.up = false
        ctx.out(`Connection '${name}' successfully deactivated.\n`)
        return 0
      }
    }
    ctx.err(`Error: argument '${obj}' not understood. Try passing --help instead.\n`)
    return 2
  },
})

register('traceroute', {
  usage: 'traceroute host',
  run(ctx) {
    const host = ctx.args.find((a) => !a.startsWith('-'))
    if (!host) {
      ctx.err('Specify "host" missing argument.\n')
      return 1
    }
    const ip = ctx.sys.resolveHost(host)
    if (!ip) {
      ctx.err(`${host}: Name or service not known\nCannot handle "host" cmdline arg \`${host}' on position 1 (argc 1)\n`)
      return 2
    }
    ctx.out(`traceroute to ${host} (${ip}), 30 hops max, 60 byte packets\n`)
    const r = route(ctx, ip)
    if (!r.ok) {
      ctx.err('connect: Network is unreachable\n')
      return 1
    }
    let hop = 1
    if (r.via) {
      const gwOk = ctx.sys.isReachable(r.via)
      ctx.out(` ${hop++}  ${gwOk ? `_gateway (${r.via})  0.512 ms  0.487 ms  0.455 ms` : '* * *'}\n`)
      if (!gwOk) {
        for (; hop <= 4; hop++) ctx.out(` ${hop}  * * *\n`)
        return 0
      }
    }
    if (canReach(ctx, ip)) ctx.out(` ${hop}  ${host} (${ip})  ${r.via ? '12.307' : '0.601'} ms  ${r.via ? '12.118' : '0.584'} ms  ${r.via ? '12.054' : '0.570'} ms\n`)
    else for (let i = 0; i < 3; i++) ctx.out(` ${hop++}  * * *\n`)
    return 0
  },
})

register(['nc', 'ncat'], {
  usage: 'nc -zv host port',
  run(ctx) {
    const rest = ctx.args.filter((a) => !a.startsWith('-'))
    const [host, portStr] = rest
    const port = Number(portStr)
    const ip = host ? ctx.sys.resolveHost(host) : undefined
    if (!ip || !port) {
      ctx.err('usage: nc [-46CDdFhklNnrStUuvZz] [destination] [port]\n')
      return 1
    }
    const local = ip.startsWith('127.') || ctx.sys.ownIps().includes(ip)
    const open = local ? [...ctx.sys.services.values()].some((s) => s.active && s.ports.includes(port)) : canReach(ctx, ip)
    if (open) ctx.err(`Connection to ${host} (${ip}) ${port} port [tcp/*] succeeded!\n`)
    else ctx.err(`nc: connect to ${host} (${ip}) port ${port} (tcp) failed: Connection refused\n`)
    return open ? 0 : 1
  },
})
