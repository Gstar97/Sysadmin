/**
 * Certificados y claves del servidor simulado.
 *
 * Los archivos se ven como PEM de verdad (-----BEGIN CERTIFICATE----- y líneas de base64 de 64
 * caracteres), pero adentro no hay DER: hay un JSON con los datos que importan para administrar
 * (sujeto, emisor, SAN, fechas, qué clave lo firmó). Con eso se puede verificar una cadena,
 * detectar un certificado vencido o un intermedio faltante, comparar clave y certificado, y
 * mostrar lo mismo que openssl x509 -text.
 */
import type { System } from './system'
import { ROOT_CRED } from './vfs'

export interface DistName {
  C?: string
  ST?: string
  L?: string
  O?: string
  OU?: string
  CN?: string
}

export type KeyAlg = 'RSA' | 'EC' | 'ED25519'

export interface CertData {
  t: 'cert'
  subject: DistName
  issuer: DistName
  /** "DNS:www.ejemplo.com" o "IP Address:10.0.0.1" */
  san: string[]
  notBefore: number
  notAfter: number
  serial: string
  /** Identificador de la clave pública del sujeto. */
  keyId: string
  /** Clave que firmó el certificado (igual a keyId si es autofirmado). */
  issuerKeyId: string
  ca: boolean
  pathLen?: number
  keyAlg: KeyAlg
  keyBits: number
  sigAlg: string
  ku: string[]
  eku: string[]
  /** Emitido por el entorno de pruebas de Let's Encrypt. */
  staging?: boolean
}

export interface KeyData {
  t: 'key'
  id: string
  alg: KeyAlg
  bits: number
  curve?: string
  /** Clave cifrada con contraseña (PEM "ENCRYPTED PRIVATE KEY"). */
  enc?: boolean
}

/** Clave pública (openssl pkey -pubout): sirve para verificar firmas, no para firmar. */
export interface PubData {
  t: 'pub'
  id: string
  alg: KeyAlg
  bits: number
}

export interface CsrData {
  t: 'csr'
  subject: DistName
  san: string[]
  keyId: string
  keyAlg: KeyAlg
  keyBits: number
}

const DAY = 86_400_000
const MARK = 'SIMPEM1:'

// ---------------------------------------------------------------------------------------
// base64 que acepta acentos (los nombres de las empresas los tienen)
// ---------------------------------------------------------------------------------------

function b64encode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function b64decode(text: string): string | undefined {
  try {
    const bin = atob(text.replace(/\s+/g, ''))
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return undefined
  }
}

function wrap64(s: string): string {
  return s.match(/.{1,64}/g)?.join('\n') ?? ''
}

const LABEL: Record<string, string> = { cert: 'CERTIFICATE', key: 'PRIVATE KEY', csr: 'CERTIFICATE REQUEST', pub: 'PUBLIC KEY' }

export function toPem(obj: CertData | KeyData | CsrData | PubData): string {
  const label = obj.t === 'key' && obj.enc ? 'ENCRYPTED PRIVATE KEY' : LABEL[obj.t]
  // Relleno para que el bloque tenga un tamaño parecido al de uno real.
  const json = JSON.stringify(obj)
  const pad = obj.t === 'key' ? 1100 : obj.t === 'cert' ? 900 : obj.t === 'pub' ? 300 : 600
  const body = b64encode(MARK + json + ' '.repeat(Math.max(0, pad - json.length)))
  return `-----BEGIN ${label}-----\n${wrap64(body)}\n-----END ${label}-----\n`
}

export interface PemBlock {
  label: string
  data?: CertData | KeyData | CsrData | PubData
}

/** Todos los bloques PEM de un texto (un fullchain tiene varios). */
export function parsePem(text: string): PemBlock[] {
  const out: PemBlock[] = []
  const re = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const raw = b64decode(m[2])
    let data: PemBlock['data']
    if (raw?.startsWith(MARK)) {
      try {
        data = JSON.parse(raw.slice(MARK.length).trim())
      } catch {
        data = undefined
      }
    }
    out.push({ label: m[1], data })
  }
  return out
}

export function certsIn(text: string): CertData[] {
  return parsePem(text)
    .map((b) => b.data)
    .filter((d): d is CertData => d?.t === 'cert')
}

export function keyIn(text: string): KeyData | undefined {
  return parsePem(text)
    .map((b) => b.data)
    .find((d): d is KeyData => d?.t === 'key')
}

export function pubIn(text: string): PubData | undefined {
  return parsePem(text)
    .map((b) => b.data)
    .find((d): d is PubData => d?.t === 'pub')
}

