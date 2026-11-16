/**
 * RAID por software con mdadm: crear arreglos (0, 1, 5, 6 y 10), /proc/mdstat, mdadm --detail,
 * marcar un disco como fallado, sacarlo, agregar el reemplazo y ver la reconstrucción avanzar.
 * Si fallan más discos de los que soporta el nivel, el arreglo deja de servir y el sistema de
 * archivos montado encima da errores de entrada y salida. mdmonitor avisa por correo.
 */
import { SERVICE_CHECKS } from './commands/sysinfo'
import { submit } from './mail'
import { register, type CommandContext, type Foreground, type IO } from './shell'
import { MiB, mdMemberSize, type MdArray, type Storage } from './storage'
import { System } from './system'
import { ROOT_CRED } from './vfs'

const SPEED = 150 * MiB

function kib(bytes: number) {
  return Math.floor(bytes / 1024)
}

function shortName(dev: string) {
  return dev.replace(/^\/dev\//, '')
}

function confPath(sys: System) {
  return sys.distro === 'rocky' ? '/etc/mdadm.conf' : '/etc/mdadm/mdadm.conf'
}

function uuidHex(): string {
  const h = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')
  return `${h()}:${h()}:${h()}:${h()}`
}

function dateStr(t: number) {
  const d = new Date(t)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n: number) => String(n).padStart(2, '0')
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`
}

function kernel(sys: System, message: string, priority = 6) {
  sys.journal.push({ time: Date.now(), unit: 'kernel', priority, message, ident: 'kernel' })
}

/** Integrantes que están en su lugar y funcionando (sin contar el que se está reconstruyendo). */
function inSync(a: MdArray) {
  return a.members.filter((m) => m.role >= 0 && !m.faulty && m.dev !== a.sync?.dev)
}

/** ¿Siguen estando todos los datos? */
function dataOk(a: MdArray): boolean {
  const roles = new Set(inSync(a).map((m) => m.role))
  const missing = a.raidDevices - roles.size
  if (a.level === 0) return missing === 0
  if (a.level === 1) return roles.size >= 1
  if (a.level === 5) return missing <= 1
  if (a.level === 6) return missing <= 2
  // RAID 10 (near=2): cada par de espejos necesita al menos uno.
  for (let i = 0; i < a.raidDevices; i += 2) if (!roles.has(i) && !roles.has(i + 1)) return false
  return true
}

function degraded(a: MdArray) {
  return new Set(inSync(a).map((m) => m.role)).size < a.raidDevices
}

function statusString(a: MdArray) {
  const roles = new Set(inSync(a).map((m) => m.role))
  return Array.from({ length: a.raidDevices }, (_, i) => (roles.has(i) ? 'U' : '_')).join('')
}

/** Avanza la reconstrucción según el tiempo que pasó. */
function tick(sys: System, a: MdArray) {
  if (!a.sync) return
  if (Date.now() - a.sync.start >= a.sync.duration) finishSync(sys, a)
}

function finishSync(sys: System, a: MdArray) {
  if (!a.sync) return
  const kind = a.sync.kind
  a.sync = undefined
  a.events += 2
  a.updated = Date.now()
  kernel(sys, `md: ${a.name}: ${kind === 'recovery' ? 'recovery' : 'resync'} done.`)
  monitorEvent(sys, a, kind === 'recovery' ? 'RebuildFinished' : 'ResyncFinished')
}

/** Empieza a reconstruir sobre un repuesto, si hay un lugar libre y un repuesto disponible. */
function startRecovery(sys: System, a: MdArray) {
  if (a.sync || a.failed) return
  const taken = new Set(a.members.filter((m) => m.role >= 0 && !m.faulty).map((m) => m.role))
  const free = Array.from({ length: a.raidDevices }, (_, i) => i).find((i) => !taken.has(i))
  if (free === undefined) return
  const spare = a.members.find((m) => m.role === -1 && !m.faulty)
  if (!spare) return
  spare.role = free
  a.sync = { kind: 'recovery', dev: spare.dev, start: Date.now(), duration: Math.max(4000, (mdMemberSize(sys.storage, a) / SPEED) * 1000) }
  a.events += 2
  kernel(sys, `md: recovery of RAID array ${a.name}`)
  monitorEvent(sys, a, 'RebuildStarted')
}

// ---------------------------------------------------------------------------------------
// mdmonitor: avisa por correo
// ---------------------------------------------------------------------------------------

function mailAddr(sys: System): string | undefined {
  const f = confPath(sys)
  if (!sys.vfs.exists(f)) return undefined
  return /^\s*MAILADDR\s+(\S+)/m.exec(sys.vfs.readFile(f, ROOT_CRED))?.[1]
}

function monitorEvent(sys: System, a: MdArray, event: string, dev?: string) {
  sys.journal.push({ time: Date.now(), unit: 'mdmonitor.service', priority: event === 'Fail' || event === 'DegradedArray' ? 3 : 6, message: `${event} event detected on md device /dev/${a.name}${dev ? `, component device ${dev}` : ''}`, ident: 'mdadm', pid: 911 })
  if (!sys.services.get('mdmonitor')?.active) return
  if (!['Fail', 'DegradedArray', 'FailSpare'].includes(event)) return
  const to = mailAddr(sys)
  if (!to || !sys.installed.has('postfix')) return
  const body = `This is an automatically generated mail message from mdadm\nrunning on ${sys.hostname}\n\nA ${event} event had been detected on md device /dev/${a.name}.\n\n${dev ? `It could be related to component device ${dev}.\n\n` : ''}Faithfully yours, etc.\n\nP.S. The /proc/mdstat file currently contains the following:\n\n${mdstat(sys.storage)}`
  submit(sys, 0, 'root', [to], `${event} event on /dev/${a.name}:${sys.hostname}`, body)
}

// ---------------------------------------------------------------------------------------
// /proc/mdstat y mdadm --detail
// ---------------------------------------------------------------------------------------

export function mdstat(st: Storage): string {
  const arrays = [...st.arrays.values()]
  const pers = new Set<string>()
  for (const a of arrays) {
    if (a.level === 1) pers.add('[raid1]')
    else if (a.level === 0) pers.add('[raid0]')
    else if (a.level === 10) pers.add('[raid10]')
    else ['[raid6]', '[raid5]', '[raid4]'].forEach((x) => pers.add(x))
  }
  let out = `Personalities : ${[...pers].join(' ')}${pers.size ? ' ' : ''}\n`
  for (const a of arrays) {
    const devs = [...a.members].reverse().map((m) => `${shortName(m.dev)}[${m.num}]${m.faulty ? '(F)' : m.role === -1 && m.dev !== a.sync?.dev ? '(S)' : ''}`)
    const blocks = kib(st.size(`/dev/${a.name}`) ?? 0)
    out += `${a.name} : active raid${a.level} ${devs.join(' ')}\n`
    let geo = `      ${blocks} blocks super 1.2`
    if (a.level === 5 || a.level === 6) geo += ` level ${a.level}, ${a.chunkKiB}k chunk, algorithm 2 [${a.raidDevices}/${new Set(inSync(a).map((m) => m.role)).size}] [${statusString(a)}]`
    else if (a.level === 10) geo += ` ${a.chunkKiB}K chunks 2 near-copies [${a.raidDevices}/${new Set(inSync(a).map((m) => m.role)).size}] [${statusString(a)}]`
    else if (a.level === 1) geo += ` [${a.raidDevices}/${new Set(inSync(a).map((m) => m.role)).size}] [${statusString(a)}]`
    else geo += ` ${a.chunkKiB}k chunks`
    out += geo + '\n'
    if (a.sync) {
      const total = kib(mdMemberSize(st, a))
      const frac = Math.min(0.999, (Date.now() - a.sync.start) / a.sync.duration)
      const bar = Math.floor(frac * 20)
      const left = ((1 - frac) * a.sync.duration) / 60000
      out += `      [${'='.repeat(bar)}>${'.'.repeat(19 - bar)}]  ${a.sync.kind} = ${(frac * 100).toFixed(1)}% (${Math.floor(total * frac)}/${total}) finish=${left.toFixed(1)}min speed=${kib(SPEED)}K/sec\n`
    }
    out += '      \n'
  }
  return out + 'unused devices: <none>\n'
}

function detail(st: Storage, sys: System, a: MdArray): string {
  const size = st.size(`/dev/${a.name}`) ?? 0
  const each = mdMemberSize(st, a)
  const hb = (b: number) => `${(b / 1024 ** 3).toFixed(2)} GiB ${(b / 1e9).toFixed(2)} GB`
  const active = inSync(a).length
  const failed = a.members.filter((m) => m.faulty).length
  const spares = a.members.filter((m) => m.role === -1 && !m.faulty).length + (a.sync ? 1 : 0)
  const working = a.members.filter((m) => !m.faulty).length
  const state = a.failed ? 'clean, FAILED' : [a.sync?.kind === 'resync' ? 'active, resyncing' : 'clean', degraded(a) ? 'degraded' : '', a.sync?.kind === 'recovery' ? 'recovering' : ''].filter(Boolean).join(', ')
  let out = `/dev/${a.name}:\n           Version : 1.2\n     Creation Time : ${dateStr(a.created)}\n        Raid Level : raid${a.level}\n        Array Size : ${kib(size)} (${hb(size)})\n`
  if (a.level !== 0) out += `     Used Dev Size : ${kib(each)} (${hb(each)})\n`
  out += `      Raid Devices : ${a.raidDevices}\n     Total Devices : ${a.members.length}\n       Persistence : Superblock is persistent\n\n       Update Time : ${dateStr(a.updated)}\n             State : ${state} \n    Active Devices : ${active}\n   Working Devices : ${working}\n    Failed Devices : ${failed}\n     Spare Devices : ${spares}\n\n`
  if (a.level === 5 || a.level === 6) out += `            Layout : left-symmetric\n        Chunk Size : ${a.chunkKiB}K\n\n`
  if (a.level === 10) out += `            Layout : near=2\n        Chunk Size : ${a.chunkKiB}K\n\n`
  if (a.level === 0) out += `        Chunk Size : ${a.chunkKiB}K\n\n`
  out += `Consistency Policy : ${a.level === 0 ? 'none' : 'resync'}\n\n`
  if (a.sync) out += `    ${a.sync.kind === 'recovery' ? 'Rebuild' : ' Resync'} Status : ${Math.floor(Math.min(0.99, (Date.now() - a.sync.start) / a.sync.duration) * 100)}% complete\n\n`
  out += `              Name : ${a.hostName}:${a.minor}  (local to host ${sys.hostname})\n              UUID : ${a.uuid}\n            Events : ${a.events}\n\n    Number   Major   Minor   RaidDevice State\n`
  const majmin = (dev: string) => {
    const d = /^\/dev\/(sd[a-z])(\d*)$/.exec(dev)
    const disk = d ? st.disks.get(d[1]) : undefined
    return disk ? [disk.major, disk.minor + Number(d![2] || 0)] : [0, 0]
  }
  for (let role = 0; role < a.raidDevices; role++) {
    const m = a.members.find((x) => x.role === role && !x.faulty)
    if (!m) {
      out += `       -       0        0        ${role}      removed\n`
      continue
    }
    const [maj, min] = majmin(m.dev)
    const what = m.dev === a.sync?.dev ? 'spare rebuilding' : 'active sync'
    out += `${String(m.num).padStart(8)}${String(maj).padStart(8)}${String(min).padStart(9)}${String(role).padStart(9)}      ${what}   ${m.dev}\n`
  }
  out += '\n'
  for (const m of a.members.filter((x) => x.faulty || x.role === -1)) {
    const [maj, min] = majmin(m.dev)
    out += `${String(m.num).padStart(8)}${String(maj).padStart(8)}${String(min).padStart(9)}        -      ${m.faulty ? 'faulty' : 'spare'}   ${m.dev}\n`
  }
  return out
}

// ---------------------------------------------------------------------------------------
// Fallas
// ---------------------------------------------------------------------------------------

/** Un integrante falla (por mdadm --fail o porque el disco se rompió). */
export function failMember(sys: System, a: MdArray, dev: string, reason: 'manual' | 'io' = 'manual') {
  const m = a.members.find((x) => x.dev === dev)
  if (!m || m.faulty) return
  const wasRebuilding = a.sync?.dev === dev
  m.faulty = true
  if (wasRebuilding) a.sync = undefined
  a.events += 2
  a.updated = Date.now()
  if (reason === 'io') kernel(sys, `blk_update_request: I/O error, dev ${shortName(dev)}, sector 2048 op 0x1:(WRITE) flags 0x800 phys_seg 1 prio class 0`, 3)
  kernel(sys, `md/raid${a.level === 10 ? '10' : a.level === 1 ? '1' : a.level === 0 ? '0' : '456'}:${a.name}: Disk failure on ${shortName(dev)}, disabling device.`, 2)
  if (!dataOk(a)) {
    a.failed = true
    // La reconstrucción se corta: el disco que se estaba llenando vuelve a ser un repuesto.
    const target = a.members.find((x) => x.dev === a.sync?.dev)
    if (target) target.role = -1
    a.sync = undefined
    kernel(sys, `md/raid${a.level}:${a.name}: Cannot continue operation (${a.members.filter((x) => x.faulty).length}/${a.raidDevices} failed).`, 2)
    const mp = sys.storage.mounts.find((x) => x.dev === `/dev/${a.name}`)
    if (mp) kernel(sys, `XFS (${a.name}): log I/O error -5`, 2)
    if (mp) kernel(sys, `XFS (${a.name}): Filesystem has been shut down due to log error (0x2).`, 2)
  } else kernel(sys, `md/raid${a.level === 1 ? '1' : '456'}:${a.name}: Operation continuing on ${new Set(inSync(a).map((x) => x.role)).size} devices.`, 2)
  monitorEvent(sys, a, 'Fail', dev)
  if (!a.failed) startRecovery(sys, a)
}

// ---------------------------------------------------------------------------------------
// mdadm
// ---------------------------------------------------------------------------------------

class Confirm implements Foreground {
  constructor(
    private q: string,
    private done: (yes: boolean, io: IO) => void,
  ) {}
  prompt() {
    return this.q
  }
  async line(text: string, io: IO): Promise<'exit'> {
    this.done(/^y(es)?$/i.test(text.trim()), io)
    return 'exit'
  }
}

function findArray(st: Storage, arg: string | undefined): MdArray | undefined {
  if (!arg) return undefined
  const name = arg.replace(/^\/dev\/(md\/)?/, '')
  return st.arrays.get(name) ?? [...st.arrays.values()].find((a) => `${a.minor}` === name)
}

function create(ctx: CommandContext, args: string[]): number {
  const sys = ctx.sys
  const st = sys.storage
  let level: number | undefined
  let n: number | undefined
  let spareN = 0
  let chunk = 512
  let run = false
  const devs: string[] = []
  let target = ''
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const val = (short: string, long: string) => (a === short || a === long ? args[++i] : a.startsWith(long + '=') ? a.slice(long.length + 1) : a.startsWith(short) && a.length > short.length && !a.startsWith('--') ? a.slice(short.length) : undefined)
    let v: string | undefined
    if ((v = val('-l', '--level')) !== undefined) level = Number(v.replace(/^raid/, ''))
    else if ((v = val('-n', '--raid-devices')) !== undefined) n = Number(v)
    else if ((v = val('-x', '--spare-devices')) !== undefined) spareN = Number(v)
    else if ((v = val('-c', '--chunk')) !== undefined) chunk = parseInt(v, 10)
    else if (a === '-R' || a === '--run') run = true
    else if (a === '--create' || a === '-C' || a === '--verbose' || a === '-v' || a.startsWith('--metadata') || a.startsWith('--name') || a === '--assume-clean') continue
    else if (a.startsWith('-')) continue
    else if (!target) target = a
    else devs.push(a)
  }
  if (!target || !/^\/dev\/md\/?\w+$/.test(target)) {
    ctx.err(`mdadm: ${target || 'device'} is an invalid name for an md device.  Try /dev/md/${target.replace(/^\/dev\//, '') || 'name'}\n`)
    return 1
  }
  if (level === undefined || ![0, 1, 5, 6, 10].includes(level)) {
    ctx.err(level === undefined ? 'mdadm: a RAID level is needed to create an array.\n' : `mdadm: invalid raid level: ${level}\n`)
    return 2
  }
  if (!n) {
    ctx.err('mdadm: no raid-devices specified.\n')
    return 2
  }
  const name = target.replace(/^\/dev\/(md\/)?/, '').replace(/^(\d+)$/, 'md$1')
  if (st.arrays.has(name)) {
    ctx.err(`mdadm: ${target} is already in use.\n`)
    return 1
  }
  const min = { 0: 1, 1: 2, 5: 2, 6: 4, 10: 2 }[level as 0 | 1 | 5 | 6 | 10]
  if (n < min) {
    ctx.err(`mdadm: at least ${min} raid-devices needed for level ${level}\n`)
    return 2
  }
  if (devs.length < n + spareN) {
    ctx.err(`mdadm: You haven't given enough devices (real or missing) to create this array\n`)
    return 2
  }
  if (devs.length > n + spareN) {
    ctx.err(`mdadm: You have listed more devices (${devs.length}) than are in the array(${n + spareN})!\n`)
    return 2
  }
  for (const d of devs) {
    if (d === 'missing') continue
    if (st.size(d) === undefined) {
      ctx.err(`mdadm: cannot open ${d}: No such file or directory\n`)
      return 1
    }
    const disk = st.disks.get(shortName(d))
    if (disk?.parts.length) {
      ctx.err(`mdadm: cannot open ${d}: Device or resource busy\n[simulador] ${d} tiene particiones: usá las particiones o borrá la tabla con wipefs -a.\n`)
      return 1
    }
    if (st.holder(d)) {
      ctx.err(`mdadm: cannot open ${d}: Device or resource busy\n`)
      return 1
    }
  }
  const doIt = (io: { out: (s: string) => void; err: (s: string) => void }) => {
    const minor = Number(/\d+$/.exec(name)?.[0] ?? st.arrays.size)
    const now = Date.now()
    const members = devs.map((d, i) => ({ dev: d, num: i, role: i < n! ? i : -1, faulty: false })).filter((m) => m.dev !== 'missing')
    const a: MdArray = { name, level: level as MdArray['level'], raidDevices: n!, members, chunkKiB: chunk, uuid: uuidHex(), hostName: sys.hostname.split('.')[0], created: now, updated: now, events: 0, minor, failed: false }
    st.arrays.set(name, a)
    st.syncDevFiles()
    io.err('mdadm: Defaulting to version 1.2 metadata\n')
    io.err(`mdadm: array ${target} started.\n`)
    kernel(sys, `md/raid${level === 1 ? '1' : level === 0 ? '0' : level === 10 ? '10' : '456'}:${name}: ${degraded(a) ? 'not clean -- starting background reconstruction' : 'active'} with ${members.filter((m) => m.role >= 0).length} out of ${n} devices`)
    // RAID 1, 5, 6 y 10 recién creados sincronizan sus copias o su paridad en segundo plano.
    if (level !== 0 && !degraded(a)) {
      a.sync = { kind: level === 5 ? 'recovery' : 'resync', dev: level === 5 ? members[n! - 1].dev : undefined, start: now, duration: Math.max(4000, (mdMemberSize(st, a) / SPEED) * 1000) }
    }
    return 0
  }
  if (level === 1 && !run) {
    const note = 'mdadm: Note: this array has metadata at the start and\n    may not be suitable as a boot device.  If you plan to\n    store \'/boot\' on this device please ensure that\n    your boot-loader understands md/v1.x metadata, or use\n    --metadata=0.90\n'
    const piped = ctx.stdin.readAll()
    if (piped || !ctx.isTTY) {
      ctx.err(note + 'Continue creating array [y/N]? ')
      if (!/^y/i.test(piped.trim())) {
        ctx.err('\nmdadm: create aborted.\n')
        return 1
      }
      ctx.err('\n')
      return doIt(ctx)
    }
    ctx.err(note)
    ctx.sh.fg = new Confirm('Continue creating array [y/N]? ', (yes, io) => {
      ctx.sh.fg = undefined
      if (!yes) {
        io.err('mdadm: create aborted.\n')
        ctx.sh.lastExit = 1
        return
      }
      ctx.sh.lastExit = doIt(io)
    })
    return 0
  }
  return doIt(ctx)
}

register('mdadm', {
  usage: 'mdadm --create /dev/md0 --level=1 --raid-devices=2 /dev/sdb /dev/sdc | mdadm --detail /dev/md0 | mdadm /dev/md0 --fail|--remove|--add /dev/sdX',
  summary:
    '  --create (-C)  crea un arreglo: --level (-l), --raid-devices (-n), --spare-devices (-x)\n  --detail (-D)  el estado del arreglo   --detail --scan  la línea para mdadm.conf\n  --fail (-f), --remove (-r), --add (-a)  marcar un disco fallado, sacarlo, agregar el reemplazo\n  --stop (-S), --assemble --scan (-As), --zero-superblock, --examine (-E), --wait (-W)',
  path: '/usr/sbin',
  run(ctx) {
    const sys = ctx.sys
    const st = sys.storage
    const args = [...ctx.args]
    if (!args.length) {
      ctx.err('Usage: mdadm --help\n  for help\n')
      return 1
    }
    if (args.includes('--version') || args.includes('-V')) {
      ctx.err(`mdadm - v4.3 - 2024-02-15${sys.distro === 'ubuntu' ? '' : ''}\n`)
      return 0
    }
    const readOnly = args.some((a) => /^(--detail|-D|--examine|-E|--query|-Q)$/.test(a)) && !args.includes('--scan')
    if (ctx.sh.user !== 'root' && !readOnly) {
      ctx.err('mdadm: must be super-user to perform this action\n')
      return 1
    }
    for (const a of st.arrays.values()) tick(sys, a)
    if (args[0] === '--create' || args[0] === '-C' || /^--create$/.test(args[1] ?? '') || args.includes('--create') || args.includes('-C')) return create(ctx, args)
    // Detalle
    if (args.includes('--detail') || args.includes('-D')) {
      if (args.includes('--scan') || args.includes('-s')) {
        for (const a of st.arrays.values()) ctx.out(`ARRAY /dev/${a.name} metadata=1.2 name=${a.hostName}:${a.minor} UUID=${a.uuid}\n`)
        return 0
      }
      const target = args.find((x) => x.startsWith('/dev/'))
      const a = findArray(st, target)
      if (!a) {
        ctx.err(`mdadm: cannot open ${target ?? ''}: No such file or directory\n`)
        return 1
      }
      ctx.out(detail(st, sys, a))
      return a.failed ? 1 : degraded(a) ? 1 : 0
    }
    if (args.includes('--examine') || args.includes('-E')) {
      const dev = args.find((x) => x.startsWith('/dev/'))!
      const a = st.mdOf(dev ?? '')
      if (!a) {
        ctx.err(`mdadm: No md superblock detected on ${dev}.\n`)
        return 1
      }
      const m = a.members.find((x) => x.dev === dev)!
      ctx.out(`${dev}:\n          Magic : a92b4efc\n        Version : 1.2\n    Feature Map : 0x0\n     Array UUID : ${a.uuid}\n           Name : ${a.hostName}:${a.minor}  (local to host ${sys.hostname})\n  Creation Time : ${dateStr(a.created)}\n     Raid Level : raid${a.level}\n   Raid Devices : ${a.raidDevices}\n\n    Device Role : ${m.role >= 0 ? `Active device ${m.role}` : 'spare'}\n   Array State : ${statusString(a).replace(/U/g, 'A').replace(/_/g, '.')} ('A' == active, '.' == missing, 'R' == replacing)\n`)
      return 0
    }
    if (args.includes('--wait') || args.includes('-W')) {
      for (const a of st.arrays.values()) if (a.sync) finishSync(sys, a)
      return 0
    }
    if (args.includes('--zero-superblock')) {
      for (const dev of args.filter((x) => x.startsWith('/dev/'))) {
        if (st.mdOf(dev)?.members.some((m) => m.dev === dev && !m.faulty)) {
          ctx.err(`mdadm: Couldn't open ${dev} for write - not zeroing\n`)
          return 1
        }
        const a = st.mdOf(dev)
        if (a) a.members = a.members.filter((m) => m.dev !== dev)
      }
      return 0
    }
    if (args.includes('--stop') || args.includes('-S')) {
      const a = findArray(st, args.find((x) => x.startsWith('/dev/')))
      if (!a) {
        ctx.err('mdadm: error opening : No such file or directory\n')
        return 1
      }
      if (st.mounts.some((m) => m.dev === `/dev/${a.name}`) || st.vgOf(`/dev/${a.name}`)) {
        ctx.err(`mdadm: Cannot get exclusive access to /dev/${a.name}:Perhaps a running process, mounted filesystem or active volume group?\n`)
        return 1
      }
      st.arrays.delete(a.name)
      st.syncDevFiles()
      ctx.err(`mdadm: stopped /dev/${a.name}\n`)
      return 0
    }
    if (args.includes('--assemble') || args.includes('-A') || args.includes('-As')) {
      return 0
    }
    // Administración: mdadm [--manage] /dev/md0 --fail /dev/sdc --remove /dev/sdc --add /dev/sdd
    const target = args.find((x) => /^\/dev\/md/.test(x))
    const a = findArray(st, target)
    if (!a) {
      ctx.err(`mdadm: error opening ${target ?? ''}: No such file or directory\n`)
      return 1
    }
    let op: string | undefined
    let code = 0
    for (const x of args) {
      if (x === target || x === '--manage') continue
      if (/^(--fail|-f|--set-faulty)$/.test(x)) op = 'fail'
      else if (/^(--remove|-r)$/.test(x)) op = 'remove'
      else if (/^(--add|-a|--re-add)$/.test(x)) op = 'add'
      else if (x.startsWith('/dev/') || x === 'failed' || x === 'detached') {
        if (op === 'fail') {
          const m = a.members.find((y) => y.dev === x)
          if (!m) {
            ctx.err(`mdadm: set device faulty failed for ${x}:  No such device\n`)
            code = 1
            continue
          }
          ctx.err(`mdadm: set ${x} faulty in /dev/${a.name}\n`)
          failMember(sys, a, x)
        } else if (op === 'remove') {
          const list = x === 'failed' ? a.members.filter((m) => m.faulty) : a.members.filter((m) => m.dev === x)
          for (const m of list) {
            if (!m.faulty && m.role >= 0) {
              ctx.err(`mdadm: hot remove failed for ${m.dev}: Device or resource busy\n`)
              code = 1
              continue
            }
            a.members = a.members.filter((y) => y !== m)
            a.events += 1
            ctx.err(`mdadm: hot removed ${m.dev} from /dev/${a.name}\n`)
          }
          if (!list.length) {
            ctx.err(`mdadm: hot remove failed for ${x}: No such device or address\n`)
            code = 1
          }
        } else if (op === 'add') {
          if (st.size(x) === undefined) {
            ctx.err(`mdadm: cannot find ${x}: No such file or directory\n`)
            code = 1
            continue
          }
          if (st.holder(x)) {
            ctx.err(`mdadm: Cannot open ${x}: Device or resource busy\n`)
            code = 1
            continue
          }
          if ((st.size(x) ?? 0) < mdMemberSize(st, a)) {
            ctx.err(`mdadm: ${x} not large enough to join array\n`)
            code = 1
            continue
          }
          if (a.failed) {
            ctx.err(`mdadm: /dev/${a.name} has failed so using --add cannot work and might destroy\nmdadm: data on ${x}.  You should stop the array and re-assemble it.\n`)
            code = 1
            continue
          }
          a.members.push({ dev: x, num: Math.max(-1, ...a.members.map((m) => m.num)) + 1, role: -1, faulty: false })
          a.events += 1
          ctx.err(`mdadm: added ${x}\n`)
          startRecovery(sys, a)
        } else {
          ctx.err('mdadm: no operation given for the device\n')
          code = 1
        }
      }
    }
    a.updated = Date.now()
    return code
  },
})

// ---------------------------------------------------------------------------------------
// /proc/mdstat, estado inicial, mdmonitor y verificaciones
// ---------------------------------------------------------------------------------------

System.refreshHooks.push((sys) => {
  const st = sys.storage
  if (!st.arrays.size && !sys.vfs.exists('/proc/mdstat')) return
  for (const a of st.arrays.values()) tick(sys, a)
  try {
    sys.vfs.writeFile('/proc/mdstat', mdstat(st), ROOT_CRED)
  } catch {
    // sin /proc
  }
})

/** Un sistema de archivos sobre un arreglo caído da errores de entrada y salida. */
System.initHooks.push((sys) => {
  sys.vfs.ioGuard = (abs) => {
    for (const a of sys.storage.arrays.values()) {
      if (!a.failed) continue
      const m = sys.storage.mounts.find((x) => x.dev === `/dev/${a.name}`)
      if (m && (abs === m.target || abs.startsWith(m.target + '/'))) return true
    }
    return false
  }
})

SERVICE_CHECKS['mdmonitor'] = (ctx) => {
  if (!mailAddr(ctx.sys) && !ctx.sys.vfs.exists(confPath(ctx.sys))) return `mdadm: No mail address or alert command - not monitoring.`
  for (const a of ctx.sys.storage.arrays.values()) if (degraded(a)) monitorEvent(ctx.sys, a, 'DegradedArray')
  return undefined
}

export function verifyRaid(sys: System, check: object): { ok: boolean; label: string } | undefined {
  if (!('raid' in check)) return undefined
  const c = check as { raid: string; nivel?: number; estado?: string; activos?: number; repuestos?: number }
  const a = findArray(sys.storage, c.raid)
  if (a) tick(sys, a)
  const parts: string[] = []
  let ok = !!a
  if (c.nivel !== undefined) {
    ok &&= a?.level === c.nivel
    parts.push(`RAID ${c.nivel}`)
  }
  if (c.estado) {
    const st = !a ? '' : a.failed ? 'fallado' : a.sync ? (a.sync.kind === 'recovery' ? 'reconstruyendo' : 'sincronizando') : degraded(a) ? 'degradado' : 'sano'
    ok &&= st === c.estado
    parts.push(c.estado)
  }
  if (c.activos !== undefined) {
    ok &&= !!a && inSync(a).length + (a.sync?.dev ? 1 : 0) === c.activos
    parts.push(`con ${c.activos} discos activos`)
  }
  if (c.repuestos !== undefined) {
    ok &&= !!a && a.members.filter((m) => m.role === -1 && !m.faulty).length === c.repuestos
    parts.push(`y ${c.repuestos} de repuesto`)
  }
  return { ok, label: `/dev/${c.raid.replace(/^\/dev\//, '')} ${parts.join(' ')}`.trim() }
}

/** Arreglos que ya existen al empezar el ejercicio. */
System.initHooks.push((sys, state) => {
  const st = sys.storage
  for (const r of state.raid ?? []) {
    const name = r.nombre.replace(/^\/dev\//, '')
    const created = Date.now() - 200 * 86_400_000
    const a: MdArray = {
      name,
      level: r.nivel,
      raidDevices: r.discos.length,
      members: [...r.discos.map((d, i) => ({ dev: d, num: i, role: i, faulty: false })), ...r.repuestos.map((d, i) => ({ dev: d, num: r.discos.length + i, role: -1, faulty: false }))],
      chunkKiB: 512,
      uuid: uuidHex(),
      hostName: sys.hostname.split('.')[0],
      created,
      updated: created,
      events: 180,
      minor: Number(/\d+$/.exec(name)?.[0] ?? 0),
      failed: false,
    }
    st.arrays.set(name, a)
    st.syncDevFiles()
    for (const d of r.fallados) {
      const m = a.members.find((x) => x.dev === d)
      if (m) {
        m.faulty = true
        a.events += 2
      }
    }
    if (!dataOk(a)) a.failed = true
    if (r.fs) {
      const sig = st.makeFs(`/dev/${name}`, r.fs)
      if (r.usado) sig.baseUsed = Math.min(sig.size, Math.round(sig.size * r.usado))
      if (r.montaje) {
        sys.vfs.mkdirp(r.montaje, ROOT_CRED)
        st.mount(`/dev/${name}`, r.montaje, r.fs, r.fs === 'xfs' ? 'rw,relatime,seclabel,attr2,inode64,logbufs=8,logbsize=32k,sunit=1024,swidth=2048,noquota' : 'rw,relatime,stripe=256')
      }
    }
    if (r.fallados.length) {
      for (const d of r.fallados) kernel(sys, `md/raid${a.level}:${name}: Disk failure on ${shortName(d)}, disabling device.`, 2)
      startRecovery(sys, a)
    }
  }
  if (state.raid?.length) {
    const f = confPath(sys)
    if (sys.installed.has('mdadm') && !sys.vfs.exists(f)) {
      sys.vfs.mkdirp(f.replace(/\/[^/]+$/, ''), ROOT_CRED)
      sys.vfs.writeFile(f, [...st.arrays.values()].map((a) => `ARRAY /dev/${a.name} metadata=1.2 name=${a.hostName}:${a.minor} UUID=${a.uuid}`).join('\n') + '\n', ROOT_CRED)
    }
  }
})

