import { useMemo, useState } from 'react'
import { ace, ALL_RIGHTS, effectiveAcl, explainRights, intersect, LEVEL_ES, levelOf, RIGHT_ES, shareRights, type Ace, type AceView, type FsTree, type Level, type Right, type SecurityDescriptor, type ShareAce, type ShareLevel } from '@/engines/windows/permisos'
import { cn } from '@/lib/cn'
import { Button, Icon } from '@/ui'
import { Chip, Frame } from '../fundamentos/Frame'

const ROOT = 'D:\\Datos'
const FOLDERS = [
  { path: ROOT, nombre: 'Datos', nivel: 0 },
  { path: `${ROOT}\\Ventas`, nombre: 'Ventas', nivel: 1 },
  { path: `${ROOT}\\Ventas\\Precios`, nombre: 'Precios', nivel: 2 },
  { path: `${ROOT}\\Compras`, nombre: 'Compras', nivel: 1 },
]

const GROUPS = ['BUILTIN\\Administrators', 'NT AUTHORITY\\SYSTEM', 'EMPRESA\\Domain Users', 'EMPRESA\\GG-Ventas', 'EMPRESA\\GG-Compras', 'EMPRESA\\GG-Pasantes', 'EMPRESA\\DL-Ventas-Modificar', 'EMPRESA\\DL-Compras-Modificar', 'Everyone']
const short = (id: string) => id.replace(/^(EMPRESA|BUILTIN|NT AUTHORITY)\\/, '')

const PEOPLE = [
  { id: 'maria', nombre: 'María', detalle: 'de Ventas (GG-Ventas, que está en DL-Ventas-Modificar)', principals: ['EMPRESA\\mlopez', 'EMPRESA\\GG-Ventas', 'EMPRESA\\DL-Ventas-Modificar'] },
  { id: 'pablo', nombre: 'Pablo', detalle: 'pasante de Ventas (GG-Ventas y GG-Pasantes)', principals: ['EMPRESA\\pruiz', 'EMPRESA\\GG-Ventas', 'EMPRESA\\GG-Pasantes', 'EMPRESA\\DL-Ventas-Modificar'] },
  { id: 'juan', nombre: 'Juan', detalle: 'de Compras (GG-Compras, que está en DL-Compras-Modificar)', principals: ['EMPRESA\\jperez', 'EMPRESA\\GG-Compras', 'EMPRESA\\DL-Compras-Modificar'] },
  { id: 'ana', nombre: 'Ana', detalle: 'de IT (Domain Admins)', principals: ['EMPRESA\\aadmin', 'EMPRESA\\Domain Admins', 'BUILTIN\\Administrators'] },
].map((p) => ({ ...p, principals: [...p.principals, 'EMPRESA\\Domain Users', 'BUILTIN\\Users', 'Everyone', 'NT AUTHORITY\\Authenticated Users'] }))

const APLICA = [
  { id: 'todo', label: 'Esta carpeta, subcarpetas y archivos', flags: { oi: true, ci: true } },
  { id: 'carpeta', label: 'Solo esta carpeta', flags: {} },
  { id: 'carpeta_sub', label: 'Esta carpeta y subcarpetas', flags: { ci: true } },
  { id: 'carpeta_arch', label: 'Esta carpeta y archivos', flags: { oi: true } },
  { id: 'hijos', label: 'Solo subcarpetas y archivos', flags: { oi: true, ci: true, io: true } },
] as const

/** Columnas de una fila de permisos: apiladas en el celular, en fila desde sm. */
const ROW = 'grid grid-cols-2 items-center gap-1 sm:grid-cols-[1.3fr_0.8fr_1.1fr_1.5fr_1.5rem]'

const LEVELS: Level[] = ['FullControl', 'Modify', 'ReadAndExecute', 'Read', 'Write']

function aplicaOf(e: Ace): string {
  return APLICA.find((a) => !!(a.flags as Partial<Ace>).oi === e.oi && !!(a.flags as Partial<Ace>).ci === e.ci && !!(a.flags as Partial<Ace>).io === e.io)?.id ?? 'todo'
}

interface Estado {
  sds: Record<string, SecurityDescriptor>
  share: ShareAce[]
}

const INICIAL: Estado = {
  sds: {
    [ROOT]: {
      owner: 'BUILTIN\\Administrators',
      protected: true,
      entries: [ace('BUILTIN\\Administrators', 'FullControl'), ace('NT AUTHORITY\\SYSTEM', 'FullControl'), ace('EMPRESA\\Domain Users', 'ReadAndExecute')],
    },
  },
  share: [{ identity: 'Everyone', level: 'Read', type: 'Allow' }],
}

