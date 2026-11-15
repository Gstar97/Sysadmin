/**
 * testssl.sh simplificado: protocolos, categorías de cifrados, certificado, encabezados y la
 * calificación final con las reglas principales (TLS viejos, cifrados débiles, HSTS, confianza).
 */
import { fetchHttp, parseUrl } from '../http'
import { register } from '../shell'

const W = 50

function pad(label: string, width = 29): string {
  return ` ${label.padEnd(width)}`
}

/** ¿El servidor ofrece cifrados CBC (obsoletos) o débiles (3DES, RC4) en TLS 1.2 o anteriores? */
function cipherCategories(ciphers: string | undefined): { cbc: boolean; weak: boolean } {
  const list = (ciphers ?? 'HIGH:!aNULL:!MD5').split(':').filter(Boolean)
  const on = list.filter((t) => !t.startsWith('!') && !t.startsWith('-'))
  const broad = (t: string) => /^(HIGH|ALL|DEFAULT|MEDIUM|AES|AES128|AES256|SHA1|SHA256|SHA384|kEECDH|EECDH|EDH|kEDH|ECDHE|DHE|RSA)$/i.test(t)
  const cbc = on.some((t) => broad(t) || (/-(SHA|SHA256|SHA384)$/i.test(t) && !/GCM|CHACHA|POLY|CCM/i.test(t)))
  const weak = on.some((t) => /3DES|DES-CBC3|RC4|^MEDIUM$|^LOW$|EXPORT|^NULL$|^ALL$/i.test(t)) && !list.includes('!3DES') && !list.includes('!RC4')
  return { cbc, weak }
}

