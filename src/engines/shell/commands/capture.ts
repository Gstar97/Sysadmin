/** tcpdump (captura en vivo, -w y -r) y mtr, sobre los escenarios de src/engines/captura. */
import { escenario, type Pkt } from '../../captura/model'
import { compileBpf, FilterError } from '../../captura/filtros'
import { tcpdumpLine } from '../../captura/salida'
import { inSubnet } from '../hosts'
import { register } from '../shell'
import { routeFor } from './net'

const PCAP_MAGIC = 'PCAP:'

/** Un .pcap del simulador: el escenario de origen y el filtro con el que se guardó. */
function readPcap(text: string): { esc: string; filtro: string } | undefined {
  if (!text.startsWith(PCAP_MAGIC)) return undefined
  const [first, ...rest] = text.split('\n')
  const filtro = rest.find((l) => l.startsWith('FILTER:'))?.slice(7) ?? ''
  return { esc: first.slice(PCAP_MAGIC.length).trim(), filtro }
}

function payloadAscii(p: Pkt): string {
  if (!p.payload) return ''
  return '\n' + p.payload.replace(/\r/g, '.').replace(/[^\x20-\x7e\n]/g, '.')
}

register('tcpdump', {
  usage: 'tcpdump [-i interfaz] [-n] [-e] [-v] [-A] [-c cantidad] [-w archivo] [-r archivo] [expresión]',
  summary: '  -i  interfaz (any = todas) · -n  sin resolver nombres · -c  cortar después de N paquetes · -e  mostrar las MAC · -v  más detalle · -A  la carga útil en texto · -w  guardar en un archivo · -r  leer un archivo',
  path: '/usr/sbin',
  run(ctx) {
    const sys = ctx.sys
    let iface: string | undefined
    let count: number | undefined
    let write: string | undefined
    let read: string | undefined
    let e = false
    let v = false
    let ascii = false
    const expr: string[] = []
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i]
      if (a === '-i') iface = ctx.args[++i]
      else if (a === '-c') count = Number(ctx.args[++i])
      else if (a === '-w') write = ctx.args[++i]
      else if (a === '-r') read = ctx.args[++i]
      else if (a === '-D' || a === '--list-interfaces') {
        sys.interfaces.forEach((x, n) => ctx.out(`${n + 1}.${x.name} [${x.up ? 'Up, Running, Connected' : 'Down'}]\n`))
        ctx.out(`${sys.interfaces.length + 1}.any (Pseudo-device that captures on all interfaces) [Up, Running]\n${sys.interfaces.length + 2}.lo [Up, Running, Loopback]\n`)
        return 0
      } else if (/^-[nNeEvAqtlS]+$/.test(a) || a === '-nn' || a === '-vv' || a === '-vvv') {
        if (a.includes('e')) e = true
        if (a.includes('v')) v = true
        if (a.includes('A')) ascii = true
      } else if (/^-c\d+$/.test(a)) count = Number(a.slice(2))
      else if (a === '-s' || a === '-W' || a === '-C' || a === '-G') i++
      else if (a.startsWith('-')) {
        ctx.err(`tcpdump: invalid option -- '${a.replace(/^-+/, '')[0]}'\nusage: tcpdump [-AbdDefhHIJKlLnNOpqStuUvxX#] [ -B size ] [ -c count ] [ -i interface ] [ -r file ] [ -w file ] [ expression ]\n`)
        return 1
      } else expr.push(a)
    }
    let filter
    try {
      filter = compileBpf(expr.join(' '))
    } catch (err) {
      if (err instanceof FilterError) {
        ctx.err(err.message + '\n')
        return 1
      }
      throw err
    }
    const show = (pkts: Pkt[]) => {
      for (const p of pkts) ctx.out(tcpdumpLine(p, { e, v }) + (ascii ? payloadAscii(p) : '') + '\n')
    }
    if (read) {
      let text: string
      try {
        text = sys.vfs.readFile(ctx.sh.resolve(read), ctx.sh.cred)
      } catch {
        ctx.err(`tcpdump: ${read}: No such file or directory\n`)
        return 1
      }
      const pc = readPcap(text)
      const esc = pc ? escenario(pc.esc) : undefined
      if (!pc || !esc) {
        ctx.err(`tcpdump: ${read}: unknown file format\n`)
        return 1
      }
      const base = compileBpf(pc.filtro)
      let pkts = esc.paquetes.filter(base).filter(filter)
      if (count) pkts = pkts.slice(0, count)
      ctx.err(`reading from file ${read}, link-type EN10MB (Ethernet), snapshot length 262144\n`)
      show(pkts)
      return 0
    }
    if (ctx.sh.user !== 'root') {
      ctx.err(`tcpdump: ${iface ?? sys.interfaces[0]?.name ?? 'eth0'}: You don't have permission to perform this capture on that device\n(socket: Operation not permitted)\n`)
      return 1
    }
    const dev = iface ?? sys.interfaces.find((x) => x.up && x.name !== 'lo')?.name ?? 'eth0'
    if (dev !== 'any' && dev !== 'lo' && !sys.interfaces.some((x) => x.name === dev)) {
      ctx.err(`tcpdump: ${dev}: No such device exists\n(No such device exists)\n`)
      return 1
    }
    const esc = sys.traffic ? escenario(sys.traffic) : undefined
    let pkts = esc && dev !== 'lo' ? esc.paquetes.filter(filter) : []
    if (count) pkts = pkts.slice(0, count)
    if (write) {
      ctx.err(`tcpdump: listening on ${dev}, link-type ${dev === 'any' ? 'LINUX_SLL2 (Linux cooked v2)' : 'EN10MB (Ethernet)'}, snapshot length 262144 bytes\n`)
      sys.vfs.writeFile(ctx.sh.resolve(write), `${PCAP_MAGIC}${esc?.id ?? 'vacio'}\nFILTER:${expr.join(' ')}\n`, ctx.sh.cred, { mode: 0o644, umask: ctx.sh.umask })
    } else {
      if (!v) ctx.err('tcpdump: verbose output suppressed, use -v[v]... for full protocol decode\n')
      ctx.err(`listening on ${dev}, link-type ${dev === 'any' ? 'LINUX_SLL2 (Linux cooked v2)' : 'EN10MB (Ethernet)'}, snapshot length 262144 bytes\n`)
      show(pkts)
    }
    if (!count) ctx.out('^C')
    ctx.err(`\n${pkts.length} packet${pkts.length === 1 ? '' : 's'} captured\n${pkts.length} packet${pkts.length === 1 ? '' : 's'} received by filter\n0 packets dropped by kernel\n`)
    if (!count) ctx.err('[simulador] La captura se cortó sola. En un equipo real corre hasta que la cortás con Ctrl+C (o hasta juntar los -c paquetes).\n')
    return 0
  },
})

