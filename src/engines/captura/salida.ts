/**
 * Cómo se ve un paquete: una línea de tcpdump (-n, con -e y -v opcionales), el detalle por capas
 * del visor y el texto de "seguir la conversación TCP".
 */
import { flagsText, protocolo, type Pkt } from './model'

function clock(t: number): string {
  const base = 9 * 3600 + 41 * 60 + 2.103512
  const s = base + t
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = (s % 60).toFixed(6).padStart(9, '0')
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}`
}

function tcpFlags(f: Pkt['tcp']): string {
  if (!f) return ''
  const map = { S: 'S', F: 'F', R: 'R', P: 'P' } as const
  let out = ''
  for (const k of ['S', 'F', 'R', 'P'] as const) if (f.flags.includes(k)) out += map[k]
  if (f.flags.includes('A')) out += '.'
  return out || 'none'
}

export function tcpdumpLine(p: Pkt, o: { e?: boolean; v?: boolean } = {}): string {
  const head = clock(p.t) + ' '
  const eth = o.e ? `${p.eth.src} > ${p.eth.dst}, ethertype ${p.arp ? 'ARP (0x0806)' : 'IPv4 (0x0800)'}, length ${p.size}: ` : ''
  if (p.arp) {
    const body = p.arp.op === 'request' ? `Request who-has ${p.arp.tpa} tell ${p.arp.spa}, length ${p.size === 42 ? 28 : 46}` : `Reply ${p.arp.spa} is-at ${p.arp.sha}, length ${p.size === 42 ? 28 : 46}`
    return `${head}${eth}ARP, ${body}`
  }
  const ip = p.ip!
  const v = o.v ? ` (tos 0x0, ttl ${ip.ttl}, id ${ip.id}, offset 0, flags [${ip.df ? 'DF' : 'none'}], proto ${ip.proto.toUpperCase()} (${ip.proto === 'tcp' ? 6 : ip.proto === 'udp' ? 17 : 1}), length ${p.size - 14})\n    ` : ' '
  const pre = `${head}${eth}IP${v}`
  if (p.tcp) {
    const t = p.tcp
    const opts = t.mss ? `, options [mss ${t.mss},sackOK,TS val 1209 ecr 0,nop,wscale 7]` : ''
    // tcpdump muestra el número de secuencia inicial real en el SYN y después, relativos.
    const isn = (fromClient: boolean) => (2_000_000_000 + ((t.stream * 7919 + (fromClient ? 13 : 977)) * 104729) % 1_000_000_000) >>> 0
    const fromClient = t.dport < t.sport
    const syn = t.flags.includes('S')
    const seq = syn ? `, seq ${isn(fromClient)}` : t.len ? `, seq ${t.seq}:${t.seq + t.len}` : t.flags.includes('F') || t.flags.includes('R') ? `, seq ${t.seq}` : ''
    const ack = t.flags.includes('A') ? `, ack ${syn ? isn(!fromClient) + 1 : t.ack}` : ''
    return `${pre}${ip.src}.${t.sport} > ${ip.dst}.${t.dport}: Flags [${tcpFlags(t)}]${seq}${ack}, win ${t.win}${opts}, length ${t.len}${p.http?.request ? `: HTTP: ${p.http.request}` : p.http?.status ? `: HTTP: ${p.http.status}` : ''}`
  }
  if (p.udp) {
    const u = p.udp
    const where = `${ip.src}.${u.sport} > ${ip.dst}.${u.dport}: `
    if (p.dns) {
      const d = p.dns
      if (!d.response) return `${pre}${where}${d.id}+ ${d.qtype}? ${d.qname}. (${u.len - 8})`
      const rc = d.rcode === 'NOERROR' ? '' : ` ${d.rcode}`
      return `${pre}${where}${d.id}${rc} ${d.answers.length}/0/0${d.answers.map((a) => ` ${d.qtype} ${a}`).join(',')} (${u.len - 8})`
    }
    if (p.dhcp) return `${pre}${where}BOOTP/DHCP, ${p.dhcp.type === 'Discover' || p.dhcp.type === 'Request' ? `Request from ${p.dhcp.client}` : 'Reply'}, length ${u.len - 8}${o.v ? `\n\t  DHCP-Message (53), length 1: ${p.dhcp.type}${p.dhcp.yiaddr && p.dhcp.type !== 'Request' ? `\n\t  Your-IP ${p.dhcp.yiaddr}` : ''}${p.dhcp.router ? `\n\t  Default-Gateway (3), length 4: ${p.dhcp.router}` : ''}${p.dhcp.dns ? `\n\t  Domain-Name-Server (6), length 4: ${p.dhcp.dns}` : ''}` : ''}`
    return `${pre}${where}UDP, length ${u.len - 8}`
  }
  if (p.icmp) {
    const c = p.icmp
    if (c.type === 8) return `${pre}${ip.src} > ${ip.dst}: ICMP echo request, id ${c.id}, seq ${c.seq}, length ${p.size - 34}`
    if (c.type === 0) return `${pre}${ip.src} > ${ip.dst}: ICMP echo reply, id ${c.id}, seq ${c.seq}, length ${p.size - 34}`
    if (c.type === 3 && c.code === 4) {
      // El destino del paquete original, sin el puerto.
      const unreach = /> (\d+\.\d+\.\d+\.\d+)/.exec(c.orig ?? '')?.[1] ?? '?'
      return `${pre}${ip.src} > ${ip.dst}: ICMP ${unreach} unreachable - need to frag (mtu ${c.mtu}), length ${p.size - 34}`
    }
    return `${pre}${ip.src} > ${ip.dst}: ICMP type ${c.type}, length ${p.size - 34}`
  }
  return `${head}${protocolo(p)}`
}

/** El árbol de detalle del visor: una lista de secciones con sus líneas. */
export function detalle(p: Pkt): { titulo: string; lineas: string[] }[] {
  const out: { titulo: string; lineas: string[] }[] = []
  out.push({ titulo: `Frame ${p.n}: ${p.size} bytes`, lineas: [`Tiempo desde el comienzo: ${p.t.toFixed(6)} s`, `Protocolos: eth:${p.arp ? 'arp' : `ip:${p.ip?.proto}${p.dns ? ':dns' : p.dhcp ? ':dhcp' : p.tls ? ':tls' : p.http ? ':http' : ''}`}`] })
  out.push({ titulo: `Ethernet II, Src: ${p.eth.src}, Dst: ${p.eth.dst}`, lineas: [`Destino: ${p.eth.dst}${p.eth.dst === 'ff:ff:ff:ff:ff:ff' ? ' (broadcast: para todos)' : ''}`, `Origen: ${p.eth.src}`, `Tipo: ${p.arp ? 'ARP (0x0806)' : 'IPv4 (0x0800)'}`] })
  if (p.arp) {
    out.push({ titulo: `Address Resolution Protocol (${p.arp.op === 'request' ? 'request' : 'reply'})`, lineas: [`Opcode: ${p.arp.op} (${p.arp.op === 'request' ? 1 : 2})`, `Sender MAC: ${p.arp.sha}`, `Sender IP: ${p.arp.spa}`, `Target MAC: ${p.arp.tha}`, `Target IP: ${p.arp.tpa}`] })
    return out
  }
  const ip = p.ip!
  out.push({ titulo: `Internet Protocol Version 4, Src: ${ip.src}, Dst: ${ip.dst}`, lineas: [`Time to Live: ${ip.ttl}`, `Identification: 0x${ip.id.toString(16)} (${ip.id})`, `Flags: ${ip.df ? "Don't fragment (DF)" : 'ninguno'}`, `Protocol: ${ip.proto.toUpperCase()} (${ip.proto === 'tcp' ? 6 : ip.proto === 'udp' ? 17 : 1})`, `Total Length: ${p.size - 14}`] })
  if (p.tcp) {
    const t = p.tcp
    out.push({
      titulo: `Transmission Control Protocol, Src Port: ${t.sport}, Dst Port: ${t.dport}, Seq: ${t.seq}, Ack: ${t.ack}, Len: ${t.len}`,
      lineas: [`Stream index: ${t.stream}`, `Sequence Number (relative): ${t.seq}`, `Acknowledgment Number (relative): ${t.ack}`, `Flags: ${flagsText(t.flags)}`, `Window: ${t.win}`, ...(t.mss ? [`Options: Maximum segment size: ${t.mss} bytes`] : []), ...(t.analysis ? [`[Análisis: ${t.analysis === 'retransmission' ? 'esto es una retransmisión (el segmento ya se había mandado y no llegó la confirmación)' : t.analysis === 'duplicate_ack' ? 'ACK duplicado: el receptor avisa que le falta un segmento' : 'ventana cero'}]`] : [])],
    })
  }
  if (p.udp) out.push({ titulo: `User Datagram Protocol, Src Port: ${p.udp.sport}, Dst Port: ${p.udp.dport}`, lineas: [`Length: ${p.udp.len}`] })
  if (p.icmp) {
    const c = p.icmp
    out.push({ titulo: 'Internet Control Message Protocol', lineas: [`Type: ${c.type} (${c.type === 8 ? 'Echo (ping) request' : c.type === 0 ? 'Echo (ping) reply' : c.type === 3 ? 'Destination unreachable' : '?'})`, `Code: ${c.code}${c.type === 3 && c.code === 4 ? ' (Fragmentation needed)' : ''}`, ...(c.mtu ? [`MTU of next hop: ${c.mtu}`] : []), ...(c.id !== undefined ? [`Identifier: ${c.id}`, `Sequence: ${c.seq}`] : []), ...(c.orig ? [`Paquete original: ${c.orig}`] : [])] })
  }
  if (p.dns) {
    const d = p.dns
    out.push({ titulo: `Domain Name System (${d.response ? 'response' : 'query'})`, lineas: [`Transaction ID: 0x${d.id.toString(16).padStart(4, '0')}`, `Flags: ${d.response ? `respuesta, ${d.rcode === 'NOERROR' ? 'sin error' : d.rcode === 'NXDOMAIN' ? 'No such name (NXDOMAIN)' : 'Server failure (SERVFAIL)'}` : 'consulta estándar, recursión pedida'}`, `Queries: ${d.qname}: type ${d.qtype}, class IN`, ...(d.response ? [`Answers: ${d.answers.length ? d.answers.map((a) => `${d.qname}: type ${d.qtype}, ${a}`).join('; ') : '(ninguna)'}`] : [])] })
  }
  if (p.dhcp) {
    const d = p.dhcp
    out.push({ titulo: `Dynamic Host Configuration Protocol (${d.type})`, lineas: [`Transaction ID: ${d.xid}`, `Client MAC address: ${d.client}`, ...(d.yiaddr ? [`Your (client) IP address: ${d.yiaddr}`] : []), ...(d.server ? [`DHCP Server Identifier: ${d.server}`] : []), ...(d.router ? [`Router: ${d.router}`] : []), ...(d.dns ? [`Domain Name Server: ${d.dns}`] : []), ...(d.lease ? [`IP Address Lease Time: ${d.lease} s`] : []), ...(d.hostname ? [`Host Name: ${d.hostname}`] : [])] })
  }
  if (p.tls) out.push({ titulo: `Transport Layer Security (${p.tls.version})`, lineas: [...p.tls.records.map((r) => `Record: ${r}`), ...(p.tls.sni ? [`Server Name Indication: ${p.tls.sni}`] : []), 'El contenido viaja cifrado: solo se ven los tamaños y el nombre del sitio (SNI).'] })
  if (p.http) out.push({ titulo: 'Hypertext Transfer Protocol', lineas: (p.payload ?? '').split('\r\n\r\n')[0].split('\r\n') })
  return out
}

/** Seguir la conversación TCP: el texto en cada sentido, o los tamaños si está cifrado. */
export function seguirTcp(pkts: Pkt[], stream: number): { cliente: string; lineas: { de: 'cliente' | 'servidor'; texto: string }[] } {
  const ps = pkts.filter((p) => p.tcp?.stream === stream)
  const first = ps[0]
  const cliente = first ? `${first.ip!.src}:${first.tcp!.sport}` : ''
  const lineas: { de: 'cliente' | 'servidor'; texto: string }[] = []
  for (const p of ps) {
    if (!p.tcp || !p.tcp.len || p.tcp.analysis === 'retransmission') continue
    const de = `${p.ip!.src}:${p.tcp.sport}` === cliente ? 'cliente' : 'servidor'
    lineas.push({ de, texto: p.payload ?? `[${p.tcp.len} bytes${p.tls ? ` de ${p.tls.records.join(', ')}, cifrados` : ''}]` })
  }
  return { cliente, lineas }
}
