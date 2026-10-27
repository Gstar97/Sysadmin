import { useEffect, useMemo, useRef, useState } from 'react'
import {
  compressIpv6,
  eui64,
  expandIpv6,
  formatIpv4,
  ipv4Class,
  ipv4Kind,
  ipv6Kind,
  ipv6Network,
  parseIpv4,
  splitNetwork,
  subnetInfo,
  toBinary,
} from '@/engines/network/ip'
import { checkField, generateExercise, parsePrefix, SUBNET_TYPES, type Difficulty, type SubnetExercise, type SubnetExerciseType } from '@/engines/subnetting'
import { cn } from '@/lib/cn'
import { createRng } from '@/lib/random'
import { Badge, Button, Callout, Icon } from '@/ui'

type Tab = 'ipv4' | 'ipv6' | 'practica'

interface Props {
  modo?: 'calculadora' | 'practica' | 'ambos'
  tipos?: SubnetExerciseType[]
  dificultad?: Difficulty
}

export function Subnetting({ modo = 'ambos', tipos, dificultad = 2 }: Props) {
  const tabs: { id: Tab; label: string }[] = [
    ...(modo !== 'practica' ? [{ id: 'ipv4' as const, label: 'Calculadora IPv4' }, { id: 'ipv6' as const, label: 'Calculadora IPv6' }] : []),
    ...(modo !== 'calculadora' ? [{ id: 'practica' as const, label: 'Práctica' }] : []),
  ]
  const [tab, setTab] = useState<Tab>(tabs[0].id)
  return (
    <div className="my-6 rounded-xl border border-line bg-surface shadow-card">
      {tabs.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-line p-1.5" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn('min-h-9 whitespace-nowrap rounded-lg px-3 text-sm font-medium', tab === t.id ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2')}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div className="p-4">
        {tab === 'ipv4' && <Ipv4Calculator />}
        {tab === 'ipv6' && <Ipv6Calculator />}
        {tab === 'practica' && <Practice tipos={tipos} dificultad={dificultad} />}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------
// Calculadora IPv4
// ---------------------------------------------------------------------------------------

function parseInput(text: string): { ip: number; prefix: number } | string {
  const t = text.trim()
  const m = /^(\S+?)\s*(?:\/\s*(\d{1,2})|\s+(\S+))$/.exec(t)
  if (!m) return 'Escribe una dirección con su prefijo (192.168.10.71/26) o con su máscara (192.168.10.71 255.255.255.192).'
  const ip = parseIpv4(m[1])
  if (ip === undefined) return `"${m[1]}" no es una dirección IPv4 válida: son cuatro números de 0 a 255 separados por puntos.`
  const prefix = m[2] !== undefined ? Number(m[2]) : parsePrefix(m[3])
  if (prefix === undefined || prefix > 32) return `"${m[2] ?? m[3]}" no es un prefijo ni una máscara válida (los unos de la máscara tienen que ser contiguos).`
  return { ip, prefix }
}

function BinaryRow({ label, value, prefix }: { label: string; value: number; prefix: number }) {
  const bits = toBinary(value, false)
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 font-mono text-xs sm:text-sm">
      <span className="w-24 shrink-0 font-sans text-muted">{label}</span>
      <span aria-label={`${label}: ${toBinary(value)}`}>
        {bits.split('').map((b, i) => (
          <span key={i}>
            <span className={i < prefix ? 'font-semibold text-accent' : 'text-muted'}>{b}</span>
            {i % 8 === 7 && i < 31 && <span className="text-muted">.</span>}
          </span>
        ))}
      </span>
    </div>
  )
}

function Ipv4Calculator() {
  const [text, setText] = useState('192.168.10.71/26')
  const [split, setSplit] = useState<number | undefined>()
  const parsed = parseInput(text)
  const info = typeof parsed === 'string' ? undefined : subnetInfo(parsed.ip, parsed.prefix)
  const rows: [string, string][] = info && typeof parsed !== 'string'
    ? [
        ['Dirección', formatIpv4(parsed.ip)],
        ['Máscara', `${formatIpv4(info.mask)} (/${info.prefix})`],
        ['Wildcard', formatIpv4(info.wildcard)],
        ['Red', formatIpv4(info.network)],
        ['Broadcast', info.prefix >= 31 ? 'no tiene (/31 y /32)' : formatIpv4(info.broadcast)],
        ['Primer host', formatIpv4(info.firstHost)],
        ['Último host', formatIpv4(info.lastHost)],
        ['Hosts utilizables', info.usableHosts.toLocaleString('es')],
        ['Direcciones totales', info.totalAddresses.toLocaleString('es')],
        ['Clase (histórica)', ipv4Class(parsed.ip)],
        ['Tipo', ipv4Kind(parsed.ip)],
      ]
    : []
  const splitPrefix = info && split && split > info.prefix ? split : undefined
  const subnets = info && splitPrefix ? splitNetwork(info.network, info.prefix, splitPrefix) : []
  return (
    <div className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Dirección y prefijo o máscara</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="w-full max-w-md rounded-lg border border-line bg-bg px-3 py-2 font-mono"
          spellCheck={false}
          autoCapitalize="off"
          inputMode="text"
          aria-invalid={typeof parsed === 'string'}
        />
      </label>
      {typeof parsed === 'string' ? (
        <Callout tone="warn">{parsed}</Callout>
      ) : (
        info && (
          <>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {rows.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 border-b border-line py-1">
                  <dt className="text-muted">{k}</dt>
                  <dd className="text-right font-mono">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="space-y-1 rounded-lg bg-surface-2 p-3">
              <div className="mb-1 text-sm font-medium">En binario (en color, la parte de red)</div>
              <BinaryRow label="Dirección" value={parsed.ip} prefix={info.prefix} />
              <BinaryRow label="Máscara" value={info.mask} prefix={info.prefix} />
              <BinaryRow label="Red" value={info.network} prefix={info.prefix} />
              <BinaryRow label="Broadcast" value={info.broadcast} prefix={info.prefix} />
            </div>
            {info.prefix < 30 && (
              <div>
                <label className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">Dividir en subredes de</span>
                  <select className="rounded-lg border border-line bg-bg px-2 py-1" value={splitPrefix ?? ''} onChange={(e) => setSplit(e.target.value ? Number(e.target.value) : undefined)}>
                    <option value="">elegir prefijo…</option>
                    {Array.from({ length: Math.min(30, info.prefix + 12) - info.prefix }, (_, i) => info.prefix + i + 1).map((p) => (
                      <option key={p} value={p}>
                        /{p} ({2 ** (p - info.prefix)} subredes de {2 ** (32 - p) - 2} hosts)
                      </option>
                    ))}
                  </select>
                </label>
                {splitPrefix && (
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-left font-mono text-xs sm:text-sm">
                      <thead className="text-muted">
                        <tr>
                          <th className="py-1 pr-3 font-sans font-medium">#</th>
                          <th className="py-1 pr-3 font-sans font-medium">Red</th>
                          <th className="py-1 pr-3 font-sans font-medium">Rango de hosts</th>
                          <th className="py-1 font-sans font-medium">Broadcast</th>
                        </tr>
                      </thead>
                      <tbody>
                        {subnets.slice(0, 16).map((n, i) => {
                          const s = subnetInfo(n, splitPrefix)
                          return (
                            <tr key={n} className="border-t border-line">
                              <td className="py-1 pr-3">{i + 1}</td>
                              <td className="py-1 pr-3">{formatIpv4(n)}/{splitPrefix}</td>
                              <td className="py-1 pr-3">
                                {formatIpv4(s.firstHost)} – {formatIpv4(s.lastHost)}
                              </td>
                              <td className="py-1">{formatIpv4(s.broadcast)}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    {subnets.length > 16 && <p className="mt-1 text-sm text-muted">… y {(subnets.length - 16).toLocaleString('es')} subredes más.</p>}
                  </div>
                )}
              </div>
            )}
          </>
        )
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------
// Calculadora IPv6
// ---------------------------------------------------------------------------------------

function Ipv6Calculator() {
  const [text, setText] = useState('2001:db8:acad:10::25/64')
  const [mac, setMac] = useState('00:1A:2B:3C:4D:5E')
  const [addr, pre] = text.trim().split('/')
  const prefix = pre === undefined ? 64 : Number(pre)
  const full = expandIpv6(addr ?? '')
  const valid = !!full && Number.isInteger(prefix) && prefix >= 0 && prefix <= 128
  const iid = eui64(mac)
  const net64 = valid ? expandIpv6(ipv6Network(addr, 64) ?? '') : undefined
  const eui = net64 && iid ? compressIpv6(`${net64.split(':').slice(0, 4).join(':')}:${iid}`) : undefined
  return (
    <div className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Dirección IPv6 con prefijo</span>
        <input value={text} onChange={(e) => setText(e.target.value)} className="w-full max-w-lg rounded-lg border border-line bg-bg px-3 py-2 font-mono" spellCheck={false} autoCapitalize="off" aria-invalid={!valid} />
      </label>
      {!valid ? (
        <Callout tone="warn">Escribe una dirección IPv6 válida, por ejemplo 2001:db8:acad:10::25/64. Solo puede haber un "::" y cada grupo tiene hasta 4 dígitos hexadecimales.</Callout>
      ) : (
        <dl className="grid grid-cols-1 gap-y-1 text-sm">
          {[
            ['Forma completa', full],
            ['Forma abreviada (RFC 5952)', compressIpv6(full)],
            ['Tipo', ipv6Kind(full)],
            [`Prefijo de red (/${prefix})`, `${ipv6Network(full, prefix)}/${prefix}`],
            ['Identificador de interfaz', full.split(':').slice(4).join(':')],
            ['Subredes /64 dentro del prefijo', prefix <= 64 ? (2n ** BigInt(64 - prefix)).toLocaleString('es') : 'el prefijo es más largo que /64'],
          ].map(([k, v]) => (
            <div key={k} className="flex flex-wrap justify-between gap-3 border-b border-line py-1">
              <dt className="text-muted">{k}</dt>
              <dd className="break-all text-right font-mono">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="rounded-lg bg-surface-2 p-3">
        <div className="mb-2 text-sm font-medium">Identificador EUI-64 a partir de una MAC</div>
        <input value={mac} onChange={(e) => setMac(e.target.value)} className="w-full max-w-xs rounded-lg border border-line bg-bg px-3 py-2 font-mono" spellCheck={false} autoCapitalize="off" aria-label="Dirección MAC" />
        {iid ? (
          <p className="mt-2 text-sm">
            Se parte la MAC al medio, se inserta <code className="font-mono">FFFE</code> y se invierte el séptimo bit del primer byte: <span className="font-mono font-semibold">{iid}</span>
            {eui && (
              <>
                {' '}
                → con el prefijo /64 de arriba queda <span className="break-all font-mono font-semibold">{eui}</span>
              </>
            )}
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted">Escribe una MAC de 12 dígitos hexadecimales.</p>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------
// Práctica
// ---------------------------------------------------------------------------------------

interface Stats {
  total: number
  correct: number
  streak: number
  best: number
  byType: Record<string, { total: number; correct: number }>
}

const STATS_KEY = 'carrera-infra:subnetting'

function loadStats(): Stats {
  try {
    const raw = localStorage.getItem(STATS_KEY)
    if (raw) return JSON.parse(raw) as Stats
  } catch {
    // almacenamiento no disponible
  }
  return { total: 0, correct: 0, streak: 0, best: 0, byType: {} }
}

function saveStats(s: Stats) {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(s))
  } catch {
    // almacenamiento no disponible
  }
}

const TIMED_SECONDS = 300

function Practice({ tipos, dificultad }: { tipos?: SubnetExerciseType[]; dificultad: Difficulty }) {
  const available = SUBNET_TYPES.filter((t) => !tipos || tipos.includes(t.id))
  const [selected, setSelected] = useState<SubnetExerciseType[]>(available.slice(0, Math.min(available.length, 4)).map((t) => t.id))
  const [level, setLevel] = useState<Difficulty>(dificultad)
  const rng = useMemo(() => createRng(), [])
  const [exercise, setExercise] = useState<SubnetExercise>(() => generateExercise(rng, available[0].id, dificultad))
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [checked, setChecked] = useState<Record<string, boolean> | undefined>()
  const [stats, setStats] = useState<Stats>(loadStats)
  const [timer, setTimer] = useState<{ end: number; correct: number; total: number } | undefined>()
  const [now, setNow] = useState(() => Date.now())
  const firstInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!timer) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [timer])

  const remaining = timer ? Math.max(0, Math.ceil((timer.end - now) / 1000)) : 0
  const timeUp = !!timer && remaining === 0

  const next = (types = selected, lvl = level) => {
    const pool = types.length ? types : [available[0].id]
    const tipo = pool[Math.floor(Math.random() * pool.length)]
    setExercise(generateExercise(rng, tipo, lvl))
    setAnswers({})
    setChecked(undefined)
    requestAnimationFrame(() => firstInput.current?.focus())
  }

  const check = () => {
    const result = Object.fromEntries(exercise.campos.map((f) => [f.id, checkField(f, answers[f.id] ?? '')]))
    setChecked(result)
    const ok = Object.values(result).every(Boolean)
    const t = stats.byType[exercise.tipo] ?? { total: 0, correct: 0 }
    const updated: Stats = {
      total: stats.total + 1,
      correct: stats.correct + (ok ? 1 : 0),
      streak: ok ? stats.streak + 1 : 0,
      best: Math.max(stats.best, ok ? stats.streak + 1 : 0),
      byType: { ...stats.byType, [exercise.tipo]: { total: t.total + 1, correct: t.correct + (ok ? 1 : 0) } },
    }
    setStats(updated)
    saveStats(updated)
    if (timer && !timeUp) setTimer({ ...timer, total: timer.total + 1, correct: timer.correct + (ok ? 1 : 0) })
  }

  const toggleType = (id: SubnetExerciseType) => {
    const nextSel = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
    setSelected(nextSel)
  }

  const allOk = checked && Object.values(checked).every(Boolean)

  return (
    <div className="space-y-4">
      <details className="rounded-lg border border-line p-3">
        <summary className="cursor-pointer text-sm font-medium">Tipos de ejercicio y dificultad</summary>
        <div className="mt-3 flex flex-wrap gap-2">
          {available.map((t) => (
            <label key={t.id} className={cn('flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-sm', selected.includes(t.id) ? 'border-accent bg-accent-soft text-accent' : 'border-line')}>
              <input type="checkbox" className="sr-only" checked={selected.includes(t.id)} onChange={() => toggleType(t.id)} />
              {selected.includes(t.id) && <Icon name="check" className="h-3.5 w-3.5" />}
              {t.nombre}
            </label>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span>Dificultad:</span>
          {([1, 2, 3] as Difficulty[]).map((d) => (
            <button key={d} type="button" onClick={() => setLevel(d)} className={cn('min-h-8 rounded-lg border px-3', level === d ? 'border-accent bg-accent-soft text-accent' : 'border-line')}>
              {d === 1 ? 'Fácil' : d === 2 ? 'Media' : 'Difícil'}
            </button>
          ))}
          <Button variant="secondary" onClick={() => next(selected, level)}>
            Aplicar
          </Button>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="neutral">
          Aciertos: {stats.correct}/{stats.total}
        </Badge>
        <Badge tone={stats.streak >= 5 ? 'ok' : 'neutral'}>Racha: {stats.streak}</Badge>
        <Badge tone="neutral">Mejor racha: {stats.best}</Badge>
        {timer ? (
          <Badge tone={timeUp ? 'bad' : 'accent'}>
            <Icon name="clock" className="h-3.5 w-3.5" />
            {timeUp ? 'Tiempo terminado' : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`}
          </Badge>
        ) : (
          <Button
            variant="ghost"
            onClick={() => {
              setTimer({ end: Date.now() + TIMED_SECONDS * 1000, correct: 0, total: 0 })
              setNow(Date.now())
              next()
            }}
          >
            <Icon name="clock" className="h-4 w-4" />
            Contrarreloj (5 min)
          </Button>
        )}
      </div>

      {timeUp && timer ? (
        <Callout tone="info" title="Fin del contrarreloj">
          Resolviste {timer.correct} de {timer.total} ejercicios en 5 minutos.{' '}
          <button type="button" className="font-medium text-accent underline" onClick={() => setTimer(undefined)}>
            Volver a la práctica libre
          </button>
        </Callout>
      ) : (
        <form
          className="space-y-3 rounded-lg border border-line p-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (checked) next()
            else check()
          }}
        >
          <p className="font-medium">{exercise.enunciado}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {exercise.campos.map((f, i) => (
              <label key={f.id} className="block">
                <span className="mb-1 block text-sm text-muted">{f.etiqueta}</span>
                <div className="flex items-center gap-2">
                  <input
                    ref={i === 0 ? firstInput : undefined}
                    value={answers[f.id] ?? ''}
                    onChange={(e) => setAnswers((a) => ({ ...a, [f.id]: e.target.value }))}
                    disabled={!!checked}
                    className={cn('w-full rounded-lg border bg-bg px-3 py-2 font-mono', checked ? (checked[f.id] ? 'border-ok' : 'border-bad') : 'border-line')}
                    inputMode={f.formato === 'numero' ? 'numeric' : 'text'}
                    autoCapitalize="off"
                    spellCheck={false}
                    placeholder={f.formato === 'prefijo' ? '/24 o 255.255.255.0' : f.formato === 'si_no' ? 'sí o no' : ''}
                  />
                  {checked && <Icon name={checked[f.id] ? 'check' : 'x'} className={checked[f.id] ? 'text-ok' : 'text-bad'} />}
                </div>
                {checked && !checked[f.id] && <span className="mt-1 block font-mono text-sm text-ok">Correcto: {f.respuesta}</span>}
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            {!checked ? <Button type="submit">Comprobar</Button> : <Button type="submit">Siguiente ejercicio</Button>}
          </div>
          {checked && (
            <Callout tone={allOk ? 'ok' : 'warn'} title={allOk ? '¡Correcto!' : 'Así se resuelve'}>
              <ol className="list-decimal space-y-1 pl-5">
                {exercise.pasos.map((p, i) => (
                  <li key={i} className="whitespace-pre-wrap font-mono text-xs sm:text-sm">
                    {p}
                  </li>
                ))}
              </ol>
            </Callout>
          )}
        </form>
      )}
    </div>
  )
}
