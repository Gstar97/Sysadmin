/**
 * Los dos lenguajes de filtro de capturas:
 * - BPF, el de tcpdump ("host 192.168.10.53 and port 53"): decide qué se captura o se muestra.
 * - El de visualización de Wireshark ("dns && ip.src == 192.168.10.53"): campos con nombre,
 *   comparaciones y "contains".
 * Los dos se compilan a una función sobre un paquete y avisan los errores como sus programas.
 */
import type { Pkt } from './model'

type Pred = (p: Pkt) => boolean

function ipInt(s: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return undefined
  const v = m.slice(1).map(Number)
  if (v.some((x) => x > 255)) return undefined
  return ((v[0] << 24) | (v[1] << 16) | (v[2] << 8) | v[3]) >>> 0
}

function inNet(ip: string | undefined, cidr: string): boolean {
  if (!ip) return false
  const [n, p] = cidr.split('/')
  const a = ipInt(ip)
  const b = ipInt(n)
  const pre = p === undefined ? 32 : Number(p)
  if (a === undefined || b === undefined) return false
  const mask = pre === 0 ? 0 : (~0 << (32 - pre)) >>> 0
  return ((a & mask) >>> 0) === ((b & mask) >>> 0)
}

const ports = (p: Pkt) => (p.tcp ? [p.tcp.sport, p.tcp.dport] : p.udp ? [p.udp.sport, p.udp.dport] : [])
const srcPort = (p: Pkt) => p.tcp?.sport ?? p.udp?.sport
const dstPort = (p: Pkt) => p.tcp?.dport ?? p.udp?.dport
const srcIp = (p: Pkt) => p.ip?.src ?? p.arp?.spa
const dstIp = (p: Pkt) => p.ip?.dst ?? p.arp?.tpa

const SERVICES: Record<string, number> = { http: 80, https: 443, domain: 53, ssh: 22, ntp: 123, bootps: 67, bootpc: 68, smtp: 25, telnet: 23, microsoft_ds: 445, 'microsoft-ds': 445, rdp: 3389, 'ms-wbt-server': 3389 }

// -------------------------------------------------------------------------------------------
// BPF (tcpdump)
// -------------------------------------------------------------------------------------------

export class FilterError extends Error {}

