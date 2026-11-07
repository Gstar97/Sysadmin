import { describe, expect, it } from 'vitest'
import { createRng } from '@/lib/random'
import { bestRoute, contains, randomInstalada, randomSalida, type RutaTabla } from '@/engines/redes/rutas'
import { GRAFO_EJEMPLO, dvDetectar, dvInicial, dvPaso, igualTabla, lsPaso, lsTablas, tablasCorrectas, type Grafo } from '@/engines/redes/convergencia'
import { validateFrr } from '@/engines/config/frr'
import { createBashSession, stripAnsi, verifyBash } from '@/engines/shell'
import { createIosSession } from '@/engines/network'

const r = (net: string, prefix: number): RutaTabla => ({ code: 'S', net, prefix, iface: 'Gi0/1', via: '10.0.0.1', ad: 1, metric: 0 })

describe('Decisión de un router', () => {
  it('gana el prefijo más largo, y sin coincidencia se descarta', () => {
    const t = [r('0.0.0.0', 0), r('10.20.0.0', 16), r('10.20.5.0', 24), r('10.20.5.128', 25)]
    expect(bestRoute(t, '10.20.5.140')).toBe(3)
    expect(bestRoute(t, '10.20.5.20')).toBe(2)
    expect(bestRoute(t, '10.20.99.1')).toBe(1)
    expect(bestRoute(t, '8.8.8.8')).toBe(0)
    expect(bestRoute(t.slice(1), '8.8.8.8')).toBeUndefined()
    expect(contains(r('192.168.1.0', 24), '192.168.2.1')).toBe(false)
  })
  it('los ejercicios al azar tienen una respuesta coherente', () => {
    const rng = createRng(3)
    for (let i = 0; i < 200; i++) {
      const q = randomSalida(rng)
      expect(q.answer).toBe(bestRoute(q.table, q.dest))
      const c = randomInstalada(rng)
      const w = c.candidatas[c.answer]
      expect(c.candidatas.every((x) => x.ad > w.ad || (x.ad === w.ad && x.metric >= w.metric))).toBe(true)
    }
  })
})

describe('Convergencia', () => {
  const ok = (t: ReturnType<typeof dvInicial>, g: Grafo) => g.nodos.every((n) => igualTabla(t[n], tablasCorrectas(g)[n]))
  it('vector distancia converge desde cero y después de cortar un enlace', () => {
    const g = structuredClone(GRAFO_EJEMPLO)
    let t = dvInicial(g)
    let steps = 0
    while (!ok(t, g) && steps < 20) {
      t = dvPaso(g, t)
      steps++
    }
    expect(ok(t, g)).toBe(true)
    const g2 = structuredClone(g)
    g2.enlaces[0].up = false
    let t2 = dvDetectar(g2, t)
    expect(ok(t2, g2)).toBe(false)
    for (let i = 0; i < 20 && !ok(t2, g2); i++) t2 = dvPaso(g2, t2)
    expect(ok(t2, g2)).toBe(true)
  })
  it('estado de enlace: el aviso se inunda y cada uno recalcula', () => {
    const g2 = structuredClone(GRAFO_EJEMPLO)
    g2.enlaces[2].up = false
    let en = new Set([g2.enlaces[2].a, g2.enlaces[2].b])
    expect(ok(lsTablas(GRAFO_EJEMPLO, g2, en), g2)).toBe(false)
    for (let i = 0; i < 5; i++) en = lsPaso(g2, en)
    expect(ok(lsTablas(GRAFO_EJEMPLO, g2, en), g2)).toBe(true)
  })
})

describe('FRRouting', () => {
  it('acepta una configuración correcta y avisa la sintaxis de IOS', () => {
    const good = 'frr version 10.4.1\nhostname gw\n!\nrouter ospf\n ospf router-id 2.2.2.2\n network 10.0.12.0/30 area 0\n passive-interface enp0s8\nexit\n'
    expect(validateFrr(good).diagnostics).toEqual([])
    const bad = validateFrr('router ospf\n network 10.0.12.0 0.0.0.3 area 0\n ospf router-id 2.2.2\nexit\nnetwork 10.0.0.0/8 area 0\n').diagnostics
    expect(bad.filter((d) => d.severity === 'error')).toHaveLength(3)
  })
})

