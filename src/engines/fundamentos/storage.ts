/** Comparador de discos: tiempos estimados para cargas típicas según IOPS y rendimiento secuencial. */

export interface DiskModel {
  id: string
  nombre: string
  /** MB/s en lectura secuencial (valor típico de ficha técnica). */
  secuencial: number
  /** Operaciones de 4 KiB por segundo en lectura aleatoria (ficha técnica, con cola profunda). */
  iops: number
  /** Latencia típica de una lectura aleatoria. */
  latenciaMs: number
  /** Costo por TB relativo al disco rígido (aproximado). */
  costoRelativo: number
  capacidadMaxTB: number
  nota: string
}

export const DISKS: DiskModel[] = [
  { id: 'hdd', nombre: 'Disco rígido 7200 rpm (SATA)', secuencial: 250, iops: 150, latenciaMs: 8, costoRelativo: 1, capacidadMaxTB: 30, nota: 'Partes mecánicas: el cabezal tiene que moverse hasta los datos.' },
  { id: 'sata', nombre: 'SSD SATA', secuencial: 550, iops: 90_000, latenciaMs: 0.1, costoRelativo: 3, capacidadMaxTB: 8, nota: 'Sin partes móviles, pero limitado por la interfaz SATA (6 Gbit/s).' },
  { id: 'nvme4', nombre: 'SSD NVMe PCIe 4.0', secuencial: 7_000, iops: 1_000_000, latenciaMs: 0.06, costoRelativo: 3.5, capacidadMaxTB: 8, nota: 'Conectado directo por PCIe, con miles de colas en paralelo.' },
  { id: 'nvme5', nombre: 'SSD NVMe PCIe 5.0', secuencial: 14_000, iops: 1_500_000, latenciaMs: 0.05, costoRelativo: 5, capacidadMaxTB: 30, nota: 'El doble de ancho de banda que PCIe 4.0; común en servidores nuevos.' },
]

export interface Workload {
  id: string
  nombre: string
  descripcion: string
  /** Operaciones aleatorias de 4 KiB. */
  aleatorias: number
  /** MB leídos o escritos de forma secuencial. */
  secuencialMB: number
  importa: string
}

export const WORKLOADS: Workload[] = [
  { id: 'bd', nombre: 'Base de datos', descripcion: 'Un sistema de ventas que hace 2 millones de lecturas pequeñas en lugares distintos del disco.', aleatorias: 2_000_000, secuencialMB: 0, importa: 'IOPS y latencia: muchas operaciones pequeñas repartidas por todo el disco.' },
  { id: 'backup', nombre: 'Copia de seguridad', descripcion: 'Copiar 500 GB de archivos grandes a un disco de respaldo.', aleatorias: 0, secuencialMB: 500_000, importa: 'Rendimiento secuencial (MB/s) y costo por TB: se escriben muchos datos seguidos.' },
  { id: 'archivos', nombre: 'Servidor de archivos', descripcion: '60 GB de documentos y planillas: un poco de todo, archivos grandes y pequeños.', aleatorias: 300_000, secuencialMB: 60_000, importa: 'Un equilibrio entre rendimiento secuencial y IOPS.' },
  { id: 'vms', nombre: 'Arranque de 20 máquinas virtuales', descripcion: 'Veinte VM arrancan a la vez y leen sus sistemas operativos desde el mismo almacenamiento.', aleatorias: 1_200_000, secuencialMB: 20_000, importa: 'IOPS: muchas lecturas aleatorias simultáneas de distintas VM.' },
]

/** Segundos estimados: las operaciones aleatorias se limitan por IOPS y las secuenciales por MB/s. */
export function estimate(disk: DiskModel, w: Workload): number {
  return w.aleatorias / disk.iops + w.secuencialMB / disk.secuencial
}
