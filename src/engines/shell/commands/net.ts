import { compressIpv6, eui64, expandIpv6, ipv6Network } from '../../network/ip'
import { FW_SERVICES, hostByIp, inbound, learnNeighbor, routeTo, sourceIp } from '../hosts'
import type { NetIface, System } from '../system'
import { namedListen, unboundListen } from '../dns'
import { keaListen, dhcpConfigure } from './dnsserver'
import { nginxServe } from '../web'
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
  const r = staticRoute(sys, ip)
  if (r) {
    const dev = up.find((i) => i.name === r.dev && inSubnet(r.via, i.ip!))
    if (dev) return { ok: true, via: r.via, src: dev.ip!.split('/')[0] }
  }
  if (!sys.gateway) return { ok: false, reason: 'no_route' }
  const gwIf = up.find((i) => inSubnet(sys.gateway!, i.ip!))
  if (!gwIf) return { ok: false, reason: 'no_route' }
  return { ok: true, via: sys.gateway, src: gwIf.ip!.split('/')[0] }
}

/** La ruta estática más específica hacia esa IP (las rutas cuyo siguiente salto no está en una red conectada no cuentan). */
function staticRoute(sys: System, ip: string) {
  const up = sys.interfaces.filter((i) => i.up && i.ip)
  return sys.routes
    .filter((r) => inSubnet(ip, r.net) && up.some((i) => i.name === r.dev && inSubnet(r.via, i.ip!)))
    .sort((a, b) => Number(b.net.split('/')[1]) - Number(a.net.split('/')[1]))[0]
}

function canReach(ctx: CommandContext, ip: string): boolean {
  const r = route(ctx, ip)
  if (!r.ok) return false
  if (ctx.sys.ownIps().includes(ip) || ip.startsWith('127.')) return true
  if (r.via && !ctx.sys.isReachable(r.via)) return false
  // Una red de otra sede solo responde si el paquete sale por el router que lleva hasta ella.
  const remote = ctx.sys.remoteNets.find((n) => inSubnet(ip, n.net))
  if (remote) return r.via === remote.via
  return ctx.sys.isReachable(ip)
}

/** Para las verificaciones: si desde ese servidor se llega a la IP siguiendo su tabla de rutas. */
export function reaches(sys: System, ip: string): boolean {
  return canReach({ sys } as CommandContext, ip)
}

/** Lo que dice "ip route": la ruta por defecto, las estáticas y las conectadas. */
function routeLines(sys: System): string {
  let out = ''
  for (const i of sys.interfaces.filter((x) => x.up && x.ip)) {
    if (sys.gateway && inSubnet(sys.gateway, i.ip!)) out += `default via ${sys.gateway} dev ${i.name} proto ${i.dhcp ? 'dhcp' : 'static'} metric 100 \n`
  }
  for (const r of sys.routes) {
    if (!sys.interfaces.some((i) => i.name === r.dev && i.up)) continue
    out += r.nm ? `${r.net} via ${r.via} dev ${r.dev} proto static metric 100 \n` : `${r.net} via ${r.via} dev ${r.dev} \n`
  }
  for (const i of sys.interfaces.filter((x) => x.up && x.ip)) out += `${networkOf(i.ip!)} dev ${i.name} proto kernel scope link src ${i.ip!.split('/')[0]} metric 100 \n`
  return out
}

/** "10.2.0.0/24" o "10.2.0.5" (como /32). Devuelve la red normalizada, o un error si sobran bits de host. */
function parsePrefix(text: string): { net: string } | { error: string } {
  const [ip, p] = text.includes('/') ? text.split('/') : [text, '32']
  const prefix = Number(p)
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || ip.split('.').some((o) => Number(o) > 255) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return { error: `Error: any valid prefix is expected rather than "${text}".\n` }
  const net = networkOf(`${ip}/${prefix}`)
  if (net.split('/')[0] !== ip) return { error: 'Error: Invalid prefix for given prefix length.\n' }
  return { net }
}

