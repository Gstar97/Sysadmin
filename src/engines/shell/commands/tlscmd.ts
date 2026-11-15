/**
 * openssl, certbot, update-ca-trust y update-ca-certificates sobre el modelo de certificados
 * del simulador (tls.ts) y Let's Encrypt (acme.ts).
 */
import { http01, lineages, LE_DIR, writeLineage, type Lineage } from '../acme'
import { endpointAt, openSslVersion, reach, web } from '../http'
import { register, type CommandContext } from '../shell'
import { digest } from './files'
import { nginxStartCheck } from '../web'
import {
  anchorsDir,
  bundlePath,
  certsIn,
  csrIn,
  dnString,
  fingerprint,
  gmt,
  hashHex,
  issue,
  keyIn,
  pubIn,
  modulus,
  newKey,
  OPENSSL_ERR,
  parsePem,
  parseSan,
  parseSubject,
  rebuildTrustStore,
  selfSigned,
  serialHex,
  toPem,
  trustedRoots,
  verifyChain,
  x509Text,
  type CertData,
  type CsrData,
  type KeyAlg,
  type KeyData,
} from '../tls'
import { ROOT_CRED } from '../vfs'

// ---------------------------------------------------------------------------------------
// Lectura y escritura de archivos
// ---------------------------------------------------------------------------------------

function readIn(ctx: CommandContext, file: string | undefined, what: string): string | undefined {
  if (!file) {
    const text = ctx.stdin.readAll()
    if (text) return text
    ctx.err(`[simulador] Indicá el archivo con -in (por ejemplo, openssl ${what} -in archivo.pem -noout -text).\n`)
    return undefined
  }
  try {
    return ctx.sys.vfs.readFile(ctx.sh.resolve(file), ctx.sh.cred)
  } catch (e) {
    const denied = String(e).includes('EACCES') || String(e).includes('ermission')
    ctx.err(`Could not open file or uri for loading ${what === 'x509' ? 'certificate' : what === 'req' ? 'certificate request' : 'private key'} from ${file}: ${denied ? 'Permission denied' : 'No such file or directory'}\n`)
    return undefined
  }
}

function writeOut(ctx: CommandContext, file: string | undefined, text: string, mode = 0o644): boolean {
  if (!file) {
    ctx.out(text)
    return true
  }
  try {
    ctx.sys.vfs.writeFile(ctx.sh.resolve(file), text, ctx.sh.cred, { mode, umask: ctx.sh.umask })
    return true
  } catch {
    ctx.err(`Could not open file or uri for writing ${file}: Permission denied\n`)
    return false
  }
}

const DER = 'SIMDER1:'
const P12 = 'SIMP12_1:'

function toDer(c: CertData): string {
  return DER + btoa(unescape(encodeURIComponent(JSON.stringify(c))))
}

function fromDer(text: string): CertData | undefined {
  if (!text.startsWith(DER)) return undefined
  try {
    return JSON.parse(decodeURIComponent(escape(atob(text.slice(DER.length).trim()))))
  } catch {
    return undefined
  }
}

/** Opciones estilo openssl: -in archivo, -noout, -addext (repetible). */
function opts(args: string[]): { flags: Set<string>; vals: Map<string, string[]>; rest: string[] } {
  const withValue = new Set(['-in', '-out', '-key', '-keyout', '-subj', '-days', '-addext', '-newkey', '-CA', '-CAkey', '-CAfile', '-untrusted', '-connect', '-servername', '-algorithm', '-pkeyopt', '-inkey', '-certfile', '-passout', '-passin', '-password', '-name', '-extfile', '-extensions', '-copy_extensions', '-signkey', '-checkend', '-ext', '-inform', '-outform', '-config', '-reqexts', '-set_serial', '-CAserial', '-nameopt', '-verify_hostname', '-pass', '-sigopt', '-sign', '-verify', '-prverify', '-signature', '-k', '-iter'])
  const flags = new Set<string>()
  const vals = new Map<string, string[]>()
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (withValue.has(a)) vals.set(a, [...(vals.get(a) ?? []), args[++i] ?? ''])
    else if (a.startsWith('-')) flags.add(a)
    else rest.push(a)
  }
  return { flags, vals, rest }
}

function one(o: ReturnType<typeof opts>, k: string): string | undefined {
  return o.vals.get(k)?.[0]
}

function loadCert(ctx: CommandContext, file: string | undefined, inform?: string): CertData | undefined {
  const text = readIn(ctx, file, 'x509')
  if (text === undefined) return undefined
  const c = inform?.toUpperCase() === 'DER' ? fromDer(text) : certsIn(text)[0]
  if (!c) {
    ctx.err(`Could not find certificate from ${file ?? '<stdin>'}\n${hashHex('e', 12).toUpperCase()}:error:1608010C:STORE routines:ossl_store_handle_load_result:unsupported:../crypto/store/store_result.c:151:\nUnable to load certificate\n`)
    return undefined
  }
  return c
}

function loadKey(ctx: CommandContext, file: string | undefined): KeyData | undefined {
  const text = readIn(ctx, file, 'pkey')
  if (text === undefined) return undefined
  const k = keyIn(text)
  if (!k) {
    ctx.err(`Could not find private key from ${file}\nUnable to load private key\n`)
    return undefined
  }
  return k
}

/** Extensiones de -addext y de un archivo de extensiones (-extfile). */
function extensions(texts: string[]): { san: string[]; ca?: boolean; ku?: string[]; eku?: string[] } {
  const out: { san: string[]; ca?: boolean; ku?: string[]; eku?: string[] } = { san: [] }
  const altSections = new Map<string, string[]>()
  const lines = texts.flatMap((t) => t.split('\n'))
  let section = ''
  for (const raw of lines) {
    const l = raw.trim()
    const sec = /^\[\s*(\S+)\s*\]$/.exec(l)
    if (sec) {
      section = sec[1]
      continue
    }
    const kv = /^([\w.]+)\s*=\s*(.+)$/.exec(l)
    if (!kv) continue
    const [, k, v] = kv
    if (/^(DNS|IP)\.\d+$/i.test(k)) altSections.set(section, [...(altSections.get(section) ?? []), `${k.split('.')[0]}:${v}`])
    else if (k === 'subjectAltName') {
      if (v.startsWith('@')) out.san.push(`@${v.slice(1)}`)
      else out.san.push(...parseSan(v))
    } else if (k === 'basicConstraints') out.ca = /CA:TRUE/i.test(v)
    else if (k === 'keyUsage') out.ku = v.replace(/critical,?\s*/i, '').split(',').map((x) => x.trim()).map((x) => ({ digitalSignature: 'Digital Signature', keyEncipherment: 'Key Encipherment', keyCertSign: 'Certificate Sign', cRLSign: 'CRL Sign' } as Record<string, string>)[x] ?? x)
    else if (k === 'extendedKeyUsage') out.eku = v.split(',').map((x) => x.trim()).map((x) => ({ serverAuth: 'TLS Web Server Authentication', clientAuth: 'TLS Web Client Authentication' } as Record<string, string>)[x] ?? x)
  }
  out.san = out.san.flatMap((s) => (s.startsWith('@') ? parseSan((altSections.get(s.slice(1)) ?? []).join(',')) : [s]))
  return out
}

function keyFromSpec(spec: string | undefined, pkeyopts: string[]): { alg: KeyAlg; bits: number } {
  const s = (spec ?? 'rsa:2048').toLowerCase()
  if (s.startsWith('ec') || pkeyopts.some((p) => p.startsWith('ec_paramgen_curve'))) return { alg: 'EC', bits: 256 }
  if (s.startsWith('ed25519')) return { alg: 'ED25519', bits: 256 }
  const bits = Number(/rsa:(\d+)/.exec(s)?.[1] ?? pkeyopts.find((p) => p.startsWith('rsa_keygen_bits'))?.split(':')[1] ?? 2048)
  return { alg: 'RSA', bits }
}

