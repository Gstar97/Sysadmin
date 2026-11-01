/**
 * Procesos y rendimiento: top, uptime, free, vmstat, iostat, mpstat, sar, iotop, nice, renice,
 * nohup y pstree. Todos usan el mismo modelo (perf.ts).
 */
import { parseArgs } from '../args'
import { jitter, MEM_TOTAL_KB, metrics, NCPU } from '../perf'
import { register, type CommandContext } from '../shell'
import { commOf, type Proc } from '../system'

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const f1 = (n: number) => n.toFixed(1)

function uptimeLine(ctx: CommandContext): string {
  const mins = Math.floor((Date.now() - ctx.sys.bootTime) / 60_000)
  const days = Math.floor(mins / 1440)
  const hh = Math.floor((mins % 1440) / 60)
  const mm = mins % 60
  const users = new Set(ctx.sys.procs.filter((p) => p.cmd === '-bash').map((p) => p.user)).size || 1
  const m = metrics(ctx.sys)
  return ` ${new Date().toTimeString().slice(0, 8)} up ${days} days, ${String(hh).padStart(2)}:${pad(mm)},  ${users} user${users > 1 ? 's' : ''},  load average: ${m.load.map((x) => x.toFixed(2)).join(', ')}`
}

export function loadText(ctx: CommandContext): string {
  return metrics(ctx.sys).load.map((x) => x.toFixed(2)).join(', ')
}

register('uptime', {
  usage: 'uptime [-p]',
  run(ctx) {
    if (ctx.args.includes('-p')) {
      const mins = Math.floor((Date.now() - ctx.sys.bootTime) / 60_000)
      ctx.out(`up ${Math.floor(mins / 1440)} days, ${Math.floor((mins % 1440) / 60)} hours, ${mins % 60} minutes\n`)
    } else ctx.out(uptimeLine(ctx) + '\n')
    return 0
  },
})

function procRows(ctx: CommandContext, list: Proc[], limit: number) {
  for (const p of list.slice(0, limit)) {
    const ni = p.nice ?? 0
    const pr = 20 + ni
    const virt = Math.round(20000 + p.mem * 40000)
    const res = Math.round(4000 + (p.mem * MEM_TOTAL_KB) / 100)
    const mins = Math.floor(((Date.now() - p.start) / 1000) * (p.cpu / 100) / 60)
    const time = `${Math.min(999, mins)}:${pad(Math.floor(Math.random() * 0) + (mins % 60))}.${pad(Math.round(p.cpu) % 100)}`
    ctx.out(`${String(p.pid).padStart(7)} ${p.user.padEnd(9).slice(0, 9)} ${String(pr).padStart(2)} ${String(ni).padStart(3)} ${String(virt).padStart(7)} ${String(res).padStart(6)} ${String(Math.round(res / 3)).padStart(6)} ${p.stat[0]} ${f1(p.cpu).padStart(5)} ${f1(p.mem).padStart(5)} ${time.padStart(9)} ${commOf(p)}\n`)
  }
}