export function csrIn(text: string): CsrData | undefined {
  return parsePem(text)
    .map((b) => b.data)
    .find((d): d is CsrData => d?.t === 'csr')
}

// ---------------------------------------------------------------------------------------
// Identificadores estables (los certificados de fábrica tienen que ser siempre iguales)
// ---------------------------------------------------------------------------------------

export function hashHex(seed: string, len = 40): string {
  let out = ''
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  let i = 0
  while (out.length < len) {
    for (const c of `${seed}:${i}`) {
      h1 = Math.imul(h1 ^ c.charCodeAt(0), 16777619) >>> 0
      h2 = Math.imul(h2 ^ c.charCodeAt(0), 2246822519) >>> 0
    }
    out += ((h1 ^ h2) >>> 0).toString(16).padStart(8, '0')
    i++
  }
  return out.slice(0, len)
}

let counter = 0
/** Identificador nuevo para una clave generada en el ejercicio. */
export function freshId(prefix: string): string {
  counter++
  return hashHex(`${prefix}:${Date.now()}:${counter}:${Math.random()}`)
}

export function newKey(alg: KeyAlg = 'RSA', bits = 2048, seed?: string): KeyData {
  const id = seed ? hashHex(`key:${seed}`) : freshId('key')
  return alg === 'EC' ? { t: 'key', id, alg, bits: 256, curve: 'prime256v1' } : alg === 'ED25519' ? { t: 'key', id, alg, bits: 256 } : { t: 'key', id, alg, bits }
}

function sigAlgFor(alg: KeyAlg): string {
  return alg === 'EC' ? 'ecdsa-with-SHA256' : alg === 'ED25519' ? 'ED25519' : 'sha256WithRSAEncryption'
}

export interface IssueOpts {
  subject: DistName
  san?: string[]
  days: number
  /** Desfase del inicio respecto de ahora, en días (negativo: ya empezó). */
  startDays?: number
  ca?: boolean
  pathLen?: number
  key: { id: string; alg: KeyAlg; bits: number }
  /** Quién firma: undefined = autofirmado. */
  issuer?: { cert: CertData; keyId: string }
  serial?: string
  ku?: string[]
  eku?: string[]
  staging?: boolean
  now?: number
}

export function issue(o: IssueOpts): CertData {
  const now = o.now ?? Date.now()
  const start = now + (o.startDays ?? 0) * DAY
  const signerAlg = o.issuer ? o.issuer.cert.keyAlg : o.key.alg
  return {
    t: 'cert',
    subject: o.subject,
    issuer: o.issuer ? o.issuer.cert.subject : o.subject,
    san: o.san ?? [],
    notBefore: start,
    notAfter: start + o.days * DAY,
    serial: o.serial ?? hashHex(`serial:${o.key.id}:${start}:${Math.random()}`, 32).toUpperCase(),
    keyId: o.key.id,
    issuerKeyId: o.issuer ? o.issuer.keyId : o.key.id,
    ca: !!o.ca,
    pathLen: o.pathLen,
    keyAlg: o.key.alg,
    keyBits: o.key.bits,
    sigAlg: sigAlgFor(signerAlg),
    ku: o.ku ?? (o.ca ? ['Certificate Sign', 'CRL Sign'] : ['Digital Signature', 'Key Encipherment']),
    eku: o.eku ?? (o.ca ? [] : ['TLS Web Server Authentication']),
    staging: o.staging,
  }
}

// ---------------------------------------------------------------------------------------
// Las autoridades públicas del simulador
// ---------------------------------------------------------------------------------------

const Y = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d)

function fixed(name: DistName, keySeed: string, from: number, to: number, issuer?: CertData, alg: KeyAlg = 'RSA', bits = 4096, pathLen?: number): CertData {
  const keyId = hashHex(`key:${keySeed}`)
  return {
    t: 'cert',
    subject: name,
    issuer: issuer?.subject ?? name,
    san: [],
    notBefore: from,
    notAfter: to,
    serial: hashHex(`serial:${keySeed}`, 32).toUpperCase(),
    keyId,
    issuerKeyId: issuer?.keyId ?? keyId,
    ca: true,
    pathLen,
    keyAlg: alg,
    keyBits: alg === 'EC' ? 384 : bits,
    sigAlg: (issuer?.keyAlg ?? alg) === 'EC' ? 'ecdsa-with-SHA384' : 'sha256WithRSAEncryption',
    ku: ['Digital Signature', 'Certificate Sign', 'CRL Sign'],
    eku: issuer ? ['TLS Web Client Authentication', 'TLS Web Server Authentication'] : [],
  }
}

