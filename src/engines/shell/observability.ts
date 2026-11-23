/**
 * Monitoreo y logs en el laboratorio simulado: node_exporter, Prometheus (con promtool),
 * Alertmanager (con amtool), Grafana, Loki (con logcli), Alloy y el agente 2 de Zabbix (con
 * zabbix_get). Cada programa lee su configuración al arrancar (y falla como el real si está mal),
 * escucha en su puerto y responde por HTTP. Prometheus consulta de verdad a sus objetivos por la
 * red del laboratorio; Loki recibe las líneas reales de los archivos y del journal de cada equipo
 * con Alloy; Alertmanager manda las alertas por correo al Postfix del laboratorio.
 */
import { LineCounter, parseDocument, type YAMLError } from 'yaml'
import { register, type CommandContext } from './shell'
import { commOf, SERVICE_PROCS, System, type Proc } from './system'
import type { BashState } from './schema'
import { fetchHttp, reach, SERVERS, type FetchResult, type HttpRequest, type HttpResponse } from './http'
import { hostByIp } from './hosts'
import { metrics } from './perf'
import { ROOT_CRED } from './vfs'
import { SERVICE_CHECKS } from './commands/sysinfo'
import { REPO_GATES } from './commands/pkg'
import { EXEC_CHECKS } from './commands/systemd'
import { VENDOR_UNITS } from './units'
import { submit } from './mail'
import { ALERTMANAGER_EXEC, ALERTMANAGER_VERSION, ALLOY_VERSION, GRAFANA_PKGS, GRAFANA_VERSION, LOKI_VERSION, NODE_EXPORTER_VERSION, PROMETHEUS_EXEC, PROMETHEUS_VERSION, ZABBIX_PKGS, ZABBIX_VERSION } from './monpkgs'
import { buildTsdb, formatDuration, parseDuration, type HttpSpec, type Labels, type NodeSpec, type Scenario, type SeriesSpec, type Tsdb } from '../metrics/tsdb'
import { Engine, fmt, fmtLabels, formatInstant, instantQuery, parse as parsePromQL, PromQLError, rangeQuery, type Node as PromNode, type VSample } from '../metrics/promql'
import { buildLogDb, type LogDb, type LogScenario, type LogStream } from '../logs/logdb'
import { evalMetric, LogQLError, metricRange, parseLogQL, queryLogs, type MetricNode } from '../logs/logql'
import { AlloyError, formatAlloy, planAlloy, relabel, validateAlloy, type AlloyPlan } from './alloyconf'

// ---------------------------------------------------------------------------------------
// Tiempo, YAML y archivos
// ---------------------------------------------------------------------------------------

/** Segundos que se "durmieron" en el laboratorio (sleep hace avanzar el tiempo para las alertas). */
const SLEPT = new WeakMap<System, number>()
System.sleepHooks.push((sys, seconds) => {
  for (const h of [sys, ...sys.lab]) SLEPT.set(h, (SLEPT.get(h) ?? 0) + seconds)
})
export function obsNow(sys: System): number {
  return Date.now() + (SLEPT.get(sys) ?? 0) * 1000
}

const STATE = new WeakMap<System, { metricas?: Scenario; logs?: LogScenario }>()
System.initHooks.push((sys, state: BashState) => {
  if (state.metricas || state.logs_historicos) STATE.set(sys, { metricas: state.metricas as Scenario | undefined, logs: state.logs_historicos as LogScenario | undefined })
})

function read(sys: System, path: string): string | undefined {
  try {
    return sys.vfs.readFile(path, ROOT_CRED)
  } catch {
    return undefined
  }
}

function goYamlMessage(e: YAMLError): string {
  switch (e.code) {
    case 'BLOCK_AS_IMPLICIT_KEY':
    case 'MULTILINE_IMPLICIT_KEY':
    case 'MISSING_CHAR':
      return "could not find expected ':'"
    case 'TAB_AS_INDENT':
      return 'found character that cannot start any token'
    case 'DUPLICATE_KEY':
      return `mapping key ${/"[^"]+"|\S+/.exec(e.message.replace(/^Map keys must be unique.*?:?\s*/, ''))?.[0] ?? ''} already defined`
    default:
      return /mapping values|Nested mappings/i.test(e.message) ? 'mapping values are not allowed in this context' : 'did not find expected key'
  }
}

/** YAML como lo lee Go: errores con "yaml: line N: ...". */
function loadYaml(text: string): { data?: unknown; error?: string } {
  const lc = new LineCounter()
  const doc = parseDocument(text, { lineCounter: lc, uniqueKeys: true })
  if (doc.errors.length) {
    const e = doc.errors[0]
    const line = e.linePos?.[0]?.line ?? 1
    return { error: `yaml: line ${line}: ${goYamlMessage(e)}` }
  }
  return { data: doc.toJS() ?? {} }
}

