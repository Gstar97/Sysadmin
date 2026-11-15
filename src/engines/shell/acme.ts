/**
 * Let's Encrypt y certbot: el "linaje" de un certificado (archive/, live/ con enlaces y
 * renewal/*.conf) y la validación HTTP-01 desde internet, que pasa por el DNS público, el
 * reenvío de puertos del borde, el firewall y lo que nginx sirve en /.well-known/acme-challenge/.
 */
import { fetchHttp, web } from './http'
import type { System } from './system'
import { certsIn, issue, LE_R11, newKey, STAGING_R11, toPem, type CertData } from './tls'
import { ROOT_CRED } from './vfs'

export const LE_DIR = '/etc/letsencrypt'

export interface Lineage {
  name: string
  domains: string[]
  staging: boolean
  version: number
  authenticator: 'nginx' | 'webroot' | 'standalone'
  webroot?: string
  hook?: string
  cert?: CertData
}

function confText(l: Lineage): string {
  const v = l.version
  const lines = [
    `# renew_before_expiry = 30 days`,
    `version = 4.1.1`,
    `archive_dir = ${LE_DIR}/archive/${l.name}`,
    `cert = ${LE_DIR}/live/${l.name}/cert.pem`,
    `privkey = ${LE_DIR}/live/${l.name}/privkey.pem`,
    `chain = ${LE_DIR}/live/${l.name}/chain.pem`,
    `fullchain = ${LE_DIR}/live/${l.name}/fullchain.pem`,
    '',
    '# Options used in the renewal process',
    '[renewalparams]',
    `account = ${'0'.repeat(0)}7b1f3e9d0c2a4b6e8f1a3c5d7e9b0a2c`,
    `authenticator = ${l.authenticator}`,
    ...(l.authenticator === 'nginx' ? ['installer = nginx'] : []),
    `server = https://acme-${l.staging ? 'staging-' : ''}v02.api.letsencrypt.org/directory`,
    'key_type = ecdsa',
    ...(l.webroot ? ['webroot_path = ' + l.webroot + ',', '[[webroot_map]]', ...l.domains.map((d) => `${d} = ${l.webroot}`)] : []),
    ...(l.hook ? [`renew_hook = ${l.hook}`] : []),
  ]
  void v
  return lines.join('\n') + '\n'
}

/** Escribe un certificado nuevo en el linaje (como hace certbot al emitir o renovar). */
export function writeLineage(sys: System, l: Lineage, days = 90, ageDays = 0): CertData {
  const fs = sys.vfs
  const arch = `${LE_DIR}/archive/${l.name}`
  const live = `${LE_DIR}/live/${l.name}`
  for (const d of [LE_DIR, `${LE_DIR}/archive`, `${LE_DIR}/live`, `${LE_DIR}/renewal`, arch, live]) if (!fs.exists(d)) fs.mkdirp(d, ROOT_CRED, d.includes('archive') || d.includes('live') ? 0o700 : 0o755)
  l.version++
  const key = newKey('EC', 256, `le:${sys.hostname}:${l.name}:${l.version}:${Date.now()}`)
  const inter = l.staging ? STAGING_R11 : LE_R11
  const cert = issue({ subject: { CN: l.domains[0] }, san: l.domains.map((d) => `DNS:${d}`), days, startDays: -ageDays, key, issuer: { cert: inter, keyId: inter.keyId }, staging: l.staging })
  const n = l.version
  fs.writeFile(`${arch}/cert${n}.pem`, toPem(cert), ROOT_CRED, { mode: 0o644 })
  fs.writeFile(`${arch}/chain${n}.pem`, toPem(inter), ROOT_CRED, { mode: 0o644 })
  fs.writeFile(`${arch}/fullchain${n}.pem`, toPem(cert) + toPem(inter), ROOT_CRED, { mode: 0o644 })
  fs.writeFile(`${arch}/privkey${n}.pem`, toPem(key), ROOT_CRED, { mode: 0o600 })
  for (const f of ['cert', 'chain', 'fullchain', 'privkey']) {
    const link = `${live}/${f}.pem`
    if (fs.exists(link, ROOT_CRED, false)) fs.unlink(link, ROOT_CRED)
    fs.symlink(`../../archive/${l.name}/${f}${n}.pem`, link, ROOT_CRED)
  }
  if (!fs.exists(`${live}/README`)) fs.writeFile(`${live}/README`, 'This directory contains your keys and certificates.\n\n`privkey.pem`  : the private key for your certificate.\n`fullchain.pem`: the certificate file used in most server software.\n`chain.pem`    : used for OCSP stapling in Nginx >=1.3.7.\n`cert.pem`     : will break many server configurations, and should not be used\n                 without reading further documentation (see link below).\n', ROOT_CRED)
  fs.writeFile(`${LE_DIR}/renewal/${l.name}.conf`, confText(l), ROOT_CRED, { mode: 0o644 })
  l.cert = cert
  return cert
}