register(['top', 'htop'], {
  usage: 'top [-b] [-n N] [-o CAMPO] [-u USUARIO] [-p PID]',
  summary: '  Teclas en un servidor real: P (ordenar por CPU), M (por memoria), k (matar), r (renice), 1 (cada CPU), q (salir)',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { b: ['b'], c: ['c'] }, values: { n: ['n'], o: ['o'], u: ['u', 'U'], p: ['p'], d: ['d'] } })
    const m = metrics(ctx.sys)
    let procs = [...ctx.sys.procs]
    const sort = a.values.get('o')?.replace(/^[+-]/, '')
    if (sort === '%MEM') procs.sort((x, y) => y.mem - x.mem || x.pid - y.pid)
    else if (sort === 'PID') procs.sort((x, y) => x.pid - y.pid)
    else procs.sort((x, y) => y.cpu - x.cpu || y.mem - x.mem || x.pid - y.pid)
    if (a.values.has('u')) procs = procs.filter((p) => p.user === a.values.get('u'))
    if (a.values.has('p')) procs = procs.filter((p) => a.values.get('p')!.split(',').includes(String(p.pid)))
    const all = ctx.sys.procs
    const count = (c: string) => all.filter((p) => p.stat.startsWith(c)).length
    const running = all.filter((p) => p.stat.startsWith('R')).length
    const mb = (kb: number) => f1(kb / 1024).padStart(8)
    ctx.out(
      `top - ${uptimeLine(ctx).trim().replace(/^\S+ /, `${new Date().toTimeString().slice(0, 8)} `)}\n` +
        `Tasks: ${String(all.length + 95).padStart(3)} total, ${String(running).padStart(3)} running, ${String(all.length + 95 - running - count('T') - count('Z')).padStart(3)} sleeping, ${String(count('T')).padStart(3)} stopped, ${String(count('Z')).padStart(3)} zombie\n` +
        `%Cpu(s): ${f1(m.us).padStart(4)} us, ${f1(m.sy).padStart(4)} sy, ${f1(m.ni).padStart(4)} ni, ${f1(m.id).padStart(4)} id, ${f1(m.wa).padStart(4)} wa,  0.0 hi,  0.1 si, ${f1(m.st).padStart(4)} st\n` +
        `MiB Mem : ${mb(MEM_TOTAL_KB)} total, ${mb(m.memFreeKb)} free, ${mb(m.memUsedKb)} used, ${mb(m.cacheKb)} buff/cache\n` +
        `MiB Swap: ${mb(m.swapTotalKb)} total, ${mb(m.swapTotalKb - m.swapUsedKb)} free, ${mb(m.swapUsedKb)} used. ${mb(m.availKb)} avail Mem\n\n` +
        '    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND\n',
    )
    procRows(ctx, procs, 15)
    if (ctx.isTTY && !a.flags.has('b')) ctx.err(`[simulador] ${ctx.name} se actualiza en vivo y se sale con q; aquí se muestra una sola captura (como top -b -n 1).\n`)
    return 0
  },
})

register('free', {
  usage: 'free [-h|-m|-g|-w]',
  run(ctx) {
    const m = metrics(ctx.sys)
    const h = ctx.args.includes('-h')
    const mm = ctx.args.includes('-m')
    const g = ctx.args.includes('-g')
    const human = (kb: number) => {
      if (kb === 0) return '0B'
      const units = ['Ki', 'Mi', 'Gi', 'Ti']
      let v = kb
      let u = 0
      while (v >= 1024 && u < units.length - 1) {
        v /= 1024
        u++
      }
      return `${v < 10 ? v.toFixed(1) : Math.round(v)}${units[u]}`
    }
    const row = (kb: number) => (h ? human(Math.round(kb)) : mm ? String(Math.round(kb / 1024)) : g ? String(Math.round(kb / 1048576)) : String(Math.round(kb)))
    const mem = [MEM_TOTAL_KB, m.memUsedKb, m.memFreeKb, 9620, m.cacheKb, m.availKb]
    ctx.out(`${''.padEnd(8)}${['total', 'used', 'free', 'shared', 'buff/cache', 'available'].map((c) => c.padStart(12)).join('')}\n`)
    ctx.out(`${'Mem:'.padEnd(8)}${mem.map((v) => row(v).padStart(12)).join('')}\n`)
    ctx.out(`${'Swap:'.padEnd(8)}${[m.swapTotalKb, m.swapUsedKb, m.swapTotalKb - m.swapUsedKb].map((v) => row(v).padStart(12)).join('')}\n`)
    return 0
  },
})

register('vmstat', {
  usage: 'vmstat [-S M] [INTERVALO [CANTIDAD]]',
  run(ctx) {
    const nums = ctx.args.filter((x) => /^\d+$/.test(x)).map(Number)
    const count = nums.length >= 2 ? Math.min(nums[1], 20) : nums.length === 1 ? 5 : 1
    const megas = ctx.args.includes('-S') && ctx.args.includes('M')
    const m = metrics(ctx.sys)
    const u = (kb: number) => String(Math.round(megas ? kb / 1024 : kb))
    ctx.out('procs -----------memory---------- ---swap-- -----io---- -system-- -------cpu-------\n r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st gu\n')
    for (let i = 0; i < count; i++) {
      const jt = (v: number, amt: number) => Math.max(0, v + (i ? jitter(i * 7 + v, amt) : 0))
      const si = m.swapUsedKb > 0 && m.memFreeKb < 200 * 1024 ? Math.round(jt(180, 60)) : 0
      const cols = [
        String(Math.round(m.running)).padStart(2),
        String(m.blocked).padStart(2),
        u(m.swapUsedKb).padStart(6),
        u(jt(m.memFreeKb, 4000)).padStart(6),
        u(4268).padStart(6),
        u(m.cacheKb - 4268).padStart(6),
        String(si).padStart(4),
        String(si ? Math.round(si * 1.3) : 0).padStart(4),
        String(Math.round(jt(m.readKbs, m.readKbs * 0.1))).padStart(5),
        String(Math.round(jt(m.writeKbs, m.writeKbs * 0.1))).padStart(5),
        String(Math.round(jt(180 + m.us * 12, 20))).padStart(4),
        String(Math.round(jt(320 + m.us * 20, 30))).padStart(4),
        String(Math.round(m.us + m.ni)).padStart(2),
        String(Math.round(m.sy)).padStart(2),
        String(Math.round(m.id)).padStart(2),
        String(Math.round(m.wa)).padStart(2),
        String(Math.round(m.st)).padStart(2),
        ' 0',
      ]
      ctx.out(cols.join(' ') + '\n')
    }
    return 0
  },
})

