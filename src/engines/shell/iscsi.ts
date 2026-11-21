/**
 * iSCSI: el servidor (LIO, con targetcli) presenta discos o archivos como LUN por la red, y el
 * cliente (open-iscsi, con iscsiadm) los descubre, inicia sesión y los ve como discos locales
 * nuevos (aparecen en lsblk). Las ACL del servidor deciden qué iniciadores entran, y sin
 * saveconfig la configuración se pierde al reiniciar.
 */
import { register, type CommandContext } from './shell'
import { System } from './system'
import { ROOT_CRED } from './vfs'
import { GiB, MiB, type Disk } from './storage'
import { inbound, hostByIp, routeTo, sourceIp } from './hosts'
import { pveOf, pveHooks } from './proxmox'

interface Backstore {
  name: string
  kind: 'block' | 'fileio'
  dev: string
  size: number
}

interface Target {
  iqn: string
  luns: string[]
  acls: string[]
  portal: string
}

interface LioState {
  backstores: Backstore[]
  targets: Target[]
  saved: boolean
}

interface Session {
  target: string
  portal: string
  host: System
  disks: string[]
}

const LIO = new WeakMap<System, LioState>()
const NODES = new WeakMap<System, { target: string; portal: string; host: System }[]>()
const SESSIONS = new WeakMap<System, Session[]>()

function lio(sys: System): LioState {
  let s = LIO.get(sys)
  if (!s) LIO.set(sys, (s = { backstores: [], targets: [], saved: true }))
  return s
}

function hexOf(seed: string, n: number) {
  let h = 2166136261
  let out = ''
  for (let i = 0; out.length < n; i++) {
    h = Math.imul(h ^ (seed.charCodeAt(i % seed.length) + i), 16777619) >>> 0
    out += h.toString(16)
  }
  return out.slice(0, n)
}

/** El nombre de iniciador de este equipo (/etc/iscsi/initiatorname.iscsi). */
export function initiatorName(sys: System): string {
  const path = '/etc/iscsi/initiatorname.iscsi'
  if (sys.vfs.exists(path, ROOT_CRED)) {
    const m = /^InitiatorName=(\S+)/m.exec(sys.vfs.readFile(path, ROOT_CRED))
    if (m) return m[1]
  }
  const prefix = pveOf(sys) ? 'iqn.1993-08.org.debian:01' : sys.distro === 'rocky' ? 'iqn.1994-05.com.redhat' : 'iqn.2004-10.com.ubuntu:01'
  return `${prefix}:${hexOf(sys.hostname, 12)}`
}

function ensureInitiatorFile(sys: System) {
  const path = '/etc/iscsi/initiatorname.iscsi'
  if (sys.vfs.exists(path, ROOT_CRED)) return
  sys.vfs.mkdirp('/etc/iscsi', ROOT_CRED)
  sys.vfs.writeFile(path, `## DO NOT EDIT OR REMOVE THIS FILE!\n## If you remove this file, the iSCSI daemon will not start.\nInitiatorName=${initiatorName(sys)}\n`, ROOT_CRED, { mode: 0o600 })
}

System.installHooks['open-iscsi'] = (sys) => ensureInitiatorFile(sys)
System.installHooks['iscsi-initiator-utils'] = (sys) => ensureInitiatorFile(sys)
System.initHooks.push((sys) => {
  if (sys.installed.has('open-iscsi') || sys.installed.has('iscsi-initiator-utils') || pveOf(sys)) ensureInitiatorFile(sys)
})

// Sin saveconfig, LIO arranca vacío después de un reinicio.
System.powerHooks.push((sys, on) => {
  const s = LIO.get(sys)
  if (on && s && !s.saved) {
    s.backstores = []
    s.targets = []
    s.saved = true
  }
  if (!on) for (const host of [sys, ...sys.lab]) {
    const ses = SESSIONS.get(host)
    if (ses) SESSIONS.set(host, ses.filter((x) => x.host !== sys))
  }
})

function targetConfPath(sys: System) {
  return sys.distro === 'rocky' ? '/etc/target/saveconfig.json' : '/etc/rtslib-fb-target/saveconfig.json'
}