function csrText(c: CsrData): string {
  return `Certificate Request:
    Data:
        Version: 1 (0x0)
        Subject: ${dnString(c.subject)}
        Subject Public Key Info:
            Public Key Algorithm: ${c.keyAlg === 'RSA' ? 'rsaEncryption' : c.keyAlg === 'EC' ? 'id-ecPublicKey' : 'ED25519'}
                Public-Key: (${c.keyBits} bit)
        Attributes:
${c.san.length ? `            Requested Extensions:\n                X509v3 Subject Alternative Name: \n                    ${c.san.join(', ')}` : '            (none)\n            Requested Extensions:'}
    Signature Algorithm: ${c.keyAlg === 'EC' ? 'ecdsa-with-SHA256' : 'sha256WithRSAEncryption'}
    Signature Value:
        ${hashHex(`csr:${c.keyId}`, 60).match(/.{2}/g)?.join(':')}
`
}

// ---------------------------------------------------------------------------------------
// openssl
// ---------------------------------------------------------------------------------------

function genKey(ctx: CommandContext, alg: KeyAlg, bits: number, out: string | undefined, encrypted: boolean): number {
  if (alg === 'RSA' && bits < 2048) ctx.err('[simulador] Ojo: hoy una clave RSA de menos de 2048 bits no la acepta ninguna autoridad ni navegador.\n')
  const k = newKey(alg, bits)
  if (encrypted) k.enc = true
  if (!writeOut(ctx, out, toPem(k), 0o600)) return 1
  if (alg === 'RSA') ctx.err('.....+'.repeat(3) + '\n')
  return 0
}

function opensslReq(ctx: CommandContext, o: ReturnType<typeof opts>): number {
  if (one(o, '-in')) {
    const text = readIn(ctx, one(o, '-in'), 'req')
    if (text === undefined) return 1
    const c = csrIn(text)
    if (!c) {
      ctx.err('Unable to load X509 request\n')
      return 1
    }
    if (o.flags.has('-verify')) ctx.err('Certificate request self-signature verify OK\n')
    if (o.flags.has('-text')) ctx.out(csrText(c))
    if (o.flags.has('-subject')) ctx.out(`subject=${dnString(c.subject)}\n`)
    if (!o.flags.has('-noout')) ctx.out(toPem(c))
    return 0
  }
  const subjText = one(o, '-subj')
  const cfg = one(o, '-config')
  let cfgText = ''
  if (cfg) {
    try {
      cfgText = ctx.sys.vfs.readFile(ctx.sh.resolve(cfg), ctx.sh.cred)
    } catch {
      ctx.err(`Can't open "${cfg}" for reading, No such file or directory\n`)
      return 1
    }
  }
  let subject = subjText ? parseSubject(subjText) : undefined
  if (!subject && cfgText) {
    const dn: Record<string, string> = {}
    for (const m of cfgText.matchAll(/^\s*(C|ST|L|O|OU|CN)\s*=\s*(.+)$/gm)) dn[m[1]] = m[2].trim()
    if (Object.keys(dn).length) subject = dn
  }
  if (!subject) {
    if (subjText) {
      ctx.err(`subject name is expected to be in the format /type0=value0/type1=value1/type2=... where characters may be escaped by \\. This name is not in that format: '${subjText}'\n`)
      return 1
    }
    ctx.err('You are about to be asked to enter information that will be incorporated\ninto your certificate request.\n-----\n[simulador] openssl pregunta los datos uno por uno. En el simulador pasalos con -subj, por ejemplo: -subj "/C=AR/O=Mi Empresa/CN=www.ejemplo.com"\n')
    return 1
  }
  const ext = extensions([...(o.vals.get('-addext') ?? []), cfgText])
  // La clave: -key existente o -newkey (que la escribe en -keyout).
  let key: KeyData | undefined
  if (one(o, '-key')) key = loadKey(ctx, one(o, '-key'))
  else if (one(o, '-newkey') || o.flags.has('-new') || o.flags.has('-x509')) {
    const spec = keyFromSpec(one(o, '-newkey'), o.vals.get('-pkeyopt') ?? [])
    key = newKey(spec.alg, spec.bits)
    const keyout = one(o, '-keyout')
    const plain = o.flags.has('-nodes') || o.flags.has('-noenc')
    if (!plain) {
      ctx.err('[simulador] Sin -noenc (o -nodes, el nombre viejo), openssl cifra la clave y pide una contraseña; nginx no podría arrancar sin que alguien la escriba. Agregá -noenc.\n')
      return 1
    }
    if (!keyout) {
      ctx.err('[simulador] Indicá dónde guardar la clave nueva con -keyout clave.pem.\n')
      return 1
    }
    if (!writeOut(ctx, keyout, toPem(key), 0o600)) return 1
    ctx.err('-----\n')
  }
  if (!key) return 1
  if (o.flags.has('-x509')) {
    const days = Number(one(o, '-days') ?? 30)
    const cert = issue({ subject, san: ext.san, days, key, ca: ext.ca, ku: ext.ku, eku: ext.eku ?? (ext.ca ? [] : undefined) })
    return writeOut(ctx, one(o, '-out'), toPem(cert)) ? 0 : 1
  }
  const csr: CsrData = { t: 'csr', subject, san: ext.san, keyId: key.id, keyAlg: key.alg, keyBits: key.bits }
  return writeOut(ctx, one(o, '-out'), toPem(csr)) ? 0 : 1
}

