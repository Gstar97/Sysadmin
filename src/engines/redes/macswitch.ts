/**
 * Cómo un switch aprende direcciones MAC: anota la MAC de origen con el puerto por donde
 * entró la trama y decide si reenvía por un puerto, inunda (por todos menos el de entrada) o
 * descarta (el destino está del mismo lado).
 */
export const BROADCAST = 'ff:ff:ff:ff:ff:ff'

export interface SwitchHost {
  id: string
  nombre: string
  mac: string
  puerto: number
}

export interface MacEntry {
  mac: string
  puerto: number
  /** Segundos desde que se aprendió o se vio por última vez. */
  edad: number
}

export type SwitchAction = { tipo: 'reenviar'; puerto: number } | { tipo: 'inundar'; puertos: number[] } | { tipo: 'descartar' }

export interface FrameResult {
  aprendida: { mac: string; puerto: number; nueva: boolean; movida: boolean }
  accion: SwitchAction
  explicacion: string
  tabla: MacEntry[]
}

/** Envía una trama de "desde" a "hacia" (una MAC o la de broadcast) y actualiza la tabla. */
export function sendFrame(tabla: MacEntry[], puertos: number, desde: SwitchHost, destino: string): FrameResult {
  const t = tabla.map((e) => ({ ...e }))
  const prev = t.find((e) => e.mac === desde.mac)
  const before = prev?.puerto
  const movida = !!prev && prev.puerto !== desde.puerto
  if (prev) {
    prev.puerto = desde.puerto
    prev.edad = 0
  } else t.push({ mac: desde.mac, puerto: desde.puerto, edad: 0 })
  const learnTxt = !prev
    ? `El switch anota que la MAC ${desde.mac} está en el puerto ${desde.puerto} (la aprende de la dirección de origen).`
    : movida
      ? `La MAC ${desde.mac} estaba anotada en el puerto ${before}, pero ahora llegó por el ${desde.puerto}: el switch corrige la tabla (el equipo se cambió de puerto).`
      : `La MAC ${desde.mac} ya estaba anotada en el puerto ${desde.puerto}: el switch solo renueva su tiempo.`
  const others = Array.from({ length: puertos }, (_, i) => i + 1).filter((p) => p !== desde.puerto)
  let accion: SwitchAction
  let txt: string
  if (destino === BROADCAST) {
    accion = { tipo: 'inundar', puertos: others }
    txt = 'El destino es la dirección de broadcast (ff:ff:ff:ff:ff:ff): el switch la manda por todos los puertos menos por el que entró.'
  } else {
    const known = t.find((e) => e.mac === destino)
    if (!known) {
      accion = { tipo: 'inundar', puertos: others }
      txt = `El switch no conoce la MAC ${destino} (no está en su tabla): inunda la trama por todos los puertos menos el de entrada. Solo el equipo con esa MAC la acepta; los demás la descartan.`
    } else if (known.puerto === desde.puerto) {
      accion = { tipo: 'descartar' }
      txt = `La MAC ${destino} está en el mismo puerto por donde entró la trama: no hace falta mandarla a ningún lado y el switch la descarta (filtra).`
    } else {
      accion = { tipo: 'reenviar', puerto: known.puerto }
      txt = `El switch conoce la MAC ${destino}: está en el puerto ${known.puerto}. Reenvía la trama solo por ese puerto.`
    }
  }
  return { aprendida: { mac: desde.mac, puerto: desde.puerto, nueva: !prev, movida }, accion, explicacion: `${learnTxt} ${txt}`, tabla: t }
}

/** Pasa el tiempo: las entradas viejas se borran (en Cisco, 300 segundos por defecto). */
export function age(tabla: MacEntry[], segundos: number, limite = 300): MacEntry[] {
  return tabla.map((e) => ({ ...e, edad: e.edad + segundos })).filter((e) => e.edad < limite)
}

export function sameAction(a: SwitchAction, b: SwitchAction): boolean {
  if (a.tipo !== b.tipo) return false
  if (a.tipo === 'reenviar' && b.tipo === 'reenviar') return a.puerto === b.puerto
  return true
}

/** OUI (los primeros 3 bytes) de algunos fabricantes muy comunes, para leer una MAC. */
export const OUIS: Record<string, string> = {
  '08:00:27': 'Oracle VirtualBox',
  '52:54:00': 'QEMU/KVM (virtual, administrada localmente)',
  '00:50:56': 'VMware',
  '00:0c:29': 'VMware',
  '00:15:5d': 'Microsoft Hyper-V',
  'b8:27:eb': 'Raspberry Pi Foundation',
}
