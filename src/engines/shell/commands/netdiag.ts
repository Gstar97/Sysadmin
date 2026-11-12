/** Herramientas de capa 2 y de direccionamiento: arping, ethtool, ipcalc y named -v. */
import { inSubnet, macOf } from '../hosts'
import { register } from '../shell'

function ipNum(ip: string): number {
  return ip.split('.').reduce((a, b) => a * 256 + Number(b), 0)
}
function numIp(n: number): string {
  return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.')
}
function validIp(ip: string) {
  const p = ip.split('.')
  return p.length === 4 && p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255)
}

register('arping', {
  usage: 'arping [-D] [-c count] -I interface destination',
  path: '/usr/sbin',
  run(ctx) {
    const sys = ctx.sys
    let count = 3
    let dad = false
    let ifName: string | undefined
    let target: string | undefined
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i]
      if (a === '-c') count = Number(ctx.args[++i])
      else if (a === '-D') dad = true
      else if (a === '-I') ifName = ctx.args[++i]
      else if (!a.startsWith('-')) target = a
    }
    if (!target) {
      ctx.err('arping: usage error: Destination address required\n')
      return 2
    }
    if (ctx.sh.user !== 'root') {
      ctx.err('arping: socket: Operation not permitted\n')
      return 2
    }
    const iface = ifName ? sys.interfaces.find((i) => i.name === ifName) : sys.interfaces.find((i) => i.up && i.ip && inSubnet(target!, i.ip))
    if (!iface) {
      ctx.err(ifName ? `arping: Device ${ifName} not available.\n` : 'arping: Suitable device could not be determined. Please, use option -I.\n')
      return 2
    }
    if (dad) count = ctx.args.includes('-c') ? count : 1
    const owners = sys.lab.filter((h) => h.ownIps().includes(target!))
    const src = dad ? '0.0.0.0' : (iface.ip?.split('/')[0] ?? '0.0.0.0')
    ctx.out(`ARPING ${target} from ${src} ${iface.name}\n`)
    let received = 0
    const sameNet = !iface.ip || inSubnet(target, iface.ip) || dad
    for (let n = 0; n < count && sameNet; n++) {
      // Con una IP duplicada contestan todos los que la tienen.
      for (const h of owners) {
        ctx.out(`Unicast reply from ${target} [${macOf(h, target)!.toUpperCase()}]  ${(0.5 + ((n * 13 + h.hostname.length) % 7) / 10).toFixed(3)}ms\n`)
        received++
        if (dad) break
      }
      // Un equipo "alcanzable" del ejercicio (sin máquina propia) también contesta, con una MAC fija.
      if (!owners.length && sys.reachable.has(target) && !sys.ownIps().includes(target)) {
        const tail = target.split('.').map((x) => Number(x).toString(16).padStart(2, '0'))
        ctx.out(`Unicast reply from ${target} [52:54:00:${tail[1]}:${tail[2]}:${tail[3]}]  ${(0.5 + n / 10).toFixed(3)}ms\n`.replace(/\[([^\]]+)\]/, (m) => m.toUpperCase()))
        received++
      }
      if (dad && received) break
    }
    ctx.out(`Sent ${dad && received ? 1 : count} probes (${dad && received ? 1 : count} broadcast(s))\nReceived ${received} response(s)\n`)
    if (dad) return received ? 1 : 0
    return received ? 0 : 1
  },
})