register('iostat', {
  usage: 'iostat [-x] [-z] [INTERVALO [CANTIDAD]]',
  run(ctx) {
    if (!ctx.sys.installed.has('sysstat')) {
      ctx.err(`bash: iostat: command not found\n[simulador] Viene en el paquete sysstat: sudo ${ctx.sys.distro === 'rocky' ? 'dnf' : 'apt'} install sysstat\n`)
      return 127
    }
    const m = metrics(ctx.sys)
    const ext = ctx.args.some((x) => /^-\w*x/.test(x))
    const d = new Date()
    ctx.out(`Linux ${ctx.sys.distro === 'rocky' ? '6.12.0-55.el10.x86_64' : '6.8.0-58-generic'} (${ctx.sys.hostname}) \t${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} \t_x86_64_\t(${NCPU} CPU)\n\n`)
    ctx.out(`avg-cpu:  %user   %nice %system %iowait  %steal   %idle\n          ${[m.us, m.ni, m.sy, m.wa, m.st, m.id].map((v) => v.toFixed(2).padStart(6)).join('  ')}\n\n`)
    const devs = [{ name: 'sda', share: 1 }, { name: 'dm-0', share: 0.97 }]
    if (ext) {
      ctx.out('Device            r/s     rkB/s   rrqm/s  %rrqm r_await rareq-sz     w/s     wkB/s   wrqm/s  %wrqm w_await wareq-sz     d/s     dkB/s   drqm/s  %drqm d_await dareq-sz     f/s f_await  aqu-sz  %util\n')
      for (const dv of devs) {
        const r = m.readKbs * dv.share
        const w = m.writeKbs * dv.share
        const rs = r / 32
        const ws = w / 24
        const wait = 0.4 + m.util / 6
        ctx.out(`${dv.name.padEnd(12)} ${rs.toFixed(2).padStart(8)} ${r.toFixed(2).padStart(9)} ${'0.00'.padStart(8)} ${'0.00'.padStart(6)} ${wait.toFixed(2).padStart(7)} ${'32.00'.padStart(8)} ${ws.toFixed(2).padStart(7)} ${w.toFixed(2).padStart(9)} ${'1.20'.padStart(8)} ${'4.76'.padStart(6)} ${(wait * 1.6).toFixed(2).padStart(7)} ${'24.00'.padStart(8)} ${'0.00'.padStart(7)} ${'0.00'.padStart(9)} ${'0.00'.padStart(8)} ${'0.00'.padStart(6)} ${'0.00'.padStart(7)} ${'0.00'.padStart(8)} ${'0.00'.padStart(7)} ${'0.00'.padStart(7)} ${(m.util / 30).toFixed(2).padStart(7)} ${(m.util * dv.share).toFixed(2).padStart(6)}\n`)
      }
    } else {
      ctx.out('Device             tps    kB_read/s    kB_wrtn/s    kB_dscd/s    kB_read    kB_wrtn    kB_dscd\n')
      for (const dv of devs) {
        const r = m.readKbs * dv.share
        const w = m.writeKbs * dv.share
        ctx.out(`${dv.name.padEnd(12)} ${(r / 32 + w / 24).toFixed(2).padStart(9)} ${r.toFixed(2).padStart(12)} ${w.toFixed(2).padStart(12)} ${'0.00'.padStart(12)} ${String(Math.round(r * 3600)).padStart(10)} ${String(Math.round(w * 3600)).padStart(10)} ${'0'.padStart(10)}\n`)
      }
    }
    ctx.out('\n')
    return 0
  },
})

