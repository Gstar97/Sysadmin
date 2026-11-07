/**
 * DNS y DHCP del lado del servidor y del cliente: dig, nslookup y host contra el DNS del
 * laboratorio; named-checkconf, named-checkzone, rndc y unbound-checkconf; Kea DHCPv4
 * (kea-dhcp4 -t, el servicio y los préstamos que reciben los clientes).
 */
import { checkzoneOutput, parseZone } from '../../config/zone'
import { parseKea, cidrRange, type KeaConfig } from '../../config/kea'
import { nameservers, namedActive, namedStart, query, readNamedConfig, loadZones, readUnboundConfig, systemResolve, unboundConfPaths, unboundStart, type DnsAnswer, type RR } from '../dns'
import { register, type CommandContext } from '../shell'
import { System } from '../system'
import { ROOT_CRED } from '../vfs'
import { SERVICE_CHECKS } from './sysinfo'

System.resolver = systemResolve

const VERSION = (sys: System) => (sys.distro === 'rocky' ? '9.18.33' : '9.18.30-0ubuntu0.24.04.2-Ubuntu')

function digWhen(): string {
  const d = new Date()
  const [wd, , mon] = [d.toUTCString().slice(0, 3), 0, d.toUTCString().slice(8, 11)]
  return `${wd} ${mon} ${String(d.getUTCDate()).padStart(2, '0')} ${d.toISOString().slice(11, 19)} UTC ${d.getUTCFullYear()}`
}

function reverseName(ip: string): string {
  return `${ip.split('.').reverse().join('.')}.in-addr.arpa`
}

function rrLine(r: RR): string {
  const name = r.name.length < 16 ? `${r.name}\t` : r.name
  return `${name}\t${r.ttl}\tIN\t${r.type}\t${r.data}`
}

function commError(server: string, e: NonNullable<DnsAnswer['error']>): string {
  const why = e === 'timeout' ? 'timed out' : e === 'refused' ? 'connection refused' : 'host unreachable'
  return `;; communications error to ${server}#53: ${why}`
}

/** Prueba los nameserver en orden, como hace el cliente. */
function ask(ctx: CommandContext, server: string | undefined, name: string, type: string): { r?: DnsAnswer; errors: string[] } {
  const list = server ? [server] : nameservers(ctx.sys)
  const errors: string[] = []
  if (!list.length) list.push('127.0.0.1')
  for (const s of list.slice(0, 3)) {
    const ip = ctx.sys.resolveHost(s) ?? s
    const r = query(ctx.sys, ip, name, type)
    if (!r.error) return { r, errors }
    // dig reintenta tres veces con cada servidor antes de rendirse.
    for (let i = 0; i < (e2n(r.error)); i++) errors.push(commError(ip, r.error))
  }
  return { errors }
}
const e2n = (e: string) => (e === 'timeout' ? 3 : 1)

