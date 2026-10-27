import { useState } from 'react'
import { cn } from '@/lib/cn'
import { Chip, Frame } from './Frame'

interface Item {
  nombre: string
  segundos: number
  detalle: string
  grupo: 'cpu' | 'memoria' | 'disco' | 'red'
}

/** Latencias típicas de hardware actual (valores aproximados de referencia). */
const ITEMS: Item[] = [
  { nombre: 'Un ciclo de CPU (3 GHz)', segundos: 0.33e-9, detalle: 'Lo que tarda una operación simple dentro del procesador.', grupo: 'cpu' },
  { nombre: 'Caché L1', segundos: 1e-9, detalle: 'Unos pocos ciclos. Está dentro de cada núcleo.', grupo: 'cpu' },
  { nombre: 'Caché L2', segundos: 4e-9, detalle: 'Más grande y algo más lenta que L1.', grupo: 'cpu' },
  { nombre: 'Caché L3', segundos: 15e-9, detalle: 'Compartida entre núcleos; varía mucho según el procesador.', grupo: 'cpu' },
  { nombre: 'Memoria RAM', segundos: 90e-9, detalle: 'Fuera del procesador: decenas de veces más lenta que la caché.', grupo: 'memoria' },
  { nombre: 'Lectura aleatoria en SSD NVMe', segundos: 60e-6, detalle: 'Entre 20 y 100 microsegundos según el modelo.', grupo: 'disco' },
  { nombre: 'Lectura aleatoria en SSD SATA', segundos: 100e-6, detalle: 'Limitada por la interfaz y el protocolo SATA.', grupo: 'disco' },
  { nombre: 'Ida y vuelta en la red del centro de datos', segundos: 0.5e-3, detalle: 'Un ping entre dos servidores cercanos.', grupo: 'red' },
  { nombre: 'Lectura aleatoria en disco rígido', segundos: 8e-3, detalle: 'El cabezal tiene que moverse y esperar a que gire el plato.', grupo: 'disco' },
  { nombre: 'Ida y vuelta entre continentes', segundos: 150e-3, detalle: 'Por ejemplo, de Sudamérica a Europa por internet.', grupo: 'red' },
]

const SCALE = 1 / 0.33e-9 // un ciclo = 1 segundo

function realTime(s: number): string {
  if (s < 1e-6) return `${+(s * 1e9).toFixed(s < 1e-9 ? 2 : 0)} ns`
  if (s < 1e-3) return `${+(s * 1e6).toFixed(0)} µs`
  return `${+(s * 1e3).toFixed(s < 1e-2 ? 1 : 0)} ms`
}

function humanTime(s: number): string {
  const v = s * SCALE
  if (v < 60) return `${Math.round(v)} segundos`
  if (v < 3600) return `${Math.round(v / 60)} minutos`
  if (v < 86400) return `${(v / 3600).toFixed(1)} horas`
  if (v < 86400 * 60) return `${(v / 86400).toFixed(1)} días`
  if (v < 86400 * 365 * 2) return `${(v / (86400 * 30.4)).toFixed(1)} meses`
  return `${(v / (86400 * 365)).toFixed(1)} años`
}

const COLORS: Record<Item['grupo'], string> = { cpu: 'bg-ok', memoria: 'bg-accent', disco: 'bg-warn', red: 'bg-info' }

export function LatencyScale() {
  const [human, setHuman] = useState(true)
  const min = Math.log10(ITEMS[0].segundos)
  const max = Math.log10(ITEMS[ITEMS.length - 1].segundos)
  return (
    <Frame
      titulo="¿Cuánto tarda cada cosa?"
      acciones={
        <>
          <Chip active={!human} onClick={() => setHuman(false)}>
            Tiempo real
          </Chip>
          <Chip active={human} onClick={() => setHuman(true)}>
            Si un ciclo durara 1 segundo
          </Chip>
        </>
      }
    >
      <ul className="space-y-2">
        {ITEMS.map((it) => (
          <li key={it.nombre}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
              <span className="font-medium">{it.nombre}</span>
              <span className="font-mono">{human ? humanTime(it.segundos) : realTime(it.segundos)}</span>
            </div>
            <div className="mt-1 h-2.5 rounded-full bg-surface-2" aria-hidden>
              <div className={cn('h-full rounded-full', COLORS[it.grupo])} style={{ width: `${4 + ((Math.log10(it.segundos) - min) / (max - min)) * 96}%` }} />
            </div>
            <div className="mt-0.5 text-xs text-muted">{it.detalle}</div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted">
        Las barras usan escala logarítmica: cada tramo es 10 veces más que el anterior. Los valores son aproximados y cambian según el equipo; lo importante es el orden de magnitud.
      </p>
    </Frame>
  )
}