register('ethtool', {
  usage: 'ethtool DEVNAME',
  path: '/usr/sbin',
  run(ctx) {
    const name = ctx.args.find((a) => !a.startsWith('-'))
    const iface = ctx.sys.interfaces.find((i) => i.name === name)
    if (!name) {
      ctx.err('ethtool: bad command line argument(s)\nFor more information run ethtool -h\n')
      return 1
    }
    if (!iface) {
      ctx.err(`netlink error: no device matches name (offset 24)\nnetlink error: No such device\n`)
      return 1
    }
    if (ctx.args.includes('-s')) {
      // ethtool -s DEV [speed N] [duplex half|full] [autoneg on|off]: cambia la negociación (sin salida si anda).
      if (ctx.sh.user !== 'root') {
        ctx.err('netlink error: Operation not permitted\n')
        return 1
      }
      const val = (k: string) => {
        const i = ctx.args.indexOf(k)
        return i >= 0 ? ctx.args[i + 1] : undefined
      }
      const speed = val('speed')
      const duplex = val('duplex')
      const autoneg = val('autoneg')
      if (autoneg === 'on') {
        // Con los dos lados en automático, negocian lo mejor que tienen en común.
        iface.autoneg = true
        iface.speed = 1000
        iface.duplex = 'full'
      } else {
        if (autoneg === 'off') iface.autoneg = false
        if (speed) iface.speed = Number(speed)
        if (duplex === 'half' || duplex === 'full') iface.duplex = duplex
      }
      return 0
    }
    const up = iface.up
    const modes = ['10baseT/Half 10baseT/Full', '100baseT/Half 100baseT/Full', '1000baseT/Full']
    ctx.out(`Settings for ${iface.name}:\n\tSupported ports: [ TP ]\n\tSupported link modes:   ${modes.join('\n\t                        ')}\n\tSupported pause frame use: No\n\tSupports auto-negotiation: Yes\n\tAdvertised link modes:  ${iface.autoneg ? modes.join('\n\t                        ') : 'Not reported'}\n\tAdvertised auto-negotiation: ${iface.autoneg ? 'Yes' : 'No'}\n`)
    ctx.out(`\tSpeed: ${up ? `${iface.speed}Mb/s` : 'Unknown!'}\n\tDuplex: ${up ? (iface.duplex === 'full' ? 'Full' : 'Half') : 'Unknown! (255)'}\n\tAuto-negotiation: ${iface.autoneg ? 'on' : 'off'}\n\tPort: Twisted Pair\n\tPHYAD: 0\n\tTransceiver: internal\n\tMDI-X: off (auto)\n`)
    if (ctx.sh.user !== 'root') ctx.out('\tCannot get wake-on-lan settings: Operation not permitted\n')
    else ctx.out('\tSupports Wake-on: umbg\n\tWake-on: d\n\tCurrent message level: 0x00000007 (7)\n\t\t\t       drv probe link\n')
    ctx.out(`\tLink detected: ${up ? 'yes' : 'no'}\n`)
    return 0
  },
})

function kindOf(ip: number): { rocky: string; ubuntu: string } {
  const inR = (net: string, p: number) => Math.floor(ip / 2 ** (32 - p)) === Math.floor(ipNum(net) / 2 ** (32 - p))
  if (inR('10.0.0.0', 8) || inR('172.16.0.0', 12) || inR('192.168.0.0', 16)) return { rocky: 'Private Use', ubuntu: 'Private Internet' }
  if (inR('127.0.0.0', 8)) return { rocky: 'Loopback', ubuntu: 'Loopback' }
  if (inR('169.254.0.0', 16)) return { rocky: 'Link Local', ubuntu: 'Link Local' }
  if (inR('100.64.0.0', 10)) return { rocky: 'Shared Address Space', ubuntu: 'Shared Address Space' }
  if (inR('224.0.0.0', 4)) return { rocky: 'Multicast', ubuntu: 'Multicast' }
  if (inR('192.0.2.0', 24) || inR('198.51.100.0', 24) || inR('203.0.113.0', 24)) return { rocky: 'Documentation', ubuntu: 'Documentation' }
  return { rocky: 'Internet', ubuntu: 'Internet' }
}

