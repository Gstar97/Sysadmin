/**
 * rsyslog: lectura de la configuración (RainerScript y el formato clásico de selectores),
 * validación con mensajes parecidos a los de "rsyslogd -N1" y evaluación de las reglas para un
 * mensaje (la usa el simulador para escribir archivos y reenviar a otros servidores).
 */
import type { Diagnostic } from './types'

export const RSYSLOG_VERSION = '8.2412.0'

const FAC_NUM: Record<string, number> = {
  kern: 0, user: 1, mail: 2, daemon: 3, auth: 4, security: 4, syslog: 5, lpr: 6, news: 7, uucp: 8, cron: 9, authpriv: 10, ftp: 11, ntp: 12, audit: 13, alert: 14, clock: 15,
  local0: 16, local1: 17, local2: 18, local3: 19, local4: 20, local5: 21, local6: 22, local7: 23, mark: 24,
}
export const SEVERITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']
const SEV_ALIAS: Record<string, string> = { panic: 'emerg', error: 'err', warn: 'warning' }

export interface RsMessage {
  facility: string
  severity: string
  hostname: string
  fromhost: string
  fromhostIp: string
  programname: string
  pid?: number
  msg: string
  /** Milisegundos. */
  time: number
  inputname: string
}

export type Expr =
  | { k: 'prop'; name: string }
  | { k: 'str'; v: string }
  | { k: 'num'; v: number }
  | { k: 'not'; e: Expr }
  | { k: 'bin'; op: string; a: Expr; b: Expr }
  | { k: 'fn'; name: string; args: Expr[] }

export type RsAction =
  | { kind: 'file'; path?: string; dynaFile?: string; template?: string; disabled?: boolean }
  | { kind: 'fwd'; target: string; port: number; protocol: 'tcp' | 'udp'; template?: string; queued: boolean; id: string }
  | { kind: 'usrmsg' }
  | { kind: 'other'; type: string }

interface Selector {
  facs: string[] | '*'
  neg: boolean
  eq: boolean
  prio: string
}

export type Stmt =
  | { k: 'sel'; sels: Selector[]; body: Stmt[]; line: number }
  | { k: 'prop'; prop: string; neg: boolean; op: string; value: string; body: Stmt[]; line: number }
  | { k: 'if'; cond: Expr; then: Stmt[]; else?: Stmt[]; line: number }
  | { k: 'action'; action: RsAction; line: number }
  | { k: 'stop'; line: number }
  | { k: 'call'; name: string; line: number }

export interface RsInput {
  type: string
  port: number
  protocol: 'tcp' | 'udp'
  ruleset?: string
  file: string
  line: number
}

export interface RsTemplate {
  name: string
  string: string
}

export interface RsDiag {
  file: string
  line: number
  message: string
  code: number
  /** Errores de sintaxis: rsyslog antepone "error during parsing file". */
  parse?: boolean
}

export interface RsConfig {
  modules: Set<string>
  inputs: RsInput[]
  templates: Map<string, RsTemplate>
  rulesets: Map<string, Stmt[]>
  /** Plantilla por defecto de las acciones de archivo ($ActionFileDefaultTemplate o el módulo omfile). */
  fileTemplate: string
  errors: RsDiag[]
  files: string[]
}

export const MAIN_RULESET = 'RSYSLOG_DefaultRuleset'

/** Plantillas que trae rsyslog. */
export const BUILTIN_TEMPLATES: Record<string, string> = {
  RSYSLOG_TraditionalFileFormat: '%TIMESTAMP% %HOSTNAME% %syslogtag%%msg:::sp-if-no-1st-sp%%msg:::drop-last-lf%\n',
  RSYSLOG_FileFormat: '%TIMESTAMP:::date-rfc3339% %HOSTNAME% %syslogtag%%msg:::sp-if-no-1st-sp%%msg:::drop-last-lf%\n',
  RSYSLOG_TraditionalForwardFormat: '<%PRI%>%TIMESTAMP% %HOSTNAME% %syslogtag:1:32%%msg:::sp-if-no-1st-sp%%msg%',
  RSYSLOG_ForwardFormat: '<%PRI%>%TIMESTAMP:::date-rfc3339% %HOSTNAME% %syslogtag:1:32%%msg:::sp-if-no-1st-sp%%msg%',
  RSYSLOG_SyslogProtocol23Format: '<%PRI%>1 %TIMESTAMP:::date-rfc3339% %HOSTNAME% %APP-NAME% %PROCID% %MSGID% %STRUCTURED-DATA% %msg%\n',
  RSYSLOG_DebugFormat: 'Debug line with all properties:\nFROMHOST: \'%FROMHOST%\', fromhost-ip: \'%fromhost-ip%\', HOSTNAME: \'%HOSTNAME%\', PRI: %PRI%,\nsyslogtag \'%syslogtag%\', programname: \'%programname%\', APP-NAME: \'%APP-NAME%\', PROCID: \'%PROCID%\', MSGID: \'%MSGID%\',\nmsg: \'%msg%\'\n\n',
}

const PROPERTIES = new Set([
  'msg', 'rawmsg', 'rawmsg-after-pri', 'hostname', 'source', 'fromhost', 'fromhost-ip', 'fromhost-port', 'syslogtag', 'programname', 'pri', 'pri-text', 'iut', 'syslogfacility', 'syslogfacility-text', 'syslogseverity', 'syslogseverity-text', 'syslogpriority', 'syslogpriority-text', 'timegenerated', 'timereported', 'timestamp', 'protocol-version', 'structured-data', 'app-name', 'procid', 'msgid', 'inputname', 'jsonmesg', 'uuid',
  '$now', '$year', '$month', '$day', '$hour', '$hhour', '$qhour', '$minute', '$now-utc', '$year-utc', '$month-utc', '$day-utc', '$hour-utc', '$minute-utc', '$myhostname', '$bom', '$wday',
])

/** Módulos que vienen con el paquete rsyslog (el resto necesita otro paquete: rsyslog-relp, rsyslog-elasticsearch...). */
const CORE_MODULES = ['imuxsock', 'imjournal', 'imklog', 'immark', 'imtcp', 'imudp', 'imfile', 'imptcp', 'impstats', 'builtin:omfile', 'builtin:omfwd', 'builtin:omusrmsg', 'builtin:omdiscard', 'omprog', 'mmjsonparse', 'mmnormalize', 'mmutf8fix', 'omjournal', 'imrelp', 'omrelp', 'omelasticsearch', 'omhttp', 'imkafka', 'omkafka', 'mmdblookup']
const INPUT_PROTO: Record<string, 'tcp' | 'udp'> = { imtcp: 'tcp', imptcp: 'tcp', imrelp: 'tcp', imudp: 'udp' }

