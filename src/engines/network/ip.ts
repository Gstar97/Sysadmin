/** Utilidades de direcciones IPv4 e IPv6: conversión, máscaras, subredes y VLSM. */

export function parseIpv4(text: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text.trim())
  if (!m) return undefined
  const parts = m.slice(1).map(Number)
  if (parts.some((p) => p > 255)) return undefined
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}

export function formatIpv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

export function prefixToMask(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
}

/** Devuelve el prefijo de una máscara contigua, o undefined si la máscara no es válida. */
export function maskToPrefix(mask: number): number | undefined {
  const inv = ~mask >>> 0
  if ((inv & (inv + 1)) !== 0) return undefined
  let bits = 0
  for (let m = mask; m; m = (m << 1) >>> 0) bits++
  return bits
}

export function wildcardToPrefix(wildcard: number): number | undefined {
  return maskToPrefix(~wildcard >>> 0)
}

export function networkOf(ip: number, prefix: number): number {
  return (ip & prefixToMask(prefix)) >>> 0
}

export function broadcastOf(ip: number, prefix: number): number {
  return (networkOf(ip, prefix) | (~prefixToMask(prefix) >>> 0)) >>> 0
}

export function sameSubnet(a: number, b: number, prefix: number): boolean {
  return networkOf(a, prefix) === networkOf(b, prefix)
}

export function parseCidr(text: string): { ip: number; prefix: number } | undefined {
  const [addr, p] = text.trim().split('/')
  const ip = parseIpv4(addr)
  const prefix = Number(p)
  if (ip === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return undefined
  return { ip, prefix }
}

export type Ipv4Class = 'A' | 'B' | 'C' | 'D' | 'E'

export function ipv4Class(ip: number): Ipv4Class {
  const first = ip >>> 24
  if (first < 128) return 'A'
  if (first < 192) return 'B'
  if (first < 224) return 'C'
  if (first < 240) return 'D'
  return 'E'
}

export function classfulPrefix(ip: number): number {
  const c = ipv4Class(ip)
  return c === 'A' ? 8 : c === 'B' ? 16 : 24
}

/** Tipo de dirección según su rango (RFC 1918, loopback, APIPA, etc.). */
export function ipv4Kind(ip: number): string {
  const inRange = (net: string, prefix: number) => sameSubnet(ip, parseIpv4(net)!, prefix)
  if (inRange('10.0.0.0', 8) || inRange('172.16.0.0', 12) || inRange('192.168.0.0', 16)) return 'privada (RFC 1918)'
  if (inRange('127.0.0.0', 8)) return 'loopback'
  if (inRange('169.254.0.0', 16)) return 'enlace local (APIPA)'
  if (inRange('100.64.0.0', 10)) return 'CGNAT (RFC 6598)'
  if (inRange('224.0.0.0', 4)) return 'multicast'
  if (inRange('240.0.0.0', 4)) return 'reservada'
  if (inRange('0.0.0.0', 8)) return 'esta red'
  return 'pública'
}

export interface SubnetInfo {
  network: number
  broadcast: number
  prefix: number
  mask: number
  wildcard: number
  firstHost: number
  lastHost: number
  usableHosts: number
  totalAddresses: number
}

export function subnetInfo(ip: number, prefix: number): SubnetInfo {
  const network = networkOf(ip, prefix)
  const broadcast = broadcastOf(ip, prefix)
  const total = 2 ** (32 - prefix)
  // /31 (enlaces punto a punto, RFC 3021) y /32 no reservan red ni broadcast.
  const usable = prefix >= 31 ? total : total - 2
  return {
    network,
    broadcast,
    prefix,
    mask: prefixToMask(prefix),
    wildcard: ~prefixToMask(prefix) >>> 0,
    firstHost: prefix >= 31 ? network : network + 1,
    lastHost: prefix >= 31 ? broadcast : broadcast - 1,
    usableHosts: usable,
    totalAddresses: total,
  }
}

/** Divide una red en subredes de igual tamaño. */
export function splitNetwork(network: number, prefix: number, newPrefix: number): number[] {
  const count = 2 ** (newPrefix - prefix)
  const size = 2 ** (32 - newPrefix)
  const base = networkOf(network, prefix)
  return Array.from({ length: count }, (_, i) => (base + i * size) >>> 0)
}

/** Prefijo mínimo que alcanza para una cantidad de hosts. */
export function prefixForHosts(hosts: number): number {
  for (let p = 30; p >= 0; p--) if (2 ** (32 - p) - 2 >= hosts) return p
  return 0
}

export interface VlsmAssignment {
  name: string
  hosts: number
  prefix: number
  network: number
}

/** Asigna subredes VLSM de mayor a menor, como se hace a mano. Devuelve undefined si no alcanza el espacio. */
export function vlsm(network: number, prefix: number, needs: { name: string; hosts: number }[]): VlsmAssignment[] | undefined {
  const sorted = [...needs].sort((a, b) => b.hosts - a.hosts)
  let cursor = networkOf(network, prefix)
  const end = broadcastOf(network, prefix)
  const out: VlsmAssignment[] = []
  for (const n of sorted) {
    const p = prefixForHosts(n.hosts)
    const size = 2 ** (32 - p)
    if (cursor % size !== 0) cursor = Math.ceil(cursor / size) * size
    if (cursor + size - 1 > end) return undefined
    out.push({ name: n.name, hosts: n.hosts, prefix: p, network: cursor >>> 0 })
    cursor += size
  }
  return out
}

export function toBinary(n: number, dotted = true): string {
  const bits = (n >>> 0).toString(2).padStart(32, '0')
  return dotted ? bits.match(/.{8}/g)!.join('.') : bits
}

// ---------------------------------------------------------------------------------------
// IPv6
// ---------------------------------------------------------------------------------------

/** Expande una dirección IPv6 a 8 grupos de 4 dígitos. */
export function expandIpv6(text: string): string | undefined {
  const t = text.trim().toLowerCase()
  if (!/^[0-9a-f:]+$/.test(t) || (t.match(/::/g)?.length ?? 0) > 1) return undefined
  const [head, tail] = t.includes('::') ? t.split('::') : [t, undefined]
  const h = head ? head.split(':') : []
  const tl = tail !== undefined ? (tail ? tail.split(':') : []) : []
  const missing = 8 - h.length - tl.length
  if (tail === undefined ? h.length !== 8 : missing < 1) return undefined
  const groups = [...h, ...Array(tail === undefined ? 0 : missing).fill('0'), ...tl]
  if (groups.some((g) => g.length === 0 || g.length > 4)) return undefined
  return groups.map((g) => g.padStart(4, '0')).join(':')
}

/** Abrevia una dirección IPv6 según RFC 5952 (ceros a la izquierda y la secuencia de ceros más larga). */
export function compressIpv6(text: string): string | undefined {
  const full = expandIpv6(text)
  if (!full) return undefined
  const groups = full.split(':').map((g) => g.replace(/^0+(?=.)/, ''))
  let best = { start: -1, len: 0 }
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') {
      i++
      continue
    }
    let j = i
    while (j < 8 && groups[j] === '0') j++
    if (j - i > best.len && j - i >= 2) best = { start: i, len: j - i }
    i = j
  }
  if (best.start === -1) return groups.join(':')
  const left = groups.slice(0, best.start).join(':')
  const right = groups.slice(best.start + best.len).join(':')
  return `${left}::${right}`
}

