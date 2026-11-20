/**
 * Recursos virtuales: cuánto se le promete a las máquinas virtuales (vCPU y memoria) contra lo que
 * el servidor tiene, y qué pasa cuando se promete de más. Es un modelo simple para entender la
 * idea; los números reales dependen del hipervisor y de la carga.
 */
export type Uso = 'baja' | 'media' | 'alta'

export interface HostSpec {
  /** Hilos de CPU (núcleos × 2 con hyper-threading). */
  hilos: number
  ramGb: number
  /** Memoria que se queda el hipervisor. */
  reservaGb: number
}

export interface VmSpec {
  nombre: string
  vcpu: number
  ramGb: number
  /** Cuánto usa la CPU, en promedio. */
  uso: Uso
  /** Qué parte de su memoria usa de verdad el sistema invitado (el resto es caché que podría soltar). */
  ramUsoPct: number
  /** Mismo sistema operativo que otras (páginas de memoria iguales que se pueden compartir). */
  so: string
}

export interface Opciones {
  /** Globo (ballooning): el hipervisor le pide al invitado que devuelva la memoria que no usa. */
  globo: boolean
  /** Compartir páginas iguales entre VM (KSM en Linux/Proxmox, TPS en VMware). */
  compartir: boolean
  /** El host puede usar swap cuando se queda sin memoria. */
  swapHost: boolean
}

export const USO_FACTOR: Record<Uso, number> = { baja: 0.1, media: 0.35, alta: 0.8 }

export interface Resultado {
  vcpuTotal: number
  /** vCPU prometidas por cada hilo real. */
  ratio: number
  /** Demanda de CPU promedio respecto de lo que hay (%). */
  demandaCpuPct: number
  esperaCpu: 'baja' | 'media' | 'alta'
  ramAsignadaGb: number
  ramDisponibleGb: number
  /** Memoria que el host realmente tiene que poner. */
  ramNecesariaGb: number
  recuperadaGloboGb: number
  recuperadaCompartirGb: number
  /** Lo que falta y va a swap del host (o no arranca). */
  faltanteGb: number
  estado: 'ok' | 'ajustado' | 'problema'
  mensajes: string[]
}

const r1 = (n: number) => Math.round(n * 10) / 10

