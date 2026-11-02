/**
 * Archivos de zona de BIND (RFC 1035): $TTL, $ORIGIN, @, nombres relativos, paréntesis del SOA
 * y los registros más usados. Devuelve los registros ya con nombres completos y los mismos
 * problemas que reporta named-checkzone, explicados.
 */
import type { Diagnostic } from './types'

export interface ZoneRecord {
  /** Nombre completo, en minúsculas y con el punto final (www.empresa.local.). */
  name: string
  ttl: number
  type: string
  /** Datos ya normalizados (los nombres, completos y con punto final). */
  data: string
  line: number
}

export interface ZoneProblem {
  line: number
  severity: 'error' | 'warning'
  /** Mensaje tal como lo escribe named-checkzone. */
  bind: string
  /** La explicación para el estudiante. */
  explicacion: string
}

export interface ParsedZone {
  origin: string
  records: ZoneRecord[]
  problems: ZoneProblem[]
  serial?: number
}

const TYPES = ['SOA', 'NS', 'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'PTR', 'SRV', 'CAA']
const CLASSES = ['IN', 'CH', 'HS']

/** "3600", "1h", "1d2h", "1w" → segundos. */
export function parseTtl(t: string): number | undefined {
  if (/^\d+$/.test(t)) return Number(t)
  const re = /(\d+)([smhdw])/gi
  if (!/^(\d+[smhdw])+$/i.test(t)) return undefined
  let total = 0
  for (const m of t.matchAll(re)) total += Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2].toLowerCase() as 's']
  return total
}

function isIpv4(s: string) {
  const p = s.split('.')
  return p.length === 4 && p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255)
}

function isIpv6(s: string) {
  if (!/^[0-9a-f:.]+$/i.test(s) || !s.includes(':')) return false
  const dbl = s.split('::').length - 1
  if (dbl > 1) return false
  const groups = s.split(':').filter((g) => g !== '')
  if (groups.some((g) => g.length > 4 && !isIpv4(g))) return false
  return dbl === 1 ? groups.length < 8 : groups.length === 8
}

/** Divide en palabras respetando comillas y cortando en ";" (comentario). */
function words(line: string): { text: string; quoted: boolean }[] {
  const out: { text: string; quoted: boolean }[] = []
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (c === ';') break
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '(' || c === ')') {
      out.push({ text: c, quoted: false })
      i++
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < line.length && line[j] !== '"') j += line[j] === '\\' ? 2 : 1
      out.push({ text: line.slice(i + 1, j), quoted: true })
      i = j + 1
      continue
    }
    let j = i
    while (j < line.length && !/[\s;()]/.test(line[j])) j++
    out.push({ text: line.slice(i, j), quoted: false })
    i = j
  }
  return out
}