const INICIAL_RED: Estado = {
  sds: {
    ...INICIAL.sds,
    [ROOT]: { owner: 'BUILTIN\\Administrators', protected: true, entries: [ace('BUILTIN\\Administrators', 'FullControl'), ace('NT AUTHORITY\\SYSTEM', 'FullControl'), ace('EMPRESA\\Domain Users', 'ReadAndExecute', 'Allow', {})] },
    [`${ROOT}\\Ventas`]: { owner: 'BUILTIN\\Administrators', protected: true, entries: [ace('BUILTIN\\Administrators', 'FullControl'), ace('NT AUTHORITY\\SYSTEM', 'FullControl'), ace('EMPRESA\\DL-Ventas-Modificar', 'Modify')] },
    [`${ROOT}\\Compras`]: { owner: 'BUILTIN\\Administrators', protected: true, entries: [ace('BUILTIN\\Administrators', 'FullControl'), ace('NT AUTHORITY\\SYSTEM', 'FullControl'), ace('EMPRESA\\DL-Compras-Modificar', 'Modify')] },
  },
  share: [{ identity: 'Everyone', level: 'Read', type: 'Allow' }],
}

function treeOf(e: Estado): FsTree {
  return {
    sd: (p) => e.sds[p],
    isDir: () => true,
    parent: (p) => (p === ROOT ? undefined : p.slice(0, p.lastIndexOf('\\'))),
  }
}

function result(e: Estado, path: string, personId: string, red: boolean) {
  const p = PEOPLE.find((x) => x.id === personId)!
  const acl = effectiveAcl(treeOf(e), path)
  const principals = red ? [...p.principals, 'NT AUTHORITY\\NETWORK'] : p.principals
  const why = explainRights(acl, principals)
  const ntfs = new Set(ALL_RIGHTS.filter((r) => why[r].ok))
  const share = shareRights(e.share, principals)
  const final = red ? intersect(ntfs, share) : ntfs
  return { acl, why, ntfs, share, final }
}

const lvl = (s: Set<Right>) => LEVEL_ES[levelOf(s)]

interface Desafio {
  titulo: string
  pista: string
  ok: (e: Estado) => boolean
}

const has = (e: Estado, path: string, who: string, red: boolean) => result(e, path, who, red).final
const isLevel = (s: Set<Right>, l: Level | 'None') => levelOf(s) === l

const DESAFIOS_NTFS: Desafio[] = [
  {
    titulo: 'Hoy cualquiera lee todo. Que en Ventas solo entre Ventas (con Modificar) y Juan no pueda ni listar; IT sigue con control total.',
    pista: 'En Ventas, destildá "Heredar de la carpeta de arriba" (los permisos heredados se copian como explícitos), quitá Domain Users y agregá Modificar para DL-Ventas-Modificar. Un permiso heredado no se puede quitar sin cortar la herencia.',
    ok: (e) => isLevel(has(e, `${ROOT}\\Ventas`, 'maria', false), 'Modify') && isLevel(has(e, `${ROOT}\\Ventas`, 'juan', false), 'None') && isLevel(has(e, `${ROOT}\\Ventas`, 'ana', false), 'FullControl'),
  },
  {
    titulo: 'Pablo, el pasante, tiene que poder leer Precios pero no cambiar nada ahí, sin sacarlo de GG-Ventas. María sigue modificando.',
    pista: 'Una denegación explícita de Escritura (y Eliminar) para GG-Pasantes en Precios gana sobre el Modificar heredado de Ventas.',
    ok: (e) => isLevel(has(e, `${ROOT}\\Ventas\\Precios`, 'pablo', false), 'ReadAndExecute') && isLevel(has(e, `${ROOT}\\Ventas\\Precios`, 'maria', false), 'Modify'),
  },
  {
    titulo: 'En Compras, Juan modifica y María no ve nada. Hacelo sin denegar nada.',
    pista: 'Deshabilitá la herencia en Compras y dejá solo administradores, SYSTEM y DL-Compras-Modificar. Lo que no se permite, no se tiene: no hace falta denegar.',
    ok: (e) => isLevel(has(e, `${ROOT}\\Compras`, 'juan', false), 'Modify') && isLevel(has(e, `${ROOT}\\Compras`, 'maria', false), 'None') && !(e.sds[`${ROOT}\\Compras`]?.entries ?? []).some((x) => x.type === 'Deny'),
  },
]

