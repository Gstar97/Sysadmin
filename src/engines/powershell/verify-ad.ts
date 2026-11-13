/** Verificaciones de ejercicio sobre Active Directory y directivas de grupo. */
import { ouPathToDn, passwordPolicy, sameDn, type AdStore } from './ad'
import { resultantPolicy } from './ad-ops'
import { isDc } from './dns'
import { adPrincipal, rsopFor } from './gpo'
import type { PsCheck } from './schema'
import type { PsSession } from './session'
import { toText } from './values'

type Result = { ok: boolean; label: string }

function domainStore(s: PsSession): AdStore | undefined {
  return (s.data.ad?.[0] ?? s.data.domainStore?.[0]) as AdStore | undefined
}

function target(st: AdStore, a: string) {
  return a.toLowerCase() === 'dominio' || a.toLowerCase() === st.domain ? st.domainDn : ouPathToDn(a, st.domainDn)
}

/** RSoP de un usuario o un equipo (según el nombre) con la base actual del dominio. */
function rsopOf(s: PsSession, st: AdStore, name: string) {
  const o = adPrincipal(st, name)
  if (!o) return undefined
  const scope = o.ObjectClass === 'computer' ? 'Computer' : 'User'
  const computerSession = o.ObjectClass === 'computer' ? s.lab?.find(toText(o.Name)) : undefined
  return rsopFor(st, o, scope, computerSession)
}