const ACTION_COMMON = ['type', 'name', 'template', 'queue.type', 'queue.filename', 'queue.size', 'queue.maxdiskspace', 'queue.saveonshutdown', 'queue.highwatermark', 'queue.lowwatermark', 'queue.dequeuebatchsize', 'queue.timeoutenqueue', 'queue.timeoutshutdown', 'queue.workerthreads', 'queue.spooldirectory', 'queue.maxfilesize', 'queue.discardmark', 'queue.discardseverity', 'queue.checkpointinterval', 'queue.syncqueuefiles', 'queue.timeoutactioncompletion', 'action.resumeretrycount', 'action.resumeinterval', 'action.resumeintervalmax', 'action.reportsuspension', 'action.reportsuspensioncontinuation', 'action.execonlywhenpreviousissuspended', 'action.copymsg', 'action.errorfile', 'action.writeallmarkmessages']
const ACTION_PARAMS: Record<string, string[]> = {
  omfwd: ['target', 'port', 'protocol', 'tcp_framing', 'tcp_framedelimiter', 'ziplevel', 'compression.mode', 'compression.stream.flushontxend', 'streamdriver', 'streamdriver.name', 'streamdrivermode', 'streamdriver.mode', 'streamdriverauthmode', 'streamdriver.authmode', 'streamdriverpermittedpeers', 'streamdriver.permittedpeers', 'streamdriver.cafile', 'streamdriver.certfile', 'streamdriver.keyfile', 'keepalive', 'keepalive.probes', 'keepalive.interval', 'keepalive.time', 'rebindinterval', 'address', 'device', 'udp.sendtoall', 'udp.senddelay', 'gnutlsprioritystring', 'resendlastmsgonreconnect', 'pool.resumeinterval', 'targetsrv', 'conerrskip', 'maxerrormessages'],
  omfile: ['file', 'dynafile', 'dirowner', 'dirownernum', 'dirgroup', 'dirgroupnum', 'fileowner', 'fileownernum', 'filegroup', 'filegroupnum', 'filecreatemode', 'dircreatemode', 'failonchownfailure', 'createdirs', 'sync', 'iobuffersize', 'asyncwriting', 'flushontxend', 'flushinterval', 'dynafilecachesize', 'closetimeout', 'veryrobustzip', 'ziplevel', 'rotation.sizelimit', 'rotation.sizelimitcommand', 'sig.provider', 'cry.provider', 'addlf'],
  omusrmsg: ['users'],
  omdiscard: [],
}
const INPUT_COMMON = ['type', 'name', 'ruleset', 'ratelimit.interval', 'ratelimit.burst', 'ratelimit.name']
const INPUT_PARAMS: Record<string, string[]> = {
  imtcp: ['port', 'address', 'supportoctetcountedframing', 'maxsessions', 'maxlisteners', 'flowcontrol', 'disablelfdelimiter', 'discardtruncatedmsg', 'notifyonconnectionclose', 'notifyonconnectionopen', 'keepalive', 'keepalive.probes', 'keepalive.time', 'keepalive.interval', 'streamdriver.name', 'streamdriver.mode', 'streamdriver.authmode', 'streamdriver.permittedpeers', 'streamdriver.cafile', 'streamdriver.certfile', 'streamdriver.keyfile', 'permittedpeer', 'gnutlsprioritystring', 'addtlframedelimiter', 'listenportfilename', 'defaulttz', 'framingfix.cisco.asa', 'preservecase', 'socketbacklog'],
  imudp: ['port', 'address', 'ipfreebind', 'device', 'defaulttz', 'name.appendport', 'rcvbufsize', 'preservecase'],
  imptcp: ['port', 'address', 'path', 'supportoctetcountedframing', 'keepalive', 'maxsessions', 'defaulttz', 'compression.mode'],
  imfile: ['file', 'tag', 'facility', 'severity', 'persiststateinterval', 'readmode', 'startmsg.regex', 'endmsg.regex', 'escapelf', 'maxlinesatonce', 'maxsubmitatonce', 'deletestateonfiledelete', 'addmetadata', 'freshstarttail', 'reopenontruncate', 'statefile', 'readtimeout', 'discardtruncatedmsg', 'msgdiscardingerror', 'needparse', 'trimlineoverbytes', 'ignoreolderthan', 'addceetag'],
  imrelp: ['port', 'address', 'tls', 'tls.cacert', 'tls.mycert', 'tls.myprivkey', 'tls.authmode', 'tls.permittedpeer', 'maxdatasize', 'keepalive'],
}
const TEMPLATE_PARAMS = ['name', 'type', 'string', 'plugin', 'subtree', 'option.sql', 'option.stdsql', 'option.json', 'option.jsonf', 'option.casesensitive']

/** Directivas clásicas ($Algo) que existen; algunas solo con su módulo cargado. */
const LEGACY: Record<string, string | undefined> = {
  modload: undefined, includeconfig: undefined, workdirectory: undefined, fileowner: undefined, filegroup: undefined, filecreatemode: undefined, dircreatemode: undefined, dirowner: undefined, dirgroup: undefined, umask: undefined,
  privdroptouser: undefined, privdroptogroup: undefined, privdroptouserid: undefined, privdroptogroupid: undefined, repeatedmsgreduction: undefined, actionfiledefaulttemplate: undefined, actionforwarddefaulttemplate: undefined,
  actionqueuetype: undefined, actionqueuefilename: undefined, actionqueuemaxdiskspace: undefined, actionqueuesaveonshutdown: undefined, actionresumeretrycount: undefined, actionresumeinterval: undefined, actionqueuesize: undefined,
  actionsendstreamdriver: undefined, actionsendstreamdrivermode: undefined, actionsendstreamdriverauthmode: undefined, actionsendstreamdriverpermittedpeer: undefined, defaultnetstreamdriver: undefined, defaultnetstreamdrivercafile: undefined, defaultnetstreamdrivercertfile: undefined, defaultnetstreamdriverkeyfile: undefined,
  mainmsgqueuetype: undefined, mainmsgqueuesize: undefined, mainmsgqueuefilename: undefined, maxmessagesize: undefined, preservefqdn: undefined, createdirs: undefined, escapecontrolcharactersonreceive: undefined, omitlocallogging: undefined, systemlogsocketname: undefined, abortonuncleanconfig: undefined, localhostname: undefined,
  template: undefined, ruleset: undefined, allowedsender: undefined, imjournalstatefile: 'imjournal', imjournalratelimitinterval: 'imjournal', imjournalratelimitburst: 'imjournal', klogpermitnonkernelfacility: 'imklog',
  inputtcpserverrun: 'imtcp', inputtcpmaxsessions: 'imtcp', inputtcpserverstreamdrivermode: 'imtcp', inputtcpserverstreamdriverauthmode: 'imtcp', inputtcpserverstreamdriverpermittedpeer: 'imtcp', inputtcpserverbindruleset: 'imtcp',
  udpserverrun: 'imudp', udpserveraddress: 'imudp', inputudpserverrun: 'imudp', inputudpserverbindruleset: 'imudp', inputfilename: 'imfile', inputfiletag: 'imfile', inputfilestatefile: 'imfile', inputfileseverity: 'imfile', inputfilefacility: 'imfile', inputrunfilemonitor: 'imfile',
  markmessageperiod: 'immark', syssocketratelimitinterval: 'imuxsock', syssocketratelimitburst: 'imuxsock',
}

type Param = { name: string; value: string; line: number }

export interface IncludeResolver {
  (pattern: string): { path: string; text: string }[]
}

