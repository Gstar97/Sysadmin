/**
 * Conjunto de reglas de nftables (/etc/nftables.conf o un archivo para nft -f): tablas, cadenas
 * base con type/hook/priority/policy, sets y reglas. Avisa los errores de sintaxis que daría
 * "nft -c -f" y los errores de diseño que más dejan a alguien afuera: política drop sin dejar
 * volver las respuestas, sin SSH, NAT fuera de su cadena.
 */
import type { Diagnostic } from './types'

const FAMILIES = ['ip', 'ip6', 'inet', 'arp', 'bridge', 'netdev']
const HOOKS: Record<string, string[]> = {
  filter: ['prerouting', 'input', 'forward', 'output', 'postrouting', 'ingress', 'egress'],
  nat: ['prerouting', 'input', 'output', 'postrouting'],
  route: ['output'],
}
const PRIORITIES = ['raw', 'mangle', 'dstnat', 'filter', 'security', 'srcnat', 'out']
const CT_STATES = ['new', 'established', 'related', 'invalid', 'untracked']
const KEYWORDS = new Set([
  'ip', 'ip6', 'saddr', 'daddr', 'tcp', 'udp', 'sctp', 'th', 'dport', 'sport', 'ct', 'state', 'iif', 'oif', 'iifname', 'oifname', 'meta', 'l4proto', 'nfproto',
  'icmp', 'icmpv6', 'type', 'code', 'accept', 'drop', 'reject', 'with', 'tcp-reset', 'icmpx', 'admin-prohibited', 'port-unreachable', 'host-unreachable', 'counter',
  'log', 'prefix', 'level', 'limit', 'rate', 'over', 'burst', 'packets', 'bytes', 'second', 'minute', 'hour', 'day', 'masquerade', 'snat', 'dnat', 'to', 'jump',
  'goto', 'return', 'continue', 'flags', 'syn', 'ack', 'fin', 'rst', 'echo-request', 'echo-reply', 'destination-unreachable', 'time-exceeded', 'nd-neighbor-solicit',
  'nd-neighbor-advert', 'nd-router-advert', 'nd-router-solicit', 'packet-too-big', 'parameter-problem', 'mark', 'set', 'notrack', 'protocol', 'nexthdr', 'length',
  'vmap', 'map', 'comment', 'ether', 'vlan', 'id', 'redirect', 'queue', 'fib', 'oif', 'missing', 'and', 'or', '!=', '==', '<', '>', '<=', '>=', '@', 'established', 'related',
  'new', 'invalid', 'untracked', ':', 'ipv6-icmp', 'info', 'warn', 'notice', 'err', 'crit', 'alert', 'emerg', 'debug', 'tcp-mss', 'option', 'maxseg', 'size', 'rt', 'mtu', 'reset', 'fully-random', 'persistent', 'random',
])

interface Chain {
  name: string
  line: number
  type?: string
  hook?: string
  policy?: string
  rules: { text: string; line: number }[]
}