function opensslX509(ctx: CommandContext, o: ReturnType<typeof opts>): number {
  if (o.flags.has('-req')) {
    const text = readIn(ctx, one(o, '-in'), 'req')
    if (text === undefined) return 1
    const csr = csrIn(text)
    if (!csr) {
      ctx.err('Unable to load certificate request input\n')
      return 1
    }
    const days = Number(one(o, '-days') ?? 30)
    let extText: string[] = []
    if (one(o, '-extfile')) {
      try {
        extText = [ctx.sys.vfs.readFile(ctx.sh.resolve(one(o, '-extfile')!), ctx.sh.cred)]
      } catch {
        ctx.err(`Can't open "${one(o, '-extfile')}" for reading, No such file or directory\n`)
        return 1
      }
    }
    const ext = extensions(extText)
    // Sin -copy_extensions copy ni -extfile, el SAN de la solicitud NO pasa al certificado.
    const san = ext.san.length ? ext.san : one(o, '-copy_extensions') === 'copy' || one(o, '-copy_extensions') === 'copyall' ? csr.san : []
    let issuer: { cert: CertData; keyId: string } | undefined
    if (one(o, '-CA')) {
      const ca = loadCert(ctx, one(o, '-CA'))
      const caKey = loadKey(ctx, one(o, '-CAkey'))
      if (!ca || !caKey) return 1
      if (caKey.id !== ca.keyId) {
        ctx.err('Error: CA certificate and CA private key do not match\n')
        return 1
      }
      if (!ca.ca) ctx.err('[simulador] Ojo: el certificado de -CA no es de una autoridad (CA:FALSE); lo que firme no va a validar.\n')
      issuer = { cert: ca, keyId: caKey.id }
      const serialFile = (one(o, '-CA') ?? '').replace(/\.[^.]+$/, '') + '.srl'
      if (o.flags.has('-CAcreateserial') || ctx.sys.vfs.exists(ctx.sh.resolve(serialFile))) writeOut(ctx, serialFile, hashHex(`srl:${Date.now()}`, 40).toUpperCase() + '\n')
    } else if (one(o, '-signkey') || one(o, '-key')) {
      const k = loadKey(ctx, one(o, '-signkey') ?? one(o, '-key'))
      if (!k) return 1
      issuer = undefined
    } else {
      ctx.err('[simulador] Para firmar la solicitud hace falta -CA y -CAkey (o -signkey para autofirmar).\n')
      return 1
    }
    const cert = issue({ subject: csr.subject, san, days, key: { id: csr.keyId, alg: csr.keyAlg, bits: csr.keyBits }, issuer, ca: ext.ca, ku: ext.ku, eku: ext.eku })
    ctx.err(`Certificate request self-signature ok\nsubject=${dnString(csr.subject)}\n`)
    return writeOut(ctx, one(o, '-out'), toPem(cert)) ? 0 : 1
  }
  const c = loadCert(ctx, one(o, '-in'), one(o, '-inform'))
  if (!c) return 1
  let out = ''
  if (o.flags.has('-text')) out += x509Text(c)
  if (o.flags.has('-subject')) out += `subject=${dnString(c.subject)}\n`
  if (o.flags.has('-issuer')) out += `issuer=${dnString(c.issuer)}\n`
  if (o.flags.has('-dates') || o.flags.has('-startdate')) out += `notBefore=${gmt(c.notBefore)}\n`
  if (o.flags.has('-dates') || o.flags.has('-enddate')) out += `notAfter=${gmt(c.notAfter)}\n`
  if (o.flags.has('-serial')) out += `serial=${c.serial}\n`
  if (o.flags.has('-fingerprint')) out += `${o.flags.has('-sha1') ? 'SHA1' : 'sha256'} Fingerprint=${fingerprint(c, o.flags.has('-sha1') ? 'sha1' : 'sha256')}\n`
  if (o.flags.has('-modulus')) out += `Modulus=${modulus(c.keyId)}\n`
  for (const e of o.vals.get('-ext') ?? []) {
    if (e.includes('subjectAltName')) out += c.san.length ? `X509v3 Subject Alternative Name: \n    ${c.san.join(', ')}\n` : 'No extensions in certificate\n'
    if (e.includes('basicConstraints')) out += `X509v3 Basic Constraints: critical\n    CA:${c.ca ? 'TRUE' : 'FALSE'}${c.ca && c.pathLen !== undefined ? `, pathlen:${c.pathLen}` : ''}\n`
    if (/(^|,)keyUsage/.test(e)) out += c.ku.length ? `X509v3 Key Usage: critical\n    ${c.ku.join(', ')}\n` : ''
    if (e.includes('extendedKeyUsage')) out += c.eku.length ? `X509v3 Extended Key Usage: \n    ${c.eku.join(', ')}\n` : ''
  }
  if (o.flags.has('-pubkey')) out += `-----BEGIN PUBLIC KEY-----\n${hashHex(`pub:${c.keyId}`, 64)}\n-----END PUBLIC KEY-----\n`
  let code = 0
  const end = one(o, '-checkend')
  if (end !== undefined) {
    const ok = c.notAfter > Date.now() + Number(end) * 1000
    out += ok ? 'Certificate will not expire\n' : 'Certificate will expire\n'
    code = ok ? 0 : 1
  }
  if (!o.flags.has('-noout')) {
    const outform = one(o, '-outform')?.toUpperCase()
    if (outform === 'DER') {
      if (!one(o, '-out')) {
        ctx.err('[simulador] DER es binario: guardalo con -out archivo.der.\n')
        return 1
      }
      writeOut(ctx, one(o, '-out'), toDer(c))
    } else if (one(o, '-out')) writeOut(ctx, one(o, '-out'), toPem(c))
    else out += toPem(c)
  }
  ctx.out(out)
  return code
}

function opensslVerify(ctx: CommandContext, o: ReturnType<typeof opts>): number {
  const ca = one(o, '-CAfile')
  const untrusted = (o.vals.get('-untrusted') ?? []).flatMap((f) => {
    try {
      return certsIn(ctx.sys.vfs.readFile(ctx.sh.resolve(f), ctx.sh.cred))
    } catch {
      return []
    }
  })
  let code = 0
  for (const f of o.rest) {
    const text = readIn(ctx, f, 'x509')
    if (text === undefined) return 2
    const certs = certsIn(text)
    if (!certs.length) {
      ctx.err(`Could not find certificate from ${f}\n`)
      return 2
    }
    const trusted = trustedRoots(ctx.sys, ca ? ctx.sh.resolve(ca) : undefined)
    const r = verifyChain([certs[0], ...certs.slice(1), ...untrusted], trusted)
    if (r.code === 'ok') ctx.out(`${f}: OK\n`)
    else {
      const [n, msg] = OPENSSL_ERR[r.code as keyof typeof OPENSSL_ERR]
      const c = r.chain[r.depth] ?? certs[0]
      ctx.err(`${dnString(c.subject)}\nerror ${n} at ${r.depth} depth lookup: ${msg}\nerror ${f}: verification failed\n`)
      code = 2
    }
  }
  return code
}

