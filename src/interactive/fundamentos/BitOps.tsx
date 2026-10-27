import { useState } from 'react'
import { groupBits, toBase } from '@/engines/fundamentos/numbers'
import { formatIpv4, maskToPrefix, parseIpv4, prefixToMask } from '@/engines/network/ip'
import { cn } from '@/lib/cn'
import { Chip, Frame, inputClass } from './Frame'

type Op = 'AND' | 'OR' | 'XOR' | 'NOT'

const OPS: { id: Op; regla: string; uso: string }[] = [
  { id: 'AND', regla: 'El resultado es 1 solo si los dos bits son 1.', uso: 'Sirve para quedarse con una parte de los bits: la máscara de red se aplica con AND.' },
  { id: 'OR', regla: 'El resultado es 1 si al menos uno de los dos bits es 1.', uso: 'Sirve para encender bits sin tocar los demás, por ejemplo sumar un permiso.' },
  { id: 'XOR', regla: 'El resultado es 1 si los bits son distintos.', uso: 'Sirve para ver qué bits cambiaron entre dos valores; también se usa en RAID 5 para calcular la paridad.' },
  { id: 'NOT', regla: 'Invierte cada bit: los 1 pasan a 0 y los 0 a 1.', uso: 'La máscara invertida (wildcard) de las ACL de Cisco y la umask de Linux se calculan así.' },
]

function apply(op: Op, a: number, b: number): number {
  if (op === 'AND') return a & b
  if (op === 'OR') return a | b
  if (op === 'XOR') return a ^ b
  return ~a & 0xff
}

function BitRow({ label, value, onToggle, highlight }: { label: string; value: number; onToggle?: (bit: number) => void; highlight?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className={cn('w-20 shrink-0 text-right text-sm', highlight ? 'font-semibold' : 'text-muted')}>{label}</span>
      <div className="flex gap-1">
        {Array.from({ length: 8 }, (_, i) => {
          const bit = 7 - i
          const on = (value >> bit) & 1
          const cls = cn('flex h-9 w-8 items-center justify-center rounded-md border font-mono text-sm sm:w-9', on ? 'border-accent bg-accent-soft font-bold text-accent' : 'border-line text-muted', highlight && 'ring-1 ring-accent/30')
          return onToggle ? (
            <button key={bit} type="button" aria-label={`${label}, bit ${2 ** bit}`} aria-pressed={!!on} className={cls} onClick={() => onToggle(bit)}>
              {on}
            </button>
          ) : (
            <span key={bit} className={cls}>
              {on}
            </span>
          )
        })}
      </div>
      <span className="w-12 font-mono text-sm">{value}</span>
    </div>
  )
}

function Bits() {
  const [a, setA] = useState(0b11001010)
  const [b, setB] = useState(0b11110000)
  const [op, setOp] = useState<Op>('AND')
  const info = OPS.find((o) => o.id === op)!
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {OPS.map((o) => (
          <Chip key={o.id} active={o.id === op} onClick={() => setOp(o.id)}>
            {o.id}
          </Chip>
        ))}
      </div>
      <p className="mt-2 text-sm">
        <b>{info.regla}</b> {info.uso}
      </p>
      <div className="mt-3 space-y-1.5 overflow-x-auto pb-1">
        <BitRow label="A" value={a} onToggle={(bit) => setA((v) => v ^ (1 << bit))} />
        {op !== 'NOT' && <BitRow label="B" value={b} onToggle={(bit) => setB((v) => v ^ (1 << bit))} />}
        <div className="ml-[88px] w-[300px] border-t border-fg/40" />
        <BitRow label={op === 'NOT' ? 'NOT A' : `A ${op} B`} value={apply(op, a, b)} highlight />
      </div>
      <p className="mt-2 text-xs text-muted">Toca los bits de A y B para cambiarlos.</p>
    </div>
  )
}

function parseMask(text: string): number | undefined {
  const t = text.trim()
  const m = /^\/?(\d{1,2})$/.exec(t)
  if (m) return Number(m[1]) <= 32 ? Number(m[1]) : undefined
  const ip = parseIpv4(t)
  return ip === undefined ? undefined : maskToPrefix(ip)
}

