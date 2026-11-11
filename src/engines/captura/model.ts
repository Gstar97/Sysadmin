/**
 * Capturas de tráfico simuladas: paquetes con sus capas (Ethernet, ARP, IP, TCP/UDP/ICMP y la
 * aplicación: DNS, DHCP, TLS, HTTP) armados a partir de escenarios. Las usan tcpdump en la
 * terminal y el visor de capturas (estilo Wireshark).
 */

export type TcpFlag = 'S' | 'A' | 'F' | 'R' | 'P'

export interface Pkt {
  n: number
  /** Segundos desde el comienzo de la captura. */
  t: number
  eth: { src: string; dst: string }
  arp?: { op: 'request' | 'reply'; sha: string; spa: string; tha: string; tpa: string }
  ip?: { src: string; dst: string; ttl: number; id: number; df: boolean; proto: 'tcp' | 'udp' | 'icmp' }
  tcp?: {
    sport: number
    dport: number
    flags: TcpFlag[]
    seq: number
    ack: number
    win: number
    len: number
    mss?: number
    /** Lo que Wireshark detecta solo: retransmisiones, ACK duplicados. */
    analysis?: 'retransmission' | 'duplicate_ack' | 'zero_window'
    stream: number
  }
  udp?: { sport: number; dport: number; len: number }
  icmp?: { type: number; code: number; id?: number; seq?: number; mtu?: number; orig?: string }
  dns?: { id: number; response: boolean; qname: string; qtype: 'A' | 'AAAA' | 'MX' | 'PTR' | 'NS'; rcode: 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL'; answers: string[] }
  dhcp?: { type: 'Discover' | 'Offer' | 'Request' | 'ACK' | 'NAK' | 'Release'; xid: string; client: string; yiaddr?: string; server?: string; router?: string; dns?: string; lease?: number; hostname?: string }
  tls?: { records: ('Client Hello' | 'Server Hello' | 'Change Cipher Spec' | 'Certificate' | 'Application Data' | 'Alert')[]; sni?: string; version: string }
  http?: { request?: string; host?: string; status?: string }
  /** Texto de la carga útil, si no está cifrada (para seguir la conversación). */
  payload?: string
  size: number
}

export interface Escenario {
  id: string
  titulo: string
  descripcion: string
  paquetes: Pkt[]
}

// -------------------------------------------------------------------------------------------
// Constructor de escenarios: arma las capas y lleva los números de secuencia de cada conexión.
// -------------------------------------------------------------------------------------------

interface Host {
  ip: string
  mac: string
}

class Builder {
  pkts: Pkt[] = []
  t = 0
  private ipId = 4000
  private streams = 0

  push(p: Omit<Pkt, 'n' | 't'>, dt = 0.0004) {
    this.t += dt
    this.pkts.push({ ...p, n: this.pkts.length + 1, t: +this.t.toFixed(6) })
    return this.pkts[this.pkts.length - 1]
  }

  ip(src: Host, dst: Host, proto: 'tcp' | 'udp' | 'icmp', ttl = 64, macDst = dst.mac, macSrc = src.mac) {
    return { eth: { src: macSrc, dst: macDst }, ip: { src: src.ip, dst: dst.ip, ttl, id: this.ipId++, df: proto === 'tcp', proto } }
  }

  arp(who: Host, target: Host, dt = 0.0003) {
    this.push({ eth: { src: who.mac, dst: 'ff:ff:ff:ff:ff:ff' }, arp: { op: 'request', sha: who.mac, spa: who.ip, tha: '00:00:00:00:00:00', tpa: target.ip }, size: 42 }, dt)
    this.push({ eth: { src: target.mac, dst: who.mac }, arp: { op: 'reply', sha: target.mac, spa: target.ip, tha: who.mac, tpa: who.ip }, size: 60 })
  }