/** Primera línea donde aparece una clave (para los errores de campos desconocidos). */
function lineOfKey(text: string, key: string, after = 0): number {
  const lines = text.split('\n')
  for (let i = after; i < lines.length; i++) if (new RegExp(`^\\s*(- )?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`).test(lines[i])) return i + 1
  return 1
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

function unknownFields(text: string, obj: unknown, allowed: string[], type: string): string | undefined {
  if (!isObj(obj)) return undefined
  const bad = Object.keys(obj).filter((k) => !allowed.includes(k))
  if (!bad.length) return undefined
  return `yaml: unmarshal errors:\n  ${bad.map((k) => `line ${lineOfKey(text, k)}: field ${k} not found in type ${type}`).join('\n  ')}`
}

function durationOf(v: unknown, fallback: number): number | string {
  if (v === undefined || v === null) return fallback
  const d = parseDuration(String(v))
  return d === undefined ? `not a valid duration string: "${String(v)}"` : d
}

/** Archivos que coinciden con un patrón (*, ?, [..] y **) en el sistema de archivos del equipo. */
export function globFiles(sys: System, pattern: string): string[] {
  if (!/[*?[]/.test(pattern)) return sys.vfs.exists(pattern) ? [pattern] : []
  const parts = pattern.split('/').filter(Boolean)
  const toRe = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`)
  const out: string[] = []
  const walk = (dir: string, i: number) => {
    if (i === parts.length) {
      out.push(dir || '/')
      return
    }
    const p = parts[i]
    let entries: string[]
    try {
      entries = sys.vfs.readdir(dir || '/', ROOT_CRED)
    } catch {
      return
    }
    if (p === '**') {
      walk(dir, i + 1)
      for (const e of entries) {
        const path = `${dir}/${e}`
        try {
          if (sys.vfs.stat(path, ROOT_CRED).type === 'dir') walk(path, i)
        } catch {
          // ignorar
        }
      }
      return
    }
    const re = toRe(p)
    for (const e of entries) {
      if (!re.test(e)) continue
      const path = `${dir}/${e}`
      if (i < parts.length - 1) {
        try {
          if (sys.vfs.stat(path, ROOT_CRED).type !== 'dir') continue
        } catch {
          continue
        }
      }
      walk(path, i + 1)
    }
  }
  walk('', 0)
  return out.filter((p) => {
    try {
      return sys.vfs.stat(p, ROOT_CRED).type === 'file'
    } catch {
      return false
    }
  })
}

function argVal(cmd: string, name: string): string | undefined {
  const parts = cmd.split(/\s+/)
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === name || parts[i] === `-${name}`) return parts[i + 1]
    if (parts[i].startsWith(`${name}=`) || parts[i].startsWith(`-${name}=`)) return parts[i].slice(parts[i].indexOf('=') + 1)
  }
  return undefined
}

function procOf(sys: System, comm: string): Proc | undefined {
  if (sys.poweredOff) return undefined
  return sys.procs.find((p) => commOf(p) === comm)
}

function serviceActive(sys: System, name: string): boolean {
  return !sys.poweredOff && !!sys.services.get(name)?.active
}

function slog(level: string, source: string, msg: string, extra = ''): string {
  return `time=${new Date().toISOString()} level=${level} source=${source} msg=${JSON.stringify(msg)}${extra ? ` ${extra}` : ''}`
}

function json(status: number, body: unknown, extraHeaders: [string, string][] = []): HttpResponse {
  return { status, headers: [['Content-Type', 'application/json'], ...extraHeaders], body: JSON.stringify(body) + '\n' }
}

function text(status: number, body: string, type = 'text/plain; charset=utf-8'): HttpResponse {
  return { status, headers: [['Content-Type', type]], body }
}

function queryParams(path: string): URLSearchParams {
  const i = path.indexOf('?')
  return new URLSearchParams(i < 0 ? '' : path.slice(i + 1))
}

function pathOnly(path: string): string {
  const i = path.indexOf('?')
  return i < 0 ? path : path.slice(0, i)
}

/** Lo que dice Go cuando una conexión HTTP falla (para lastError de Prometheus, Grafana, logcli). */
function goDialError(r: Extract<FetchResult, { ok: false }>, url: string, method = 'Get'): string {
  const u = /^https?:\/\/([^/:]+)(?::(\d+))?/.exec(url)
  const host = u?.[1] ?? ''
  const port = u?.[2] ?? '80'
  if (r.code === 6) return `${method} "${url}": dial tcp: lookup ${host} on 127.0.0.53:53: no such host`
  if (r.code === 28) return `${method} "${url}": context deadline exceeded`
  if (/No route/.test(r.message)) return `${method} "${url}": dial tcp ${r.ip}:${port}: connect: no route to host`
  return `${method} "${url}": dial tcp ${r.ip ?? host}:${port}: connect: connection refused`
}

// ---------------------------------------------------------------------------------------
// Paquetes: repositorios, procesos y unidades
// ---------------------------------------------------------------------------------------

function anyFileMatches(sys: System, dir: string, re: RegExp): boolean {
  let entries: string[]
  try {
    entries = sys.vfs.readdir(dir, ROOT_CRED)
  } catch {
    return false
  }
  return entries.some((f) => re.test(read(sys, `${dir}/${f}`) ?? ''))
}

const grafanaRepo = (sys: System) => (sys.distro === 'rocky' ? anyFileMatches(sys, '/etc/yum.repos.d', /rpm\.grafana\.com/) : anyFileMatches(sys, '/etc/apt/sources.list.d', /apt\.grafana\.com/))
const zabbixRepo = (sys: System) => (sys.distro === 'rocky' ? anyFileMatches(sys, '/etc/yum.repos.d', /repo\.zabbix\.com/) : anyFileMatches(sys, '/etc/apt/sources.list.d', /repo\.zabbix\.com/))
for (const p of GRAFANA_PKGS) REPO_GATES[p] = { repo: 'grafana', ok: grafanaRepo }
for (const p of ZABBIX_PKGS) REPO_GATES[p] = { repo: 'zabbix', ok: zabbixRepo }

SERVICE_PROCS['prometheus'] = { cmd: PROMETHEUS_EXEC, user: 'prometheus', comm: 'prometheus' }
SERVICE_PROCS['node_exporter'] = { cmd: '/usr/local/bin/node_exporter', user: 'node_exporter', comm: 'node_exporter' }
SERVICE_PROCS['alertmanager'] = { cmd: ALERTMANAGER_EXEC, user: 'alertmanager', comm: 'alertmanager' }
SERVICE_PROCS['grafana-server'] = { cmd: '/usr/share/grafana/bin/grafana server --config=/etc/grafana/grafana.ini --pidfile=/run/grafana/grafana-server.pid cfg:default.paths.logs=/var/log/grafana cfg:default.paths.data=/var/lib/grafana cfg:default.paths.provisioning=/etc/grafana/provisioning', user: 'grafana', comm: 'grafana' }
SERVICE_PROCS['loki'] = { cmd: '/usr/bin/loki -config.file /etc/loki/config.yml', user: 'loki', comm: 'loki' }
SERVICE_PROCS['alloy'] = { cmd: '/usr/bin/alloy run --storage.path=/var/lib/alloy/data /etc/alloy/config.alloy', user: 'alloy', comm: 'alloy' }
SERVICE_PROCS['zabbix-agent2'] = { cmd: '/usr/sbin/zabbix_agent2 -c /etc/zabbix/zabbix_agent2.conf', user: 'zabbix', comm: 'zabbix_agent2' }

VENDOR_UNITS['grafana-server'] = `[Unit]\nDescription=Grafana instance\nDocumentation=http://docs.grafana.org\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nEnvironmentFile=-/etc/sysconfig/grafana-server\nUser=grafana\nGroup=grafana\nType=simple\nRestart=on-failure\nWorkingDirectory=/usr/share/grafana\nRuntimeDirectory=grafana\nExecStart=/usr/share/grafana/bin/grafana server --config=\${CONF_FILE} --pidfile=\${PID_FILE_DIR}/grafana-server.pid cfg:default.paths.provisioning=\${PROVISIONING_CFG_DIR}\n\n[Install]\nWantedBy=multi-user.target\n`
VENDOR_UNITS['loki'] = `[Unit]\nDescription=Loki service\nAfter=network.target\n\n[Service]\nType=simple\nUser=loki\nExecStart=/usr/bin/loki -config.file /etc/loki/config.yml\nTimeoutSec = 120\nRestart = on-failure\nRestartSec = 2\n\n[Install]\nWantedBy=multi-user.target\n`
VENDOR_UNITS['alloy'] = `[Unit]\nDescription=Vendor-agnostic OpenTelemetry Collector distribution with programmable pipelines\nDocumentation=https://grafana.com/docs/alloy\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nRestart=always\nUser=alloy\nEnvironment=HOSTNAME=%H\nEnvironment=ALLOY_DEPLOY_MODE=deb\nEnvironmentFile=/etc/default/alloy\nWorkingDirectory=/var/lib/alloy\nExecStart=/usr/bin/alloy run $CUSTOM_ARGS --storage.path=/var/lib/alloy/data $CONFIG_FILE\nExecReload=/usr/bin/env kill -HUP $MAINPID\nTimeoutStopSec=20s\nSendSIGKILL=no\n\n[Install]\nWantedBy=multi-user.target\n`
VENDOR_UNITS['zabbix-agent2'] = `[Unit]\nDescription=Zabbix Agent 2\nAfter=syslog.target\nAfter=network.target\n\n[Service]\nEnvironment="CONFFILE=/etc/zabbix/zabbix_agent2.conf"\nType=simple\nRestart=on-failure\nPIDFile=/run/zabbix/zabbix_agent2.pid\nKillMode=control-group\nExecStart=/usr/sbin/zabbix_agent2 -c $CONFFILE\nExecStop=/bin/kill -SIGTERM $MAINPID\nRestartSec=10s\nUser=zabbix\nGroup=zabbix\n\n[Install]\nWantedBy=multi-user.target\n`

function chownTree(sys: System, path: string, user: string) {
  const u = sys.users.get(user)
  if (!u) return
  sys.vfs.mkdirp(path, ROOT_CRED)
  const n = sys.vfs.stat(path, ROOT_CRED)
  n.uid = u.uid
  n.gid = u.gid
}

System.installHooks['prometheus'] = (sys) => chownTree(sys, '/var/lib/prometheus', 'prometheus')
System.installHooks['alertmanager'] = (sys) => chownTree(sys, '/var/lib/alertmanager', 'alertmanager')
System.installHooks['loki'] = (sys) => chownTree(sys, '/var/lib/loki', 'loki')
System.installHooks['grafana'] = (sys) => chownTree(sys, '/var/lib/grafana', 'grafana')
System.installHooks['alloy'] = (sys) => {
  chownTree(sys, '/var/lib/alloy', 'alloy')
  // Como el paquete real: el usuario alloy entra a los grupos que pueden leer logs y el journal.
  if (!sys.groups.has('systemd-journal')) sys.addGroup('systemd-journal', 190)
  for (const g of ['adm', 'systemd-journal']) {
    const grp = sys.groups.get(g)
    if (grp && !grp.members.includes('alloy')) grp.members.push('alloy')
  }
}
System.installHooks['zabbix-agent2'] = (sys) => chownTree(sys, '/run/zabbix', 'zabbix')

// ---------------------------------------------------------------------------------------
// node_exporter
// ---------------------------------------------------------------------------------------

function rootFs(sys: System): { dev: string; fstype: string; size: number; used: number } {
  const st = sys.storage
  const m = st.mounts.find((x) => x.target === '/' && x.dev)
  if (m && m.dev) return { dev: m.source, fstype: m.fstype, size: st.sigs.get(m.dev)?.size ?? 50 * 1024 ** 3, used: st.used(m.dev) }
  return { dev: '/dev/sda2', fstype: 'xfs', size: 50 * 1024 ** 3, used: 20 * 1024 ** 3 }
}

function nodeExporterListen(sys: System): number | undefined {
  const p = procOf(sys, 'node_exporter')
  if (!p) return undefined
  const l = argVal(p.cmd, '--web.listen-address') ?? ':9100'
  return Number(l.split(':').pop()) || 9100
}

function nodeMetricsText(sys: System): string {
  const m = metrics(sys)
  const fs = rootFs(sys)
  const now = obsNow(sys) / 1000
  const up = (now - sys.bootTime / 1000) || 86400
  const lines: string[] = []
  const h = (name: string, help: string, type: string) => lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
  h('node_boot_time_seconds', 'Node boot time, in unixtime.', 'gauge')
  lines.push(`node_boot_time_seconds ${(sys.bootTime / 1000).toFixed(0)}`)
  h('node_cpu_seconds_total', 'Seconds the CPUs spent in each mode.', 'counter')
  for (let c = 0; c < sys.ncpu; c++) {
    for (const [mode, pct] of [['idle', m.id], ['iowait', m.wa], ['irq', 0], ['nice', m.ni], ['softirq', 0.1], ['steal', m.st], ['system', m.sy], ['user', m.us]] as const) lines.push(`node_cpu_seconds_total{cpu="${c}",mode="${mode}"} ${((up * pct) / 100).toFixed(2)}`)
  }
  h('node_exporter_build_info', 'A metric with a constant \'1\' value labeled by version, revision, branch, goversion from which node_exporter was built, and the goos and goarch for the build.', 'gauge')
  lines.push(`node_exporter_build_info{branch="HEAD",goarch="amd64",goos="linux",goversion="go1.25.3",revision="d5d7f8b",tags="unknown",version="${NODE_EXPORTER_VERSION}"} 1`)
  h('node_filesystem_avail_bytes', 'Filesystem space available to non-root users in bytes.', 'gauge')
  lines.push(`node_filesystem_avail_bytes{device="${fs.dev}",fstype="${fs.fstype}",mountpoint="/"} ${Math.max(0, fs.size - fs.used - fs.size * 0.02).toFixed(0)}`)
  h('node_filesystem_free_bytes', 'Filesystem free space in bytes.', 'gauge')
  lines.push(`node_filesystem_free_bytes{device="${fs.dev}",fstype="${fs.fstype}",mountpoint="/"} ${(fs.size - fs.used).toFixed(0)}`)
  h('node_filesystem_size_bytes', 'Filesystem size in bytes.', 'gauge')
  lines.push(`node_filesystem_size_bytes{device="${fs.dev}",fstype="${fs.fstype}",mountpoint="/"} ${fs.size.toFixed(0)}`)
  for (const [n, v] of [['node_load1', m.load[0]], ['node_load5', m.load[1]], ['node_load15', m.load[2]]] as const) {
    h(n, `${n.slice(9)}m load average.`, 'gauge')
    lines.push(`${n} ${v.toFixed(2)}`)
  }
  h('node_memory_MemAvailable_bytes', 'Memory information field MemAvailable_bytes.', 'gauge')
  lines.push(`node_memory_MemAvailable_bytes ${(m.availKb * 1024).toFixed(0)}`)
  h('node_memory_MemFree_bytes', 'Memory information field MemFree_bytes.', 'gauge')
  lines.push(`node_memory_MemFree_bytes ${(m.memFreeKb * 1024).toFixed(0)}`)
  h('node_memory_MemTotal_bytes', 'Memory information field MemTotal_bytes.', 'gauge')
  lines.push(`node_memory_MemTotal_bytes ${(sys.memTotalKb * 1024).toFixed(0)}`)
  const ifs = sys.interfaces.filter((i) => i.ip)
  h('node_network_receive_bytes_total', 'Network device statistic receive_bytes.', 'counter')
  for (const i of ifs) lines.push(`node_network_receive_bytes_total{device="${i.name}"} ${(up * 52_000).toFixed(0)}`)
  h('node_network_transmit_bytes_total', 'Network device statistic transmit_bytes.', 'counter')
  for (const i of ifs) lines.push(`node_network_transmit_bytes_total{device="${i.name}"} ${(up * 21_000).toFixed(0)}`)
  h('node_systemd_unit_state', 'Systemd unit', 'gauge')
  for (const [name, s] of [...sys.services].slice(0, 12)) for (const state of ['active', 'failed', 'inactive']) lines.push(`node_systemd_unit_state{name="${name}.service",state="${state}",type="simple"} ${(state === 'active' ? s.active : state === 'failed' ? s.failed : !s.active && !s.failed) ? 1 : 0}`)
  h('node_time_seconds', 'System time in seconds since epoch (1970).', 'gauge')
  lines.push(`node_time_seconds ${now.toFixed(3)}`)
  h('node_uname_info', 'Labeled system information as provided by the uname system call.', 'gauge')
  lines.push(`node_uname_info{domainname="(none)",machine="x86_64",nodename="${sys.hostname}",release="${sys.distro === 'rocky' ? '6.12.0-55.12.1.el10_0.x86_64' : '6.8.0-88-generic'}",sysname="Linux",version="#1 SMP PREEMPT_DYNAMIC"} 1`)
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------------------
// Prometheus: configuración y reglas
// ---------------------------------------------------------------------------------------

interface Target {
  target: string
  labels: Labels
}
interface Job {
  name: string
  interval: number
  metricsPath: string
  scheme: string
  targets: Target[]
}
export interface PromConfig {
  scrapeInterval: number
  evalInterval: number
  jobs: Job[]
  ruleFiles: string[]
  alertmanagers: string[]
  externalLabels: Labels
}
export interface Rule {
  kind: 'alert' | 'record'
  name: string
  expr: string
  node: PromNode
  for: number
  labels: Labels
  annotations: Labels
  group: string
  file: string
}

const TOP = ['global', 'alerting', 'rule_files', 'scrape_configs', 'scrape_config_files', 'remote_write', 'remote_read', 'storage', 'tracing', 'otlp', 'runtime']
const GLOBAL = ['scrape_interval', 'scrape_timeout', 'evaluation_interval', 'external_labels', 'query_log_file', 'scrape_failure_log_file', 'scrape_protocols', 'rule_query_offset', 'body_size_limit', 'sample_limit', 'label_limit']
const SCRAPE = ['job_name', 'scrape_interval', 'scrape_timeout', 'metrics_path', 'scheme', 'static_configs', 'file_sd_configs', 'honor_labels', 'honor_timestamps', 'params', 'relabel_configs', 'metric_relabel_configs', 'basic_auth', 'authorization', 'tls_config', 'follow_redirects', 'sample_limit', 'bearer_token', 'scrape_protocols', 'enable_compression', 'fallback_scrape_protocol']

export function parsePromConfig(text: string, file: string): { cfg?: PromConfig; error?: string } {
  const pre = `parsing YAML file ${file}: `
  const y = loadYaml(text)
  if (y.error) return { error: pre + y.error }
  const d = (y.data ?? {}) as Obj
  if (!isObj(d)) return { error: `${pre}yaml: unmarshal errors:\n  line 1: cannot unmarshal !!str into config.plain` }
  const uf = unknownFields(text, d, TOP, 'config.plain')
  if (uf) return { error: pre + uf }
  const g = (d.global ?? {}) as Obj
  const ug = unknownFields(text, g, GLOBAL, 'config.GlobalConfig')
  if (ug) return { error: pre + ug }
  const si = durationOf(g.scrape_interval, 60)
  if (typeof si === 'string') return { error: pre + si }
  const ei = durationOf(g.evaluation_interval, 60)
  if (typeof ei === 'string') return { error: pre + ei }
  const jobs: Job[] = []
  const names = new Set<string>()
  for (const sc of (d.scrape_configs as unknown[]) ?? []) {
    if (!isObj(sc)) continue
    const us = unknownFields(text, sc, SCRAPE, 'config.ScrapeConfig')
    if (us) return { error: pre + us }
    const name = String(sc.job_name ?? '')
    if (!name) return { error: 'job_name is empty' }
    if (names.has(name)) return { error: `found multiple scrape configs with job name "${name}"` }
    names.add(name)
    const iv = durationOf(sc.scrape_interval, si)
    if (typeof iv === 'string') return { error: pre + iv }
    const targets: Target[] = []
    for (const s of (sc.static_configs as unknown[]) ?? []) {
      if (!isObj(s)) continue
      const ut = unknownFields(text, s, ['targets', 'labels'], 'struct { Targets []string "yaml:\\"targets\\""; Labels model.LabelSet "yaml:\\"labels\\"" }')
      if (ut) return { error: pre + ut }
      for (const t of (s.targets as unknown[]) ?? []) {
        const tt = String(t)
        if (/^\w+:\/\//.test(tt) || tt.includes('/')) return { error: `"${tt}" is not a valid hostname` }
        targets.push({ target: tt, labels: Object.fromEntries(Object.entries((s.labels as Obj) ?? {}).map(([k, v]) => [k, String(v)])) })
      }
    }
    jobs.push({ name, interval: iv, metricsPath: String(sc.metrics_path ?? '/metrics'), scheme: String(sc.scheme ?? 'http'), targets })
  }
  const ams: string[] = []
  const al = (d.alerting ?? {}) as Obj
  for (const a of (al.alertmanagers as unknown[]) ?? []) {
    if (!isObj(a)) continue
    for (const s of (a.static_configs as unknown[]) ?? []) if (isObj(s)) for (const t of (s.targets as unknown[]) ?? []) ams.push(String(t))
  }
  const rf = d.rule_files
  if (rf !== undefined && rf !== null && !Array.isArray(rf)) return { error: `${pre}yaml: unmarshal errors:\n  line ${lineOfKey(text, 'rule_files')}: cannot unmarshal !!str \`${String(rf)}\` into []string` }
  return {
    cfg: {
      scrapeInterval: si,
      evalInterval: ei,
      jobs,
      ruleFiles: ((rf as unknown[]) ?? []).map(String),
      alertmanagers: ams,
      externalLabels: Object.fromEntries(Object.entries((g.external_labels as Obj) ?? {}).map(([k, v]) => [k, String(v)])),
    },
  }
}

export interface RuleFileResult {
  file: string
  count: number
  error?: string
  rules: Rule[]
}

export function parseRuleFile(text: string, file: string): RuleFileResult {
  const y = loadYaml(text)
  if (y.error) return { file, count: 0, error: `${file}: ${y.error}`, rules: [] }
  const d = (y.data ?? {}) as Obj
  const uf = unknownFields(text, d, ['groups'], 'rulefmt.RuleGroups')
  if (uf) return { file, count: 0, error: `${file}: ${uf}`, rules: [] }
  const rules: Rule[] = []
  const groups = (d.groups as unknown[]) ?? []
  const seenGroups = new Set<string>()
  for (const g of groups) {
    if (!isObj(g)) continue
    const gname = String(g.name ?? '')
    if (!gname) return { file, count: 0, error: `${file}: Groupname must not be empty`, rules: [] }
    if (seenGroups.has(gname)) return { file, count: 0, error: `${file}: ${lineOfKey(text, 'name')}:${1}: groupname: "${gname}" is repeated in the same file`, rules: [] }
    seenGroups.add(gname)
    const ug = unknownFields(text, g, ['name', 'interval', 'rules', 'limit', 'query_offset', 'labels'], 'rulefmt.RuleGroup')
    if (ug) return { file, count: 0, error: `${file}: ${ug}`, rules: [] }
    ;((g.rules as unknown[]) ?? []).forEach((r, i) => {
      if (!isObj(r)) return
      const name = String(r.alert ?? r.record ?? '')
      const where = `${file}: group "${gname}", rule ${i + 1}, "${name}"`
      const ur = unknownFields(text, r, ['alert', 'record', 'expr', 'for', 'keep_firing_for', 'labels', 'annotations'], 'rulefmt.Rule')
      if (ur) throw new Error(`${file}: ${ur}`)
      if (r.alert === undefined && r.record === undefined) throw new Error(`${where}: one of 'record' or 'alert' must be set`)
      if (r.alert !== undefined && r.record !== undefined) throw new Error(`${where}: only one of 'record' and 'alert' must be set`)
      if (r.expr === undefined || r.expr === '') throw new Error(`${where}: field 'expr' must be set in rule`)
      if (r.record !== undefined && (r.annotations || r.for)) throw new Error(`${where}: invalid field 'annotations' in recording rule`)
      let node: PromNode
      try {
        node = parsePromQL(String(r.expr))
      } catch (e) {
        throw new Error(`${file}:${lineOfKey(text, 'expr', lineOfKey(text, r.alert !== undefined ? 'alert' : 'record') - 1)}:15: group "${gname}", rule ${i + 1}, "${name}": could not parse expression: ${(e as Error).message}`, { cause: e })
      }
      const fd = durationOf(r.for, 0)
      if (typeof fd === 'string') throw new Error(`${where}: ${fd}`)
      rules.push({
        kind: r.alert !== undefined ? 'alert' : 'record',
        name,
        expr: String(r.expr),
        node,
        for: fd,
        labels: Object.fromEntries(Object.entries((r.labels as Obj) ?? {}).map(([k, v]) => [k, String(v)])),
        annotations: Object.fromEntries(Object.entries((r.annotations as Obj) ?? {}).map(([k, v]) => [k, String(v)])),
        group: gname,
        file,
      })
    })
  }
  return { file, count: rules.length, rules }
}

function safeRules(text: string, file: string): RuleFileResult {
  try {
    return parseRuleFile(text, file)
  } catch (e) {
    return { file, count: 0, error: (e as Error).message, rules: [] }
  }
}

function dirOf(p: string): string {
  return p.slice(0, p.lastIndexOf('/')) || '/'
}

function ruleFilesOf(sys: System, cfg: PromConfig, cfgPath: string): string[] {
  return cfg.ruleFiles.flatMap((pat) => globFiles(sys, pat.startsWith('/') ? pat : `${dirOf(cfgPath)}/${pat}`))
}

interface PromRt {
  configPath: string
  cfg: PromConfig
  rules: Rule[]
  lifecycle: boolean
  remoteWrite: boolean
  port: number
  loadedAt: number
}
const PROM = new WeakMap<System, PromRt>()

function loadProm(sys: System, cmd: string): PromRt | { error: string } {
  const configPath = argVal(cmd, '--config.file') ?? 'prometheus.yml'
  const textCfg = read(sys, configPath)
  if (textCfg === undefined) return { error: `open ${configPath}: no such file or directory` }
  const r = parsePromConfig(textCfg, configPath)
  if (!r.cfg) return { error: r.error! }
  const rules: Rule[] = []
  for (const f of ruleFilesOf(sys, r.cfg, configPath)) {
    const rr = safeRules(read(sys, f) ?? '', f)
    if (rr.error) return { error: `error loading rules, previous rule set restored: ${rr.error}` }
    rules.push(...rr.rules)
  }
  const listen = argVal(cmd, '--web.listen-address') ?? '0.0.0.0:9090'
  return { configPath, cfg: r.cfg, rules, lifecycle: /--web\.enable-lifecycle/.test(cmd), remoteWrite: /--web\.enable-remote-write-receiver/.test(cmd), port: Number(listen.split(':').pop()) || 9090, loadedAt: obsNow(sys) }
}

EXEC_CHECKS['prometheus'] = (ctx, cmd) => {
  const r = loadProm(ctx.sys, cmd)
  if ('error' in r) return { status: '1/FAILURE', lines: [slog('ERROR', 'main.go:648', `Error loading config (--config.file=${argVal(cmd, '--config.file') ?? 'prometheus.yml'})`, `file=${argVal(cmd, '--config.file') ?? 'prometheus.yml'} err=${JSON.stringify(r.error)}`)] }
  PROM.set(ctx.sys, r)
  return undefined
}

function promRt(sys: System): PromRt | undefined {
  const p = procOf(sys, 'prometheus')
  if (!p) return undefined
  let rt = PROM.get(sys)
  if (!rt) {
    const r = loadProm(sys, p.cmd)
    if ('error' in r) return undefined
    PROM.set(sys, (rt = r))
  }
  return rt
}

// ---------------------------------------------------------------------------------------
// Prometheus: objetivos, historia y reglas
// ---------------------------------------------------------------------------------------

export interface TargetState {
  job: string
  target: string
  labels: Labels
  url: string
  health: 'up' | 'down'
  lastError: string
  kind: string
  host?: System
  interval: number
}

function kindOf(body: string): string {
  for (const k of ['node_exporter', 'prometheus', 'alertmanager', 'loki', 'alloy', 'grafana']) if (body.includes(`${k}_build_info`)) return k
  return 'otro'
}

function scrape(sys: System, rt: PromRt): TargetState[] {
  const out: TargetState[] = []
  for (const j of rt.cfg.jobs) {
    for (const t of j.targets) {
      const url = `${j.scheme}://${t.target}${j.metricsPath}`
      const r = fetchHttp(sys, url, { userAgent: `Prometheus/${PROMETHEUS_VERSION}` })
      const labels: Labels = { instance: t.target, job: j.name, ...t.labels }
      if (!r.ok) {
        out.push({ job: j.name, target: t.target, labels, url, health: 'down', lastError: goDialError(r, url), kind: 'otro', interval: j.interval })
        continue
      }
      if (r.res.status !== 200) {
        out.push({ job: j.name, target: t.target, labels, url, health: 'down', lastError: `server returned HTTP status ${r.res.status} ${r.res.status === 404 ? 'Not Found' : 'Error'}`, kind: 'otro', interval: j.interval })
        continue
      }
      out.push({ job: j.name, target: t.target, labels, url, health: 'up', lastError: '', kind: kindOf(r.res.body), host: hostByIp(sys, r.ip), interval: j.interval })
    }
  }
  return out
}

/** Hace cuánto está caído un objetivo (desde que se paró su servicio o se apagó el equipo). */
function downMinutes(sys: System, t: TargetState): number {
  const port = Number(t.target.split(':').pop())
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(t.target.split(':')[0]) ? t.target.split(':')[0] : sys.resolveHost(t.target.split(':')[0])
  const host = ip ? hostByIp(sys, ip) : undefined
  const svc = host ? [...host.services.values()].find((s) => s.ports.includes(port)) : undefined
  const since = svc && !svc.active ? svc.since : undefined
  return since ? Math.max(1, (obsNow(sys) - since) / 60000) : 5
}

function nodeSpecFor(t: TargetState): NodeSpec {
  const h = t.host!
  const m = metrics(h)
  const fs = rootFs(h)
  const { instance, job, ...extra } = t.labels
  return {
    instancia: instance,
    job,
    cpus: h.ncpu,
    memoria_gb: h.memTotalKb / 1024 / 1024,
    carga: Math.min(0.98, (m.us + m.sy + m.wa) / 100),
    memoria_usada: Math.min(0.98, m.memUsedKb / h.memTotalKb),
    disco_gb: fs.size / 1024 ** 3,
    disco_usado: fs.used / fs.size,
    etiquetas: extra,
  }
}

interface PromData {
  db: Tsdb
  targets: TargetState[]
}
const PROM_DATA = new WeakMap<System, { key: string; data: PromData }>()

function alloyRemoteWriters(sys: System, rt: PromRt): NodeSpec[] {
  if (!rt.remoteWrite) return []
  const out: NodeSpec[] = []
  for (const h of [sys, ...sys.lab]) {
    const a = alloyRt(h)
    if (!a) continue
    for (const m of a.plan.metrics) {
      if (!m.urls.some((u) => pointsTo(h, u, sys, rt.port, '/api/v1/write'))) continue
      out.push({ instancia: m.instance, job: m.job, cpus: h.ncpu, memoria_gb: h.memTotalKb / 1024 / 1024, disco_gb: rootFs(h).size / 1024 ** 3, disco_usado: rootFs(h).used / rootFs(h).size })
    }
  }
  return out
}

/** La historia de las métricas que ve este Prometheus (se rehace cada 30 segundos o si cambia algo). */
export function promData(sys: System): PromData | undefined {
  const rt = promRt(sys)
  if (!rt) return undefined
  const targets = scrape(sys, rt)
  const writers = alloyRemoteWriters(sys, rt)
  const now = obsNow(sys)
  const key = JSON.stringify([rt.loadedAt, targets.map((t) => [t.target, t.health, t.kind]), writers.map((w) => w.instancia), Math.floor(now / 30000)])
  const cached = PROM_DATA.get(sys)
  if (cached?.key === key) return cached.data
  const st = STATE.get(sys)?.metricas
  const nodos: NodeSpec[] = []
  const series: SeriesSpec[] = [...(st?.series ?? [])]
  const http: HttpSpec[] = [...(st?.http ?? [])]
  for (const t of targets) {
    if (t.kind === 'node_exporter' && t.host) {
      const base = nodeSpecFor(t)
      const over = st?.nodos?.find((n) => n.instancia === base.instancia)
      nodos.push({ ...base, ...(over ?? {}), etiquetas: { ...base.etiquetas, ...(over?.etiquetas ?? {}) } })
      continue
    }
    const { instance, job, ...extra } = t.labels
    if (t.health === 'down') {
      const over = st?.nodos?.find((n) => n.instancia === instance)
      if (over || /9100$/.test(t.target)) {
        nodos.push({ instancia: instance, job, etiquetas: extra, ...(over ?? {}), eventos: [...(over?.eventos ?? []), { desde: `-${Math.round(downMinutes(sys, t))}m`, caido: true }] })
        continue
      }
      series.push({ nombre: 'up', etiquetas: t.labels, valor: 1, eventos: [{ desde: `-${Math.round(downMinutes(sys, t))}m`, valor: 0 }] })
      continue
    }
    series.push({ nombre: 'up', etiquetas: { instance, job, ...extra }, valor: 1 })
    if (t.kind !== 'otro') series.push({ nombre: `${t.kind}_build_info`, etiquetas: { instance, job, version: { prometheus: PROMETHEUS_VERSION, alertmanager: ALERTMANAGER_VERSION, loki: LOKI_VERSION, alloy: ALLOY_VERSION, grafana: GRAFANA_VERSION, node_exporter: NODE_EXPORTER_VERSION }[t.kind] ?? '' }, valor: 1 })
  }
  for (const w of writers) if (!nodos.some((n) => n.instancia === w.instancia)) nodos.push(w)
  for (const n of st?.nodos ?? []) if (!nodos.some((x) => x.instancia === n.instancia) && !targets.some((t) => t.labels.instance === n.instancia)) continue
  const step = Math.min(60, rt.cfg.scrapeInterval)
  const db = buildTsdb({ ahora: new Date(now).toISOString(), ventana: st?.ventana ?? '3h', paso: `${step}s`, semilla: st?.semilla, nodos, series, http })
  // Reglas de grabación: quedan como series nuevas.
  const engine = new Engine(db)
  for (const r of rt.rules.filter((x) => x.kind === 'record')) {
    try {
      const res = rangeQuery(db, r.expr, db.start, db.end, rt.cfg.evalInterval)
      for (const s of res.series) db.series.push({ labels: { ...s.labels, ...r.labels, __name__: r.name }, samples: s.samples })
    } catch {
      // una regla que falla al evaluarse no se graba (Prometheus lo deja en el log)
    }
  }
  void engine
  const data = { db, targets }
  PROM_DATA.set(sys, { key, data })
  return data
}

export interface AlertInstance {
  labels: Labels
  annotations: Labels
  value: number
  activeAt: number
  state: 'pending' | 'firing'
}
export interface RuleState {
  rule: Rule
  state: 'inactive' | 'pending' | 'firing'
  alerts: AlertInstance[]
  health: 'ok' | 'err'
  lastError?: string
}

function humanize(v: number): string {
  const a = Math.abs(v)
  for (const [f, u] of [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k']] as const) if (a >= f) return `${+(v / f).toPrecision(4)}${u}`
  return String(+v.toPrecision(4))
}

/** Plantillas de las anotaciones: {{ $labels.x }}, {{ $value }}, humanize, humanizePercentage, printf. */
export function expandTemplate(tpl: string, labels: Labels, value: number): string {
  return tpl.replace(/\{\{-?\s*(.*?)\s*-?\}\}/g, (_m, inner: string) => {
    const pf = /^printf\s+"([^"]*)"\s+\$value$/.exec(inner)
    if (pf) return pf[1].replace(/%\.?(\d*)f/, (_x, d) => value.toFixed(d ? Number(d) : 6)).replace('%d', String(Math.round(value))).replace('%v', fmt(value))
    const [head, ...fns] = inner.split('|').map((x) => x.trim())
    let v: string
    let n = value
    if (head === '$value' || head === '.Value') v = fmt(value)
    else {
      const m = /^\$labels\.(\w+)$|^\.Labels\.(\w+)$/.exec(head)
      v = m ? (labels[m[1] ?? m[2]] ?? '') : ''
      n = Number(v)
    }
    for (const f of fns) {
      if (f === 'humanize') v = humanize(n)
      else if (f === 'humanizePercentage') v = `${+(n * 100).toPrecision(4)}%`
      else if (f === 'humanizeDuration') v = formatDuration(Math.round(n))
      else if (/^printf/.test(f)) v = f.includes('%.') ? n.toFixed(Number(/%\.(\d+)f/.exec(f)?.[1] ?? 2)) : v
    }
    return v
  })
}

function sameSeries(a: Labels, b: Labels): boolean {
  const ka = Object.keys(a).filter((k) => k !== '__name__')
  return ka.length === Object.keys(b).filter((k) => k !== '__name__').length && ka.every((k) => a[k] === b[k])
}

/** Evalúa las reglas de alerta: activa desde cuándo, pendiente o disparada según "for". */
export function evalAlertRules(db: Tsdb, rules: Rule[], now: number, step: number, extLabels: Labels = {}): RuleState[] {
  const engine = new Engine(db)
  const out: RuleState[] = []
  for (const r of rules.filter((x) => x.kind === 'alert')) {
    let v: VSample[]
    try {
      const res = engine.eval(r.node, now)
      v = res.type === 'vector' ? res.v : res.type === 'scalar' ? [{ labels: {}, v: res.v }] : []
    } catch (e) {
      out.push({ rule: r, state: 'inactive', alerts: [], health: 'err', lastError: (e as Error).message })
      continue
    }
    const alerts: AlertInstance[] = []
    for (const s of v) {
      let since = now
      const limit = now - Math.max(r.for, step) - 4 * step
      for (let t = now - step; t >= limit; t -= step) {
        let back: VSample[]
        try {
          const res = engine.eval(r.node, t)
          back = res.type === 'vector' ? res.v : []
        } catch {
          break
        }
        if (!back.some((b) => sameSeries(b.labels, s.labels))) break
        since = t
      }
      const { __name__: _n, ...base } = s.labels
      const labels: Labels = { ...base, ...Object.fromEntries(Object.entries(r.labels).map(([k, val]) => [k, expandTemplate(val, base, s.v)])), alertname: r.name, ...extLabels }
      const annotations = Object.fromEntries(Object.entries(r.annotations).map(([k, val]) => [k, expandTemplate(val, base, s.v)]))
      alerts.push({ labels, annotations, value: s.v, activeAt: since, state: now - since >= r.for ? 'firing' : 'pending' })
    }
    const state = alerts.some((a) => a.state === 'firing') ? 'firing' : alerts.length ? 'pending' : 'inactive'
    out.push({ rule: r, state, alerts, health: 'ok' })
  }
  return out
}

export function promAlerts(sys: System): RuleState[] {
  const rt = promRt(sys)
  const data = promData(sys)
  if (!rt || !data) return []
  return evalAlertRules(data.db, rt.rules, obsNow(sys) / 1000, rt.cfg.evalInterval, rt.cfg.externalLabels)
}

// ---------------------------------------------------------------------------------------
// Prometheus: HTTP
// ---------------------------------------------------------------------------------------

const promVal = (v: number) => fmt(v)

function vectorJson(v: { labels: Labels; v: number }[], t: number) {
  return v.map((s) => ({ metric: s.labels, value: [t, promVal(s.v)] }))
}

function promHttp(sys: System, rt: PromRt, req: HttpRequest): HttpResponse {
  const p = pathOnly(req.path)
  const q = queryParams(req.path)
  if (req.method === 'POST' && req.headers['content-type']?.includes('x-www-form-urlencoded')) for (const [k, v] of new URLSearchParams(req.body)) q.set(k, v)
  if (p === '/-/healthy') return text(200, 'Prometheus Server is Healthy.\n')
  if (p === '/-/ready') return text(200, 'Prometheus Server is Ready.\n')
  if (p === '/-/reload' || p === '/-/quit') {
    if (!rt.lifecycle) return text(403, 'Lifecycle API is not enabled.\n')
    if (req.method !== 'POST' && req.method !== 'PUT') return text(405, 'Only POST or PUT requests allowed\n')
    const proc = procOf(sys, 'prometheus')!
    const r = loadProm(sys, proc.cmd)
    if ('error' in r) return text(500, `failed to reload config: ${r.error}\n`)
    PROM.set(sys, r)
    return text(200, '')
  }
  if (p === '/metrics') return text(200, `# HELP prometheus_build_info A metric with a constant '1' value labeled by version, revision, branch, goversion from which prometheus was built, and the goos and goarch for the build.\n# TYPE prometheus_build_info gauge\nprometheus_build_info{branch="HEAD",goarch="amd64",goos="linux",goversion="go1.25.3",revision="3f1c2a9",tags="netgo,builtinassets",version="${PROMETHEUS_VERSION}"} 1\n# HELP prometheus_config_last_reload_successful Whether the last configuration reload attempt was successful.\n# TYPE prometheus_config_last_reload_successful gauge\nprometheus_config_last_reload_successful 1\n`, 'text/plain; version=0.0.4; charset=utf-8')
  if (p === '/api/v1/status/buildinfo') return json(200, { status: 'success', data: { version: PROMETHEUS_VERSION, revision: '3f1c2a9', branch: 'HEAD', goVersion: 'go1.25.3' } })
  if (p === '/api/v1/status/config') return json(200, { status: 'success', data: { yaml: read(sys, rt.configPath) ?? '' } })
  if (p === '/api/v1/write') {
    if (!rt.remoteWrite) return text(404, 'remote write receiver needs to be enabled with --web.enable-remote-write-receiver\n')
    return { status: 204, headers: [], body: '' }
  }
  const data = promData(sys)!
  if (p === '/api/v1/targets') {
    return json(200, {
      status: 'success',
      data: {
        activeTargets: data.targets.map((t) => ({
          discoveredLabels: { __address__: t.target, __metrics_path__: t.url.replace(/^https?:\/\/[^/]+/, ''), __scheme__: t.url.split(':')[0], job: t.job },
          labels: t.labels,
          scrapePool: t.job,
          scrapeUrl: t.url,
          globalUrl: t.url,
          lastError: t.lastError,
          lastScrape: new Date(obsNow(sys) - 4000).toISOString(),
          lastScrapeDuration: t.health === 'up' ? 0.0042 : 0,
          health: t.health,
          scrapeInterval: formatDuration(t.interval),
          scrapeTimeout: '10s',
        })),
        droppedTargets: [],
        droppedTargetCounts: Object.fromEntries(rt.cfg.jobs.map((j) => [j.name, 0])),
      },
    })
  }
  if (p === '/api/v1/rules' || p === '/api/v1/alerts') {
    const states = promAlerts(sys)
    if (p === '/api/v1/alerts') return json(200, { status: 'success', data: { alerts: states.flatMap((s) => s.alerts.map((a) => ({ labels: a.labels, annotations: a.annotations, state: a.state, activeAt: new Date(a.activeAt * 1000).toISOString(), value: String(a.value) }))) } })
    const groups = new Map<string, { name: string; file: string; rules: unknown[]; interval: number }>()
    for (const r of rt.rules) {
      const k = `${r.file}::${r.group}`
      if (!groups.has(k)) groups.set(k, { name: r.group, file: r.file, rules: [], interval: rt.cfg.evalInterval })
      const st = states.find((s) => s.rule === r)
      groups.get(k)!.rules.push(r.kind === 'alert' ? { state: st?.state ?? 'inactive', name: r.name, query: r.expr, duration: r.for, labels: r.labels, annotations: r.annotations, alerts: (st?.alerts ?? []).map((a) => ({ labels: a.labels, annotations: a.annotations, state: a.state, activeAt: new Date(a.activeAt * 1000).toISOString(), value: String(a.value) })), health: st?.health ?? 'ok', type: 'alerting' } : { name: r.name, query: r.expr, labels: r.labels, health: 'ok', type: 'recording' })
    }
    return json(200, { status: 'success', data: { groups: [...groups.values()] } })
  }
  if (p === '/api/v1/query' || p === '/api/v1/query_range') {
    const query = q.get('query') ?? ''
    if (!query) return json(400, { status: 'error', errorType: 'bad_data', error: 'invalid parameter "query": unknown position: parse error: no expression found in input' })
    try {
      if (p === '/api/v1/query') {
        const t = q.get('time') ? Number(q.get('time')) : data.db.end
        const r = instantQuery(data.db, query, t)
        const v = r.value
        const result = v.type === 'vector' ? vectorJson(v.v, t) : v.type === 'scalar' ? [t, promVal(v.v)] : v.type === 'string' ? [t, v.v] : v.v.map((s) => ({ metric: s.labels, values: s.samples.map((x) => [x.t, promVal(x.v)]) }))
        return json(200, { status: 'success', data: { resultType: v.type, result } })
      }
      const start = Number(q.get('start') ?? data.db.end - 3600)
      const end = Number(q.get('end') ?? data.db.end)
      const step = parseDuration(q.get('step') ?? '60s') ?? Number(q.get('step') ?? 60)
      const r = rangeQuery(data.db, query, start, end, step)
      return json(200, { status: 'success', data: { resultType: 'matrix', result: r.series.map((s) => ({ metric: s.labels, values: s.samples.map((x) => [x.t, promVal(x.v)]) })) } })
    } catch (e) {
      return json(400, { status: 'error', errorType: 'bad_data', error: `invalid parameter "query": ${(e as Error).message}` })
    }
  }
  if (p === '/' || p === '/query' || p === '/graph') return text(p === '/' ? 302 : 200, p === '/' ? '<a href="/query">Found</a>.\n' : '<!doctype html><html><head><title>Prometheus Time Series Collection and Processing Server</title></head><body>…</body></html>\n', 'text/html; charset=utf-8')
  return text(404, '404 page not found\n')
}

// ---------------------------------------------------------------------------------------
// Alertmanager
// ---------------------------------------------------------------------------------------

interface AmMatcher {
  name: string
  op: '=' | '!=' | '=~' | '!~'
  value: string
}
interface AmRoute {
  receiver?: string
  groupBy: string[]
  matchers: AmMatcher[]
  routes: AmRoute[]
  cont: boolean
}
interface AmReceiver {
  name: string
  email: { to: string; from?: string; smarthost?: string }[]
  webhook: { url: string }[]
  other: number
}
interface AmConfig {
  smarthost?: string
  smtpFrom?: string
  route: AmRoute
  receivers: AmReceiver[]
  inhibitRules: number
}

function parseMatchers(r: Obj): AmMatcher[] {
  const out: AmMatcher[] = []
  for (const m of (r.matchers as unknown[]) ?? []) {
    const mm = /^\s*(\w+)\s*(=~|!~|!=|=)\s*"?([^"]*)"?\s*$/.exec(String(m))
    if (mm) out.push({ name: mm[1], op: mm[2] as AmMatcher['op'], value: mm[3] })
  }
  for (const [k, v] of Object.entries((r.match as Obj) ?? {})) out.push({ name: k, op: '=', value: String(v) })
  for (const [k, v] of Object.entries((r.match_re as Obj) ?? {})) out.push({ name: k, op: '=~', value: String(v) })
  return out
}

function parseRoute(r: Obj): AmRoute {
  return { receiver: r.receiver === undefined ? undefined : String(r.receiver), groupBy: ((r.group_by as unknown[]) ?? []).map(String), matchers: parseMatchers(r), routes: ((r.routes as unknown[]) ?? []).filter(isObj).map(parseRoute), cont: !!r.continue }
}

export function parseAmConfig(textCfg: string): { cfg?: AmConfig; error?: string } {
  const y = loadYaml(textCfg)
  if (y.error) return { error: y.error }
  const d = (y.data ?? {}) as Obj
  const uf = unknownFields(textCfg, d, ['global', 'route', 'receivers', 'inhibit_rules', 'templates', 'time_intervals', 'mute_time_intervals'], 'config.plain')
  if (uf) return { error: uf }
  const g = (d.global ?? {}) as Obj
  if (!isObj(d.route)) return { error: 'no routes provided' }
  const route = parseRoute(d.route)
  if (!route.receiver) return { error: 'root route must specify a default receiver' }
  if (route.matchers.length) return { error: 'root route must not have any matchers' }
  const receivers: AmReceiver[] = []
  const names = new Set<string>()
  for (const r of (d.receivers as unknown[]) ?? []) {
    if (!isObj(r)) continue
    const name = String(r.name ?? '')
    if (!name) return { error: 'missing name in receiver' }
    if (names.has(name)) return { error: `notification config name "${name}" is not unique` }
    names.add(name)
    const ur = unknownFields(textCfg, r, ['name', 'email_configs', 'webhook_configs', 'slack_configs', 'msteams_configs', 'msteamsv2_configs', 'telegram_configs', 'discord_configs', 'pagerduty_configs', 'opsgenie_configs', 'pushover_configs', 'sns_configs', 'victorops_configs', 'wechat_configs', 'webex_configs', 'jira_configs', 'rocketchat_configs'], 'config.Receiver')
    if (ur) return { error: ur }
    const email: AmReceiver['email'] = []
    for (const e of (r.email_configs as unknown[]) ?? []) {
      if (!isObj(e)) continue
      if (!e.to) return { error: 'missing to address in email config' }
      const smarthost = e.smarthost ? String(e.smarthost) : g.smtp_smarthost ? String(g.smtp_smarthost) : undefined
      if (!smarthost) return { error: 'no global SMTP smarthost set' }
      if (!e.from && !g.smtp_from) return { error: 'no global SMTP from set' }
      email.push({ to: String(e.to), from: e.from ? String(e.from) : String(g.smtp_from), smarthost })
    }
    const webhook: AmReceiver['webhook'] = []
    for (const w of (r.webhook_configs as unknown[]) ?? []) {
      if (!isObj(w)) continue
      if (!w.url && !w.url_file) return { error: 'one of url or url_file must be configured' }
      webhook.push({ url: String(w.url) })
    }
    const other = ['slack_configs', 'msteams_configs', 'msteamsv2_configs', 'telegram_configs', 'discord_configs'].reduce((n, k) => n + ((r[k] as unknown[]) ?? []).length, 0)
    receivers.push({ name, email, webhook, other })
  }
  const check = (rt: AmRoute): string | undefined => {
    if (rt.receiver && !names.has(rt.receiver)) return `undefined receiver "${rt.receiver}" used in route`
    for (const c of rt.routes) {
      const e = check(c)
      if (e) return e
    }
    return undefined
  }
  const e = check(route)
  if (e) return { error: e }
  return { cfg: { smarthost: g.smtp_smarthost ? String(g.smtp_smarthost) : undefined, smtpFrom: g.smtp_from ? String(g.smtp_from) : undefined, route, receivers, inhibitRules: ((d.inhibit_rules as unknown[]) ?? []).length } }
}

interface Silence {
  id: string
  matchers: AmMatcher[]
  endsAt: number
  comment: string
  createdBy: string
}
interface AmRt {
  path: string
  cfg: AmConfig
  port: number
  silences: Silence[]
  notified: Set<string>
  lastDispatch: number
}
const AM = new WeakMap<System, AmRt>()

function loadAm(sys: System, cmd: string, prev?: AmRt): AmRt | { error: string } {
  const path = argVal(cmd, '--config.file') ?? 'alertmanager.yml'
  const t = read(sys, path)
  if (t === undefined) return { error: `open ${path}: no such file or directory` }
  const r = parseAmConfig(t)
  if (!r.cfg) return { error: r.error! }
  const listen = argVal(cmd, '--web.listen-address') ?? ':9093'
  return { path, cfg: r.cfg, port: Number(listen.split(':').pop()) || 9093, silences: prev?.silences ?? [], notified: prev?.notified ?? new Set(), lastDispatch: 0 }
}

EXEC_CHECKS['alertmanager'] = (ctx, cmd) => {
  const r = loadAm(ctx.sys, cmd, AM.get(ctx.sys))
  if ('error' in r) return { status: '1/FAILURE', lines: [slog('ERROR', 'coordinator.go:117', 'Loading configuration file failed', `component=configuration file=${argVal(cmd, '--config.file') ?? 'alertmanager.yml'} err=${JSON.stringify(r.error)}`)] }
  AM.set(ctx.sys, r)
  return undefined
}

function amRt(sys: System): AmRt | undefined {
  const p = procOf(sys, 'alertmanager')
  if (!p) return undefined
  let rt = AM.get(sys)
  if (!rt) {
    const r = loadAm(sys, p.cmd)
    if ('error' in r) return undefined
    AM.set(sys, (rt = r))
  }
  return rt
}

/** Si la URL o el host:puerto de un equipo apunta a otro equipo y puerto (y llega por la red). */
function pointsTo(from: System, url: string, target: System, port: number, path?: string): boolean {
  const m = /^(?:https?:\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url.trim())
  if (!m) return false
  const p = Number(m[2] ?? (url.startsWith('https') ? 443 : 80))
  if (p !== port) return false
  if (path && m[3] && !m[3].startsWith(path)) return false
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(m[1]) ? m[1] : m[1] === 'localhost' ? '127.0.0.1' : from.resolveHost(m[1])
  if (!ip) return false
  if (hostByIp(from, ip) !== target) return false
  const r = reach(from, ip, port)
  return !('error' in r)
}

interface AmAlert {
  labels: Labels
  annotations: Labels
  startsAt: number
  generator: string
  silencedBy: string[]
}

function matchOne(m: AmMatcher, labels: Labels): boolean {
  const v = labels[m.name] ?? ''
  if (m.op === '=') return v === m.value
  if (m.op === '!=') return v !== m.value
  const re = new RegExp(`^(?:${m.value})$`)
  return m.op === '=~' ? re.test(v) : !re.test(v)
}

/** Alertas que recibe este Alertmanager: de los Prometheus y los Loki del laboratorio que apuntan a él. */
export function amAlerts(sys: System): AmAlert[] {
  const rt = amRt(sys)
  if (!rt) return []
  const now = obsNow(sys)
  const out: AmAlert[] = []
  for (const h of [sys, ...sys.lab]) {
    const pr = promRt(h)
    if (pr && pr.cfg.alertmanagers.some((t) => pointsTo(h, t, sys, rt.port))) {
      for (const s of promAlerts(h)) for (const a of s.alerts.filter((x) => x.state === 'firing')) out.push({ labels: a.labels, annotations: a.annotations, startsAt: a.activeAt * 1000, generator: `http://${h.hostname}:${pr.port}/graph`, silencedBy: [] })
    }
    const lk = lokiRt(h)
    if (lk?.alertmanagerUrl && pointsTo(h, lk.alertmanagerUrl, sys, rt.port)) {
      for (const s of lokiAlerts(h)) for (const a of s.alerts.filter((x) => x.state === 'firing')) out.push({ labels: a.labels, annotations: a.annotations, startsAt: a.activeAt * 1000, generator: `http://${h.hostname}:${lk.port}/explore`, silencedBy: [] })
    }
  }
  for (const a of out) a.silencedBy = rt.silences.filter((s) => s.endsAt > now && s.matchers.every((m) => matchOne(m, a.labels))).map((s) => s.id)
  return out
}

function routeFor(route: AmRoute, labels: Labels): AmRoute[] {
  const out: AmRoute[] = []
  for (const r of route.routes) {
    if (!r.matchers.every((m) => matchOne(m, labels))) continue
    const sub = routeFor({ ...r, receiver: r.receiver ?? route.receiver, groupBy: r.groupBy.length ? r.groupBy : route.groupBy }, labels)
    out.push(...(sub.length ? sub : [{ ...r, receiver: r.receiver ?? route.receiver, groupBy: r.groupBy.length ? r.groupBy : route.groupBy }]))
    if (!r.cont) return out
  }
  return out.length ? out : [route]
}

/** Manda las notificaciones de las alertas nuevas (correo por el Postfix del laboratorio, webhooks). */
function dispatch(sys: System) {
  const rt = amRt(sys)
  if (!rt) return
  const now = obsNow(sys)
  if (now - rt.lastDispatch < 15000) return
  rt.lastDispatch = now
  const alerts = amAlerts(sys).filter((a) => !a.silencedBy.length)
  const groups = new Map<string, { receiver: string; groupBy: string[]; alerts: AmAlert[] }>()
  for (const a of alerts) {
    for (const r of routeFor(rt.cfg.route, a.labels)) {
      const gl = r.groupBy.includes('...') ? a.labels : Object.fromEntries(r.groupBy.map((k) => [k, a.labels[k] ?? '']))
      const key = `${r.receiver}|${JSON.stringify(gl)}`
      if (!groups.has(key)) groups.set(key, { receiver: r.receiver!, groupBy: r.groupBy, alerts: [] })
      groups.get(key)!.alerts.push(a)
    }
  }
  for (const [key, g] of groups) {
    const fp = `${key}|${g.alerts.map((a) => JSON.stringify(a.labels)).sort().join(',')}`
    if (rt.notified.has(fp)) continue
    rt.notified.add(fp)
    const rec = rt.cfg.receivers.find((r) => r.name === g.receiver)
    if (!rec) continue
    const common = Object.fromEntries(Object.entries(g.alerts[0].labels).filter(([k, v]) => g.alerts.every((a) => a.labels[k] === v)))
    // Como la plantilla __subject de Alertmanager: las etiquetas del grupo y, entre paréntesis, el
    // resto de las comunes (las dos ordenadas por nombre de etiqueta).
    const groupKeys = g.groupBy.includes('...') ? Object.keys(g.alerts[0].labels) : g.groupBy.filter((k) => g.alerts[0].labels[k] !== undefined)
    const groupVals = [...groupKeys].sort().map((k) => g.alerts[0].labels[k])
    const rest = Object.keys(common).filter((k) => !groupKeys.includes(k)).sort().map((k) => common[k])
    const subject = `[FIRING:${g.alerts.length}] ${groupVals.join(' ')}${rest.length ? ` (${rest.join(' ')})` : ''}`
    const body = g.alerts.map((a) => `Labels:\n${Object.entries(a.labels).map(([k, v]) => ` - ${k} = ${v}`).join('\n')}\nAnnotations:\n${Object.entries(a.annotations).map(([k, v]) => ` - ${k} = ${v}`).join('\n')}\nSource: ${a.generator}\n`).join('\n')
    rec.email.forEach((e, i) => {
      const [host, port] = (e.smarthost ?? '').split(':')
      const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : host === 'localhost' ? '127.0.0.1' : sys.resolveHost(host)
      const target = ip ? hostByIp(sys, ip) : undefined
      const r = ip ? reach(sys, ip, Number(port) || 25) : { error: 'timeout' as const }
      const smtpOk = !!target && !('error' in r) && !!target.services.get('postfix')?.active
      if (!smtpOk) {
        const why = !ip ? `dial tcp: lookup ${host} on 127.0.0.53:53: no such host` : `dial tcp ${ip}:${port || 25}: connect: ${'error' in r && r.error === 'timeout' ? 'connection timed out' : 'connection refused'}`
        sys.journal.push({ time: Date.now(), unit: 'alertmanager.service', priority: 3, ident: 'alertmanager', message: slog('ERROR', 'dispatch.go:360', 'Notify for alerts failed', `component=dispatcher num_alerts=${g.alerts.length} err="${g.receiver}/email[${i}]: notify retry canceled after 3 attempts: establish connection to server: ${why}"`) })
        return
      }
      submit(target!, 0, e.from ?? 'alertmanager@localhost', [e.to], subject, body, `From: ${e.from}\nSubject: ${subject}\nX-Alertmanager: ${ALERTMANAGER_VERSION}\n`)
    })
    rec.webhook.forEach((w, i) => {
      const r = fetchHttp(sys, w.url, { method: 'POST', body: JSON.stringify({ version: '4', status: 'firing', receiver: g.receiver, alerts: g.alerts.map((a) => ({ status: 'firing', labels: a.labels, annotations: a.annotations })) }), headers: { 'content-type': 'application/json' } })
      if (!r.ok) sys.journal.push({ time: Date.now(), unit: 'alertmanager.service', priority: 3, ident: 'alertmanager', message: slog('ERROR', 'dispatch.go:360', 'Notify for alerts failed', `component=dispatcher num_alerts=${g.alerts.length} err="${g.receiver}/webhook[${i}]: notify retry canceled after 3 attempts: ${goDialError(r, w.url, 'Post')}"`) })
    })
  }
}

System.refreshHooks.push((sys) => {
  for (const h of [sys, ...sys.lab]) if (h.services.get('alertmanager')?.active) dispatch(h)
})

function amHttp(sys: System, rt: AmRt, req: HttpRequest): HttpResponse {
  const p = pathOnly(req.path)
  if (p === '/-/healthy' || p === '/-/ready') return text(200, 'OK')
  if (p === '/-/reload') {
    if (req.method !== 'POST') return text(405, 'Method Not Allowed\n')
    const r = loadAm(sys, procOf(sys, 'alertmanager')!.cmd, rt)
    if ('error' in r) return text(500, `failed to reload config: ${r.error}\n`)
    AM.set(sys, r)
    return text(200, '')
  }
  if (p === '/api/v2/status') return json(200, { cluster: { status: 'disabled' }, versionInfo: { version: ALERTMANAGER_VERSION }, config: { original: read(sys, rt.path) ?? '' }, uptime: new Date(sys.bootTime).toISOString() })
  if (p === '/api/v2/alerts' && req.method === 'GET') {
    dispatch(sys)
    return json(
      200,
      amAlerts(sys).map((a) => ({ labels: a.labels, annotations: a.annotations, startsAt: new Date(a.startsAt).toISOString(), endsAt: new Date(obsNow(sys) + 4 * 60000).toISOString(), generatorURL: a.generator, status: { state: a.silencedBy.length ? 'suppressed' : 'active', silencedBy: a.silencedBy, inhibitedBy: [] }, receivers: routeFor(rt.cfg.route, a.labels).map((r) => ({ name: r.receiver })) })),
    )
  }
  if (p === '/api/v2/alerts' && req.method === 'POST') return text(200, '')
  if (p === '/api/v2/silences') return json(200, rt.silences.map((s) => ({ id: s.id, matchers: s.matchers.map((m) => ({ name: m.name, value: m.value, isRegex: m.op.includes('~'), isEqual: !m.op.startsWith('!') })), endsAt: new Date(s.endsAt).toISOString(), comment: s.comment, createdBy: s.createdBy, status: { state: s.endsAt > obsNow(sys) ? 'active' : 'expired' } })))
  if (p === '/metrics') return text(200, `# HELP alertmanager_build_info A metric with a constant '1' value.\n# TYPE alertmanager_build_info gauge\nalertmanager_build_info{version="${ALERTMANAGER_VERSION}"} 1\n`)
  if (p === '/' || p.startsWith('/#')) return text(200, '<!doctype html><html><head><title>Alertmanager</title></head><body></body></html>\n', 'text/html')
  return text(404, '404 page not found\n')
}

// ---------------------------------------------------------------------------------------
// Grafana
// ---------------------------------------------------------------------------------------

interface Datasource {
  name: string
  type: string
  url: string
  uid: string
  isDefault: boolean
  access: string
  file: string
}
interface GrafanaRt {
  datasources: Datasource[]
  adminUser: string
  adminPass: string
  port: number
}
const GRAFANA = new WeakMap<System, GrafanaRt>()
const GRAFANA_PASS = new WeakMap<System, string>()

function iniValue(textIni: string, section: string, key: string): string | undefined {
  let cur = ''
  for (const raw of textIni.split('\n')) {
    const l = raw.trim()
    const s = /^\[(.+)\]$/.exec(l)
    if (s) {
      cur = s[1]
      continue
    }
    if (l.startsWith(';') || l.startsWith('#')) continue
    const kv = /^([\w.]+)\s*=\s*(.*)$/.exec(l)
    if (kv && cur === section && kv[1] === key) return kv[2].replace(/^"|"$/g, '')
  }
  return undefined
}

function loadGrafana(sys: System): GrafanaRt | { error: string } {
  const ini = read(sys, '/etc/grafana/grafana.ini') ?? ''
  const prov = iniValue(ini, 'paths', 'provisioning') ?? '/etc/grafana/provisioning'
  const datasources: Datasource[] = []
  for (const f of globFiles(sys, `${prov}/datasources/*.y*ml`)) {
    const t = read(sys, f) ?? ''
    const y = loadYaml(t)
    if (y.error) return { error: `Datasource provisioning error: failed to load datasources config: could not parse YAML ${f}: ${y.error}` }
    const d = (y.data ?? {}) as Obj
    if (d.apiVersion === undefined) return { error: `Datasource provisioning error: failed to load datasources config: ${f}: apiVersion is missing` }
    for (const ds of (d.datasources as unknown[]) ?? []) {
      if (!isObj(ds)) continue
      if (!ds.name) return { error: 'Datasource provisioning error: datasource.yaml config is invalid. Datasource name is required' }
      if (!ds.type) return { error: `Datasource provisioning error: datasource.yaml config is invalid. Datasource type is required (datasource "${ds.name}")` }
      datasources.push({ name: String(ds.name), type: String(ds.type), url: String(ds.url ?? ''), uid: String(ds.uid ?? String(ds.name).toLowerCase().replace(/\W+/g, '-')), isDefault: !!ds.isDefault, access: String(ds.access ?? 'proxy'), file: f })
    }
  }
  if (datasources.filter((d) => d.isDefault).length > 1) return { error: 'Datasource provisioning error: datasource.yaml config is invalid. Only one datasource per organization can be marked as default' }
  return { datasources, adminUser: iniValue(ini, 'security', 'admin_user') ?? 'admin', adminPass: GRAFANA_PASS.get(sys) ?? iniValue(ini, 'security', 'admin_password') ?? 'admin', port: Number(iniValue(ini, 'server', 'http_port') ?? 3000) }
}

SERVICE_CHECKS['grafana-server'] = (ctx) => {
  const r = loadGrafana(ctx.sys)
  if ('error' in r) return `Error: ✗ ${r.error}`
  GRAFANA.set(ctx.sys, r)
  return undefined
}

function grafanaRt(sys: System): GrafanaRt | undefined {
  if (!serviceActive(sys, 'grafana-server')) return undefined
  let rt = GRAFANA.get(sys)
  if (!rt) {
    const r = loadGrafana(sys)
    if ('error' in r) return undefined
    GRAFANA.set(sys, (rt = r))
  }
  return rt
}

/** Prueba un origen de datos desde el servidor de Grafana (como el botón "Save & test"). */
export function datasourceHealth(sys: System, ds: Datasource): { status: 'OK' | 'ERROR'; message: string } {
  const base = ds.url.replace(/\/$/, '')
  if (ds.type === 'prometheus') {
    const url = `${base}/api/v1/query?query=1%2B1`
    const r = fetchHttp(sys, url)
    if (!r.ok) return { status: 'ERROR', message: `${goDialError(r, url, 'Post')} - There was an error returned querying the Prometheus API.` }
    if (r.res.status !== 200) return { status: 'ERROR', message: `bad_response: readObjectStart: expect { or n, but found 4 - There was an error returned querying the Prometheus API.` }
    return { status: 'OK', message: 'Successfully queried the Prometheus API.' }
  }
  if (ds.type === 'loki') {
    const url = `${base}/loki/api/v1/labels`
    const r = fetchHttp(sys, url)
    if (!r.ok) return { status: 'ERROR', message: `Unable to connect with Loki. Please check the server logs for more details. ${goDialError(r, url)}` }
    if (r.res.status !== 200) return { status: 'ERROR', message: 'Unable to connect with Loki. Please check the server logs for more details.' }
    return { status: 'OK', message: 'Data source successfully connected.' }
  }
  return { status: 'OK', message: 'Data source is working' }
}

function grafanaHttp(sys: System, rt: GrafanaRt, req: HttpRequest): HttpResponse {
  const p = pathOnly(req.path)
  if (p === '/api/health') return json(200, { database: 'ok', version: GRAFANA_VERSION, commit: '6f7a1d2b' })
  if (p === '/login') return text(200, '<!DOCTYPE html><html lang="en-US"><head><title>Grafana</title></head><body></body></html>\n', 'text/html; charset=UTF-8')
  if (p === '/') return { status: 302, headers: [['Location', '/login'], ['Content-Type', 'text/html; charset=utf-8']], body: '<a href="/login">Found</a>.\n\n' }
  if (p.startsWith('/api/')) {
    const auth = req.headers['authorization'] ?? ''
    const m = /^Basic (.+)$/.exec(auth)
    const [u, pw] = m ? atob(m[1]).split(':') : []
    if (u !== rt.adminUser || pw !== rt.adminPass) return json(401, { message: 'Invalid username or password', messageId: 'password-auth.failed', statusCode: 401, traceID: '' })
    const dsJson = (d: Datasource, i: number) => ({ id: i + 1, uid: d.uid, orgId: 1, name: d.name, type: d.type, access: d.access, url: d.url, isDefault: d.isDefault, readOnly: true })
    if (p === '/api/datasources') return json(200, rt.datasources.map(dsJson))
    const byName = /^\/api\/datasources\/name\/(.+)$/.exec(p)
    if (byName) {
      const i = rt.datasources.findIndex((d) => d.name === decodeURIComponent(byName[1]))
      return i < 0 ? json(404, { message: 'Data source not found' }) : json(200, dsJson(rt.datasources[i], i))
    }
    const health = /^\/api\/datasources\/uid\/([^/]+)\/health$/.exec(p)
    if (health) {
      const d = rt.datasources.find((x) => x.uid === health[1])
      if (!d) return json(404, { message: 'Data source not found' })
      const h = datasourceHealth(sys, d)
      return json(h.status === 'OK' ? 200 : 400, h)
    }
    if (p === '/api/org') return json(200, { id: 1, name: 'Main Org.' })
    return json(404, { message: 'Not found' })
  }
  return text(404, '404 page not found\n')
}

// ---------------------------------------------------------------------------------------
// Loki
// ---------------------------------------------------------------------------------------

interface LokiRt {
  path: string
  port: number
  rulesDir: string
  alertmanagerUrl?: string
}
const LOKI = new WeakMap<System, LokiRt>()

const LOKI_TOP = ['auth_enabled', 'server', 'common', 'schema_config', 'storage_config', 'limits_config', 'ruler', 'compactor', 'query_range', 'ingester', 'analytics', 'querier', 'frontend', 'pattern_ingester', 'distributor', 'memberlist', 'table_manager', 'tracing', 'query_scheduler', 'frontend_worker', 'ingester_client', 'bloom_build', 'bloom_gateway', 'target', 'ui', 'runtime_config', 'chunk_store_config', 'index_gateway', 'kafka_config', 'operational_config', 'ballast_bytes']

export function parseLokiConfig(t: string, path: string): LokiRt | { error: string } {
  const y = loadYaml(t)
  if (y.error) return { error: `failed parsing config: ${path}: ${y.error}` }
  const d = (y.data ?? {}) as Obj
  const uf = unknownFields(t, d, LOKI_TOP, 'loki.ConfigWrapper')
  if (uf) return { error: `failed parsing config: ${path}: ${uf}` }
  const sc = (d.schema_config as Obj)?.configs
  if (!Array.isArray(sc) || !sc.length) return { error: 'invalid schema config: must specify at least one schema configuration' }
  const server = (d.server ?? {}) as Obj
  const common = (d.common ?? {}) as Obj
  const ruler = (d.ruler ?? {}) as Obj
  const rulesDir = String(((ruler.storage as Obj)?.local as Obj)?.directory ?? ((common.storage as Obj)?.filesystem as Obj)?.rules_directory ?? '/var/lib/loki/rules')
  return { path, port: Number(server.http_listen_port ?? 3100), rulesDir, alertmanagerUrl: ruler.alertmanager_url ? String(ruler.alertmanager_url) : undefined }
}

function loadLoki(sys: System): LokiRt | { error: string } {
  const path = '/etc/loki/config.yml'
  const t = read(sys, path)
  if (t === undefined) return { error: `failed parsing config: open ${path}: no such file or directory` }
  return parseLokiConfig(t, path)
}

SERVICE_CHECKS['loki'] = (ctx) => {
  const r = loadLoki(ctx.sys)
  if ('error' in r) return r.error
  LOKI.set(ctx.sys, r)
  return undefined
}

function lokiRt(sys: System): LokiRt | undefined {
  if (!serviceActive(sys, 'loki')) return undefined
  let rt = LOKI.get(sys)
  if (!rt) {
    const r = loadLoki(sys)
    if ('error' in r) return undefined
    LOKI.set(sys, (rt = r))
  }
  return rt
}

// ---------------------------------------------------------------------------------------
// Alloy
// ---------------------------------------------------------------------------------------

interface AlloyRt {
  path: string
  plan: AlloyPlan
}
const ALLOY = new WeakMap<System, AlloyRt>()

function alloyConfigPath(sys: System): string {
  const env = read(sys, sys.distro === 'rocky' ? '/etc/sysconfig/alloy' : '/etc/default/alloy') ?? ''
  return /^CONFIG_FILE="?([^"\n]+)"?/m.exec(env)?.[1] ?? '/etc/alloy/config.alloy'
}

function loadAlloy(sys: System): AlloyRt | { error: string } {
  const path = alloyConfigPath(sys)
  const t = read(sys, path)
  if (t === undefined) return { error: `Error: failed to read config file ${path}: open ${path}: no such file or directory` }
  try {
    const blocks = validateAlloy(t)
    return { path, plan: planAlloy(blocks, { hostname: sys.hostname, env: {} }) }
  } catch (e) {
    if (e instanceof AlloyError) return { error: `Error: ${path}:${e.line}:${e.col}: ${e.message}` }
    return { error: `Error: ${(e as Error).message}` }
  }
}

SERVICE_CHECKS['alloy'] = (ctx) => {
  const r = loadAlloy(ctx.sys)
  if ('error' in r) return r.error
  ALLOY.set(ctx.sys, r)
  return undefined
}

function alloyRt(sys: System): AlloyRt | undefined {
  if (!serviceActive(sys, 'alloy')) return undefined
  let rt = ALLOY.get(sys)
  if (!rt) {
    const r = loadAlloy(sys)
    if ('error' in r) return undefined
    ALLOY.set(sys, (rt = r))
  }
  return rt
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Hora de una línea de log (syslog, nginx o ISO); si no tiene, undefined. */
function lineTime(line: string, now: number): number | undefined {
  const sy = /^([A-Z][a-z]{2}) +(\d{1,2}) (\d\d):(\d\d):(\d\d)/.exec(line)
  if (sy) {
    const y = new Date(now).getFullYear()
    let t = new Date(y, MONTHS.indexOf(sy[1]), Number(sy[2]), Number(sy[3]), Number(sy[4]), Number(sy[5])).getTime()
    if (t > now + 86400000) t = new Date(y - 1, MONTHS.indexOf(sy[1]), Number(sy[2]), Number(sy[3]), Number(sy[4]), Number(sy[5])).getTime()
    return t
  }
  const ng = /\[(\d\d)\/([A-Z][a-z]{2})\/(\d{4}):(\d\d):(\d\d):(\d\d) ([+-]\d{4})\]/.exec(line)
  if (ng) return Date.parse(`${ng[3]}-${String(MONTHS.indexOf(ng[2]) + 1).padStart(2, '0')}-${ng[1]}T${ng[4]}:${ng[5]}:${ng[6]}${ng[7].slice(0, 3)}:${ng[7].slice(3)}`)
  const iso = /(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?)/.exec(line)
  if (iso) return Date.parse(iso[1])
  return undefined
}

const PRIORITY = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']

/** Lo que manda un agente a un Loki: streams con sus líneas (y por qué no manda lo que no puede leer). */
function agentStreams(agent: System, loki: System, port: number): LogStream[] {
  const a = alloyRt(agent)
  if (!a) return []
  const cred = agent.credFor('alloy')
  const now = obsNow(agent)
  const out: LogStream[] = []
  const push = (labels: Labels, entries: { t: number; line: string }[]) => {
    if (entries.length) out.push({ labels, entries })
  }
  for (const src of a.plan.logs) {
    const sinks = src.sinks.filter((s) => s.urls.some((u) => pointsTo(agent, u, loki, port, '/loki/api/v1/push')))
    // Destinos que son este Loki pero no se alcanzan: Alloy lo avisa en su log, como el real.
    for (const s of src.sinks) for (const u of s.urls) if (!pointsTo(agent, u, loki, port, '/loki/api/v1/push')) warnUnreachable(agent, u, loki, port)
    if (!sinks.length) continue
    const raw: { labels: Labels; entries: { t: number; line: string }[] }[] = []
    if (src.kind === 'file') {
      for (const t of src.targets ?? []) {
        const pattern = t.__path__
        if (!pattern) continue
        for (const f of globFiles(agent, String(pattern))) {
          let content: string
          try {
            content = agent.vfs.readFile(f, cred)
          } catch {
            const key = `perm:${f}`
            if (!WARNED.has(agent)) WARNED.set(agent, new Set())
            if (!WARNED.get(agent)!.has(key)) {
              WARNED.get(agent)!.add(key)
              agent.journal.push({ time: Date.now(), unit: 'alloy.service', priority: 4, ident: 'alloy', message: `ts=${new Date().toISOString()} level=warn msg="failed to tail file" component_path=/ component_id=loki.source.file path=${f} error="open ${f}: permission denied"` })
            }
            continue
          }
          const lines = content.split('\n').filter((l) => l.trim())
          const entries = lines.map((line, i) => ({ t: (lineTime(line, now) ?? now - (lines.length - i) * 5000) / 1000, line }))
          const labels = Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith('__')).map(([k, v]) => [k, String(v)]))
          raw.push({ labels: { ...labels, filename: f }, entries })
        }
      }
    } else {
      const canRead = cred.uid === 0 || cred.groups.some((g) => ['systemd-journal', 'adm', 'wheel'].includes(agent.groupByGid(g)?.name ?? ''))
      if (!canRead) continue
      const byUnit = new Map<string, { t: number; line: string }[]>()
      const meta = new Map<string, Labels>()
      for (const j of agent.journal) {
        const base: Labels = { __journal__systemd_unit: j.unit, __journal__hostname: agent.hostname, __journal_priority_keyword: PRIORITY[j.priority] ?? 'info', __journal_syslog_identifier: j.ident }
        const l = relabel({ ...base, ...(src.labels ?? {}) }, src.journalRules ?? [])
        if (!l) continue
        const visible = Object.fromEntries(Object.entries(l).filter(([k]) => !k.startsWith('__')))
        const k = JSON.stringify(visible)
        meta.set(k, visible)
        if (!byUnit.has(k)) byUnit.set(k, [])
        byUnit.get(k)!.push({ t: j.time / 1000, line: j.message })
      }
      for (const [k, entries] of byUnit) raw.push({ labels: meta.get(k)!, entries })
    }
    for (const s of sinks) {
      for (const r of raw) {
        let labels: Labels | undefined = { ...r.labels, ...s.staticLabels }
        labels = relabel(labels, s.rules)
        if (!labels) continue
        for (const d of s.drop) delete labels[d]
        labels = { ...labels, ...s.externalLabels }
        const entries = s.dropLines.length ? r.entries.filter((e) => !s.dropLines.some((re) => re.test(e.line))) : r.entries
        push(labels, entries)
      }
    }
  }
  return out
}
const WARNED = new WeakMap<System, Set<string>>()