function sClient(ctx: CommandContext, o: ReturnType<typeof opts>): number {
  const target = one(o, '-connect') ?? o.rest[0]
  if (!target) {
    ctx.err('[simulador] Indicá el servidor: openssl s_client -connect www.ejemplo.com:443 -servername www.ejemplo.com\n')
    return 1
  }
  const [hostRaw, portRaw] = target.split(':')
  const host = hostRaw.toLowerCase()
  const port = Number(portRaw ?? 443)
  const sni = one(o, '-servername') ?? (/^\d+\.\d+\.\d+\.\d+$/.test(host) ? undefined : host)
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : ctx.sys.resolveHost(host)
  const tag = `40${hashHex('sc', 10).toUpperCase()}`
  if (!ip) {
    ctx.err(`${tag}:error:10080002:BIO routines:BIO_lookup_ex:system lib:../crypto/bio/bio_addr.c:741:\nconnect:errno=0\n`)
    return 1
  }
  const r = reach(ctx.sys, ip, port)
  const fail = () => {
    ctx.err(`${tag}:error:8000006F:system library:BIO_connect:Connection refused:../crypto/bio/bio_sock2.c:178:calling connect()\n${tag}:error:10000067:BIO routines:BIO_connect:connect error:../crypto/bio/bio_sock2.c:180:\nconnect:errno=111\n`)
    return 1
  }
  if ('error' in r) {
    if (r.error !== 'outside') return fail()
    ctx.err('[simulador] Para sitios de internet usá curl -v; s_client se practica con los servidores del laboratorio.\n')
    return 1
  }
  const ep = endpointAt(r.target, port, r.localIp)
  if (!ep) return fail()
  if (!ep.tls) {
    ctx.out(`CONNECTED(00000003)\n${tag}:error:0A00010B:SSL routines:ssl3_get_record:wrong version number:../ssl/record/ssl3_record.c:354:\n---\nno peer certificate available\n---\nNo client certificate CA names sent\n---\nSSL handshake has read 5 bytes and written 299 bytes\nVerification: OK\n---\nNew, (NONE), Cipher is (NONE)\n`)
    return 1
  }
  const hello = ep.tls(sni ?? host)
  if ('error' in hello) {
    ctx.out(`CONNECTED(00000003)\n${tag}:error:0A000438:SSL routines:ssl3_read_bytes:tlsv1 alert internal error:../ssl/record/rec_layer_s3.c:907:SSL alert number 80\n---\nno peer certificate available\n---\n`)
    return 1
  }
  const chain: CertData[] = hello.chain
  const protos = hello.protocols
  const want = o.flags.has('-tls1_3') ? 'TLSv1.3' : o.flags.has('-tls1_2') ? 'TLSv1.2' : o.flags.has('-tls1_1') ? 'TLSv1.1' : o.flags.has('-tls1') ? 'TLSv1' : undefined
  const proto = want ? (protos.includes(want) ? want : undefined) : protos.includes('TLSv1.3') ? 'TLSv1.3' : protos.at(-1)
  if (!proto) {
    ctx.out(`CONNECTED(00000003)\n${tag}:error:0A00042E:SSL routines:ssl3_read_bytes:tlsv1 alert protocol version:../ssl/record/rec_layer_s3.c:907:SSL alert number 70\n---\nno peer certificate available\n---\nNo client certificate CA names sent\n---\nNew, (NONE), Cipher is (NONE)\nProtocol: ${want}\n`)
    return 1
  }
  const trusted = trustedRoots(ctx.sys, one(o, '-CAfile') ? ctx.sh.resolve(one(o, '-CAfile')!) : undefined)
  const v = verifyChain(chain, trusted, o.vals.has('-verify_hostname') ? one(o, '-verify_hostname') : undefined)
  const lines: string[] = ['CONNECTED(00000003)']
  const fmt = (c: CertData) => Object.entries(c.subject).map(([k, val]) => `${k}=${val}`).join(', ')
  const fmtI = (c: CertData) => Object.entries(c.issuer).map(([k, val]) => `${k}=${val}`).join(', ')
  const built = v.chain
  for (let i = built.length - 1; i >= 0; i--) {
    lines.push(`depth=${i} ${fmt(built[i])}`)
    if (v.code !== 'ok' && i === v.depth) {
      const [n, msg] = v.code === 'hostname' ? [62, 'hostname mismatch'] : OPENSSL_ERR[v.code as keyof typeof OPENSSL_ERR]
      lines.push(`verify error:num=${n}:${msg}`)
    }
    lines.push('verify return:1')
  }
  let finalCode = 0
  let finalMsg = 'ok'
  if (v.code !== 'ok') {
    const [n, msg] = v.code === 'hostname' ? [62, 'hostname mismatch'] : OPENSSL_ERR[v.code as keyof typeof OPENSSL_ERR]
    finalCode = n
    finalMsg = msg
    if (v.code === 'issuer' && v.depth === 0) {
      lines.push(`depth=0 ${fmt(chain[0])}`, 'verify error:num=21:unable to verify the first certificate', 'verify return:1')
      finalCode = 21
      finalMsg = 'unable to verify the first certificate'
    }
  }
  lines.push('---', 'Certificate chain')
  chain.forEach((c, i) => {
    lines.push(` ${i} s:${fmt(c)}`, `   i:${fmtI(c)}`, `   a:PKEY: ${c.keyAlg === 'EC' ? 'id-ecPublicKey' : 'rsaEncryption'}, ${c.keyBits} (bit); sigalg: ${c.sigAlg.startsWith('ecdsa') ? 'ecdsa-with-SHA384' : 'RSA-SHA256'}`, `   v:NotBefore: ${gmt(c.notBefore)}; NotAfter: ${gmt(c.notAfter)}`)
    if (o.flags.has('-showcerts')) lines.push(toPem(c).trimEnd())
  })
  lines.push('---', 'Server certificate')
  if (!o.flags.has('-showcerts')) lines.push(toPem(chain[0]).trimEnd())
  lines.push(`subject=${fmt(chain[0])}`, `issuer=${fmtI(chain[0])}`, '---', 'No client certificate CA names sent', `Peer signing digest: SHA256`, `Peer signature type: ${chain[0].keyAlg === 'EC' ? 'ECDSA' : 'rsa_pss_rsae_sha256'}`, `Negotiated TLS1.3 group: X25519MLKEM768`, '---', `SSL handshake has read ${2400 + chain.length * 1300} bytes and written 1612 bytes`, `Verification${finalCode ? ' error' : ''}: ${finalMsg === 'ok' ? 'OK' : finalMsg}`, '---', `New, ${proto}, Cipher is ${proto === 'TLSv1.3' ? 'TLS_AES_256_GCM_SHA384' : 'ECDHE-RSA-AES256-GCM-SHA384'}`, `Protocol: ${proto}`, `Server public key is ${chain[0].keyBits} bit`, 'This TLS version forbids renegotiation.', 'Compression: NONE', 'Expansion: NONE', 'No ALPN negotiated', 'Early data was not sent', `Verify return code: ${finalCode} (${finalMsg})`, '---', 'DONE')
  ctx.out(lines.join('\n') + '\n')
  return 0
}

function pkcs12(ctx: CommandContext, o: ReturnType<typeof opts>): number {
  if (o.flags.has('-export')) {
    const cert = loadCert(ctx, one(o, '-in'))
    const key = loadKey(ctx, one(o, '-inkey'))
    if (!cert || !key) return 1
    if (key.id !== cert.keyId) {
      ctx.err('No certificate matches private key\n')
      return 1
    }
    const chain: CertData[] = []
    if (one(o, '-certfile')) {
      try {
        chain.push(...certsIn(ctx.sys.vfs.readFile(ctx.sh.resolve(one(o, '-certfile')!), ctx.sh.cred)))
      } catch {
        ctx.err(`Could not open file or uri for loading certificates from ${one(o, '-certfile')}\n`)
        return 1
      }
    }
    const pass = (one(o, '-passout') ?? one(o, '-password') ?? '').replace(/^pass:/, '')
    if (!one(o, '-passout') && !one(o, '-password')) ctx.err('Enter Export Password:\nVerifying - Enter Export Password:\n[simulador] Contraseña vacía; en el laboratorio real conviene usar una (-passout pass:...).\n')
    const blob = P12 + btoa(unescape(encodeURIComponent(JSON.stringify({ cert, key, chain, pass }))))
    if (!one(o, '-out')) {
      ctx.err('[simulador] PKCS#12 es binario: guardalo con -out archivo.pfx.\n')
      return 1
    }
    return writeOut(ctx, one(o, '-out'), blob, 0o600) ? 0 : 1
  }
  const text = readIn(ctx, one(o, '-in'), 'pkcs12')
  if (text === undefined) return 1
  if (!text.startsWith(P12)) {
    ctx.err('Could not read PKCS12 file\n')
    return 1
  }
  const data = JSON.parse(decodeURIComponent(escape(atob(text.slice(P12.length))))) as { cert: CertData; key: KeyData; chain: CertData[]; pass: string }
  const given = (one(o, '-passin') ?? one(o, '-password') ?? '').replace(/^pass:/, '')
  if (data.pass && given !== data.pass) {
    ctx.err('Mac verify error: invalid password?\n')
    return 1
  }
  if (o.flags.has('-info')) ctx.err('MAC: sha256, Iteration 2048\nMAC length: 32, salt length: 8\nPKCS7 Encrypted data: PBES2, PBKDF2, AES-256-CBC, Iteration 2048, PRF hmac-sha256\nCertificate bag\nPKCS7 Data\nShrouded Keybag: PBES2, PBKDF2, AES-256-CBC, Iteration 2048, PRF hmac-sha256\n')
  let out = ''
  if (!o.flags.has('-nokeys')) out += `Bag Attributes\n    localKeyID: ${hashHex(data.key.id, 40).toUpperCase().match(/.{2}/g)?.join(' ')}\n${toPem({ ...data.key, enc: !(o.flags.has('-nodes') || o.flags.has('-noenc')) })}`
  if (!o.flags.has('-nocerts')) for (const c of [data.cert, ...(o.flags.has('-clcerts') ? [] : data.chain)]) out += `subject=${dnString(c.subject)}\nissuer=${dnString(c.issuer)}\n${toPem(c)}`
  return writeOut(ctx, one(o, '-out'), out, 0o600) ? 0 : 1
}