function Network() {
  const [ipText, setIpText] = useState('192.168.10.77')
  const [maskText, setMaskText] = useState('255.255.255.192')
  const ip = parseIpv4(ipText)
  const prefix = parseMask(maskText)
  const mask = prefix === undefined ? undefined : prefixToMask(prefix)
  const rows =
    ip !== undefined && mask !== undefined
      ? [
          { label: 'IP', value: ip },
          { label: 'Máscara', value: mask },
          { label: 'IP AND máscara = red', value: (ip & mask) >>> 0, strong: true },
        ]
      : []
  return (
    <div>
      <div className="flex flex-wrap gap-3">
        <label className="text-sm">
          Dirección IP
          <input value={ipText} onChange={(e) => setIpText(e.target.value)} className={`${inputClass} mt-1 block w-44`} spellCheck={false} />
        </label>
        <label className="text-sm">
          Máscara (o prefijo como /26)
          <input value={maskText} onChange={(e) => setMaskText(e.target.value)} className={`${inputClass} mt-1 block w-44`} spellCheck={false} />
        </label>
      </div>
      {ip === undefined && <p className="mt-3 text-sm text-bad">La IP tiene que tener cuatro números de 0 a 255 separados por puntos.</p>}
      {ip !== undefined && mask === undefined && <p className="mt-3 text-sm text-bad">Esa máscara no es válida: tiene que tener todos los 1 juntos a la izquierda (por ejemplo 255.255.255.0 o /24).</p>}
      {rows.length > 0 && (
        <>
          <div className="mt-4 overflow-x-auto">
            <table className="font-mono text-sm">
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label} className={cn(r.strong && 'border-t-2 border-fg/40 font-bold')}>
                    <td className="whitespace-nowrap py-1 pr-3 font-sans text-xs text-muted">{r.label}</td>
                    <td className="whitespace-nowrap py-1 pr-4">{formatIpv4(r.value)}</td>
                    {[24, 16, 8, 0].map((shift) => {
                      const octet = (r.value >>> shift) & 0xff
                      const bits = toBase(octet, 2, 8)
                      return (
                        <td key={shift} className="whitespace-nowrap py-1 pr-2">
                          {[...bits].map((bit, i) => {
                            const pos = 31 - (24 - shift) - i
                            const isNet = 32 - pos <= prefix!
                            return (
                              <span key={i} className={cn(isNet ? 'text-accent' : 'text-muted')}>
                                {bit}
                              </span>
                            )
                          })}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-sm">
            Donde la máscara tiene 1 (en color) se copia el bit de la IP: es la parte de <b>red</b>. Donde tiene 0 el resultado queda en 0: es la parte de <b>equipo</b> (host). La red es{' '}
            <b className="font-mono">
              {formatIpv4((ip! & mask!) >>> 0)}/{prefix}
            </b>
            .
          </p>
          <p className="mt-1 text-xs text-muted">
            Con OR y la máscara invertida (NOT) se obtiene la última dirección de la red: {formatIpv4((ip! | (~mask! >>> 0)) >>> 0)}. Máscara en binario: {groupBits(toBase(mask!, 2, 32), 8)}.
          </p>
        </>
      )}
    </div>
  )
}

/** Operaciones de bits (AND, OR, XOR, NOT) y su uso más común: aplicar una máscara de red. */
export function BitOps({ modo = 'bits' }: { modo?: 'bits' | 'red' }) {
  const [mode, setMode] = useState(modo)
  return (
    <Frame
      titulo="Operaciones con bits"
      acciones={
        <>
          <Chip active={mode === 'bits'} onClick={() => setMode('bits')}>
            AND, OR, XOR, NOT
          </Chip>
          <Chip active={mode === 'red'} onClick={() => setMode('red')}>
            IP y máscara
          </Chip>
        </>
      }
    >
      {mode === 'bits' ? <Bits /> : <Network />}
    </Frame>
  )
}