export function compileBpf(expr: string): Pred {
  const src = expr.trim()
  if (!src) return () => true
  const toks = src
    .replace(/\(/g, ' ( ')
    .replace(/\)/g, ' ) ')
    .replace(/&&/g, ' and ')
    .replace(/\|\|/g, ' or ')
    .replace(/!(?!=)/g, ' not ')
    .split(/\s+/)
    .filter(Boolean)
  let i = 0
  const peek = () => toks[i]
  const next = () => toks[i++]
  const fail = (msg?: string): never => {
    throw new FilterError(msg ?? `tcpdump: syntax error in filter expression: syntax error`)
  }

  function primary(): Pred {
    const t = next()
    if (t === undefined) fail()
    if (t === '(') {
      const e = or()
      if (next() !== ')') fail()
      return e
    }
    if (t === 'not') {
      const e = primary()
      return (p) => !e(p)
    }
    let dir: 'src' | 'dst' | undefined
    let tok = t
    if (tok === 'src' || tok === 'dst') {
      dir = tok
      tok = next() ?? fail()
    }
    let proto: 'tcp' | 'udp' | undefined
    if ((tok === 'tcp' || tok === 'udp') && (peek() === 'port' || peek() === 'portrange' || peek() === 'src' || peek() === 'dst')) {
      proto = tok
      tok = next()!
      if (tok === 'src' || tok === 'dst') {
        dir = tok
        tok = next() ?? fail()
      }
    }
    if (tok === 'host') {
      const h = next() ?? fail()
      if (ipInt(h) === undefined) fail(`tcpdump: can't parse host '${h}' (usá una IP; con -n no se resuelven nombres)`)
      return (p) => (dir === 'src' ? srcIp(p) === h : dir === 'dst' ? dstIp(p) === h : srcIp(p) === h || dstIp(p) === h)
    }
    if (tok === 'net') {
      const n = next() ?? fail()
      if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(n)) fail(`tcpdump: invalid net '${n}' (va como 192.168.10.0/24)`)
      return (p) => (dir === 'src' ? inNet(srcIp(p), n) : dir === 'dst' ? inNet(dstIp(p), n) : inNet(srcIp(p), n) || inNet(dstIp(p), n))
    }
    if (tok === 'port' || tok === 'portrange') {
      const v = next() ?? fail()
      let lo: number
      let hi: number
      if (tok === 'portrange') {
        const m = /^(\d+)-(\d+)$/.exec(v) ?? fail(`tcpdump: illegal port range '${v}'`)
        lo = Number(m[1])
        hi = Number(m[2])
      } else {
        const n = /^\d+$/.test(v) ? Number(v) : SERVICES[v]
        if (n === undefined) fail(`tcpdump: unknown port '${v}'`)
        lo = hi = n!
      }
      const hit = (x: number | undefined) => x !== undefined && x >= lo && x <= hi
      return (p) => {
        if (proto === 'tcp' && !p.tcp) return false
        if (proto === 'udp' && !p.udp) return false
        return dir === 'src' ? hit(srcPort(p)) : dir === 'dst' ? hit(dstPort(p)) : ports(p).some(hit)
      }
    }
    if (dir && ipInt(tok) !== undefined) return (p) => (dir === 'src' ? srcIp(p) === tok : dstIp(p) === tok)
    if (dir) fail()
    if (tok === 'tcp') return (p) => !!p.tcp
    if (tok === 'udp') return (p) => !!p.udp
    if (tok === 'icmp') return (p) => !!p.icmp
    if (tok === 'arp') return (p) => !!p.arp
    if (tok === 'ip') return (p) => !!p.ip
    if (tok === 'ip6') return () => false
    if (tok === 'greater' || tok === 'less') {
      const n = Number(next())
      if (!Number.isFinite(n)) fail()
      return tok === 'greater' ? (p) => p.size >= n : (p) => p.size <= n
    }
    // tcp[tcpflags] & (tcp-syn|tcp-fin) != 0
    if (/^tcp\[tcpflags\]$/.test(tok) || /^tcp\[13\]$/.test(tok)) {
      if (next() !== '&') fail()
      let flagsExpr = next() ?? fail()
      if (flagsExpr === '(') {
        flagsExpr = ''
        while (peek() !== ')' && peek() !== undefined) flagsExpr += next()
        next()
      }
      const map: Record<string, string> = { 'tcp-syn': 'S', 'tcp-ack': 'A', 'tcp-fin': 'F', 'tcp-rst': 'R', 'tcp-push': 'P' }
      const want = flagsExpr.split('|').map((f) => map[f] ?? fail(`tcpdump: unknown tcp flag '${f}'`))
      const op = next()
      const val = next()
      if ((op !== '!=' && op !== '==' && op !== '=') || val === undefined) fail()
      return (p) => {
        if (!p.tcp) return false
        const any = want.some((f) => p.tcp!.flags.includes(f as 'S'))
        if (op === '!=' && val === '0') return any
        if ((op === '==' || op === '=') && val === '0') return !any
        return want.every((f) => p.tcp!.flags.includes(f as 'S'))
      }
    }
    if (ipInt(tok) !== undefined) return (p) => srcIp(p) === tok || dstIp(p) === tok
    return fail()
  }
  function and(): Pred {
    let l = primary()
    while (peek() === 'and' || (peek() !== undefined && peek() !== 'or' && peek() !== ')')) {
      if (peek() === 'and') next()
      else fail()
      const r = primary()
      const a = l
      l = (p) => a(p) && r(p)
    }
    return l
  }
  function or(): Pred {
    let l = and()
    while (peek() === 'or') {
      next()
      const r = and()
      const a = l
      l = (p) => a(p) || r(p)
    }
    return l
  }
  const e = or()
  if (i < toks.length) fail()
  return e
}

// -------------------------------------------------------------------------------------------
// Filtros de visualización de Wireshark
// -------------------------------------------------------------------------------------------

type Val = string | number | boolean | undefined | (string | number)[]