function warnUnreachable(agent: System, url: string, loki: System, port: number) {
  const m = /^https?:\/\/([^/:]+)(?::(\d+))?/.exec(url)
  if (!m || Number(m[2] ?? 80) !== port) return
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(m[1]) ? m[1] : agent.resolveHost(m[1])
  if (!ip || hostByIp(agent, ip) !== loki) return
  const r = fetchHttp(agent, url, { method: 'POST', body: '' })
  if (r.ok) return
  const key = `send:${url}:${r.code}`
  if (!WARNED.has(agent)) WARNED.set(agent, new Set())
  if (WARNED.get(agent)!.has(key)) return
  WARNED.get(agent)!.add(key)
  agent.journal.push({ time: Date.now(), unit: 'alloy.service', priority: 4, ident: 'alloy', message: `ts=${new Date().toISOString()} level=warn msg="error sending batch, will retry" component_path=/ component_id=loki.write status=-1 tenant="" error=${JSON.stringify(goDialError(r, url, 'Post'))}` })
}

const LOKI_DATA = new WeakMap<System, { key: string; db: LogDb }>()

/** Todo lo que tiene este Loki: lo que mandan los agentes del laboratorio y la historia del ejercicio. */
export function lokiDb(sys: System): LogDb | undefined {
  const rt = lokiRt(sys)
  if (!rt) return undefined
  const now = obsNow(sys)
  const streams: LogStream[] = []
  for (const h of [sys, ...sys.lab]) streams.push(...agentStreams(h, sys, rt.port))
  const key = JSON.stringify([streams.map((s) => [s.labels, s.entries.length]), Math.floor(now / 30000)])
  const cached = LOKI_DATA.get(sys)
  if (cached?.key === key) return cached.db
  const hist = STATE.get(sys)?.logs
  const base = buildLogDb({ ...(hist ?? {}), ahora: new Date(now).toISOString(), ventana: hist?.ventana ?? '6h' })
  // Juntar streams con las mismas etiquetas.
  const map = new Map<string, LogStream>()
  for (const s of [...base.streams, ...streams]) {
    const k = JSON.stringify(Object.keys(s.labels).sort().map((x) => [x, s.labels[x]]))
    const cur = map.get(k)
    if (cur) cur.entries.push(...s.entries)
    else map.set(k, { labels: s.labels, entries: [...s.entries] })
  }
  for (const s of map.values()) s.entries = s.entries.filter((e) => e.t <= now / 1000 + 1).sort((a, b) => a.t - b.t)
  const db: LogDb = { streams: [...map.values()].filter((s) => s.entries.length), start: base.start, end: now / 1000 }
  LOKI_DATA.set(sys, { key, db })
  return db
}

