/**
 * Arma la parte web de un servidor a partir del estado del ejercicio: aplicaciones, DNS
 * público, certificados ya instalados, CA interna, autoridades de confianza y un linaje de
 * certbot.
 */
import { writeLineage, type Lineage } from './acme'
import { web } from './http'
import { apachePrime, apacheService } from './apache'
import { nginxPrime } from './web'
import { System } from './system'
import { anchorsDir, ensureTrustStore, issue, LE_R11, newKey, rebuildTrustStore, STAGING_R11, toPem, type CertData } from './tls'
import { ROOT_CRED } from './vfs'

/** La CA interna de una empresa: siempre la misma para el mismo nombre (así sirve en varios equipos). */
export function internalCa(cn: string): { cert: CertData; key: ReturnType<typeof newKey> } {
  const key = newKey('RSA', 4096, `ca:${cn}`)
  const now = Date.now()
  const start = Math.floor(now / (365 * 86_400_000)) * 365 * 86_400_000 - 200 * 86_400_000
  const cert = issue({ subject: { C: 'AR', O: cn.replace(/ (Root )?CA$/i, ''), CN: cn }, days: 3650, key, ca: true, now: start, serial: `CA${key.id.slice(0, 30)}`.toUpperCase() })
  return { cert, key }
}

function write(sys: System, path: string, text: string, mode = 0o644) {
  sys.vfs.mkdirp(path.slice(0, path.lastIndexOf('/')), ROOT_CRED)
  sys.vfs.writeFile(path, text, ROOT_CRED, { mode })
}

System.initHooks.push((sys, state) => {
  // Carpetas de certificados y claves de la distribución.
  for (const [d, mode] of sys.distro === 'rocky' ? ([['/etc/pki/tls/certs', 0o755], ['/etc/pki/tls/private', 0o755], ['/etc/pki/ca-trust/source/anchors', 0o755]] as const) : ([['/etc/ssl/certs', 0o755], ['/etc/ssl/private', 0o710], ['/usr/local/share/ca-certificates', 0o755]] as const)) {
    if (!sys.vfs.exists(d)) sys.vfs.mkdirp(d, ROOT_CRED, mode)
  }
  const w = state.web
  const rt = web(sys)
  rt.apps = w.aplicaciones
  rt.publicDns = w.dominios_publicos
  rt.publicIp = w.ip_publica
  rt.inboundFromInternet = w.puertos_publicados
  const needsStore = w.certificados.length || w.ca_interna || w.confia_en.length || w.certbot
  if (needsStore) setupTls(sys, state)
  // nginx y Apache arrancaron con la configuración que dejó el ejercicio.
  if (sys.services.get('nginx')?.active) nginxPrime(sys)
  if (sys.services.get(apacheService(sys))?.active) apachePrime(sys)
})

function setupTls(sys: System, state: Parameters<(typeof System.initHooks)[number]>[1]) {
  const w = state.web
  ensureTrustStore(sys)
  const ca = w.ca_interna ? internalCa(w.ca_interna.cn) : undefined
  if (w.ca_interna && ca) {
    write(sys, w.ca_interna.certificado, toPem(ca.cert))
    write(sys, w.ca_interna.clave, toPem(ca.key), 0o600)
  }
  for (const c of w.certificados) {
    const key = newKey('RSA', 2048, `cert:${sys.hostname}:${c.certificado}`)
    const san = (c.san.length ? c.san : [c.cn]).map((s) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? `IP Address:${s}` : `DNS:${s}`))
    const total = c.dias_emitido + c.dias_restantes
    let issuer: { cert: CertData; keyId: string } | undefined
    let chainExtra: CertData[] = []
    if (c.emisor === 'letsencrypt' || c.emisor === 'staging') {
      const inter = c.emisor === 'staging' ? STAGING_R11 : LE_R11
      issuer = { cert: inter, keyId: inter.keyId }
      chainExtra = c.con_intermedio ? [inter] : []
    } else if (c.emisor === 'ca_interna') {
      const cn = w.ca_interna?.cn ?? 'CA interna'
      const ica = internalCa(cn)
      issuer = { cert: ica.cert, keyId: ica.key.id }
    }
    const cert = issue({ subject: { CN: c.cn }, san, days: total, startDays: -c.dias_emitido, key, issuer, staging: c.emisor === 'staging' })
    write(sys, c.certificado, [cert, ...chainExtra].map(toPem).join(''))
    write(sys, c.clave, toPem(key), 0o600)
  }
  if (w.confia_en.length) {
    for (const cn of w.confia_en) {
      const file = `${anchorsDir(sys)}/${cn.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.crt`
      write(sys, file, toPem(internalCa(cn).cert))
    }
    rebuildTrustStore(sys)
  }
  if (w.certbot) {
    const l: Lineage = { name: w.certbot.dominios[0], domains: w.certbot.dominios, staging: false, version: 0, authenticator: w.certbot.metodo, webroot: w.certbot.webroot, hook: w.certbot.hook }
    writeLineage(sys, l, 90, 90 - w.certbot.dias_restantes)
  }
}
