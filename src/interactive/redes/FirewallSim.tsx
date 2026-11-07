import { useMemo, useState } from 'react'
import { OFICINA, REQUISITOS_LAN, describeRegla, evaluar, paquetesOficina, type Regla, type Zona } from '@/engines/redes/firewall'
import { createRng, shuffle } from '@/lib/random'
import { cn } from '@/lib/cn'
import { Button } from '@/ui'
import { Chip, Feedback, Frame, Score } from '../fundamentos/Frame'

type Modo = 'pasa' | 'ordenar'

function Zonas() {
  return (
    <svg viewBox="0 0 440 150" className="h-auto w-full max-w-[440px]" role="img" aria-label="Internet conectado a la interfaz WAN del firewall (IP pública 203.0.113.10); del firewall salen la LAN 192.168.1.0/24 y la DMZ 172.16.0.0/24 con el servidor web 172.16.0.10">
      <g fill="none" stroke="var(--line)" strokeWidth="2">
        <line x1="110" y1="75" x2="180" y2="75" />
        <line x1="260" y1="60" x2="320" y2="35" />
        <line x1="260" y1="90" x2="320" y2="115" />
      </g>
      <rect x="10" y="50" width="100" height="50" rx="25" fill="var(--surface-2)" stroke="var(--line)" />
      <rect x="180" y="50" width="80" height="50" rx="8" fill="var(--warn-soft)" stroke="var(--warn)" />
      <rect x="320" y="14" width="110" height="42" rx="8" fill="var(--info-soft)" stroke="var(--line)" />
      <rect x="320" y="94" width="110" height="42" rx="8" fill="var(--ok-soft)" stroke="var(--line)" />
      <g fontFamily="system-ui" fontSize="11" fill="var(--fg)" textAnchor="middle">
        <text x="60" y="79" fontWeight="700">Internet</text>
        <text x="220" y="72" fontWeight="700">Firewall</text>
        <text x="220" y="88" fontSize="9.5">WAN 203.0.113.10</text>
        <text x="375" y="32" fontWeight="700">LAN</text>
        <text x="375" y="47" fontSize="9.5">192.168.1.0/24</text>
        <text x="375" y="112" fontWeight="700">DMZ</text>
        <text x="375" y="127" fontSize="9.5">172.16.0.0/24 · web .10</text>
      </g>
    </svg>
  )
}

function TablaReglas({ reglas, zona, marcar }: { reglas: Regla[]; zona: Zona; marcar?: string }) {
  const rs = reglas.filter((r) => r.interfaz === zona)
  return (
    <div>
      <h4 className="mb-1 text-sm font-semibold">Reglas de la interfaz {zona}</h4>
      <ol className="space-y-1 text-xs">
        {rs.map((r, i) => (
          <li key={r.id} className={cn('flex gap-2 rounded-lg border border-line px-2 py-1', marcar === r.id && 'border-[var(--accent)] bg-[var(--accent)]/10')}>
            <span className="font-mono text-muted">{i + 1}</span>
            <span className={cn('font-semibold', r.accion === 'permitir' ? 'text-ok' : 'text-bad')}>{r.accion === 'permitir' ? 'Permitir' : 'Bloquear'}</span>
            <span className="font-mono">{describeRegla(r).replace(/^(Permitir|Bloquear) /, '')}</span>
          </li>
        ))}
        <li className="flex gap-2 rounded-lg border border-dashed border-line px-2 py-1 text-muted">
          <span className="font-mono">·</span> Todo lo demás: bloqueado (denegación por defecto)
        </li>
      </ol>
    </div>
  )
}

function cumple(lan: Regla[]): boolean {
  const reglas = [...OFICINA.reglas.filter((r) => r.interfaz !== 'LAN'), ...lan]
  return REQUISITOS_LAN.every((q) => evaluar(OFICINA, q.paquete, reglas).pasa === q.pasa)
}