interface LokiRule {
  name: string
  expr: string
  node: MetricNode
  for: number
  labels: Labels
  annotations: Labels
  group: string
}

function lokiRules(sys: System, rt: LokiRt): { rules: LokiRule[]; errors: string[] } {
  const rules: LokiRule[] = []
  const errors: string[] = []
  for (const f of globFiles(sys, `${rt.rulesDir}/fake/*.y*ml`)) {
    const t = read(sys, f) ?? ''
    const y = loadYaml(t)
    if (y.error) {
      errors.push(`${f}: ${y.error}`)
      continue
    }
    for (const g of (((y.data ?? {}) as Obj).groups as unknown[]) ?? []) {
      if (!isObj(g)) continue
      for (const r of (g.rules as unknown[]) ?? []) {
        if (!isObj(r) || r.alert === undefined) continue
        try {
          const q = parseLogQL(String(r.expr))
          if (q.k !== 'metric') throw new LogQLError('invalid rule: the expression must be a metric query (count_over_time, rate...)')
          rules.push({ name: String(r.alert), expr: String(r.expr), node: q.expr, for: Number(durationOf(r.for, 0)) || 0, labels: Object.fromEntries(Object.entries((r.labels as Obj) ?? {}).map(([k, v]) => [k, String(v)])), annotations: Object.fromEntries(Object.entries((r.annotations as Obj) ?? {}).map(([k, v]) => [k, String(v)])), group: String(g.name) })
        } catch (e) {
          errors.push(`${f}: could not parse expression for alert '${String(r.alert)}' in group '${String(g.name)}': ${(e as Error).message}`)
        }
      }
    }
  }
  return { rules, errors }
}

