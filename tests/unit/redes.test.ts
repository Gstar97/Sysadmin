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
