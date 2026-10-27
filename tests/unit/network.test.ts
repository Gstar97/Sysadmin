import { describe, expect, it } from 'vitest'
import { checkObjective, createIosSession, verifyIos } from '@/engines/network'
import { formatIpv4 } from '@/engines/network/ip'
import { Network, normalizeIfName, shortIfName } from '@/engines/network/model'
import { topologySpecSchema, type TopologySpec } from '@/engines/network/schema'

function vlanLab(overrides: (spec: TopologySpec) => void = () => undefined): Network {
  const spec = topologySpecSchema.parse({
    dispositivos: [
      { id: 'PC1', tipo: 'pc', interfaces: [{ nombre: 'eth0', ip: '192.168.10.10/24' }], puerta_enlace: '192.168.10.1' },
      { id: 'PC2', tipo: 'pc', interfaces: [{ nombre: 'eth0', ip: '192.168.20.10/24' }], puerta_enlace: '192.168.20.1' },
      { id: 'PC3', tipo: 'pc', interfaces: [{ nombre: 'eth0', ip: '192.168.10.11/24' }], puerta_enlace: '192.168.10.1' },
      {
        id: 'SW1',
        tipo: 'switch',
        vlans: [{ id: 10 }, { id: 20 }],
        interfaces: [
          { nombre: 'Fa0/1', modo: 'acceso', vlan: 10 },
          { nombre: 'Fa0/2', modo: 'acceso', vlan: 20 },
          { nombre: 'Gi0/1', modo: 'troncal' },
          { nombre: 'Gi0/2', modo: 'troncal' },
        ],
      },
      { id: 'SW2', tipo: 'switch', vlans: [{ id: 10 }, { id: 20 }], interfaces: [{ nombre: 'Fa0/1', modo: 'acceso', vlan: 10 }, { nombre: 'Gi0/1', modo: 'troncal' }] },
      {
        id: 'R1',
        tipo: 'router',
        interfaces: [
          { nombre: 'G0/0', subinterfaces: [{ nombre: 'G0/0.10', vlan: 10, ip: '192.168.10.1/24' }, { nombre: 'G0/0.20', vlan: 20, ip: '192.168.20.1/24' }] },
        ],
      },
    ],
    enlaces: [
      { a: 'PC1:eth0', b: 'SW1:Fa0/1' },
      { a: 'PC2:eth0', b: 'SW1:Fa0/2' },
      { a: 'SW1:Gi0/1', b: 'R1:G0/0' },
      { a: 'SW1:Gi0/2', b: 'SW2:Gi0/1' },
      { a: 'PC3:eth0', b: 'SW2:Fa0/1' },
    ],
  })
  overrides(spec)
  return new Network(spec)
}

describe('nombres de interfaz', () => {
  it('normaliza abreviaturas como IOS', () => {
    expect(normalizeIfName('g0/1')).toBe('GigabitEthernet0/1')
    expect(normalizeIfName('Gi 0/1')).toBe('GigabitEthernet0/1')
    expect(normalizeIfName('fa0/24')).toBe('FastEthernet0/24')
    expect(normalizeIfName('g0/0.10')).toBe('GigabitEthernet0/0.10')
    expect(normalizeIfName('lo0')).toBe('Loopback0')
    expect(normalizeIfName('eth0', 'pc')).toBe('eth0')
    expect(shortIfName('GigabitEthernet0/1')).toBe('Gi0/1')
    expect(shortIfName('FastEthernet0/1', 'trunk')).toBe('Fa0/1')
  })
})

