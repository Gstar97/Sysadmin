import { describe, expect, it } from 'vitest'
import {
  broadcastOf,
  compressIpv6,
  eui64,
  expandIpv6,
  formatIpv4,
  ipv4Kind,
  ipv6Kind,
  ipv6Network,
  maskToPrefix,
  networkOf,
  parseIpv4,
  prefixForHosts,
  prefixToMask,
  subnetInfo,
  vlsm,
} from '@/engines/network/ip'
import { createRng, randomInt } from '@/lib/random'

/** Implementación de referencia, octeto por octeto, independiente de las operaciones de bits. */
function refNetwork(ip: string, prefix: number): string {
  return ip
    .split('.')
    .map(Number)
    .map((o, i) => {
      const bits = Math.max(0, Math.min(8, prefix - 8 * i))
      const block = 2 ** (8 - bits)
      return Math.floor(o / block) * block
    })
    .join('.')
}

function refBroadcast(ip: string, prefix: number): string {
  return ip
    .split('.')
    .map(Number)
    .map((o, i) => {
      const bits = Math.max(0, Math.min(8, prefix - 8 * i))
      const block = 2 ** (8 - bits)
      return Math.floor(o / block) * block + block - 1
    })
    .join('.')
}

describe('IPv4', () => {
  it('convierte entre texto y número', () => {
    expect(parseIpv4('192.168.10.71')).toBe(3232238151)
    expect(formatIpv4(3232238151)).toBe('192.168.10.71')
    expect(parseIpv4('256.1.1.1')).toBeUndefined()
    expect(parseIpv4('10.0.0')).toBeUndefined()
  })

  it('máscaras y prefijos', () => {
    expect(formatIpv4(prefixToMask(26))).toBe('255.255.255.192')
    expect(maskToPrefix(parseIpv4('255.255.240.0')!)).toBe(20)
    expect(maskToPrefix(parseIpv4('255.255.255.0')!)).toBe(24)
    expect(maskToPrefix(parseIpv4('255.0.255.0')!)).toBeUndefined()
    expect(maskToPrefix(0)).toBe(0)
  })

  it('coincide con la implementación de referencia en miles de casos al azar', () => {
    const rng = createRng(2026)
    for (let i = 0; i < 5000; i++) {
      const ip = [0, 0, 0, 0].map(() => randomInt(rng, 0, 255)).join('.')
      const prefix = randomInt(rng, 0, 32)
      const n = parseIpv4(ip)!
      expect(formatIpv4(networkOf(n, prefix))).toBe(refNetwork(ip, prefix))
      expect(formatIpv4(broadcastOf(n, prefix))).toBe(refBroadcast(ip, prefix))
    }
  })

  it('información de subred, incluidos /31 y /32', () => {
    const s = subnetInfo(parseIpv4('192.168.10.71')!, 26)
    expect(formatIpv4(s.network)).toBe('192.168.10.64')
    expect(formatIpv4(s.broadcast)).toBe('192.168.10.127')
    expect(formatIpv4(s.firstHost)).toBe('192.168.10.65')
    expect(formatIpv4(s.lastHost)).toBe('192.168.10.126')
    expect(s.usableHosts).toBe(62)
    expect(subnetInfo(parseIpv4('10.0.0.0')!, 31).usableHosts).toBe(2)
    expect(subnetInfo(parseIpv4('10.0.0.5')!, 32).usableHosts).toBe(1)
  })

  it('tipo de dirección', () => {
    expect(ipv4Kind(parseIpv4('172.31.255.1')!)).toMatch(/privada/)
    expect(ipv4Kind(parseIpv4('172.32.0.1')!)).toBe('pública')
    expect(ipv4Kind(parseIpv4('169.254.3.3')!)).toMatch(/APIPA/)
    expect(ipv4Kind(parseIpv4('100.64.1.1')!)).toMatch(/CGNAT/)
  })

  it('prefijo según cantidad de hosts', () => {
    expect(prefixForHosts(2)).toBe(30)
    expect(prefixForHosts(30)).toBe(27)
    expect(prefixForHosts(31)).toBe(26)
    expect(prefixForHosts(254)).toBe(24)
    expect(prefixForHosts(255)).toBe(23)
  })

  it('VLSM asigna de mayor a menor sin superposiciones', () => {
    const plan = vlsm(parseIpv4('192.168.1.0')!, 24, [
      { name: 'A', hosts: 20 },
      { name: 'B', hosts: 100 },
      { name: 'C', hosts: 2 },
    ])!
    expect(plan.map((p) => `${p.name} ${formatIpv4(p.network)}/${p.prefix}`)).toEqual(['B 192.168.1.0/25', 'A 192.168.1.128/27', 'C 192.168.1.160/30'])
    expect(vlsm(parseIpv4('192.168.1.0')!, 24, [{ name: 'X', hosts: 300 }])).toBeUndefined()
  })
})

describe('IPv6', () => {
  it('abrevia según RFC 5952', () => {
    expect(compressIpv6('2001:0db8:0000:0000:0000:ff00:0042:8329')).toBe('2001:db8::ff00:42:8329')
    expect(compressIpv6('2001:db8:0:0:1:0:0:1')).toBe('2001:db8::1:0:0:1')
    expect(compressIpv6('2001:db8:0:1:1:1:1:1')).toBe('2001:db8:0:1:1:1:1:1')
    expect(compressIpv6('0:0:0:0:0:0:0:1')).toBe('::1')
    expect(compressIpv6('::')).toBe('::')
  })

  it('expande y rechaza direcciones inválidas', () => {
    expect(expandIpv6('fe80::1')).toBe('fe80:0000:0000:0000:0000:0000:0000:0001')
    expect(expandIpv6('2001::db8::1')).toBeUndefined()
    expect(expandIpv6('2001:db8:12345::1')).toBeUndefined()
    expect(expandIpv6('1:2:3:4:5:6:7:8:9')).toBeUndefined()
  })

  it('tipo, prefijo de red y EUI-64', () => {
    expect(ipv6Kind('fe80::1')).toBe('enlace local')
    expect(ipv6Kind('2001:db8::1')).toBe('documentación')
    expect(ipv6Kind('2800:3f0::1')).toBe('unicast global')
    expect(ipv6Kind('fd00::1')).toMatch(/ULA/)
    expect(ipv6Network('2001:db8:acad:10:abcd::25', 64)).toBe('2001:db8:acad:10::')
    expect(ipv6Network('2001:db8:acad:10::25', 48)).toBe('2001:db8:acad::')
    expect(eui64('00:1A:2B:3C:4D:5E')).toBe('21a:2bff:fe3c:4d5e')
  })
})