export function evaluar(host: HostSpec, vms: VmSpec[], op: Opciones): Resultado {
  const mensajes: string[] = []
  const vcpuTotal = vms.reduce((s, v) => s + v.vcpu, 0)
  const ratio = host.hilos ? vcpuTotal / host.hilos : 0
  const demanda = vms.reduce((s, v) => s + v.vcpu * USO_FACTOR[v.uso], 0)
  const demandaCpuPct = host.hilos ? (demanda / host.hilos) * 100 : 0
  let esperaCpu: Resultado['esperaCpu'] = demandaCpuPct > 90 ? 'alta' : demandaCpuPct > 70 || ratio > 6 ? 'media' : 'baja'
  const grande = vms.filter((v) => v.vcpu > host.hilos)
  for (const v of grande) mensajes.push(`${v.nombre} tiene más vCPU (${v.vcpu}) que hilos el servidor (${host.hilos}): no puede arrancar.`)
  const anchas = vms.filter((v) => v.vcpu <= host.hilos && v.vcpu > host.hilos / 2)
  if (anchas.length && esperaCpu === 'baja' && vms.length > 1) {
    esperaCpu = 'media'
    mensajes.push(`${anchas.map((v) => v.nombre).join(', ')} tiene más de la mitad de los hilos del servidor: cada vez que corre necesita muchos a la vez libres, y espera más. Darle menos vCPU suele hacerla más rápida.`)
  }
  if (esperaCpu === 'alta') mensajes.push(`Las VM piden en promedio el ${Math.round(demandaCpuPct)} % de la CPU: van a pasar tiempo esperando turno (CPU ready o steal). Se nota como lentitud sin que ninguna VM marque su CPU al 100 %.`)
  else if (esperaCpu === 'media' && !anchas.length) mensajes.push(`La CPU está bastante pedida (${Math.round(demandaCpuPct)} % en promedio, ${r1(ratio)} vCPU por hilo): en los picos va a haber esperas.`)
  else if (vms.length) mensajes.push(`CPU: ${r1(ratio)} vCPU por hilo y ${Math.round(demandaCpuPct)} % de demanda promedio. Prometer más vCPU que hilos es normal mientras las VM no trabajen todas a la vez.`)

  const ramAsignadaGb = vms.reduce((s, v) => s + v.ramGb, 0)
  const ramDisponibleGb = Math.max(0, host.ramGb - host.reservaGb)
  // Sin globo, con el tiempo cada invitado llena su memoria de caché y el host la tiene que poner toda.
  let necesaria = vms.reduce((s, v) => s + v.ramGb * 0.95, 0)
  let globo = 0
  if (op.globo) {
    const conGlobo = vms.reduce((s, v) => s + v.ramGb * Math.max(0.35, Math.min(0.95, v.ramUsoPct / 100 + 0.1)), 0)
    globo = Math.max(0, necesaria - conGlobo)
    necesaria = conGlobo
  }
  let compartir = 0
  if (op.compartir) {
    const porSo = new Map<string, number>()
    for (const v of vms) porSo.set(v.so, (porSo.get(v.so) ?? 0) + 1)
    for (const v of vms) {
      const n = porSo.get(v.so) ?? 1
      if (n >= 2) compartir += v.ramGb * Math.min(0.15, 0.04 * (n - 1))
    }
    necesaria -= compartir
  }
  const faltanteGb = Math.max(0, necesaria - ramDisponibleGb)
  let estado: Resultado['estado'] = 'ok'
  if (faltanteGb > 0) {
    estado = 'problema'
    mensajes.push(
      op.swapHost
        ? `Faltan ${r1(faltanteGb)} GB de memoria real: el host manda memoria de las VM a su swap. Es lo peor que puede pasar en un hipervisor: todo se vuelve lentísimo aunque el host "muestre memoria libre" en algún momento.`
        : `Faltan ${r1(faltanteGb)} GB de memoria real y el host no tiene swap: las VM que pidan memoria no arrancan o el sistema mata alguna para liberar.`,
    )
  } else if (necesaria > ramDisponibleGb * 0.85) {
    estado = 'ajustado'
    mensajes.push(`La memoria está al ${Math.round((necesaria / ramDisponibleGb) * 100)} % de lo disponible: un pico o una VM más y falta. Conviene dejar margen (y para un clúster, lugar para recibir las VM de un nodo caído).`)
  }
  if (ramAsignadaGb > ramDisponibleGb && faltanteGb === 0) mensajes.push(`Se prometieron ${r1(ramAsignadaGb)} GB sobre ${r1(ramDisponibleGb)} GB disponibles (sobreasignación de memoria): funciona gracias a ${[op.globo && 'el globo', op.compartir && 'compartir páginas'].filter(Boolean).join(' y ') || 'que las VM no usan todo'}, pero depende de que las VM no necesiten todo a la vez.`)
  if (esperaCpu === 'alta' && estado === 'ok') estado = 'problema'
  else if (esperaCpu === 'media' && estado === 'ok') estado = 'ajustado'
  if (grande.length) estado = 'problema'
  return { vcpuTotal, ratio: r1(ratio), demandaCpuPct: Math.round(demandaCpuPct), esperaCpu, ramAsignadaGb: r1(ramAsignadaGb), ramDisponibleGb: r1(ramDisponibleGb), ramNecesariaGb: r1(necesaria), recuperadaGloboGb: r1(globo), recuperadaCompartirGb: r1(compartir), faltanteGb: r1(faltanteGb), estado, mensajes }
}