const err = (cfg: RsConfig, file: string, line: number, message: string, code = 2207, parse = false) => cfg.errors.push({ file, line, message, code, parse })

function newConfig(): RsConfig {
  return { modules: new Set(['builtin:omfile', 'builtin:omfwd', 'builtin:omusrmsg', 'builtin:omdiscard']), inputs: [], templates: new Map(), rulesets: new Map([[MAIN_RULESET, []]]), fileTemplate: 'RSYSLOG_FileFormat', errors: [], files: [] }
}

class Parser {
  pos = 0
  private lineStarts: number[] = [0]
  /** Opciones de cola ($ActionQueueType) que se aplican a la próxima acción clásica. */
  legacyQueue = false
  legacyTemplate?: string
  private fwdCount = 0

  constructor(
    private s: string,
    private file: string,
    private cfg: RsConfig,
    private include?: IncludeResolver,
    private depth = 0,
  ) {
    for (let i = 0; i < s.length; i++) if (s[i] === '\n') this.lineStarts.push(i + 1)
  }

  line(p = this.pos): number {
    let lo = 0
    let hi = this.lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.lineStarts[mid] <= p) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  private syntax(token: string, line = this.line()) {
    err(this.cfg, this.file, line, `syntax error on token '${token}'`, 2207, true)
  }

  /** Saltea espacios, saltos de línea y comentarios. */
  skip(newlines = true) {
    const s = this.s
    while (this.pos < s.length) {
      const c = s[this.pos]
      if (c === ' ' || c === '\t' || c === '\r' || (newlines && c === '\n')) this.pos++
      else if (c === '\\' && s[this.pos + 1] === '\n') this.pos += 2
      else if (c === '#') {
        while (this.pos < s.length && s[this.pos] !== '\n') this.pos++
      } else if (c === '/' && s[this.pos + 1] === '*') {
        const end = s.indexOf('*/', this.pos + 2)
        this.pos = end < 0 ? s.length : end + 2
      } else break
    }
  }

  private restOfLine(): string {
    // Una línea clásica, con sus continuaciones (barra invertida al final). Termina en el salto de
    // línea o en una llave de cierre fuera de comillas.
    let out = ''
    let q = ''
    while (this.pos < this.s.length) {
      const c = this.s[this.pos]
      if (!q && c === '\\' && this.s[this.pos + 1] === '\n') {
        this.pos += 2
        while (this.s[this.pos] === ' ' || this.s[this.pos] === '\t') this.pos++
        continue
      }
      if (!q && c === '\n') break
      if (!q && c === '}') break
      if (!q && c === '#' && /\s$/.test(out)) {
        while (this.pos < this.s.length && this.s[this.pos] !== '\n') this.pos++
        break
      }
      if (c === '"' || c === "'") q = q === c ? '' : q || c
      out += c
      this.pos++
    }
    return out.trim()
  }

  private word(): string | undefined {
    const m = /^[A-Za-z_][\w.:-]*/.exec(this.s.slice(this.pos, this.pos + 200))
    if (!m) return undefined
    this.pos += m[0].length
    return m[0]
  }

  private quoted(): string | undefined {
    const q = this.s[this.pos]
    if (q !== '"' && q !== "'") return undefined
    let out = ''
    let i = this.pos + 1
    for (; i < this.s.length; i++) {
      const c = this.s[i]
      if (c === '\\' && i + 1 < this.s.length) {
        const n = this.s[++i]
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n
        continue
      }
      if (c === q) break
      out += c
    }
    if (i >= this.s.length) {
      err(this.cfg, this.file, this.line(), 'unterminated string', 2207, true)
      this.pos = this.s.length
      return out
    }
    this.pos = i + 1
    return out
  }