/** Los linajes que hay en /etc/letsencrypt (leídos de renewal/*.conf y live/). */
export function lineages(sys: System): Lineage[] {
  const dir = `${LE_DIR}/renewal`
  if (!sys.vfs.exists(dir)) return []
  const out: Lineage[] = []
  for (const f of sys.vfs.readdir(dir, ROOT_CRED).filter((x) => x.endsWith('.conf')).sort()) {
    const text = sys.vfs.readFile(`${dir}/${f}`, ROOT_CRED)
    const name = f.slice(0, -5)
    const get = (k: string) => new RegExp(`^${k}\\s*=\\s*(.*)$`, 'm').exec(text)?.[1]?.trim()
    let cert: CertData | undefined
    let version = 0
    try {
      cert = certsIn(sys.vfs.readFile(`${LE_DIR}/live/${name}/cert.pem`, ROOT_CRED))[0]
      const files = sys.vfs.readdir(`${LE_DIR}/archive/${name}`, ROOT_CRED)
      version = Math.max(0, ...files.map((x) => Number(/^cert(\d+)\.pem$/.exec(x)?.[1] ?? 0)))
    } catch {
      cert = undefined
    }
    const webroot = /^webroot_path\s*=\s*([^,\n]+)/m.exec(text)?.[1]?.trim()
    out.push({
      name,
      domains: cert?.san.map((s) => s.replace(/^DNS:/, '')) ?? [name],
      staging: (get('server') ?? '').includes('staging'),
      version,
      authenticator: (get('authenticator') as Lineage['authenticator']) ?? 'nginx',
      webroot,
      hook: get('renew_hook') ?? get('deploy_hook'),
      cert,
    })
  }
  return out
}

export type ChallengeResult = { ok: true } | { ok: false; detail: string; type: 'dns' | 'connection' | 'unauthorized' | 'timeout' }

/**
 * Validación HTTP-01: Let's Encrypt busca el token en http://dominio/.well-known/acme-challenge/
 * desde internet. El cliente lo deja en la carpeta del sitio (webroot) o lo sirve con nginx.
 */
export function http01(sys: System, domain: string, webroot: string | undefined, viaNginx: boolean): ChallengeResult {
  const ip = web(sys).publicDns[domain]
  if (!ip) return { ok: false, type: 'dns', detail: `DNS problem: NXDOMAIN looking up A for ${domain} - check that a DNS record exists for this domain` }
  const token = `Tk${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`
  let tmp: string | undefined
  const fs = sys.vfs
  if (webroot) {
    const dir = `${webroot.replace(/\/$/, '')}/.well-known/acme-challenge`
    try {
      fs.mkdirp(dir, ROOT_CRED)
      tmp = `${dir}/${token}`
      fs.writeFile(tmp, `${token}.key-authorization`, ROOT_CRED, { mode: 0o644 })
    } catch {
      return { ok: false, type: 'unauthorized', detail: `Couldn't create the challenge file in ${dir}` }
    }
  }
  void viaNginx
  const r = fetchHttp(sys, `http://${domain}/.well-known/acme-challenge/${token}`, { fromInternet: true, http1: true, userAgent: "Mozilla/5.0 (compatible; Let's Encrypt validation server; +https://www.letsencrypt.org)" })
  if (tmp) {
    try {
      fs.unlink(tmp, ROOT_CRED)
    } catch {
      // ya no está
    }
  }
  if (!r.ok) return { ok: false, type: r.code === 28 ? 'timeout' : 'connection', detail: `${ip}: Timeout during connect (likely firewall problem)` }
  if (viaNginx && !webroot) return { ok: true }
  if (r.res.status !== 200 || !r.res.body.includes(token)) return { ok: false, type: 'unauthorized', detail: `${ip}: Invalid response from http://${domain}/.well-known/acme-challenge/${token}: ${r.res.status}` }
  return { ok: true }
}
