/**
 * Configuración de Kea DHCPv4 (kea-dhcp4.conf): JSON con comentarios, subredes con id, pools,
 * opciones y reservas. Avisa lo mismo que "kea-dhcp4 -t" y además los errores de diseño
 * típicos (pool fuera de la subred, puerta de enlace de otra red, reservas dentro del pool).
 */
import type { Diagnostic } from './types'

export interface KeaSubnet {
  id?: number
  subnet: string
  pools: { start: string; end: string }[]
  options: Record<string, string>
  reservations: { mac?: string; ip: string; hostname?: string }[]
  line: number
}

export interface KeaConfig {
  interfaces: string[]
  validLifetime: number
  options: Record<string, string>
  subnets: KeaSubnet[]
}

export interface KeaProblem {
  line: number
  severity: 'error' | 'warning'
  kea: string
  explicacion: string
}

const OPTION_NAMES = ['routers', 'domain-name-servers', 'domain-name', 'domain-search', 'ntp-servers', 'time-offset', 'broadcast-address', 'host-name', 'tftp-server-name', 'boot-file-name', 'interface-mtu', 'netbios-name-servers', 'vendor-encapsulated-options', 'classless-static-route', 'subnet-mask', 'time-servers', 'log-servers', 'dhcp-lease-time']

