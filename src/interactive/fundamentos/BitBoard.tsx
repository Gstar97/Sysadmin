import { useState } from 'react'
import { groupBits, toBase } from '@/engines/fundamentos/numbers'
import { createRng, pick, randomInt } from '@/lib/random'
import { cn } from '@/lib/cn'
import { Button } from '@/ui'
import { Chip, Frame, Score } from './Frame'

const TYPICAL = [128, 192, 224, 240, 248, 252, 254, 255, 10, 172, 168, 100, 127, 64, 32, 15]

function newTarget(seed: number, width: 8 | 16): number {
  const rng = createRng(seed)
  if (width === 8 && rng() < 0.5) return pick(rng, TYPICAL)
  return randomInt(rng, 1, 2 ** width - 1)
}

/** Interruptores de bits: cada uno vale una potencia de 2 y el número es la suma de los encendidos. */
export function BitBoard({ bits = 8 }: { bits?: 8 | 16 }) {
  const [width, setWidth] = useState<8 | 16>(bits)
  const [value, setValue] = useState(0)
  const [mode, setMode] = useState<'libre' | 'practica'>('libre')
  const [target, setTarget] = useState(() => newTarget(Date.now(), bits))
  const [score, setScore] = useState({ correct: 0, total: 0, streak: 0 })
  const max = 2 ** width - 1
  const solved = mode === 'practica' && value === target
  const on = Array.from({ length: width }, (_, i) => width - 1 - i).filter((b) => value & (1 << b))

  const next = (skip: boolean) => {
    setScore((s) => ({ correct: s.correct + (skip ? 0 : 1), total: s.total + 1, streak: skip ? 0 : s.streak + 1 }))
    setTarget(newTarget(Date.now(), width))
    setValue(0)
  }

  const changeWidth = (w: 8 | 16) => {
    setWidth(w)
    setValue(0)
    setTarget(newTarget(Date.now(), w))
  }

  return (
    <Frame
      titulo="Tablero de bits"
      acciones={
        <>
          <Chip active={mode === 'libre'} onClick={() => setMode('libre')}>
            Explorar
          </Chip>
          <Chip active={mode === 'practica'} onClick={() => setMode('practica')}>
            Practicar
          </Chip>
          <Chip active={width === 8} onClick={() => changeWidth(8)}>
            8 bits
          </Chip>
          <Chip active={width === 16} onClick={() => changeWidth(16)}>
            16 bits
          </Chip>
        </>
      }
    >
      {mode === 'practica' && (
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <p className="text-sm">
            Enciende los bits necesarios para formar <b className="font-mono text-lg">{target}</b>
          </p>
          <Score {...score} />
        </div>
      )}
      <div className={cn('grid gap-1.5', width === 8 ? 'grid-cols-8' : 'grid-cols-8 sm:grid-cols-16')}>
        {Array.from({ length: width }, (_, i) => {
          const bit = width - 1 - i
          const isOn = (value & (1 << bit)) !== 0
          return (
            <button
              key={bit}
              type="button"
              aria-pressed={isOn}
              aria-label={`Bit de valor ${2 ** bit}`}
              onClick={() => setValue((v) => v ^ (1 << bit))}
              className={cn('flex min-h-14 flex-col items-center justify-center rounded-lg border font-mono transition', isOn ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface-2 hover:border-accent')}
            >
              <span className={cn('text-[10px]', isOn ? 'opacity-90' : 'text-muted')}>{2 ** bit}</span>
              <span className="text-lg font-bold">{isOn ? 1 : 0}</span>
            </button>
          )
        })}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        {[
          ['Decimal', String(value)],
          ['Binario', groupBits(toBase(value, 2, width))],
          ['Hexadecimal', `0x${toBase(value, 16, width / 4)}`],
          ['Octal', toBase(value, 8)],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg bg-surface-2 px-3 py-2">
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="font-mono font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 font-mono text-sm text-muted">{on.length ? `${on.map((b) => 2 ** b).join(' + ')} = ${value}` : 'Ningún bit encendido: 0'}</p>
      {solved && <p className="mt-2 rounded-lg border border-ok bg-ok-soft p-2 text-sm font-semibold text-ok" role="status">¡Correcto! {target} en binario es {groupBits(toBase(target, 2, width))}.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="ghost" onClick={() => setValue(0)}>
          Todo en 0
        </Button>
        <Button variant="ghost" onClick={() => setValue(max)}>
          Todo en 1 ({max})
        </Button>
        <Button variant="ghost" onClick={() => setValue((v) => (v << 1) & max)} title="Cada bit pasa a la posición de la izquierda: el valor se multiplica por 2 (si no se pierde el bit más alto)">
          Correr a la izquierda (×2)
        </Button>
        <Button variant="ghost" onClick={() => setValue((v) => v >> 1)} title="Cada bit pasa a la posición de la derecha: el valor se divide por 2 y se descarta el resto">
          Correr a la derecha (÷2)
        </Button>
        {mode === 'practica' &&
          (solved ? (
            <Button onClick={() => next(false)}>Siguiente número</Button>
          ) : (
            <Button variant="secondary" onClick={() => next(true)}>
              Saltar
            </Button>
          ))}
      </div>
    </Frame>
  )
}
