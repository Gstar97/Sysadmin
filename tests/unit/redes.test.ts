import { describe, expect, it } from 'vitest'
import { createRng } from '@/lib/random'
import { generatePoeExercise, poeBudget, standardFor } from '@/engines/redes/poe'
import { BROADCAST, sendFrame, age, type MacEntry, type SwitchHost } from '@/engines/redes/macswitch'
import { inbound, newNat, outbound } from '@/engines/redes/nat'
import { checkVlsm, classify, randomAddress, randomVlsm, vlsmSolution } from '@/engines/redes/addressing'
import { parseZone, checkzoneOutput } from '@/engines/config/zone'
import { parseNamed } from '@/engines/config/named'
import { parseKea } from '@/engines/config/kea'

describe('PoE', () => {
  it('elige el estándar más chico que alcanza', () => {
    expect(standardFor(5)).toBe('af')
    expect(standardFor(20)).toBe('at')
    expect(standardFor(40)).toBe('bt3')
    expect(standardFor(70)).toBe('bt4')
    expect(standardFor(80)).toBeUndefined()
  })
  it('reserva por clase y detecta lo que el switch no puede alimentar', () => {
    const r = poeBudget([{ id: 'ap', nombre: 'AP', watts: 20, cantidad: 4 }, { id: 'ptz', nombre: 'PTZ', watts: 55, cantidad: 1 }], 125, 8, 'at')
    expect(r.reservado).toBe(120)
    expect(r.sinPoe).toHaveLength(1)
  })
  it('los ejercicios al azar son coherentes', () => {
    const rng = createRng(3)
    for (let i = 0; i < 200; i++) {
      const e = generatePoeExercise(rng)
      expect(e.explicacion.at(-1)).toMatch(e.alcanza ? /^Alcanza/ : /^No alcanza/)
    }
  })
})

describe('switch aprendiendo MAC', () => {
  const a: SwitchHost = { id: 'a', nombre: 'A', mac: 'aa:aa:aa:aa:aa:01', puerto: 1 }
  const b: SwitchHost = { id: 'b', nombre: 'B', mac: 'aa:aa:aa:aa:aa:02', puerto: 2 }
  it('inunda lo desconocido, reenvía lo conocido y descarta lo del mismo puerto', () => {
    let t: MacEntry[] = []
    let r = sendFrame(t, 4, a, b.mac)
    expect(r.accion).toEqual({ tipo: 'inundar', puertos: [2, 3, 4] })
    t = r.tabla
    r = sendFrame(t, 4, b, a.mac)
    expect(r.accion).toEqual({ tipo: 'reenviar', puerto: 1 })
    t = r.tabla
    r = sendFrame(t, 4, { ...b, mac: 'aa:aa:aa:aa:aa:03', puerto: 1 }, a.mac)
    expect(r.accion.tipo).toBe('descartar')
    expect(sendFrame(t, 4, a, BROADCAST).accion.tipo).toBe('inundar')
    expect(age(t, 400)).toHaveLength(0)
  })
})

describe('NAT', () => {
  it('PAT cambia el puerto si ya está usado y lo de afuera solo entra con redirección', () => {
    let s = newNat('203.0.113.7')
    s = outbound(s, '192.168.1.10', 50000, '142.250.78.14:443').state
    const r = outbound(s, '192.168.1.11', 50000, '142.250.78.14:443')
    expect(r.entry.externo).not.toBe('203.0.113.7:50000')
    expect(inbound(r.state, 443).ok).toBe(false)
    expect(inbound({ ...r.state, redirecciones: [{ proto: 'TCP', puerto: 443, hacia: '192.168.1.20:443' }] }, 443).ok).toBe(true)
    expect(inbound({ ...newNat('100.72.4.9', '181.30.2.2'), redirecciones: [{ proto: 'TCP', puerto: 443, hacia: 'x' }] }, 443).ok).toBe(false)
  })
})