describe('capa 2 y capa 3', () => {
  it('misma VLAN a través de un troncal entre switches', () => {
    const r = vlanLab().ping('PC1', 'PC3')
    expect(r.ok).toBe(true)
    expect(r.forward[0].via).toEqual(['SW1', 'SW2'])
  })

  it('router-on-a-stick comunica VLAN distintas', () => {
    const r = vlanLab().ping('PC1', 'PC2')
    expect(r.ok).toBe(true)
    expect(r.forward.map((h) => h.to)).toEqual(['R1', 'PC2'])
  })

  it('un troncal que no permite la VLAN corta la comunicación y lo explica', () => {
    const net = vlanLab((s) => {
      s.dispositivos[3].interfaces[3].vlans_permitidas = [20]
    })
    const r = net.ping('PC1', 'PC3')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/no permite la VLAN 10/)
  })

  it('un puerto en la VLAN equivocada deja al equipo aislado', () => {
    const net = vlanLab((s) => {
      s.dispositivos[4].interfaces[0].vlan = 20
    })
    expect(net.ping('PC1', 'PC3').ok).toBe(false)
  })

  it('sin puerta de enlace no sale de su red', () => {
    const net = vlanLab((s) => {
      delete s.dispositivos[0].puerta_enlace
    })
    const r = net.ping('PC1', 'PC2')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/no tiene puerta de enlace/)
  })

  it('una interfaz apagada se informa como causa', () => {
    const net = vlanLab((s) => {
      s.dispositivos[5].interfaces[0].apagada = true
    })
    const r = net.ping('PC1', 'PC2')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/apagada|ARP/)
  })

  it('DTP: dynamic auto forma troncal si el otro extremo es trunk', () => {
    const net = vlanLab((s) => {
      delete s.dispositivos[4].interfaces[1].modo
    })
    const sw2 = net.device('SW2')!
    expect(net.effectiveMode(sw2, net.port(sw2, 'Gi0/1')!)).toBe('trunk')
    expect(net.ping('PC1', 'PC3').ok).toBe(true)
  })

  it('objetivos de conectividad esperada y bloqueada', () => {
    const net = vlanLab()
    expect(checkObjective(net, { desde: 'PC1', hacia: 'PC2', resultado: 'ok' }).ok).toBe(true)
    expect(checkObjective(net, { desde: 'PC1', hacia: 'PC2', resultado: 'falla' }).ok).toBe(false)
  })
})

describe('enrutamiento', () => {
  const spec = topologySpecSchema.parse({
    dispositivos: [
      { id: 'A', tipo: 'pc', interfaces: [{ nombre: 'eth0', ip: '10.1.0.10/24' }], puerta_enlace: '10.1.0.1' },
      { id: 'B', tipo: 'pc', interfaces: [{ nombre: 'eth0', ip: '10.3.0.10/24' }], puerta_enlace: '10.3.0.1' },
      { id: 'R1', tipo: 'router', interfaces: [{ nombre: 'G0/0', ip: '10.1.0.1/24' }, { nombre: 'G0/1', ip: '10.2.0.1/30' }], ospf: { router_id: '1.1.1.1', redes: [{ red: '10.0.0.0', wildcard: '0.255.255.255' }] } },
      { id: 'R2', tipo: 'router', interfaces: [{ nombre: 'G0/0', ip: '10.3.0.1/24' }, { nombre: 'G0/1', ip: '10.2.0.2/30' }], ospf: { router_id: '2.2.2.2', redes: [{ red: '10.0.0.0', wildcard: '0.255.255.255' }] } },
    ],
    enlaces: [
      { a: 'A:eth0', b: 'R1:G0/0' },
      { a: 'B:eth0', b: 'R2:G0/0' },
      { a: 'R1:G0/1', b: 'R2:G0/1' },
    ],
  })

  it('OSPF forma adyacencia y aprende las redes remotas', () => {
    const net = new Network(spec)
    const r1 = net.device('R1')!
    expect(net.ospfNeighbors(r1).map((n) => formatIpv4(n.rid))).toEqual(['2.2.2.2'])
    const o = net.routingTable(r1).find((r) => r.code === 'O')!
    expect(`${formatIpv4(o.net)}/${o.prefix} via ${formatIpv4(o.nextHop!)}`).toBe('10.3.0.0/24 via 10.2.0.2')
    expect(net.ping('A', 'B').ok).toBe(true)
  })

  it('con áreas distintas no hay adyacencia', () => {
    const s2 = structuredClone(spec)
    s2.dispositivos[3].ospf!.redes = [{ red: '10.0.0.0', wildcard: '0.255.255.255', area: 1 }]
    const net = new Network(s2)
    expect(net.ospfNeighbors(net.device('R1')!)).toHaveLength(0)
    expect(net.ping('A', 'B').ok).toBe(false)
  })

  it('rutas estáticas en ambos sentidos', () => {
    const s2 = structuredClone(spec)
    delete s2.dispositivos[2].ospf
    delete s2.dispositivos[3].ospf
    expect(new Network(s2).ping('A', 'B').ok).toBe(false)
    s2.dispositivos[2].rutas = [{ destino: '10.3.0.0/24', via: '10.2.0.2' }]
    const ida = new Network(s2).ping('A', 'B')
    expect(ida.ok).toBe(false)
    expect(ida.reason).toMatch(/la respuesta no vuelve/)
    s2.dispositivos[3].rutas = [{ destino: '0.0.0.0/0', via: '10.2.0.1' }]
    expect(new Network(s2).ping('A', 'B').ok).toBe(true)
  })
})