register('mpstat', {
  usage: 'mpstat [-P ALL] [INTERVALO [CANTIDAD]]',
  run(ctx) {
    if (!ctx.sys.installed.has('sysstat')) {
      ctx.err(`bash: mpstat: command not found\n`)
      return 127
    }
    const m = metrics(ctx.sys)
    const all = ctx.args.includes('ALL')
    const t = new Date().toTimeString().slice(0, 8)
    ctx.out(`Linux (${ctx.sys.hostname})\n\n${t}     CPU    %usr   %nice    %sys %iowait    %irq   %soft  %steal  %guest  %gnice   %idle\n`)
    const row = (cpu: string, v: [number, number, number, number, number]) => {
      const [us, ni, sy, wa, stl] = v
      const id = Math.max(0, 100 - us - ni - sy - wa - stl)
      ctx.out(`${t}     ${cpu.padStart(3)} ${[us, ni, sy, wa, 0, 0.1, stl, 0, 0, id].map((x) => x.toFixed(2).padStart(7)).join(' ')}\n`)
    }
    row('all', [m.us, m.ni, m.sy, m.wa, m.st])
    if (all) {
      // Un proceso de un solo hilo al 100 % ocupa una CPU entera; el resto del trabajo va a las otras.
      const hogs = Math.min(NCPU, ctx.sys.procs.filter((p) => p.cpu > 80 && !p.stat.startsWith('T') && !p.stat.startsWith('Z')).length)
      const restUs = Math.max(0, (m.us + m.ni) * NCPU - hogs * 99.4)
      const others = NCPU - hogs
      for (let i = 0; i < NCPU; i++) {
        if (i < hogs) row(String(i), m.ni > m.us ? [0, 99.4, 0.5, 0, 0] : [99.4, 0, 0.5, 0, 0])
        else {
          const us = others ? restUs / others : 0
          const sy = Math.min(100 - us, (m.sy * NCPU - hogs * 0.5) / Math.max(1, others))
          const wa = Math.min(100 - us - sy - m.st, (m.wa * NCPU) / Math.max(1, others))
          row(String(i), [us, 0, sy, Math.max(0, wa), m.st])
        }
      }
    }
    return 0
  },
})