const DESAFIOS_RED: Desafio[] = [
  {
    titulo: 'María tiene Modificar en NTFS sobre Ventas, pero por la red no puede guardar nada. Arreglalo.',
    pista: 'El recurso compartido da Lectura a Todos: gana el más restrictivo. Dale Cambiar (o Control total) a Authenticated Users en el recurso y dejá que NTFS decida.',
    ok: (e) => isLevel(has(e, `${ROOT}\\Ventas`, 'maria', true), 'Modify'),
  },
  {
    titulo: 'Dejá el recurso como se recomienda: Control total para Authenticated Users y nada para Todos. Juan tiene que seguir sin entrar a Ventas y María, modificando.',
    pista: 'Con el recurso abierto a los usuarios autenticados, el que decide es NTFS. Revisá que Ventas no herede Domain Users.',
    ok: (e) => e.share.some((x) => x.identity === 'NT AUTHORITY\\Authenticated Users' && x.level === 'Full') && !e.share.some((x) => x.identity === 'Everyone') && isLevel(has(e, `${ROOT}\\Ventas`, 'juan', true), 'None') && isLevel(has(e, `${ROOT}\\Ventas`, 'maria', true), 'Modify'),
  },
  {
    titulo: 'Pablo, el pasante, no tiene que poder borrar nada en Ventas por la red, pero sí crear y modificar. Sin tocar el recurso.',
    pista: 'En Ventas, agregá para GG-Pasantes una entrada Denegar con el permiso Eliminar. Una denegación puede ser de un solo derecho.',
    ok: (e) => {
      const p = has(e, `${ROOT}\\Ventas`, 'pablo', true)
      return !p.has('D') && p.has('W') && p.has('R') && isLevel(has(e, `${ROOT}\\Ventas`, 'maria', true), 'Modify')
    },
  },
]