const FIELDS: Record<string, (p: Pkt) => Val> = {
  frame: () => true,
  'frame.len': (p) => p.size,
  'frame.number': (p) => p.n,
  eth: () => true,
  'eth.addr': (p) => [p.eth.src, p.eth.dst],
  'eth.src': (p) => p.eth.src,
  'eth.dst': (p) => p.eth.dst,
  ip: (p) => !!p.ip,
  'ip.addr': (p) => (p.ip ? [p.ip.src, p.ip.dst] : undefined),
  'ip.src': (p) => p.ip?.src,
  'ip.dst': (p) => p.ip?.dst,
  'ip.ttl': (p) => p.ip?.ttl,
  'ip.flags.df': (p) => (p.ip ? (p.ip.df ? 1 : 0) : undefined),
  tcp: (p) => !!p.tcp,
  'tcp.port': (p) => (p.tcp ? [p.tcp.sport, p.tcp.dport] : undefined),
  'tcp.srcport': (p) => p.tcp?.sport,
  'tcp.dstport': (p) => p.tcp?.dport,
  'tcp.stream': (p) => p.tcp?.stream,
  'tcp.len': (p) => p.tcp?.len,
  'tcp.seq': (p) => p.tcp?.seq,
  'tcp.ack': (p) => p.tcp?.ack,
  'tcp.flags.syn': (p) => (p.tcp ? (p.tcp.flags.includes('S') ? 1 : 0) : undefined),
  'tcp.flags.ack': (p) => (p.tcp ? (p.tcp.flags.includes('A') ? 1 : 0) : undefined),
  'tcp.flags.fin': (p) => (p.tcp ? (p.tcp.flags.includes('F') ? 1 : 0) : undefined),
  'tcp.flags.reset': (p) => (p.tcp ? (p.tcp.flags.includes('R') ? 1 : 0) : undefined),
  'tcp.flags.push': (p) => (p.tcp ? (p.tcp.flags.includes('P') ? 1 : 0) : undefined),
  'tcp.options.mss_val': (p) => p.tcp?.mss,
  'tcp.analysis.flags': (p) => !!p.tcp?.analysis,
  'tcp.analysis.retransmission': (p) => p.tcp?.analysis === 'retransmission',
  'tcp.analysis.duplicate_ack': (p) => p.tcp?.analysis === 'duplicate_ack',
  udp: (p) => !!p.udp,
  'udp.port': (p) => (p.udp ? [p.udp.sport, p.udp.dport] : undefined),
  'udp.srcport': (p) => p.udp?.sport,
  'udp.dstport': (p) => p.udp?.dport,
  icmp: (p) => !!p.icmp,
  'icmp.type': (p) => p.icmp?.type,
  'icmp.code': (p) => p.icmp?.code,
  'icmp.mtu': (p) => p.icmp?.mtu,
  arp: (p) => !!p.arp,
  'arp.opcode': (p) => (p.arp ? (p.arp.op === 'request' ? 1 : 2) : undefined),
  'arp.src.proto_ipv4': (p) => p.arp?.spa,
  'arp.dst.proto_ipv4': (p) => p.arp?.tpa,
  dns: (p) => !!p.dns,
  'dns.qry.name': (p) => p.dns?.qname,
  'dns.qry.type': (p) => (p.dns ? ({ A: 1, NS: 2, PTR: 12, MX: 15, AAAA: 28 } as const)[p.dns.qtype] : undefined),
  'dns.flags.response': (p) => (p.dns ? (p.dns.response ? 1 : 0) : undefined),
  'dns.flags.rcode': (p) => (p.dns?.response ? { NOERROR: 0, SERVFAIL: 2, NXDOMAIN: 3 }[p.dns.rcode] : undefined),
  'dns.a': (p) => (p.dns?.qtype === 'A' ? p.dns.answers : undefined),
  'dns.id': (p) => p.dns?.id,
  dhcp: (p) => !!p.dhcp,
  'dhcp.option.dhcp': (p) => (p.dhcp ? { Discover: 1, Offer: 2, Request: 3, NAK: 6, ACK: 5, Release: 7 }[p.dhcp.type] : undefined),
  'dhcp.ip.your': (p) => p.dhcp?.yiaddr,
  'dhcp.hw.mac_addr': (p) => p.dhcp?.client,
  'dhcp.option.hostname': (p) => p.dhcp?.hostname,
  tls: (p) => !!p.tls,
  'tls.handshake.type': (p) => (p.tls ? p.tls.records.map((r) => (r === 'Client Hello' ? 1 : r === 'Server Hello' ? 2 : r === 'Certificate' ? 11 : 0)).filter(Boolean) : undefined),
  'tls.handshake.extensions_server_name': (p) => p.tls?.sni,
  http: (p) => !!p.http,
  'http.request': (p) => !!p.http?.request,
  'http.response': (p) => !!p.http?.status,
  'http.host': (p) => p.http?.host,
  'http.request.method': (p) => p.http?.request?.split(' ')[0],
  'http.response.code': (p) => (p.http?.status ? Number(p.http.status.split(' ')[1]) : undefined),
}
FIELDS.bootp = FIELDS.dhcp
FIELDS['bootp.option.dhcp'] = FIELDS['dhcp.option.dhcp']

