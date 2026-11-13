/**
 * Licenciamiento de Windows Server 2025 por núcleos (lo que hay que comprar para un servidor físico).
 *
 * Reglas:
 * - Se licencian todos los núcleos físicos, con un mínimo de 8 por procesador y 16 por servidor.
 * - Las licencias se venden en paquetes de 2 y de 16 núcleos.
 * - Standard: licenciar todos los núcleos da derecho a 2 máquinas virtuales (entornos de SO). Para
 *   más, se vuelven a licenciar todos los núcleos: cada "juego" suma 2 VM más.
 * - Datacenter: con todos los núcleos licenciados una vez, VM ilimitadas.
 * - Aparte, cada usuario o dispositivo que usa el servidor necesita una CAL (de 2025: las de 2022 no
 *   sirven). Con el pago por uso de Azure Arc no hacen falta CAL (salvo las de Escritorio remoto).
 *
 * Precios de referencia: precio sugerido de Microsoft para 16 núcleos (los reales dependen del canal).
 */

export type Edicion = 'Standard' | 'Datacenter'

export const PRECIO_16_NUCLEOS_USD: Record<Edicion, number> = { Standard: 1176, Datacenter: 6771 }

export interface Servidor {
  procesadores: number
  /** Núcleos físicos de cada procesador. */
  nucleos: number
}

export interface Licenciamiento {
  edicion: Edicion
  /** Núcleos a licenciar una vez (con los mínimos aplicados). */
  nucleosBase: number
  /** Cuántas veces hay que licenciar todos los núcleos (en Datacenter, siempre 1). */
  juegos: number
  totalNucleos: number
  paquetes16: number
  paquetes2: number
  /** VM de Windows Server que quedan cubiertas (Infinity en Datacenter). */
  vmsCubiertas: number
  costoUsd: number
  pasos: string[]
}

const par = (n: number) => n + (n % 2)

export function nucleosBase(s: Servidor): number {
  return Math.max(16, s.procesadores * Math.max(8, par(s.nucleos)))
}

export function licenciar(s: Servidor, vms: number, edicion: Edicion): Licenciamiento {
  const base = nucleosBase(s)
  const juegos = edicion === 'Datacenter' ? 1 : Math.max(1, Math.ceil(vms / 2))
  const total = base * juegos
  const paquetes16 = Math.floor(total / 16)
  const paquetes2 = (total % 16) / 2
  const reales = s.procesadores * s.nucleos
  const pasos = [
    `Núcleos físicos: ${s.procesadores} procesador${s.procesadores > 1 ? 'es' : ''} × ${s.nucleos} núcleos = ${reales}.`,
    s.nucleos < 8 || reales < 16 || s.nucleos % 2
      ? `Se aplican los mínimos (8 por procesador, 16 por servidor${s.nucleos % 2 ? ', y se redondea a par porque los paquetes son de 2' : ''}): ${base} núcleos.`
      : `Supera los mínimos (8 por procesador y 16 por servidor): se licencian los ${base}.`,
    edicion === 'Datacenter'
      ? 'Datacenter: con licenciar los núcleos una vez, las VM son ilimitadas.'
      : `Standard: cada vez que licenciás todos los núcleos, cubrís 2 VM. Para ${vms} VM hacen falta ${juegos} juego${juegos > 1 ? 's' : ''}.`,
    `Total: ${base} × ${juegos} = ${total} núcleos = ${paquetes16} paquete${paquetes16 === 1 ? '' : 's'} de 16${paquetes2 ? ` y ${paquetes2} de 2` : ''}.`,
  ]
  return { edicion, nucleosBase: base, juegos, totalNucleos: total, paquetes16, paquetes2, vmsCubiertas: edicion === 'Datacenter' ? Infinity : juegos * 2, costoUsd: Math.round((total / 16) * PRECIO_16_NUCLEOS_USD[edicion]), pasos }
}

/** Desde cuántas VM conviene Datacenter (para ese servidor, con precios de referencia). */
export function equilibrio(s: Servidor): number {
  for (let vms = 1; vms <= 200; vms++) if (licenciar(s, vms, 'Standard').costoUsd > licenciar(s, vms, 'Datacenter').costoUsd) return vms
  return Infinity
}

/** CAL de usuario o de dispositivo: conviene la que da menos cantidad. */
export function cals(usuarios: number, dispositivos: number): { tipo: 'usuario' | 'dispositivo'; cantidad: number; motivo: string } {
  if (usuarios <= dispositivos) return { tipo: 'usuario', cantidad: usuarios, motivo: `Hay ${usuarios} personas y ${dispositivos} dispositivos: con CAL de usuario, cada persona entra desde los dispositivos que quiera.` }
  return { tipo: 'dispositivo', cantidad: dispositivos, motivo: `Hay ${dispositivos} dispositivos compartidos por ${usuarios} personas (por ejemplo, turnos): conviene la CAL de dispositivo.` }
}

export interface EjercicioLicencias {
  servidor: Servidor
  vms: number
  edicion: Edicion
  respuesta: number
  enunciado: string
  pasos: string[]
}

/** Ejercicio al azar: cuántos núcleos de licencia hay que comprar. */
export function generarEjercicio(rng: () => number): EjercicioLicencias {
  const pick = <T,>(xs: T[]) => xs[Math.floor(rng() * xs.length)]
  const servidor = { procesadores: pick([1, 1, 2, 2]), nucleos: pick([4, 6, 8, 10, 12, 16, 20, 24, 32]) }
  const edicion: Edicion = rng() < 0.7 ? 'Standard' : 'Datacenter'
  const vms = pick([0, 1, 2, 3, 4, 5, 6, 8, 10])
  const l = licenciar(servidor, vms, edicion)
  return {
    servidor,
    vms,
    edicion,
    respuesta: l.totalNucleos,
    enunciado: `Un servidor con ${servidor.procesadores} procesador${servidor.procesadores > 1 ? 'es' : ''} de ${servidor.nucleos} núcleos va a correr Windows Server 2025 ${edicion}${vms ? ` con ${vms} máquina${vms > 1 ? 's' : ''} virtual${vms > 1 ? 'es' : ''} de Windows Server` : ' sin máquinas virtuales'}. ¿Cuántos núcleos de licencia hay que comprar?`,
    pasos: l.pasos,
  }
}