function lokiAlerts(sys: System): { rule: LokiRule; state: 'inactive' | 'pending' | 'firing'; alerts: AlertInstance[] }[] {
  const rt = lokiRt(sys)
  const db = lokiDb(sys)
  if (!rt || !db) return []
  const now = obsNow(sys) / 1000
  const out: { rule: LokiRule; state: 'inactive' | 'pending' | 'firing'; alerts: AlertInstance[] }[] = []
  for (const r of lokiRules(sys, rt).rules) {
    let v: VSample[]
    try {
      const res = evalMetric(db, r.node, now)
      v = typeof res === 'number' ? [] : res.map((s) => ({ labels: s.labels, v: s.v }))
    } catch {
      out.push({ rule: r, state: 'inactive', alerts: [] })
      continue
    }
    const alerts: AlertInstance[] = v.map((s) => {
      let since = now
      for (let t = now - 60; t >= now - r.for - 240; t -= 60) {
        const back = evalMetric(db, r.node, t)
        if (typeof back === 'number' || !back.some((b) => sameSeries(b.labels, s.labels))) break
        since = t
      }
      return { labels: { ...s.labels, ...r.labels, alertname: r.name }, annotations: Object.fromEntries(Object.entries(r.annotations).map(([k, x]) => [k, expandTemplate(x, s.labels, s.v)])), value: s.v, activeAt: since, state: now - since >= r.for ? 'firing' : 'pending' }
    })
    out.push({ rule: r, state: alerts.some((a) => a.state === 'firing') ? 'firing' : alerts.length ? 'pending' : 'inactive', alerts })
  }
  return out
}