describe('direcciones y VLSM', () => {
  it('clasifica, incluidas las trampas', () => {
    expect(classify('172.31.2.3')).toBe('privada')
    expect(classify('172.32.2.3')).toBe('publica')
    expect(classify('100.64.0.1')).toBe('cgnat')
    expect(classify('100.128.0.1')).toBe('publica')
    expect(classify('169.254.10.2')).toBe('apipa')
    expect(classify('203.0.113.5')).toBe('documentacion')
    const rng = createRng(1)
    for (let i = 0; i < 300; i++) {
      const r = randomAddress(rng)
      expect(classify(r.ip)).toBe(r.kind)
    }
  })
  it('la solución de referencia pasa su propia verificación', () => {
    const rng = createRng(9)
    for (let i = 0; i < 100; i++) {
      const { base, needs } = randomVlsm(rng)
      const sol = vlsmSolution(base, needs)!
      const answers = needs.map((n) => sol.find((s) => s.nombre === n.nombre)!.red)
      expect(checkVlsm(base, needs, answers).every((c) => c.ok)).toBe(true)
    }
  })
  it('detecta red mal alineada, tamaño insuficiente y solapamiento', () => {
    const needs = [{ nombre: 'A', hosts: 50 }, { nombre: 'B', hosts: 20 }]
    const r = checkVlsm('192.168.1.0/24', needs, ['192.168.1.10/26', '192.168.1.32/28'])
    expect(r[0].problemas.join()).toMatch(/no es una dirección de red/)
    expect(r[1].problemas.join()).toMatch(/necesita 20/)
    expect(r[1].problemas.join()).toMatch(/superpone/)
  })
})

describe('archivos de BIND y Kea', () => {
  it('zona: nombre sin punto final y CNAME con otros datos', () => {
    const z = parseZone('$TTL 1h\n@ IN SOA ns1 admin ( 1 1h 15m 1w 5m )\n  IN NS ns1.empresa.local\nns1 IN A 10.0.0.53\nwww IN CNAME web\nwww IN A 10.0.0.80\nweb IN A 10.0.0.80\n', 'empresa.local')
    const out = checkzoneOutput(z, 'db').text
    expect(out).toContain('CNAME and other data')
    const z2 = parseZone('$TTL 1h\n@ IN SOA ns1 admin ( 1 1h 15m 1w 5m )\n  IN NS ns1.empresa.local\nns1 IN A 10.0.0.53\n', 'empresa.local')
    expect(checkzoneOutput(z2, 'db').text).toContain("NS 'ns1.empresa.local.empresa.local' has no address records")
    const ok = parseZone('$TTL 1h\n@ IN SOA ns1 admin ( 7 1h 15m 1w 5m )\n  IN NS ns1\nns1 IN A 10.0.0.53\n', 'empresa.local')
    expect(checkzoneOutput(ok, 'db').text).toContain('loaded serial 7\nOK')
  })
  it('named.conf: falta punto y coma', () => {
    const r = parseNamed('options {\n  directory "/var/named"\n  recursion no;\n};\n')
    expect(r.problems[0].bind).toContain("missing ';' before 'recursion'")
  })
  it('Kea: id obligatorio, pool fuera de la subred y opción inexistente', () => {
    const r = parseKea('{ "Dhcp4": { "interfaces-config": { "interfaces": ["eth0"] }, "subnet4": [ { "subnet": "10.0.0.0/24", "pools": [ { "pool": "10.0.1.10 - 10.0.1.20" } ], "option-data": [ { "name": "router", "data": "10.0.0.1" } ] } ] } }')
    const msgs = r.problems.map((p) => p.kea).join('\n')
    expect(msgs).toContain("missing parameter 'id'")
    expect(msgs).toContain('does not match the prefix')
    expect(msgs).toContain("dhcp4.router' does not exist")
  })
})

import { Network } from '@/engines/network/model'
import { topologySpecSchema } from '@/engines/network/schema'
import { computeStp } from '@/engines/network/stp'