// ---------------------------------------------------------------------------------------
// Hashes, firmas y cifrado simétrico
// ---------------------------------------------------------------------------------------

const DIGESTS: Record<string, { algo: string; name: string }> = {
  md5: { algo: 'MD5', name: 'MD5' },
  sha1: { algo: 'SHA-1', name: 'SHA1' },
  sha256: { algo: 'SHA-256', name: 'SHA2-256' },
  sha384: { algo: 'SHA-384', name: 'SHA2-384' },
  sha512: { algo: 'SHA-512', name: 'SHA2-512' },
}
const SIG = 'SIMSIG1:'

function readFileArg(ctx: CommandContext, f: string): string | undefined {
  try {
    return ctx.sys.vfs.readFile(ctx.sh.resolve(f), ctx.sh.cred)
  } catch {
    ctx.err(`Could not open file or uri for loading ${f}\n`)
    return undefined
  }
}

/** openssl dgst: el hash de un archivo, o firmarlo (-sign) y verificar la firma (-verify). */
async function dgst(ctx: CommandContext, sub: string, o: ReturnType<typeof opts>): Promise<number> {
  const key = sub === 'dgst' ? (Object.keys(DIGESTS).find((k) => o.flags.has(`-${k}`)) ?? 'sha256') : sub
  const d = DIGESTS[key]
  const files = o.rest.length ? o.rest : ['-']
  const content = (f: string) => (f === '-' ? ctx.stdin.readAll() : readFileArg(ctx, f))
  const signWith = one(o, '-sign')
  const verifyWith = one(o, '-verify') ?? one(o, '-prverify')
  if (signWith) {
    const k = loadKey(ctx, signWith)
    const text = content(files[0])
    if (!k || text === undefined) return 1
    const sig = SIG + JSON.stringify({ k: k.id, d: await digest(d.algo, text) })
    const out = one(o, '-out')
    if (!out) {
      ctx.out(sig + '\n')
      return 0
    }
    return writeOut(ctx, out, sig) ? 0 : 1
  }
  if (verifyWith) {
    const keyText = readIn(ctx, verifyWith, 'pkey')
    if (keyText === undefined) return 1
    const pub = one(o, '-prverify') ? keyIn(keyText) : (pubIn(keyText) ?? keyIn(keyText))
    if (!pub) {
      ctx.err(`Could not find public key from ${verifyWith}\nUnable to load public key\n`)
      return 1
    }
    const sigFile = one(o, '-signature')
    if (!sigFile) {
      ctx.err('No signature to verify: use the -signature option\n')
      return 1
    }
    const sigText = readFileArg(ctx, sigFile)
    const text = content(files[0])
    if (sigText === undefined || text === undefined) return 1
    let ok = false
    if (sigText.startsWith(SIG)) {
      try {
        const s = JSON.parse(sigText.slice(SIG.length)) as { k: string; d: string }
        ok = s.k === pub.id && s.d === (await digest(d.algo, text))
      } catch {
        ok = false
      }
    }
    if (ok) {
      ctx.out('Verified OK\n')
      return 0
    }
    ctx.out('Verification failure\n')
    if (pub.alg === 'RSA') ctx.err(`${hashHex('v', 12).toUpperCase()}:error:02000068:rsa routines:ossl_rsa_verify:bad signature:../crypto/rsa/rsa_sign.c:442:\n`)
    return 1
  }
  for (const f of files) {
    const text = content(f)
    if (text === undefined) return 1
    ctx.out(`${d.name}(${f === '-' ? 'stdin' : f})= ${await digest(d.algo, text)}\n`)
  }
  return 0
}

const ENC = 'Salted__SIMENC1:'

/** openssl enc: cifrado simétrico con contraseña (-pass pass:...), y -d para descifrar. */
async function enc(ctx: CommandContext, o: ReturnType<typeof opts>): Promise<number> {
  const cipher = [...o.flags].find((f) => /^-(aes|chacha|camellia|des)/i.test(f))?.slice(1)
  if (!cipher) {
    ctx.err('[simulador] Elegí el algoritmo, por ejemplo: openssl enc -aes-256-cbc -pbkdf2 -in archivo -out archivo.enc\n')
    return 1
  }
  if (/^des/i.test(cipher)) {
    ctx.err(`enc: Unknown option or cipher: ${cipher}\n[simulador] DES ya no viene habilitado en OpenSSL 3: está roto hace décadas. Usá -aes-256-cbc.\n`)
    return 1
  }
  const passArg = one(o, '-pass') ?? (one(o, '-k') !== undefined ? `pass:${one(o, '-k')}` : undefined)
  let pass: string | undefined
  if (passArg?.startsWith('pass:')) pass = passArg.slice(5)
  else if (passArg?.startsWith('file:')) pass = readFileArg(ctx, passArg.slice(5))?.split('\n')[0]
  else if (passArg?.startsWith('env:')) pass = ctx.sh.getVar(passArg.slice(4)) ?? ''
  if (pass === undefined) {
    ctx.err(`enter ${cipher.toUpperCase()} ${o.flags.has('-d') ? 'decryption' : 'encryption'} password:\n[simulador] En el simulador la contraseña va con -pass pass:LaContraseña (en un servidor real, mejor que la pida: así no queda en el historial).\n`)
    return 1
  }
  const strong = o.flags.has('-pbkdf2') || o.vals.has('-iter')
  const input = readIn(ctx, one(o, '-in'), 'enc')
  if (input === undefined) return 1
  const b64 = o.flags.has('-a') || o.flags.has('-base64')
  if (o.flags.has('-d')) {
    const raw = b64 ? (() => { try { return atob(input.replace(/\s+/g, '')) } catch { return '' } })() : input
    let data: { p: string; c: string; k: boolean; x: string } | undefined
    if (raw.startsWith(ENC)) {
      try {
        data = JSON.parse(raw.slice(ENC.length))
      } catch {
        data = undefined
      }
    }
    if (!data) {
      ctx.err('bad magic number\n')
      return 1
    }
    if (!strong && data.k) ctx.err('*** WARNING : deprecated key derivation used.\nUsing -iter or -pbkdf2 would be better.\n')
    if (data.p !== (await digest('SHA-256', `pass:${pass}`)) || data.c !== cipher.toLowerCase() || data.k !== strong) {
      ctx.err(`bad decrypt\n${hashHex('d', 12).toUpperCase()}:error:1C800064:Provider routines:ossl_cipher_unpadblock:bad decrypt:../providers/implementations/ciphers/ciphercommon_block.c:107:\n`)
      return 1
    }
    const plain = decodeURIComponent(escape(atob(data.x)))
    return writeOut(ctx, one(o, '-out'), plain, 0o644) ? 0 : 1
  }
  if (!strong) ctx.err('*** WARNING : deprecated key derivation used.\nUsing -iter or -pbkdf2 would be better.\n')
  const blob = ENC + JSON.stringify({ p: await digest('SHA-256', `pass:${pass}`), c: cipher.toLowerCase(), k: strong, x: btoa(unescape(encodeURIComponent(input))) })
  const out = b64 ? btoa(blob).replace(/.{64}/g, '$&\n') + '\n' : blob
  return writeOut(ctx, one(o, '-out'), out, 0o644) ? 0 : 1
}