describe('consola IOS', () => {
  const state = {
    consola: 'R1',
    topologia: {
      dispositivos: [
        { id: 'R1', tipo: 'router', nombre: 'Router' },
        { id: 'PC1', tipo: 'pc', interfaces: [{ nombre: 'eth0', ip: '192.168.1.10/24' }], puerta_enlace: '192.168.1.1' },
      ],
      enlaces: [{ a: 'R1:G0/0', b: 'PC1:eth0' }],
    },
  }
  const out = async (s: ReturnType<typeof createIosSession>, line: string) => (await s.run(line)).chunks.map((c) => c.text).join('')

  it('modos, abreviaturas y prompt', async () => {
    const s = createIosSession(state)
    expect(s.prompt()).toBe('Router>')
    await out(s, 'en')
    expect(s.prompt()).toBe('Router#')
    await out(s, 'conf t')
    await out(s, 'hostname R1')
    expect(s.prompt()).toBe('R1(config)#')
    await out(s, 'int g0/0')
    expect(s.prompt()).toBe('R1(config-if)#')
    await out(s, 'ip add 192.168.1.1 255.255.255.0')
    const ev = await out(s, 'no shut')
    expect(ev).toMatch(/changed state to up/)
    await out(s, 'end')
    expect(await out(s, 'ping 192.168.1.10')).toMatch(/Success rate is \d+ percent \([45]\/5\)/)
    expect(await out(s, 'sh ip int br')).toMatch(/GigabitEthernet0\/0\s+192\.168\.1\.1\s+YES manual up\s+up/)
  })

  it('errores con el formato de IOS', async () => {
    const s = createIosSession(state)
    await out(s, 'enable')
    expect(await out(s, 'co')).toMatch(/% Ambiguous command:\s+"co"/)
    await out(s, 'configure terminal')
    const bad = await out(s, 'ip adress 1.1.1.1')
    expect(bad).toMatch(/% Invalid input detected at '\^' marker\./)
    // El ^ queda debajo de la palabra mal escrita (prompt "Router(config)#" + "ip ").
    expect(bad.split('\n')[0].indexOf('^')).toBe('Router(config)#ip '.length)
    expect(await out(s, 'interface')).toMatch(/% Incomplete command/)
  })

  it('running-config, guardado y reload', async () => {
    const s = createIosSession(state)
    for (const l of ['en', 'conf t', 'hostname R1', 'enable secret Clave.123', 'service password-encryption', 'line con 0', 'password consola', 'login', 'end']) await out(s, l)
    const run = await out(s, 'show running-config')
    expect(run).toMatch(/hostname R1/)
    expect(run).toMatch(/enable secret 5 \$1\$/)
    expect(run).toMatch(/password 7 [0-9A-F]+/)
    expect(verifyIos(s, { guardado: true }).ok).toBe(false)
    await out(s, 'copy running-config startup-config')
    expect(verifyIos(s, { guardado: true }).ok).toBe(true)
    await out(s, 'conf t')
    await out(s, 'hostname OTRO')
    await out(s, 'end')
    await out(s, 'reload')
    expect(s.dev.hostname).toBe('R1')
  })

  it('ayuda con ? y autocompletado', async () => {
    const s = createIosSession(state)
    await out(s, 'enable')
    const r = await s.run('show ip ?')
    expect(r.chunks[0].text).toMatch(/route/)
    expect(r.refill).toBe('show ip ')
    expect(s.complete('conf')).toBe('configure ')
  })

  it('crear VLAN al asignarla a un puerto, como IOS', async () => {
    const s = createIosSession({
      consola: 'SW1',
      topologia: { dispositivos: [{ id: 'SW1', tipo: 'switch' }], enlaces: [] },
    })
    for (const l of ['en', 'conf t', 'int fa0/5', 'switchport mode access']) await out(s, l)
    expect(await out(s, 'switchport access vlan 30')).toMatch(/Creating vlan 30/)
    expect(verifyIos(s, { vlan: 30 }).ok).toBe(true)
    expect(verifyIos(s, { interfaz: 'Fa0/5', modo: 'acceso', vlan: 30 }).ok).toBe(true)
  })
})