export function parseZone(text: string, zoneName: string, fileName = 'zona'): ParsedZone {
  let origin = zoneName.toLowerCase().replace(/\.?$/, '.')
  const zoneOrigin = origin
  const records: ZoneRecord[] = []
  const problems: ZoneProblem[] = []
  let defaultTtl: number | undefined
  let lastOwner: string | undefined
  let warnedNoTtl = false
  const err = (line: number, bind: string, explicacion: string) => problems.push({ line, severity: 'error', bind: `dns_master_load: ${fileName}:${line}: ${bind}`, explicacion })
  const fq = (n: string) => {
    if (n === '@') return origin
    const low = n.toLowerCase()
    return low.endsWith('.') ? low : `${low}.${origin}`
  }

  // Une las líneas de un mismo registro entre paréntesis.
  const lines = text.split('\n')
  const entries: { line: number; startsBlank: boolean; toks: { text: string; quoted: boolean }[] }[] = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const toks = words(raw)
    if (!toks.length) continue
    const entry = { line: i + 1, startsBlank: /^\s/.test(raw), toks: [] as { text: string; quoted: boolean }[] }
    let depth = 0
    let cur = toks
    let j = i
    for (;;) {
      for (const t of cur) {
        if (!t.quoted && t.text === '(') depth++
        else if (!t.quoted && t.text === ')') depth--
        else entry.toks.push(t)
      }
      if (depth <= 0 || j + 1 >= lines.length) break
      j++
      cur = words(lines[j])
    }
    if (depth > 0) err(entry.line, 'unbalanced parentheses', 'Se abrió un paréntesis "(" que nunca se cierra: el registro (casi siempre el SOA) se come el resto del archivo.')
    i = j
    entries.push(entry)
  }

  for (const e of entries) {
    const t = e.toks.map((x) => x.text)
    if (t[0]?.startsWith('$')) {
      const dir = t[0].toUpperCase()
      if (dir === '$TTL') {
        const v = t[1] ? parseTtl(t[1]) : undefined
        if (v === undefined) err(e.line, 'bad ttl', '$TTL necesita un tiempo válido: segundos (86400) o con unidad (1d, 1h).')
        else defaultTtl = v
      } else if (dir === '$ORIGIN') {
        if (!t[1]) err(e.line, 'unexpected end of input', '$ORIGIN necesita un nombre de dominio.')
        else origin = fq(t[1])
      } else if (dir !== '$INCLUDE') err(e.line, `unknown $ directive '${t[0]}'`, `"${t[0]}" no es una directiva de zona: las que existen son $TTL, $ORIGIN y $INCLUDE.`)
      continue
    }
    let k = 0
    let owner: string | undefined
    if (!e.startsBlank) {
      owner = fq(t[0])
      k = 1
    } else owner = lastOwner
    let ttl: number | undefined
    // TTL y clase pueden venir en cualquier orden antes del tipo.
    for (let n = 0; n < 2 && k < t.length; n++) {
      if (ttl === undefined && parseTtl(t[k]) !== undefined && !TYPES.includes(t[k].toUpperCase())) {
        ttl = parseTtl(t[k])
        k++
      } else if (CLASSES.includes(t[k].toUpperCase())) k++
    }
    const type = t[k]?.toUpperCase()
    const data = t.slice(k + 1)
    if (!owner) {
      err(e.line, 'no current owner name', 'La línea empieza con espacio (o sea, sin nombre) pero no hay un registro anterior del que tomar el nombre.')
      continue
    }
    lastOwner = owner
    if (!type) {
      err(e.line, 'unexpected end of input', 'Falta el tipo de registro (A, NS, MX, CNAME...).')
      continue
    }
    if (!TYPES.includes(type)) {
      err(e.line, `unknown RR type '${t[k]}'`, `"${t[k]}" no es un tipo de registro. Revisa que esté bien escrito (A, AAAA, CNAME, MX, NS, TXT, PTR, SRV, SOA, CAA).`)
      continue
    }
    if (ttl === undefined) {
      if (defaultTtl === undefined && !warnedNoTtl) {
        problems.push({ line: e.line, severity: 'warning', bind: `dns_master_load: ${fileName}:${e.line}: no TTL specified; using SOA MINTTL instead`, explicacion: 'Falta $TTL al principio del archivo: BIND usa el último número del SOA. Conviene escribir $TTL 86400 (o el valor que quieras) en la primera línea.' })
        warnedNoTtl = true
      }
    }
    const recTtl = ttl ?? defaultTtl ?? 86400
    const need = (n: number, como: string) => {
      if (data.length < n) {
        err(e.line, 'unexpected end of input', `Al registro ${type} le faltan datos. Se escribe así: ${como}`)
        return false
      }
      return true
    }
    let norm: string | undefined
    switch (type) {
      case 'A':
        if (!need(1, 'nombre A 192.168.10.20')) continue
        if (!isIpv4(data[0])) {
          err(e.line, 'bad dotted quad', `"${data[0]}" no es una IPv4 válida (cuatro números de 0 a 255 separados por puntos). Si es una IPv6, el registro es AAAA.`)
          continue
        }
        norm = data[0]
        break
      case 'AAAA':
        if (!need(1, 'nombre AAAA 2001:db8::20')) continue
        if (!isIpv6(data[0])) {
          err(e.line, 'bad IPv6 address', `"${data[0]}" no es una IPv6 válida. Si es una IPv4, el registro es A.`)
          continue
        }
        norm = data[0].toLowerCase()
        break
      case 'NS':
      case 'CNAME':
      case 'PTR':
        if (!need(1, `nombre ${type} destino.empresa.local.`)) continue
        norm = fq(data[0])
        break
      case 'MX':
        if (!need(2, 'empresa.local. MX 10 mail.empresa.local.')) continue
        if (!/^\d+$/.test(data[0])) {
          err(e.line, `expected a 16-bit integer near '${data[0]}'`, 'MX lleva primero la preferencia (un número, menor = preferido) y después el servidor: MX 10 mail.empresa.local.')
          continue
        }
        norm = `${data[0]} ${fq(data[1])}`
        break
      case 'SRV':
        if (!need(4, '_ldap._tcp SRV 0 100 389 dc1.empresa.local.')) continue
        if (!data.slice(0, 3).every((x) => /^\d+$/.test(x))) {
          err(e.line, 'not a valid number', 'SRV lleva prioridad, peso y puerto (tres números) antes del servidor.')
          continue
        }
        norm = `${data.slice(0, 3).join(' ')} ${fq(data[3])}`
        break
      case 'TXT':
        if (!need(1, 'nombre TXT "texto"')) continue
        norm = e.toks
          .slice(e.toks.length - data.length)
          .map((x) => `"${x.text}"`)
          .join(' ')
        break
      case 'CAA':
        if (!need(3, 'empresa.com. CAA 0 issue "letsencrypt.org"')) continue
        norm = data.join(' ')
        break
      case 'SOA': {
        if (data.length < 7) {
          err(e.line, 'unexpected end of input', 'El SOA lleva siete datos: servidor primario, correo del responsable (con punto en vez de @), serial, refresh, retry, expire y TTL negativo. Si están en varias líneas, van entre paréntesis.')
          continue
        }
        const nums = data.slice(2, 7)
        if (!nums.every((x) => parseTtl(x) !== undefined)) {
          err(e.line, 'not a valid number', 'Los cinco últimos datos del SOA son números (serial y tiempos).')
          continue
        }
        if (data[1].includes('@')) {
          problems.push({ line: e.line, severity: 'warning', bind: `${fileName}:${e.line}: SOA RNAME contains '@'`, explicacion: 'En el SOA el correo del responsable se escribe con un punto en lugar de @: admin.empresa.local. (significa admin@empresa.local).' })
        }
        norm = `${fq(data[0])} ${fq(data[1].replace('@', '.'))} ${nums.map((x) => parseTtl(x)).join(' ')}`
        break
      }
    }
    if (type === 'SOA' && defaultTtl === undefined && ttl === undefined) {
      // Sin $TTL, los registros usan el mínimo del SOA.
      defaultTtl = Number(norm!.split(' ').at(-1))
    }
    records.push({ name: owner, ttl: type === 'SOA' ? recTtl : recTtl, type, data: norm!, line: e.line })
  }

  // Controles de la zona completa (como named-checkzone).
  const fatal = problems.some((p) => p.severity === 'error')
  const zoneErr = (line: number, bind: string, explicacion: string) => problems.push({ line, severity: 'error', bind: `zone ${zoneOrigin.replace(/\.$/, '')}/IN: ${bind}`, explicacion })
  if (!fatal) {
    const soas = records.filter((r) => r.type === 'SOA' && r.name === zoneOrigin)
    if (soas.length !== 1) zoneErr(1, `has ${soas.length} SOA records`, soas.length ? 'La zona tiene más de un SOA: tiene que haber exactamente uno, en el nombre de la zona (@).' : 'Falta el registro SOA, que tiene que ser el primero y estar en el nombre de la zona (@).')
    const ns = records.filter((r) => r.type === 'NS' && r.name === zoneOrigin)
    if (!ns.length) zoneErr(1, 'has no NS records', 'La zona necesita al menos un registro NS en @ que diga cuál es su servidor DNS.')
    for (const n of ns) {
      if (n.data.endsWith(zoneOrigin)) {
        const has = records.some((r) => r.name === n.data && (r.type === 'A' || r.type === 'AAAA'))
        if (!has) {
          const doubled = n.data.endsWith(`${zoneOrigin.replace(/\.$/, '')}.${zoneOrigin}`)
          zoneErr(n.line, `NS '${n.data.replace(/\.$/, '')}' has no address records (A or AAAA)`, doubled ? `Al nombre le falta el punto final: sin él, BIND le agrega la zona y queda "${n.data}". Escríbelo terminado en punto.` : `El servidor del NS está dentro de esta zona, así que necesita su registro A (o AAAA) aquí: ${n.data.split('.')[0]} IN A ...`)
        }
      }
    }
    for (const r of records) {
      if (r.type === 'CNAME') {
        const other = records.find((o) => o.name === r.name && o.type !== 'CNAME')
        if (other) problems.push({ line: r.line, severity: 'error', bind: `dns_master_load: ${fileName}:${r.line}: ${r.name.replace(/\.$/, '')}: CNAME and other data`, explicacion: `"${r.name}" tiene un CNAME y además otro registro (${other.type}, línea ${other.line}). Un nombre con CNAME no puede tener nada más: o es un alias o tiene sus propios datos.` })
      }
      if (r.type === 'MX' || r.type === 'NS') {
        const target = r.data.split(' ').at(-1)!
        if (records.some((o) => o.name === target && o.type === 'CNAME')) problems.push({ line: r.line, severity: 'warning', bind: `zone ${zoneOrigin.replace(/\.$/, '')}/IN: ${r.name.replace(/\.$/, '')}/${r.type} '${target.replace(/\.$/, '')}' is a CNAME (illegal)`, explicacion: `Un ${r.type} tiene que apuntar a un nombre con registro A, no a un alias (CNAME).` })
      }
      if (['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS', 'PTR'].includes(r.type) && !r.name.endsWith(zoneOrigin)) {
        problems.push({ line: r.line, severity: 'warning', bind: `${fileName}:${r.line}: ignoring out-of-zone data (${r.name.replace(/\.$/, '')})`, explicacion: `"${r.name}" no pertenece a la zona ${zoneOrigin}: BIND lo ignora. Si lo escribiste con punto final, quizá sobra; si no, revisa $ORIGIN.` })
      }
    }
  }
  const soa = records.find((r) => r.type === 'SOA')
  return { origin: zoneOrigin, records: records.filter((r) => r.name.endsWith(zoneOrigin)), problems, serial: soa ? Number(soa.data.split(' ')[2]) : undefined }
}