export const ROOTS = {
  isrgX1: fixed({ C: 'US', O: 'Internet Security Research Group', CN: 'ISRG Root X1' }, 'isrg-x1', Y(2015, 6, 4), Y(2035, 6, 4)),
  isrgX2: fixed({ C: 'US', O: 'Internet Security Research Group', CN: 'ISRG Root X2' }, 'isrg-x2', Y(2020, 9, 4), Y(2040, 9, 17), undefined, 'EC'),
  digicertG2: fixed({ C: 'US', O: 'DigiCert Inc', OU: 'www.digicert.com', CN: 'DigiCert Global Root G2' }, 'digicert-g2', Y(2013, 8, 1), Y(2038, 1, 15), undefined, 'RSA', 2048),
  usertrust: fixed({ C: 'US', ST: 'New Jersey', L: 'Jersey City', O: 'The USERTRUST Network', CN: 'USERTrust RSA Certification Authority' }, 'usertrust', Y(2010, 2, 1), Y(2038, 1, 18)),
  gtsR1: fixed({ C: 'US', O: 'Google Trust Services LLC', CN: 'GTS Root R1' }, 'gts-r1', Y(2016, 6, 22), Y(2036, 6, 22)),
}

export const LE_R11 = fixed({ C: 'US', O: "Let's Encrypt", CN: 'R11' }, 'le-r11', Y(2024, 3, 13), Y(2027, 3, 12), ROOTS.isrgX1, 'RSA', 2048, 0)

/** El entorno de pruebas (staging) de Let's Encrypt: su raíz no está en ningún almacén de confianza. */
export const STAGING_ROOT = fixed({ C: 'US', O: '(STAGING) Internet Security Research Group', CN: '(STAGING) Pretend Pear X1' }, 'staging-pear', Y(2015, 6, 4), Y(2035, 6, 4))
export const STAGING_R11 = fixed({ C: 'US', O: "(STAGING) Let's Encrypt", CN: '(STAGING) Wannabe Watercress R11' }, 'staging-r11', Y(2024, 3, 13), Y(2027, 3, 12), STAGING_ROOT, 'RSA', 2048, 0)

export const DEFAULT_ROOTS: CertData[] = Object.values(ROOTS)

export function bundlePath(sys: System): string {
  return sys.distro === 'rocky' ? '/etc/pki/tls/certs/ca-bundle.crt' : '/etc/ssl/certs/ca-certificates.crt'
}

export function anchorsDir(sys: System): string {
  return sys.distro === 'rocky' ? '/etc/pki/ca-trust/source/anchors' : '/usr/local/share/ca-certificates'
}

function bundleText(extra: CertData[]): string {
  return [...DEFAULT_ROOTS, ...extra].map((c) => `# ${c.subject.CN ?? c.subject.O}\n${toPem(c)}`).join('\n')
}

/** Arma el almacén de confianza del sistema la primera vez. */
export function ensureTrustStore(sys: System) {
  const path = bundlePath(sys)
  if (sys.vfs.exists(path)) return
  const dir = path.slice(0, path.lastIndexOf('/'))
  sys.vfs.mkdirp(dir, ROOT_CRED)
  sys.vfs.mkdirp(anchorsDir(sys), ROOT_CRED)
  sys.vfs.writeFile(path, bundleText([]), ROOT_CRED, { mode: 0o644 })
}

/**
 * update-ca-trust / update-ca-certificates: el almacén queda con las raíces de fábrica más los
 * certificados de la carpeta de anclas. En Ubuntu solo cuentan los archivos .crt.
 */
export function rebuildTrustStore(sys: System): { added: number; ignored: string[] } {
  ensureTrustStore(sys)
  const dir = anchorsDir(sys)
  const extra: CertData[] = []
  const ignored: string[] = []
  let files: string[]
  try {
    files = sys.vfs.readdir(dir, ROOT_CRED).sort()
  } catch {
    files = []
  }
  for (const f of files) {
    if (sys.distro === 'ubuntu' && !f.endsWith('.crt')) {
      ignored.push(f)
      continue
    }
    try {
      extra.push(...certsIn(sys.vfs.readFile(`${dir}/${f}`, ROOT_CRED)))
    } catch {
      // ilegible
    }
  }
  sys.vfs.writeFile(bundlePath(sys), bundleText(extra), ROOT_CRED, { mode: 0o644 })
  return { added: extra.length, ignored }
}

