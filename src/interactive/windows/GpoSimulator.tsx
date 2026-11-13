import { useMemo, useState } from 'react'
import { computeRsop, type FilterReason, type GpLink, type GpoDef, type RsopResult } from '@/engines/gpo/rsop'
import { cn } from '@/lib/cn'
import { Button, Icon } from '@/ui'
import { Chip, Frame } from '../fundamentos/Frame'

const DOM = 'DC=empresa,DC=local'
const EMPRESA = `OU=Empresa,${DOM}`
const VENTAS = `OU=Ventas,${EMPRESA}`
const COMPRAS = `OU=Compras,${EMPRESA}`

const CONTAINERS = [
  { dn: DOM, nombre: 'empresa.local', nivel: 0 },
  { dn: EMPRESA, nombre: 'Empresa', nivel: 1 },
  { dn: VENTAS, nombre: 'Ventas', nivel: 2 },
  { dn: COMPRAS, nombre: 'Compras', nivel: 2 },
]

const PROTECTOR = 'Protector de pantalla (minutos)'
const PANEL = 'Panel de control'
const s = (valueName: string, value: string | number) => ({ scope: 'User' as const, key: 'Usuario', valueName, value })

const GPOS: (GpoDef & { color: string })[] = [
  { id: 'base', name: 'Dominio - Base', status: 'AllSettingsEnabled', settings: [s(PROTECTOR, 15), s(PANEL, 'Permitido')], apply: [], color: 'bg-sky-500' },
  { id: 'escritorio', name: 'Empresa - Escritorio', status: 'AllSettingsEnabled', settings: [s(PROTECTOR, 10)], apply: [], color: 'bg-violet-500' },
  { id: 'ventas', name: 'Ventas - Restricciones', status: 'AllSettingsEnabled', settings: [s(PROTECTOR, 5), s(PANEL, 'Bloqueado')], apply: [], color: 'bg-amber-500' },
  { id: 'soporte', name: 'Soporte - Herramientas', status: 'AllSettingsEnabled', settings: [s(PANEL, 'Permitido')], apply: [], color: 'bg-emerald-500' },
]

const PEOPLE = [
  { id: 'maria', nombre: 'María', ou: VENTAS, grupos: ['GG-Ventas'] },
  { id: 'pedro', nombre: 'Pedro', ou: VENTAS, grupos: ['GG-Soporte'] },
  { id: 'juan', nombre: 'Juan', ou: COMPRAS, grupos: ['GG-Compras'] },
]

const FILTERS = ['Authenticated Users', 'GG-Ventas', 'GG-Soporte', 'GG-Compras']

const REASON: Record<FilterReason, string> = {
  'Blocked (Inheritance)': 'cortada por el bloqueo de herencia',
  'Disabled (Link)': 'el vínculo está deshabilitado',
  'Disabled (GPO)': 'la GPO tiene deshabilitada la parte de usuario',
  'Denied (Security)': 'filtrado de seguridad: no es para esta persona',
  'Denied (WMI Filter)': 'el filtro WMI no se cumple',
  'Not Applied (Empty)': 'no tiene configuraciones de usuario',
}

interface Estado {
  links: GpLink[]
  blocked: string[]
  filtros: Record<string, string>
}

const INICIAL: Estado = {
  links: [
    { gpoId: 'base', target: DOM, enabled: true, enforced: false, order: 1 },
    { gpoId: 'escritorio', target: EMPRESA, enabled: true, enforced: false, order: 1 },
    { gpoId: 'ventas', target: VENTAS, enabled: true, enforced: false, order: 1 },
  ],
  blocked: [],
  filtros: { base: 'Authenticated Users', escritorio: 'Authenticated Users', ventas: 'Authenticated Users', soporte: 'GG-Soporte' },
}

function rsop(e: Estado, personId: string): RsopResult {
  const p = PEOPLE.find((x) => x.id === personId)!
  const gpos = GPOS.map((g) => ({ ...g, apply: [e.filtros[g.id]] }))
  return computeRsop({ gpos, links: e.links, blocked: e.blocked, domainDn: DOM, containerDn: p.ou, principals: [p.nombre, ...p.grupos], scope: 'User' })
}