export const DISPLAY_FIELDS = Object.keys(FIELDS)

export function compileDisplay(expr: string): Pred {
  const src = expr.trim()
  if (!src) return () => true
  const toks: string[] = []
  const re = /\s*(&&|\|\||==|!=|>=|<=|>|<|!|=|\(|\)|"(?:[^"\\]|\\.)*"|[A-Za-z0-9_.:/-]+)/y
  let pos = 0
  while (pos < src.length) {
    re.lastIndex = pos
    const m = re.exec(src)
    if (!m) throw new FilterError(`"${src.slice(pos).trim()}" no se entiende acá.`)
    if (m[1]) toks.push(m[1])
    pos = re.lastIndex
    if (/^\s*$/.test(src.slice(pos))) break
  }
  const alias: Record<string, string> = { and: '&&', or: '||', not: '!', eq: '==', ne: '!=', gt: '>', lt: '<', ge: '>=', le: '<=' }
  const T = toks.map((t) => alias[t] ?? t)
  let i = 0
  const peek = () => T[i]
  const next = () => T[i++]
  const fail = (msg: string): never => {
    throw new FilterError(msg)
  }

  function value(raw: string): string | number {
    if (raw.startsWith('"')) return raw.slice(1, -1)
    if (/^\d+$/.test(raw)) return Number(raw)
    if (/^0x[0-9a-f]+$/i.test(raw)) return parseInt(raw, 16)
    return raw
  }

  function cmp(field: string, op: string, v: string | number): Pred {
    const get = FIELDS[field]
    return (p) => {
      const got = get(p)
      if (got === undefined || got === false) return false
      const list = Array.isArray(got) ? got : [got]
      return list.some((x) => {
        if (op === 'contains') return String(x).toLowerCase().includes(String(v).toLowerCase())
        if (typeof v === 'string' && /\/\d+$/.test(v) && typeof x === 'string') return op === '==' ? inNet(x, v) : op === '!=' ? !inNet(x, v) : false
        const a = typeof x === 'boolean' ? (x ? 1 : 0) : x
        const b = v
        if (op === '==') return String(a) === String(b)
        if (op === '!=') return String(a) !== String(b)
        const na = Number(a)
        const nb = Number(b)
        if (op === '>') return na > nb
        if (op === '<') return na < nb
        if (op === '>=') return na >= nb
        if (op === '<=') return na <= nb
        return false
      })
    }
  }

  function primary(): Pred {
    const t = next()
    if (t === undefined) fail('El filtro termina antes de tiempo.')
    if (t === '(') {
      const e = or()
      if (next() !== ')') fail('Falta cerrar un paréntesis.')
      return e
    }
    if (t === '!') {
      const e = primary()
      return (p) => !e(p)
    }
    if (!(t in FIELDS)) {
      const near = DISPLAY_FIELDS.find((f) => f.startsWith(t.split('.')[0] + '.'))
      fail(`"${t}" no es un campo, protocolo o valor válido.${near ? ` ¿Quisiste decir algo como ${near}?` : ''}`)
    }
    const op = peek()
    if (op === '==' || op === '!=' || op === '>' || op === '<' || op === '>=' || op === '<=' || op === 'contains' || op === 'matches') {
      next()
      const raw = next()
      if (raw === undefined) fail(`Falta el valor después de ${op}.`)
      if (op === 'matches') {
        let rx: RegExp
        try {
          rx = new RegExp(String(value(raw)), 'i')
        } catch {
          return fail('La expresión regular no es válida.')
        }
        return (p) => {
          const got = FIELDS[t](p)
          return (Array.isArray(got) ? got : [got]).some((x) => x !== undefined && rx.test(String(x)))
        }
      }
      return cmp(t, op, value(raw))
    }
    if (op === '=') fail('Para comparar se usa == (dos signos igual).')
    const get = FIELDS[t]
    return (p) => {
      const v = get(p)
      return v !== undefined && v !== false && !(Array.isArray(v) && v.length === 0)
    }
  }
  function and(): Pred {
    let l = primary()
    while (peek() === '&&') {
      next()
      const r = primary()
      const a = l
      l = (p) => a(p) && r(p)
    }
    return l
  }
  function or(): Pred {
    let l = and()
    while (peek() === '||') {
      next()
      const r = and()
      const a = l
      l = (p) => a(p) || r(p)
    }
    return l
  }
  const e = or()
  if (i < T.length) fail(`Sobra "${T[i]}": para unir condiciones usá && o ||.`)
  return e
}