register('trust', {
  usage: 'trust list [--filter=ca-anchors]',
  run(ctx) {
    if (ctx.args[0] !== 'list') {
      ctx.err('usage: trust command <args>...\n\nCommon trust commands are:\n  list             List trust or certificates\n  extract          Extract certificates and trust\n  anchor           Add, remove, change trust anchors\n')
      return 2
    }
    let out = ''
    for (const c of trustedRoots(ctx.sys)) {
      out += `pkcs11:id=%${fingerprint(c, 'sha1').split(':').slice(0, 20).join('%')};type=cert\n    type: certificate\n    label: ${c.subject.CN ?? c.subject.O ?? ''}\n    trust: anchor\n    category: authority\n\n`
    }
    ctx.out(out)
    return 0
  },
})

register('openssl', {
  usage: 'openssl genpkey | req | x509 | verify | s_client | pkcs12 | rand | dgst | version',
  run(ctx) {
    const [sub, ...rest] = ctx.args
    const o = opts(rest)
    switch (sub) {
      case 'version':
        ctx.out(ctx.sys.distro === 'rocky' ? 'OpenSSL 3.5.1 1 Jul 2025 (Library: OpenSSL 3.5.1 1 Jul 2025)\n' : 'OpenSSL 3.5.5 27 Jan 2026 (Library: OpenSSL 3.5.5 27 Jan 2026)\n')
        return 0
      case 'rand': {
        const n = Number(o.rest[0] ?? 0)
        const bytes = Array.from({ length: n }, () => Math.floor(Math.random() * 256))
        ctx.out((o.flags.has('-hex') ? bytes.map((b) => b.toString(16).padStart(2, '0')).join('') : btoa(String.fromCharCode(...bytes))) + '\n')
        return 0
      }
      case 'genrsa':
        return genKey(ctx, 'RSA', Number(o.rest[0] ?? 2048), one(o, '-out'), o.flags.has('-aes256'))
      case 'genpkey': {
        const alg = (one(o, '-algorithm') ?? 'RSA').toUpperCase()
        const pk = o.vals.get('-pkeyopt') ?? []
        if (!['RSA', 'EC', 'ED25519', 'RSA-PSS'].includes(alg)) {
          ctx.err(`genpkey: Error initializing ${alg} context\n`)
          return 1
        }
        const bits = Number(pk.find((p) => p.startsWith('rsa_keygen_bits'))?.split(':')[1] ?? 2048)
        if (alg === 'EC' && !pk.some((p) => p.startsWith('ec_paramgen_curve'))) {
          ctx.err('genpkey: Error generating EC key\n[simulador] Con EC hay que elegir la curva: -pkeyopt ec_paramgen_curve:P-256\n')
          return 1
        }
        return genKey(ctx, alg === 'EC' ? 'EC' : alg === 'ED25519' ? 'ED25519' : 'RSA', bits, one(o, '-out'), o.flags.has('-aes256') || o.flags.has('-aes-256-cbc'))
      }
      case 'req':
        return opensslReq(ctx, o)
      case 'x509':
        return opensslX509(ctx, o)
      case 'verify':
        return opensslVerify(ctx, o)
      case 's_client':
        return sClient(ctx, o)
      case 'pkcs12':
        return pkcs12(ctx, o)
      case 'rsa':
      case 'pkey':
      case 'ec': {
        const k = loadKey(ctx, one(o, '-in'))
        if (!k) return 1
        let out = ''
        if (o.flags.has('-check')) out += k.alg === 'RSA' ? 'RSA key ok\n' : 'Key is valid\n'
        if (o.flags.has('-modulus')) out += `Modulus=${modulus(k.id)}\n`
        if (o.flags.has('-text')) out += `Private-Key: (${k.bits} bit${k.alg === 'RSA' ? ', 2 primes' : ''})\n`
        if (o.flags.has('-pubout')) out += toPem({ t: 'pub', id: k.id, alg: k.alg, bits: k.bits })
        else if (!o.flags.has('-noout')) out += toPem(k)
        return writeOut(ctx, one(o, '-out'), out, 0o600) ? 0 : 1
      }
      case 'dgst':
      case 'sha256':
      case 'sha1':
      case 'sha512':
      case 'md5':
        return dgst(ctx, sub, o)
      case 'enc':
        return enc(ctx, o)
      case 'x509v3':
      case 'ca':
        ctx.err(`[simulador] openssl ${sub} no está simulado: para firmar con tu CA usá openssl x509 -req -in pedido.csr -CA ca.crt -CAkey ca.key.\n`)
        return 1
      case undefined:
      case 'help':
        ctx.err('help:\n\nStandard commands\nca  crl  dgst  ec  enc  genpkey  genrsa  pkcs12  pkey  rand  req  rsa  s_client  verify  version  x509\n')
        return sub ? 0 : 1
      default:
        ctx.err(`Invalid command '${sub}'; type "help" for a list.\n`)
        return 1
    }
  },
})

// ---------------------------------------------------------------------------------------
// Almacén de confianza
// ---------------------------------------------------------------------------------------

register('update-ca-trust', {
  usage: 'update-ca-trust [extract]',
  path: '/usr/bin',
  run(ctx) {
    if (ctx.sys.distro !== 'rocky') {
      ctx.err(`bash: update-ca-trust: command not found\n[simulador] En Ubuntu es update-ca-certificates (y el archivo va en ${anchorsDir(ctx.sys)} con extensión .crt).\n`)
      return 127
    }
    if (ctx.sh.user !== 'root') {
      ctx.err('p11-kit: couldn\'t create directory: /etc/pki/ca-trust/extracted/pem/directory-hash: Permission denied\n')
      return 1
    }
    rebuildTrustStore(ctx.sys)
    return 0
  },
})