function dots(label: string, right: string, indent: number) {
  const left = `${'  '.repeat(indent)}o- ${label} `
  return `${left}${'.'.repeat(Math.max(3, 79 - left.length - right.length - 1))} ${right}\n`
}

function lsTree(sys: System): string {
  const s = lio(sys)
  const human = (n: number) => `${(n / GiB).toFixed(1)}GiB`
  let out = dots('/', '[...]', 0)
  out += dots('backstores', '[...]', 1)
  const blocks = s.backstores.filter((b) => b.kind === 'block')
  const files = s.backstores.filter((b) => b.kind === 'fileio')
  out += dots('block', `[Storage Objects: ${blocks.length}]`, 2)
  for (const b of blocks) out += dots(b.name, `[${b.dev} (${human(b.size)}) write-thru ${s.targets.some((t) => t.luns.includes(b.name)) ? 'activated' : 'deactivated'}]`, 3)
  out += dots('fileio', `[Storage Objects: ${files.length}]`, 2)
  for (const b of files) out += dots(b.name, `[${b.dev} (${human(b.size)}) write-back ${s.targets.some((t) => t.luns.includes(b.name)) ? 'activated' : 'deactivated'}]`, 3)
  out += dots('iscsi', `[Targets: ${s.targets.length}]`, 1)
  for (const t of s.targets) {
    out += dots(t.iqn, '[TPGs: 1]', 2)
    out += dots('tpg1', '[no-gen-acls, no-auth]', 3)
    out += dots('acls', `[ACLs: ${t.acls.length}]`, 4)
    for (const a of t.acls) out += dots(a, `[Mapped LUNs: ${t.luns.length}]`, 5)
    out += dots('luns', `[LUNs: ${t.luns.length}]`, 4)
    t.luns.forEach((l, i) => {
      const b = s.backstores.find((x) => x.name === l)
      out += dots(`lun${i}`, `[${b?.kind}/${l} (${b?.dev}) (default_tg_pt_gp)]`, 5)
    })
    out += dots('portals', '[Portals: 1]', 4)
    out += dots(`${t.portal}:3260`, '[OK]', 5)
  }
  return out
}

function backstoreSize(sys: System, dev: string): number | undefined {
  return sys.storage.size(dev)
}