describe('switching: STP, BPDU Guard, EtherChannel y HSRP', () => {
  const tri = (extra: Record<string, unknown> = {}) =>
    new Network(
      topologySpecSchema.parse({
        dispositivos: [
          { id: 'SW1', tipo: 'switch', stp_prioridad: 4096 },
          { id: 'SW2', tipo: 'switch' },
          { id: 'SW3', tipo: 'switch' },
          { id: 'PC1', tipo: 'pc', interfaces: [{ nombre: 'eth0', ip: '10.0.0.1/24' }] },
          { id: 'PC2', tipo: 'pc', interfaces: [{ nombre: 'eth0', ip: '10.0.0.2/24' }] },
          ...((extra.dispositivos as unknown[]) ?? []),
        ],
        enlaces: [
          { a: 'SW1:Gi0/1', b: 'SW2:Gi0/1' },
          { a: 'SW1:Gi0/2', b: 'SW3:Gi0/1' },
          { a: 'SW2:Gi0/2', b: 'SW3:Gi0/2' },
          { a: 'PC1:eth0', b: 'SW2:Fa0/1' },
          { a: 'PC2:eth0', b: 'SW3:Fa0/1' },
          ...((extra.enlaces as unknown[]) ?? []),
        ],
      }),
    )
  it('elige la raíz por prioridad y bloquea un solo puerto del triángulo', () => {
    const net = tri()
    const stp = computeStp(net, 1)
    expect(stp.rootDev).toBe('SW1')
    const blocked = [...stp.switches.values()].flatMap((s) => [...s.ports.values()].filter((p) => !p.forwarding))
    expect(blocked).toHaveLength(1)
    expect(net.ping('PC1', 'PC2').ok).toBe(true)
  })
  it('BPDU Guard apaga el puerto al que se conecta un switch', () => {
    const net = new Network(
      topologySpecSchema.parse({
        dispositivos: [{ id: 'SW1', tipo: 'switch', interfaces: [{ nombre: 'Fa0/5', modo: 'acceso', portfast: true, bpduguard: true }] }, { id: 'MINI', tipo: 'switch' }],
        enlaces: [{ a: 'MINI:Fa0/1', b: 'SW1:Fa0/5' }],
      }),
    )
    const sw = net.device('SW1')!
    const p = net.port(sw, 'Fa0/5')!
    expect(net.physUp(sw, p)).toBe(false)
    expect(p.errDisabled).toBe(true)
  })
  it('EtherChannel solo se forma con modos compatibles', () => {
    const spec = (ma: string, mb: string) =>
      new Network(
        topologySpecSchema.parse({
          dispositivos: [
            { id: 'A', tipo: 'switch', interfaces: [{ nombre: 'Gi0/1', canal: { grupo: 1, modo: ma } }, { nombre: 'Gi0/2', canal: { grupo: 1, modo: ma } }] },
            { id: 'B', tipo: 'switch', interfaces: [{ nombre: 'Gi0/1', canal: { grupo: 1, modo: mb } }, { nombre: 'Gi0/2', canal: { grupo: 1, modo: mb } }] },
          ],
          enlaces: [
            { a: 'A:Gi0/1', b: 'B:Gi0/1' },
            { a: 'A:Gi0/2', b: 'B:Gi0/2' },
          ],
        }),
      )
    const ok = spec('active', 'passive')
    expect(ok.bundled(ok.device('A')!, ok.port(ok.device('A')!, 'Gi0/1')!)).toBe(true)
    const stp = computeStp(ok, 1)
    expect([...stp.switches.values()].every((s) => [...s.ports.values()].every((p) => p.forwarding))).toBe(true)
    const bad = spec('passive', 'passive')
    expect(bad.bundled(bad.device('A')!, bad.port(bad.device('A')!, 'Gi0/1')!)).toBe(false)
    const stp2 = computeStp(bad, 1)
    expect([...stp2.switches.values()].flatMap((s) => [...s.ports.values()]).some((p) => !p.forwarding)).toBe(true)
  })
  it('HSRP: si cae el router activo, el otro toma la IP virtual', () => {
    const net = new Network(
      topologySpecSchema.parse({
        dispositivos: [
          { id: 'SW', tipo: 'switch' },
          { id: 'PC', tipo: 'pc', interfaces: [{ nombre: 'eth0', ip: '10.0.0.11/24' }], puerta_enlace: '10.0.0.1' },
          { id: 'R1', tipo: 'router', interfaces: [{ nombre: 'Gi0/0', ip: '10.0.0.2/24', hsrp: { grupo: 1, ip: '10.0.0.1', prioridad: 110, preempt: true } }] },
          { id: 'R2', tipo: 'router', interfaces: [{ nombre: 'Gi0/0', ip: '10.0.0.3/24', hsrp: { grupo: 1, ip: '10.0.0.1' } }] },
        ],
        enlaces: [
          { a: 'PC:eth0', b: 'SW:Fa0/1' },
          { a: 'R1:Gi0/0', b: 'SW:Fa0/2' },
          { a: 'R2:Gi0/0', b: 'SW:Fa0/3' },
        ],
      }),
    )
    expect(net.hsrpActiveFor(1, 0x0a000001)?.dev.id).toBe('R1')
    expect(net.ping('PC', '10.0.0.1').ok).toBe(true)
    net.port(net.device('R1')!, 'Gi0/0')!.shutdown = true
    expect(net.hsrpActiveFor(1, 0x0a000001)?.dev.id).toBe('R2')
    expect(net.ping('PC', '10.0.0.1').ok).toBe(true)
  })
})