register('update-ca-certificates', {
  usage: 'update-ca-certificates',
  path: '/usr/sbin',
  run(ctx) {
    if (ctx.sys.distro !== 'ubuntu') {
      ctx.err(`bash: update-ca-certificates: command not found\n[simulador] En Rocky es update-ca-trust (y el archivo va en ${anchorsDir(ctx.sys)}).\n`)
      return 127
    }
    if (ctx.sh.user !== 'root') {
      ctx.err('Updating certificates in /etc/ssl/certs...\nln: failed to create symbolic link: Permission denied\n')
      return 1
    }
    const before = (() => {
      try {
        return certsIn(ctx.sys.vfs.readFile(bundlePath(ctx.sys), ROOT_CRED)).length
      } catch {
        return 0
      }
    })()
    const r = rebuildTrustStore(ctx.sys)
    const after = certsIn(ctx.sys.vfs.readFile(bundlePath(ctx.sys), ROOT_CRED)).length
    for (const f of r.ignored) ctx.err(`[simulador] ${anchorsDir(ctx.sys)}/${f} se ignora: tiene que terminar en .crt\n`)
    ctx.out(`Updating certificates in /etc/ssl/certs...\n${Math.max(0, after - before)} added, ${Math.max(0, before - after)} removed; done.\nRunning hooks in /etc/ca-certificates/update.d...\ndone.\n`)
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// certbot
// ---------------------------------------------------------------------------------------

const DONATE = `- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
If you like Certbot, please consider supporting our work by:
 * Donating to ISRG / Let's Encrypt:   https://letsencrypt.org/donate
 * Donating to EFF:                    https://eff.org/donate-le
- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
`

function hasAccount(ctx: CommandContext, staging: boolean): boolean {
  return ctx.sys.vfs.exists(`${LE_DIR}/accounts/acme-${staging ? 'staging-' : ''}v02.api.letsencrypt.org`)
}

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Agrega HTTPS al server de nginx que tiene ese nombre (lo que hace el instalador de certbot). */
function installNginx(ctx: CommandContext, l: Lineage, redirect: boolean): string | undefined {
  const sys = ctx.sys
  const dirs = sys.distro === 'rocky' ? ['/etc/nginx/conf.d', '/etc/nginx'] : ['/etc/nginx/sites-enabled', '/etc/nginx/conf.d', '/etc/nginx']
  const files: string[] = []
  for (const d of dirs) {
    if (!sys.vfs.exists(d)) continue
    for (const f of sys.vfs.readdir(d, ROOT_CRED)) {
      const p = `${d}/${f}`
      try {
        if (sys.vfs.stat(p, ROOT_CRED).type === 'file' && (d === '/etc/nginx' ? f === 'nginx.conf' : true)) files.push(p)
      } catch {
        // enlace roto
      }
    }
  }
  for (const f of files) {
    const text = sys.vfs.readFile(f, ROOT_CRED)
    const re = new RegExp(`server_name\\s+[^;]*\\b${l.domains[0].replace(/\./g, '\\.')}\\b[^;]*;`)
    const m = re.exec(text)
    if (!m) continue
    // Encontrar el bloque server { ... } que contiene ese server_name.
    let start = text.lastIndexOf('server', m.index)
    while (start >= 0 && !/^server\s*\{/.test(text.slice(start))) start = text.lastIndexOf('server', start - 1)
    if (start < 0) continue
    let depth = 0
    let end = -1
    for (let i = text.indexOf('{', start); i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end < 0) continue
    const block = text.slice(start, end)
    const live = `${LE_DIR}/live/${l.name}`
    // Ya instalado: no se repite nada (certbot reinstala sin duplicar).
    if (block.includes(`ssl_certificate ${live}/fullchain.pem`)) return f
    const ssl = `\n    listen 443 ssl; # managed by Certbot\n    ssl_certificate ${live}/fullchain.pem; # managed by Certbot\n    ssl_certificate_key ${live}/privkey.pem; # managed by Certbot\n    include ${LE_DIR}/options-ssl-nginx.conf; # managed by Certbot\n    ssl_dhparam ${LE_DIR}/ssl-dhparams.pem; # managed by Certbot\n`
    const newBlock = block.replace(/\n(\s*)listen\s+80[^;]*;\s*\n/g, '\n').replace(/\n(\s*)listen\s+\[::\]:80[^;]*;\s*\n/g, '\n') + ssl
    let out = text.slice(0, start) + newBlock + text.slice(end)
    if (redirect && !out.includes(`if ($host = ${l.domains[0]})`)) out += `\nserver {\n    if ($host = ${l.domains[0]}) {\n        return 301 https://$host$request_uri;\n    } # managed by Certbot\n\n    listen 80;\n    server_name ${l.domains.join(' ')};\n    return 404; # managed by Certbot\n}\n`
    sys.vfs.writeFile(f, out, ROOT_CRED)
    if (!sys.vfs.exists(`${LE_DIR}/options-ssl-nginx.conf`)) sys.vfs.writeFile(`${LE_DIR}/options-ssl-nginx.conf`, '# This file contains important security parameters. If you modify this file\n# manually, Certbot will be unable to automatically provide future security\n# updates. Instead, Certbot will print and log an error message with a path to\n# the up-to-date file that you will need to refer to when manually updating\n# this file. Contents are based on https://ssl-config.mozilla.org\n\nssl_session_cache shared:le_nginx_SSL:10m;\nssl_session_timeout 1440m;\nssl_session_tickets off;\n\nssl_protocols TLSv1.2 TLSv1.3;\nssl_prefer_server_ciphers off;\n\nssl_ciphers "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305";\n', ROOT_CRED)
    if (!sys.vfs.exists(`${LE_DIR}/ssl-dhparams.pem`)) sys.vfs.writeFile(`${LE_DIR}/ssl-dhparams.pem`, `-----BEGIN DH PARAMETERS-----\n${hashHex('dh', 64)}\n-----END DH PARAMETERS-----\n`, ROOT_CRED)
    return f
  }
  return undefined
}

function reloadNginx(ctx: CommandContext) {
  // El instalador de nginx recarga el servicio al terminar.
  if (ctx.sys.services.get('nginx')?.active) nginxStartCheck(ctx.sys)
}

register('certbot', {
  usage: 'certbot certonly --webroot -w RUTA -d DOMINIO | certbot --nginx -d DOMINIO | certbot renew [--dry-run] | certbot certificates',
  async run(ctx) {
    const a = ctx.args
    if (a.includes('--version')) {
      ctx.out(`certbot ${ctx.sys.distro === 'rocky' ? '4.1.1' : '4.0.0'}\n`)
      return 0
    }
    if (ctx.sh.user !== 'root') {
      ctx.err("The following error was encountered:\n[Errno 13] Permission denied: '/var/log/letsencrypt/.certbot.lock'\nEither run as root, or set --config-dir, --work-dir, and --logs-dir to writeable paths.\n")
      return 1
    }
    ctx.err('Saving debug log to /var/log/letsencrypt/letsencrypt.log\n')
    const sys = ctx.sys
    const sub = a.find((x) => !x.startsWith('-') && ['certonly', 'renew', 'certificates', 'delete', 'install', 'run'].includes(x))
    const domains: string[] = []
    let webroot: string | undefined
    let certName: string | undefined
    let hook: string | undefined
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-d' || a[i] === '--domains' || a[i] === '--domain') domains.push(...(a[++i] ?? '').split(',').filter(Boolean))
      else if (a[i].startsWith('--domains=')) domains.push(...a[i].slice(10).split(','))
      else if (a[i] === '-w' || a[i] === '--webroot-path') webroot = a[++i]
      else if (a[i] === '--cert-name') certName = a[++i]
      else if (a[i] === '--deploy-hook' || a[i] === '--renew-hook') hook = a[++i]
    }
    const staging = a.includes('--staging') || a.includes('--test-cert')
    const dry = a.includes('--dry-run')
    const plugin = a.includes('--nginx') ? 'nginx' : a.includes('--webroot') || webroot ? 'webroot' : a.includes('--standalone') ? 'standalone' : undefined
    if (plugin === 'nginx' && !sys.installed.has('python3-certbot-nginx')) {
      ctx.err(`The requested nginx plugin does not appear to be installed\n[simulador] Instalá el complemento: ${sys.distro === 'rocky' ? 'sudo dnf install python3-certbot-nginx' : 'sudo apt install python3-certbot-nginx'}\n`)
      return 1
    }

    if (sub === 'certificates') {
      const ls = lineages(sys)
      if (!ls.length) {
        ctx.out('- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -\nNo certificates found.\n- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -\n')
        return 0
      }
      let out = '- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -\nFound the following certs:\n'
      for (const l of ls) {
        const days = l.cert ? Math.floor((l.cert.notAfter - Date.now()) / 86_400_000) : 0
        out += `  Certificate Name: ${l.name}\n    Serial Number: ${l.cert?.serial.toLowerCase().slice(0, 36) ?? ''}\n    Key Type: ECDSA\n    Identifiers: ${l.domains.join(' ')}\n    Expiry Date: ${l.cert ? new Date(l.cert.notAfter).toISOString().replace('T', ' ').slice(0, 19) : ''}+00:00 (${days < 0 ? 'INVALID: EXPIRED' : `VALID: ${days} days`}${l.staging ? ', TEST_CERT' : ''})\n    Certificate Path: ${LE_DIR}/live/${l.name}/fullchain.pem\n    Private Key Path: ${LE_DIR}/live/${l.name}/privkey.pem\n`
      }
      ctx.out(out + '- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -\n')
      return 0
    }

    if (sub === 'delete') {
      const name = certName
      if (!name || !sys.vfs.exists(`${LE_DIR}/renewal/${name}.conf`)) {
        ctx.err(`No certificate found with name ${name ?? ''} (expected ${LE_DIR}/renewal/${name ?? ''}.conf).\n`)
        return 1
      }
      for (const d of [`${LE_DIR}/live/${name}`, `${LE_DIR}/archive/${name}`]) if (sys.vfs.exists(d)) sys.vfs.removeTree(d, ROOT_CRED)
      sys.vfs.unlink(`${LE_DIR}/renewal/${name}.conf`, ROOT_CRED)
      ctx.out(`- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -\nDeleted all files relating to certificate ${name}.\n- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -\n`)
      return 0
    }

    if (sub === 'renew') {
      const ls = lineages(sys)
      if (!ls.length) {
        ctx.out('No simulated renewals were attempted.\n')
        return 0
      }
      let failed = 0
      const lines: string[] = []
      for (const l of ls) {
        ctx.out(`\n- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -\nProcessing ${LE_DIR}/renewal/${l.name}.conf\n- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -\n`)
        const due = !l.cert || l.cert.notAfter - Date.now() < 30 * 86_400_000
        if (!dry && !due && !a.includes('--force-renewal')) {
          ctx.out(`Certificate not yet due for renewal\n`)
          lines.push(`  ${LE_DIR}/live/${l.name}/fullchain.pem expires on ${l.cert ? ymd(l.cert.notAfter) : ''} (skipped)`)
          continue
        }
        ctx.out(`${dry ? 'Simulating renewal of an existing certificate' : 'Renewing an existing certificate'} for ${l.domains.join(' and ')}\n`)
        const bad = l.domains.map((d) => ({ d, r: http01(sys, d, l.authenticator === 'webroot' ? l.webroot : undefined, l.authenticator === 'nginx') })).find((x) => !x.r.ok)
        if (bad && !bad.r.ok) {
          failed++
          ctx.out(`\nCertbot failed to authenticate some domains (authenticator: ${l.authenticator}). The Certificate Authority reported these problems:\n  Domain: ${bad.d}\n  Type:   ${bad.r.type}\n  Detail: ${bad.r.detail}\n\nFailed to renew certificate ${l.name} with error: Some challenges have failed.\n`)
          lines.push(`  ${LE_DIR}/live/${l.name}/fullchain.pem (failure)`)
          continue
        }
        if (dry) {
          lines.push(`  ${LE_DIR}/live/${l.name}/fullchain.pem (success)`)
          continue
        }
        writeLineage(sys, l, 90)
        lines.push(`  ${LE_DIR}/live/${l.name}/fullchain.pem (success)`)
        if (l.authenticator === 'nginx') reloadNginx(ctx)
        if (l.hook) {
          const code = (await ctx.sh.run(l.hook)).chunks
          void code
          ctx.out(`Running deploy-hook command: ${l.hook}\n`)
        }
      }
      ctx.out(`\n- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -\n${dry ? 'Congratulations, all simulated renewals succeeded: \n' : failed ? 'All renewals failed. The following certificates could not be renewed:\n' : 'Congratulations, all renewals succeeded: \n'}${lines.join('\n')}\n- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -\n`)
      if (failed && dry) return 1
      return failed ? 1 : 0
    }

    // Obtener (certonly o el modo instalador con --nginx)
    if (!domains.length) {
      ctx.err('[simulador] certbot pregunta los nombres; pasalos con -d (uno por nombre): certbot --nginx -d www.ejemplo.com -d ejemplo.com\n')
      return 1
    }
    if (!plugin) {
      ctx.err('[simulador] Elegí cómo validar: --nginx (certbot configura nginx) o --webroot -w /var/www/sitio (deja el archivo de prueba en la carpeta del sitio).\n')
      return 1
    }
    if (plugin === 'webroot' && !webroot) {
      ctx.err('Missing command line flag or config entry for this setting:\nInput the webroot for ' + domains[0] + ':\n[simulador] Indicá la carpeta del sitio con -w.\n')
      return 1
    }
    if (!hasAccount(ctx, staging)) {
      const email = a.includes('-m') || a.includes('--email') || a.some((x) => x.startsWith('--email=')) || a.includes('--register-unsafely-without-email')
      const tos = a.includes('--agree-tos')
      if (!email || !tos) {
        ctx.err('[simulador] La primera vez certbot pide un correo y que aceptes los términos. Agregá -m tu@correo --agree-tos (o -n para que no pregunte nada).\n')
        return 1
      }
      sys.vfs.mkdirp(`${LE_DIR}/accounts/acme-${staging ? 'staging-' : ''}v02.api.letsencrypt.org`, ROOT_CRED, 0o700)
      ctx.err('Account registered.\n')
    }
    ctx.out(`${dry ? 'Simulating a certificate request' : 'Requesting a certificate'} for ${domains.join(' and ')}\n`)
    for (const d of domains) {
      const r = http01(sys, d, plugin === 'webroot' ? webroot : undefined, plugin === 'nginx')
      if (!r.ok) {
        ctx.out(`\nCertbot failed to authenticate some domains (authenticator: ${plugin}). The Certificate Authority reported these problems:\n  Domain: ${d}\n  Type:   ${r.type}\n  Detail: ${r.detail}\n\nHint: ${plugin === 'webroot' ? 'The Certificate Authority failed to download the temporary challenge files created by Certbot. Ensure that the listed domains serve their content from the provided --webroot-path/-w and that files created there can be downloaded from the internet.' : "The Certificate Authority couldn't exterally verify that the nginx plugin completed the required http-01 challenges. Ensure the plugin is configured correctly and that the changes it makes are accessible from the internet."}\n\nSome challenges have failed.\nAsk for help or search for solutions at https://community.letsencrypt.org. See the logfile /var/log/letsencrypt/letsencrypt.log or re-run Certbot with -v for more details.\n`)
        return 1
      }
    }
    if (dry) {
      ctx.out('The dry run was successful.\n')
      return 0
    }
    const name = certName ?? domains[0]
    const existing = lineages(sys).find((l) => l.name === name)
    const l: Lineage = existing ?? { name, domains, staging, version: 0, authenticator: plugin === 'nginx' ? 'nginx' : plugin === 'webroot' ? 'webroot' : 'standalone', webroot, hook }
    l.domains = domains
    l.staging = staging
    if (hook) l.hook = hook
    const cert = writeLineage(sys, l, 90)
    const live = `${LE_DIR}/live/${name}`
    ctx.out(`\nSuccessfully received certificate.\nCertificate is saved at: ${live}/fullchain.pem\nKey is saved at:         ${live}/privkey.pem\nThis certificate expires on ${ymd(cert.notAfter)}.\nThese files will be updated when the certificate renews.\n`)
    const timer = sys.timers.get(sys.distro === 'rocky' ? 'certbot-renew' : 'certbot')
    if (timer?.enabled) ctx.out('Certbot has set up a scheduled task to automatically renew this certificate in the background.\n')
    if (plugin === 'nginx' && sub !== 'certonly') {
      ctx.out('\nDeploying certificate\n')
      const f = installNginx(ctx, l, !a.includes('--no-redirect'))
      if (!f) {
        ctx.out(`Could not install certificate\n\nNEXT STEPS:\n- The certificate was saved, but could not be installed (installer: nginx). After fixing the error shown below, try installing it again by running:\n  certbot install --cert-name ${name}\n\nCould not automatically find a matching server block for ${domains[0]}. Set the \`server_name\` directive to use the Nginx installer.\n`)
        return 1
      }
      for (const d of domains) ctx.out(`Successfully deployed certificate for ${d} to ${f}\n`)
      ctx.out(`Congratulations! You have successfully enabled HTTPS on ${domains.map((d) => `https://${d}`).join(' and ')}\n`)
      // Certbot recarga nginx.
      reloadNginx(ctx)
    }
    ctx.out('\n' + DONATE)
    return 0
  },
})

export { csrText, selfSigned, serialHex, parsePem, openSslVersion, web, issue }
