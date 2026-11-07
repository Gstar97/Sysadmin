/**
 * Firewall con estado al estilo de OPNsense/pfSense: las reglas se aplican en la interfaz por la
 * que ENTRA el paquete, se evalúan de arriba hacia abajo, gana la primera que coincide y, si
 * ninguna coincide, se bloquea. Las respuestas de una conexión permitida pasan solas (estado).
 * La redirección de puertos (NAT de destino) se aplica antes de las reglas.
 */

export type Zona = 'LAN' | 'DMZ' | 'WAN'
export type Proto = 'tcp' | 'udp' | 'icmp'

export interface Regla {
  id: string
  /** Interfaz donde está la regla (por donde entra el tráfico). */
  interfaz: Zona
  accion: 'permitir' | 'bloquear'
  proto: Proto | 'cualquiera'
  /** Red en CIDR, un alias de zona ("LAN net", "DMZ net") o "cualquiera". */
  origen: string
  destino: string
  puerto?: number
  descripcion: string
}

export interface Redireccion {
  puertoPublico: number
  proto: Proto
  hacia: string
  puerto: number
}

export interface Escenario {
  nombre: string
  redes: Record<Zona, string>
  ipPublica: string
  reglas: Regla[]
  redirecciones: Redireccion[]
}

export interface Paquete {
  texto: string
  desde: string
  hacia: string
  proto: Proto
  puerto?: number
  /** Es la respuesta de una conexión que empezó del otro lado (src -> dst al revés). */
  respuestaDe?: Paquete
}

export interface Resultado {
  pasa: boolean
  regla?: Regla
  pasos: string[]
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0
}

export function inCidr(ip: string, cidr: string): boolean {
  const [net, p] = cidr.split('/')
  const prefix = Number(p ?? 32)
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  return ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(net) & mask) >>> 0)
}

export function zonaDe(e: Escenario, ip: string): Zona {
  if (inCidr(ip, e.redes.LAN)) return 'LAN'
  if (inCidr(ip, e.redes.DMZ)) return 'DMZ'
  return 'WAN'
}

function matchAddr(e: Escenario, ip: string, spec: string): boolean {
  if (spec === 'cualquiera') return true
  if (spec === 'LAN net') return inCidr(ip, e.redes.LAN)
  if (spec === 'DMZ net') return inCidr(ip, e.redes.DMZ)
  if (spec === 'WAN address') return ip === e.ipPublica
  return inCidr(ip, spec)
}

function regla(e: Escenario, zona: Zona, p: { desde: string; hacia: string; proto: Proto; puerto?: number }, reglas = e.reglas) {
  return reglas.find((r) => r.interfaz === zona && (r.proto === 'cualquiera' || r.proto === p.proto) && matchAddr(e, p.desde, r.origen) && matchAddr(e, p.hacia, r.destino) && (r.puerto === undefined || r.puerto === p.puerto))
}

export function describeRegla(r: Regla): string {
  return `${r.accion === 'permitir' ? 'Permitir' : 'Bloquear'} ${r.proto === 'cualquiera' ? 'todo' : r.proto.toUpperCase()} de ${r.origen} a ${r.destino}${r.puerto ? ` puerto ${r.puerto}` : ''}`
}