register('dig', {
  usage: 'dig [@server] [-x addr] [-t type] name [type] [+short] [+noall +answer] [+norecurse]',
  path: '/usr/bin',
  run(ctx) {
    let server: string | undefined
    let type: string | undefined
    let name: string | undefined
    const plus = new Set<string>()
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i]
      if (a.startsWith('@')) server = a.slice(1)
      else if (a === '-x') name = reverseName(ctx.args[++i] ?? '')
      else if (a === '-t') type = (ctx.args[++i] ?? 'A').toUpperCase()
      else if (a.startsWith('+')) plus.add(a.slice(1).toLowerCase())
      else if (/^(A|AAAA|MX|NS|SOA|TXT|CNAME|PTR|SRV|CAA|ANY)$/i.test(a) && (name !== undefined || ctx.args.slice(i + 1).some((x) => !x.startsWith('+') && !x.startsWith('@')))) type = a.toUpperCase()
      else if (name === undefined) name = a
    }
    if (ctx.args.includes('-x')) type ??= 'PTR'
    name ??= '.'
    type ??= name === '.' ? 'NS' : 'A'
    if (plus.has('trace')) {
      ctx.err('[simulador] +trace no está disponible: acá se ve la respuesta final del resolvedor.\n')
    }
    const { r, errors } = ask(ctx, server, name, type)
    const short = plus.has('short')
    const onlyAnswer = plus.has('noall') && plus.has('answer')
    if (!r) {
      if (!short) ctx.out(`${errors.join('\n')}\n\n; <<>> DiG ${VERSION(ctx.sys)} <<>> ${ctx.args.join(' ')}\n${server ? '; (1 server found)\n' : ''};; global options: +cmd\n;; no servers could be reached\n`)
      else ctx.out(`${errors.join('\n')}\n`)
      return 9
    }
    if (short) {
      if (r.answer.length) ctx.out(r.answer.map((x) => x.data).join('\n') + '\n')
      return 0
    }
    if (onlyAnswer) {
      if (r.answer.length) ctx.out(r.answer.map(rrLine).join('\n') + '\n')
      return 0
    }
    const rd = !plus.has('norecurse') && !plus.has('norec')
    const flags = ['qr', r.aa ? 'aa' : '', rd ? 'rd' : '', r.ra ? 'ra' : ''].filter(Boolean).join(' ')
    const fq = name.endsWith('.') ? name : `${name}.`
    let out = `\n; <<>> DiG ${VERSION(ctx.sys)} <<>> ${ctx.args.filter((a) => !a.startsWith('+')).join(' ')}\n${server ? '; (1 server found)\n' : ''};; global options: +cmd\n;; Got answer:\n`
    out += `;; ->>HEADER<<- opcode: QUERY, status: ${r.status}, id: ${10000 + ((name.length * 7919 + type.length * 31) % 50000)}\n`
    out += `;; flags: ${flags}; QUERY: 1, ANSWER: ${r.answer.length}, AUTHORITY: ${r.authority.length}, ADDITIONAL: 1\n`
    if (rd && !r.ra) out += ';; WARNING: recursion requested but not available\n'
    out += `\n;; OPT PSEUDOSECTION:\n; EDNS: version: 0, flags:; udp: 1232\n;; QUESTION SECTION:\n;${fq}\t\t\tIN\t${type}\n\n`
    if (r.answer.length) out += `;; ANSWER SECTION:\n${r.answer.map(rrLine).join('\n')}\n\n`
    if (r.authority.length) out += `;; AUTHORITY SECTION:\n${r.authority.map(rrLine).join('\n')}\n\n`
    const srv = r.server
    out += `;; Query time: ${r.by === 'externo' ? 18 : r.aa ? 0 : 4} msec\n;; SERVER: ${srv}#53(${srv}) (UDP)\n;; WHEN: ${digWhen()}\n;; MSG SIZE  rcvd: ${40 + (r.answer.length + r.authority.length) * 24}\n\n`
    ctx.out(out)
    return 0
  },
})

register('nslookup', {
  usage: 'nslookup [-type=TYPE] name [server]',
  path: '/usr/bin',
  run(ctx) {
    const typeArg = ctx.args.find((a) => /^-(q(uery)?|type)=/i.test(a))
    let type = typeArg ? typeArg.split('=')[1].toUpperCase() : 'A'
    const [rawName, server] = ctx.args.filter((a) => !a.startsWith('-'))
    if (!rawName) {
      ctx.err('[simulador] nslookup interactivo no está disponible: escribí nslookup nombre [servidor].\n')
      return 1
    }
    let name = rawName
    if (/^\d+(\.\d+){3}$/.test(rawName)) {
      name = reverseName(rawName)
      type = 'PTR'
    }
    const { r, errors } = ask(ctx, server, name, type)
    if (!r) {
      ctx.out(`${errors.join('\n')}\n;; no servers could be reached\n\n`)
      return 1
    }
    ctx.out(`Server:\t\t${r.server}\nAddress:\t${r.server}#53\n\n`)
    if (r.status !== 'NOERROR' || !r.answer.length) {
      ctx.out(r.status === 'NOERROR' ? `*** Can't find ${rawName}: No answer\n\n` : `** server can't find ${type === 'PTR' ? name : rawName}: ${r.status}\n\n`)
      return 1
    }
    if (!r.aa) ctx.out('Non-authoritative answer:\n')
    for (const a of r.answer) {
      const n = a.name.replace(/\.$/, '')
      if (a.type === 'CNAME') ctx.out(`${n}\tcanonical name = ${a.data}\n`)
      else if (a.type === 'A' || a.type === 'AAAA') ctx.out(`Name:\t${n}\nAddress: ${a.data}\n`)
      else if (a.type === 'MX') ctx.out(`${n}\tmail exchanger = ${a.data}\n`)
      else if (a.type === 'PTR') ctx.out(`${a.name.replace(/\.$/, '')}\tname = ${a.data}\n`)
      else if (a.type === 'NS') ctx.out(`${n}\tnameserver = ${a.data}\n`)
      else ctx.out(`${n}\t${a.type.toLowerCase()} = ${a.data}\n`)
    }
    ctx.out('\n')
    return 0
  },
})