const winner = (r: RsopResult, setting: string) => r.settings.find((w) => w.setting.valueName === setting)

const DESAFIOS: { titulo: string; pista: string; ok: (e: Estado) => boolean }[] = [
  {
    titulo: 'A María le tiene que quedar el protector en 10 minutos (el de "Empresa - Escritorio"), sin desvincular "Ventas - Restricciones".',
    pista: 'Lo de arriba solo le gana a lo de abajo si el vínculo está exigido.',
    ok: (e) => winner(rsop(e, 'maria'), PROTECTOR)?.gpo.id === 'escritorio' && e.links.some((l) => l.gpoId === 'ventas' && l.target === VENTAS && l.enabled),
  },
  {
    titulo: 'Pedro está en la OU Ventas pero es de Soporte: que tenga el Panel de control permitido, sin moverlo de OU, y que María lo siga teniendo bloqueado.',
    pista: 'Podés vincular "Soporte - Herramientas" a Ventas con más prioridad (orden 1), o filtrar "Ventas - Restricciones" para que sea solo de GG-Ventas.',
    ok: (e) => winner(rsop(e, 'pedro'), PANEL)?.setting.value === 'Permitido' && winner(rsop(e, 'maria'), PANEL)?.setting.value === 'Bloqueado',
  },
  {
    titulo: 'En Compras no quieren "Empresa - Escritorio", pero a Juan se le tiene que aplicar igual "Dominio - Base", y el resto de la empresa sigue recibiendo "Empresa - Escritorio".',
    pista: 'Bloquear la herencia en Compras corta todo lo de arriba… salvo lo que esté exigido.',
    ok: (e) => {
      const j = rsop(e, 'juan').applied.map((x) => x.gpo.id)
      return j.includes('base') && !j.includes('escritorio') && rsop(e, 'maria').applied.some((x) => x.gpo.id === 'escritorio')
    },
  },
]