/** Simulador de permisos efectivos: NTFS (con herencia y denegaciones) y, en modo red, combinado con el recurso compartido. */
export function PermissionSimulator({ modo = 'ntfs' }: { modo?: 'ntfs' | 'red' }) {
  const red = modo === 'red'
  const start = red ? INICIAL_RED : INICIAL
  const [e, setE] = useState<Estado>(start)
  const [path, setPath] = useState(`${ROOT}\\Ventas`)
  const [persona, setPersona] = useState('maria')
  const [verPista, setVerPista] = useState<number>()
  const r = useMemo(() => result(e, path, persona, red), [e, path, persona, red])
  const sd = e.sds[path]
  const inherited = r.acl.filter((x) => x.inherited)
  const update = (fn: (d: Estado) => void) =>
    setE((prev) => {
      const d = structuredClone(prev)
      fn(d)
      return d
    })
  const ensure = (d: Estado) => (d.sds[path] ??= { owner: 'BUILTIN\\Administrators', protected: false, entries: [] })
  const desafios = red ? DESAFIOS_RED : DESAFIOS_NTFS
  const ok = desafios.map((dz) => dz.ok(e))
  const persona0 = PEOPLE.find((x) => x.id === persona)!

  return (
    <Frame
      titulo={red ? 'Permisos efectivos por la red (recurso + NTFS)' : 'Permisos efectivos NTFS'}
      acciones={
        <Button variant="secondary" onClick={() => setE(start)}>
          <Icon name="refresh" className="h-4 w-4" /> Volver a empezar
        </Button>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
        <nav aria-label="Carpetas" className="space-y-1">
          {FOLDERS.map((f) => (
            <button key={f.path} type="button" onClick={() => setPath(f.path)} aria-pressed={path === f.path} className={cn('flex min-h-9 w-full items-center gap-1 rounded px-2 text-left text-sm', path === f.path ? 'bg-accent-soft font-semibold text-accent' : 'hover:bg-surface-2')} style={{ paddingLeft: `${0.5 + f.nivel * 1}rem` }}>
              📁 {f.nombre}
              {e.sds[f.path]?.protected && <span className="ml-auto text-[10px] text-muted">sin herencia</span>}
            </button>
          ))}
          {red && (
            <div className="mt-3 rounded-lg border border-line p-2 text-sm">
              <div className="font-semibold">Recurso compartido \\SRV-ARCH01\Datos</div>
              <ul className="mt-1 space-y-1">
                {e.share.map((s, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-1">
                    <select aria-label="Cuenta del recurso" className="min-h-8 rounded border border-line bg-bg px-1 text-xs" value={s.identity} onChange={(ev) => update((d) => void (d.share[i].identity = ev.target.value))}>
                      {['Everyone', 'NT AUTHORITY\\Authenticated Users', ...GROUPS.filter((g) => g.startsWith('EMPRESA'))].map((g) => (
                        <option key={g} value={g}>
                          {short(g)}
                        </option>
                      ))}
                    </select>
                    <select aria-label="Permiso del recurso" className="min-h-8 rounded border border-line bg-bg px-1 text-xs" value={s.level} onChange={(ev) => update((d) => void (d.share[i].level = ev.target.value as ShareLevel))}>
                      <option value="Full">Control total</option>
                      <option value="Change">Cambiar</option>
                      <option value="Read">Leer</option>
                    </select>
                    <button type="button" className="text-xs text-bad" aria-label="Quitar entrada del recurso" onClick={() => update((d) => void d.share.splice(i, 1))}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="mt-1 text-xs text-accent" onClick={() => update((d) => void d.share.push({ identity: 'NT AUTHORITY\\Authenticated Users', level: 'Read', type: 'Allow' }))}>
                + Agregar
              </button>
            </div>
          )}
        </nav>

        <div className="min-w-0 space-y-3">
          <section aria-label="Permisos NTFS de la carpeta" className="rounded-lg border border-line p-3">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-semibold">Seguridad de {path}</h4>
              {path !== ROOT && (
                <label className="ml-auto flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={!sd?.protected}
                    onChange={(ev) =>
                      update((d) => {
                        const s = ensure(d)
                        if (!ev.target.checked && !s.protected) {
                          // Como el botón "Convertir los permisos heredados en explícitos".
                          for (const x of inherited) s.entries.push({ identity: x.identity, rights: [...x.rights], type: x.type, oi: x.oi, ci: x.ci, io: x.io, np: x.np })
                        }
                        s.protected = !ev.target.checked
                      })
                    }
                  />
                  Heredar de la carpeta de arriba
                </label>
              )}
            </div>
            <div className="mt-2 text-sm">
              <div className={cn(ROW, 'hidden text-xs text-muted sm:grid')}>
                <span>Cuenta</span>
                <span>Tipo</span>
                <span>Permiso</span>
                <span>Se aplica a</span>
                <span />
              </div>
                {(sd?.entries ?? []).map((x, i) => (
                  <div key={`e${i}`} className={cn(ROW, 'border-t border-line py-1')}>
                    <span>
                      <select aria-label="Cuenta" className="min-h-8 w-full rounded border border-line bg-bg px-1 text-xs" value={x.identity} onChange={(ev) => update((d) => void (ensure(d).entries[i].identity = ev.target.value))}>
                        {GROUPS.map((g) => (
                          <option key={g} value={g}>
                            {short(g)}
                          </option>
                        ))}
                      </select>
                    </span>
                    <span>
                      <select aria-label="Tipo" className="min-h-8 w-full rounded border border-line bg-bg px-1 text-xs" value={x.type} onChange={(ev) => update((d) => void (ensure(d).entries[i].type = ev.target.value as 'Allow' | 'Deny'))}>
                        <option value="Allow">Permitir</option>
                        <option value="Deny">Denegar</option>
                      </select>
                    </span>
                    <span>
                      <select
                        aria-label="Permiso"
                        className="min-h-8 w-full rounded border border-line bg-bg px-1 text-xs"
                        value={x.rights.join() === 'W,A,D' ? 'WD' : x.rights.join() === 'D' ? 'DEL' : levelOf(x.rights) === 'Special' ? '' : levelOf(x.rights)}
                        onChange={(ev) =>
                          update((d) => {
                            const target = ensure(d).entries[i]
                            target.rights = ev.target.value === 'WD' ? ['W', 'A', 'D'] : ev.target.value === 'DEL' ? ['D'] : [...ace('x', ev.target.value as Level).rights]
                          })
                        }
                      >
                        {levelOf(x.rights) === 'Special' && !['W,A,D', 'D'].includes(x.rights.join()) && <option value="">Especial ({x.rights.map((y) => RIGHT_ES[y]).join(', ')})</option>}
                        {LEVELS.map((l) => (
                          <option key={l} value={l}>
                            {LEVEL_ES[l]}
                          </option>
                        ))}
                        <option value="WD">Escribir y eliminar</option>
                        <option value="DEL">Eliminar</option>
                      </select>
                    </span>
                    <span>
                      <select
                        aria-label="Se aplica a"
                        className="min-h-8 w-full rounded border border-line bg-bg px-1 text-xs"
                        value={aplicaOf(x)}
                        onChange={(ev) =>
                          update((d) => {
                            const f = APLICA.find((a) => a.id === ev.target.value)!.flags as Partial<Ace>
                            Object.assign(ensure(d).entries[i], { oi: !!f.oi, ci: !!f.ci, io: !!f.io, np: false })
                          })
                        }
                      >
                        {APLICA.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.label}
                          </option>
                        ))}
                      </select>
                    </span>
                    <span className="text-right">
                      <button type="button" className="text-xs text-bad" aria-label={`Quitar ${short(x.identity)}`} onClick={() => update((d) => void ensure(d).entries.splice(i, 1))}>
                        ✕
                      </button>
                    </span>
                  </div>
                ))}
                {!sd?.protected &&
                  inherited.map((x, i) => (
                    <div key={`i${i}`} className={cn(ROW, 'border-t border-line py-1 text-muted')}>
                      <span>{short(x.identity)}</span>
                      <span>{x.type === 'Allow' ? 'Permitir' : 'Denegar'}</span>
                      <span>{LEVEL_ES[levelOf(x.rights)]}</span>
                      <span className="text-xs sm:col-span-2">
                        heredado de {x.from?.split('\\').pop()}
                      </span>
                    </div>
                  ))}
            </div>
            <button type="button" className="mt-2 text-sm text-accent" onClick={() => update((d) => void ensure(d).entries.push(ace('EMPRESA\\GG-Ventas', 'ReadAndExecute')))}>
              + Agregar permiso
            </button>
          </section>

          <section aria-label="Resultado" className="rounded-lg border border-line p-3">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-semibold">Acceso efectivo de</h4>
              {PEOPLE.map((x) => (
                <Chip key={x.id} active={persona === x.id} onClick={() => setPersona(x.id)}>
                  {x.nombre}
                </Chip>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted">
              {persona0.nombre} es {persona0.detalle}.
            </p>
            <div className={cn('mt-2 grid gap-2 text-sm', red ? 'sm:grid-cols-3' : '')}>
              {red && (
                <>
                  <div className="rounded border border-line p-2">
                    <div className="text-xs text-muted">NTFS</div>
                    <div className="font-semibold">{lvl(r.ntfs)}</div>
                  </div>
                  <div className="rounded border border-line p-2">
                    <div className="text-xs text-muted">Recurso compartido</div>
                    <div className="font-semibold">{lvl(r.share)}</div>
                  </div>
                </>
              )}
              <div className="rounded border-2 border-accent p-2">
                <div className="text-xs text-muted">{red ? 'Por la red (el más restrictivo)' : 'Resultado'}</div>
                <div className="font-semibold">{lvl(r.final)}</div>
              </div>
            </div>
            <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
              {ALL_RIGHTS.map((rt) => {
                const w = r.why[rt]
                const yes = r.final.has(rt)
                const cut = red && w.ok && !r.share.has(rt)
                return (
                  <li key={rt} className="flex items-start gap-2">
                    <span className={cn('mt-0.5 inline-block w-4 text-center font-bold', yes ? 'text-ok' : 'text-bad')} aria-hidden>
                      {yes ? '✓' : '✕'}
                    </span>
                    <span>
                      {RIGHT_ES[rt]}
                      <span className="block text-xs text-muted">{cut ? 'NTFS lo permite, pero el recurso compartido no' : explain(w.ace, w.ok)}</span>
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        </div>
      </div>

      <section className="mt-4 rounded-lg border border-line p-3" aria-label="Desafíos">
        <h4 className="text-sm font-semibold">Desafíos</h4>
        <ol className="mt-1 space-y-2 text-sm">
          {desafios.map((dz, i) => (
            <li key={i} className="flex gap-2">
              <span className={cn('mt-0.5 h-5 w-5 shrink-0 rounded-full text-center text-xs leading-5', ok[i] ? 'bg-ok text-white' : 'border border-line text-muted')}>{ok[i] ? '✓' : i + 1}</span>
              <span>
                {dz.titulo}{' '}
                <button type="button" className="text-xs text-accent" onClick={() => setVerPista(verPista === i ? undefined : i)}>
                  {verPista === i ? 'Ocultar pista' : 'Pista'}
                </button>
                {verPista === i && <span className="mt-1 block text-xs text-muted">{dz.pista}</span>}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </Frame>
  )
}

function explain(a: AceView | undefined, ok: boolean): string {
  if (!a) return 'Ninguna entrada lo menciona: no se tiene'
  const where = a.inherited ? `heredado de ${a.from?.split('\\').pop()}` : 'explícito en esta carpeta'
  return `${ok ? 'Lo da' : 'Lo niega'} ${a.type === 'Deny' ? 'una denegación' : 'un permiso'} para ${short(a.identity)} (${where})`
}

/** Para las pruebas: los estados de partida, los desafíos y el cálculo. */
export const __test = { INICIAL, INICIAL_RED, DESAFIOS_NTFS, DESAFIOS_RED, ROOT }
