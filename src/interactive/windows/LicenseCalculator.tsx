import { useMemo, useState } from 'react'
import { cals, equilibrio, generarEjercicio, licenciar, type Edicion, type EjercicioLicencias } from '@/engines/windows/licencias'
import { cn } from '@/lib/cn'
import { createRng } from '@/lib/random'
import { Button } from '@/ui'
import { Chip, Feedback, Frame, inputClass, Score } from '../fundamentos/Frame'

const usd = (n: number) => `US$ ${n.toLocaleString('es-AR')}`

function Numero({ label, value, onChange, min = 0, max = 999 }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number }) {
  return (
    <label className="text-sm">
      <span className="block text-muted">{label}</span>
      <input type="number" min={min} max={max} value={value} onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || 0)))} className={cn(inputClass, 'w-full')} />
    </label>
  )
}

function Resultado({ edicion, procesadores, nucleos, vms, mejor }: { edicion: Edicion; procesadores: number; nucleos: number; vms: number; mejor: boolean }) {
  const l = licenciar({ procesadores, nucleos }, vms, edicion)
  return (
    <div className={cn('rounded-lg border p-3', mejor ? 'border-ok bg-ok-soft' : 'border-line')}>
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="font-semibold">{edicion}</h4>
        {mejor && <span className="text-xs font-semibold text-ok">Conviene</span>}
      </div>
      <p className="mt-1 text-2xl font-semibold">{l.totalNucleos} núcleos</p>
      <p className="text-sm text-muted">
        {l.paquetes16} paquete{l.paquetes16 === 1 ? '' : 's'} de 16{l.paquetes2 ? ` + ${l.paquetes2} de 2` : ''} · ≈ {usd(l.costoUsd)}
      </p>
      <p className="text-sm">VM cubiertas: {l.vmsCubiertas === Infinity ? 'ilimitadas' : l.vmsCubiertas}</p>
      <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-xs text-muted">
        {l.pasos.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ol>
    </div>
  )
}

function Calculadora() {
  const [procesadores, setProcesadores] = useState(1)
  const [nucleos, setNucleos] = useState(12)
  const [vms, setVms] = useState(4)
  const [usuarios, setUsuarios] = useState(40)
  const [dispositivos, setDispositivos] = useState(55)
  const st = licenciar({ procesadores, nucleos }, vms, 'Standard')
  const dc = licenciar({ procesadores, nucleos }, vms, 'Datacenter')
  const eq = equilibrio({ procesadores, nucleos })
  const cal = cals(usuarios, dispositivos)
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Numero label="Procesadores (sockets)" value={procesadores} onChange={setProcesadores} min={1} max={8} />
        <Numero label="Núcleos por procesador" value={nucleos} onChange={setNucleos} min={1} max={128} />
        <Numero label="VM de Windows Server" value={vms} onChange={setVms} max={100} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Resultado edicion="Standard" procesadores={procesadores} nucleos={nucleos} vms={vms} mejor={st.costoUsd <= dc.costoUsd} />
        <Resultado edicion="Datacenter" procesadores={procesadores} nucleos={nucleos} vms={vms} mejor={dc.costoUsd < st.costoUsd} />
      </div>
      <p className="text-sm">
        En este servidor, Datacenter empieza a convenir desde <b>{eq} VM</b>. Precios de referencia: el sugerido por Microsoft para 16 núcleos (Standard US$ 1.176, Datacenter US$ 6.771); el real depende del canal de compra.
      </p>
      <div className="rounded-lg border border-line p-3">
        <h4 className="font-semibold">Licencias de acceso (CAL)</h4>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <Numero label="Personas que usan el servidor" value={usuarios} onChange={setUsuarios} max={100000} />
          <Numero label="Dispositivos que se conectan" value={dispositivos} onChange={setDispositivos} max={100000} />
        </div>
        <p className="mt-2 text-sm">
          Conviene: <b>{cal.cantidad} CAL de {cal.tipo}</b>. {cal.motivo}
        </p>
        <p className="mt-1 text-xs text-muted">Las CAL tienen que ser de Windows Server 2025 (o más nuevas): las de 2022 no sirven. El Escritorio remoto lleva sus propias CAL (RDS). Con el pago por uso de Azure Arc no se compran núcleos ni CAL de Windows Server.</p>
      </div>
    </div>
  )
}

function Practica() {
  const rng = useMemo(() => createRng(), [])
  const [ex, setEx] = useState<EjercicioLicencias>(() => generarEjercicio(rng))
  const [valor, setValor] = useState('')
  const [respondido, setRespondido] = useState(false)
  const [stats, setStats] = useState({ correct: 0, total: 0, streak: 0 })
  const ok = Number(valor) === ex.respuesta
  const responder = () => {
    if (respondido || !valor) return
    setRespondido(true)
    setStats((s) => ({ correct: s.correct + (ok ? 1 : 0), total: s.total + 1, streak: ok ? s.streak + 1 : 0 }))
  }
  return (
    <div className="space-y-3">
      <Score {...stats} />
      <p>{ex.enunciado}</p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          responder()
        }}
      >
        <label className="text-sm">
          <span className="block text-muted">Núcleos de licencia</span>
          <input type="number" min={0} value={valor} onChange={(e) => setValor(e.target.value)} disabled={respondido} className={cn(inputClass, 'w-40')} />
        </label>
        <Button type="submit" disabled={respondido || !valor}>
          Comprobar
        </Button>
      </form>
      {respondido && (
        <>
          <Feedback ok={ok} titulo={ok ? '¡Correcto!' : `No: son ${ex.respuesta} núcleos`} pasos={ex.pasos} />
          <Button
            onClick={() => {
              setEx(generarEjercicio(rng))
              setValor('')
              setRespondido(false)
            }}
          >
            Otro ejercicio
          </Button>
        </>
      )}
    </div>
  )
}

/** Cuántas licencias de Windows Server 2025 hay que comprar, Standard contra Datacenter, y CAL. */
export function LicenseCalculator({ modo = 'ambos' }: { modo?: 'calculadora' | 'practica' | 'ambos' }) {
  const [tab, setTab] = useState<'calc' | 'practica'>(modo === 'practica' ? 'practica' : 'calc')
  return (
    <Frame
      titulo="Licencias de Windows Server 2025"
      acciones={
        modo === 'ambos' && (
          <>
            <Chip active={tab === 'calc'} onClick={() => setTab('calc')}>
              Calculadora
            </Chip>
            <Chip active={tab === 'practica'} onClick={() => setTab('practica')}>
              Práctica
            </Chip>
          </>
        )
      }
    >
      {tab === 'calc' ? <Calculadora /> : <Practica />}
    </Frame>
  )
}