function Toggle({ on, onClick, children, label }: { on: boolean; onClick: () => void; children: string; label: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} aria-label={label} className={cn('min-h-8 rounded border px-2 text-xs', on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:bg-surface-2')}>
      {children}
    </button>
  )
}

/** "¿Qué GPO gana?": vincular, exigir, bloquear herencia y filtrar, y ver el resultado para cada persona. */
export function GpoSimulator() {
  const [e, setE] = useState<Estado>(INICIAL)
  const [persona, setPersona] = useState('maria')
  const [verPista, setVerPista] = useState<number>()
  const r = useMemo(() => rsop(e, persona), [e, persona])
  const p = PEOPLE.find((x) => x.id === persona)!

  const linksOf = (dn: string) => e.links.filter((l) => l.target === dn).sort((a, b) => a.order - b.order)
  const update = (fn: (draft: Estado) => Estado) => setE((prev) => fn(structuredClone(prev)))
  const setLink = (gpoId: string, target: string | '') =>
    update((d) => {
      const others = d.links.filter((l) => l.gpoId !== gpoId)
      const renum = (list: GpLink[]) => {
        for (const c of CONTAINERS) list.filter((l) => l.target === c.dn).sort((a, b) => a.order - b.order).forEach((l, i) => (l.order = i + 1))
        return list
      }
      if (!target) return { ...d, links: renum(others) }
      const prev = d.links.find((l) => l.gpoId === gpoId)
      const order = others.filter((l) => l.target === target).length + 1
      return { ...d, links: renum([...others, { gpoId, target, enabled: prev?.enabled ?? true, enforced: prev?.enforced ?? false, order }]) }
    })
  const moveUp = (link: GpLink) =>
    update((d) => {
      const sib = d.links.filter((l) => l.target === link.target).sort((a, b) => a.order - b.order)
      const i = sib.findIndex((l) => l.gpoId === link.gpoId)
      if (i > 0) [sib[i - 1].order, sib[i].order] = [sib[i].order, sib[i - 1].order]
      return d
    })
  const gpoName = (id: string) => GPOS.find((g) => g.id === id)!
  const ok = DESAFIOS.map((dz) => dz.ok(e))

  return (
    <Frame
      titulo="¿Qué GPO gana?"
      acciones={
        <Button variant="secondary" onClick={() => setE(INICIAL)}>
          <Icon name="refresh" className="h-4 w-4" /> Volver a empezar
        </Button>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-label="Dominio y vínculos">
          <h4 className="mb-2 text-sm font-semibold">Dominio, OU y vínculos</h4>
          <ul className="space-y-2">
            {CONTAINERS.map((c) => (
              <li key={c.dn} className="rounded-lg border border-line p-2" style={{ marginLeft: `${c.nivel * 1.25}rem` }}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{c.nivel === 0 ? '🌐' : '📁'} {c.nombre}</span>
                  {c.nivel > 0 && (
                    <Toggle on={e.blocked.includes(c.dn)} label={`Bloquear herencia en ${c.nombre}`} onClick={() => update((d) => ({ ...d, blocked: d.blocked.includes(c.dn) ? d.blocked.filter((b) => b !== c.dn) : [...d.blocked, c.dn] }))}>
                      Bloquear herencia
                    </Toggle>
                  )}
                  <span className="ml-auto text-xs text-muted">{PEOPLE.filter((x) => x.ou === c.dn).map((x) => `👤 ${x.nombre}`).join('  ')}</span>
                </div>
                <ul className="mt-1 space-y-1">
                  {linksOf(c.dn).map((l, i) => {
                    const g = gpoName(l.gpoId)
                    return (
                      <li key={l.gpoId} className="flex flex-wrap items-center gap-1 text-sm">
                        <span className="w-5 text-center font-mono text-xs text-muted" title="Orden del vínculo (1 = más prioridad)">{l.order}</span>
                        <span className={cn('inline-block h-3 w-3 rounded-sm', g.color)} aria-hidden />
                        <span className={cn(!l.enabled && 'text-muted line-through')}>{g.name}</span>
                        <span className="ml-auto flex gap-1">
                          {i > 0 && (
                            <Toggle on={false} label={`Subir prioridad de ${g.name}`} onClick={() => moveUp(l)}>
                              ↑ prioridad
                            </Toggle>
                          )}
                          <Toggle on={l.enforced} label={`Exigir ${g.name}`} onClick={() => update((d) => ({ ...d, links: d.links.map((x) => (x.gpoId === l.gpoId ? { ...x, enforced: !x.enforced } : x)) }))}>
                            Exigido
                          </Toggle>
                          <Toggle on={l.enabled} label={`Vínculo de ${g.name} habilitado`} onClick={() => update((d) => ({ ...d, links: d.links.map((x) => (x.gpoId === l.gpoId ? { ...x, enabled: !x.enabled } : x)) }))}>
                            Habilitado
                          </Toggle>
                        </span>
                      </li>
                    )
                  })}
                  {linksOf(c.dn).length === 0 && <li className="text-xs text-muted">Sin GPO vinculadas.</li>}
                </ul>
              </li>
            ))}
          </ul>
        </section>
        <section aria-label="GPO">
          <h4 className="mb-2 text-sm font-semibold">GPO</h4>
          <ul className="space-y-2">
            {GPOS.map((g) => {
              const link = e.links.find((l) => l.gpoId === g.id)
              return (
                <li key={g.id} className="rounded-lg border border-line p-2 text-sm">
                  <div className="flex items-center gap-2 font-medium">
                    <span className={cn('inline-block h-3 w-3 rounded-sm', g.color)} aria-hidden />
                    {g.name}
                  </div>
                  <p className="mt-0.5 text-xs text-muted">{g.settings.map((x) => `${x.valueName}: ${x.value}`).join(' · ')}</p>
                  <div className="mt-1 grid gap-2 sm:grid-cols-2">
                    <label className="text-xs">
                      <span className="block text-muted">Vinculada a</span>
                      <select className="min-h-9 w-full rounded border border-line bg-bg px-2" value={link?.target ?? ''} onChange={(ev) => setLink(g.id, ev.target.value)}>
                        <option value="">(sin vincular)</option>
                        {CONTAINERS.map((c) => (
                          <option key={c.dn} value={c.dn}>
                            {c.nombre}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-xs">
                      <span className="block text-muted">Filtrado de seguridad (se aplica a)</span>
                      <select className="min-h-9 w-full rounded border border-line bg-bg px-2" value={e.filtros[g.id]} onChange={(ev) => update((d) => ({ ...d, filtros: { ...d.filtros, [g.id]: ev.target.value } }))}>
                        {FILTERS.map((f) => (
                          <option key={f}>{f}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      </div>

      <section className="mt-4 rounded-lg border border-line p-3" aria-label="Resultado">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-semibold">Resultado para</h4>
          {PEOPLE.map((x) => (
            <Chip key={x.id} active={persona === x.id} onClick={() => setPersona(x.id)}>
              {x.nombre}
            </Chip>
          ))}
          <span className="text-xs text-muted">
            {p.nombre} está en {CONTAINERS.find((c) => c.dn === p.ou)!.nombre} y es de {p.grupos.join(', ')}
          </span>
        </div>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <div>
            <h5 className="text-xs font-semibold uppercase text-muted">Lo que le queda</h5>
            <table className="mt-1 w-full text-sm">
              <tbody>
                {[PROTECTOR, PANEL].map((k) => {
                  const w = winner(r, k)
                  return (
                    <tr key={k} className="border-t border-line align-top">
                      <td className="p-1">{k}</td>
                      <td className="p-1 font-semibold">{w ? String(w.setting.value) : <span className="text-muted">sin configurar</span>}</td>
                      <td className="p-1 text-xs text-muted">
                        {w && (
                          <>
                            gana <b>{w.gpo.name}</b>
                            {w.losers.length > 0 && <> (le gana a {w.losers.map((l) => `${l.gpo.name}: ${l.value}`).join(', ')})</>}
                          </>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div>
            <h5 className="text-xs font-semibold uppercase text-muted">GPO aplicadas (de mayor a menor prioridad)</h5>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm">
              {r.applied.map((a) => (
                <li key={a.gpo.id}>
                  {a.gpo.name} <span className="text-xs text-muted">desde {a.from.replace('empresa.local/', '')}{a.link.enforced ? ', exigida' : ''}</span>
                </li>
              ))}
              {!r.applied.length && <li className="text-muted">Ninguna.</li>}
            </ol>
            {r.filtered.length > 0 && (
              <>
                <h5 className="mt-2 text-xs font-semibold uppercase text-muted">No se aplican</h5>
                <ul className="mt-1 space-y-0.5 text-sm">
                  {r.filtered.map((f) => (
                    <li key={f.gpo.id}>
                      {f.gpo.name}: <span className="text-muted">{REASON[f.reason]}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="mt-4" aria-label="Desafíos">
        <h4 className="text-sm font-semibold">Desafíos ({ok.filter(Boolean).length} de {DESAFIOS.length})</h4>
        <ol className="mt-1 space-y-2">
          {DESAFIOS.map((dz, i) => (
            <li key={i} className={cn('rounded-lg border p-2 text-sm', ok[i] ? 'border-ok bg-ok-soft' : 'border-line')}>
              <div className="flex gap-2">
                <span aria-hidden>{ok[i] ? '✅' : '⬜'}</span>
                <span>
                  <span className="sr-only">{ok[i] ? 'Cumplido: ' : 'Pendiente: '}</span>
                  {dz.titulo}
                </span>
              </div>
              {!ok[i] && (
                <button type="button" className="ml-6 mt-1 text-xs text-accent underline" onClick={() => setVerPista(verPista === i ? undefined : i)}>
                  {verPista === i ? 'Ocultar pista' : 'Ver una pista'}
                </button>
              )}
              {verPista === i && !ok[i] && <p className="ml-6 mt-1 text-xs text-muted">{dz.pista}</p>}
            </li>
          ))}
        </ol>
        <p className="mt-2 text-xs text-muted">Cada desafío se puede resolver por separado (empezá de cero con "Volver a empezar") o todos juntos. En un dominio real, el cliente recién ve los cambios después de un gpupdate o de volver a iniciar sesión.</p>
      </section>
    </Frame>
  )
}
