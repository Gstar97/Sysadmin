import { formatIpv4, maskToPrefix, parseCidr, parseIpv4 } from '@/engines/network/ip'
import type { Port } from '@/engines/network/model'

export function cidrText(p: Port): string {
  return p.ip ? `${formatIpv4(p.ip.ip)}/${p.ip.prefix}` : ''
}

/** Acepta "192.168.1.1/24" o "192.168.1.1 255.255.255.0". */
export function parseCidrInput(text: string): { ip: number; prefix: number } | undefined {
  const t = text.trim()
  const c = parseCidr(t)
  if (c) return c
  const [a, m] = t.split(/\s+/)
  const ip = parseIpv4(a ?? '')
  const mask = parseIpv4(m ?? '')
  if (ip === undefined || mask === undefined) return undefined
  const prefix = maskToPrefix(mask)
  return prefix === undefined ? undefined : { ip, prefix }
}
