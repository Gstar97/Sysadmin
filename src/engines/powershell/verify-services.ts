/** Verificaciones de los servicios de red y archivos de Windows Server (DNS, DHCP, NTFS, SMB...). */
import { dhcpState, isAuthorized, leaseInfo } from './dhcp'
import { resolveName, serverZones } from './dns'
import { canonicalIdentity, findShare, getSd, localLevel, networkLevel } from './files'
import type { PsCheck } from './schema'
import type { PsSession } from './session'
import { toText } from './values'

type Result = { ok: boolean; label: string }

const clean = (v: string) => v.toLowerCase().replace(/\.$/, '')

export function verifyServices(s: PsSession, check: PsCheck): Result | undefined {
  if ('zona_dns' in check) {
    const z = serverZones(s).find((x) => x.name === clean(check.zona_dns))
    if (!check.existe) return { ok: !z, label: `la zona ${check.zona_dns} no existe en ${s.state.equipo}` }
    let ok = !!z
    const parts: string[] = []
    if (check.integrada_ad !== undefined) {
      ok &&= z?.adIntegrated === check.integrada_ad
      parts.push(check.integrada_ad ? 'integrada en AD' : 'no integrada en AD')
    }
    if (check.inversa !== undefined) {
      ok &&= z?.reverse === check.inversa
      parts.push(check.inversa ? 'inversa' : 'directa')
    }
    if (check.reenviador_condicional !== undefined) {
      ok &&= (z?.kind === 'Forwarder') === check.reenviador_condicional
      parts.push(check.reenviador_condicional ? 'reenviador condicional' : 'primaria')
    }
    if (check.antiguedad !== undefined) {
      ok &&= z?.aging === check.antiguedad
      parts.push(check.antiguedad ? 'con antigüedad activada' : 'sin antigüedad')
    }
    return { ok, label: `la zona ${check.zona_dns} existe en ${s.state.equipo}${parts.length ? ` (${parts.join(', ')})` : ''}` }
  }
  if ('registro_dns' in check) {
    const r = resolveName(s, check.registro_dns, check.tipo, s.state.red.ip)
    const value = (x: Record<string, unknown>) => clean(toText(x.IPAddress ?? x.NameHost ?? x.NameExchange ?? x.Strings ?? ''))
    const found = r.ok && r.records.some((x) => x.Type === check.tipo && (!check.valor || value(x) === clean(check.valor)))
    return { ok: found === check.existe, label: `${check.existe ? 'hay' : 'no hay'} un registro ${check.tipo} ${check.registro_dns}${check.valor ? ` → ${check.valor}` : ''} en ${s.state.equipo}` }
  }
  if ('reenviador_dns' in check) {
    const f = (s.data.dnsForwarders ?? []) as string[]
    return { ok: f.includes(check.reenviador_dns), label: `${s.state.equipo} reenvía las consultas a ${check.reenviador_dns}` }
  }
  if ('limpieza_dns' in check) {
    const sc = (s.data.dnsScavenging?.[0] as { enabled: boolean } | undefined)?.enabled ?? false
    return { ok: sc === check.limpieza_dns, label: `la limpieza de registros viejos está ${check.limpieza_dns ? 'activada' : 'desactivada'} en ${s.state.equipo}` }
  }
  if ('resuelve' in check) {
    const r = resolveName(s, check.resuelve, check.tipo)
    const ok = r.ok && (!check.valor || r.records.some((x) => clean(toText(x.IPAddress ?? x.NameHost ?? x.NameTarget ?? x.NameExchange ?? '')) === clean(check.valor!)))
    return { ok: ok === check.resuelve_bien, label: `${s.state.equipo} ${check.resuelve_bien ? 'resuelve' : 'no resuelve'} ${check.resuelve}${check.valor ? ` (${check.valor})` : ''}` }
  }
  if ('ambito_dhcp' in check) {
    const sc = dhcpState(s).scopes.find((x) => x.id === check.ambito_dhcp)
    if (!check.existe) return { ok: !sc, label: `el ámbito ${check.ambito_dhcp} no existe en ${s.state.equipo}` }
    let ok = !!sc
    const parts: string[] = []
    if (check.activo !== undefined) {
      ok &&= (sc?.state === 'Active') === check.activo
      parts.push(check.activo ? 'activo' : 'inactivo')
    }
    if (check.inicio) {
      ok &&= sc?.start === check.inicio
      parts.push(`desde ${check.inicio}`)
    }
    if (check.fin) {
      ok &&= sc?.end === check.fin
      parts.push(`hasta ${check.fin}`)
    }
    const opts = sc ? { ...dhcpState(s).options, ...sc.options } : {}
    if (check.puerta_enlace) {
      ok &&= opts[3]?.[0] === check.puerta_enlace
      parts.push(`puerta de enlace ${check.puerta_enlace}`)
    }
    if (check.dns) {
      ok &&= check.dns.every((d, i) => opts[6]?.[i] === d)
      parts.push(`DNS ${check.dns.join(', ')}`)
    }
    if (check.excluye) {
      const n = ipNum(check.excluye)
      ok &&= !!sc?.exclusions.some(([a, b]) => n >= ipNum(a) && n <= ipNum(b))
      parts.push(`excluye ${check.excluye}`)
    }
    return { ok, label: `el ámbito ${check.ambito_dhcp} existe en ${s.state.equipo}${parts.length ? ` (${parts.join(', ')})` : ''}` }
  }
  if ('reserva_dhcp' in check) {
    const norm = (m: string) => m.replace(/[^0-9a-f]/gi, '').toLowerCase()
    const found = dhcpState(s).scopes.some((sc) => (!check.ambito || sc.id === check.ambito) && sc.reservations.some((r) => r.ip === check.reserva_dhcp && (!check.mac || norm(r.mac) === norm(check.mac))))
    return { ok: found, label: `hay una reserva para ${check.reserva_dhcp}${check.mac ? ` (${check.mac})` : ''} en ${s.state.equipo}` }
  }
  if ('dhcp_autorizado' in check) return { ok: !!s.state.dominio && isAuthorized(s) === check.dhcp_autorizado, label: `${s.state.equipo} ${check.dhcp_autorizado ? 'está' : 'no está'} autorizado como servidor DHCP en AD` }
  if ('conmutacion_dhcp' in check) {
    const f = dhcpState(s).failovers.find((x) => x.partner.toLowerCase() === check.conmutacion_dhcp.toLowerCase().split('.')[0])
    return { ok: !!f && (!check.modo || f.mode === check.modo), label: `${s.state.equipo} tiene conmutación por error de DHCP con ${check.conmutacion_dhcp}${check.modo ? ` (${check.modo})` : ''}` }
  }
  if ('concesion_dhcp' in check) {
    const r = s.state.red
    const lease = leaseInfo(s)
    const has = r.dhcp && !r.ip.startsWith('169.254.') && r.ip !== '0.0.0.0' && !!lease
    let ok = has === check.concesion_dhcp
    if (check.direccion) ok &&= r.ip === check.direccion
    if (check.de) {
      const srv = s.lab?.find(check.de)
      ok &&= !!srv && lease?.server === srv.state.red.ip
    }
    return { ok, label: `${s.state.equipo} ${check.concesion_dhcp ? 'tiene' : 'no tiene'} una dirección por DHCP${check.direccion ? ` (${check.direccion})` : ''}${check.de ? ` de ${check.de}` : ''}` }
  }
  if ('permiso_ntfs' in check) {
    const got = localLevel(s, check.para, check.permiso_ntfs)
    return { ok: got === check.nivel, label: `${check.para} tiene ${check.nivel} sobre ${check.permiso_ntfs}` }
  }
  if ('herencia_ntfs' in check) {
    const sd = getSd(s, s.resolvePath(check.herencia_ntfs))
    return { ok: !sd?.protected === check.habilitada, label: `la herencia de ${check.herencia_ntfs} está ${check.habilitada ? 'habilitada' : 'deshabilitada'}` }
  }
  if ('recurso_compartido' in check) {
    const sh = findShare(s, check.recurso_compartido)
    if (!check.existe) return { ok: !sh, label: `el recurso ${check.recurso_compartido} no existe en ${s.state.equipo}` }
    let ok = !!sh
    if (check.ruta) ok &&= !!sh && sh.path.toLowerCase() === s.resolvePath(check.ruta).toLowerCase()
    if (check.abe !== undefined) ok &&= !!sh && sh.abe === check.abe
    return { ok, label: `${s.state.equipo} comparte ${check.recurso_compartido}${check.ruta ? ` (${check.ruta})` : ''}${check.abe ? ' con enumeración basada en acceso' : ''}` }
  }
  if ('acceso_compartido' in check) {
    const sh = findShare(s, check.acceso_compartido)
    const who = canonicalIdentity(s, check.cuenta) ?? check.cuenta
    const entry = sh?.access.find((a) => a.identity.toLowerCase() === who.toLowerCase() && a.type === 'Allow')
    const ok = check.nivel === 'None' ? !!sh && !entry : entry?.level === check.nivel
    return { ok, label: `en el recurso ${check.acceso_compartido}, ${check.cuenta} tiene ${check.nivel}` }
  }
  if ('acceso_red' in check) {
    let got: string
    try {
      got = networkLevel(s, check.usuario, check.acceso_red)
    } catch {
      got = 'None'
    }
    return { ok: got === check.nivel, label: `${check.usuario} tiene ${check.nivel} en ${check.acceso_red} (por la red)` }
  }
  if ('cuota' in check) {
    const f = (s.data.fsrm?.[0] as { quotas: { path: string; limitBytes: number; soft: boolean }[] } | undefined)?.quotas ?? []
    const q = f.find((x) => x.path.toLowerCase() === s.resolvePath(check.cuota).toLowerCase())
    let ok = !!q
    if (check.limite_mb !== undefined) ok &&= !!q && Math.round(q.limitBytes / 1048576) === check.limite_mb
    if (check.blanda !== undefined) ok &&= !!q && q.soft === check.blanda
    return { ok, label: `hay una cuota${check.blanda === true ? ' blanda' : check.blanda === false ? ' estricta' : ''} en ${check.cuota}${check.limite_mb ? ` de ${check.limite_mb} MB` : ''}` }
  }
  if ('filtro_archivos' in check) {
    const f = (s.data.fsrm?.[0] as { screens: { path: string; groups: string[]; active: boolean }[] } | undefined)?.screens ?? []
    const sc = f.find((x) => x.path.toLowerCase() === s.resolvePath(check.filtro_archivos).toLowerCase())
    const ok = !!sc && sc.active && (!check.grupo || sc.groups.some((g) => g.toLowerCase() === check.grupo!.toLowerCase()))
    return { ok, label: `hay un filtro de archivos activo en ${check.filtro_archivos}${check.grupo ? ` (${check.grupo})` : ''}` }
  }
  if ('carpeta_dfs' in check) {
    const roots = ((s.data.domainStore?.[0] as { dfs?: { namespace: string; folders: { name: string; targets: string[] }[] }[] } | undefined)?.dfs ?? (s.data.dfs as { namespace: string; folders: { name: string; targets: string[] }[] }[] | undefined) ?? [])
    const parts = check.carpeta_dfs.replace(/^\\\\/, '').split('\\')
    const root = roots.find((r) => r.namespace.toLowerCase() === `\\\\${parts[0]}\\${parts[1]}`.toLowerCase())
    const folder = root?.folders.find((f) => f.name.toLowerCase() === parts.slice(2).join('\\').toLowerCase())
    const ok = !!folder && (!check.destino || folder.targets.some((t) => t.toLowerCase() === check.destino!.toLowerCase()))
    return { ok, label: `existe la carpeta DFS ${check.carpeta_dfs}${check.destino ? ` → ${check.destino}` : ''}` }
  }
  if ('unidad_red' in check) {
    const target = s.fs.drives.get(check.unidad_red.toUpperCase().replace(/:?$/, ':'))
    return { ok: !!target && (!check.ruta || target.toLowerCase() === check.ruta.toLowerCase()), label: `${s.state.equipo} tiene la unidad ${check.unidad_red}${check.ruta ? ` → ${check.ruta}` : ''}` }
  }
  return undefined
}

function ipNum(ip: string): number {
  return ip.split('.').reduce((a, o) => a * 256 + Number(o), 0)
}