function ip(n: string): number | undefined {
  const p = n.trim().split('.')
  if (p.length !== 4 || !p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return undefined
  return p.reduce((a, b) => a * 256 + Number(b), 0)
}

export function cidrRange(c: string): { net: number; bcast: number; prefix: number } | undefined {
  const [a, p] = c.split('/')
  const n = ip(a ?? '')
  const pre = Number(p)
  if (n === undefined || !/^\d+$/.test(p ?? '') || pre > 32) return undefined
  const size = 2 ** (32 - pre)
  const net = Math.floor(n / size) * size
  return { net, bcast: net + size - 1, prefix: pre }
}

/** Quita comentarios (#, //, /* *\/) sin mover las líneas. */
function stripComments(text: string): string {
  let out = ''
  let i = 0
  let inStr = false
  while (i < text.length) {
    const c = text[i]
    if (inStr) {
      out += c
      if (c === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      i++
      continue
    }
    if (c === '#' || (c === '/' && text[i + 1] === '/')) {
      while (i < text.length && text[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const chunk = end < 0 ? text.slice(i) : text.slice(i, end + 2)
      out += chunk.replace(/[^\n]/g, ' ')
      i += chunk.length
      continue
    }
    out += c
    i++
  }
  return out
}

function lineOf(text: string, pos: number): number {
  return text.slice(0, pos).split('\n').length
}

/** Línea donde aparece una clave (primera aparición después de "from"). */
function keyLine(text: string, key: string, from = 0): number {
  const i = text.indexOf(`"${key}"`, from)
  return i < 0 ? 1 : lineOf(text, i)
}

export function parseKea(text: string, file = '/etc/kea/kea-dhcp4.conf', opts: { idRequired?: boolean } = {}): { config?: KeaConfig; problems: KeaProblem[] } {
  const idRequired = opts.idRequired ?? true
  const problems: KeaProblem[] = []
  let clean = stripComments(text)
  // Comas sobrantes antes de cerrar.
  for (const m of clean.matchAll(/,(\s*)([}\]])/g)) {
    problems.push({ line: lineOf(clean, m.index!), severity: 'warning', kea: `${file}:${lineOf(clean, m.index!)}: Extraneous comma`, explicacion: 'Sobra una coma antes de cerrar la lista o el bloque. Según la versión, Kea la rechaza o la ignora con un aviso: mejor quitarla.' })
  }
  clean = clean.replace(/,(\s*)([}\]])/g, ' $1$2')
  let data: unknown
  try {
    data = JSON.parse(clean)
  } catch (e) {
    const msg = String((e as Error).message)
    const pos = /position (\d+)/.exec(msg)
    const lc = /line (\d+) column (\d+)/.exec(msg)
    const line = lc ? Number(lc[1]) : pos ? lineOf(clean, Number(pos[1])) : 1
    let explicacion = 'El archivo no es JSON válido. Revisa comillas, comas entre elementos y que cada { y [ tenga su cierre.'
    const prevLine = clean.split('\n').slice(0, line - 1).reverse().find((l) => l.trim())
    if (prevLine && /["}\]\d]\s*$/.test(prevLine) && !/[,{[]\s*$/.test(prevLine)) explicacion = 'Falta una coma al final de la línea anterior: en JSON cada elemento se separa del siguiente con ",".'
    if (/'/.test(clean.split('\n')[line - 1] ?? '')) explicacion = "En JSON los textos van entre comillas dobles (\"...\"), no simples ('...')."
    problems.push({ line, severity: 'error', kea: `${file}:${line}: syntax error`, explicacion })
    return { problems }
  }
  const err = (line: number, kea: string, explicacion: string) => problems.push({ line, severity: 'error', kea, explicacion })
  const warn = (line: number, kea: string, explicacion: string) => problems.push({ line, severity: 'warning', kea, explicacion })
  if (!data || typeof data !== 'object' || !('Dhcp4' in data)) {
    err(1, "no Dhcp4 configuration found", 'Todo tiene que ir dentro de un objeto "Dhcp4": { "Dhcp4": { ... } }. Si es para IPv6, es otro servicio (kea-dhcp6).')
    return { problems }
  }
  const d = (data as { Dhcp4: Record<string, unknown> }).Dhcp4
  const known = ['interfaces-config', 'lease-database', 'valid-lifetime', 'renew-timer', 'rebind-timer', 'max-valid-lifetime', 'min-valid-lifetime', 'subnet4', 'option-data', 'loggers', 'control-socket', 'shared-networks', 'reservations', 'client-classes', 'hooks-libraries', 'dhcp-ddns', 'authoritative', 'expired-leases-processing', 'host-reservation-identifiers', 'reservations-global', 'reservations-in-subnet', 'reservations-out-of-pool', 'calculate-tee-times', 'match-client-id', 'next-server', 'boot-file-name', 'multi-threading', 'sanity-checks', 'option-def', 'host-reservation-identifiers', 'ddns-send-updates', 'early-global-reservations-lookup', 'cache-threshold', 'decline-probation-period']
  for (const k of Object.keys(d)) if (!known.includes(k)) err(keyLine(clean, k), `${file}: got unexpected keyword "${k}" in Dhcp4 map.`, `"${k}" no es una opción de Kea DHCPv4. Revisa cómo está escrito (Kea usa minúsculas con guiones, por ejemplo "valid-lifetime").`)
  const ifc = d['interfaces-config'] as { interfaces?: unknown } | undefined
  const interfaces = Array.isArray(ifc?.interfaces) ? (ifc!.interfaces as unknown[]).map(String) : []
  if (!interfaces.length) warn(keyLine(clean, 'interfaces-config'), 'interfaces-config: no interfaces specified', 'No hay interfaces en "interfaces-config": Kea arranca pero no escucha en ninguna tarjeta de red y nadie recibe dirección. Pon la interfaz de la red de clientes, por ejemplo ["enp0s3"].')
  const readOptions = (arr: unknown, at: number): Record<string, string> => {
    const out: Record<string, string> = {}
    if (!Array.isArray(arr)) return out
    for (const o of arr as Record<string, unknown>[]) {
      const name = String(o?.name ?? o?.code ?? '')
      if (o?.name !== undefined && !OPTION_NAMES.includes(name)) {
        err(keyLine(clean, name, at) || at, `option data configuration failed: definition for the option 'dhcp4.${name}' does not exist`, `"${name}" no es el nombre de una opción DHCP. Las más usadas: routers (puerta de enlace), domain-name-servers (DNS), domain-name y ntp-servers.`)
      }
      if (o?.data === undefined) err(at, `option data configuration failed: option data not specified for '${name}'`, `La opción "${name}" necesita "data" con su valor.`)
      out[name] = String(o?.data ?? '')
    }
    return out
  }
  const globalOptions = readOptions(d['option-data'], keyLine(clean, 'option-data'))
  const subnets: KeaSubnet[] = []
  const raw = Array.isArray(d.subnet4) ? (d.subnet4 as Record<string, unknown>[]) : []
  if (!raw.length) warn(keyLine(clean, 'Dhcp4'), 'no subnets defined', 'No hay ninguna subred en "subnet4": Kea no tiene direcciones para repartir.')
  let from = clean.indexOf('"subnet4"')
  for (const s of raw) {
    const at = clean.indexOf('"subnet"', from)
    const line = at < 0 ? 1 : lineOf(clean, at)
    from = at < 0 ? from : at + 1
    const cidr = String(s.subnet ?? '')
    const range = cidrRange(cidr)
    if (!range) {
      err(line, `subnet configuration failed: Invalid subnet syntax (prefix/len expected):${cidr}`, `"${cidr}" no es una subred válida: se escribe red/prefijo, por ejemplo "192.168.10.0/24".`)
      continue
    }
    if (range.net !== ip(cidr.split('/')[0])) warn(line, `subnet ${cidr}: address is not a network address`, `"${cidr}" no es la dirección de red: con /${range.prefix} la red es ${[24, 16, 8, 0].map((sh) => Math.floor(range.net / 2 ** sh) % 256).join('.')}.`)
    const id = typeof s.id === 'number' ? s.id : undefined
    if (id === undefined) {
      if (idRequired) err(line, "subnet configuration failed: missing parameter 'id'", 'Cada subred necesita un "id" numérico único (1, 2, 3...). Desde Kea 2.6 es obligatorio: los préstamos se guardan asociados a ese número.')
      else warn(line, "subnet without 'id'", 'Esta subred no tiene "id": esta versión de Kea le asigna uno solo, pero desde Kea 2.6 es obligatorio. Ponlo siempre (1, 2, 3...).')
    } else if (subnets.some((x) => x.id === id)) err(line, `subnet configuration failed: subnet with the prefix of '${cidr}' already exists or id ${id} is duplicated`, `El id ${id} ya lo usa otra subred: cada subred necesita un id distinto.`)
    for (const o of subnets) {
      const r = cidrRange(o.subnet)!
      if (range.net <= r.bcast && r.net <= range.bcast) err(line, `subnet configuration failed: subnet with the prefix of '${cidr}' already exists`, `La subred ${cidr} se superpone con ${o.subnet}.`)
    }
    const inSub = (n: number | undefined) => n !== undefined && n > range.net && n < range.bcast
    const pools: { start: string; end: string }[] = []
    for (const p of Array.isArray(s.pools) ? (s.pools as Record<string, unknown>[]) : []) {
      const txt = String(p.pool ?? '')
      const pl = keyLine(clean, 'pool', at)
      let a: string, b: string
      if (txt.includes('/')) {
        const r = cidrRange(txt)
        if (!r) {
          err(pl, `pool configuration failed: Failed to parse pool definition: ${txt}`, `"${txt}" no es un rango válido. Se escribe "192.168.10.100 - 192.168.10.199" o como subred.`)
          continue
        }
        a = [24, 16, 8, 0].map((sh) => Math.floor(r.net / 2 ** sh) % 256).join('.')
        b = [24, 16, 8, 0].map((sh) => Math.floor(r.bcast / 2 ** sh) % 256).join('.')
      } else {
        const m = /^\s*(\S+)\s*-\s*(\S+)\s*$/.exec(txt)
        if (!m || ip(m[1]) === undefined || ip(m[2]) === undefined) {
          err(pl, `pool configuration failed: Failed to parse pool definition: ${txt}`, `"${txt}" no es un rango válido. Se escribe con un guion entre dos direcciones: "192.168.10.100 - 192.168.10.199".`)
          continue
        }
        ;[a, b] = [m[1], m[2]]
      }
      if (ip(a)! > ip(b)!) err(pl, `pool configuration failed: upper bound address is less than lower bound address`, `El rango empieza en ${a} y termina en ${b}: el final es menor que el principio.`)
      else if (ip(a)! < range.net || ip(b)! > range.bcast) err(pl, `subnet configuration failed: a pool of type V4, with the following address range: ${a}-${b} does not match the prefix of a subnet: ${cidr}`, `El pool ${a} - ${b} no está dentro de la subred ${cidr}.`)
      pools.push({ start: a, end: b })
    }
    if (!pools.length) warn(line, `subnet ${cidr} has no pools`, 'La subred no tiene "pools": solo entrega las direcciones reservadas, a nadie más.')
    const options = { ...globalOptions, ...readOptions(s['option-data'], line) }
    if (options.routers) {
      for (const r of options.routers.split(',')) {
        if (!inSub(ip(r))) warn(line, `routers ${r.trim()} outside subnet ${cidr}`, `La puerta de enlace ${r.trim()} no está dentro de ${cidr}: los clientes reciben una puerta de enlace a la que no pueden llegar.`)
        else if (pools.some((p) => ip(r)! >= ip(p.start)! && ip(r)! <= ip(p.end)!)) warn(line, `routers ${r.trim()} inside pool`, `La puerta de enlace ${r.trim()} está dentro del pool: Kea podría prestársela a un equipo y habría una IP duplicada.`)
      }
    } else warn(line, `subnet ${cidr} has no routers option`, 'No hay opción "routers": los clientes reciben IP pero no puerta de enlace, así que no salen de su red.')
    const reservations: KeaSubnet['reservations'] = []
    for (const r of Array.isArray(s.reservations) ? (s.reservations as Record<string, unknown>[]) : []) {
      const rl = keyLine(clean, 'ip-address', at)
      const mac = r['hw-address'] !== undefined ? String(r['hw-address']) : undefined
      const addr = String(r['ip-address'] ?? '')
      if (mac !== undefined && !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)) err(rl, `reservation configuration failed: invalid hw-address ${mac}`, `"${mac}" no es una MAC válida: seis pares hexadecimales separados por dos puntos (52:54:00:ab:cd:01).`)
      if (!inSub(ip(addr))) err(rl, `reservation configuration failed: specified reservation for address ${addr} is outside of subnet ${cidr}`, `La reserva ${addr} no está dentro de la subred ${cidr}.`)
      else if (pools.some((p) => ip(addr)! >= ip(p.start)! && ip(addr)! <= ip(p.end)!)) warn(rl, `reservation ${addr} is inside a pool`, `La reserva ${addr} está dentro del pool. Kea lo permite, pero lo más claro es dejar las reservas fuera del rango dinámico.`)
      if (reservations.some((x) => x.ip === addr)) err(rl, `reservation configuration failed: duplicate IPv4 address ${addr}`, `La dirección ${addr} está reservada dos veces.`)
      if (mac && reservations.some((x) => x.mac?.toLowerCase() === mac.toLowerCase())) err(rl, `reservation configuration failed: duplicate hw-address ${mac}`, `La MAC ${mac} tiene dos reservas.`)
      reservations.push({ mac: mac?.toLowerCase(), ip: addr, hostname: r.hostname !== undefined ? String(r.hostname) : undefined })
    }
    subnets.push({ id, subnet: cidr, pools, options, reservations, line })
  }
  const vl = d['valid-lifetime']
  if (vl !== undefined && (typeof vl !== 'number' || vl <= 0)) err(keyLine(clean, 'valid-lifetime'), 'valid-lifetime must be a positive integer', '"valid-lifetime" es el tiempo del préstamo en segundos, un número sin comillas (por ejemplo 3600).')
  return { config: { interfaces, validLifetime: typeof vl === 'number' ? vl : 7200, options: globalOptions, subnets }, problems }
}

export function validateKea(text: string): { diagnostics: Diagnostic[]; data?: unknown } {
  const { problems } = parseKea(text)
  return { diagnostics: problems.map((p) => ({ line: p.line, severity: p.severity, message: `${p.explicacion} (kea-dhcp4 -t: ${p.kea.replace(/^\S+:\d+: |^\S+: /, '')})` })) }
}