export function verifyAd(s: PsSession, check: PsCheck): Result | undefined {
  if ('gpo' in check) {
    const st = domainStore(s)
    const g = st?.gpos?.find((x) => x.name.toLowerCase() === check.gpo.toLowerCase())
    if (!check.existe) return { ok: !g, label: `la GPO "${check.gpo}" no existe` }
    let ok = !!g
    const parts = [`la GPO "${check.gpo}" existe`]
    if (check.vinculada_a !== undefined) {
      const t = st ? target(st, check.vinculada_a) : ''
      const link = g && st?.links?.find((l) => l.gpoId === g.id && sameDn(l.target, t))
      ok &&= !!link
      parts.push(`vinculada a ${check.vinculada_a}`)
      if (check.exigida !== undefined) {
        ok &&= !!link && link.enforced === check.exigida
        parts.push(check.exigida ? 'exigida' : 'sin exigir')
      }
      if (check.vinculo_habilitado !== undefined) {
        ok &&= !!link && link.enabled === check.vinculo_habilitado
        parts.push(check.vinculo_habilitado ? 'con el vínculo habilitado' : 'con el vínculo deshabilitado')
      }
    }
    if (check.configura) {
      const c = check.configura
      const set = g?.settings.find((x) => x.key.toLowerCase().endsWith(c.clave.replace(/^(HKLM|HKCU)\\/i, '').toLowerCase()) && x.valueName.toLowerCase() === c.valor_nombre.toLowerCase())
      ok &&= !!set && (c.valor === undefined || toText(set.value).toLowerCase() === toText(c.valor).toLowerCase())
      parts.push(`configura ${c.valor_nombre}${c.valor !== undefined ? ` = ${c.valor}` : ''}`)
    }
    if (check.aplica_a_grupo) {
      ok &&= !!g && g.apply.some((a) => a.toLowerCase() === check.aplica_a_grupo!.toLowerCase())
      parts.push(`se aplica a ${check.aplica_a_grupo}`)
    }
    return { ok, label: parts.join(', ') }
  }
  if ('herencia_bloqueada' in check) {
    const st = domainStore(s)
    const blocked = !!st && (st.blocked ?? []).some((b) => sameDn(b, target(st, check.herencia_bloqueada)))
    return { ok: blocked === check.bloqueada, label: `la OU ${check.herencia_bloqueada} ${check.bloqueada ? 'bloquea' : 'no bloquea'} la herencia` }
  }
  if ('gpo_aplicada' in check) {
    const st = domainStore(s)
    const r = st && rsopOf(s, st, check.a)
    const applied = !!r?.applied.some((e) => e.gpo.name.toLowerCase() === check.gpo_aplicada.toLowerCase())
    return { ok: !!r && applied === check.aplicada, label: `la GPO "${check.gpo_aplicada}" ${check.aplicada ? 'se aplica' : 'no se aplica'} a ${check.a}` }
  }
  if ('gpo_ganadora' in check) {
    const st = domainStore(s)
    const r = st && rsopOf(s, st, check.a)
    const w = r?.settings.find((x) => x.setting.key.toLowerCase().endsWith(check.clave.replace(/^(HKLM|HKCU)\\/i, '').toLowerCase()) && x.setting.valueName.toLowerCase() === check.valor_nombre.toLowerCase())
    return { ok: !!w && w.gpo.name.toLowerCase() === check.gpo_ganadora.toLowerCase(), label: `para ${check.a}, ${check.valor_nombre} lo define "${check.gpo_ganadora}"` }
  }
  if ('es_controlador' in check) return { ok: isDc(s.state, s.lab) === check.es_controlador, label: `${s.state.equipo} ${check.es_controlador ? 'es' : 'no es'} controlador de dominio` }
  if ('unido_a' in check) return { ok: s.state.dominio?.toLowerCase() === check.unido_a.toLowerCase(), label: `${s.state.equipo} está unido a ${check.unido_a} (ya reiniciado)` }
  if ('papelera_ad' in check) {
    const st = domainStore(s)
    return { ok: !!st && !!st.recycleBin === check.papelera_ad, label: `la papelera de reciclaje de AD está ${check.papelera_ad ? 'activada' : 'desactivada'}` }
  }
  if ('reloj_desfase_max' in check) return { ok: Math.abs(s.state.desfase_reloj_min) <= check.reloj_desfase_max, label: `el reloj de ${s.state.equipo} está a menos de ${check.reloj_desfase_max} minutos de la hora real` }
  if ('dns_cliente' in check) return { ok: check.dns_cliente.every((d, i) => s.state.red.dns[i] === d), label: `${s.state.equipo} usa como DNS ${check.dns_cliente.join(', ')}` }
  if ('fsmo' in check) {
    const st = domainStore(s)
    return { ok: !!st?.fsmo && st.fsmo[check.fsmo].toLowerCase() === check.en_equipo.toLowerCase(), label: `el rol ${check.fsmo} lo tiene ${check.en_equipo}` }
  }
  if ('cuenta_servicio' in check) {
    const st = domainStore(s)
    const msa = st?.serviceAccounts?.find((x) => toText(x.Name).toLowerCase() === check.cuenta_servicio.toLowerCase())
    if (!check.existe) return { ok: !msa, label: `la cuenta de servicio ${check.cuenta_servicio} no existe` }
    let ok = !!msa
    if (check.instalada !== undefined) ok &&= ((s.data.installedMsas ?? []) as string[]).includes(check.cuenta_servicio.toLowerCase()) === check.instalada
    return { ok, label: `la cuenta de servicio ${check.cuenta_servicio} existe${check.instalada ? ` y está instalada en ${s.state.equipo}` : ''}` }
  }
  if ('politica_contrasenas' in check) {
    const st = domainStore(s)
    const p = st ? passwordPolicy(st) : undefined
    const c = check.politica_contrasenas
    let ok = !!p
    const parts: string[] = []
    if (c.longitud_minima !== undefined) {
      ok &&= Number(p?.MinPasswordLength) >= c.longitud_minima
      parts.push(`longitud mínima de al menos ${c.longitud_minima}`)
    }
    if (c.umbral_bloqueo !== undefined) {
      ok &&= Number(p?.LockoutThreshold) === c.umbral_bloqueo
      parts.push(`bloqueo a los ${c.umbral_bloqueo} intentos`)
    }
    if (c.complejidad !== undefined) {
      ok &&= p?.ComplexityEnabled === c.complejidad
      parts.push(c.complejidad ? 'con complejidad' : 'sin complejidad')
    }
    return { ok, label: `la directiva de contraseñas del dominio tiene ${parts.join(', ')}` }
  }
  if ('politica_resultante' in check) {
    const st = domainStore(s)
    const u = st?.users.find((x) => toText(x.SamAccountName).toLowerCase() === check.politica_resultante.toLowerCase())
    const p = st && u ? resultantPolicy(st, u) : undefined
    return { ok: !!p && toText(p.Name).toLowerCase() === check.politica.toLowerCase(), label: `a ${check.politica_resultante} le toca la directiva de contraseñas "${check.politica}"` }
  }
  return undefined
}