  dns(client: Host, server: Host, gwMac: string | undefined, id: number, qname: string, qtype: 'A' | 'AAAA' | 'MX' | 'PTR' | 'NS', answers: string[], rcode: 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL' = 'NOERROR', delay = 0.012, sport = 40000 + (id % 20000)) {
    const qlen = 17 + qname.length + 1
    this.push({ ...this.ip(client, server, 'udp', 64, gwMac ?? server.mac), udp: { sport, dport: 53, len: qlen + 8 }, dns: { id, response: false, qname, qtype, rcode: 'NOERROR', answers: [] }, size: 42 + qlen }, 0.0006)
    if (delay < 0) return
    const alen = qlen + answers.length * 16
    this.push({ ...this.ip(server, client, 'udp', gwMac ? 57 : 64, client.mac, gwMac ?? server.mac), udp: { sport: 53, dport: sport, len: alen + 8 }, dns: { id, response: true, qname, qtype, rcode, answers }, size: 42 + alen }, delay)
  }

  /** Una conexión TCP: devuelve funciones para mandar datos en cada sentido y cerrar. */
  tcp(c: Host, s: Host, sport: number, dport: number, opts: { gwMac?: string; rtt?: number; ttlBack?: number; mss?: number } = {}) {
    const stream = this.streams++
    const rtt = opts.rtt ?? 0.02
    const cs = { seq: 1, ack: 0 }
    const ss = { seq: 1, ack: 0 }
    const ttlBack = opts.ttlBack ?? (opts.gwMac ? 52 : 64)
    const out = (flags: TcpFlag[], len: number, extra: Partial<NonNullable<Pkt['tcp']>> = {}, dt = 0.0003, more: Partial<Pkt> = {}) =>
      this.push({ ...this.ip(c, s, 'tcp', 64, opts.gwMac ?? s.mac), tcp: { sport, dport, flags, seq: cs.seq, ack: cs.ack, win: 64240, len, stream, ...extra }, size: 54 + len + (extra.mss ? 12 : 0), ...more }, dt)
    const back = (flags: TcpFlag[], len: number, extra: Partial<NonNullable<Pkt['tcp']>> = {}, dt = rtt, more: Partial<Pkt> = {}) =>
      this.push({ ...this.ip(s, c, 'tcp', ttlBack, c.mac, opts.gwMac ?? s.mac), tcp: { sport: dport, dport: sport, flags, seq: ss.seq, ack: ss.ack, win: 65160, len, stream, ...extra }, size: 54 + len + (extra.mss ? 12 : 0), ...more }, dt)
    return {
      stream,
      handshake: () => {
        out(['S'], 0, { seq: 0, ack: 0, mss: opts.mss ?? 1460 }, 0.0008)
        cs.seq = 1
        back(['S', 'A'], 0, { seq: 0, ack: 1, mss: 1460 })
        ss.seq = 1
        cs.ack = 1
        ss.ack = 1
        out(['A'], 0)
      },
      send: (len: number, more: Partial<Pkt> = {}, dt = 0.0004) => {
        out(['P', 'A'], len, {}, dt, more)
        cs.seq += len
        ss.ack = cs.seq
      },
      reply: (len: number, more: Partial<Pkt> = {}, dt = rtt) => {
        back(['P', 'A'], len, {}, dt, more)
        ss.seq += len
        cs.ack = ss.seq
      },
      ackOut: (dt = 0.0002) => out(['A'], 0, {}, dt),
      ackBack: (dt = rtt / 2) => back(['A'], 0, {}, dt),
      /** Repite el último segmento del servidor (se perdió en el camino). */
      retransmitReply: (len: number, more: Partial<Pkt> = {}, dt = 0.2) => {
        back(['P', 'A'], len, { seq: ss.seq - len, analysis: 'retransmission' }, dt, more)
      },
      dupAckOut: (dt = 0.001) => out(['A'], 0, { analysis: 'duplicate_ack' }, dt),
      retransmitSyn: (dt = 1) => out(['S'], 0, { seq: 0, ack: 0, mss: opts.mss ?? 1460, analysis: 'retransmission' }, dt),
      reset: (dt = rtt) => back(['R', 'A'], 0, { seq: 1, ack: 1 }, dt),
      close: (dt = 0.002) => {
        out(['F', 'A'], 0, {}, dt)
        cs.seq += 1
        back(['F', 'A'], 0, { ack: cs.seq })
        ss.seq += 1
        cs.ack = ss.seq
        out(['A'], 0)
      },
      cs,
      ss,
    }
  }
}

const PC: Host = { ip: '192.168.10.100', mac: '52:54:00:3c:1a:7e' }
const GW: Host = { ip: '192.168.10.1', mac: '52:54:00:aa:10:01' }
const DNS: Host = { ip: '192.168.10.53', mac: '52:54:00:5e:00:53' }
const WEB: Host = { ip: '93.184.215.14', mac: GW.mac }

function visitaWeb(): Escenario {
  const b = new Builder()
  const xid = '0x5f3a9c21'
  // DHCP: DORA (la PC todavía no tiene IP)
  const zero = { ip: '0.0.0.0', mac: PC.mac }
  const bcast = { ip: '255.255.255.255', mac: 'ff:ff:ff:ff:ff:ff' }
  b.push({ ...b.ip(zero, bcast, 'udp'), udp: { sport: 68, dport: 67, len: 308 }, dhcp: { type: 'Discover', xid, client: PC.mac, hostname: 'pc-ventas-03' }, size: 342 }, 0.0001)
  b.push({ ...b.ip(DNS, bcast, 'udp', 64, 'ff:ff:ff:ff:ff:ff', DNS.mac), udp: { sport: 67, dport: 68, len: 308 }, dhcp: { type: 'Offer', xid, client: PC.mac, yiaddr: PC.ip, server: DNS.ip, router: GW.ip, dns: DNS.ip, lease: 3600 }, size: 342 }, 0.0021)
  b.push({ ...b.ip(zero, bcast, 'udp'), udp: { sport: 68, dport: 67, len: 308 }, dhcp: { type: 'Request', xid, client: PC.mac, yiaddr: PC.ip, server: DNS.ip, hostname: 'pc-ventas-03' }, size: 342 }, 0.0009)
  b.push({ ...b.ip(DNS, bcast, 'udp', 64, 'ff:ff:ff:ff:ff:ff', DNS.mac), udp: { sport: 67, dport: 68, len: 308 }, dhcp: { type: 'ACK', xid, client: PC.mac, yiaddr: PC.ip, server: DNS.ip, router: GW.ip, dns: DNS.ip, lease: 3600 }, size: 342 }, 0.0018)
  // ARP: quién es el DNS y quién la puerta de enlace
  b.arp(PC, DNS, 0.35)
  b.dns(PC, DNS, undefined, 0x1a2b, 'www.ejemplo.com.ar', 'A', ['93.184.215.14'], 'NOERROR', 0.031)
  b.dns(PC, DNS, undefined, 0x1a2c, 'www.ejemplo.com.ar', 'AAAA', [], 'NOERROR', 0.028)
  b.arp(PC, GW, 0.0004)
  // TCP + TLS
  const c = b.tcp(PC, WEB, 51544, 443, { gwMac: GW.mac, rtt: 0.024 })
  c.handshake()
  c.send(517, { tls: { records: ['Client Hello'], sni: 'www.ejemplo.com.ar', version: 'TLS 1.3' } })
  c.ackBack(0.012)
  c.reply(1448, { tls: { records: ['Server Hello', 'Change Cipher Spec', 'Application Data'], version: 'TLS 1.3' } }, 0.012)
  c.reply(1448, { tls: { records: ['Application Data'], version: 'TLS 1.3' } }, 0.0002)
  c.ackOut()
  c.reply(912, { tls: { records: ['Application Data'], version: 'TLS 1.3' } }, 0.0002)
  c.send(80, { tls: { records: ['Change Cipher Spec', 'Application Data'], version: 'TLS 1.3' } }, 0.004)
  c.send(214, { tls: { records: ['Application Data'], version: 'TLS 1.3' } }, 0.0003)
  c.ackBack()
  for (let i = 0; i < 4; i++) {
    c.reply(1448, { tls: { records: ['Application Data'], version: 'TLS 1.3' } }, i ? 0.0002 : 0.03)
    if (i % 2) c.ackOut()
  }
  c.reply(633, { tls: { records: ['Application Data'], version: 'TLS 1.3' } }, 0.0002)
  c.ackOut()
  c.close()
  // Una consulta HTTP sin cifrar a un sitio interno, para ver el contenido
  const INTRA: Host = { ip: '192.168.10.80', mac: '52:54:00:5e:00:80' }
  b.arp(PC, INTRA, 0.8)
  b.dns(PC, DNS, undefined, 0x1a30, 'intranet.empresa.internal', 'A', ['192.168.10.80'], 'NOERROR', 0.0011)
  const h = b.tcp(PC, INTRA, 51602, 80, { rtt: 0.0006 })
  h.handshake()
  h.send(98, { http: { request: 'GET / HTTP/1.1', host: 'intranet.empresa.internal' }, payload: 'GET / HTTP/1.1\r\nHost: intranet.empresa.internal\r\nUser-Agent: curl/8.11.1\r\nAccept: */*\r\n\r\n' })
  h.reply(412, { http: { status: 'HTTP/1.1 200 OK' }, payload: 'HTTP/1.1 200 OK\r\nServer: nginx\r\nContent-Type: text/html\r\nContent-Length: 266\r\n\r\n<html><head><title>Intranet</title></head><body><h1>Intranet de la empresa</h1><p>Turnos, vacaciones y manuales.</p></body></html>' })
  h.ackOut()
  h.close()
  return { id: 'visita-web', titulo: 'Una visita web completa', descripcion: 'Una PC recién encendida pide IP por DHCP, averigua MAC por ARP, resuelve el nombre por DNS y abre una página por HTTPS; al final, una consulta HTTP sin cifrar a la intranet.', paquetes: b.pkts }
}

function retransmisiones(): Escenario {
  const b = new Builder()
  const FS: Host = { ip: '10.2.0.20', mac: GW.mac }
  const c = b.tcp(PC, FS, 50112, 445, { gwMac: GW.mac, rtt: 0.031, ttlBack: 61 })
  c.handshake()
  c.send(180, { payload: undefined })
  c.reply(1448, {}, 0.032)
  c.reply(1448, {}, 0.0003)
  c.ackOut()
  // se pierde un segmento: el cliente manda ACK duplicados y el servidor retransmite
  c.reply(1448, {}, 0.0003)
  c.dupAckOut(0.0004)
  c.dupAckOut(0.0005)
  c.dupAckOut(0.0005)
  c.retransmitReply(1448, {}, 0.031)
  c.ackOut()
  c.reply(1448, {}, 0.0004)
  c.reply(1448, {}, 0.0004)
  c.ackOut()
  c.reply(1448, {}, 0.0004)
  c.retransmitReply(1448, {}, 0.21)
  c.ackOut()
  c.reply(824, {}, 0.0004)
  c.ackOut()
  // una conexión a un puerto cerrado: RST
  const r = b.tcp(PC, { ip: '10.2.0.21', mac: GW.mac }, 50114, 3389, { gwMac: GW.mac, rtt: 0.03, ttlBack: 61 })
  b.push({ ...b.ip(PC, { ip: '10.2.0.21', mac: GW.mac }, 'tcp', 64, GW.mac), tcp: { sport: 50114, dport: 3389, flags: ['S'], seq: 0, ack: 0, win: 64240, len: 0, mss: 1460, stream: r.stream }, size: 66 }, 0.5)
  b.push({ ...b.ip({ ip: '10.2.0.21', mac: GW.mac }, PC, 'tcp', 61, PC.mac, GW.mac), tcp: { sport: 3389, dport: 50114, flags: ['R', 'A'], seq: 0, ack: 1, win: 0, len: 0, stream: r.stream }, size: 54 }, 0.03)
  // y una a un equipo que no responde: SYN que se repiten
  const n = b.tcp(PC, { ip: '10.2.0.99', mac: GW.mac }, 50116, 22, { gwMac: GW.mac })
  b.push({ ...b.ip(PC, { ip: '10.2.0.99', mac: GW.mac }, 'tcp', 64, GW.mac), tcp: { sport: 50116, dport: 22, flags: ['S'], seq: 0, ack: 0, win: 64240, len: 0, mss: 1460, stream: n.stream }, size: 66 }, 0.4)
  n.retransmitSyn(1.02)
  n.retransmitSyn(2.04)
  n.retransmitSyn(4.1)
  return { id: 'retransmisiones', titulo: 'Copia lenta a la sucursal', descripcion: 'Una copia de archivos (SMB, puerto 445) hacia la sucursal con pérdidas, un puerto cerrado que responde RST y un equipo que no contesta.', paquetes: b.pkts }
}

function mtu(): Escenario {
  const b = new Builder()
  const VPN_GW: Host = { ip: '10.99.0.1', mac: GW.mac }
  const APP: Host = { ip: '10.2.0.50', mac: GW.mac }
  // Una respuesta chica (una API que devuelve poco) anda
  const chica = b.tcp(PC, APP, 50198, 80, { gwMac: GW.mac, rtt: 0.038, ttlBack: 61 })
  chica.handshake()
  chica.send(96, { http: { request: 'GET /api/estado HTTP/1.1', host: 'pedidos.empresa.internal' }, payload: 'GET /api/estado HTTP/1.1\r\nHost: pedidos.empresa.internal\r\nAccept: application/json\r\n\r\n' })
  chica.reply(212, { http: { status: 'HTTP/1.1 200 OK' }, payload: 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 103\r\n\r\n{"estado":"ok","pedidos_pendientes":12}' }, 0.039)
  chica.ackOut()
  chica.close()
  // La página grande: el saludo y la consulta pasan, pero los segmentos grandes del servidor
  // no llegan nunca. El aviso de "hay que fragmentar" le llega al servidor, no a la PC.
  const grande = b.tcp(PC, APP, 50200, 443, { gwMac: GW.mac, rtt: 0.038, ttlBack: 61 })
  grande.handshake()
  grande.send(517, { tls: { records: ['Client Hello'], sni: 'pedidos.empresa.internal', version: 'TLS 1.3' } }, 0.2)
  grande.ackBack(0.039)
  // ...silencio: después de esperar medio minuto, el navegador se rinde y cierra la conexión
  grande.close(30)
  b.t += 5
  // ping con el bit DF ("no fragmentar") y distintos tamaños
  for (const [size, ok2] of [
    [1472, false],
    [1392, true],
  ] as const) {
    b.push({ ...b.ip(PC, APP, 'icmp', 64, GW.mac), icmp: { type: 8, code: 0, id: 7, seq: size }, size: size + 42 }, 1.2)
    if (ok2) b.push({ ...b.ip(APP, PC, 'icmp', 61, PC.mac, GW.mac), icmp: { type: 0, code: 0, id: 7, seq: size }, size: size + 42 }, 0.04)
    else b.push({ ...b.ip(VPN_GW, PC, 'icmp', 63, PC.mac, GW.mac), icmp: { type: 3, code: 4, mtu: 1420, orig: `IP ${PC.ip} > ${APP.ip}: ICMP echo request` }, size: 70 }, 0.002)
  }
  for (const p of b.pkts) if (p.ip?.proto === 'icmp' && p.icmp?.type === 8) p.ip.df = true
  return { id: 'mtu', titulo: 'La VPN conecta pero la página no termina de cargar', descripcion: 'Una PC usa una aplicación de la sucursal a través de una VPN: las respuestas chicas llegan, la página grande se queda esperando. Al final, dos ping con "no fragmentar".', paquetes: b.pkts }
}

function dnsFalla(): Escenario {
  const b = new Builder()
  b.dns(PC, DNS, undefined, 0x2001, 'intranet.empresa.internal', 'A', ['192.168.10.80'], 'NOERROR', 0.0009)
  b.dns(PC, DNS, undefined, 0x2002, 'www.google.com', 'A', [], 'SERVFAIL', 0.0011)
  b.dns(PC, DNS, undefined, 0x2003, 'www.google.com', 'A', [], 'SERVFAIL', 0.0012)
  b.dns(PC, DNS, undefined, 0x2004, 'erp.empresa.internl', 'A', [], 'NXDOMAIN', 0.0008)
  b.dns(PC, { ip: '192.168.10.54', mac: '52:54:00:5e:00:54' }, undefined, 0x2005, 'www.google.com', 'A', [], 'NOERROR', -1)
  // nadie contesta: el resolvedor de la PC vuelve a preguntar a los 5 segundos (timeout por defecto)
  b.t += 5
  b.dns(PC, { ip: '192.168.10.54', mac: '52:54:00:5e:00:54' }, undefined, 0x2005, 'www.google.com', 'A', [], 'NOERROR', -1)
  // ping a una IP pública: anda
  const PUB: Host = { ip: '1.1.1.1', mac: GW.mac }
  for (let i = 1; i <= 2; i++) {
    b.push({ ...b.ip(PC, PUB, 'icmp', 64, GW.mac), icmp: { type: 8, code: 0, id: 9, seq: i }, size: 98 }, 0.5)
    b.push({ ...b.ip(PUB, PC, 'icmp', 57, PC.mac, GW.mac), icmp: { type: 0, code: 0, id: 9, seq: i }, size: 98 }, 0.011)
  }
  return { id: 'dns-falla', titulo: 'Hay internet, pero no resuelve', descripcion: 'Consultas DNS a dos resolvedores: uno responde con errores y el otro no contesta. El ping a una IP pública funciona.', paquetes: b.pkts }
}

const CACHE = new Map<string, Escenario>()
const FACTORIES: Record<string, () => Escenario> = { 'visita-web': visitaWeb, retransmisiones, mtu, 'dns-falla': dnsFalla }

export const ESCENARIOS = Object.keys(FACTORIES)

export function escenario(id: string): Escenario | undefined {
  if (!FACTORIES[id]) return undefined
  if (!CACHE.has(id)) CACHE.set(id, FACTORIES[id]())
  return CACHE.get(id)
}

export function protocolo(p: Pkt): string {
  if (p.arp) return 'ARP'
  if (p.dhcp) return 'DHCP'
  if (p.dns) return 'DNS'
  if (p.tls) return p.tls.version.replace(' ', 'v')
  if (p.http) return 'HTTP'
  if (p.icmp) return 'ICMP'
  if (p.tcp) return 'TCP'
  if (p.udp) return 'UDP'
  return 'Ethernet'
}

export function flagsText(f: TcpFlag[]): string {
  const names: Record<TcpFlag, string> = { S: 'SYN', A: 'ACK', F: 'FIN', R: 'RST', P: 'PSH' }
  return f
    .slice()
    .sort((a, b) => 'FSRPA'.indexOf(a) - 'FSRPA'.indexOf(b))
    .map((x) => names[x])
    .join(', ')
}

/** La columna "Info" de Wireshark. */
export function info(p: Pkt): string {
  if (p.arp) return p.arp.op === 'request' ? `Who has ${p.arp.tpa}? Tell ${p.arp.spa}` : `${p.arp.spa} is at ${p.arp.sha}`
  if (p.dhcp) return `DHCP ${p.dhcp.type} - Transaction ID ${p.dhcp.xid}`
  if (p.dns) {
    const id = `0x${p.dns.id.toString(16).padStart(4, '0')}`
    if (!p.dns.response) return `Standard query ${id} ${p.dns.qtype} ${p.dns.qname}`
    if (p.dns.rcode !== 'NOERROR') return `Standard query response ${id} ${p.dns.rcode === 'NXDOMAIN' ? 'No such name' : 'Server failure'} ${p.dns.qtype} ${p.dns.qname}`
    return `Standard query response ${id} ${p.dns.qtype} ${p.dns.qname}${p.dns.answers.map((a) => ` ${p.dns!.qtype} ${a}`).join('')}`
  }
  if (p.icmp) {
    if (p.icmp.type === 8) return `Echo (ping) request  id=0x${(p.icmp.id ?? 0).toString(16).padStart(4, '0')}, seq=${p.icmp.seq}, ttl=${p.ip?.ttl}`
    if (p.icmp.type === 0) return `Echo (ping) reply    id=0x${(p.icmp.id ?? 0).toString(16).padStart(4, '0')}, seq=${p.icmp.seq}, ttl=${p.ip?.ttl}`
    if (p.icmp.type === 3 && p.icmp.code === 4) return `Destination unreachable (Fragmentation needed)  MTU ${p.icmp.mtu}`
    return `ICMP type ${p.icmp.type} code ${p.icmp.code}`
  }
  if (p.tls) return p.tls.records.join(', ') + (p.tcp?.analysis === 'retransmission' ? ' [TCP Retransmission]' : '')
  if (p.http) return p.http.request ?? p.http.status ?? ''
  if (p.tcp) {
    const t = p.tcp
    const pre = t.analysis === 'retransmission' ? '[TCP Retransmission] ' : t.analysis === 'duplicate_ack' ? '[TCP Dup ACK] ' : ''
    return `${pre}${t.sport} → ${t.dport} [${flagsText(t.flags)}] Seq=${t.seq} Ack=${t.ack} Win=${t.win} Len=${t.len}${t.mss ? ` MSS=${t.mss}` : ''}`
  }
  if (p.udp) return `${p.udp.sport} → ${p.udp.dport} Len=${p.udp.len - 8}`
  return ''
}
