/**
 * Quórum de un clúster (como lo calcula corosync con votequorum): cada nodo prendido vota, hace
 * falta más de la mitad de los votos esperados, y si la red se parte, cada lado cuenta solo los
 * votos que ve. El dispositivo de quórum (QDevice, algoritmo ffsplit) le da su voto a un solo
 * lado: al que tiene más nodos o, si empatan, al que tiene el nodo de ID más bajo.
 */
export type Lado = 'A' | 'B'

export interface NodoQ {
  nombre: string
  votos: number
  prendido: boolean
  lado: Lado
}

export interface EscenarioQ {
  nodos: NodoQ[]
  qdevice: boolean
  /** El QDevice está prendido y se ve desde los dos lados. */
  qdevicePrendido?: boolean
  /** Votos esperados forzados (pvecm expected). */
  esperados?: number
}

export interface Particion {
  lado: Lado
  nodos: string[]
  votos: number
  conQdevice: boolean
  quorum: boolean
}

export interface ResultadoQ {
  esperados: number
  necesarios: number
  particiones: Particion[]
  nivel: 'ok' | 'parcial' | 'bloqueado' | 'split-brain'
  resumen: string
}

export function evaluarQuorum(e: EscenarioQ): ResultadoQ {
  const esperadosReales = e.nodos.reduce((s, n) => s + n.votos, 0) + (e.qdevice ? 1 : 0)
  const esperados = e.esperados ?? esperadosReales
  const necesarios = Math.floor(esperados / 2) + 1
  const lados = (['A', 'B'] as Lado[])
    .map((lado) => {
      const nodos = e.nodos.filter((n) => n.prendido && n.lado === lado)
      return { lado, nodos, idMin: Math.min(...nodos.map((n) => e.nodos.indexOf(n))) }
    })
    .filter((p) => p.nodos.length)
  // ffsplit: el voto del QDevice va al lado con más nodos; si empatan, al del nodo de ID más bajo.
  let ganadorQ: Lado | undefined
  if (e.qdevice && (e.qdevicePrendido ?? true) && lados.length) {
    const orden = [...lados].sort((a, b) => b.nodos.length - a.nodos.length || a.idMin - b.idMin)
    ganadorQ = orden[0].lado
  }
  const particiones: Particion[] = lados.map((p) => {
    const conQdevice = p.lado === ganadorQ
    const votos = p.nodos.reduce((s, n) => s + n.votos, 0) + (conQdevice ? 1 : 0)
    return { lado: p.lado, nodos: p.nodos.map((n) => n.nombre), votos, conQdevice, quorum: votos >= necesarios }
  })
  const conQuorum = particiones.filter((p) => p.quorum)
  const apagados = e.nodos.filter((n) => !n.prendido).map((n) => n.nombre)
  let nivel: ResultadoQ['nivel']
  let resumen: string
  if (conQuorum.length > 1) {
    nivel = 'split-brain'
    resumen = `Las dos partes creen que tienen quórum (con ${esperados} votos esperados alcanza con ${necesarios}): cada una puede arrancar las mismas VM con los mismos discos. Eso es un split brain y puede romper los datos. Por eso no se bajan los votos esperados con la red partida.`
  } else if (!conQuorum.length) {
    nivel = 'bloqueado'
    resumen = `Ninguna parte llega a ${necesarios} votos: todo el clúster queda bloqueado. No se puede arrancar, crear ni migrar nada. Las VM comunes que ya corrían siguen, pero los nodos con VM bajo alta disponibilidad se reinician solos al minuto (su watchdog), así que esas VM se caen.`
  } else if (particiones.length > 1 || apagados.length) {
    nivel = 'parcial'
    const otra = particiones.find((p) => !p.quorum)
    resumen = `${conQuorum[0].nodos.join(', ')} ${conQuorum[0].nodos.length > 1 ? 'tienen' : 'tiene'} ${conQuorum[0].votos} de ${necesarios} votos necesarios: siguen funcionando y la alta disponibilidad recupera ahí las VM de los nodos que faltan.${otra ? ` ${otra.nodos.join(', ')} quedan bloqueados: no arrancan nada y, si tenían VM bajo HA, se reinician solos.` : ''}`
  } else {
    nivel = 'ok'
    resumen = `Todos los nodos se ven: ${particiones[0]?.votos ?? 0} votos de ${necesarios} necesarios.`
  }
  return { esperados, necesarios, particiones, nivel, resumen }
}

/** Cuántos nodos se pueden caer sin perder el quórum. */
export function tolerancia(nodos: number, qdevice: boolean): number {
  const total = nodos + (qdevice ? 1 : 0)
  const necesarios = Math.floor(total / 2) + 1
  // Con QDevice, cae un nodo por vez y el QDevice sigue votando.
  return Math.max(0, total - necesarios)
}