describe('Rutas estáticas en Linux', () => {
  const state = {
    usuario: 'root',
    red: {
      interfaces: [{ nombre: 'enp0s3', ip: '192.168.10.20/24' }],
      puerta_enlace: '192.168.10.1',
      redes_remotas: [{ red: '10.2.0.0/24', via: '192.168.10.2' }],
    },
  }
  it('una red de otra sede responde solo por su router', async () => {
    const sh = createBashSession(state)
    expect(verifyBash(sh, { alcanza: '10.2.0.50', resultado: 'ok' }).ok).toBe(false)
    const get = await sh.run('ip route get 10.2.0.50')
    expect(stripAnsi(get.chunks.map((c) => c.text).join(''))).toContain('via 192.168.10.1')
    await sh.run('ip route add 10.2.0.0/24 via 192.168.10.2')
    expect(verifyBash(sh, { alcanza: '10.2.0.50', resultado: 'ok' }).ok).toBe(true)
    expect(verifyBash(sh, { ruta: '10.2.0.0/24', via: '192.168.10.2', persistente: false }).ok).toBe(true)
    const bad = await sh.run('ip route add 10.9.0.0/24 via 172.16.0.1')
    expect(bad.chunks.map((c) => c.text).join('')).toContain('Nexthop has invalid gateway')
    const host = await sh.run('ip route add 10.3.0.5/24 via 192.168.10.2')
    expect(host.chunks.map((c) => c.text).join('')).toContain('Invalid prefix')
  })
  it('nmcli guarda la ruta en la conexión', async () => {
    const sh = createBashSession(state)
    await sh.run('nmcli connection modify enp0s3 +ipv4.routes "10.2.0.0/24 192.168.10.2"')
    expect(verifyBash(sh, { ruta: '10.2.0.0/24' }).ok).toBe(false)
    await sh.run('nmcli connection up enp0s3')
    expect(verifyBash(sh, { ruta: '10.2.0.0/24', persistente: true }).ok).toBe(true)
    const out = await sh.run('ip route')
    expect(out.chunks.map((c) => c.text).join('')).toContain('10.2.0.0/24 via 192.168.10.2 dev enp0s3 proto static metric 100')
  })
})

describe('IOS: show ip route con una IP y rutas flotantes', () => {
  it('muestra la entrada que gana y "Network not in table" sin coincidencia', async () => {
    const s = createIosSession({
      consola: 'R1',
      topologia: {
        dispositivos: [
          { id: 'R1', tipo: 'router', interfaces: [{ nombre: 'Gi0/0', ip: '10.0.12.1/30' }, { nombre: 'Gi0/1', ip: '10.0.21.1/30' }] },
          { id: 'R2', tipo: 'router', interfaces: [{ nombre: 'Gi0/0', ip: '10.0.12.2/30' }, { nombre: 'Gi0/1', ip: '10.0.21.2/30' }] },
        ],
        enlaces: [
          { a: 'R1:Gi0/0', b: 'R2:Gi0/0' },
          { a: 'R1:Gi0/1', b: 'R2:Gi0/1' },
        ],
      },
    })
    const text = async (c: string) => (await s.run(c)).chunks.map((x) => x.text).join('')
    await text('enable')
    await text('configure terminal')
    await text('ip route 10.2.0.0 255.255.255.0 10.0.21.2 5')
    await text('ip route 10.2.0.0 255.255.255.0 10.0.12.2')
    const entry = await text('do show ip route 10.2.0.9')
    expect(entry).toContain('Known via "static", distance 1')
    expect(await text('do show ip route 8.8.8.8')).toContain('% Network not in table')
    const routes = s.net.routingTable(s.net.device('R1')!).filter((r) => r.prefix === 24)
    expect(routes).toHaveLength(1)
    await text('interface gi0/0')
    await text('shutdown')
    expect(await text('do show ip route 10.2.0.9')).toContain('distance 5')
  })
})