/** Decide si un paquete atraviesa el firewall. */
export function evaluar(e: Escenario, p: Paquete, reglas = e.reglas): Resultado {
  const pasos: string[] = []
  if (p.respuestaDe) {
    const ida = evaluar(e, p.respuestaDe, reglas)
    if (ida.pasa) return { pasa: true, pasos: ['Es la respuesta de una conexión que el firewall ya dejó pasar: la tabla de estados la reconoce y pasa sin mirar las reglas.'] }
    return { pasa: false, pasos: ['Sería una respuesta, pero la conexión de ida nunca se permitió: no hay estado que la respalde y se descarta.'] }
  }
  let hacia = p.hacia
  let puerto = p.puerto
  const entra = zonaDe(e, p.desde)
  if (entra === 'WAN' && p.hacia === e.ipPublica) {
    const rd = e.redirecciones.find((r) => r.proto === p.proto && r.puertoPublico === p.puerto)
    if (rd) {
      hacia = rd.hacia
      puerto = rd.puerto
      pasos.push(`La redirección de puertos cambia el destino: ${e.ipPublica}:${p.puerto} pasa a ser ${rd.hacia}:${rd.puerto}. Las reglas ven ya el destino nuevo.`)
    } else {
      pasos.push(`Va a la IP pública del firewall (${e.ipPublica}) y no hay redirección para ${p.proto.toUpperCase()} ${p.puerto ?? ''}: el paquete es para el firewall mismo.`)
    }
  }
  if (zonaDe(e, hacia) === entra && entra !== 'WAN') {
    return { pasa: true, pasos: [...pasos, 'Origen y destino están en la misma red: el tráfico va directo por el switch y no pasa por el firewall.'] }
  }
  const r = regla(e, entra, { desde: p.desde, hacia, proto: p.proto, puerto }, reglas)
  pasos.push(`Entra por la interfaz ${entra}: se revisan las reglas de ${entra} de arriba hacia abajo.`)
  if (!r) {
    pasos.push(`Ninguna regla de ${entra} coincide: se aplica la denegación por defecto y se bloquea.`)
    return { pasa: false, pasos }
  }
  pasos.push(`La primera que coincide es "${r.descripcion}" (${describeRegla(r)}).`)
  if (r.accion === 'permitir') pasos.push('Pasa, y el firewall anota la conexión en su tabla de estados para dejar volver las respuestas.')
  else pasos.push('Se bloquea. Las reglas de más abajo no se miran.')
  return { pasa: r.accion === 'permitir', regla: r, pasos }
}

export const OFICINA: Escenario = {
  nombre: 'Oficina con DMZ',
  redes: { LAN: '192.168.1.0/24', DMZ: '172.16.0.0/24', WAN: '0.0.0.0/0' },
  ipPublica: '203.0.113.10',
  redirecciones: [{ puertoPublico: 443, proto: 'tcp', hacia: '172.16.0.10', puerto: 443 }],
  reglas: [
    { id: 'w1', interfaz: 'WAN', accion: 'permitir', proto: 'tcp', origen: 'cualquiera', destino: '172.16.0.10/32', puerto: 443, descripcion: 'Web pública (HTTPS)' },
    { id: 'd1', interfaz: 'DMZ', accion: 'bloquear', proto: 'cualquiera', origen: 'DMZ net', destino: 'LAN net', descripcion: 'La DMZ nunca entra a la LAN' },
    { id: 'd2', interfaz: 'DMZ', accion: 'permitir', proto: 'udp', origen: 'DMZ net', destino: 'cualquiera', puerto: 53, descripcion: 'DNS hacia afuera' },
    { id: 'd3', interfaz: 'DMZ', accion: 'permitir', proto: 'tcp', origen: 'DMZ net', destino: 'cualquiera', puerto: 443, descripcion: 'Actualizaciones (HTTPS)' },
    { id: 'l1', interfaz: 'LAN', accion: 'permitir', proto: 'tcp', origen: '192.168.1.50/32', destino: 'DMZ net', puerto: 22, descripcion: 'SSH a la DMZ solo desde la PC de sistemas' },
    { id: 'l2', interfaz: 'LAN', accion: 'bloquear', proto: 'tcp', origen: 'LAN net', destino: 'DMZ net', puerto: 22, descripcion: 'Nadie más hace SSH a la DMZ' },
    { id: 'l3', interfaz: 'LAN', accion: 'permitir', proto: 'cualquiera', origen: 'LAN net', destino: 'cualquiera', descripcion: 'La LAN sale a todos lados' },
  ],
}