register('mtr', {
  usage: 'mtr [-r] [-w] [-n] [-c ciclos] destino',
  summary: '  -r  reporte (no interactivo) · -w  nombres completos · -n  sin resolver nombres · -c  cantidad de ciclos',
  path: '/usr/sbin',
  run(ctx) {
    const sys = ctx.sys
    let cycles = 10
    let host: string | undefined
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i]
      if (a === '-c') cycles = Number(ctx.args[++i]) || 10
      else if (/^-[rwnbz]*c$/.test(a)) cycles = Number(ctx.args[++i]) || 10
      else if (a.startsWith('-')) continue
      else host = a
    }
    if (!host) {
      ctx.err('mtr: No destination host given\n')
      return 1
    }
    const ip = sys.resolveHost(host)
    if (!ip) {
      ctx.err(`mtr: Failed to resolve host: ${host}: Name or service not known\n`)
      return 1
    }
    const declared = sys.hops[host] ?? sys.hops[ip]
    let hops: { ip: string; perdida: number; ms: number }[]
    if (declared) hops = declared
    else {
      const r = routeFor(sys, ip)
      if (!r.ok) {
        ctx.err('mtr: Network is unreachable\n')
        return 1
      }
      hops = []
      const remote = sys.remoteNets.find((n) => inSubnet(ip, n.net))
      const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)
      if (r.via) hops.push({ ip: r.via, perdida: 0, ms: 0.5 })
      if (remote) hops.push({ ip: ip.replace(/\d+$/, '1'), perdida: 0, ms: 6 })
      else if (r.via && !isPrivate) hops.push({ ip: '203.0.113.1', perdida: 0, ms: 4.1 }, { ip: '198.51.100.17', perdida: 0, ms: 6.8 }, { ip: '198.51.100.94', perdida: 0, ms: 9.2 })
      const ok = ip === '127.0.0.1' || sys.ownIps().includes(ip) || (remote ? r.via === remote.via : sys.isReachable(ip) || (!isPrivate && sys.internet))
      hops.push(ok ? { ip, perdida: 0, ms: (hops.at(-1)?.ms ?? 0.3) + 1.2 } : { ip: '???', perdida: 100, ms: 0 })
    }
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    ctx.out(`Start: ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}-0300\n`)
    ctx.out(`HOST: ${sys.hostname.padEnd(28)} Loss%   Snt   Last   Avg  Best  Wrst StDev\n`)
    hops.forEach((h, i) => {
      const n = `${String(i + 1).padStart(3)}.|-- ${h.ip.padEnd(26)}`
      if (h.perdida >= 100) {
        ctx.out(`${n} 100.0${String(cycles).padStart(6)}    0.0   0.0   0.0   0.0   0.0\n`)
        return
      }
      const avg = h.ms
      const f = (x: number) => x.toFixed(1).padStart(6)
      ctx.out(`${n}${h.perdida.toFixed(1).padStart(5)}%${String(cycles).padStart(6)}${f(avg * 1.02)}${f(avg)}${f(avg * 0.85)}${f(avg * 1.4)}${f(avg * 0.12)}\n`)
    })
    return 0
  },
})