/** ¿Pasa este paquete? y ordenar reglas, sobre un firewall con estado con LAN, DMZ y WAN. */
export function FirewallSim() {
  const rng = useMemo(() => createRng(), [])
  const [modo, setModo] = useState<Modo>('pasa')
  const pool = useMemo(() => shuffle(rng, paquetesOficina()), [rng])
  const [idx, setIdx] = useState(0)
  const [answer, setAnswer] = useState<boolean>()
  const [stats, setStats] = useState({ correct: 0, total: 0, streak: 0 })
  const [orden, setOrden] = useState<Regla[]>(() => {
    // Desordenadas de verdad: un orden que ya cumple la política no sirve como ejercicio.
    const lan = OFICINA.reglas.filter((r) => r.interfaz === 'LAN')
    let o = shuffle(rng, lan)
    while (cumple(o)) o = shuffle(rng, lan)
    return o
  })

  const p = pool[idx % pool.length]
  const res = evaluar(OFICINA, p)
  const choose = (a: boolean) => {
    if (answer !== undefined) return
    setAnswer(a)
    const ok = a === res.pasa
    setStats((s) => ({ correct: s.correct + (ok ? 1 : 0), total: s.total + 1, streak: ok ? s.streak + 1 : 0 }))
  }
  const reglasOrden = [...OFICINA.reglas.filter((r) => r.interfaz !== 'LAN'), ...orden]
  const checks = REQUISITOS_LAN.map((q) => ({ q, r: evaluar(OFICINA, q.paquete, reglasOrden) }))
  const allOk = checks.every((c) => c.r.pasa === c.q.pasa)
  const move = (i: number, d: number) => {
    const j = i + d
    if (j < 0 || j >= orden.length) return
    const next = [...orden]
    ;[next[i], next[j]] = [next[j], next[i]]
    setOrden(next)
  }

  return (
    <Frame
      titulo="¿Pasa este paquete?"
      acciones={
        <>
          <Chip active={modo === 'pasa'} onClick={() => setModo('pasa')}>
            Predecir
          </Chip>
          <Chip active={modo === 'ordenar'} onClick={() => setModo('ordenar')}>
            Ordenar las reglas
          </Chip>
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <Zonas />
          <p className="text-xs text-muted">Redirección de puertos: TCP 443 a la IP pública → 172.16.0.10:443.</p>
          {modo === 'pasa' ? (
            <>
              {(['WAN', 'DMZ', 'LAN'] as Zona[]).map((z) => (
                <TablaReglas key={z} reglas={OFICINA.reglas} zona={z} marcar={answer !== undefined ? res.regla?.id : undefined} />
              ))}
            </>
          ) : (
            <TablaReglas reglas={OFICINA.reglas.filter((r) => r.interfaz !== 'LAN')} zona="WAN" />
          )}
        </div>
        <div className="space-y-3">
          {modo === 'pasa' ? (
            <>
              <Score {...stats} />
              <p className="rounded-lg bg-surface-2 p-3 text-sm font-medium">{p.texto}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant={answer === true ? 'primary' : 'secondary'} disabled={answer !== undefined} onClick={() => choose(true)}>
                  Pasa
                </Button>
                <Button variant={answer === false ? 'primary' : 'secondary'} disabled={answer !== undefined} onClick={() => choose(false)}>
                  Se bloquea
                </Button>
              </div>
              {answer !== undefined && (
                <>
                  <div aria-live="polite">
                    <Feedback ok={answer === res.pasa} titulo={answer === res.pasa ? `¡Correcto! ${res.pasa ? 'Pasa.' : 'Se bloquea.'}` : res.pasa ? 'Pasa.' : 'Se bloquea.'} pasos={res.pasos} />
                  </div>
                  <Button
                    onClick={() => {
                      setIdx((i) => i + 1)
                      setAnswer(undefined)
                    }}
                  >
                    Otro paquete
                  </Button>
                </>
              )}
            </>
          ) : (
            <>
              <p className="text-sm">Estas son las reglas de la interfaz LAN, desordenadas. Ponlas en el orden correcto para que se cumpla todo lo de abajo. Recuerda: gana la primera que coincide.</p>
              <ol className="space-y-1 text-xs">
                {orden.map((r, i) => (
                  <li key={r.id} className="flex items-center gap-2 rounded-lg border border-line px-2 py-1">
                    <span className="font-mono text-muted">{i + 1}</span>
                    <span className="flex-1">
                      <span className={cn('font-semibold', r.accion === 'permitir' ? 'text-ok' : 'text-bad')}>{r.accion === 'permitir' ? 'Permitir' : 'Bloquear'}</span> <span className="font-mono">{describeRegla(r).replace(/^(Permitir|Bloquear) /, '')}</span>
                    </span>
                    <button type="button" className="rounded px-2 py-1 hover:bg-surface-2 disabled:opacity-30" aria-label="Subir regla" disabled={i === 0} onClick={() => move(i, -1)}>
                      ↑
                    </button>
                    <button type="button" className="rounded px-2 py-1 hover:bg-surface-2 disabled:opacity-30" aria-label="Bajar regla" disabled={i === orden.length - 1} onClick={() => move(i, 1)}>
                      ↓
                    </button>
                  </li>
                ))}
              </ol>
              <ul className="space-y-1 text-sm" aria-live="polite">
                {checks.map(({ q, r }) => {
                  const ok = r.pasa === q.pasa
                  return (
                    <li key={q.paquete.texto} className={cn(ok ? 'text-ok' : 'text-bad')}>
                      {ok ? '✓' : '✗'} {q.paquete.texto}: tiene que {q.pasa ? 'pasar' : 'bloquearse'}
                      {!ok && ` (ahora ${r.pasa ? 'pasa' : 'se bloquea'}${r.regla ? ` por "${r.regla.descripcion}"` : ''})`}
                    </li>
                  )
                })}
              </ul>
              {allOk && <Feedback ok titulo="¡Listo! El orden cumple la política." pasos={['Primero la excepción más específica (la PC de sistemas), después el bloqueo general del SSH y al final el permiso amplio. Si el permiso amplio va arriba, se come todo lo demás.']} />}
            </>
          )}
        </div>
      </div>
    </Frame>
  )
}