  /** (nombre="valor" ...) */
  params(): Param[] | undefined {
    this.skip()
    if (this.s[this.pos] !== '(') {
      this.syntax(this.s[this.pos] ?? 'EOF')
      return undefined
    }
    this.pos++
    const out: Param[] = []
    for (;;) {
      this.skip()
      const c = this.s[this.pos]
      if (c === undefined) {
        err(this.cfg, this.file, this.line(), "syntax error on token 'EOF'", 2207, true)
        return out
      }
      if (c === ')') {
        this.pos++
        return out
      }
      const line = this.line()
      const name = this.word()
      if (!name) {
        this.syntax(c)
        this.recover(')')
        return out
      }
      this.skip()
      if (this.s[this.pos] !== '=') {
        this.syntax(this.s[this.pos] ?? 'EOF')
        this.recover(')')
        return out
      }
      this.pos++
      this.skip()
      let value: string
      if (this.s[this.pos] === '[') {
        const end = this.s.indexOf(']', this.pos)
        value = this.s.slice(this.pos + 1, end < 0 ? this.s.length : end).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).join(',')
        this.pos = end < 0 ? this.s.length : end + 1
      } else {
        const q = this.quoted()
        if (q !== undefined) value = q
        else {
          const m = /^[^\s()]+/.exec(this.s.slice(this.pos))
          value = m?.[0] ?? ''
          this.pos += value.length
        }
      }
      out.push({ name: name.toLowerCase(), value, line })
    }
  }

  private recover(until: string) {
    while (this.pos < this.s.length && this.s[this.pos] !== until && this.s[this.pos] !== '\n') this.pos++
    if (this.s[this.pos] === until) this.pos++
  }

  /** Lista de sentencias hasta el final o hasta la llave que cierra el bloque. */
  statements(inBlock: boolean): Stmt[] {
    const out: Stmt[] = []
    for (;;) {
      this.skip()
      if (this.pos >= this.s.length) {
        if (inBlock) err(this.cfg, this.file, this.line(), "syntax error on token 'EOF' (falta cerrar una llave)", 2207, true)
        return out
      }
      if (this.s[this.pos] === '}') {
        if (inBlock) {
          this.pos++
          return out
        }
        this.syntax('}')
        this.pos++
        continue
      }
      const before = this.pos
      this.statement(out)
      if (this.pos === before) this.pos++
    }
  }

  private lastFilter(out: Stmt[]): Stmt[] | undefined {
    const last = out.at(-1)
    if (last && (last.k === 'sel' || last.k === 'prop')) return last.body
    if (last && last.k === 'if') return last.else ?? last.then
    return undefined
  }

  private statement(out: Stmt[]) {
    const s = this.s
    const line = this.line()
    const c = s[this.pos]
    if (c === '$' && /[A-Za-z]/.test(s[this.pos + 1] ?? '')) {
      this.pos++
      this.legacyDirective(this.restOfLine(), line)
      return
    }
    if (c === ':') {
      const text = this.restOfLine()
      const m = /^:([$!.\w-]+),\s*(!?)([\w-]+),\s*"((?:[^"\\]|\\.)*)"\s*(.*)$/.exec(text)
      if (!m) {
        err(this.cfg, this.file, line, `invalid property-based filter: '${text.slice(0, 40)}'`, 2207, true)
        return
      }
      const body: Stmt[] = []
      const a = this.legacyAction(m[5], line)
      if (a) body.push(a)
      if (!PROPERTIES.has(m[1].toLowerCase()) && !/^\$[!.]/.test(m[1])) err(this.cfg, this.file, line, `invalid property '${m[1]}'`, 2207, true)
      if (!['contains', 'isequal', 'startswith', 'regex', 'ereregex', 'isempty', 'endswith'].includes(m[3].toLowerCase())) err(this.cfg, this.file, line, `error: invalid compare operation '${m[3]}' - ignoring selector`, 3003)
      out.push({ k: 'prop', prop: m[1].toLowerCase(), neg: !!m[2], op: m[3].toLowerCase(), value: m[4], body, line })
      return
    }
    if (c === '&') {
      this.pos++
      this.skip(false)
      const target = this.lastFilter(out)
      const tmp: Stmt[] = []
      this.actionStatement(tmp, line)
      if (!target) {
        this.syntax('&', line)
        return
      }
      target.push(...tmp)
      return
    }
    // Selector clásico: facilidad.prioridad
    const head = /^[\w*,]+\.[!=]*[\w*]+(?:;[\s\\]*[\w*,]+\.[!=]*[\w*]+)*(?=[\s;])/i.exec(s.slice(this.pos, this.pos + 400))
    if (head) {
      const text = this.restOfLine()
      const m = /^(\S+(?:;\s*\S+)*?)\s+(.+)$/.exec(text.replace(/;\s+/g, ';'))
      if (!m) {
        err(this.cfg, this.file, line, `selector without action: '${text}'`, 2207, true)
        return
      }
      const sels = this.selectors(m[1], line)
      const body: Stmt[] = []
      if (/^action\s*\(/.test(m[2]) || /^stop$/.test(m[2])) {
        // "*.* action(...)": volvemos a leer la acción como RainerScript.
        const sub = new Parser(m[2], this.file, this.cfg, this.include, this.depth)
        sub.lineOffset = line - 1
        sub.statementInto(body)
      } else {
        const a = this.legacyAction(m[2], line)
        if (a) body.push(a)
      }
      out.push({ k: 'sel', sels, body, line })
      return
    }
    const w = this.word()
    if (!w) {
      this.syntax(this.restOfLine().split(/\s/)[0] || c, line)
      return
    }
    const kw = w.toLowerCase()
    switch (kw) {
      case 'module': {
        const p = this.params()
        if (p) this.module(p, line)
        return
      }
      case 'input': {
        const p = this.params()
        if (p) this.input(p, line)
        return
      }
      case 'template': {
        const p = this.params()
        if (p) this.template(p, line)
        return
      }
      case 'global':
      case 'main_queue':
      case 'parser':
      case 'timezone':
      case 'lookup_table':
      case 'dyn_stats':
      case 'percentile_stats':
      case 'license':
        this.params()
        return
      case 'include': {
        const p = this.params()
        const file = p?.find((x) => x.name === 'file')?.value
        const mode = p?.find((x) => x.name === 'mode')?.value
        if (file) this.includeFiles(file, line, mode === 'optional')
        return
      }
      case 'ruleset': {
        const p = this.params()
        const name = p?.find((x) => x.name === 'name')?.value
        if (!name) err(this.cfg, this.file, line, 'ruleset: parameter "name" required but not specified', 2105)
        this.skip()
        if (this.s[this.pos] !== '{') {
          this.syntax(this.s[this.pos] ?? 'EOF')
          return
        }
        this.pos++
        const body = this.statements(true)
        if (name) {
          if (this.cfg.rulesets.has(name) && name !== MAIN_RULESET) err(this.cfg, this.file, line, `ruleset '${name}' specified more than once`, 2207, true)
          this.cfg.rulesets.set(name, [...(name === MAIN_RULESET ? this.cfg.rulesets.get(name)! : []), ...body])
        }
        return
      }
      case 'if': {
        out.push(this.ifStatement(line))
        return
      }
      case 'action':
      case 'stop':
      case 'call':
        this.pos -= w.length
        this.actionStatement(out, line)
        return
      case 'set':
      case 'unset':
      case 'reset': {
        const end = this.s.indexOf(';', this.pos)
        this.pos = end < 0 ? this.s.length : end + 1
        return
      }
      case 'then':
      case 'else':
        this.syntax(w, line)
        return
      default:
        this.syntax(w, line)
        this.restOfLine()
    }
  }

  lineOffset = 0

  /** Para releer una acción dentro de una línea clásica. */
  statementInto(out: Stmt[]) {
    this.skip()
    this.actionStatement(out, this.lineOffset + 1)
  }

  private actionStatement(out: Stmt[], line: number) {
    this.skip(false)
    const rest = this.s.slice(this.pos, this.pos + 20)
    if (/^action\s*\(/i.test(rest)) {
      this.word()
      const p = this.params()
      if (p) {
        const a = this.rainerAction(p, line)
        if (a) out.push(a)
      }
      return
    }
    if (/^stop\b/i.test(rest)) {
      this.pos += 4
      out.push({ k: 'stop', line })
      return
    }
    if (/^call\b/i.test(rest)) {
      this.pos += 4
      this.skip(false)
      const name = this.quoted() ?? this.word() ?? ''
      out.push({ k: 'call', name, line })
      return
    }
    const text = this.restOfLine()
    const a = this.legacyAction(text, line)
    if (a) out.push(a)
  }

  private ifStatement(line: number): Stmt {
    const cond = this.expr(line)
    this.skip()
    const w = this.word()
    if (w?.toLowerCase() !== 'then') {
      this.syntax(w ?? this.s[this.pos] ?? 'EOF')
      this.restOfLine()
      return { k: 'if', cond, then: [], line }
    }
    const then = this.body(line)
    const save = this.pos
    this.skip()
    if (/^else\b/i.test(this.s.slice(this.pos, this.pos + 5))) {
      this.pos += 4
      this.skip()
      if (/^if\b/i.test(this.s.slice(this.pos, this.pos + 3))) {
        this.pos += 2
        return { k: 'if', cond, then, else: [this.ifStatement(this.line())], line }
      }
      return { k: 'if', cond, then, else: this.body(line), line }
    }
    this.pos = save
    return { k: 'if', cond, then, line }
  }

  private body(line: number): Stmt[] {
    this.skip()
    if (this.s[this.pos] === '{') {
      this.pos++
      return this.statements(true)
    }
    const out: Stmt[] = []
    this.actionStatement(out, line)
    return out
  }

  // --- Expresiones de los if -------------------------------------------------------------

  private exprTokens: string[] = []

  private expr(line: number): Expr {
    // Tomamos el texto hasta "then" (fuera de comillas).
    const start = this.pos
    let q = ''
    let i = this.pos
    for (; i < this.s.length; i++) {
      const c = this.s[i]
      if (q) {
        if (c === '\\') i++
        else if (c === q) q = ''
        continue
      }
      if (c === '"' || c === "'") q = c
      else if (/\bthen\b/i.test(this.s.slice(i, i + 5)) && /[\s)'"]/.test(this.s[i - 1] ?? ' ') && /[\s{]|$/.test(this.s[i + 4] ?? ' ')) break
    }
    const text = this.s.slice(start, i)
    this.pos = i
    this.exprTokens = tokenizeExpr(text)
    if (!this.exprTokens.length) {
      this.syntax('then', line)
      return { k: 'str', v: '' }
    }
    const e = this.orExpr(line)
    if (this.exprTokens.length) this.syntax(this.exprTokens[0], line)
    return e
  }

  private next(): string | undefined {
    return this.exprTokens.shift()
  }

  private peek(): string | undefined {
    return this.exprTokens[0]
  }

  private orExpr(line: number): Expr {
    let a = this.andExpr(line)
    while (this.peek()?.toLowerCase() === 'or') {
      this.next()
      a = { k: 'bin', op: 'or', a, b: this.andExpr(line) }
    }
    return a
  }

  private andExpr(line: number): Expr {
    let a = this.notExpr(line)
    while (this.peek()?.toLowerCase() === 'and') {
      this.next()
      a = { k: 'bin', op: 'and', a, b: this.notExpr(line) }
    }
    return a
  }

  private notExpr(line: number): Expr {
    if (this.peek()?.toLowerCase() === 'not') {
      this.next()
      return { k: 'not', e: this.notExpr(line) }
    }
    return this.cmpExpr(line)
  }

  private cmpExpr(line: number): Expr {
    const a = this.addExpr(line)
    const op = this.peek()?.toLowerCase()
    if (op && ['==', '!=', '<>', '<', '>', '<=', '>=', 'contains', 'contains_i', 'startswith', 'startswith_i', 'endswith'].includes(op)) {
      this.next()
      return { k: 'bin', op, a, b: this.addExpr(line) }
    }
    return a
  }

  private addExpr(line: number): Expr {
    let a = this.prim(line)
    while (this.peek() === '+' || this.peek() === '&' || this.peek() === '-') {
      const op = this.next()!
      a = { k: 'bin', op, a, b: this.prim(line) }
    }
    return a
  }

  private prim(line: number): Expr {
    const t = this.next()
    if (t === undefined) {
      this.syntax('then', line)
      return { k: 'str', v: '' }
    }
    if (t === '(') {
      const e = this.orExpr(line)
      if (this.next() !== ')') this.syntax('then', line)
      return e
    }
    if (t.startsWith('$')) {
      const name = t.slice(1).toLowerCase()
      if (!PROPERTIES.has(name) && !PROPERTIES.has(`$${name}`) && !/^[!./]/.test(name)) err(this.cfg, this.file, line, `invalid property '${t.slice(1)}'`, 2207, true)
      return { k: 'prop', name: PROPERTIES.has(`$${name}`) ? `$${name}` : name }
    }
    if (t.startsWith('"') || t.startsWith("'")) return { k: 'str', v: t.slice(1, -1).replace(/\\(.)/g, '$1') }
    if (/^-?\d+$/.test(t)) return { k: 'num', v: Number(t) }
    if (/^[a-z_]\w*$/i.test(t) && this.peek() === '(') {
      this.next()
      const args: Expr[] = []
      while (this.peek() !== undefined && this.peek() !== ')') {
        args.push(this.orExpr(line))
        if (this.peek() === ',') this.next()
      }
      this.next()
      return { k: 'fn', name: t.toLowerCase(), args }
    }
    this.syntax(t, line)
    return { k: 'str', v: '' }
  }

  // --- Piezas -----------------------------------------------------------------------------

  private selectors(text: string, line: number): Selector[] {
    const out: Selector[] = []
    for (const part of text.split(';').filter(Boolean)) {
      const m = /^([\w*,]+)\.(!?)(=?)([\w*]+)$/i.exec(part.trim())
      if (!m) {
        err(this.cfg, this.file, line, `invalid selector '${part}'`, 2207, true)
        continue
      }
      const facs = m[1] === '*' ? '*' : m[1].toLowerCase().split(',')
      if (facs !== '*') for (const f of facs) if (!(f in FAC_NUM)) err(this.cfg, this.file, line, `invalid facility name '${f}'`, 3000)
      let prio = m[4].toLowerCase()
      prio = SEV_ALIAS[prio] ?? prio
      if (prio !== '*' && prio !== 'none' && !SEVERITIES.includes(prio)) err(this.cfg, this.file, line, `unknown priority name "${m[4]}"`, 3000)
      out.push({ facs, neg: !!m[2], eq: !!m[3], prio })
    }
    return out
  }

  private legacyAction(text: string, line: number): Stmt | undefined {
    let t = text.trim()
    if (!t) {
      err(this.cfg, this.file, line, 'selector without action', 2207, true)
      return undefined
    }
    if (t === 'stop' || t === '~') return { k: 'stop', line }
    let template: string | undefined
    const semi = /^(.*?);([\w-]+)$/.exec(t)
    if (semi && !t.startsWith(':om')) {
      t = semi[1].trim()
      template = semi[2]
    }
    const queued = this.legacyQueue
    if (t.startsWith('@')) {
      const tcp = t.startsWith('@@')
      const target = t.slice(tcp ? 2 : 1).replace(/^\([^)]*\)/, '')
      const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(target)
      if (!m) {
        err(this.cfg, this.file, line, `invalid forwarding target '${target}'`, 2207, true)
        return undefined
      }
      return { k: 'action', line, action: { kind: 'fwd', target: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2] ?? 514), protocol: tcp ? 'tcp' : 'udp', template: template ?? this.legacyTemplateFwd, queued, id: `action-${++this.fwdCount}-builtin:omfwd` } }
    }
    if (t.startsWith('?')) return { k: 'action', line, action: { kind: 'file', dynaFile: t.slice(1), template: template ?? this.legacyTemplate } }
    if (t.startsWith('/') || t.startsWith('-/')) return { k: 'action', line, action: { kind: 'file', path: t.replace(/^-/, ''), template: template ?? this.legacyTemplate } }
    if (t === '*' || /^:omusrmsg:/.test(t)) return { k: 'action', line, action: { kind: 'usrmsg' } }
    if (t.startsWith('|')) return { k: 'action', line, action: { kind: 'other', type: 'ompipe' } }
    if (/^[\w,]+$/.test(t)) return { k: 'action', line, action: { kind: 'usrmsg' } }
    this.syntax(t.split(/\s/)[0], line)
    return undefined
  }

  legacyTemplateFwd?: string

  private checkParams(p: Param[], allowed: string[], what: string, line: number) {
    for (const x of p) if (!allowed.includes(x.name)) err(this.cfg, this.file, x.line ?? line, `${what ? `${what}: ` : ''}parameter '${x.name}' not known -- typo in config file?`, 2207)
  }

  private rainerAction(p: Param[], line: number): Stmt | undefined {
    const get = (n: string) => p.find((x) => x.name === n)?.value
    const type = get('type')
    if (!type) {
      err(this.cfg, this.file, line, 'action: parameter "type" required but not specified', 2105)
      return undefined
    }
    const t = type.toLowerCase()
    const known = ACTION_PARAMS[t]
    if (!known && !this.cfg.modules.has(t)) {
      err(this.cfg, this.file, line, `module name '${type}' is unknown`, 2209)
      return undefined
    }
    if (known) this.checkParams(p, [...ACTION_COMMON, ...known], t, line)
    const template = get('template')
    const queued = !!get('queue.type') && get('queue.type')!.toLowerCase() !== 'direct'
    if (t === 'omfwd') {
      const target = get('target')
      if (!target) {
        err(this.cfg, this.file, line, "omfwd: parameter 'target' required but not specified - action definition invalid", 2105)
        return undefined
      }
      const proto = (get('protocol') ?? 'udp').toLowerCase()
      if (proto !== 'tcp' && proto !== 'udp') err(this.cfg, this.file, line, `omfwd: invalid protocol '${get('protocol')}' - must be "tcp" or "udp"`, 2207)
      const port = Number(get('port') ?? 514)
      if (!Number.isInteger(port) || port < 1 || port > 65535) err(this.cfg, this.file, line, `omfwd: invalid port '${get('port')}'`, 2207)
      return { k: 'action', line, action: { kind: 'fwd', target, port, protocol: proto === 'tcp' ? 'tcp' : 'udp', template, queued, id: `action-${++this.fwdCount}-builtin:omfwd` } }
    }
    if (t === 'omfile') {
      const file = get('file')
      const dyna = get('dynafile')
      if (!file === !dyna) {
        err(this.cfg, this.file, line, 'omfile: either the "file" or "dynafile" parameter must be given', 2105)
        return undefined
      }
      return { k: 'action', line, action: { kind: 'file', path: file, dynaFile: dyna, template } }
    }
    if (t === 'omusrmsg') return { k: 'action', line, action: { kind: 'usrmsg' } }
    if (t === 'omdiscard') return { k: 'stop', line }
    return { k: 'action', line, action: { kind: 'other', type: t } }
  }

  private module(p: Param[], line: number) {
    const load = p.find((x) => x.name === 'load')?.value
    if (!load) {
      err(this.cfg, this.file, line, 'module: parameter "load" required but not specified', 2105)
      return
    }
    this.loadModule(load, line)
    if (load === 'builtin:omfile') {
      const t = p.find((x) => x.name === 'template')?.value
      if (t) this.cfg.fileTemplate = t
    }
  }

  private loadModule(name: string, line: number) {
    const n = name.trim()
    if (!CORE_MODULES.includes(n)) {
      err(this.cfg, this.file, line, `could not load module '${n}', errors: trying to load module /usr/lib64/rsyslog/${n}.so: cannot open shared object file: No such file or directory`, 2066)
      return
    }
    if (this.cfg.modules.has(n) && !n.startsWith('builtin:')) {
      err(this.cfg, this.file, line, `module '${n}' already in this config, cannot be added`, 2221)
      return
    }
    this.cfg.modules.add(n)
  }

  private input(p: Param[], line: number) {
    const type = p.find((x) => x.name === 'type')?.value
    if (!type) {
      err(this.cfg, this.file, line, 'input: parameter "type" required but not specified', 2105)
      return
    }
    if (!this.cfg.modules.has(type)) {
      err(this.cfg, this.file, line, `input module name '${type}' is unknown`, 2209)
      return
    }
    const known = INPUT_PARAMS[type]
    if (known) this.checkParams(p, [...INPUT_COMMON, ...known], type, line)
    const proto = INPUT_PROTO[type]
    if (!proto) return
    const portV = p.find((x) => x.name === 'port')?.value
    if (!portV) {
      err(this.cfg, this.file, line, `${type}: required parameter 'port' missing`, 2105)
      return
    }
    for (const one of portV.split(',')) {
      const port = Number(one)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        err(this.cfg, this.file, line, `${type}: invalid port '${one}'`, 2207)
        continue
      }
      this.cfg.inputs.push({ type, port, protocol: proto, ruleset: p.find((x) => x.name === 'ruleset')?.value, file: this.file, line })
    }
  }

  private template(p: Param[], line: number) {
    this.checkParams(p, TEMPLATE_PARAMS, 'template', line)
    const name = p.find((x) => x.name === 'name')?.value
    const type = p.find((x) => x.name === 'type')?.value?.toLowerCase()
    if (!name) {
      err(this.cfg, this.file, line, 'template: parameter "name" required but not specified', 2105)
      return
    }
    if (!type) {
      err(this.cfg, this.file, line, `template '${name}': parameter "type" required but not specified`, 2105)
      return
    }
    let string = p.find((x) => x.name === 'string')?.value ?? ''
    if (type === 'string' && !p.some((x) => x.name === 'string')) err(this.cfg, this.file, line, `template '${name}' of type string needs a string parameter`, 2105)
    this.skip()
    if (type === 'list') {
      if (this.s[this.pos] !== '{') {
        this.syntax(this.s[this.pos] ?? 'EOF')
        return
      }
      const end = this.s.indexOf('}', this.pos)
      const body = this.s.slice(this.pos + 1, end < 0 ? this.s.length : end)
      this.pos = end < 0 ? this.s.length : end + 1
      string = ''
      for (const m of body.matchAll(/(constant|property)\s*\(([^)]*)\)/g)) {
        const sub = new Parser(`x(${m[2]})`, this.file, this.cfg)
        sub.pos = 1
        const ps = sub.params() ?? []
        const v = (n: string) => ps.find((x) => x.name === n)?.value ?? ''
        string += m[1] === 'constant' ? v('value') : `%${v('name')}%`
      }
    } else if (!['string', 'subtree', 'plugin'].includes(type)) err(this.cfg, this.file, line, `template '${name}': invalid template type '${type}'`, 2207)
    if (this.cfg.templates.has(name)) err(this.cfg, this.file, line, `template '${name}' already defined`, 2207)
    this.cfg.templates.set(name, { name, string })
  }

  private legacyDirective(text: string, line: number) {
    const m = /^(\S+)\s*(.*)$/.exec(text)
    if (!m) return
    const name = m[1].toLowerCase()
    const args = m[2].trim()
    if (!(name in LEGACY)) {
      err(this.cfg, this.file, line, `invalid or yet-unknown config file command '${m[1]}' - have you forgotten to load a module?`, 3003)
      return
    }
    const needs = LEGACY[name]
    if (needs && !this.cfg.modules.has(needs)) {
      err(this.cfg, this.file, line, `invalid or yet-unknown config file command '${m[1]}' - have you forgotten to load a module?`, 3003)
      return
    }
    switch (name) {
      case 'modload':
        this.loadModule(args, line)
        break
      case 'includeconfig':
        this.includeFiles(args, line, true)
        break
      case 'actionfiledefaulttemplate':
        this.cfg.fileTemplate = args
        this.legacyTemplate = undefined
        break
      case 'actionforwarddefaulttemplate':
        this.legacyTemplateFwd = args
        break
      case 'actionqueuetype':
        this.legacyQueue = args.toLowerCase() !== 'direct'
        break
      case 'inputtcpserverrun':
        this.cfg.inputs.push({ type: 'imtcp', port: Number(args) || 514, protocol: 'tcp', file: this.file, line })
        break
      case 'udpserverrun':
      case 'inputudpserverrun':
        this.cfg.inputs.push({ type: 'imudp', port: Number(args) || 514, protocol: 'udp', file: this.file, line })
        break
      case 'template': {
        const t = /^([\w-]+)\s*,\s*"((?:[^"\\]|\\.)*)"/.exec(args)
        if (!t) {
          err(this.cfg, this.file, line, `invalid template definition '${args}'`, 2207, true)
          break
        }
        this.cfg.templates.set(t[1], { name: t[1], string: t[2].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(.)/g, '$1') })
        break
      }
    }
  }

  private includeFiles(pattern: string, line: number, optional: boolean) {
    if (!this.include || this.depth > 4) return
    const files = this.include(pattern)
    if (!files.length && !optional && !pattern.includes('*')) err(this.cfg, this.file, line, `error accessing config file or directory '${pattern}': No such file or directory`, 2040)
    for (const f of files) {
      this.cfg.files.push(f.path)
      const p = new Parser(f.text, f.path, this.cfg, this.include, this.depth + 1)
      p.legacyQueue = this.legacyQueue
      p.legacyTemplate = this.legacyTemplate
      p.legacyTemplateFwd = this.legacyTemplateFwd
      this.cfg.rulesets.get(MAIN_RULESET)!.push(...p.statements(false))
    }
  }
}