/** Dirección IPv6 de enlace local: en Ubuntu sale de la MAC (EUI-64); en Rocky es aleatoria y estable. */
export function linkLocal(sys: System, iface: NetIface): string {
  if (sys.distro === 'ubuntu') return `fe80::${eui64(iface.mac)}`
  let h = 0
  for (const c of iface.mac + sys.hostname) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0
  const g = (n: number) => ((h >>> n) & 0xffff).toString(16)
  return compressIpv6(`fe80:0:0:0:${g(0)}:${g(7)}:${((h * 7) & 0xffff).toString(16)}:${g(13)}`)!
}

/** Todas las IPv6 de una interfaz (las configuradas y la de enlace local), con prefijo. */
export function ipv6List(sys: System, iface: NetIface): string[] {
  if (!iface.up) return iface.ipv6
  return [...iface.ipv6, `${linkLocal(sys, iface)}/64`]
}

function v6Net(cidr: string): string {
  const [a, p] = cidr.split('/')
  return `${ipv6Network(a, Number(p ?? 64))}/${p ?? 64}`
}

function sameV6Net(ip: string, cidr: string): boolean {
  const [, p] = cidr.split('/')
  return ipv6Network(ip, Number(p ?? 64)) === ipv6Network(cidr.split('/')[0], Number(p ?? 64))
}

function maskOf(prefix: number): string {
  const m = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  return [24, 16, 8, 0].map((sh) => (m >>> sh) & 255).join('.')
}

