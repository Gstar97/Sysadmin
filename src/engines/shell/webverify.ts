/**
 * Verificaciones de los ejercicios web: solicitudes HTTP, certificados, confianza, módulos de
 * Apache y booleanos de SELinux.
 */
import { apacheModules } from './apache'
import { fetchHttp, header } from './http'
import type { BashCheck } from './schema'
import type { System } from './system'
import { certsIn, keyIn, selfSigned, trustedRoots } from './tls'
import { ROOT_CRED } from './vfs'

interface CheckResult {
  ok: boolean
  label: string
}

type Single = Exclude<BashCheck, { en: string }>

export function verifyWeb(sys: System, check: Single): CheckResult | undefined {
  if ('http' in check) {
    const r = fetchHttp(sys, check.http, { method: check.metodo, insecure: check.inseguro, headers: check.encabezados, fromInternet: check.desde_internet })
    const parts: string[] = []
    let ok = true
    if (check.falla !== undefined) {
      ok = !r.ok === check.falla && (!r.ok ? r.stage === 'connect' || r.stage === 'resolve' : true)
      return { ok, label: `${check.http} ${check.falla ? 'no responde' : 'responde'}${check.desde_internet ? ' desde internet' : ''}` }
    }
    if (check.tls_valido !== undefined) {
      const valid = r.ok ? !r.tls || r.tls.verify.code === 'ok' : false
      const tlsFail = !r.ok && (r.stage === 'verify' || r.stage === 'tls')
      ok &&= check.tls_valido ? r.ok && valid : tlsFail
      parts.push(check.tls_valido ? 'con un certificado válido para el nombre' : 'falla por el certificado')
    } else if (!r.ok) ok = false
    if (r.ok) {
      if (check.estado !== undefined) {
        ok &&= r.res.status === check.estado
        parts.push(`devuelve ${check.estado}`)
      }
      if (check.contiene) {
        ok &&= r.res.body.includes(check.contiene)
        parts.push(`muestra "${check.contiene}"`)
      }
      if (check.no_contiene) {
        ok &&= !r.res.body.includes(check.no_contiene)
        parts.push(`no muestra "${check.no_contiene}"`)
      }
      if (check.encabezado) {
        const v = header(r.res, check.encabezado.nombre)
        const exists = check.encabezado.existe ?? true
        ok &&= exists ? v !== undefined && (!check.encabezado.contiene || v.includes(check.encabezado.contiene)) : v === undefined
        parts.push(`${exists ? 'trae' : 'no trae'} el encabezado ${check.encabezado.nombre}${check.encabezado.contiene ? ` con "${check.encabezado.contiene}"` : ''}`)
      }
      if (check.http2 !== undefined) {
        ok &&= !!r.res.h2 === check.http2
        parts.push(check.http2 ? 'por HTTP/2' : 'por HTTP/1.1')
      }
    } else if (check.estado !== undefined || check.contiene) parts.push(check.estado !== undefined ? `devuelve ${check.estado}` : `muestra "${check.contiene}"`)
    return { ok, label: `${check.http}${check.desde_internet ? ' (desde internet)' : ''} ${parts.join(', ') || 'responde'}` }
  }
  if ('certificado' in check) {
    let text: string
    try {
      text = sys.vfs.readFile(check.certificado, ROOT_CRED)
    } catch {
      return { ok: false, label: `existe el certificado ${check.certificado}` }
    }
    const certs = certsIn(text)
    const c = certs[0]
    if (!c) return { ok: false, label: `${check.certificado} es un certificado` }
    const parts: string[] = []
    let ok = true
    if (check.cn) {
      ok &&= c.subject.CN === check.cn
      parts.push(`CN=${check.cn}`)
    }
    if (check.san_incluye) {
      ok &&= c.san.some((s) => s.replace(/^(DNS|IP Address):/, '') === check.san_incluye)
      parts.push(`incluye ${check.san_incluye} en los nombres alternativos (SAN)`)
    }
    if (check.emisor_contiene) {
      ok &&= Object.values(c.issuer).join(' ').includes(check.emisor_contiene)
      parts.push(`emitido por ${check.emisor_contiene}`)
    }
    if (check.autofirmado !== undefined) {
      ok &&= selfSigned(c) === check.autofirmado
      parts.push(check.autofirmado ? 'autofirmado' : 'firmado por una autoridad')
    }
    if (check.es_ca !== undefined) {
      ok &&= c.ca === check.es_ca
      parts.push(check.es_ca ? 'de una autoridad certificante (CA:TRUE)' : 'de servidor (CA:FALSE)')
    }
    if (check.vigente !== undefined) {
      const now = Date.now()
      ok &&= (c.notBefore <= now && c.notAfter > now) === check.vigente
      parts.push(check.vigente ? 'vigente' : 'vencido')
    }
    if (check.dias_min !== undefined) {
      ok &&= c.notAfter - Date.now() >= check.dias_min * 86_400_000
      parts.push(`con al menos ${check.dias_min} días de vigencia`)
    }
    if (check.con_cadena !== undefined) {
      ok &&= certs.length > 1 === check.con_cadena
      parts.push(check.con_cadena ? 'con el intermedio (cadena completa)' : 'sin intermedio')
    }
    if (check.clave) {
      let k
      try {
        k = keyIn(sys.vfs.readFile(check.clave, ROOT_CRED))
      } catch {
        k = undefined
      }
      ok &&= !!k && k.id === c.keyId
      parts.push(`que corresponde a la clave ${check.clave}`)
    }
    return { ok, label: `el certificado ${check.certificado} es ${parts.join(', ')}` }
  }
  if ('confia_en' in check) {
    const want = check.confia ?? true
    const has = trustedRoots(sys).some((c) => c.subject.CN === check.confia_en)
    return { ok: has === want, label: `${sys.hostname} ${want ? 'confía' : 'no confía'} en la CA "${check.confia_en}"` }
  }
  if ('modulo_apache' in check) {
    const name = check.modulo_apache.replace(/_module$/, '')
    const want = check.cargado ?? true
    const loaded = apacheModules(sys).includes(`${name}_module`)
    return { ok: loaded === want, label: `el módulo ${name} de Apache ${want ? 'está' : 'no está'} cargado` }
  }
  if ('booleano_selinux' in check) {
    const want = check.valor ?? true
    const b = sys.selinux.booleans.get(check.booleano_selinux)
    const ok = !!b && b.cur === want && b.def === want
    return { ok, label: `el booleano ${check.booleano_selinux} está en ${want ? 'on' : 'off'} (y persistente)` }
  }
  return undefined
}