function lokiHttp(sys: System, rt: LokiRt, req: HttpRequest): HttpResponse {
  const p = pathOnly(req.path)
  const q = queryParams(req.path)
  if (p === '/ready') return text(200, 'ready\n')
  if (p === '/metrics') return text(200, `# HELP loki_build_info A metric with a constant '1' value.\n# TYPE loki_build_info gauge\nloki_build_info{version="${LOKI_VERSION}"} 1\n`)
  if (p === '/loki/api/v1/push') return req.method === 'POST' ? { status: 204, headers: [], body: '' } : text(405, 'Method Not Allowed\n')
  if (p === '/loki/api/v1/status/buildinfo') return json(200, { version: LOKI_VERSION, revision: '4c3e8f1', branch: 'HEAD', goVersion: 'go1.25.3' })
  const db = lokiDb(sys)!
  if (p === '/loki/api/v1/labels') return json(200, { status: 'success', data: [...new Set(db.streams.flatMap((s) => Object.keys(s.labels)))].sort() })
  const lv = /^\/loki\/api\/v1\/label\/([^/]+)\/values$/.exec(p)
  if (lv) return json(200, { status: 'success', data: [...new Set(db.streams.map((s) => s.labels[lv[1]]).filter((x) => x !== undefined))].sort() })
  if (p === '/loki/api/v1/query_range' || p === '/loki/api/v1/query') {
    const query = q.get('query') ?? ''
    try {
      const pq = parseLogQL(query)
      if (pq.k === 'log') {
        const r = queryLogs(db, pq.expr, Number(q.get('limit') ?? 100))
        const groups = new Map<string, { stream: Labels; values: [string, string][] }>()
        for (const l of r.lines) {
          const k = JSON.stringify(l.labels)
          if (!groups.has(k)) groups.set(k, { stream: l.labels, values: [] })
          groups.get(k)!.values.push([String(Math.round(l.t * 1e9)), l.line])
        }
        return json(200, { status: 'success', data: { resultType: 'streams', result: [...groups.values()] } })
      }
      if (p === '/loki/api/v1/query') {
        const v = evalMetric(db, pq.expr, db.end)
        return json(200, { status: 'success', data: { resultType: typeof v === 'number' ? 'scalar' : 'vector', result: typeof v === 'number' ? [db.end, String(v)] : v.map((s) => ({ metric: s.labels, value: [db.end, fmt(s.v)] })) } })
      }
      const r = metricRange(db, pq.expr)
      return json(200, { status: 'success', data: { resultType: 'matrix', result: r.series.map((s) => ({ metric: s.labels, values: s.samples.map((x) => [x.t, fmt(x.v)]) })) } })
    } catch (e) {
      return text(400, `${(e as Error).message}\n`)
    }
  }
  if (p === '/loki/api/v1/rules') {
    const r = lokiRules(sys, rt)
    if (!r.rules.length) return text(404, 'no rule groups found\n')
    const groups = [...new Set(r.rules.map((x) => x.group))]
    return text(200, `fake:\n${groups.map((g) => `    - name: ${g}\n      rules:\n${r.rules.filter((x) => x.group === g).map((x) => `        - alert: ${x.name}\n          expr: ${x.expr}\n${x.for ? `          for: ${formatDuration(x.for)}\n` : ''}`).join('')}`).join('')}`, 'application/yaml')
  }
  if (p === '/prometheus/api/v1/alerts') return json(200, { status: 'success', data: { alerts: lokiAlerts(sys).flatMap((s) => s.alerts.map((a) => ({ labels: a.labels, annotations: a.annotations, state: a.state, activeAt: new Date(a.activeAt * 1000).toISOString(), value: String(a.value) }))) } })
  return text(404, '404 page not found\n')
}

// ---------------------------------------------------------------------------------------
// Zabbix: agente 2
// ---------------------------------------------------------------------------------------

const ZBX_PARAMS = new Set(['PidFile', 'LogType', 'LogFile', 'LogFileSize', 'DebugLevel', 'SourceIP', 'Server', 'ListenPort', 'ListenIP', 'StatusPort', 'ServerActive', 'Hostname', 'HostnameItem', 'HostMetadata', 'HostMetadataItem', 'HostInterface', 'HostInterfaceItem', 'RefreshActiveChecks', 'BufferSend', 'BufferSize', 'EnablePersistentBuffer', 'PersistentBufferPeriod', 'PersistentBufferFile', 'Alias', 'Timeout', 'Include', 'UnsafeUserParameters', 'UserParameter', 'UserParameterDir', 'ControlSocket', 'TLSConnect', 'TLSAccept', 'TLSCAFile', 'TLSCRLFile', 'TLSServerCertIssuer', 'TLSServerCertSubject', 'TLSCertFile', 'TLSKeyFile', 'TLSPSKIdentity', 'TLSPSKFile', 'PluginTimeout', 'PluginSocket', 'AllowKey', 'DenyKey', 'ForceActiveChecksOnStart', 'HeartbeatFrequency'])

interface ZbxConf {
  server: string[]
  serverActive: string[]
  hostname: string
  port: number
  userParams: Map<string, string>
}

export function parseZabbixAgent(sys: System, path = '/etc/zabbix/zabbix_agent2.conf'): ZbxConf | { error: string } {
  const files = [path]
  const conf: ZbxConf = { server: [], serverActive: [], hostname: sys.hostname, port: 10050, userParams: new Map() }
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi]
    const t = read(sys, f)
    if (t === undefined) return fi === 0 ? { error: `cannot open config file "${f}": open ${f}: no such file or directory` } : conf
    const lines = t.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim()
      if (!l || l.startsWith('#')) continue
      const m = /^([A-Za-z.]+)\s*=\s*(.*)$/.exec(l)
      if (!m) return { error: `cannot load configuration: invalid parameter "${l}" at line ${i + 1}` }
      const [, k, v] = m
      if (!ZBX_PARAMS.has(k) && !k.startsWith('Plugins.')) return { error: `cannot initialize configuration: unknown parameter ${k} in config file ${f}, line ${i + 1}` }
      if (k === 'Server') conf.server = v.split(',').map((x) => x.trim()).filter(Boolean)
      if (k === 'ServerActive') conf.serverActive = v.split(',').map((x) => x.trim()).filter(Boolean)
      if (k === 'Hostname') conf.hostname = v.trim()
      if (k === 'ListenPort') conf.port = Number(v) || 10050
      if (k === 'UserParameter') {
        const [key, ...cmd] = v.split(',')
        conf.userParams.set(key.trim(), cmd.join(',').trim())
      }
      if (k === 'Include') files.push(...globFiles(sys, v.trim()))
    }
  }
  return conf
}

SERVICE_CHECKS['zabbix-agent2'] = (ctx) => {
  const r = parseZabbixAgent(ctx.sys)
  if ('error' in r) return `zabbix_agent2 [${ctx.sys.allocPid()}]: ERROR: ${r.error}`
  try {
    ctx.sys.vfs.writeFile('/var/log/zabbix/zabbix_agent2.log', `${new Date().toISOString().replace('T', ' ').slice(0, 19)}.000000 Starting Zabbix Agent 2 (${ZABBIX_VERSION})\n${new Date().toISOString().replace('T', ' ').slice(0, 19)}.000000 using configuration file: /etc/zabbix/zabbix_agent2.conf\n`, ROOT_CRED, { append: true })
  } catch {
    // sin log
  }
  return undefined
}

function inCidr(ip: string, cidr: string): boolean {
  const [net, bits] = cidr.split('/')
  const toN = (x: string) => x.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0
  const mask = bits === undefined ? 0xffffffff : Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0
  return (toN(ip) & mask) === (toN(net) & mask)
}