function tokenizeExpr(text: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (/\s/.test(c) || (c === '\\' && text[i + 1] === '\n')) {
      i++
      continue
    }
    if (c === '#') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1
      out.push(text.slice(i, j + 1))
      i = j + 1
      continue
    }
    const two = text.slice(i, i + 2)
    if (['==', '!=', '<>', '<=', '>='].includes(two)) {
      out.push(two)
      i += 2
      continue
    }
    if ('()<>,+&'.includes(c) || (c === '-' && !/[\w]/.test(text[i - 1] ?? ' '))) {
      out.push(c)
      i++
      continue
    }
    const m = /^\$?[!./]?[\w.!/-]*[\w]/.exec(text.slice(i)) ?? /^\S/.exec(text.slice(i))!
    out.push(m[0])
    i += m[0].length
  }
  return out
}

/** Arma la configuración completa (el archivo principal y sus include). */
export function parseRsyslog(text: string, file = '/etc/rsyslog.conf', include?: IncludeResolver): RsConfig {
  const cfg = newConfig()
  cfg.files.push(file)
  const p = new Parser(text, file, cfg, include)
  cfg.rulesets.get(MAIN_RULESET)!.unshift(...p.statements(false))
  // Las plantillas se resuelven al final (pueden definirse después de usarse).
  const check = (stmts: Stmt[]) => {
    for (const s of stmts) {
      if (s.k === 'action') {
        const a = s.action
        if (a.kind === 'file') {
          for (const t of [a.dynaFile, a.template]) {
            if (t && !cfg.templates.has(t) && !BUILTIN_TEMPLATES[t]) {
              err(cfg, file, s.line, `Could not find template '${t}' - action disabled`, 3003)
              a.disabled = true
            }
          }
        }
        if (a.kind === 'fwd' && a.template && !cfg.templates.has(a.template) && !BUILTIN_TEMPLATES[a.template]) err(cfg, file, s.line, `Could not find template '${a.template}' - action disabled`, 3003)
      }
      if (s.k === 'sel' || s.k === 'prop') check(s.body)
      if (s.k === 'if') {
        check(s.then)
        if (s.else) check(s.else)
      }
      if (s.k === 'call' && !cfg.rulesets.has(s.name)) err(cfg, file, s.line, `CALL: ruleset '${s.name}' cannot be found, call ignored`, 2207)
    }
  }
  for (const r of cfg.rulesets.values()) check(r)
  for (const i of cfg.inputs) if (i.ruleset && !cfg.rulesets.has(i.ruleset)) err(cfg, i.file, i.line, `${i.type}: ruleset '${i.ruleset}' not found - using default ruleset instead`, 2207)
  const ports = new Map<string, RsInput>()
  for (const i of cfg.inputs) {
    const k = `${i.protocol}/${i.port}`
    if (ports.has(k)) err(cfg, i.file, i.line, `${i.type}: port ${i.port} is already used by another listener, cannot add it again`, 2077)
    ports.set(k, i)
  }
  if (!cfg.fileTemplate || (!cfg.templates.has(cfg.fileTemplate) && !BUILTIN_TEMPLATES[cfg.fileTemplate])) cfg.fileTemplate = 'RSYSLOG_FileFormat'
  return cfg
}

