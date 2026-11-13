/** Verificaciones de ejercicio sobre la configuración del equipo (red, firewall, discos, sistema). */
import { firewallAllows, networkCategory } from './machine'
import type { PsCheck } from './schema'
import type { PsSession } from './session'
import { toText, type PsObject } from './values'

export interface DiskPartition {
  letra?: string
  tamano_gb: number
  sistema?: 'NTFS' | 'ReFS' | 'FAT32'
  etiqueta: string
  tipo: 'Basic' | 'System' | 'Reserved' | 'Recovery'
  usado_gb: number
}

export interface DiskState {
  numero: number
  tamano_gb: number
  modelo: string
  estilo: 'RAW' | 'GPT' | 'MBR'
  offline: boolean
  bus: string
  particiones: DiskPartition[]
}

export function disks(s: PsSession): DiskState[] {
  return (s.data.disks ?? []) as DiskState[]
}

export function verifySystem(s: PsSession, check: PsCheck): { ok: boolean; label: string } {
  if ('nombre_equipo' in check) {
    const current = s.state.equipo
    const pending = s.pending.name
    if (check.pendiente) return { ok: pending?.toLowerCase() === check.nombre_equipo.toLowerCase(), label: `el equipo se va a llamar ${check.nombre_equipo} después de reiniciar` }
    return { ok: current.toLowerCase() === check.nombre_equipo.toLowerCase(), label: `el equipo se llama ${check.nombre_equipo}` }
  }
  if ('ip' in check) {
    const r = s.state.red
    let ok = r.ip === check.ip && !r.dhcp
    const parts = [`IP fija ${check.ip}`]
    if (check.prefijo !== undefined) {
      ok &&= r.prefijo === check.prefijo
      parts.push(`/${check.prefijo}`)
    }
    if (check.puerta_enlace) {
      ok &&= r.puerta_enlace === check.puerta_enlace
      parts.push(`puerta de enlace ${check.puerta_enlace}`)
    }
    if (check.dns) {
      ok &&= check.dns.every((d, i) => r.dns[i] === d)
      parts.push(`DNS ${check.dns.join(', ')}`)
    }
    return { ok, label: parts.join(', ') }
  }
  if ('perfil_red' in check) return { ok: networkCategory(s) === check.perfil_red, label: `la red está en el perfil ${check.perfil_red}` }
  if ('regla_firewall' in check) {
    const want = check.regla_firewall.toLowerCase()
    const rules = ((s.data.firewallRules ?? []) as PsObject[]).filter((r) => toText(r.Name).toLowerCase() === want || toText(r.DisplayName).toLowerCase() === want)
    const ok = rules.length > 0 && rules.some((r) => (r.Enabled === 'True') === check.habilitada)
    return { ok, label: `la regla "${check.regla_firewall}" ${check.habilitada ? 'está habilitada' : 'está deshabilitada'}` }
  }
  if ('permite' in check) {
    const m = /^(\d+)\/(tcp|udp)$|^(icmp|ping)$/i.exec(check.permite)
    const proto = m?.[3] ? 'ICMPv4' : (m?.[2]?.toUpperCase() as 'TCP' | 'UDP')
    const port = m?.[1] ? Number(m[1]) : undefined
    const ok = !!m && firewallAllows(s, proto, port, check.desde ?? s.state.red.ip.replace(/\d+$/, '50')) === check.permite_acceso
    return { ok, label: `el firewall ${check.permite_acceso ? 'deja' : 'no deja'} entrar ${check.permite}${check.desde ? ` desde ${check.desde}` : ''}` }
  }
  if ('disco' in check) {
    const d = disks(s).find((x) => x.numero === check.disco)
    let ok = !!d
    const parts: string[] = []
    if (check.estilo) {
      ok &&= d?.estilo === check.estilo
      parts.push(`inicializado como ${check.estilo}`)
    }
    if (check.offline !== undefined) {
      ok &&= d?.offline === check.offline
      parts.push(check.offline ? 'fuera de línea' : 'en línea')
    }
    return { ok, label: `el disco ${check.disco}${parts.length ? ` está ${parts.join(' y ')}` : ' existe'}` }
  }
  if ('volumen' in check) {
    const letter = check.volumen.replace(/[:\\]/g, '').toUpperCase()
    const p = disks(s).flatMap((d) => d.particiones).find((x) => x.letra?.toUpperCase() === letter)
    let ok = !!p && !!p.sistema
    const parts = [`la unidad ${letter}: existe`]
    if (check.sistema) {
      ok &&= p?.sistema === check.sistema
      parts.push(`con ${check.sistema}`)
    }
    if (check.etiqueta !== undefined) {
      ok &&= p?.etiqueta === check.etiqueta
      parts.push(`etiqueta "${check.etiqueta}"`)
    }
    if (check.tamano_min_gb !== undefined) {
      ok &&= (p?.tamano_gb ?? 0) >= check.tamano_min_gb
      parts.push(`de al menos ${check.tamano_min_gb} GB`)
    }
    return { ok, label: parts.join(', ') }
  }
  if ('zona_horaria' in check) return { ok: toText(s.data.timeZone?.[0]).toLowerCase() === check.zona_horaria.toLowerCase(), label: `la zona horaria es ${check.zona_horaria}` }
  if ('remoting' in check) return { ok: !!s.data.winrm?.[0] === check.remoting, label: check.remoting ? 'la administración remota (WinRM) está activada' : 'WinRM está desactivado' }
  if ('escritorio_remoto' in check) return { ok: !!s.data.rdp?.[0] === check.escritorio_remoto, label: check.escritorio_remoto ? 'el Escritorio remoto está activado' : 'el Escritorio remoto está desactivado' }
  if ('variable' in check) {
    const v = s.getVar(check.variable)
    if (!check.existe) return { ok: v === null, label: `la variable $${check.variable} no existe` }
    const ok = v !== null && (check.valor === undefined || toText(v).toLowerCase() === check.valor.toLowerCase())
    return { ok, label: `la variable $${check.variable}${check.valor !== undefined ? ` vale ${check.valor}` : ' existe'}` }
  }
  if ('funcion' in check) {
    const has = s.functions.has(check.funcion.toLowerCase())
    return { ok: has === check.existe, label: `la función ${check.funcion} ${check.existe ? 'está definida' : 'no existe'}` }
  }
  return { ok: false, label: 'verificación desconocida' }
}