register('ipcalc', {
  usage: 'ipcalc ADDRESS[/PREFIX] [NETMASK]',
  path: '/usr/bin',
  run(ctx) {
    const words = ctx.args.filter((a) => !a.startsWith('-'))
    let [addr, maskArg] = words
    if (!addr) {
      ctx.err('ipcalc: ip address expected\n')
      return 1
    }
    let prefix = 24
    if (addr.includes('/')) {
      const [a, p] = addr.split('/')
      addr = a
      if (validIp(p)) maskArg = p
      else prefix = Number(p)
    }
    if (maskArg) {
      const m = ipNum(maskArg)
      const bits = m.toString(2).padStart(32, '0')
      if (!validIp(maskArg) || /01/.test(bits)) {
        ctx.err(`ipcalc: bad netmask: ${maskArg}\n`)
        return 1
      }
      prefix = bits.indexOf('0') < 0 ? 32 : bits.indexOf('0')
    }
    if (!validIp(addr) || !(prefix >= 0 && prefix <= 32)) {
      ctx.err(`ipcalc: bad IPv4 address: ${words[0]}\n`)
      return 1
    }
    const ip = ipNum(addr)
    const size = 2 ** (32 - prefix)
    const net = Math.floor(ip / size) * size
    const bcast = net + size - 1
    const mask = numIp(2 ** 32 - size)
    const hosts = prefix >= 31 ? size : size - 2
    const first = prefix >= 31 ? net : net + 1
    const last = prefix >= 31 ? bcast : bcast - 1
    if (ctx.sys.distro === 'rocky') {
      ctx.out(`Address:\t${addr}\nNetwork:\t${numIp(net)}/${prefix}\nNetmask:\t${mask} = ${prefix}\n${prefix < 31 ? `Broadcast:\t${numIp(bcast)}\n` : ''}\nAddress space:\t${kindOf(ip).rocky}\nHostMin:\t${numIp(first)}\nHostMax:\t${numIp(last)}\nHosts/Net:\t${hosts}\n`)
      return 0
    }
    // ipcalc de Debian/Ubuntu: muestra el binario con un espacio donde termina la red.
    const bin = (n: number) => {
      const b = n.toString(2).padStart(32, '0')
      const dotted = b.match(/.{8}/g)!.join('.')
      const cut = prefix + Math.floor(Math.min(prefix, 31) / 8)
      return prefix === 32 ? dotted : `${dotted.slice(0, cut)} ${dotted.slice(cut)}`
    }
    const cls = ip < ipNum('128.0.0.0') ? 'A' : ip < ipNum('192.0.0.0') ? 'B' : ip < ipNum('224.0.0.0') ? 'C' : ip < ipNum('240.0.0.0') ? 'D' : 'E'
    const row = (k: string, v: string, n: number) => `${k.padEnd(11)}${v.padEnd(21)}${bin(n)}\n`
    ctx.out(
      row('Address:', addr, ip) +
        row('Netmask:', `${mask} = ${prefix}`, 2 ** 32 - size) +
        row('Wildcard:', numIp(size - 1), size - 1) +
        '=>\n' +
        row('Network:', `${numIp(net)}/${prefix}`, net) +
        row('HostMin:', numIp(first), first) +
        row('HostMax:', numIp(last), last) +
        (prefix < 31 ? row('Broadcast:', numIp(bcast), bcast) : '') +
        `${'Hosts/Net:'.padEnd(11)}${String(hosts).padEnd(21)}Class ${cls}${kindOf(ip).ubuntu === 'Internet' ? '' : `, ${kindOf(ip).ubuntu}`}\n\n`,
    )
    return 0
  },
})

register('named', {
  usage: 'named -v',
  path: '/usr/sbin',
  run(ctx) {
    if (ctx.args.includes('-v') || ctx.args.includes('-V')) {
      ctx.out(`BIND ${ctx.sys.distro === 'rocky' ? '9.18.33-RH' : '9.18.30-0ubuntu0.24.04.2-Ubuntu'} (Extended Support Version) <id:>\n`)
      return 0
    }
    ctx.err('[simulador] named se maneja como servicio: systemctl start named.\n')
    return 1
  },
})