register('host', {
  usage: 'host [-t type] name [server]',
  path: '/usr/bin',
  run(ctx) {
    const tIdx = ctx.args.indexOf('-t')
    const forced = tIdx >= 0 ? ctx.args[tIdx + 1]?.toUpperCase() : undefined
    const words = ctx.args.filter((a, i) => !a.startsWith('-') && (tIdx < 0 || i !== tIdx + 1))
    const [rawName, server] = words
    if (!rawName) {
      ctx.err('Usage: host [-aCdilrTvVw] [-c class] [-N ndots] [-t type] [-W time] hostname [server]\n')
      return 1
    }
    const reverse = /^\d+(\.\d+){3}$/.test(rawName)
    const name = reverse ? reverseName(rawName) : rawName
    const types = forced ? [forced] : reverse ? ['PTR'] : ['A', 'AAAA', 'MX']
    if (server) ctx.out(`Using domain server:\nName: ${server}\nAddress: ${server}#53\nAliases: \n\n`)
    let any = false
    for (const t of types) {
      const { r, errors } = ask(ctx, server, name, t)
      if (!r) {
        ctx.out(`${errors.join('\n')}\n;; no servers could be reached\n`)
        return 1
      }
      if (r.status !== 'NOERROR') {
        ctx.out(`Host ${rawName} not found: ${r.status === 'NXDOMAIN' ? '3(NXDOMAIN)' : r.status === 'REFUSED' ? '5(REFUSED)' : '2(SERVFAIL)'}\n`)
        return 1
      }
      for (const a of r.answer) {
        const n = a.name.replace(/\.$/, '')
        if (a.type === 'CNAME') {
          if (t === 'A') ctx.out(`${n} is an alias for ${a.data}\n`)
        } else if (a.type === 'A') ctx.out(`${n} has address ${a.data}\n`)
        else if (a.type === 'AAAA') ctx.out(`${n} has IPv6 address ${a.data}\n`)
        else if (a.type === 'MX') ctx.out(`${n} mail is handled by ${a.data}\n`)
        else if (a.type === 'PTR') ctx.out(`${n} domain name pointer ${a.data}\n`)
        else ctx.out(`${n} has ${a.type} record ${a.data}\n`)
        any = true
      }
    }
    if (!any && forced) ctx.out(`${rawName} has no ${forced} record\n`)
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// BIND
// ---------------------------------------------------------------------------------------

register('named-checkconf', {
  usage: 'named-checkconf [-z] [filename]',
  path: '/usr/bin',
  run(ctx) {
    const file = ctx.args.find((a) => !a.startsWith('-'))
    const conf = readNamedConfig(ctx.sys, file ? ctx.sh.resolve(file) : undefined)
    const errs = conf.problems
    if (errs.length) {
      ctx.out(errs.map((p) => p.bind).join('\n') + '\n')
      if (errs.some((p) => p.severity === 'error')) return 1
    }
    if (ctx.args.includes('-z')) {
      loadZones(ctx.sys, conf)
      let bad = false
      for (const z of conf.zones) {
        if (!['primary', 'master'].includes(z.type)) continue
        if (z.loadError) {
          bad = true
          ctx.out(z.loadError.join('\n') + '\n')
        } else if (z.zone) {
          for (const w of z.zone.problems) ctx.out(w.bind + '\n')
          ctx.out(`zone ${z.name}/IN: loaded serial ${z.zone.serial ?? 0}\n`)
        }
      }
      return bad ? 1 : 0
    }
    return 0
  },
})

register('named-checkzone', {
  usage: 'named-checkzone zonename filename',
  path: '/usr/bin',
  run(ctx) {
    const [zone, file] = ctx.args.filter((a) => !a.startsWith('-'))
    if (!zone || !file) {
      ctx.err('usage: named-checkzone [-djqvD] [-c class] [-f inputformat] [-F outputformat] [-J filename] [-t directory] [-w directory] [-k (ignore|warn|fail)] [-m (ignore|warn|fail)] [-n (ignore|warn|fail)] [-r (ignore|warn|fail)] [-i (full|full-sibling|local|local-sibling|none)] [-M (ignore|warn|fail)] [-S (ignore|warn|fail)] [-W (ignore|warn)] [-o filename] zonename [ (filename|-) ]\n')
      return 1
    }
    const path = ctx.sh.resolve(file)
    let text: string
    try {
      text = ctx.sys.vfs.readFile(path, ctx.sh.cred)
    } catch (e) {
      const notFound = !ctx.sys.vfs.exists(path)
      ctx.out(`zone ${zone}/IN: loading from master file ${file} failed: ${notFound ? 'file not found' : 'permission denied'}\nzone ${zone}/IN: not loaded due to errors.\n`)
      void e
      return 1
    }
    const res = checkzoneOutput(parseZone(text, zone, file), file)
    ctx.out(res.text)
    return res.ok ? 0 : 1
  },
})

register('rndc', {
  usage: 'rndc command',
  summary: '  reload [zone]  status  flush  reconfig',
  path: '/usr/sbin',
  run(ctx) {
    if (ctx.sh.user !== 'root') {
      ctx.err('rndc: open: /etc/rndc.key: permission denied\nrndc: could not load rndc configuration\n')
      return 1
    }
    const rt = namedActive(ctx.sys)
    if (!rt) {
      ctx.err('rndc: connect failed: 127.0.0.1#953: connection refused\n')
      return 1
    }
    const [cmd, zone] = ctx.args
    if (cmd === 'reload' || cmd === 'reconfig') {
      const err = namedStart(ctx.sys, true)
      if (err) {
        ctx.sys.log('named.service', err, 3)
        ctx.err(`rndc: '${cmd}' failed: failure\n`)
        return 1
      }
      const now = namedActive(ctx.sys)!
      if (zone) {
        const z = now.conf.zones.find((x) => x.name === zone.replace(/\.$/, '').toLowerCase())
        if (!z) {
          ctx.err(`rndc: 'reload' failed: not found\nno matching zone '${zone}' in any view\n`)
          return 1
        }
        if (z.loadError) {
          ctx.err(`rndc: 'reload' failed: ${z.loadError[0].includes('not found') ? 'file not found' : 'bad zone'}\n`)
          return 1
        }
        ctx.out('zone reload queued\n')
        return 0
      }
      ctx.out(cmd === 'reload' ? 'server reload successful\n' : '')
      return 0
    }
    if (cmd === 'status') {
      ctx.out(`version: BIND ${VERSION(ctx.sys)} (Extended Support Version) <id:>\nrunning on localhost: Linux x86_64\nboot time: ${new Date(Date.now() - 3600_000).toUTCString()}\nnumber of zones: ${rt.zones.size + 100} (99 automatic)\ndebug level: 0\nrecursive clients: 0/900/1000\nserver is up and running\n`)
      return 0
    }
    if (cmd === 'flush') return 0
    ctx.err(`rndc: '${cmd ?? ''}' failed: unknown command\n`)
    return 1
  },
})

SERVICE_CHECKS.named = (ctx) => namedStart(ctx.sys)

// ---------------------------------------------------------------------------------------
// Unbound
// ---------------------------------------------------------------------------------------

register('unbound-checkconf', {
  usage: 'unbound-checkconf [file]',
  path: '/usr/sbin',
  run(ctx) {
    const cfg = readUnboundConfig(ctx.sys)
    const file = unboundConfPaths(ctx.sys)[0]
    if (cfg.problems.length) {
      ctx.err(cfg.problems.map((p) => p.text).join('\n') + `\nread ${cfg.problems[0].file} failed: ${cfg.problems.length} errors in configuration file\n`)
      return 1
    }
    ctx.out(`unbound-checkconf: no errors in ${file}\n`)
    return 0
  },
})

SERVICE_CHECKS.unbound = (ctx) => unboundStart(ctx.sys)

// ---------------------------------------------------------------------------------------
// Kea DHCPv4
// ---------------------------------------------------------------------------------------

const KEA_FILE = '/etc/kea/kea-dhcp4.conf'
const keaRuntime = new WeakMap<System, KeaConfig>()
const keaUnit = (sys: System) => (sys.distro === 'rocky' ? 'kea-dhcp4' : 'kea-dhcp4-server')

function keaLoad(sys: System): { config?: KeaConfig; error?: string; warnings: string[] } {
  let text: string
  try {
    text = sys.vfs.readFile(KEA_FILE, ROOT_CRED)
  } catch {
    return { error: `configuration error using file: ${KEA_FILE}, error: Unable to open file ${KEA_FILE}`, warnings: [] }
  }
  // Ubuntu 24.04 trae Kea 2.4 (el id de subred todavía no es obligatorio); Rocky 10, Kea 2.6.
  const { config, problems } = parseKea(text, KEA_FILE, { idRequired: sys.distro === 'rocky' })
  const errs = problems.filter((p) => p.severity === 'error')
  const warnings = problems.filter((p) => p.severity === 'warning').map((p) => p.kea)
  if (errs.length || !config) return { error: `configuration error using file: ${KEA_FILE}, error: ${errs[0]?.kea ?? 'syntax error'}`, warnings }
  return { config, warnings }
}

register('kea-dhcp4', {
  usage: 'kea-dhcp4 -t file | -c file',
  path: '/usr/sbin',
  run(ctx) {
    const t = ctx.args.indexOf('-t')
    if (t < 0) {
      ctx.err('[simulador] kea-dhcp4 se maneja como servicio: systemctl start ' + keaUnit(ctx.sys) + '. Para revisar el archivo: kea-dhcp4 -t ' + KEA_FILE + '\n')
      return 1
    }
    const file = ctx.sh.resolve(ctx.args[t + 1] ?? KEA_FILE)
    let text: string
    try {
      text = ctx.sys.vfs.readFile(file, ctx.sh.cred)
    } catch {
      ctx.err(`Syntax check failed with: Unable to open file ${file}\n`)
      return 1
    }
    const { problems } = parseKea(text, file, { idRequired: ctx.sys.distro === 'rocky' })
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 23)
    for (const w of problems.filter((p) => p.severity === 'warning')) ctx.out(`${stamp} WARN  [kea-dhcp4.dhcp4/1042.] DHCP4_CONFIG_SYNTAX_WARNING configuration syntax warning: ${w.kea}\n`)
    const err = problems.find((p) => p.severity === 'error')
    if (err) {
      ctx.err(`Syntax check failed with: ${err.kea}\n`)
      return 1
    }
    ctx.out('Syntax check OK\n')
    return 0
  },
})

const keaCheck = (ctx: CommandContext) => {
  const r = keaLoad(ctx.sys)
  if (r.error) return `DHCP4_INIT_FAIL failed to initialize Kea server: ${r.error}`
  keaRuntime.set(ctx.sys, r.config!)
  const sys = ctx.sys
  for (const i of r.config!.interfaces) {
    const name = i.split('/')[0]
    if (name !== '*' && !sys.interfaces.some((x) => x.name === name)) sys.log(`${keaUnit(sys)}.service`, `DHCPSRV_NO_SOCKETS_OPEN no interface configured to listen to DHCP traffic (interface ${name} does not exist)`, 4)
  }
  const svc = sys.services.get(keaUnit(sys))
  if (svc) svc.ports = [67]
  return undefined
}
SERVICE_CHECKS['kea-dhcp4'] = keaCheck
SERVICE_CHECKS['kea-dhcp4-server'] = keaCheck

function ipNum(s: string) {
  return s.split('.').reduce((a, b) => a * 256 + Number(b), 0)
}
function numIp(n: number) {
  return [24, 16, 8, 0].map((sh) => Math.floor(n / 2 ** sh) % 256).join('.')
}

/** Un servidor Kea del laboratorio que escucha en una placa con IP dentro de alguna de sus subredes. */
export function dhcpOffer(client: System, mac: string): { server: System; ip: string; prefix: number; gateway?: string; dns: string[]; domain?: string; lease: number } | undefined {
  for (const srv of [client, ...client.lab]) {
    if (srv === client) continue
    const unit = keaUnit(srv)
    if (!srv.services.get(unit)?.active) continue
    let cfg = keaRuntime.get(srv)
    if (!cfg) {
      const r = keaLoad(srv)
      if (!r.config) continue
      cfg = r.config
      keaRuntime.set(srv, cfg)
    }
    for (const ifName of cfg.interfaces) {
      const [name, addr] = ifName.split('/')
      const ifaces = srv.interfaces.filter((i) => i.up && i.ip && (name === '*' || i.name === name) && (!addr || i.ip.startsWith(`${addr}/`)))
      for (const iface of ifaces) {
        const sip = ipNum(iface.ip!.split('/')[0])
        const subnet = cfg.subnets.find((s) => {
          const r = cidrRange(s.subnet)
          return r && sip >= r.net && sip <= r.bcast
        })
        if (!subnet) continue
        const range = cidrRange(subnet.subnet)!
        const leasesPath = '/var/lib/kea/kea-leases4.csv'
        let leases: string
        try {
          leases = srv.vfs.readFile(leasesPath, ROOT_CRED)
        } catch {
          leases = 'address,hwaddr,client_id,valid_lifetime,expire,subnet_id,fqdn_fwd,fqdn_rev,hostname,state,user_context,pool_id\n'
        }
        const taken = new Set<string>()
        for (const l of leases.split('\n').slice(1)) {
          const [a, hw] = l.split(',')
          if (a && hw !== mac) taken.add(a)
        }
        for (const h of [srv, ...srv.lab]) for (const o of h.ownIps()) taken.add(o)
        let ip = subnet.reservations.find((r) => r.mac === mac.toLowerCase())?.ip
        if (!ip) {
          const prev = leases.split('\n').find((l) => l.split(',')[1] === mac)?.split(',')[0]
          if (prev) ip = prev
        }
        if (!ip) {
          for (const p of subnet.pools) {
            for (let n = ipNum(p.start); n <= ipNum(p.end); n++) {
              const cand = numIp(n)
              if (!taken.has(cand) && !subnet.reservations.some((r) => r.ip === cand)) {
                ip = cand
                break
              }
            }
            if (ip) break
          }
        }
        if (!ip) {
          srv.log(`${unit}.service`, `ALLOC_ENGINE_V4_ALLOC_FAIL_SUBNET [hwtype=1 ${mac}], cid=[no info], tid=0x5a3c1f2e: failed to allocate an IPv4 lease in the subnet ${subnet.subnet}, subnet-id ${subnet.id ?? 1}, shared network (none)`, 4)
          continue
        }
        const expire = Math.floor(Date.now() / 1000) + cfg.validLifetime
        const kept = leases.split('\n').filter((l) => l && l.split(',')[1] !== mac)
        srv.vfs.writeFile(leasesPath, [...kept, `${ip},${mac},,${cfg.validLifetime},${expire},${subnet.id ?? 1},0,0,${client.hostname},0,,0`].join('\n') + '\n', ROOT_CRED)
        srv.log(`${unit}.service`, `DHCP4_LEASE_ALLOC [hwtype=1 ${mac}], cid=[no info], tid=0x5a3c1f2e: lease ${ip} has been allocated for ${cfg.validLifetime} seconds`, 6)
        const gw = subnet.options.routers?.split(',')[0]?.trim()
        return {
          server: srv,
          ip,
          prefix: range.prefix,
          gateway: gw || undefined,
          dns: (subnet.options['domain-name-servers'] ?? '').split(',').map((x) => x.trim()).filter(Boolean),
          domain: subnet.options['domain-name'],
          lease: cfg.validLifetime,
        }
      }
    }
  }
  return undefined
}

/** Pide dirección por DHCP para una interfaz: true si la obtuvo. */
export function dhcpConfigure(sys: System, ifName: string): boolean {
  const iface = sys.interfaces.find((i) => i.name === ifName)
  if (!iface) return false
  const offer = dhcpOffer(sys, iface.mac)
  iface.up = true
  if (!offer) {
    iface.ip = undefined
    return false
  }
  iface.ip = `${offer.ip}/${offer.prefix}`
  sys.gateway = offer.gateway
  if (offer.gateway) sys.reachable.add(offer.gateway)
  if (offer.dns.length) {
    sys.dns = offer.dns
    sys.vfs.writeFile('/etc/resolv.conf', `# Generated by NetworkManager\n${offer.domain ? `search ${offer.domain}\n` : ''}${offer.dns.map((d) => `nameserver ${d}`).join('\n')}\n`, ROOT_CRED)
  }
  sys.log('NetworkManager.service', `<info>  [${(Date.now() / 1000).toFixed(4)}] dhcp4 (${ifName}): state changed new lease, address=${offer.ip}`, 6)
  return true
}

/** Direcciones donde escucha Kea (para ss). */
export function keaListen(sys: System): string[] | undefined {
  const cfg = keaRuntime.get(sys) ?? keaLoad(sys).config
  if (!cfg) return undefined
  return cfg.interfaces.flatMap((n) => {
    const [name, addr] = n.split('/')
    if (addr) return [addr]
    return sys.interfaces.filter((i) => i.up && i.ip && (name === '*' || i.name === name)).map((i) => i.ip!.split('/')[0])
  })
}