register('sar', {
  usage: 'sar [-u | -r | -q | -b] [INTERVALO [CANTIDAD]]',
  summary: '  -u CPU · -r memoria · -q carga · -b disco. Sin intervalo: el historial de hoy, cada 10 minutos.',
  run(ctx) {
    if (!ctx.sys.installed.has('sysstat')) {
      ctx.err(`bash: sar: command not found\n[simulador] Viene en el paquete sysstat; para que guarde historial, además: sudo systemctl enable --now sysstat\n`)
      return 127
    }
    const kind = ctx.args.includes('-r') ? 'r' : ctx.args.includes('-q') ? 'q' : ctx.args.includes('-b') ? 'b' : 'u'
    const now = Date.now()
    const cur = metrics(ctx.sys)
    const base = metrics(ctx.sys, true)
    const incident = ctx.sys.perf.incidentMinutes
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const samples: { t: number; m: typeof cur }[] = []
    for (let t = start.getTime() + 600_000; t <= now; t += 600_000) {
      const after = incident === undefined ? true : t >= now - incident * 60_000
      samples.push({ t, m: after ? cur : base })
    }
    const time = (t: number) => {
      const d = new Date(t)
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:01`
    }
    const d = new Date()
    ctx.out(`Linux ${ctx.sys.distro === 'rocky' ? '6.12.0-55.el10.x86_64' : '6.8.0-58-generic'} (${ctx.sys.hostname}) \t${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} \t_x86_64_\t(${NCPU} CPU)\n\n`)
    const j = (v: number, i: number, amt: number) => Math.max(0, v + jitter(i, amt))
    const avg = (f: (m: typeof cur) => number) => samples.reduce((s, x) => s + f(x.m), 0) / Math.max(1, samples.length)
    if (kind === 'u') {
      ctx.out('00:00:01        CPU     %user     %nice   %system   %iowait    %steal     %idle\n')
      samples.forEach((s, i) => {
        const us = j(s.m.us, i, Math.min(2, s.m.us))
        const wa = j(s.m.wa, i + 99, Math.min(1.5, s.m.wa))
        ctx.out(`${time(s.t)}        all ${[us, s.m.ni, s.m.sy, wa, s.m.st, Math.max(0, 100 - us - s.m.ni - s.m.sy - wa - s.m.st)].map((v) => v.toFixed(2).padStart(9)).join(' ')}\n`)
      })
      ctx.out(`Average:        all ${[avg((m) => m.us), avg((m) => m.ni), avg((m) => m.sy), avg((m) => m.wa), avg((m) => m.st), avg((m) => m.id)].map((v) => v.toFixed(2).padStart(9)).join(' ')}\n`)
    } else if (kind === 'r') {
      ctx.out('00:00:01    kbmemfree   kbavail kbmemused  %memused kbbuffers  kbcached  kbcommit   %commit\n')
      samples.forEach((s, i) => {
        const used = j(s.m.memUsedKb, i, 3000)
        ctx.out(`${time(s.t)} ${[s.m.memFreeKb, s.m.availKb, used].map((v) => String(Math.round(v)).padStart(9)).join(' ')} ${((used / MEM_TOTAL_KB) * 100).toFixed(2).padStart(9)} ${'4268'.padStart(9)} ${String(Math.round(s.m.cacheKb)).padStart(9)} ${String(Math.round(used * 1.4)).padStart(9)} ${((used * 1.4 * 100) / (MEM_TOTAL_KB + s.m.swapTotalKb)).toFixed(2).padStart(9)}\n`)
      })
    } else if (kind === 'q') {
      ctx.out('00:00:01      runq-sz  plist-sz   ldavg-1   ldavg-5  ldavg-15   blocked\n')
      samples.forEach((s, i) => ctx.out(`${time(s.t)} ${String(Math.round(s.m.running)).padStart(9)} ${'187'.padStart(9)} ${[j(s.m.load[0], i, 0.1), s.m.load[1], s.m.load[2]].map((v) => v.toFixed(2).padStart(9)).join(' ')} ${String(s.m.blocked).padStart(9)}\n`))
    } else {
      ctx.out('00:00:01          tps      rtps      wtps      dtps   bread/s   bwrtn/s   bdscd/s\n')
      samples.forEach((s, i) => {
        const r = j(s.m.readKbs, i, s.m.readKbs * 0.1)
        const w = j(s.m.writeKbs, i + 5, s.m.writeKbs * 0.1)
        ctx.out(`${time(s.t)} ${[(r / 32 + w / 24), r / 32, w / 24, 0, r * 2, w * 2, 0].map((v) => v.toFixed(2).padStart(9)).join(' ')}\n`)
      })
    }
    return 0
  },
})

register('iotop', {
  usage: 'iotop [-o] [-b -n 1]',
  path: '/usr/sbin',
  run(ctx) {
    if (ctx.sh.user !== 'root') {
      ctx.err('Error: Netlink error: Operation not permitted (1)\n\nThe Linux kernel interfaces that iotop relies on now require root privileges\nor the NET_ADMIN capability. This change occurred because a security issue\n(CVE-2011-2494) was found that allows leakage of sensitive data across user\nboundaries.\n')
      return 1
    }
    const m = metrics(ctx.sys)
    const kb = (v: number) => (v >= 1024 ? `${(v / 1024).toFixed(2)} M/s` : `${v.toFixed(2)} K/s`)
    ctx.out(`Total DISK READ:       ${kb(m.readKbs).padStart(12)} | Total DISK WRITE:       ${kb(m.writeKbs).padStart(12)}\nActual DISK READ:      ${kb(m.readKbs).padStart(12)} | Actual DISK WRITE:      ${kb(m.writeKbs).padStart(12)}\n    TID  PRIO  USER     DISK READ  DISK WRITE  SWAPIN     IO>    COMMAND\n`)
    const only = ctx.args.includes('-o')
    const list = [...ctx.sys.procs].sort((x, y) => (y.io ? y.io.r + y.io.w : 0) - (x.io ? x.io.r + x.io.w : 0)).filter((p) => !only || (p.io && p.io.r + p.io.w > 0))
    for (const p of list.slice(0, 12)) {
      const io = p.io ?? { r: 0, w: 0 }
      const pct = Math.min(99.99, ((io.r + io.w) / 1024) * 1.4 + (p.stat.startsWith('D') ? 40 : 0))
      ctx.out(`${String(p.pid).padStart(7)} be/4 ${p.user.padEnd(8).slice(0, 8)} ${kb(io.r).padStart(11)} ${kb(io.w).padStart(11)}  0.00 % ${pct.toFixed(2).padStart(6)} % ${p.cmd}\n`)
    }
    if (ctx.isTTY && !ctx.args.includes('-b')) ctx.err('[simulador] iotop se actualiza en vivo; aquí se muestra una sola captura.\n')
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// Prioridades y procesos que sobreviven al cierre de la sesión
// ---------------------------------------------------------------------------------------

register('nice', {
  usage: 'nice [-n AJUSTE] COMANDO [ARGUMENTOS]',
  async run(ctx) {
    const args = [...ctx.args]
    let adj = 10
    if (args[0] === '-n') {
      args.shift()
      adj = Number(args.shift())
    } else if (/^-\d+$/.test(args[0] ?? '')) adj = Number(args.shift()!.slice(1))
    if (!args.length) {
      ctx.out('0\n')
      return 0
    }
    if (adj < 0 && ctx.sh.user !== 'root') {
      ctx.err(`nice: cannot set niceness: Permission denied\n`)
      adj = 0
    }
    const before = new Set(ctx.sys.procs.map((p) => p.pid))
    const code = await ctx.sh.invoke(args, { stdin: ctx.stdin, out: ctx.out, err: ctx.err, isTTY: ctx.isTTY })
    for (const p of ctx.sys.procs) if (!before.has(p.pid)) p.nice = Math.max(-20, Math.min(19, adj))
    return code
  },
})

register('renice', {
  usage: 'renice [-n] PRIORIDAD -p PID...',
  run(ctx) {
    const args = ctx.args.filter((x) => x !== '-n')
    const prio = Number(args[0])
    const pids = args.slice(1).filter((x) => x !== '-p').map(Number)
    if (Number.isNaN(prio) || !pids.length) {
      ctx.err('renice: bad priority value\n')
      return 1
    }
    let code = 0
    for (const pid of pids) {
      const p = ctx.sys.procs.find((x) => x.pid === pid)
      if (!p) {
        ctx.err(`renice: failed to get priority for ${pid} (process ID): No such process\n`)
        code = 1
        continue
      }
      const old = p.nice ?? 0
      if (ctx.sh.user !== 'root' && (p.user !== ctx.sh.user || prio < old)) {
        ctx.err(`renice: failed to set priority for ${pid} (process ID): Permission denied\n`)
        code = 1
        continue
      }
      p.nice = Math.max(-20, Math.min(19, prio))
      ctx.out(`${pid} (process ID) old priority ${old}, new priority ${p.nice}\n`)
    }
    return code
  },
})

register('nohup', {
  usage: 'nohup COMANDO [ARGUMENTOS]',
  async run(ctx) {
    if (!ctx.args.length) {
      ctx.err('nohup: missing operand\n')
      return 125
    }
    ctx.err("nohup: ignoring input and appending output to 'nohup.out'\n")
    let buf = ''
    const code = await ctx.sh.invoke(ctx.args, { stdin: ctx.stdin, out: (t) => (buf += t), err: (t) => (buf += t), isTTY: false })
    try {
      ctx.sys.vfs.writeFile(ctx.sh.resolve('nohup.out'), buf, ctx.sh.cred, { append: true, mode: 0o600, umask: ctx.sh.umask })
    } catch {
      // sin permiso de escritura en la carpeta
    }
    return code
  },
})

register('pstree', {
  usage: 'pstree [-p] [-u] [PID]',
  run(ctx) {
    const showPid = ctx.args.some((x) => /^-\w*p/.test(x))
    const rootPid = Number(ctx.args.find((x) => /^\d+$/.test(x)) ?? 1)
    const procs = ctx.sys.procs
    const label = (p: Proc) => `${commOf(p)}${showPid ? `(${p.pid})` : ''}`
    const lines: string[] = []
    const walk = (p: Proc, prefix: string, last: boolean, depth: number) => {
      const kids = procs.filter((c) => c.ppid === p.pid && c.pid !== p.pid).sort((a, b) => commOf(a).localeCompare(commOf(b)))
      const me = label(p)
      if (depth === 0) lines.push(me)
      else lines.push(`${prefix}${last ? '└─' : '├─'}${me}`)
      kids.forEach((k, i) => walk(k, depth === 0 ? '' : prefix + (last ? '  ' : '│ '), i === kids.length - 1, depth + 1))
    }
    const root = procs.find((p) => p.pid === rootPid)
    if (!root) return 1
    walk(root, '', true, 0)
    ctx.out(lines.join('\n') + '\n')
    return 0
  },
})