register(['testssl', 'testssl.sh'], {
  usage: 'testssl [--quiet] URI   (por ejemplo: testssl https://www.ejemplo.com)',
  run(ctx) {
    const target = ctx.args.filter((a) => !a.startsWith('-')).at(-1)
    if (!target) {
      ctx.err('\n Fatal error: URI missing\n\n[simulador] Uso: testssl https://sitio.ejemplo.com\n')
      return 1
    }
    const u = parseUrl(/^https?:\/\//i.test(target) ? target : `https://${target}`)
    if (!u) {
      ctx.err(`\n Fatal error: "${target}" is not a valid URI\n`)
      return 1
    }
    const url = `https://${u.host}:${u.port}/`
    const base = fetchHttp(ctx.sys, url, { insecure: true, tlsMin: 'TLSv1', tlsMax: 'TLSv1.3' })
    const now = new Date()
    const stamp = now.toISOString().replace('T', ' ').slice(0, 19)
    let out = ''
    if (!ctx.args.includes('--quiet')) {
      out += '\n###########################################################\n    testssl       3.2.1 from https://testssl.sh/\n\n      This program is free software. Distribution and\n             modification under GPLv2 permitted.\n      USAGE w/o ANY WARRANTY. USE IT AT YOUR OWN RISK!\n\n       Please file bugs @ https://testssl.sh/bugs/\n\n###########################################################\n\n'
    }
    if (!base.ok && base.stage !== 'verify') {
      if (base.stage === 'resolve') {
        ctx.out(out)
        ctx.err(`\n Fatal error: No IPv4/IPv6 address(es) for "${u.host}" available\n`)
        return 1
      }
      ctx.out(out)
      ctx.err(`\n Fatal error: Can't connect to "${base.ip ?? u.host}:${u.port}"\n Make sure a firewall is not between you and your scanning target!\n`)
      return 1
    }
    if (!base.ok || !base.tls) {
      ctx.out(out)
      ctx.err(`\n Fatal error: ${u.host}:${u.port} doesn't seem to be a TLS/SSL enabled server\n`)
      return 1
    }
    const ip = base.ip
    out += ` Start ${stamp}        -->> ${ip}:${u.port} (${u.host}) <<--\n\n rDNS (${ip}):     --\n Service detected:       HTTP\n\n\n`

    // Protocolos: se prueba cada versión por separado.
    const offered = (p: string) => fetchHttp(ctx.sys, url, { insecure: true, tlsMin: p, tlsMax: p }).ok
    const t10 = offered('TLSv1')
    const t11 = offered('TLSv1.1')
    const t12 = offered('TLSv1.2')
    const t13 = offered('TLSv1.3')
    const h2 = base.tls.h2
    out += ' Testing protocols via sockets except NPN+ALPN \n\n'
    out += ' SSLv2      not offered (OK)\n SSLv3      not offered (OK)\n'
    out += ` TLS 1      ${t10 ? 'offered (deprecated)' : 'not offered'}\n`
    out += ` TLS 1.1    ${t11 ? 'offered (deprecated)' : 'not offered'}\n`
    out += ` TLS 1.2    ${t12 ? 'offered (OK)' : 'not offered'}\n`
    out += ` TLS 1.3    ${t13 ? 'offered (OK): final' : 'not offered and downgraded to a weaker protocol'}\n`
    out += ` NPN/SPDY   not offered\n ALPN/HTTP2 ${h2 ? 'h2, http/1.1 (offered)' : 'http/1.1 (offered)'}\n\n`

    // Cifrados (solo cuentan en TLS 1.2 o anteriores: TLS 1.3 tiene sus propios, todos fuertes).
    const legacy = t10 || t11 || t12
    const { cbc, weak } = legacy ? cipherCategories(base.tls.cipherConf) : { cbc: false, weak: false }
    out += ' Testing cipher categories \n\n'
    out += `${' NULL ciphers (no encryption)'.padEnd(W)}not offered (OK)\n`
    out += `${' Anonymous NULL Ciphers (no authentication)'.padEnd(W)}not offered (OK)\n`
    out += `${' Export ciphers (w/o ADH+NULL)'.padEnd(W)}not offered (OK)\n`
    out += `${' LOW: 64 Bit + DES, RC[2,4], MD5 (w/o export)'.padEnd(W)}${weak ? 'offered (NOT ok)' : 'not offered (OK)'}\n`
    out += `${' Triple DES Ciphers / IDEA'.padEnd(W)}${weak ? 'offered' : 'not offered'}\n`
    out += `${' Obsoleted CBC ciphers (AES, ARIA etc.)'.padEnd(W)}${cbc ? 'offered' : 'not offered'}\n`
    out += `${' Strong encryption (AEAD ciphers) with no FS'.padEnd(W)}${cbc ? 'offered (OK)' : 'not offered'}\n`
    out += `${' Forward Secrecy strong encryption (AEAD ciphers)'.padEnd(W)}offered (OK)\n\n`

    // Certificado.
    const leaf = base.tls.chain[0]
    const v = base.tls.verify
    const days = leaf ? Math.floor((leaf.notAfter - now.getTime()) / 86_400_000) : 0
    const fmt = (t: number) => new Date(t).toISOString().replace('T', ' ').slice(0, 16)
    const trustMsg: Record<string, string> = {
      ok: 'Ok',
      expired: 'NOT ok (expired)',
      not_yet: 'NOT ok (not yet valid)',
      self_signed: 'NOT ok (self signed)',
      self_signed_chain: 'NOT ok (self signed CA in chain)',
      issuer: 'NOT ok (chain incomplete)',
      hostname: 'Ok',
    }
    const issuerCn = leaf?.issuer.CN ?? '?'
    const issuerO = `${leaf?.issuer.O ?? issuerCn}${leaf?.issuer.C ? ` from ${leaf.issuer.C}` : ''}`
    out += ' Testing server defaults (Server Hello) \n\n'
    out += `${pad('TLS clock skew')}Random values, no fingerprinting possible\n`
    out += `${pad('Server Certificate #1')}\n`
    out += `   ${'Signature Algorithm'.padEnd(27)}${leaf?.sigAlg.startsWith('ecdsa') ? 'ECDSA with SHA256' : 'SHA256 with RSA'}\n`
    out += `   ${'Common Name (CN)'.padEnd(27)}${leaf?.subject.CN ?? '--'}\n`
    out += `   ${'subjectAltName (SAN)'.padEnd(27)}${leaf?.san.map((s) => s.replace(/^DNS:/, '')).join(' ') ?? '--'}\n`
    out += `   ${'Trust (hostname)'.padEnd(27)}${v.code === 'hostname' ? `certificate does not match supplied URI (${u.host})` : 'Ok via SAN'}\n`
    out += `   ${'Chain of trust'.padEnd(27)}${trustMsg[v.code] ?? 'NOT ok'}\n`
    out += `   ${'Certificate Validity (UTC)'.padEnd(27)}${days < 0 ? `expired (${fmt(leaf!.notBefore)} --> ${fmt(leaf!.notAfter)})` : `${days} ${days >= 30 ? '>=' : '<'} 30 days (${fmt(leaf!.notBefore)} --> ${fmt(leaf!.notAfter)})`}\n`
    out += `   ${'# of certificates provided'.padEnd(27)}${base.tls.chain.length}\n`
    out += `   ${'Issuer'.padEnd(27)}${issuerCn} (${issuerO})\n\n`

    // Encabezados HTTP.
    const res = base.res
    const hdr = (n: string) => res.headers.find(([k]) => k.toLowerCase() === n)?.[1]
    const hsts = hdr('strict-transport-security')
    const maxAge = Number(/max-age=(\d+)/i.exec(hsts ?? '')?.[1] ?? 0)
    out += ' Testing HTTP header response @ "/" \n\n'
    out += `${pad('HTTP Status Code')}${res.status} ${res.status === 200 ? 'OK' : ''}\n`
    out += `${pad('Strict Transport Security')}${hsts ? `${Math.round(maxAge / 86400)} days=${maxAge} s, ${/includesubdomains/i.test(hsts) ? 'includeSubDomains' : 'just this domain'}${/preload/i.test(hsts) ? ', preload' : ''}` : 'not offered'}\n`
    out += `${pad('Server banner')}${hdr('server') ?? '(no "Server" line in header, interesting!)'}\n`
    const sec = ['x-content-type-options', 'x-frame-options', 'content-security-policy', 'referrer-policy'].filter((h) => hdr(h))
    out += `${pad('Security headers')}${sec.length ? sec.map((h) => `${h.replace(/(^|-)\w/g, (c) => c.toUpperCase())}: ${hdr(h)}`).join('\n' + ' '.repeat(30)) : '--'}\n\n`

    // Calificación.
    const caps: [string, string][] = []
    if (v.code !== 'ok') caps.push(['T', v.code === 'hostname' ? 'Domain name mismatch' : v.code === 'expired' ? 'Certificate expired' : v.code === 'issuer' ? 'Issues with the chain of trust (chain incomplete)' : 'Issues with the chain of trust (self signed)'])
    if (weak) caps.push(['C', 'Weak ciphers (3DES, RC4) offered'])
    if (t10 || t11) caps.push(['B', 'TLS 1.1 offered'.replace('1.1', t10 ? '1.0' : '1.1')])
    if (!hsts) caps.push(['A', 'HSTS is not offered'])
    else if (maxAge < 15552000) caps.push(['A', 'HSTS max-age is too short (less than 180 days)'])
    const order = ['T', 'F', 'C', 'B', 'A', 'A+']
    const grade = caps.reduce((g, [c]) => (order.indexOf(c) < order.indexOf(g) ? c : g), 'A+')
    out += ' Rating (experimental) \n\n'
    out += `${pad('Rating specs (not complete)')}SSL Labs's 'SSL Server Rating Guide' (version 2009q from 2020-01-30)\n`
    if (caps.length) caps.forEach(([c, r], i) => (out += `${pad(i === 0 ? 'Grade cap reasons' : '')}Grade capped to ${c}. ${r}\n`))
    out += `${pad('Overall Grade')}${grade}\n\n`
    out += ` Done ${stamp} [   7s] -->> ${ip}:${u.port} (${u.host}) <<--\n\n`
    ctx.out(out)
    return 0
  },
})