export function validateNftables(text: string): { diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const err = (line: number, message: string) => diagnostics.push({ line, severity: 'error', message })
  const warn = (line: number, message: string) => diagnostics.push({ line, severity: 'warning', message })
  type Frame = { kind: 'table' | 'chain' | 'set' | 'other'; line: number; family?: string; chain?: Chain }
  const stack: Frame[] = []
  const tables: { family: string; name: string; chains: Chain[]; sets: Set<string>; line: number }[] = []
  const lines = text.split('\n')

  const checkRule = (t: string, n: number, chain: Chain, family: string) => {
    chain.rules.push({ text: t, line: n })
    const stripped = t.replace(/"[^"]*"/g, '"x"').replace(/comment\s+"x"/, '')
    // Conjuntos anónimos { 80, 443 } y rangos.
    const tokens = stripped.replace(/[{},]/g, ' ').split(/\s+/).filter(Boolean)
    for (const tok of tokens) {
      if (KEYWORDS.has(tok)) continue
      if (/^@\w+$/.test(tok) || /^\$\w+$/.test(tok)) continue
      if (/^"x"$/.test(tok)) continue
      if (/^\d+(-\d+)?$/.test(tok)) continue
      if (/^\d+\.\d+\.\d+\.\d+(\/\d+)?(-\d+\.\d+\.\d+\.\d+)?(:\d+)?$/.test(tok)) continue
      if (/^[0-9a-f:]+(\/\d+)?$/i.test(tok) && tok.includes(':')) continue
      if (/^(ssh|http|https|domain|ntp|smtp|imap|imaps|dns|bootps|bootpc|ftp|telnet|mysql|postgresql)$/.test(tok)) continue
      if (/^\d+\/(second|minute|hour|day)$/.test(tok)) continue
      if (/^(established|related|new|invalid|untracked)(,(established|related|new|invalid|untracked))*$/.test(tok)) continue
      if (/^\w+$/.test(tok) && /\b(jump|goto)\s+\w+/.test(stripped) && new RegExp(`(jump|goto)\\s+${tok}\\b`).test(stripped)) continue
      if (/^0x[0-9a-f]+$/i.test(tok)) continue
      // Nombres de interfaz: nft los acepta con o sin comillas.
      if (/^(lo|eth\d+|enp\w+|ens\w+|wg\d+|eno\w+|br\w+|wlan\d+|wlp\w+)$/.test(tok) && /\b(iif|oif|iifname|oifname)\s+$/.test(stripped.slice(0, stripped.indexOf(tok)))) continue
      err(n, `Error: syntax error, unexpected ${tok}`)
      return
    }
    const ct = /ct state ([\w,{} ]+?)(?= (accept|drop|reject|counter|jump|goto|log)\b|$)/.exec(stripped)
    if (ct) for (const s of ct[1].replace(/[{}]/g, ' ').split(/[\s,]+/).filter(Boolean)) if (!CT_STATES.includes(s)) err(n, `Error: estado de conexión desconocido: ${s} (son ${CT_STATES.join(', ')}).`)
    if (/\b(masquerade|snat)\b/.test(t) && !(chain.type === 'nat' && chain.hook === 'postrouting')) err(n, 'Error: masquerade y snat solo valen en una cadena type nat hook postrouting.')
    if (/\bdnat\b/.test(t) && !(chain.type === 'nat' && (chain.hook === 'prerouting' || chain.hook === 'output'))) err(n, 'Error: dnat solo vale en una cadena type nat hook prerouting (u output).')
    if (/\b(tcp|udp) dport\b/.test(t) && family === 'arp') err(n, 'Error: la familia arp no tiene puertos.')
    const verdicts = (t.match(/\b(accept|drop|reject)\b/g) ?? []).length
    if (verdicts > 1 && !/vmap/.test(t)) err(n, 'Error: una regla tiene un solo veredicto (accept, drop o reject).')
  }

  lines.forEach((raw, i) => {
    const n = i + 1
    let t = raw.replace(/#.*$/, '').trim()
    if (!t) return
    if (/^flush ruleset$/.test(t) || /^include "\S+"$/.test(t) || /^define \w+ = .+$/.test(t)) return
    // Una línea puede abrir y cerrar a la vez (set { ... } en una línea).
    const top = stack.at(-1)
    let m: RegExpExecArray | null
    if ((m = /^table (\w+) (\w[\w-]*) \{$/.exec(t)) || (m = /^table (\w[\w-]*) \{$/.exec(t))) {
      if (top) err(n, 'Error: una tabla no puede ir dentro de otra cosa: falta cerrar una llave antes.')
      const family = m[2] ? m[1] : 'ip'
      const name = m[2] ?? m[1]
      if (!FAMILIES.includes(family)) err(n, `Error: familia desconocida "${family}" (son ${FAMILIES.join(', ')}).`)
      tables.push({ family, name, chains: [], sets: new Set(), line: n })
      stack.push({ kind: 'table', line: n, family })
      return
    }
    if ((m = /^(set|map) (\w[\w-]*) \{(.*)$/.exec(t))) {
      if (top?.kind !== 'table') err(n, 'Error: un set va dentro de una tabla.')
      tables.at(-1)?.sets.add(m[2])
      if (!/\btype \w+/.test(t) && !/\}\s*$/.test(t)) {
        // El type puede venir en la línea siguiente.
      }
      if (m[3].includes('}')) return
      stack.push({ kind: 'set', line: n })
      return
    }
    if ((m = /^chain (\w[\w-]*) \{(.*)$/.exec(t))) {
      if (top?.kind !== 'table') err(n, 'Error: una cadena va dentro de una tabla.')
      const chain: Chain = { name: m[1], line: n, rules: [] }
      tables.at(-1)?.chains.push(chain)
      stack.push({ kind: 'chain', line: n, chain, family: top?.family })
      return
    }
    if (t === '}') {
      if (!stack.length) err(n, 'Error: syntax error, unexpected }: sobra una llave.')
      stack.pop()
      return
    }
    if (top?.kind === 'set') {
      if (/^(type \w+|flags [\w,]+|elements = \{.*\}|auto-merge|timeout \w+|size \d+|counter|policy \w+);?$/.test(t.replace(/;$/, ''))) return
      if (/^elements = \{/.test(t) && !t.includes('}')) {
        stack.push({ kind: 'other', line: n })
        return
      }
      err(n, `Error: syntax error en el set: ${t}`)
      return
    }
    if (top?.kind === 'other') {
      if (t.includes('}')) stack.pop()
      return
    }
    if (top?.kind === 'chain' && top.chain) {
      const c = top.chain
      if (/^type /.test(t)) {
        m = /^type (\w+) hook (\w+)(?: device "?\w+"?)? priority ([\w+-]+(?: ?[+-] ?\d+)?);(?: policy (\w+);)?$/.exec(t)
        if (!m) {
          err(n, 'Error: la línea de una cadena base es "type filter hook input priority filter; policy drop;" (con los punto y coma).')
          return
        }
        c.type = m[1]
        c.hook = m[2]
        c.policy = m[4]
        if (!HOOKS[m[1]]) err(n, `Error: tipo de cadena desconocido "${m[1]}" (filter, nat o route).`)
        else if (!HOOKS[m[1]].includes(m[2])) err(n, `Error: una cadena ${m[1]} no puede ir en el hook ${m[2]}${m[1] === 'nat' ? ' (nat va en prerouting, input, output o postrouting)' : ''}.`)
        const prio = m[3].replace(/\s/g, '').replace(/[+-]\d+$/, '')
        if (!/^-?\d+$/.test(prio) && !PRIORITIES.includes(prio)) err(n, `Error: prioridad desconocida "${m[3]}".`)
        if (m[4] && !['accept', 'drop'].includes(m[4])) err(n, `Error: la política es accept o drop, no "${m[4]}".`)
        return
      }
      if (/^policy (accept|drop);?$/.test(t)) {
        c.policy = /drop/.test(t) ? 'drop' : 'accept'
        return
      }
      checkRule(t.replace(/;$/, ''), n, c, top.family ?? 'ip')
      return
    }
    if (top?.kind === 'table') {
      err(n, `Error: syntax error, unexpected ${t.split(/\s+/)[0]} (dentro de una tabla van chain, set o map).`)
      return
    }
    t = t.replace(/^add /, '')
    if (/^(rule|chain|table|element) /.test(t)) return
    err(n, `Error: syntax error, unexpected ${t.split(/\s+/)[0]}`)
  })
  for (const f of stack) err(f.line, 'Error: falta cerrar una llave (}) de este bloque.')

  for (const tb of tables) {
    const names = new Set(tb.chains.map((c) => c.name))
    for (const c of tb.chains) {
      for (const r of c.rules) {
        for (const ref of r.text.matchAll(/@(\w+)/g)) if (!tb.sets.has(ref[1])) err(r.line, `Error: el set @${ref[1]} no existe en la tabla ${tb.name}.`)
        const j = /\b(jump|goto) (\w+)/.exec(r.text)
        if (j && !names.has(j[2])) err(r.line, `Error: la cadena ${j[2]} no existe en la tabla ${tb.name}.`)
      }
      if (c.type === 'filter' && c.policy === 'drop' && (c.hook === 'input' || c.hook === 'forward')) {
        if (!c.rules.some((r) => /ct state [\w,{} ]*established/.test(r.text) && /accept/.test(r.text))) warn(c.line, `La cadena ${c.name} tiene policy drop y ninguna regla "ct state established,related accept": las respuestas de las conexiones que abre el equipo no van a poder volver.`)
        if (c.hook === 'input' && !c.rules.some((r) => /dport (22|ssh|\{[^}]*\b(22|ssh)\b)/.test(r.text) && /accept/.test(r.text))) warn(c.line, `La cadena ${c.name} tiene policy drop y no permite SSH (puerto 22): si administras este equipo por SSH, te vas a quedar afuera al cargar las reglas.`)
        if (c.hook === 'input' && !c.rules.some((r) => /iif(name)? "lo"/.test(r.text))) warn(c.line, `La cadena ${c.name} no permite la interfaz lo: los servicios que se hablan dentro del mismo equipo (por ejemplo, una aplicación con su base de datos local) van a fallar.`)
      }
    }
  }
  return { diagnostics }
}