register('ip', {
  usage: 'ip [ OPTIONS ] OBJECT { COMMAND | help }',
  summary: '  ip [-4|-6] [-br] addr [show|add|del|flush]  ip link [show|set DEV up|down|mtu N]  ip route [show|add|del]  ip neigh [show|flush|del]',
  path: '/usr/sbin',
  run(ctx) {
    const brief = ctx.args.includes('-br') || ctx.args.includes('-brief')
    const only6 = ctx.args.includes('-6')
    const only4 = ctx.args.includes('-4')
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
    const devArg = () => {
      const i = args.indexOf('dev')
      return i >= 0 ? args[i + 1] : undefined
    }
    const findIf = (dev?: string) => {
      const iface = sys.interfaces.find((i) => i.name === dev)
      if (!iface) ctx.err(`Cannot find device "${dev ?? ''}"\n`)
      return iface
    }
    if (objName === 'addr' || objName === 'link') {
      if (objName === 'addr' && (cmd === 'add' || cmd === 'del' || cmd === 'delete')) {
        if (needRoot()) return 2
        const cidr = args[2]
        const iface = findIf(devArg())
        if (!iface) return 1
        if (cidr?.includes(':')) {
          const [addr, p] = cidr.split('/')
          if (!expandIpv6(addr) || (p !== undefined && !/^\d+$/.test(p))) {
            ctx.err(`Error: inet6 prefix is expected rather than "${cidr}".\n`)
            return 1
          }
          const norm = `${compressIpv6(addr)}/${p ?? 128}`
          if (cmd === 'add') {
            if (iface.ipv6.includes(norm)) {
              ctx.err('RTNETLINK answers: File exists\n')
              return 2
            }
            iface.ipv6.push(norm)
          } else {
            if (!iface.ipv6.includes(norm)) {
              ctx.err('RTNETLINK answers: Cannot assign requested address\n')
              return 2
            }
            iface.ipv6 = iface.ipv6.filter((x) => x !== norm)
          }
          return 0
        }
        if (cmd === 'add') {
          if (!/^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(cidr ?? '') || cidr!.split('/')[0].split('.').some((o) => Number(o) > 255)) {
            ctx.err(`Error: any valid prefix is expected rather than "${cidr}".\n`)
            return 1
          }
          const full = cidr!.includes('/') ? cidr! : `${cidr}/32`
          if (iface.ip === full) {
            ctx.err('RTNETLINK answers: File exists\n')
            return 2
          }
          iface.ip = full
          iface.dhcp = false
        } else {
          if (cidr && iface.ip && iface.ip.split('/')[0] !== cidr.split('/')[0]) {
            ctx.err('RTNETLINK answers: Cannot assign requested address\n')
            return 2
          }
          iface.ip = undefined
        }
        return 0
      }
      if (objName === 'addr' && cmd === 'flush') {
        if (needRoot()) return 2
        const iface = findIf(devArg() ?? args[2])
        if (!iface) return 1
        if (!only6) iface.ip = undefined
        if (!only4) iface.ipv6 = []
        return 0
      }
      if (cmd === 'set') {
        if (needRoot()) return 2
        const dev = args[2] === 'dev' ? args[3] : args[2]
        const iface = findIf(dev)
        if (!iface) return 1
        if (args.includes('up')) iface.up = true
        if (args.includes('down')) iface.up = false
        const mtu = args.indexOf('mtu')
        if (mtu >= 0) iface.mtu = Number(args[mtu + 1])
        return 0
      }
      const devFilter = devArg() ?? (cmd === 'show' && args[2] ? args[2] : undefined)
      type Row = { name: string; ip?: string; mac: string; up: boolean; mtu: number; v6: string[]; dhcp: boolean }
      const rows: Row[] = [
        { name: 'lo', ip: '127.0.0.1/8', mac: '00:00:00:00:00:00', up: true, mtu: 65536, v6: ['::1/128'], dhcp: false },
        ...sys.interfaces.map((i) => ({ name: i.name, ip: i.ip, mac: i.mac, up: i.up, mtu: i.mtu, v6: ipv6List(sys, i), dhcp: i.dhcp })),
      ].filter((i) => !devFilter || i.name === devFilter)
      if (devFilter && !rows.length) {
        ctx.err(`Device "${devFilter}" does not exist.\n`)
        return 1
      }
      rows.forEach((i, idx) => {
        const state = i.name === 'lo' ? 'UNKNOWN' : i.up ? 'UP' : 'DOWN'
        if (brief) {
          const fl = i.name === 'lo' ? '<LOOPBACK,UP,LOWER_UP>' : i.up ? '<BROADCAST,MULTICAST,UP,LOWER_UP>' : '<BROADCAST,MULTICAST>'
          const addrs = objName === 'link' ? `${i.mac} ${fl}` : [...(only6 ? [] : i.ip ? [i.ip] : []), ...(only4 ? [] : i.v6)].join(' ')
          ctx.out(`${i.name.padEnd(16)} ${state.padEnd(14)} ${addrs}\n`)
          return
        }
        if (objName === 'addr' && only6 && !i.v6.length) return
        if (objName === 'addr' && only4 && !i.ip) return
        const flags = i.name === 'lo' ? '<LOOPBACK,UP,LOWER_UP>' : i.up ? '<BROADCAST,MULTICAST,UP,LOWER_UP>' : '<BROADCAST,MULTICAST>'
        ctx.out(`${idx + 1}: ${i.name}: ${flags} mtu ${i.mtu} qdisc ${i.name === 'lo' ? 'noqueue' : 'fq_codel'} state ${state} group default qlen 1000\n`)
        if (!only6 && !only4) ctx.out(`    link/${i.name === 'lo' ? 'loopback' : 'ether'} ${i.mac} brd ${i.name === 'lo' ? '00:00:00:00:00:00' : 'ff:ff:ff:ff:ff:ff'}\n`)
        if (objName !== 'addr') return
        if (i.ip && !only6) {
          if (i.name === 'lo') ctx.out('    inet 127.0.0.1/8 scope host lo\n       valid_lft forever preferred_lft forever\n')
          else {
            const prefix = Number(i.ip.split('/')[1])
            const brd = prefix < 31 ? ` brd ${broadcastOf(i.ip)}` : ''
            ctx.out(`    inet ${i.ip}${brd} scope global ${i.dhcp ? 'dynamic ' : ''}noprefixroute ${i.name}\n       valid_lft ${i.dhcp ? '3596sec' : 'forever'} preferred_lft ${i.dhcp ? '3596sec' : 'forever'}\n`)
          }
        }
        if (!only4) {
          for (const v of i.v6) {
            const scope = v.startsWith('::1') ? 'host' : v.startsWith('fe80') ? 'link' : 'global'
            ctx.out(`    inet6 ${v} scope ${scope}${scope === 'host' ? ' noprefixroute' : scope === 'link' ? ' noprefixroute' : ' noprefixroute'} \n       valid_lft forever preferred_lft forever\n`)
          }
        }
      })
      return 0
    }
    if (objName === 'route') {
      if (cmd === 'get') {
        const ip = args[2]
        if (!ip) {
          ctx.err('Command line is not complete. Try option "help"\n')
          return 1
        }
        const r = route(ctx, ip)
        if (!r.ok) {
          ctx.err('RTNETLINK answers: Network is unreachable\n')
          return 2
        }
        const dev = sys.interfaces.find((i) => i.up && i.ip && inSubnet(r.via ?? ip, i.ip))?.name ?? 'lo'
        ctx.out(`${ip} ${r.via ? `via ${r.via} ` : ''}dev ${dev} src ${r.src} uid ${ctx.sh.user === 'root' ? 0 : 1000} \n    cache \n`)
        return 0
      }
      if ((cmd === 'add' || cmd === 'del' || cmd === 'replace' || cmd === 'delete') && args[2] && args[2] !== 'default') {
        if (needRoot()) return 2
        const pr = parsePrefix(args[2])
        if ('error' in pr) {
          ctx.err(pr.error)
          return 1
        }
        const existing = sys.routes.findIndex((r) => r.net === pr.net)
        if (cmd === 'del' || cmd === 'delete') {
          if (existing < 0) {
            ctx.err('RTNETLINK answers: No such process\n')
            return 2
          }
          sys.routes.splice(existing, 1)
          return 0
        }
        const vi = args.indexOf('via')
        const via = vi >= 0 ? args[vi + 1] : undefined
        if (!via) {
          ctx.err('Error: either "to" is duplicate, or "via" is a garbage.\n')
          return 1
        }
        const dev = sys.interfaces.find((i) => i.up && i.ip && inSubnet(via, i.ip) && (!devArg() || i.name === devArg()))
        if (devArg() && !sys.interfaces.some((i) => i.name === devArg())) {
          ctx.err(`Cannot find device "${devArg()}"\n`)
          return 1
        }
        if (!dev) {
          ctx.err('Error: Nexthop has invalid gateway.\n')
          return 2
        }
        if (existing >= 0 && cmd === 'add') {
          ctx.err('RTNETLINK answers: File exists\n')
          return 2
        }
        if (existing >= 0) sys.routes.splice(existing, 1)
        sys.routes.push({ net: pr.net, via, dev: dev.name, nm: false })
        sys.reachable.add(via)
        return 0
      }
      if (cmd === 'add' || cmd === 'del' || cmd === 'replace' || cmd === 'delete') {
        if (needRoot()) return 2
        if (args[2] === 'default') {
          if (cmd === 'del' || cmd === 'delete') sys.gateway = undefined
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
      if (only6) {
        for (const i of sys.interfaces.filter((x) => x.up)) for (const v of ipv6List(sys, i)) ctx.out(`${v.startsWith('fe80') ? 'fe80::/64' : v6Net(v)} dev ${i.name} proto kernel metric ${v.startsWith('fe80') ? 1024 : 100} pref medium\n`)
        ctx.out('::1 dev lo proto kernel metric 256 pref medium\n')
        return 0
      }
      ctx.out(routeLines(sys))
      return 0
    }
    if (objName === 'neigh') {
      if (cmd === 'flush' || cmd === 'del' || cmd === 'delete') {
        if (needRoot()) return 2
        if (cmd === 'flush') sys.neigh.clear()
        else if (!sys.neigh.delete(args[2] ?? '')) {
          ctx.err('RTNETLINK answers: No such file or directory\n')
          return 2
        }
        return 0
      }
      if (!sys.neigh.size && sys.gateway && sys.isReachable(sys.gateway)) learnNeighbor(sys, sys.gateway)
      for (const [ip, n] of sys.neigh) {
        if ((only6 && !ip.includes(':')) || (only4 && ip.includes(':'))) continue
        ctx.out(n.state === 'FAILED' ? `${ip} dev ${n.dev} FAILED \n` : `${ip} dev ${n.dev} lladdr ${n.mac} ${n.state} \n`)
      }
      return 0
    }
    ctx.err(`Object "${obj}" is unknown, try "ip help".\n`)
    return 1
  },
})

/** ping a una IPv6: responde quien tenga esa dirección en una red /64 compartida (o de enlace local). */
function ping6(ctx: CommandContext, host: string, count: number, quiet: boolean): number {
  const sys = ctx.sys
  const [addrRaw, zone] = host.split('%')
  const addr = compressIpv6(addrRaw)
  if (!addr) {
    ctx.err(`ping: ${host}: Name or service not known\n`)
    return 2
  }
  const mine = sys.interfaces.flatMap((i) => ipv6List(sys, i).map((c) => ({ i, c })))
  const isLL = addr.startsWith('fe80')
  if (isLL && !zone) {
    ctx.err(`ping: Warning: IPv6 link-local address on ICMP datagram socket may require ifname or scope-id => use: address%<ifname|scope-id>\nping: connect: Invalid argument\n`)
    return 2
  }
  const own = addr === '::1' || mine.some((m) => m.c.split('/')[0] === addr)
  const via = mine.find((m) => (isLL ? m.i.name === zone : !m.c.startsWith('fe80') && sameV6Net(addr, m.c)))
  if (!own && !via) {
    ctx.err('ping: connect: Network is unreachable\n')
    return 2
  }
  const target = own ? sys : sys.lab.find((h) => h.interfaces.some((i) => ipv6List(h, i).some((c) => c.split('/')[0] === addr)))
  const ok = own || !!target
  // NDP: el vecino queda en la tabla, igual que con ARP en IPv4.
  if (target && target !== sys && via) {
    const mac = target.interfaces.find((i) => ipv6List(target, i).some((c) => c.split('/')[0] === addr))?.mac
    if (mac) sys.neigh.set(addr, { mac, dev: via.i.name, state: 'REACHABLE' })
  } else if (!own && via) sys.neigh.set(addr, { mac: '', dev: via.i.name, state: 'FAILED' })
  ctx.out(`PING ${host} (${addr}) 56 data bytes\n`)
  for (let n = 1; n <= count; n++) {
    if (ok) {
      if (!quiet) ctx.out(`64 bytes from ${addr}${zone ? `%${zone}` : ''}: icmp_seq=${n} ttl=64 time=${(own ? 0.03 : 0.5 + Math.random() * 0.2).toFixed(3)} ms\n`)
    } else if (!quiet) ctx.out(`From ${via!.c.split('/')[0]} icmp_seq=${n} Destination unreachable: Address unreachable\n`)
  }
  ctx.out(`\n--- ${host} ping statistics ---\n${count} packets transmitted, ${ok ? count : 0} received, ${ok ? '' : `+${count} errors, `}${ok ? 0 : 100}% packet loss, time ${(count - 1) * 1001}ms\n`)
  return ok ? 0 : 1
}

register(['ping', 'ping6'], {
  usage: 'ping [-4|-6] [-c count] [-i interval] destination',
  async run(ctx) {
    const a = parseArgs(ctx.args, { flags: { q: ['q'], n: ['n'], '4': ['4'], '6': ['6'] }, values: { c: ['c'], i: ['i'], W: ['W'], w: ['w'] } })
    const host = a.rest[0]
    if (!host) {
      ctx.err('ping: usage error: Destination address required\n')
      return 2
    }
    const count = a.values.has('c') ? Number(a.values.get('c')) : 4
    if (host.includes(':') || ctx.name === 'ping6' || ctx.args.includes('-6')) return ping6(ctx, host, count, a.flags.has('q'))
    const ip = ctx.sys.resolveHost(host)
    if (!ip) {
      ctx.err(`ping: ${host}: Name or service not known\n`)
      return 2
    }
    learnNeighbor(ctx.sys, ip)
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
        // Un equipo de otra sede está a dos routers (ttl 64 - 2); internet, a muchos más.
        const ttl = !r.via ? 64 : ctx.sys.remoteNets.some((n) => inSubnet(ip, n.net)) ? 62 : 116
        if (!a.flags.has('q')) ctx.out(`64 bytes from ${ip}: icmp_seq=${i} ttl=${ttl} time=${t} ms\n`)
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
    // Los DNS y Kea escuchan en direcciones concretas: se ven en ss tal como están configurados.
    const addrs = s.name === 'named' ? namedListen(ctx.sys) : s.name === 'unbound' ? unboundListen(ctx.sys) : s.name.startsWith('kea-dhcp4') ? keaListen(ctx.sys) : undefined
    if (addrs) {
      for (const ad of addrs) {
        if (s.name.startsWith('kea')) out.push({ proto: 'udp', local: ad, port: 67, proc: 'kea-dhcp4', pid: s.pid ?? 1 })
        else for (const proto of ['udp', 'tcp']) out.push({ proto, local: ad, port: 53, proc: s.name, pid: s.pid ?? 1 })
      }
      if (s.name === 'named') out.push({ proto: 'tcp', local: '127.0.0.1', port: 953, proc: 'named', pid: s.pid ?? 1 })
      continue
    }
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
      const v6 = ipv6List(ctx.sys, i).map((c) => `        inet6 ${c.split('/')[0]}  prefixlen ${c.split('/')[1]}  scopeid ${c.startsWith('fe80') ? '0x20<link>' : '0x0<global>'}\n`).join('')
      ctx.out(`${i.name}: flags=${i.up ? '4163<UP,BROADCAST,RUNNING,MULTICAST>' : '4098<BROADCAST,MULTICAST>'}  mtu ${i.mtu}\n${i.ip ? `        inet ${i.ip.split('/')[0]}  netmask ${maskOf(Number(i.ip.split('/')[1]))}  broadcast ${broadcastOf(i.ip)}\n` : ''}${v6}        ether ${i.mac}  txqueuelen 1000  (Ethernet)\n\n`)
    }
    ctx.out('lo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536\n        inet 127.0.0.1  netmask 255.0.0.0\n\n')
    return 0
  },
})

function localWebContent(ctx: CommandContext, port: number, path = '/', sys = ctx.sys): { status: number; body: string; server: string } | undefined {
  const svc = [...sys.services.values()].find((s) => s.active && s.ports.includes(port))
  if (!svc) return undefined
  if (svc.name === 'nginx') return nginxServe(sys, port, path)
  const candidates = ['/var/www/html/index.html']
  for (const c of candidates) {
    if (sys.vfs.exists(c)) return { status: 200, body: sys.vfs.readFile(c, ROOT_CRED), server: 'Apache/2.4.63' }
  }
  return { status: 403, body: '<html><head><title>403 Forbidden</title></head><body><h1>403 Forbidden</h1></body></html>\n', server: 'Apache/2.4.63' }
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
    learnNeighbor(ctx.sys, ip)
    const remote = hostByIp(ctx.sys, ip)
    if (remote && remote !== ctx.sys) {
      const failed = (why: string, code: number) => {
        ctx.err(ctx.name === 'wget' ? `Connecting to ${host} (${host})|${ip}|:${port}... failed: ${why}.\n` : code === 28 ? `curl: (28) Failed to connect to ${host} port ${port} after 3002 ms: Timeout was reached\n` : `curl: (7) Failed to connect to ${host} port ${port} after 1 ms: ${why === 'Connection refused' ? "Couldn't connect to server" : why}\n`)
        return ctx.name === 'wget' ? 4 : code
      }
      if (!routeTo(ctx.sys, ip)) return failed('Connection timed out', 28)
      const fw = inbound(remote, port, 'tcp', sourceIp(ctx.sys, ip))
      if (fw === 'reject') return failed('No route to host', 7)
      if (fw === 'drop') return failed('Connection timed out', 28)
      res = localWebContent(ctx, port, m[4] ?? '/', remote)
      if (!res) return failed('Connection refused', 7)
    } else if (ip.startsWith('127.') || ctx.sys.ownIps().includes(ip)) {
      res = localWebContent(ctx, port, m[4] ?? '/')
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
      ctx.sys.vfs.writeFile(ctx.sh.resolve(file), res.body, ctx.sh.cred, { mode: 0o666, umask: ctx.sh.umask })
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
      ctx.sys.vfs.writeFile(ctx.sh.resolve(a.values.get('o')!), res.body, ctx.sh.cred, { mode: 0o666, umask: ctx.sh.umask })
      if (!a.flags.has('s')) ctx.err(`  % Total    % Received % Xferd  Average Speed   Time\n100  ${res.body.length}  100  ${res.body.length}    0     0   ${res.body.length * 10}      0 --:--:--\n`)
      return 0
    }
    ctx.out(res.body)
    return 0
  },
})


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
        {
          // Como ufw: cada regla sin origen tiene también su versión para IPv6.
          const rows: { to: string; action: string; from: string }[] = []
          const v6: typeof rows = []
          for (const r of u.rules) {
            const m = /^(?:proto (tcp|udp) )?from (\S+)(?: to any)?(?: port (\d+))?(?: proto (tcp|udp))?$/i.exec(r.target)
            const action = r.action.toUpperCase()
            if (m) rows.push({ to: m[3] ? `${m[3]}${m[1] ?? m[4] ? `/${m[1] ?? m[4]}` : ''}` : 'Anywhere', action, from: m[2] === 'any' ? 'Anywhere' : m[2] })
            else {
              rows.push({ to: r.target, action, from: 'Anywhere' })
              v6.push({ to: `${r.target} (v6)`, action, from: 'Anywhere (v6)' })
            }
          }
          ;[...rows, ...(rest[0] === 'numbered' ? [] : v6)].forEach((r, i) => ctx.out(`${rest[0] === 'numbered' ? `[${String(i + 1).padStart(2)}] ` : ''}${r.to.padEnd(26)} ${r.action.padEnd(11)} ${r.from}\n`))
        }
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
      case 'app':
        if (rest[0] === 'list') {
          ctx.out(`Available applications:\n  OpenSSH\n${ctx.sys.installed.has('nginx') ? '  Nginx Full\n  Nginx HTTP\n  Nginx HTTPS\n' : ''}${ctx.sys.installed.has('apache2') ? '  Apache\n  Apache Full\n  Apache Secure\n' : ''}`)
          return 0
        }
        ctx.err('ERROR: Invalid syntax\n')
        return 1
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
          ctx.out(`connection.id:                          ${i.name}\nconnection.interface-name:              ${i.name}\nipv4.method:                            ${i.dhcp ? 'auto' : 'manual'}\nipv4.addresses:                         ${i.ip ?? '--'}\nipv4.gateway:                           ${sys.gateway ?? '--'}\nipv4.routes:                            ${sys.routes.filter((r) => r.dev === i.name && r.nm).map((r) => `{ ip = ${r.net}, nh = ${r.via} }`).join('; ') || '--'}\nipv4.dns:                               ${sys.dns.join(',') || '--'}\n`)
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
          else if (key === 'ipv4.routes') {
            const list: { net: string; via: string }[] = []
            for (const part of val.split(',').map((x) => x.trim()).filter(Boolean)) {
              const [netText, via] = part.split(/\s+/)
              const pr = parsePrefix(netText ?? '')
              if ('error' in pr || !via) {
                ctx.err(`Error: failed to modify ipv4.routes: invalid route: ${part}.\n`)
                return 2
              }
              list.push({ net: pr.net, via })
            }
            pending.routes = list
            pending.addRoutes = props[i].startsWith('+')
          }
          else if (key === 'ipv4.method') {
            if (!['auto', 'manual', 'disabled', 'link-local', 'shared'].includes(val)) {
              ctx.err(`Error: failed to modify ipv4.method: '${val}' not among [auto, link-local, manual, shared, disabled].\n`)
              return 2
            }
            pending.method = val
          } else if (key === 'ipv6.addresses') pending.ipv6 = val.split(/[ ,]+/).filter(Boolean)
          else if (key === 'ipv6.method' || key === 'connection.autoconnect' || key === 'ipv6.gateway') continue
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
        if (p?.method === 'auto') iface.dhcp = true
        if (p?.method === 'manual') iface.dhcp = false
        if (p?.ipv6) iface.ipv6 = p.ipv6.map((x) => (x.includes('/') ? x : `${x}/64`))
        if (iface.dhcp && !p?.address) {
          sys.nmPending.delete(name!)
          if (!dhcpConfigure(sys, iface.name)) {
            ctx.err(`Error: Connection activation failed: IP configuration could not be reserved (no available address, timeout, etc.)\nHint: use 'journalctl -xe NM_CONNECTION=3c1f0d2a-8b4e-4f6a-9e21-6d0b7a5c4e19 + NM_DEVICE=${iface.name}' to get more details.\n`)
            sys.log('NetworkManager.service', `<warn>  [${(Date.now() / 1000).toFixed(4)}] dhcp4 (${iface.name}): request timed out`, 4)
            return 4
          }
          ctx.out(`Connection successfully activated (D-Bus active path: /org/freedesktop/NetworkManager/ActiveConnection/${sys.interfaces.indexOf(iface) + 2})\n`)
          return 0
        }
        if (p?.address) iface.ip = p.address
        if (p?.routes) {
          sys.routes = sys.routes.filter((r) => !(r.dev === iface.name && r.nm && !p.addRoutes))
          for (const r of p.routes) {
            sys.routes = sys.routes.filter((x) => x.net !== r.net)
            sys.routes.push({ net: r.net, via: r.via, dev: iface.name, nm: true })
            sys.reachable.add(r.via)
          }
        }
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
      ctx.out(` ${hop++}  ${gwOk ? `${r.via === ctx.sys.gateway ? '_gateway' : r.via} (${r.via})  0.512 ms  0.487 ms  0.455 ms` : '* * *'}\n`)
      if (!gwOk) {
        for (; hop <= 4; hop++) ctx.out(` ${hop}  * * *\n`)
        return 0
      }
    }
    const remote = ctx.sys.remoteNets.find((n) => inSubnet(ip, n.net))
    if (remote && canReach(ctx, ip)) {
      const gw = networkOf(remote.net).split('/')[0].replace(/\d+$/, (x) => String(Number(x) + 1))
      ctx.out(` ${hop++}  ${gw} (${gw})  6.204 ms  6.117 ms  6.088 ms\n`)
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
    const remote = local ? undefined : hostByIp(ctx.sys, ip)
    let why = 'Connection refused'
    let open: boolean
    if (local) open = [...ctx.sys.services.values()].some((s) => s.active && s.ports.includes(port))
    else if (remote) {
      const fw = routeTo(ctx.sys, ip) ? inbound(remote, port, 'tcp', sourceIp(ctx.sys, ip)) : 'drop'
      open = fw === 'ok' && [...remote.services.values()].some((s) => s.active && s.ports.includes(port))
      if (fw === 'reject') why = 'No route to host'
      if (fw === 'drop') why = 'Connection timed out'
    } else open = canReach(ctx, ip)
    if (open) ctx.err(`Connection to ${host} (${ip}) ${port} port [tcp/*] succeeded!\n`)
    else ctx.err(`nc: connect to ${host} (${ip}) port ${port} (tcp) failed: ${why}\n`)
    return open ? 0 : 1
  },
})