export function ipv6Kind(text: string): string | undefined {
  const full = expandIpv6(text)
  if (!full) return undefined
  const first = parseInt(full.slice(0, 4), 16)
  if (full === '0000:0000:0000:0000:0000:0000:0000:0001') return 'loopback'
  if (full === '0000:0000:0000:0000:0000:0000:0000:0000') return 'no especificada'
  if ((first & 0xffc0) === 0xfe80) return 'enlace local'
  if ((first & 0xfe00) === 0xfc00) return 'única local (ULA)'
  if ((first & 0xff00) === 0xff00) return 'multicast'
  if (full.startsWith('2001:0db8')) return 'documentación'
  if ((first & 0xe000) === 0x2000) return 'unicast global'
  return 'otra'
}

/** Identificador de interfaz EUI-64 a partir de una MAC (invierte el bit U/L e inserta FFFE). */
export function eui64(mac: string): string | undefined {
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, '')
  if (hex.length !== 12) return undefined
  const first = (parseInt(hex.slice(0, 2), 16) ^ 0x02).toString(16).padStart(2, '0')
  const full = `${first}${hex.slice(2, 6)}fffe${hex.slice(6)}`
  return full.match(/.{4}/g)!.map((g) => g.replace(/^0+(?=.)/, '')).join(':')
}

/** Prefijo de red IPv6 (los primeros "prefix" bits), devuelto abreviado. */
export function ipv6Network(text: string, prefix: number): string | undefined {
  const full = expandIpv6(text)
  if (!full || prefix < 0 || prefix > 128) return undefined
  const bits = full
    .split(':')
    .map((g) => parseInt(g, 16).toString(2).padStart(16, '0'))
    .join('')
  const masked = bits.slice(0, prefix).padEnd(128, '0')
  const groups = masked.match(/.{16}/g)!.map((b) => parseInt(b, 2).toString(16))
  return compressIpv6(groups.join(':'))
}