export function trustedRoots(sys: System, caFile?: string): CertData[] {
  ensureTrustStore(sys)
  try {
    return certsIn(sys.vfs.readFile(caFile ?? bundlePath(sys), ROOT_CRED))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------------------
// Verificación
// ---------------------------------------------------------------------------------------

export type VerifyCode = 'ok' | 'expired' | 'not_yet' | 'self_signed' | 'self_signed_chain' | 'issuer' | 'hostname'

export interface VerifyResult {
  code: VerifyCode
  depth: number
  /** Cadena armada, de la hoja a la raíz. */
  chain: CertData[]
}

export function selfSigned(c: CertData): boolean {
  return c.issuerKeyId === c.keyId
}

export function hostMatches(c: CertData, host: string): boolean {
  const h = host.toLowerCase()
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(h)
  const names = c.san.length ? c.san : c.subject.CN ? [`DNS:${c.subject.CN}`] : []
  return names.some((n) => {
    if (isIp) return n === `IP Address:${h}`
    if (!n.startsWith('DNS:')) return false
    const pat = n.slice(4).toLowerCase()
    if (pat === h) return true
    if (pat.startsWith('*.')) {
      const rest = pat.slice(2)
      const idx = h.indexOf('.')
      return idx > 0 && h.slice(idx + 1) === rest
    }
    return false
  })
}

/** Lo que haría OpenSSL al verificar la cadena que presenta un servidor. */
export function verifyChain(presented: CertData[], trusted: CertData[], host?: string, now = Date.now()): VerifyResult {
  const chain: CertData[] = []
  const leaf = presented[0]
  if (!leaf) return { code: 'issuer', depth: 0, chain }
  let cur = leaf
  let depth = 0
  const seen = new Set<string>()
  while (true) {
    chain.push(cur)
    if (cur.notAfter < now) return { code: 'expired', depth, chain }
    if (cur.notBefore > now) return { code: 'not_yet', depth, chain }
    if (seen.has(cur.keyId)) return { code: 'issuer', depth, chain }
    seen.add(cur.keyId)
    if (trusted.some((t) => t.keyId === cur.keyId && selfSigned(t))) break
    if (selfSigned(cur)) return { code: depth === 0 ? 'self_signed' : 'self_signed_chain', depth, chain }
    const anchor = trusted.find((t) => t.keyId === cur.issuerKeyId)
    if (anchor) {
      chain.push(anchor)
      if (anchor.notAfter < now) return { code: 'expired', depth: depth + 1, chain }
      break
    }
    const next = presented.find((p) => p.keyId === cur.issuerKeyId && p !== cur)
    if (!next) return { code: 'issuer', depth, chain }
    cur = next
    depth++
  }
  if (host && !hostMatches(leaf, host)) return { code: 'hostname', depth: 0, chain }
  return { code: 'ok', depth: 0, chain }
}

export const OPENSSL_ERR: Record<Exclude<VerifyCode, 'ok' | 'hostname'>, [number, string]> = {
  expired: [10, 'certificate has expired'],
  not_yet: [9, 'certificate is not yet valid'],
  self_signed: [18, 'self-signed certificate'],
  self_signed_chain: [19, 'self-signed certificate in certificate chain'],
  issuer: [20, 'unable to get local issuer certificate'],
}

// ---------------------------------------------------------------------------------------
// Presentación (openssl x509 -text y compañía)
// ---------------------------------------------------------------------------------------

export function dnString(n: DistName, style: 'openssl' | 'slash' = 'openssl'): string {
  const parts = (['C', 'ST', 'L', 'O', 'OU', 'CN'] as const).filter((k) => n[k]).map((k) => `${k}${style === 'openssl' ? ' = ' : '='}${n[k]}`)
  return style === 'slash' ? '/' + parts.join('/') : parts.join(', ')
}

/** Fecha como la muestra OpenSSL: "Nov 14 10:00:00 2026 GMT". */
export function gmt(ms: number): string {
  const d = new Date(ms)
  const mon = d.toUTCString().slice(8, 11)
  return `${mon} ${String(d.getUTCDate()).padStart(2, ' ')} ${d.toISOString().slice(11, 19)} ${d.getUTCFullYear()} GMT`
}

export function serialHex(c: CertData): string {
  return (c.serial.match(/.{2}/g) ?? []).join(':').toLowerCase()
}

export function fingerprint(c: CertData, alg: 'sha256' | 'sha1' = 'sha256'): string {
  return (hashHex(`fp:${alg}:${c.serial}:${c.keyId}`, alg === 'sha256' ? 64 : 40).toUpperCase().match(/.{2}/g) ?? []).join(':')
}

export function modulus(keyId: string): string {
  return hashHex(`mod:${keyId}`, 512).toUpperCase()
}

function hexBlock(seed: string, bytes: number, indent: string): string {
  const hex = hashHex(seed, bytes * 2).match(/.{2}/g) ?? []
  const lines: string[] = []
  for (let i = 0; i < hex.length; i += 15) lines.push(indent + hex.slice(i, i + 15).join(':') + (i + 15 < hex.length ? ':' : ''))
  return lines.join('\n')
}

export function x509Text(c: CertData): string {
  const pub =
    c.keyAlg === 'RSA'
      ? `                Public Key Algorithm: rsaEncryption\n                    Public-Key: (${c.keyBits} bit)\n                    Modulus:\n${hexBlock(`mod:${c.keyId}`, 24, '                        ')}\n                        ...\n                    Exponent: 65537 (0x10001)`
      : c.keyAlg === 'EC'
        ? `                Public Key Algorithm: id-ecPublicKey\n                    Public-Key: (${c.keyBits} bit)\n                    pub:\n${hexBlock(`pub:${c.keyId}`, 30, '                        ')}\n                    ASN1 OID: ${c.keyBits === 384 ? 'secp384r1' : 'prime256v1'}\n                    NIST CURVE: ${c.keyBits === 384 ? 'P-384' : 'P-256'}`
        : `                Public Key Algorithm: ED25519\n                    ED25519 Public-Key:\n                    pub:\n${hexBlock(`pub:${c.keyId}`, 32, '                        ')}`
  const ext: string[] = []
  if (c.ku.length) ext.push(`            X509v3 Key Usage: critical\n                ${c.ku.join(', ')}`)
  if (c.eku.length) ext.push(`            X509v3 Extended Key Usage: \n                ${c.eku.join(', ')}`)
  ext.push(`            X509v3 Basic Constraints: critical\n                CA:${c.ca ? 'TRUE' : 'FALSE'}${c.ca && c.pathLen !== undefined ? `, pathlen:${c.pathLen}` : ''}`)
  ext.push(`            X509v3 Subject Key Identifier: \n                ${(hashHex(`ski:${c.keyId}`, 40).toUpperCase().match(/.{2}/g) ?? []).join(':')}`)
  if (!selfSigned(c)) ext.push(`            X509v3 Authority Key Identifier: \n                ${(hashHex(`ski:${c.issuerKeyId}`, 40).toUpperCase().match(/.{2}/g) ?? []).join(':')}`)
  if (c.issuer.O?.includes("Let's Encrypt") && !c.ca) ext.push(`            Authority Information Access: \n                CA Issuers - URI:http://${(c.issuer.CN ?? 'r11').toLowerCase().replace(/[^a-z0-9]+/g, '')}.i.lencr.org/`)
  if (c.san.length) ext.push(`            X509v3 Subject Alternative Name: \n                ${c.san.join(', ')}`)
  return `Certificate:
    Data:
        Version: 3 (0x2)
        Serial Number:
            ${serialHex(c)}
        Signature Algorithm: ${c.sigAlg}
        Issuer: ${dnString(c.issuer)}
        Validity
            Not Before: ${gmt(c.notBefore)}
            Not After : ${gmt(c.notAfter)}
        Subject: ${dnString(c.subject)}
        Subject Public Key Info:
${pub}
        X509v3 extensions:
${ext.join('\n')}
    Signature Algorithm: ${c.sigAlg}
    Signature Value:
${hexBlock(`sig:${c.serial}`, 30, '        ')}
        ...
`
}

/** "/CN=www.ejemplo.com/O=Ejemplo" o "CN=www.ejemplo.com, O=Ejemplo" a nombre distinguido. */
export function parseSubject(text: string): DistName | undefined {
  const t = text.trim()
  const parts = t.startsWith('/') ? t.slice(1).split('/') : t.split(/\s*,\s*/)
  const out: DistName = {}
  for (const p of parts) {
    if (!p) continue
    const m = /^\s*(C|ST|L|O|OU|CN)\s*=\s*(.*)$/i.exec(p)
    if (!m) return undefined
    out[m[1].toUpperCase() as keyof DistName] = m[2].trim()
  }
  return out
}

/** "DNS:a,DNS:b,IP:10.0.0.1" (lo que se escribe en subjectAltName) a la forma de OpenSSL. */
export function parseSan(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(DNS|IP)\s*:\s*(.+)$/i.exec(s)
      if (!m) return s
      return m[1].toUpperCase() === 'IP' ? `IP Address:${m[2]}` : `DNS:${m[2]}`
    })
}
