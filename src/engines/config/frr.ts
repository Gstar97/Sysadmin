/**
 * Configuración de FRRouting (/etc/frr/frr.conf) con OSPF: el mismo estilo que IOS, con bloques
 * "interface" y "router ospf" que terminan en "exit" o en "!". Avisa como vtysh ante comandos
 * desconocidos y, además, los errores de diseño típicos (redes con bits de host, área distinta
 * en una misma interfaz, router-id faltante).
 */
import type { Diagnostic } from './types'

interface Ctx {
  kind: 'top' | 'interface' | 'ospf' | 'bgp' | 'vty'
  name?: string
  line: number
}

function ipv4(s: string): number | undefined {
  const p = s.split('.')
  if (p.length !== 4 || !p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return undefined
  return p.reduce((a, b) => a * 256 + Number(b), 0)
}

function prefix(s: string): { net: number; len: number; hostBits: boolean } | undefined {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(s)
  if (!m || Number(m[2]) > 32) return undefined
  const ip = ipv4(m[1])
  if (ip === undefined) return undefined
  const size = 2 ** (32 - Number(m[2]))
  const net = Math.floor(ip / size) * size
  return { net, len: Number(m[2]), hostBits: net !== ip }
}

const area = (s: string) => /^\d+$/.test(s) || ipv4(s) !== undefined

const TOP: RegExp[] = [/^frr version \S+$/, /^frr defaults (traditional|datacenter)$/, /^hostname \S+$/, /^log (syslog|stdout|file)( .+)?$/, /^service integrated-vtysh-config$/, /^no ipv6 forwarding$/, /^ip forwarding$/, /^password \S+$/, /^enable password \S+$/]

export function validateFrr(text: string): { diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const err = (line: number, message: string) => diagnostics.push({ line, severity: 'error', message })
  const warn = (line: number, message: string) => diagnostics.push({ line, severity: 'warning', message })
  let ctx: Ctx = { kind: 'top', line: 0 }
  let ospfSeen = 0
  let routerId = false
  let networks = 0
  const ifaceAreas = new Map<string, string>()
  const lines = text.split('\n')
  lines.forEach((raw, i) => {
    const n = i + 1
    const line = raw.replace(/\s+$/, '')
    const t = line.trim()
    if (!t || t.startsWith('#')) return
    if (t === '!') {
      ctx = { kind: 'top', line: n }
      return
    }
    if (t === 'exit' || t === 'end' || t === 'exit-address-family') {
      if (t !== 'exit-address-family') ctx = { kind: 'top', line: n }
      return
    }
    // Un bloque nuevo puede empezar sin cerrar el anterior.
    let m: RegExpExecArray | null
    if ((m = /^interface (\S+)( vrf \S+)?$/.exec(t))) {
      ctx = { kind: 'interface', name: m[1], line: n }
      return
    }
    if (/^router ospf( \d+)?( vrf \S+)?$/.test(t)) {
      ctx = { kind: 'ospf', line: n }
      ospfSeen = n
      return
    }
    if (/^router bgp \d+$/.test(t)) {
      ctx = { kind: 'bgp', line: n }
      warn(n, 'BGP en FRR es para más adelante: este ejercicio no lo revisa.')
      return
    }
    if (/^line vty$/.test(t)) {
      ctx = { kind: 'vty', line: n }
      return
    }
    if ((m = /^ip route (\S+) (\S+)( \d+)?$/.exec(t))) {
      const p = prefix(m[1])
      if (!p) err(n, `% Malformed prefix "${m[1]}" (va en formato red/prefijo, por ejemplo 10.2.0.0/24).`)
      else if (p.hostBits) warn(n, `${m[1]} tiene bits de host: FRR la guarda como red, pero conviene escribir la dirección de red.`)
      if (ipv4(m[2]) === undefined && !/^[a-z]/i.test(m[2])) err(n, `% Siguiente salto inválido: ${m[2]}.`)
      return
    }
    if (ctx.kind === 'top') {
      if (/^ip ospf /.test(t) || /^network /.test(t) || /^ospf router-id/.test(t)) {
        err(n, `% Unknown command: ${t} (ese comando va dentro de un bloque interface o router ospf).`)
        return
      }
      if (!TOP.some((re) => re.test(t))) err(n, `% Unknown command: ${t}`)
      return
    }
    if (ctx.kind === 'interface') {
      if ((m = /^ip address (\S+)$/.exec(t))) {
        if (!prefix(m[1])) err(n, `% Malformed address "${m[1]}" (va con prefijo: 10.0.12.1/30).`)
        return
      }
      if ((m = /^ip ospf area (\S+)$/.exec(t))) {
        if (!area(m[1])) err(n, `% Área inválida: ${m[1]} (un número o una IP, por ejemplo 0 o 0.0.0.0).`)
        ifaceAreas.set(ctx.name!, m[1])
        return
      }
      if ((m = /^ip ospf cost (\d+)$/.exec(t))) {
        if (Number(m[1]) < 1 || Number(m[1]) > 65535) err(n, 'El costo de OSPF va de 1 a 65535.')
        return
      }
      if (/^ip ospf (passive|network (point-to-point|broadcast)|hello-interval \d+|dead-interval \d+|priority \d+|authentication( message-digest)?|message-digest-key \d+ md5 \S+)$/.test(t)) return
      if (/^(description .+|shutdown|no shutdown|ipv6 address \S+|mtu \d+|link-detect)$/.test(t)) return
      err(n, `% Unknown command: ${t}`)
      return
    }
    if (ctx.kind === 'ospf') {
      if ((m = /^ospf router-id (\S+)$/.exec(t)) || (m = /^router-id (\S+)$/.exec(t))) {
        if (ipv4(m[1]) === undefined) err(n, `% Router-ID inválido: ${m[1]} (tiene forma de IPv4, por ejemplo 2.2.2.2).`)
        routerId = true
        return
      }
      if ((m = /^network (\S+) area (\S+)$/.exec(t))) {
        const p = prefix(m[1])
        if (!p) err(n, `% Malformed prefix "${m[1]}": en FRR la red va con prefijo (10.0.12.0/30), no con wildcard como en IOS.`)
        else if (p.hostBits) warn(n, `${m[1]} tiene bits de host; escribe la dirección de red.`)
        if (!area(m[2])) err(n, `% Área inválida: ${m[2]}.`)
        networks++
        return
      }
      if ((m = /^network (\S+) (\S+) area (\S+)$/.exec(t))) {
        err(n, `% Unknown command: ${t} (eso es sintaxis de IOS con wildcard; en FRR es network ${m[1]}/PREFIJO area ${m[3]}).`)
        return
      }
      if (/^(no )?passive-interface (\S+)$/.test(t)) return
      if (/^redistribute (connected|static|kernel|bgp)( metric \d+)?( route-map \S+)?$/.test(t)) return
      if (/^default-information originate( always)?( metric \d+)?$/.test(t)) return
      if (/^auto-cost reference-bandwidth \d+$/.test(t)) return
      if (/^log-adjacency-changes( detail)?$/.test(t)) return
      if (/^area \S+ (authentication( message-digest)?|stub( no-summary)?|range \S+)$/.test(t)) return
      err(n, `% Unknown command: ${t}`)
      return
    }
    // bgp y vty: no se revisan en detalle.
  })
  if (ospfSeen && !routerId) warn(ospfSeen, 'Sin ospf router-id: FRR elige uno solo (la IP más alta). Fijarlo a mano evita sorpresas al cambiar direcciones.')
  if (ospfSeen && networks === 0 && ifaceAreas.size === 0) warn(ospfSeen, 'OSPF no está activo en ninguna interfaz: falta network ... area ... o ip ospf area en las interfaces.')
  return { diagnostics }
}