/** Mensajes de "rsyslogd -N1". */
export function formatRsyslogError(d: RsDiag, version = RSYSLOG_VERSION): string {
  const head = d.parse ? `error during parsing file ${d.file}, on or before line ${d.line}: ` : ''
  return `rsyslogd: ${head}${d.message} [v${version} try https://www.rsyslog.com/e/${d.code} ]`
}

/** Para el editor de configuración. */
export function validateRsyslog(text: string): { diagnostics: Diagnostic[] } {
  const cfg = parseRsyslog(text, 'rsyslog.conf')
  return { diagnostics: cfg.errors.map((e) => ({ line: e.line, severity: 'error' as const, message: e.message })) }
}

// ---------------------------------------------------------------------------------------
// Evaluación
// ---------------------------------------------------------------------------------------

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function rfc3339(t: number): string {
  const d = new Date(t)
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${pad(0, 3)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
}

function traditional(t: number): string {
  const d = new Date(t)
  return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function propValue(m: RsMessage, name: string): string {
  const d = new Date(m.time)
  const fac = FAC_NUM[m.facility] ?? 1
  const sev = SEVERITIES.indexOf(m.severity)
  switch (name.toLowerCase()) {
    case 'msg':
      return m.msg.startsWith(' ') ? m.msg : ` ${m.msg}`
    case 'rawmsg':
      return `<${fac * 8 + sev}>${traditional(m.time)} ${m.hostname} ${syslogtag(m)} ${m.msg}`
    case 'hostname':
    case 'source':
      return m.hostname
    case 'fromhost':
      return m.fromhost
    case 'fromhost-ip':
      return m.fromhostIp
    case 'syslogtag':
      return syslogtag(m)
    case 'programname':
    case 'app-name':
      return m.programname
    case 'procid':
      return m.pid ? String(m.pid) : '-'
    case 'msgid':
    case 'structured-data':
      return '-'
    case 'pri':
      return String(fac * 8 + sev)
    case 'pri-text':
      return `${m.facility}.${m.severity}<${fac * 8 + sev}>`
    case 'syslogfacility':
      return String(fac)
    case 'syslogfacility-text':
      return m.facility
    case 'syslogseverity':
    case 'syslogpriority':
      return String(sev)
    case 'syslogseverity-text':
    case 'syslogpriority-text':
      return m.severity
    case 'inputname':
      return m.inputname
    case 'timestamp':
    case 'timereported':
    case 'timegenerated':
      return traditional(m.time)
    case '$year':
      return String(d.getFullYear())
    case '$month':
      return pad(d.getMonth() + 1)
    case '$day':
      return pad(d.getDate())
    case '$hour':
      return pad(d.getHours())
    case '$minute':
      return pad(d.getMinutes())
    case '$now':
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    case '$myhostname':
      return m.hostname
    default:
      return ''
  }
}

function syslogtag(m: RsMessage): string {
  return m.pid ? `${m.programname}[${m.pid}]:` : `${m.programname}:`
}

/** Aplica una plantilla de rsyslog (%propiedad:desde:hasta:opciones%). */
export function renderTemplate(tpl: string, m: RsMessage): string {
  return tpl.replace(/%([^%:]+)(?::([^%:]*):([^%:]*):([^%]*))?%/g, (_, name: string, from?: string, to?: string, opts?: string) => {
    let v = propValue(m, name)
    const o = (opts ?? '').toLowerCase().split(',')
    if (name.toLowerCase() === 'msg' && o.includes('sp-if-no-1st-sp')) return m.msg.startsWith(' ') ? '' : ' '
    if (name.toLowerCase() === 'msg' && !o.includes('sp-if-no-1st-sp')) v = m.msg
    if (o.includes('date-rfc3339') && /timestamp|timereported|timegenerated/i.test(name)) v = rfc3339(m.time)
    if (o.includes('drop-last-lf')) v = v.replace(/\n$/, '')
    if (o.includes('lowercase')) v = v.toLowerCase()
    if (o.includes('uppercase')) v = v.toUpperCase()
    if (o.includes('secpath-replace') || o.includes('secpath-drop')) v = v.replace(/\//g, o.includes('secpath-drop') ? '' : '_')
    if (from && /^\d+$/.test(from)) v = v.slice(Number(from) - 1, to && /^\d+$/.test(to) ? Number(to) : undefined)
    return v
  })
}

/** Texto de una plantilla por nombre (las propias y las que trae rsyslog). */
export function templateText(cfg: RsConfig, name: string | undefined, fallback: string): string {
  const n = name ?? fallback
  return cfg.templates.get(n)?.string ?? BUILTIN_TEMPLATES[n] ?? BUILTIN_TEMPLATES[fallback] ?? BUILTIN_TEMPLATES.RSYSLOG_FileFormat
}

function selMatch(sels: Selector[], m: RsMessage): boolean {
  let ok = false
  const sev = SEVERITIES.indexOf(m.severity)
  for (const s of sels) {
    const fac = s.facs === '*' || s.facs.includes(m.facility) || (m.facility === 'auth' && s.facs.includes('security'))
    if (!fac) continue
    if (s.prio === 'none') {
      ok = false
      continue
    }
    const p = s.prio === '*' ? 7 : SEVERITIES.indexOf(s.prio)
    const hit = s.eq ? sev === p : sev <= p
    ok = s.neg ? !hit : hit
  }
  return ok
}

type Val = string | number | boolean

function evalExpr(e: Expr, m: RsMessage): Val {
  switch (e.k) {
    case 'prop':
      return e.name === 'msg' ? m.msg : propValue(m, e.name)
    case 'str':
      return e.v
    case 'num':
      return e.v
    case 'not':
      return !truthy(evalExpr(e.e, m))
    case 'fn': {
      const a = e.args.map((x) => String(evalExpr(x, m)))
      if (e.name === 're_match') return safeRe(a[1])?.test(a[0]) ?? false
      if (e.name === 'tolower') return a[0]?.toLowerCase() ?? ''
      if (e.name === 'toupper') return a[0]?.toUpperCase() ?? ''
      if (e.name === 'strlen') return (a[0] ?? '').length
      return ''
    }
    case 'bin': {
      if (e.op === 'and') return truthy(evalExpr(e.a, m)) && truthy(evalExpr(e.b, m))
      if (e.op === 'or') return truthy(evalExpr(e.a, m)) || truthy(evalExpr(e.b, m))
      const a = evalExpr(e.a, m)
      const b = evalExpr(e.b, m)
      const num = typeof a === 'number' || typeof b === 'number' ? [Number(a), Number(b)] : undefined
      const sa = String(a)
      const sb = String(b)
      switch (e.op) {
        case '==':
          return num && !num.some(Number.isNaN) ? num[0] === num[1] : sa === sb
        case '!=':
        case '<>':
          return num && !num.some(Number.isNaN) ? num[0] !== num[1] : sa !== sb
        case '<':
          return num ? num[0] < num[1] : sa < sb
        case '>':
          return num ? num[0] > num[1] : sa > sb
        case '<=':
          return num ? num[0] <= num[1] : sa <= sb
        case '>=':
          return num ? num[0] >= num[1] : sa >= sb
        case 'contains':
          return sa.includes(sb)
        case 'contains_i':
          return sa.toLowerCase().includes(sb.toLowerCase())
        case 'startswith':
          return sa.startsWith(sb)
        case 'startswith_i':
          return sa.toLowerCase().startsWith(sb.toLowerCase())
        case 'endswith':
          return sa.endsWith(sb)
        case '+':
          return Number(a) + Number(b)
        case '-':
          return Number(a) - Number(b)
        case '&':
          return sa + sb
      }
      return false
    }
  }
}

function safeRe(s: string | undefined): RegExp | undefined {
  try {
    return s === undefined ? undefined : new RegExp(s)
  } catch {
    return undefined
  }
}

const truthy = (v: Val) => (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : v !== '' && v !== '0')

function propFilter(s: Extract<Stmt, { k: 'prop' }>, m: RsMessage): boolean {
  const v = s.prop === 'msg' ? m.msg : propValue(m, s.prop)
  let hit: boolean
  switch (s.op) {
    case 'contains':
      hit = v.includes(s.value)
      break
    case 'isequal':
      hit = v === s.value
      break
    case 'startswith':
      hit = v.startsWith(s.value)
      break
    case 'endswith':
      hit = v.endsWith(s.value)
      break
    case 'isempty':
      hit = v === ''
      break
    case 'regex':
    case 'ereregex':
      hit = safeRe(s.value)?.test(v) ?? false
      break
    default:
      hit = false
  }
  return s.neg ? !hit : hit
}

/** Las acciones que ejecuta rsyslog para un mensaje, en orden (respetando stop). */
export function evaluateRsyslog(cfg: RsConfig, m: RsMessage, ruleset = MAIN_RULESET): RsAction[] {
  const out: RsAction[] = []
  let stopped = false
  const run = (stmts: Stmt[], depth: number) => {
    for (const s of stmts) {
      if (stopped) return
      switch (s.k) {
        case 'action':
          out.push(s.action)
          break
        case 'stop':
          stopped = true
          return
        case 'sel':
          if (selMatch(s.sels, m)) run(s.body, depth)
          break
        case 'prop':
          if (propFilter(s, m)) run(s.body, depth)
          break
        case 'if':
          if (truthy(evalExpr(s.cond, m))) run(s.then, depth)
          else if (s.else) run(s.else, depth)
          break
        case 'call': {
          const r = cfg.rulesets.get(s.name)
          if (r && depth < 8) run(r, depth + 1)
          break
        }
      }
    }
  }
  run(cfg.rulesets.get(ruleset) ?? cfg.rulesets.get(MAIN_RULESET) ?? [], 0)
  return out
}
