import { describe, expect, it } from 'vitest'
import { ESCENARIOS, escenario, info } from '@/engines/captura/model'
import { FilterError, compileBpf, compileDisplay } from '@/engines/captura/filtros'
import { detalle, seguirTcp, tcpdumpLine } from '@/engines/captura/salida'
import { checkCapturaExercise } from '@/engines/exercise-check'
import { capturaExerciseSchema } from '@/content/exercise-schemas'
import { createBashSession, stripAnsi } from '@/engines/shell'

const web = escenario('visita-web')!
const nums = (pred: (p: (typeof web.paquetes)[number]) => boolean, esc = web) => esc.paquetes.filter(pred).map((p) => p.n)

describe('Escenarios de captura', () => {
  it('todos existen y numeran sus paquetes en orden', () => {
    for (const id of ESCENARIOS) {
      const e = escenario(id)!
      expect(e.paquetes.length).toBeGreaterThan(10)
      e.paquetes.forEach((p, i) => {
        expect(p.n).toBe(i + 1)
        if (i) expect(p.t).toBeGreaterThan(e.paquetes[i - 1].t)
      })
    }
    expect(escenario('no-existe')).toBeUndefined()
  })
  it('la visita web sigue el orden DHCP, ARP, DNS, TCP y TLS', () => {
    const first = (pred: (p: (typeof web.paquetes)[number]) => boolean) => web.paquetes.findIndex(pred)
    const order = [first((p) => !!p.dhcp), first((p) => !!p.arp), first((p) => !!p.dns), first((p) => !!p.tcp?.flags.includes('S')), first((p) => !!p.tls)]
    expect(order.every((x) => x >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
  it('en el caso de MTU la página grande nunca recibe datos y el ping con DF grande falla', () => {
    const mtu = escenario('mtu')!
    const big = mtu.paquetes.filter((p) => p.tcp?.stream === 1)
    expect(big.some((p) => p.tls?.records.includes('Client Hello'))).toBe(true)
    expect(big.filter((p) => p.ip!.src === '10.2.0.50' && p.tcp!.len > 0)).toHaveLength(0)
    const frag = mtu.paquetes.find((p) => p.icmp?.type === 3)!
    expect(frag.icmp!.mtu).toBe(1420)
    expect(tcpdumpLine(frag)).toContain('ICMP 10.2.0.50 unreachable - need to frag (mtu 1420)')
  })
})

describe('Filtros BPF (tcpdump)', () => {
  it('host, puertos, protocolos y operadores', () => {
    expect(nums(compileBpf('udp port 53'))).toEqual(nums((p) => !!p.dns))
    expect(nums(compileBpf('arp'))).toEqual(nums((p) => !!p.arp))
    expect(nums(compileBpf('host 192.168.10.80 and tcp'))).toEqual(nums((p) => !!p.tcp && (p.ip?.src === '192.168.10.80' || p.ip?.dst === '192.168.10.80')))
    expect(nums(compileBpf('tcp and not port 443'))).toEqual(nums((p) => !!p.tcp && p.tcp.dport !== 443 && p.tcp.sport !== 443))
    expect(nums(compileBpf('port 67 or port 68'))).toEqual(nums((p) => !!p.dhcp))
    expect(nums(compileBpf('tcp[tcpflags] & tcp-syn != 0'))).toEqual(nums((p) => !!p.tcp?.flags.includes('S')))
    expect(nums(compileBpf('net 192.168.10.0/24 and icmp'), escenario('dns-falla')!)).toHaveLength(4)
  })
  it('avisa los errores como tcpdump', () => {
    expect(() => compileBpf('port 53 an host')).toThrow(FilterError)
    expect(() => compileBpf('host')).toThrow(/syntax error/)
  })
})

describe('Filtros de visualización (Wireshark)', () => {
  it('campos, comparaciones y contains', () => {
    expect(nums(compileDisplay('dns'))).toEqual(nums((p) => !!p.dns))
    expect(nums(compileDisplay('ip.addr == 192.168.10.80 && http'))).toEqual([43, 44])
    expect(nums(compileDisplay('dns.qry.name contains "intranet"'))).toEqual([38, 39])
    expect(nums(compileDisplay('tls.handshake.type == 1'))).toHaveLength(1)
    expect(nums(compileDisplay('tcp.analysis.retransmission'), escenario('retransmisiones')!)).toHaveLength(5)
    expect(nums(compileDisplay('dns.flags.rcode != 0'), escenario('dns-falla')!)).toHaveLength(3)
    expect(nums(compileDisplay('ip.dst == 10.2.0.0/24 and tcp.flags.syn == 1 and tcp.flags.ack == 0'), escenario('retransmisiones')!)).toHaveLength(6)
  })
  it('!= es lo contrario de == aun con campos de dos valores (como desde Wireshark 3.6)', () => {
    const conIp = web.paquetes.filter((p) => p.ip)
    const sinDns = nums(compileDisplay('ip.addr != 192.168.10.53'))
    expect(sinDns).toEqual(conIp.filter((p) => p.ip!.src !== '192.168.10.53' && p.ip!.dst !== '192.168.10.53').map((p) => p.n))
    expect(nums(compileDisplay('!(ip.addr == 192.168.10.53)')).length).toBe(sinDns.length + web.paquetes.filter((p) => !p.ip).length)
  })
  it('explica los errores típicos', () => {
    expect(() => compileDisplay('ip.addr = 10.0.0.1')).toThrow(/==/)
    expect(() => compileDisplay('ip.adr == 10.0.0.1')).toThrow(/ip\./)
    expect(() => compileDisplay('dns tcp')).toThrow(/&&/)
  })
})

describe('Salida y conversaciones', () => {
  it('tcpdump, detalle y la conversación HTTP en texto', () => {
    expect(tcpdumpLine(web.paquetes[6])).toMatch(/IP 192\.168\.10\.100\.\d+ > 192\.168\.10\.53\.53: \d+\+ A\? www\.ejemplo\.com\.ar\. \(\d+\)/)
    expect(info(web.paquetes[4])).toBe('Who has 192.168.10.53? Tell 192.168.10.100')
    expect(detalle(web.paquetes[15]).some((s) => s.lineas.some((l) => l.includes('Server Name Indication: www.ejemplo.com.ar')))).toBe(true)
    const http = seguirTcp(web.paquetes, 1)
    expect(http.lineas[0]).toMatchObject({ de: 'cliente' })
    expect(http.lineas[0].texto).toContain('GET / HTTP/1.1')
    expect(http.lineas[1].texto).toContain('200 OK')
    expect(seguirTcp(web.paquetes, 0).lineas[0].texto).toMatch(/cifrados/)
  })
})

describe('tcpdump y mtr en la terminal', () => {
  const run = async (sh: ReturnType<typeof createBashSession>, c: string) => {
    const r = await sh.run(c)
    return { code: r.chunks.some((x) => x.stream === 'err' && /error|permission/i.test(x.text)) ? 1 : 0, text: stripAnsi(r.chunks.map((x) => x.text).join('')) }
  }
  const estado = (usuario: string) => ({ usuario, paquetes: { instalados: ['tcpdump', 'mtr'] }, red: { interfaces: [{ nombre: 'enp0s3', ip: '192.168.10.100/24' }], puerta_enlace: '192.168.10.1', trafico: 'visita-web', saltos: { '10.2.0.50': [{ ip: '192.168.10.1', perdida: 0, ms: 0.4 }, { ip: '10.99.0.1', perdida: 60, ms: 18 }, { ip: '10.2.0.50', perdida: 0, ms: 21 }] } } })
  it('captura en vivo con filtro, guarda con -w y lee con -r sin ser root', async () => {
    const root = createBashSession(estado('root') as never)
    const live = await run(root, 'tcpdump -n -c 2 port 53')
    expect(live.text).toContain('listening on enp0s3')
    expect(live.text).toContain('2 packets captured')
    expect(live.text.match(/ > /g)).toHaveLength(2)
    expect((await run(root, 'tcpdump -nn -w /tmp/web.pcap tcp port 80')).code).toBe(0)
    await run(root, 'chmod 644 /tmp/web.pcap')
    const user = createBashSession(estado('ana') as never)
    expect((await run(user, 'tcpdump -n')).text).toContain("You don't have permission")
  })
  it('-r aplica el filtro guardado y el nuevo', async () => {
    const root = createBashSession(estado('root') as never)
    await run(root, 'tcpdump -nn -w /root/w.pcap host 192.168.10.80')
    const r = await run(root, "tcpdump -n -r /root/w.pcap 'tcp[tcpflags] & tcp-syn != 0'")
    expect(r.text).toContain('reading from file /root/w.pcap')
    expect(r.text.match(/Flags \[S/g)).toHaveLength(2)
    expect((await run(root, 'tcpdump -n port 53 an host')).code).toBe(1)
  })
  it('mtr muestra los saltos declarados con su pérdida', async () => {
    const root = createBashSession(estado('root') as never)
    const r = await run(root, 'mtr -rwc 10 10.2.0.50')
    expect(r.text).toMatch(/2\.\|-- 10\.99\.0\.1\s+60\.0%/)
    expect(r.text).toMatch(/3\.\|-- 10\.2\.0\.50\s+0\.0%/)
    expect((await run(root, 'mtr -rw 1.1.1.1')).text).toContain('1.|-- 192.168.10.1')
  })
})

describe('Ejercicios de captura', () => {
  it('valida filtros de solución, números de paquete y respuestas', () => {
    const ok = capturaExerciseSchema.parse({ tipo: 'captura', escenario: 'visita-web', tareas: [{ tipo: 'filtro', consigna: 'x', solucion: 'dns' }, { tipo: 'paquete', consigna: 'x', paquete: 13 }, { tipo: 'pregunta', consigna: 'x', opciones: ['a', 'b'], correcta: 1, explicacion: 'y' }] })
    expect(checkCapturaExercise(ok)).toEqual([])
    const bad = capturaExerciseSchema.parse({ tipo: 'captura', escenario: 'visita-web', tareas: [{ tipo: 'filtro', consigna: 'x', solucion: 'dns = 1' }, { tipo: 'paquete', consigna: 'x', paquete: 400 }, { tipo: 'pregunta', consigna: 'x', opciones: ['a', 'b'], correcta: 2, explicacion: 'y' }] })
    expect(checkCapturaExercise(bad).filter((p) => p.level === 'error')).toHaveLength(3)
    expect(checkCapturaExercise({ ...ok, escenario: 'nada' })[0].message).toContain('no existe')
  })
})