/** El valor de una clave de Zabbix en este equipo, o el error ZBX_NOTSUPPORTED. */
export function zabbixItem(sys: System, key: string, conf: ZbxConf): string {
  const m = /^([\w.]+)(?:\[(.*)\])?$/.exec(key.trim())
  if (!m) return `ZBX_NOTSUPPORTED: Invalid item key format.`
  const [, name, rawArgs] = m
  const args = rawArgs === undefined ? [] : rawArgs.split(',').map((a) => a.trim().replace(/^"|"$/g, ''))
  const met = metrics(sys)
  const fs = rootFs(sys)
  switch (name) {
    case 'agent.ping':
      return '1'
    case 'agent.version':
      return ZABBIX_VERSION
    case 'agent.hostname':
      return conf.hostname
    case 'system.hostname':
      return sys.hostname
    case 'system.uname':
      return `Linux ${sys.hostname} ${sys.distro === 'rocky' ? '6.12.0-55.12.1.el10_0.x86_64' : '6.8.0-88-generic'} #1 SMP PREEMPT_DYNAMIC x86_64`
    case 'system.uptime':
      return String(Math.round((obsNow(sys) - sys.bootTime) / 1000))
    case 'system.cpu.num':
      return String(sys.ncpu)
    case 'system.cpu.load': {
      const which = args[1] ?? 'avg1'
      const v = which === 'avg5' ? met.load[1] : which === 'avg15' ? met.load[2] : met.load[0]
      return (args[0] === 'percpu' ? v / sys.ncpu : v).toFixed(6)
    }
    case 'system.cpu.util': {
      const type = args[1] || 'user'
      const v = type === 'idle' ? met.id : type === 'system' ? met.sy : type === 'iowait' ? met.wa : met.us
      return v.toFixed(6)
    }
    case 'vm.memory.size': {
      const mode = args[0] || 'total'
      const total = sys.memTotalKb * 1024
      if (mode === 'total') return String(total)
      if (mode === 'available') return String(Math.round(met.availKb * 1024))
      if (mode === 'pavailable') return ((met.availKb / sys.memTotalKb) * 100).toFixed(6)
      if (mode === 'used') return String(Math.round(met.memUsedKb * 1024))
      if (mode === 'pused') return ((met.memUsedKb / sys.memTotalKb) * 100).toFixed(6)
      return 'ZBX_NOTSUPPORTED: Invalid first parameter.'
    }
    case 'vfs.fs.size': {
      if (args[0] && args[0] !== '/') return `ZBX_NOTSUPPORTED: Cannot obtain filesystem information: [2] No such file or directory`
      const mode = args[1] || 'total'
      if (mode === 'total') return String(fs.size)
      if (mode === 'used') return String(fs.used)
      if (mode === 'free') return String(fs.size - fs.used)
      if (mode === 'pfree') return (((fs.size - fs.used) / fs.size) * 100).toFixed(6)
      if (mode === 'pused') return ((fs.used / fs.size) * 100).toFixed(6)
      return 'ZBX_NOTSUPPORTED: Invalid second parameter.'
    }
    case 'net.if.in':
    case 'net.if.out': {
      const iface = sys.interfaces.find((i) => i.name === args[0])
      if (!iface) return `ZBX_NOTSUPPORTED: Cannot find information for this network interface in /proc/net/dev.`
      return String(Math.round(((obsNow(sys) - sys.bootTime) / 1000) * (name === 'net.if.in' ? 52_000 : 21_000)))
    }
    case 'net.tcp.listen':
    case 'net.tcp.port': {
      const port = Number(name === 'net.tcp.port' ? args[1] : args[0])
      return [...sys.services.values()].some((s) => s.active && s.ports.includes(port)) ? '1' : '0'
    }
    case 'proc.num': {
      const n = args[0]
      return String(sys.procs.filter((p) => !n || commOf(p) === n).length)
    }
    case 'systemd.unit.info': {
      const unit = (args[0] ?? '').replace(/\.service$/, '')
      const s = sys.services.get(unit)
      if (!s) return `ZBX_NOTSUPPORTED: Cannot get unit property: Unit ${args[0]} not found.`
      const prop = args[1] || 'ActiveState'
      return prop === 'ActiveState' ? (s.active ? 'active' : s.failed ? 'failed' : 'inactive') : prop === 'UnitFileState' ? (s.enabled ? 'enabled' : 'disabled') : ''
    }
  }
  if (conf.userParams.has(name)) return `ZBX_NOTSUPPORTED: [simulador] UserParameter definido (${conf.userParams.get(name)}); en el simulador no se ejecuta.`
  return `ZBX_NOTSUPPORTED: Unknown metric ${name}`
}

// ---------------------------------------------------------------------------------------
// Servidores HTTP
// ---------------------------------------------------------------------------------------

SERVERS.push((sys, port) => {
  if (sys.poweredOff) return undefined
  const ne = nodeExporterListen(sys)
  if (ne === port) return { name: 'node_exporter', handle: (req) => (pathOnly(req.path) === '/metrics' ? text(200, nodeMetricsText(sys), 'text/plain; version=0.0.4; charset=utf-8') : text(200, `<html><head><title>Node Exporter</title></head><body><h1>Node Exporter</h1><p><a href="/metrics">Metrics</a></p></body></html>\n`, 'text/html')) }
  const pr = promRt(sys)
  if (pr && pr.port === port) return { name: 'prometheus', handle: (req) => promHttp(sys, pr, req) }
  const am = amRt(sys)
  if (am && am.port === port) return { name: 'alertmanager', handle: (req) => amHttp(sys, am, req) }
  const gr = grafanaRt(sys)
  if (gr && gr.port === port) return { name: 'grafana', handle: (req) => grafanaHttp(sys, gr, req) }
  const lk = lokiRt(sys)
  if (lk && lk.port === port) return { name: 'loki', handle: (req) => lokiHttp(sys, lk, req) }
  if (port === 12345 && alloyRt(sys)) return { name: 'alloy', handle: (req) => (pathOnly(req.path) === '/-/ready' ? text(200, 'Alloy is ready.\n') : pathOnly(req.path) === '/metrics' ? text(200, `alloy_build_info{version="v${ALLOY_VERSION}"} 1\n`) : text(200, '<!doctype html><html><head><title>Grafana Alloy</title></head><body></body></html>\n', 'text/html')) }
  return undefined
})

// ---------------------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------------------

const version = (name: string, v: string) => `${name}, version ${v} (branch: HEAD, revision: 3f1c2a9b)\n  build user:       root@buildkitsandbox\n  build date:       20261021-10:12:44\n  go version:       go1.25.3\n  platform:         linux/amd64\n  tags:             netgo,builtinassets\n`

function daemonCommand(name: string, v: string, hint: string) {
  register(name, {
    usage: `${name} [opciones]`,
    path: '/usr/local/bin',
    run(ctx) {
      if (ctx.args.includes('--version') || ctx.args.includes('-version')) {
        ctx.out(version(name, v))
        return 0
      }
      if (ctx.args.includes('-h') || ctx.args.includes('--help')) {
        ctx.out(`usage: ${name} [<flags>]\n\n${hint}\n`)
        return 0
      }
      ctx.err(`[simulador] En la terminal, ${name} no queda corriendo: usalo como servicio (systemctl start ${name === 'node_exporter' ? 'node_exporter' : name}).\n`)
      return 0
    },
  })
}
daemonCommand('prometheus', PROMETHEUS_VERSION, 'Flags: --config.file, --storage.tsdb.path, --storage.tsdb.retention.time, --web.listen-address, --web.enable-lifecycle, --web.enable-remote-write-receiver')
daemonCommand('node_exporter', NODE_EXPORTER_VERSION, 'Flags: --web.listen-address, --collector.<name>, --no-collector.<name>')
daemonCommand('alertmanager', ALERTMANAGER_VERSION, 'Flags: --config.file, --storage.path, --web.listen-address')

function promtoolCheckConfig(ctx: CommandContext, file: string): number {
  const sys = ctx.sys
  ctx.out(`Checking ${file}\n`)
  const t = read(sys, file)
  if (t === undefined) {
    ctx.err(`  FAILED: open ${file}: no such file or directory\n\n`)
    return 1
  }
  const r = parsePromConfig(t, file)
  if (!r.cfg) {
    ctx.err(`  FAILED: ${r.error}\n\n`)
    return 1
  }
  const files = ruleFilesOf(sys, r.cfg, file)
  if (files.length) ctx.out(` SUCCESS: ${files.length} rule files found\n`)
  ctx.out(` SUCCESS: ${file} is valid prometheus config file syntax\n\n`)
  let code = 0
  for (const f of files) code = Math.max(code, promtoolCheckRules(ctx, f))
  return code
}

function promtoolCheckRules(ctx: CommandContext, file: string): number {
  ctx.out(`Checking ${file}\n`)
  const t = read(ctx.sys, file)
  if (t === undefined) {
    ctx.err(`  FAILED:\nopen ${file}: no such file or directory\n\n`)
    return 1
  }
  const r = safeRules(t, file)
  if (r.error) {
    ctx.err(`  FAILED:\n${r.error}\n\n`)
    return 1
  }
  ctx.out(`  SUCCESS: ${r.count} rules found\n\n`)
  return 0
}

register('promtool', {
  usage: 'promtool check config ARCHIVO | check rules ARCHIVO... | check metrics | query instant URL CONSULTA | query range URL CONSULTA',
  path: '/usr/local/bin',
  run(ctx) {
    const [a, b, ...rest] = ctx.args.filter((x) => !x.startsWith('--'))
    if (a === '--version' || ctx.args.includes('--version')) {
      ctx.out(version('promtool', PROMETHEUS_VERSION))
      return 0
    }
    if (a === 'check' && b === 'config') {
      if (!rest.length) {
        ctx.err('promtool: error: required argument \'config-files\' not provided, try --help\n')
        return 1
      }
      return Math.max(...rest.map((f) => promtoolCheckConfig(ctx, f)))
    }
    if (a === 'check' && b === 'rules') {
      if (!rest.length) {
        ctx.err('promtool: error: required argument \'rule-files\' not provided, try --help\n')
        return 1
      }
      return Math.max(...rest.map((f) => promtoolCheckRules(ctx, f)))
    }
    if (a === 'check' && b === 'metrics') {
      const input = ctx.stdin.readAll?.() ?? ''
      const bad = input.split('\n').filter((l) => l && !l.startsWith('#') && !/^[a-zA-Z_:][\w:]*(\{.*\})? \S+$/.test(l))
      if (bad.length) {
        ctx.err(`error while linting: text format parsing error in line 1: ${bad[0]}\n`)
        return 1
      }
      return 0
    }
    if (a === 'query' && (b === 'instant' || b === 'range')) {
      const [url, query] = rest
      if (!url || !query) {
        ctx.err(`promtool: error: required argument 'server' not provided, try --help\n`)
        return 1
      }
      const path = b === 'instant' ? `/api/v1/query?query=${encodeURIComponent(query)}` : `/api/v1/query_range?query=${encodeURIComponent(query)}&step=60`
      const r = fetchHttp(ctx.sys, `${url.replace(/\/$/, '')}${path}`)
      if (!r.ok) {
        ctx.err(`query error: ${goDialError(r, url.replace(/\/$/, '') + path, 'Post')}\n`)
        return 1
      }
      const body = JSON.parse(r.res.body) as { status: string; error?: string; data?: { resultType: string; result: unknown } }
      if (body.status !== 'success') {
        ctx.err(`query error: bad_data: ${body.error}\n`)
        return 1
      }
      const h = hostByIp(ctx.sys, r.ip)
      const data = h ? promData(h) : undefined
      if (!data) return 0
      const t = data.db.end
      ctx.out(formatInstant(instantQuery(data.db, query, t), t) + '\n')
      return 0
    }
    if (a === 'test' && b === 'rules') {
      ctx.err('[simulador] promtool test rules no está simulado; probalo en tu laboratorio.\n')
      return 1
    }
    ctx.err(`promtool: error: expected command but got "${[a, b].filter(Boolean).join(' ')}", try --help\n`)
    return 1
  },
})

function amtoolUrl(ctx: CommandContext): string | undefined {
  const flag = ctx.args.find((a) => a.startsWith('--alertmanager.url='))?.split('=')[1] ?? (ctx.args.includes('--alertmanager.url') ? ctx.args[ctx.args.indexOf('--alertmanager.url') + 1] : undefined)
  if (flag) return flag
  const cfg = read(ctx.sys, `${ctx.sh.home}/.config/amtool/config.yml`) ?? read(ctx.sys, '/etc/amtool/config.yml')
  return cfg ? /alertmanager\.url:\s*"?([^"\s]+)"?/.exec(cfg)?.[1] : undefined
}

register('amtool', {
  usage: 'amtool check-config ARCHIVO | alert query | silence add MATCHER... --comment=TEXTO [--duration=2h] | silence query | silence expire ID',
  path: '/usr/local/bin',
  run(ctx) {
    const pos = ctx.args.filter((a) => !a.startsWith('-') && !/^--/.test(a))
    const opt = (n: string) => ctx.args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? (ctx.args.includes(`--${n}`) ? ctx.args[ctx.args.indexOf(`--${n}`) + 1] : undefined)
    if (ctx.args.includes('--version')) {
      ctx.out(version('amtool', ALERTMANAGER_VERSION))
      return 0
    }
    if (pos[0] === 'check-config') {
      let failed = 0
      for (const f of pos.slice(1)) {
        const t = read(ctx.sys, f)
        const r = t === undefined ? { error: `open ${f}: no such file or directory` } : parseAmConfig(t)
        if (!('cfg' in r) || !r.cfg) {
          ctx.out(`Checking '${f}'  FAILED: ${r.error}\n\n`)
          failed++
          continue
        }
        ctx.out(`Checking '${f}'  SUCCESS\nFound:\n - global config\n - route\n - ${r.cfg.inhibitRules} inhibit rules\n - ${r.cfg.receivers.length} receivers\n - 0 templates\n\n`)
      }
      if (failed) {
        ctx.err(`amtool: error: failed to validate ${failed} file(s)\n`)
        return 1
      }
      return 0
    }
    const url = amtoolUrl(ctx)
    if (!url) {
      ctx.err(`amtool: error: required flag --alertmanager.url not provided\n`)
      return 1
    }
    const base = url.replace(/\/$/, '')
    const probe = fetchHttp(ctx.sys, `${base}/-/healthy`)
    if (!probe.ok) {
      ctx.err(`Get "${base}/api/v2/alerts": ${goDialError(probe, `${base}/api/v2/alerts`).split(': ').slice(1).join(': ')}\n`)
      return 1
    }
    const am = hostByIp(ctx.sys, probe.ip)!
    const rt = amRt(am)!
    if (pos[0] === 'alert' && (pos[1] === 'query' || pos[1] === undefined)) {
      dispatch(am)
      const filters = pos.slice(2)
      const alerts = amAlerts(am).filter((a) => !a.silencedBy.length || ctx.args.includes('--silenced') || ctx.args.includes('-s')).filter((a) => filters.every((f) => {
        const m = /^(\w+)(=~|!~|!=|=)"?([^"]*)"?$/.exec(f)
        return m ? matchOne({ name: m[1], op: m[2] as AmMatcher['op'], value: m[3] }, a.labels) : a.labels.alertname === f
      }))
      const rows = alerts.map((a) => [a.labels.alertname ?? '', `${new Date(a.startsAt).toISOString().replace('T', ' ').slice(0, 19)} UTC`, a.annotations.summary ?? '', a.silencedBy.length ? 'suppressed' : 'active'])
      const head = ['Alertname', 'Starts At', 'Summary', 'State']
      const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
      ctx.out([head, ...rows].map((r) => r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd()).join('\n') + '\n')
      return 0
    }
    if (pos[0] === 'silence' && pos[1] === 'add') {
      const matchers = pos.slice(2).map((f) => {
        const m = /^(\w+)(=~|!~|!=|=)"?([^"]*)"?$/.exec(f)
        return m ? { name: m[1], op: m[2] as AmMatcher['op'], value: m[3] } : { name: 'alertname', op: '=' as const, value: f }
      })
      const comment = opt('comment') ?? opt('c')
      if (!comment) {
        ctx.err('amtool: error: comment required by config\n')
        return 1
      }
      if (!matchers.length) {
        ctx.err('amtool: error: no matchers specified\n')
        return 1
      }
      const dur = parseDuration(opt('duration') ?? opt('d') ?? '1h') ?? 3600
      const id = crypto.randomUUID()
      rt.silences.push({ id, matchers, endsAt: obsNow(am) + dur * 1000, comment, createdBy: opt('author') ?? opt('a') ?? ctx.sh.user })
      ctx.out(`${id}\n`)
      return 0
    }
    if (pos[0] === 'silence' && (pos[1] === 'query' || pos[1] === undefined)) {
      const now = obsNow(am)
      const rows = rt.silences.filter((s) => s.endsAt > now).map((s) => [s.id, s.matchers.map((m) => `${m.name}${m.op}"${m.value}"`).join(' '), `${new Date(s.endsAt).toISOString().replace('T', ' ').slice(0, 19)} UTC`, s.createdBy, s.comment])
      const head = ['ID', 'Matchers', 'Ends At', 'Created By', 'Comment']
      const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
      ctx.out([head, ...rows].map((r) => r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd()).join('\n') + '\n')
      return 0
    }
    if (pos[0] === 'silence' && pos[1] === 'expire') {
      for (const id of pos.slice(2)) {
        const s = rt.silences.find((x) => x.id === id)
        if (!s) {
          ctx.err(`amtool: error: silence ${id} not found\n`)
          return 1
        }
        s.endsAt = obsNow(am) - 1
      }
      return 0
    }
    ctx.err(`amtool: error: expected command but got "${pos.join(' ')}", try --help\n`)
    return 1
  },
})