/** Salida de named-checkzone. */
export function checkzoneOutput(z: ParsedZone, fileName: string): { text: string; ok: boolean } {
  const errors = z.problems.filter((p) => p.severity === 'error')
  const lines = z.problems.map((p) => p.bind)
  const zn = z.origin.replace(/\.$/, '')
  if (errors.length) {
    const loadFail = errors.some((e) => e.bind.startsWith('dns_master_load'))
    if (loadFail) {
      const first = errors.find((e) => e.bind.startsWith('dns_master_load'))!.bind.replace(/^.*?: \S+:\d+: /, '')
      lines.push(`zone ${zn}/IN: loading from master file ${fileName} failed: ${/unknown RR type/.test(first) ? 'unknown class/type' : first}`)
    }
    lines.push(`zone ${zn}/IN: not loaded due to errors.`)
    return { text: lines.join('\n') + '\n', ok: false }
  }
  lines.push(`zone ${zn}/IN: loaded serial ${z.serial ?? 0}`, 'OK')
  return { text: lines.join('\n') + '\n', ok: true }
}

/** Para el editor de configuración. */
export function validateZone(text: string, zoneName = 'empresa.local'): { diagnostics: Diagnostic[] } {
  const z = parseZone(text, zoneName)
  return {
    diagnostics: z.problems.map((p) => ({ line: p.line, severity: p.severity, message: `${p.explicacion} (named-checkzone: ${p.bind.replace(/^dns_master_load: \S+:\d+: |^zone \S+: |^\S+:\d+: /, '')})` })),
  }
}