/** Paquetes de prueba del escenario, para preguntar "¿pasa?". */
export function paquetesOficina(): Paquete[] {
  const webIn: Paquete = { texto: 'Un cliente de internet (198.51.100.7) abre https://203.0.113.10 (TCP 443 a la IP pública)', desde: '198.51.100.7', hacia: '203.0.113.10', proto: 'tcp', puerto: 443 }
  const lanOut: Paquete = { texto: 'Una PC de la LAN (192.168.1.23) abre una página en internet (TCP 443 a 142.250.78.14)', desde: '192.168.1.23', hacia: '142.250.78.14', proto: 'tcp', puerto: 443 }
  const dmzSsh: Paquete = { texto: 'El servidor web de la DMZ (172.16.0.10) intenta SSH a una PC de la LAN (192.168.1.23)', desde: '172.16.0.10', hacia: '192.168.1.23', proto: 'tcp', puerto: 22 }
  return [
    webIn,
    { texto: 'La respuesta del servidor web (172.16.0.10) a ese cliente de internet', desde: '172.16.0.10', hacia: '198.51.100.7', proto: 'tcp', puerto: 443, respuestaDe: webIn },
    { texto: 'Alguien de internet (198.51.100.7) intenta SSH a la IP pública (TCP 22 a 203.0.113.10)', desde: '198.51.100.7', hacia: '203.0.113.10', proto: 'tcp', puerto: 22 },
    { texto: 'Alguien de internet hace ping a la IP pública del firewall (ICMP a 203.0.113.10)', desde: '198.51.100.7', hacia: '203.0.113.10', proto: 'icmp' },
    lanOut,
    { texto: 'La respuesta de esa página (142.250.78.14) a la PC de la LAN', desde: '142.250.78.14', hacia: '192.168.1.23', proto: 'tcp', puerto: 443, respuestaDe: lanOut },
    { texto: 'La PC de sistemas (192.168.1.50) entra por SSH al servidor web de la DMZ (172.16.0.10)', desde: '192.168.1.50', hacia: '172.16.0.10', proto: 'tcp', puerto: 22 },
    { texto: 'Una PC cualquiera de la LAN (192.168.1.23) intenta SSH al servidor web de la DMZ', desde: '192.168.1.23', hacia: '172.16.0.10', proto: 'tcp', puerto: 22 },
    dmzSsh,
    { texto: 'El servidor web de la DMZ consulta un DNS público (UDP 53 a 1.1.1.1)', desde: '172.16.0.10', hacia: '1.1.1.1', proto: 'udp', puerto: 53 },
    { texto: 'El servidor web de la DMZ hace ping a internet (ICMP a 1.1.1.1)', desde: '172.16.0.10', hacia: '1.1.1.1', proto: 'icmp' },
    { texto: 'El servidor web de la DMZ descarga actualizaciones (TCP 443 a 151.101.2.132)', desde: '172.16.0.10', hacia: '151.101.2.132', proto: 'tcp', puerto: 443 },
    { texto: 'Dos PC de la LAN se pasan un archivo (TCP 445 de 192.168.1.23 a 192.168.1.40)', desde: '192.168.1.23', hacia: '192.168.1.40', proto: 'tcp', puerto: 445 },
    { texto: 'Una PC de la LAN (192.168.1.23) abre la web de la DMZ (TCP 443 a 172.16.0.10)', desde: '192.168.1.23', hacia: '172.16.0.10', proto: 'tcp', puerto: 443 },
  ]
}

/** Ejercicio de orden: las reglas de una interfaz, desordenadas, y lo que tiene que pasar. */
export interface Requisito {
  paquete: Paquete
  pasa: boolean
}

export const REQUISITOS_LAN: Requisito[] = [
  { paquete: { texto: 'La PC de sistemas (192.168.1.50) hace SSH a la DMZ', desde: '192.168.1.50', hacia: '172.16.0.10', proto: 'tcp', puerto: 22 }, pasa: true },
  { paquete: { texto: 'Otra PC (192.168.1.23) hace SSH a la DMZ', desde: '192.168.1.23', hacia: '172.16.0.10', proto: 'tcp', puerto: 22 }, pasa: false },
  { paquete: { texto: 'Otra PC (192.168.1.23) navega en internet', desde: '192.168.1.23', hacia: '142.250.78.14', proto: 'tcp', puerto: 443 }, pasa: true },
  { paquete: { texto: 'Otra PC (192.168.1.23) abre la web de la DMZ', desde: '192.168.1.23', hacia: '172.16.0.10', proto: 'tcp', puerto: 443 }, pasa: true },
]