register('targetcli', {
  usage: 'targetcli [RUTA COMANDO [ARGUMENTOS]] | ls | saveconfig',
  summary: '  /backstores/block create name=lun0 dev=/dev/sdb\n  /backstores/fileio create name=lun1 file_or_dev=/srv/lun1.img size=50G\n  /iscsi create iqn.2026-11.lan.empresa:san01\n  /iscsi/IQN/tpg1/luns create /backstores/block/lun0\n  /iscsi/IQN/tpg1/acls create IQN-DEL-INICIADOR\n  ls   saveconfig',
  path: '/usr/bin',
  run(ctx) {
    const sys = ctx.sys
    if (ctx.sh.user !== 'root') {
      ctx.err('You must run targetcli as root.\n')
      return 1
    }
    const s = lio(sys)
    const args = [...ctx.args]
    if (!args.length) {
      ctx.out('targetcli shell version 2.1.58\nCopyright 2011-2013 by Datera, Inc and others.\nFor help on commands, type \'help\'.\n\n[simulador] El modo interactivo no está: usá targetcli con la ruta y el comando en la misma línea (por ejemplo, targetcli ls).\n')
      return 0
    }
    let path = '/'
    if (args[0].startsWith('/')) path = args.shift()!.replace(/\/+$/, '') || '/'
    const cmd = args.shift() ?? 'ls'
    const kv = new Map(args.filter((a) => a.includes('=')).map((a) => [a.split('=')[0], a.split('=').slice(1).join('=')]))
    const plain = args.filter((a) => !a.includes('='))
    const save = () => {
      sys.vfs.mkdirp(targetConfPath(sys).replace(/\/[^/]+$/, ''), ROOT_CRED)
      sys.vfs.writeFile(targetConfPath(sys), JSON.stringify({ storage_objects: s.backstores, targets: s.targets }, null, 2) + '\n', ROOT_CRED, { mode: 0o600 })
      s.saved = true
    }
    if (cmd === 'ls') {
      ctx.out(lsTree(sys))
      return 0
    }
    if (cmd === 'saveconfig') {
      save()
      ctx.out(`Configuration saved to ${targetConfPath(sys)}\n`)
      return 0
    }
    const parts = path.split('/').filter(Boolean)
    const fail = (m: string) => {
      ctx.err(m + '\n')
      return 1
    }
    // /backstores/block|fileio
    if (parts[0] === 'backstores' && (parts[1] === 'block' || parts[1] === 'fileio') && parts.length === 2) {
      if (cmd === 'create') {
        const name = kv.get('name') ?? plain[0]
        if (!name) return fail('Missing required parameter name')
        if (s.backstores.some((b) => b.name === name)) return fail(`Storage object ${parts[1]}/${name} exists`)
        if (parts[1] === 'block') {
          const dev = kv.get('dev') ?? plain[1]
          if (!dev) return fail('Missing required parameter dev')
          const size = backstoreSize(sys, dev)
          if (size === undefined) return fail(`Device path ${dev} does not exist`)
          if (sys.storage.holder(dev)) return fail(`Cannot configure StorageObject because device ${dev} is already in use`)
          s.backstores.push({ name, kind: 'block', dev, size })
          ctx.out(`Created block storage object ${name} using ${dev}.\n`)
        } else {
          const file = kv.get('file_or_dev') ?? plain[1]
          const sz = kv.get('size') ?? plain[2]
          if (!file) return fail('Missing required parameter file_or_dev')
          const m = sz ? /^(\d+(?:\.\d+)?)([KMGT]?)$/i.exec(sz) : undefined
          if (!sys.vfs.exists(file, ROOT_CRED) && !m) return fail('Attempting to create file for new fileio backstore, need a size')
          const size = m ? Number(m[1]) * ({ '': 1, K: 1024, M: MiB, G: GiB, T: 1024 * GiB } as Record<string, number>)[m[2].toUpperCase()] : sys.vfs.stat(file, ROOT_CRED).size ?? 0
          sys.vfs.mkdirp(file.replace(/\/[^/]+$/, '') || '/', ROOT_CRED)
          if (!sys.vfs.exists(file, ROOT_CRED)) {
            sys.vfs.writeFile(file, '', ROOT_CRED, { mode: 0o600 })
            sys.vfs.stat(file, ROOT_CRED).size = 0
          }
          s.backstores.push({ name, kind: 'fileio', dev: file, size })
          ctx.out(`Created fileio ${name} with size ${Math.round(size)}\n`)
        }
        s.saved = false
        return 0
      }
      if (cmd === 'delete') {
        const name = plain[0] ?? kv.get('name')
        if (!s.backstores.some((b) => b.name === name)) return fail(`No storage object named ${name}.`)
        s.backstores = s.backstores.filter((b) => b.name !== name)
        for (const t of s.targets) t.luns = t.luns.filter((l) => l !== name)
        ctx.out(`Deleted storage object ${name}.\n`)
        s.saved = false
        return 0
      }
    }
    if (parts[0] === 'iscsi' && parts.length === 1) {
      if (cmd === 'create') {
        const iqn = plain[0] ?? `iqn.2003-01.org.linux-iscsi.${sys.hostname}.x8664:sn.${hexOf(sys.hostname + s.targets.length, 12)}`
        if (!/^iqn\.\d{4}-\d{2}\.[a-z0-9.-]+(:[^\s]+)?$/.test(iqn)) return fail(`WWN not valid as: iqn, naa, eui`)
        if (s.targets.some((t) => t.iqn === iqn)) return fail(`This Target already exists in configFS`)
        s.targets.push({ iqn, luns: [], acls: [], portal: '0.0.0.0' })
        s.saved = false
        const svc = sys.services.get(sys.distro === 'rocky' ? 'target' : 'rtslib-fb-targetctl')
        if (svc && !svc.ports.includes(3260)) svc.ports.push(3260)
        ctx.out(`Created target ${iqn}.\nCreated TPG 1.\nGlobal pref auto_add_default_portal=true\nCreated default portal listening on all IPs (0.0.0.0), port 3260.\n`)
        return 0
      }
      if (cmd === 'delete') {
        s.targets = s.targets.filter((t) => t.iqn !== plain[0])
        s.saved = false
        ctx.out(`Deleted Target ${plain[0]}.\n`)
        return 0
      }
    }
    const t = parts[0] === 'iscsi' ? s.targets.find((x) => x.iqn === parts[1]) : undefined
    if (parts[0] === 'iscsi' && parts.length >= 2 && !t) return fail(`No such path ${path}`)
    if (t && parts[2] === 'tpg1' && parts[3] === 'luns') {
      if (cmd === 'create') {
        const ref = (plain[0] ?? kv.get('storage_object') ?? '').replace(/^\/backstores\/(block|fileio)\//, '')
        const b = s.backstores.find((x) => x.name === ref)
        if (!b) return fail(`Invalid storage object ${plain[0] ?? ''}.`)
        if (t.luns.includes(b.name)) return fail(`Storage object ${b.kind}/${b.name} already exported as LUN ${t.luns.indexOf(b.name)}`)
        t.luns.push(b.name)
        s.saved = false
        const n = t.luns.length - 1
        ctx.out(`Created LUN ${n}.\n${t.acls.map((a) => `Created LUN ${n}->${n} mapping in node ACL ${a}\n`).join('')}`)
        return 0
      }
    }
    if (t && parts[2] === 'tpg1' && parts[3] === 'acls') {
      if (cmd === 'create') {
        const wwn = plain[0] ?? kv.get('wwn')
        if (!wwn || !/^iqn\./.test(wwn)) return fail('WWN not valid as: iqn, naa, eui')
        if (t.acls.includes(wwn)) return fail(`This NodeACL already exists in configFS`)
        t.acls.push(wwn)
        s.saved = false
        ctx.out(`Created Node ACL for ${wwn}\n${t.luns.map((_l, i) => `Created mapped LUN ${i}.\n`).join('')}`)
        return 0
      }
      if (cmd === 'delete') {
        t.acls = t.acls.filter((a) => a !== plain[0])
        s.saved = false
        ctx.out(`Deleted Node ACL ${plain[0]}.\n`)
        return 0
      }
    }
    if (t && parts[2] === 'tpg1' && parts[3] === 'portals') {
      if (cmd === 'create') {
        t.portal = plain[0] ?? '0.0.0.0'
        s.saved = false
        ctx.out(`Using default IP port 3260\nCreated network portal ${t.portal}:3260.\n`)
        return 0
      }
      if (cmd === 'delete') {
        ctx.out(`Deleted network portal ${plain[0]}:3260\n`)
        return 0
      }
    }
    return fail(`Command not found ${cmd}${path !== '/' ? ` in ${path}` : ''}`)
  },
})

// ---------------------------------------------------------------------------------------
// Iniciador: iscsiadm
// ---------------------------------------------------------------------------------------

function nextDiskName(sys: System): { name: string; minor: number } {
  for (let c = 'b'.charCodeAt(0); c <= 'z'.charCodeAt(0); c++) {
    const name = `sd${String.fromCharCode(c)}`
    if (!sys.storage.disks.has(name)) return { name, minor: (c - 'a'.charCodeAt(0)) * 16 }
  }
  return { name: 'sdz', minor: 400 }
}

function reachTarget(ctx: CommandContext, ip: string): System | string {
  const host = hostByIp(ctx.sys, ip)
  if (!host || !routeTo(ctx.sys, ip)) return `cannot make connection to ${ip}: No route to host`
  const fw = inbound(host, 3260, 'tcp', sourceIp(ctx.sys, ip))
  if (fw === 'drop') return `cannot make connection to ${ip}: Connection timed out`
  if (fw === 'reject') return `cannot make connection to ${ip}: No route to host`
  if (!LIO.get(host)?.targets.length) return `cannot make connection to ${ip}: Connection refused`
  return host
}

function login(ctx: CommandContext, host: System, iqn: string, portal: string): string | undefined {
  const t = lio(host).targets.find((x) => x.iqn === iqn)
  if (!t) return `iscsiadm: Could not login to [iface: default, target: ${iqn}, portal: ${portal},3260].\niscsiadm: initiator reported error (19 - encountered non-retryable iSCSI login failure)\niscsiadm: Could not log into all portals`
  if (!t.acls.includes(initiatorName(ctx.sys)))
    return `iscsiadm: Could not login to [iface: default, target: ${iqn}, portal: ${portal},3260].\niscsiadm: initiator reported error (24 - iSCSI login failed due to authorization failure)\niscsiadm: Could not log into all portals`
  const sessions = SESSIONS.get(ctx.sys) ?? []
  SESSIONS.set(ctx.sys, sessions)
  if (sessions.some((x) => x.target === iqn)) return undefined
  const disks: string[] = []
  for (const l of t.luns) {
    const b = lio(host).backstores.find((x) => x.name === l)!
    const { name, minor } = nextDiskName(ctx.sys)
    const d: Disk = { name, size: b.size, model: l, ptid: '', parts: [], major: 8, minor, rota: true }
    ctx.sys.storage.disks.set(name, d)
    disks.push(name)
    ctx.sys.journal.push({ time: Date.now(), unit: 'kernel', priority: 5, message: `sd ${7 + sessions.length}:0:0:${t.luns.indexOf(l)}: [${name}] Attached SCSI disk`, ident: 'kernel' })
  }
  ctx.sys.storage.syncDevFiles()
  sessions.push({ target: iqn, portal, host, disks })
  return undefined
}

register('iscsiadm', {
  usage: 'iscsiadm -m discovery -t sendtargets -p IP | -m node -T IQN -p IP --login|--logout | -m session',
  summary: '  -m discovery -t sendtargets -p IP   descubre los destinos de un servidor\n  -m node -T IQN -p IP --login       inicia sesión (aparecen los discos)\n  -m node -T IQN -p IP --logout      cierra la sesión\n  -m session                          sesiones abiertas',
  path: '/usr/sbin',
  run(ctx) {
    const sys = ctx.sys
    const a = ctx.args
    const get = (...names: string[]) => {
      for (const n of names) {
        const i = a.indexOf(n)
        if (i >= 0) return a[i + 1]
      }
      return undefined
    }
    const mode = get('-m', '--mode')
    if (ctx.sh.user !== 'root' && mode !== 'session') {
      ctx.err('iscsiadm: Could not open /run/lock/iscsi: Permission denied\n')
      return 1
    }
    if (mode === 'discovery' || mode === 'discoverydb') {
      const p = get('-p', '--portal')
      if (!p) {
        ctx.err('iscsiadm: portal must be specified in discovery mode\n')
        return 7
      }
      const ip = sys.resolveHost(p.split(':')[0]) ?? p
      const host = reachTarget(ctx, ip)
      if (typeof host === 'string') {
        ctx.err(`iscsiadm: ${host}\niscsiadm: cannot make connection to ${ip}: No route to host\niscsiadm: connection login retries (reopen_max) 5 exceeded\niscsiadm: Could not perform SendTargets discovery: iSCSI PDU timed out\n`)
        return 4
      }
      const nodes = NODES.get(sys) ?? []
      NODES.set(sys, nodes)
      for (const t of lio(host).targets) {
        if (!nodes.some((n) => n.target === t.iqn)) nodes.push({ target: t.iqn, portal: ip, host })
        ctx.out(`${ip}:3260,1 ${t.iqn}\n`)
      }
      return 0
    }
    if (mode === 'node') {
      const target = get('-T', '--targetname')
      const nodes = NODES.get(sys) ?? []
      const list = nodes.filter((n) => !target || n.target === target)
      if (a.includes('--login') || a.includes('-l')) {
        if (!list.length) {
          ctx.err('iscsiadm: No records found\n')
          return 21
        }
        let code = 0
        for (const n of list) {
          ctx.out(`Logging in to [iface: default, target: ${n.target}, portal: ${n.portal},3260]\n`)
          const e = login(ctx, n.host, n.target, n.portal)
          if (e) {
            ctx.err(e + '\n')
            code = 24
          } else ctx.out(`Login to [iface: default, target: ${n.target}, portal: ${n.portal},3260] successful.\n`)
        }
        return code
      }
      if (a.includes('--logout') || a.includes('-u')) {
        const sessions = SESSIONS.get(sys) ?? []
        const mine = sessions.filter((x) => !target || x.target === target)
        if (!mine.length) {
          ctx.err('iscsiadm: No matching sessions found\n')
          return 21
        }
        for (const x of mine) {
          for (const d of x.disks) {
            const busy = sys.storage.holder(`/dev/${d}`) ?? sys.storage.disks.get(d)?.parts.map((p) => sys.storage.holder(sys.storage.partPath(d, p.num))).find(Boolean)
            if (busy) ctx.err(`[simulador] /dev/${d} está en uso (${busy}): cerrar la sesión así puede perder datos.\n`)
            sys.storage.disks.delete(d)
          }
          ctx.out(`Logging out of session [sid: 1, target: ${x.target}, portal: ${x.portal},3260]\nLogout of [sid: 1, target: ${x.target}, portal: ${x.portal},3260] successful.\n`)
        }
        SESSIONS.set(sys, sessions.filter((x) => !mine.includes(x)))
        sys.storage.syncDevFiles()
        return 0
      }
      if (a.includes('-o') && get('-o') === 'update') return 0
      for (const n of list) ctx.out(`${n.portal}:3260,1 ${n.target}\n`)
      return list.length ? 0 : 21
    }
    if (mode === 'session') {
      const sessions = SESSIONS.get(sys) ?? []
      if (!sessions.length) {
        ctx.err('iscsiadm: No active sessions.\n')
        return 21
      }
      sessions.forEach((x, i) => ctx.out(`tcp: [${i + 1}] ${x.portal}:3260,1 ${x.target} (non-flash)\n`))
      return 0
    }
    ctx.err('iscsiadm: You must specify a mode, one of discovery, node, session...\n')
    return 7
  },
})

export function verifyIscsi(sys: System, check: object): { ok: boolean; label: string } | undefined {
  if ('iscsi_destino' in check) {
    const c = check as { iscsi_destino: string; luns?: number; permite?: string; guardado?: boolean }
    const t = LIO.get(sys)?.targets.find((x) => x.iqn === c.iscsi_destino)
    let ok = !!t
    const parts: string[] = []
    if (ok && c.luns !== undefined) {
      ok = t!.luns.length === c.luns
      parts.push(`con ${c.luns} LUN`)
    }
    if (ok && c.permite) {
      ok = t!.acls.includes(c.permite)
      parts.push(`que deja entrar a ${c.permite}`)
    }
    if (ok && c.guardado) {
      ok = !!LIO.get(sys)?.saved && sys.vfs.exists(targetConfPath(sys), ROOT_CRED)
      parts.push('con la configuración guardada')
    }
    return { ok, label: `existe el destino iSCSI ${c.iscsi_destino}${parts.length ? ' ' + parts.join(', ') : ''}` }
  }
  if ('iscsi_sesion' in check) {
    const c = check as { iscsi_sesion: string; discos?: number }
    const s = SESSIONS.get(sys)?.find((x) => x.target === c.iscsi_sesion)
    let ok = !!s
    if (ok && c.discos !== undefined) ok = s!.disks.length === c.discos
    return { ok, label: `hay una sesión iSCSI con ${c.iscsi_sesion}${c.discos !== undefined ? ` y ${c.discos} disco(s)` : ''}` }
  }
  return undefined
}

// pvesm add iscsi: el nodo descubre el destino e inicia sesión.
pveHooks.iscsiLogin = (ctx, portal, target) => {
  const ip = ctx.sys.resolveHost(portal.split(':')[0]) ?? portal
  const host = reachTarget(ctx, ip)
  if (typeof host === 'string') return host
  const nodes = NODES.get(ctx.sys) ?? []
  NODES.set(ctx.sys, nodes)
  if (!nodes.some((n) => n.target === target)) nodes.push({ target, portal: ip, host })
  const e = login(ctx, host, target, ip)
  return e ? e.split('\n')[1]?.replace(/^iscsiadm: /, '') : undefined
}
