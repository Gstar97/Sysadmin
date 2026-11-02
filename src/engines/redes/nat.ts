/**
 * NAT y PAT en el router de una oficina: cada conexión que sale cambia su IP (y su puerto)
 * de origen por la IP pública del router, y la tabla de traducciones recuerda cómo devolver
 * la respuesta. Las conexiones que entran solo funcionan si hay una redirección de puertos.
 */
export interface NatEntry {
  proto: 'TCP' | 'UDP'
  /** Dentro: IP privada y puerto del equipo. */
  interno: string
  /** Afuera: IP pública del router y el puerto que eligió. */
  externo: string
  destino: string
}

export interface PortForward {
  proto: 'TCP' | 'UDP'
  puerto: number
  hacia: string
}

export interface NatState {
  /** IP de la interfaz WAN del router: pública, o de CGNAT (100.64.0.0/10) si el proveedor la comparte. */
  wan: string
  publica: string
  tabla: NatEntry[]
  redirecciones: PortForward[]
  siguientePuerto: number
}

export function isCgnat(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number)
  return a === 100 && b >= 64 && b <= 127
}

export function newNat(wan: string, publica = wan): NatState {
  return { wan, publica, tabla: [], redirecciones: [], siguientePuerto: 40001 }
}

/** Un equipo de adentro abre una conexión hacia internet. */
export function outbound(s: NatState, ip: string, puerto: number, destino: string, proto: 'TCP' | 'UDP' = 'TCP'): { state: NatState; entry: NatEntry; explicacion: string } {
  const existing = s.tabla.find((e) => e.interno === `${ip}:${puerto}` && e.destino === destino && e.proto === proto)
  if (existing) return { state: s, entry: existing, explicacion: 'Esa conexión ya está en la tabla: el router usa la misma traducción.' }
  // PAT: intenta conservar el puerto de origen; si otro equipo ya lo usa, elige otro.
  const used = new Set(s.tabla.map((e) => Number(e.externo.split(':')[1])))
  let ext = puerto
  let cambio = false
  if (used.has(ext) || ext < 1024) {
    ext = s.siguientePuerto
    while (used.has(ext)) ext++
    cambio = true
  }
  const entry: NatEntry = { proto, interno: `${ip}:${puerto}`, externo: `${s.wan}:${ext}`, destino }
  const state = { ...s, tabla: [...s.tabla, entry], siguientePuerto: cambio ? ext + 1 : s.siguientePuerto }
  const explicacion = `${ip}:${puerto} sale a internet como ${s.wan}:${ext}${cambio ? ' (el puerto original ya lo usaba otra conexión, así que el router eligió otro: eso es PAT, muchas conexiones detrás de una sola IP)' : ' (el router pudo conservar el puerto)'}. Cuando ${destino} conteste a ${s.wan}:${ext}, el router busca esa fila y se la devuelve a ${ip}:${puerto}.`
  return { state, entry, explicacion }
}

/** Alguien de internet intenta conectarse a la IP pública. */
export function inbound(s: NatState, puerto: number, proto: 'TCP' | 'UDP' = 'TCP'): { ok: boolean; hacia?: string; explicacion: string } {
  if (s.publica !== s.wan && isCgnat(s.wan)) {
    return { ok: false, explicacion: `La IP de tu router (${s.wan}) es de CGNAT: la IP pública ${s.publica} la comparte el proveedor con muchos clientes y es su router el que recibe la conexión. Como ese equipo no tiene ninguna redirección hacia ti, la descarta. Con CGNAT no se puede publicar un servicio así: hace falta pedir una IP pública, usar IPv6 o un túnel saliente.` }
  }
  const fwd = s.redirecciones.find((r) => r.puerto === puerto && r.proto === proto)
  if (!fwd) return { ok: false, explicacion: `Llega una conexión a ${s.wan}:${puerto}, pero no hay ninguna fila en la tabla ni redirección para ese puerto: el router no sabe a qué equipo de adentro mandarla y la descarta. Por eso, sin configurar nada, desde internet no se puede iniciar una conexión hacia tu red.` }
  return { ok: true, hacia: fwd.hacia, explicacion: `Hay una redirección: ${proto} ${puerto} → ${fwd.hacia}. El router cambia el destino (NAT de destino) y la conexión llega al servidor. Ojo: ese servicio queda expuesto a todo internet.` }
}