register('loki', {
  usage: 'loki -config.file ARCHIVO [-verify-config] | -version',
  path: '/usr/bin',
  run(ctx) {
    if (ctx.args.some((a) => /^--?version$/.test(a))) {
      ctx.out(version('loki', LOKI_VERSION))
      return 0
    }
    const file = argVal(ctx.args.join(' '), '-config.file') ?? argVal(ctx.args.join(' '), '--config.file')
    if (ctx.args.some((a) => /^--?verify-config$/.test(a))) {
      if (!file) {
        ctx.err('failed parsing config: -config.file is required\n')
        return 1
      }
      const t = read(ctx.sys, file)
      const r = t === undefined ? { error: `failed parsing config: open ${file}: no such file or directory` } : parseLokiConfig(t, file)
      if ('error' in r) {
        ctx.err(`${r.error}\n`)
        return 1
      }
      ctx.err(`level=info ts=${new Date().toISOString()} caller=main.go:113 msg="config is valid"\n`)
      return 0
    }
    ctx.err('[simulador] En la terminal, loki no queda corriendo: usalo como servicio (systemctl start loki).\n')
    return 0
  },
})

register('alloy', {
  usage: 'alloy fmt [-w] ARCHIVO | alloy run ARCHIVO | alloy --version',
  path: '/usr/bin',
  run(ctx) {
    const [cmd, ...rest] = ctx.args
    if (cmd === '--version' || cmd === '-v') {
      ctx.out(`alloy, version v${ALLOY_VERSION} (branch: HEAD, revision: 8e1b2c3)\n  build user:       root@buildkitsandbox\n  build date:       2026-10-28T14:02:11Z\n  go version:       go1.25.3\n  platform:         linux/amd64\n  tags:             netgo,builtinassets,promtail_journal_enabled\n`)
      return 0
    }
    if (cmd === 'fmt' || cmd === 'validate') {
      const write = rest.includes('-w') || rest.includes('--write')
      const file = rest.find((a) => !a.startsWith('-'))
      if (!file) {
        ctx.err('Error: accepts 1 arg(s), received 0\n')
        return 1
      }
      const t = read(ctx.sys, file.startsWith('/') ? file : `${ctx.sh.cwd}/${file}`)
      if (t === undefined) {
        ctx.err(`Error: open ${file}: no such file or directory\n`)
        return 1
      }
      try {
        if (cmd === 'validate') {
          validateAlloy(t)
          return 0
        }
        const out = formatAlloy(t)
        if (write) ctx.sys.vfs.writeFile(file.startsWith('/') ? file : `${ctx.sh.cwd}/${file}`, out, ctx.sh.cred)
        else ctx.out(out)
        return 0
      } catch (e) {
        if (e instanceof AlloyError) ctx.err(`Error: ${file}:${e.line}:${e.col}: ${e.message}\n`)
        else ctx.err(`Error: ${(e as Error).message}\n`)
        return 1
      }
    }
    if (cmd === 'run') {
      ctx.err('[simulador] En la terminal, alloy no queda corriendo: usalo como servicio (systemctl start alloy).\n')
      return 0
    }
    ctx.err(`Error: unknown command "${cmd ?? ''}" for "alloy"\nRun 'alloy --help' for usage.\n`)
    return 1
  },
})

register('logcli', {
  usage: "logcli query 'CONSULTA' [--limit=30] [--since=1h] [--addr=URL] [-o raw|jsonl] | labels [ETIQUETA] | series 'SELECTOR'",
  path: '/usr/bin',
  run(ctx) {
    const opt = (n: string) => ctx.args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? (ctx.args.includes(`--${n}`) ? ctx.args[ctx.args.indexOf(`--${n}`) + 1] : undefined)
    const optVals = new Set(['--limit', '--since', '--addr', '-o', '--output', '--from', '--to'].flatMap((o) => (ctx.args.includes(o) ? [ctx.args[ctx.args.indexOf(o) + 1]] : [])))
    const pos = ctx.args.filter((a) => !a.startsWith('-') && !optVals.has(a))
    const addr = (opt('addr') ?? ctx.sh.getVar('LOKI_ADDR') ?? 'http://localhost:3100').replace(/\/$/, '')
    const quiet = ctx.args.includes('-q') || ctx.args.includes('--quiet')
    const output = opt('output') ?? (ctx.args.includes('-o') ? ctx.args[ctx.args.indexOf('-o') + 1] : 'default')
    const probe = fetchHttp(ctx.sys, `${addr}/ready`)
    const sub = pos[0]
    if (!sub) {
      ctx.err('logcli: error: expected command but got nothing, try --help\n')
      return 1
    }
    if (!probe.ok) {
      ctx.err(`Query failed: error sending request ${goDialError(probe, `${addr}/loki/api/v1/${sub === 'query' ? 'query_range' : 'labels'}`)}\n`)
      return 1
    }
    const loki = hostByIp(ctx.sys, probe.ip)!
    const db = lokiDb(loki)
    if (!db) {
      ctx.err('Query failed: Error response from server: 503 Service Unavailable\n')
      return 1
    }
    if (sub === 'labels') {
      if (pos[1]) for (const v of [...new Set(db.streams.map((s) => s.labels[pos[1]]).filter((x) => x !== undefined))].sort()) ctx.out(`${v}\n`)
      else for (const k of [...new Set(db.streams.flatMap((s) => Object.keys(s.labels)))].sort()) ctx.out(`${k}\n`)
      return 0
    }
    if (sub === 'series') {
      try {
        const q = parseLogQL(pos[1] ?? '')
        if (q.k !== 'log') throw new LogQLError('only stream selectors are allowed')
        for (const s of queryLogs(db, q.expr, 100000).streams) ctx.out(`${fmtLabels(s).replace(/^\{/, '{')}\n`)
        return 0
      } catch (e) {
        ctx.err(`Query failed: Error response from server: ${(e as Error).message}\n`)
        return 1
      }
    }
    if (sub === 'query' || sub === 'instant-query') {
      const query = pos[1] ?? ''
      const limit = Number(opt('limit') ?? 30)
      const since = parseDuration(opt('since') ?? '1h') ?? 3600
      try {
        const q = parseLogQL(query)
        const end = db.end
        const start = end - since
        if (!quiet) ctx.err(`${addr}/loki/api/v1/query_range?direction=BACKWARD&end=${Math.round(end * 1e9)}&limit=${limit}&query=${encodeURIComponent(query)}&start=${Math.round(start * 1e9)}\n`)
        if (q.k === 'log') {
          const r = queryLogs({ ...db, start }, q.expr, limit)
          const common = r.streams.length ? Object.fromEntries(Object.entries(r.streams[0]).filter(([k, v]) => r.streams.every((s) => s[k] === v))) : {}
          if (!quiet) ctx.err(`Common labels: ${fmtLabels(common)}\n`)
          for (const l of r.lines) {
            const own = Object.fromEntries(Object.entries(l.labels).filter(([k]) => common[k] === undefined))
            const ts = new Date(l.t * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
            if (output === 'raw') ctx.out(`${l.line}\n`)
            else if (output === 'jsonl') ctx.out(JSON.stringify({ labels: l.labels, line: l.line, timestamp: new Date(l.t * 1000).toISOString() }) + '\n')
            else ctx.out(`${ts} ${Object.keys(own).length ? fmtLabels(own) + ' ' : ''}${l.line}\n`)
          }
          return 0
        }
        if (sub === 'instant-query') {
          const v = evalMetric(db, q.expr, end)
          ctx.out(JSON.stringify(typeof v === 'number' ? v : v.map((s) => ({ metric: s.labels, value: [end, fmt(s.v)] })), null, 2) + '\n')
          return 0
        }
        const r = metricRange({ ...db, start }, q.expr)
        ctx.out(JSON.stringify(r.series.map((s) => ({ metric: s.labels, values: s.samples.map((x) => [x.t, fmt(x.v)]) })), null, 2) + '\n')
        return 0
      } catch (e) {
        ctx.err(`Query failed: Error response from server: ${(e as Error).message}\n`)
        return 1
      }
    }
    ctx.err(`logcli: error: expected command but got "${sub}", try --help\n`)
    return 1
  },
})

register(['grafana', 'grafana-cli'], {
  usage: 'grafana cli admin reset-admin-password CLAVE | grafana-cli admin reset-admin-password CLAVE',
  path: '/usr/sbin',
  run(ctx) {
    const args = ctx.name === 'grafana' && ctx.args[0] === 'cli' ? ctx.args.slice(1) : ctx.args
    if (args.includes('-v') || args.includes('--version') || args[0] === '-v') {
      ctx.out(`grafana version ${GRAFANA_VERSION}\n`)
      return 0
    }
    if (args[0] === 'admin' && args[1] === 'reset-admin-password' && args[2]) {
      if (ctx.sh.user !== 'root') {
        ctx.err('Error: ✗ failed to open database: unable to open database file: permission denied\n')
        return 1
      }
      GRAFANA_PASS.set(ctx.sys, args[2])
      const rt = GRAFANA.get(ctx.sys)
      if (rt) rt.adminPass = args[2]
      ctx.out('\nAdmin password changed successfully ✔\n\n')
      return 0
    }
    if (ctx.name === 'grafana' && ctx.args[0] === 'server') {
      ctx.err('[simulador] En la terminal, grafana no queda corriendo: usalo como servicio (systemctl start grafana-server).\n')
      return 0
    }
    ctx.err('Error: ✗ command not found. Usage: grafana cli admin reset-admin-password <new password>\n')
    return 1
  },
})

register('zabbix_agent2', {
  usage: 'zabbix_agent2 -t CLAVE | -T | -V',
  path: '/usr/sbin',
  run(ctx) {
    if (ctx.args.includes('-V') || ctx.args.includes('--version')) {
      ctx.out(`zabbix_agent2 (Zabbix) ${ZABBIX_VERSION}\nRevision a1b2c3d 5 November 2026, compilation time: Nov  5 2026 10:00:00, built with: go1.25.3\n\nCopyright (C) 2026 Zabbix SIA\n`)
      return 0
    }
    const conf = parseZabbixAgent(ctx.sys, argVal(ctx.args.join(' '), '-c') ?? '/etc/zabbix/zabbix_agent2.conf')
    if ('error' in conf) {
      ctx.err(`zabbix_agent2 [${ctx.sys.allocPid()}]: ERROR: ${conf.error}\n`)
      return 1
    }
    if (ctx.args.includes('-T') || ctx.args.includes('--test-config')) {
      ctx.out('Validating configuration file "/etc/zabbix/zabbix_agent2.conf"\nValidation successful\n')
      return 0
    }
    const t = ctx.args.indexOf('-t')
    if (t >= 0 && ctx.args[t + 1]) {
      const key = ctx.args[t + 1]
      const v = zabbixItem(ctx.sys, key, conf)
      ctx.out(`${key.padEnd(46)}[${v.startsWith('ZBX_NOTSUPPORTED') ? `m|${v}` : /^-?\d+$/.test(v) ? `u|${v}` : /^-?\d+\.\d+$/.test(v) ? `d|${v}` : `s|${v}`}]\n`)
      return 0
    }
    ctx.err('[simulador] En la terminal, zabbix_agent2 no queda corriendo: usalo como servicio (systemctl start zabbix-agent2).\n')
    return 0
  },
})

register('zabbix_get', {
  usage: 'zabbix_get -s EQUIPO -k CLAVE [-p PUERTO]',
  path: '/usr/bin',
  run(ctx) {
    const pid = ctx.sys.allocPid()
    const s = argVal(ctx.args.join(' '), '-s') ?? argVal(ctx.args.join(' '), '--host')
    const k = ctx.args.includes('-k') ? ctx.args[ctx.args.indexOf('-k') + 1] : argVal(ctx.args.join(' '), '--key')
    const port = Number(argVal(ctx.args.join(' '), '-p') ?? 10050)
    if (!s || !k) {
      ctx.err(`zabbix_get [${pid}]: either host or key not specified\nusage:\n  zabbix_get -s host-name-or-IP [-p port-number] [-I IP-address] [-t timeout] -k item-key\n`)
      return 1
    }
    const ip = /^\d+\.\d+\.\d+\.\d+$/.test(s) ? s : s === 'localhost' ? '127.0.0.1' : ctx.sys.resolveHost(s)
    if (!ip) {
      ctx.err(`zabbix_get [${pid}]: Get value error: cannot resolve [${s}]\n`)
      return 1
    }
    const r = reach(ctx.sys, ip, port)
    if ('error' in r) {
      ctx.err(`zabbix_get [${pid}]: Get value error: Cannot establish TCP connection to [[${s}]:${port}]: ${r.error === 'noroute' ? '[113] No route to host' : '[4] Interrupted system call'}\n`)
      return 1
    }
    const target = r.target
    if (!serviceActive(target, 'zabbix-agent2')) {
      ctx.err(`zabbix_get [${pid}]: Get value error: Cannot establish TCP connection to [[${s}]:${port}]: [111] Connection refused\n`)
      return 1
    }
    const conf = parseZabbixAgent(target)
    if ('error' in conf) return 1
    const allowed = conf.server.some((x) => {
      if (/^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(x)) return inCidr(r.clientIp, x.includes('/') ? x : `${x}/32`)
      if (x === 'localhost' || x === '::1') return r.clientIp.startsWith('127.')
      return target.resolveHost(x) === r.clientIp
    })
    if (!allowed) {
      try {
        target.vfs.writeFile('/var/log/zabbix/zabbix_agent2.log', `${new Date().toISOString().replace('T', ' ').slice(0, 19)}.000000 [101] failed to accept an incoming connection: connection from "${r.clientIp}" rejected, allowed hosts: "${conf.server.join(',')}"\n`, ROOT_CRED, { append: true })
      } catch {
        // sin log
      }
      ctx.err(`zabbix_get [${pid}]: Get value error: ZBX_TCP_READ() failed: [104] Connection reset by peer\nzabbix_get [${pid}]: Check access restrictions in Zabbix agent configuration\n`)
      return 1
    }
    ctx.out(`${zabbixItem(target, k, conf)}\n`)
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// Verificaciones de los ejercicios
// ---------------------------------------------------------------------------------------

export function verifyObservability(sys: System, check: object): { ok: boolean; label: string } | undefined {
  if ('prometheus_objetivo' in check) {
    const c = check as { prometheus_objetivo: string; estado?: 'up' | 'down'; job?: string }
    const data = promData(sys)
    const t = data?.targets.find((x) => x.target === c.prometheus_objetivo && (!c.job || x.job === c.job))
    const ok = !!t && (!c.estado || t.health === c.estado)
    return { ok, label: `Prometheus tiene el objetivo ${c.prometheus_objetivo}${c.job ? ` en el job ${c.job}` : ''}${c.estado ? ` (${c.estado === 'up' ? 'respondiendo' : 'caído'})` : ''}` }
  }
  if ('prometheus_alerta' in check) {
    const c = check as { prometheus_alerta: string; estado?: string }
    const st = promAlerts(sys).find((s) => s.rule.name === c.prometheus_alerta)
    return { ok: !!st && (!c.estado || st.state === c.estado), label: `Prometheus tiene la alerta ${c.prometheus_alerta}${c.estado ? ` en estado ${c.estado}` : ' cargada'}` }
  }
  if ('alertmanager_alerta' in check) {
    const c = check as { alertmanager_alerta: string; silenciada?: boolean }
    dispatch(sys)
    const a = amAlerts(sys).find((x) => x.labels.alertname === c.alertmanager_alerta)
    return { ok: !!a && (c.silenciada === undefined || (a.silencedBy.length > 0) === c.silenciada), label: `Alertmanager recibió la alerta ${c.alertmanager_alerta}${c.silenciada === true ? ' y está silenciada' : c.silenciada === false ? ' y no está silenciada' : ''}` }
  }
  if ('loki_lineas' in check) {
    const c = check as { loki_lineas: string; min: number }
    const db = lokiDb(sys)
    let n = 0
    try {
      const q = parseLogQL(c.loki_lineas)
      if (db && q.k === 'log') n = queryLogs(db, q.expr, 100000).lines.length
    } catch {
      n = 0
    }
    return { ok: n >= c.min, label: `Loki devuelve al menos ${c.min} ${c.min === 1 ? 'línea' : 'líneas'} para ${c.loki_lineas}` }
  }
  if ('grafana_datasource' in check) {
    const c = check as { grafana_datasource: string; tipo?: string; funciona?: boolean }
    const rt = grafanaRt(sys)
    const ds = rt?.datasources.find((d) => d.name === c.grafana_datasource)
    let ok = !!ds && (!c.tipo || ds.type === c.tipo)
    if (ok && c.funciona !== undefined) ok = (datasourceHealth(sys, ds!).status === 'OK') === c.funciona
    return { ok, label: `Grafana tiene el origen de datos ${c.grafana_datasource}${c.tipo ? ` (${c.tipo})` : ''}${c.funciona ? ' y responde' : ''}` }
  }
  return undefined
}

export { PromQLError }
