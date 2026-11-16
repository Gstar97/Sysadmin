/**
 * NFS: las exportaciones del servidor (/etc/exports, exportfs), showmount y el montaje en el
 * cliente. Lo montado se lee y se escribe de verdad en el sistema de archivos del servidor, con
 * los números de usuario del cliente y las reglas de root_squash y all_squash.
 */
import { NETWORK_MOUNTS } from './commands/storage'
import { UNIT_HOOKS } from './commands/systemd'
import { SERVICE_CHECKS } from './commands/sysinfo'
import { inSubnet } from './hosts'
import { reach } from './http'
import { register, type CommandContext } from './shell'
import { System } from './system'
import { normalizePath, ROOT_CRED, type Cred } from './vfs'
import { parseExports, type NfsExport, type NfsOpts, type ExportsParse } from '../config/exports'

export { parseExports, type NfsExport, type NfsOpts, type ExportsParse }

// ---------------------------------------------------------------------------------------
// /etc/exports
// ---------------------------------------------------------------------------------------

/** Todas las exportaciones configuradas en el servidor (/etc/exports y /etc/exports.d/*.exports). */
export function readExports(sys: System): ExportsParse {
  const all: ExportsParse = { exports: [], errors: [], warnings: [] }
  const files = ['/etc/exports']
  if (sys.vfs.exists('/etc/exports.d')) for (const f of sys.vfs.readdir('/etc/exports.d', ROOT_CRED)) if (f.endsWith('.exports')) files.push(`/etc/exports.d/${f}`)
  for (const f of files) {
    if (!sys.vfs.exists(f)) continue
    const r = parseExports(sys.vfs.readFile(f, ROOT_CRED), f)
    all.exports.push(...r.exports)
    all.errors.push(...r.errors)
    all.warnings.push(...r.warnings)
  }
  return all
}

/** Opciones como las muestra exportfs -v. */
export function optString(o: NfsOpts): string {
  return [
    o.sync ? 'sync' : 'async',
    o.wdelay ? 'wdelay' : 'no_wdelay',
    o.hide ? 'hide' : 'nohide',
    ...(o.crossmnt ? ['crossmnt'] : []),
    o.subtreeCheck ? 'subtree_check' : 'no_subtree_check',
    ...(o.fsid ? [`fsid=${o.fsid}`] : []),
    ...(o.anonuid !== undefined && o.anonuid !== 65534 ? [`anonuid=${o.anonuid}`] : []),
    ...(o.anongid !== undefined && o.anongid !== 65534 ? [`anongid=${o.anongid}`] : []),
    `sec=${o.sec}`,
    o.rw ? 'rw' : 'ro',
    o.secure ? 'secure' : 'insecure',
    o.rootSquash ? 'root_squash' : 'no_root_squash',
    o.allSquash ? 'all_squash' : 'no_all_squash',
  ].join(',')
}

// ---------------------------------------------------------------------------------------
// Estado del servidor: lo exportado de verdad (lo que aplicó exportfs)
// ---------------------------------------------------------------------------------------

const STATE = new WeakMap<System, { applied: NfsExport[] }>()

export function nfsState(sys: System) {
  let s = STATE.get(sys)
  if (!s) {
    s = { applied: [] }
    STATE.set(sys, s)
  }
  return s
}

/** exportfs -r: vuelve a leer la configuración. Devuelve los mensajes. */
export function reexport(sys: System): string[] {
  const r = readExports(sys)
  const msgs = [...r.errors.map((e) => e.message), ...r.warnings]
  const ok: NfsExport[] = []
  for (const e of r.exports) {
    if (!sys.vfs.exists(e.path)) {
      msgs.push(`exportfs: Failed to stat ${e.path}: No such file or directory`)
      continue
    }
    ok.push(e)
  }
  nfsState(sys).applied = r.errors.length ? nfsState(sys).applied : ok
  return msgs
}

function serverActive(sys: System): boolean {
  return !!sys.services.get('nfs-server')?.active
}

/** ¿El cliente (por IP y nombre) entra en esta especificación de /etc/exports? */
function clientMatches(server: System, spec: string, ip: string, client?: System): boolean {
  if (spec === '*' || spec === '<world>') return true
  if (/^\d+\.\d+\.\d+\.\d+\/\d+\.\d+\.\d+\.\d+$/.test(spec)) {
    const [net, mask] = spec.split('/')
    const bits = mask.split('.').reduce((n, o) => n + (Number(o) >>> 0).toString(2).replace(/0/g, '').length, 0)
    return inSubnet(ip, `${net}/${bits}`)
  }
  if (/^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(spec)) return inSubnet(ip, spec.includes('/') ? spec : `${spec}/32`)
  if (spec.includes('*') || spec.includes('?')) {
    if (!client) return false
    const re = new RegExp('^' + spec.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
    return re.test(client.hostname)
  }
  return server.resolveHost(spec) === ip
}

/** La exportación que le corresponde a un cliente para una ruta (la más específica). */
export function exportFor(server: System, path: string, ip: string, client?: System): NfsExport | undefined {
  const abs = normalizePath(path)
  return nfsState(server)
    .applied.filter((e) => abs === e.path || abs.startsWith(e.path === '/' ? '/' : e.path + '/'))
    .sort((a, b) => b.path.length - a.path.length)
    .find((e) => clientMatches(server, e.client, ip, client))
}

/** Las credenciales con que el servidor atiende a un usuario del cliente. */
export function squash(o: NfsOpts): (c: Cred) => Cred {
  const anon: Cred = { uid: o.anonuid ?? 65534, gid: o.anongid ?? 65534, groups: [o.anongid ?? 65534] }
  return (c) => (o.allSquash || (c.uid === 0 && o.rootSquash) ? anon : c)
}

SERVICE_CHECKS['nfs-server'] = (ctx) => {
  for (const m of reexport(ctx.sys)) ctx.sys.log('nfs-server.service', m, 4)
  return undefined
}

// ---------------------------------------------------------------------------------------
// Comandos del servidor
// ---------------------------------------------------------------------------------------

register('exportfs', {
  usage: 'exportfs [-v] [-r] [-a] [-u cliente:/ruta] [-s]',
  summary: '  -r   vuelve a leer /etc/exports y aplica los cambios\n  -a   exporta todo (con -r: todo lo de la configuración)\n  -v   muestra las opciones\n  -s   muestra lo exportado con el formato de /etc/exports\n  -u   deja de exportar',
  path: '/usr/sbin',
  run(ctx) {
    const flags = new Set(ctx.args.filter((a) => /^-[a-z]+$/.test(a)).flatMap((a) => [...a.slice(1)]))
    if (ctx.sh.user !== 'root') {
      if (flags.has('r') || flags.has('a') || flags.has('u')) {
        ctx.err('exportfs: could not open /var/lib/nfs/.etab.lock for locking: errno 13 (Permission denied)\n')
        return 1
      }
    }
    const sys = ctx.sys
    if (flags.has('u')) {
      const spec = ctx.args.find((a) => !a.startsWith('-')) ?? ''
      const [client, path] = spec.split(/:(?=\/)/)
      const st = nfsState(sys)
      const before = st.applied.length
      st.applied = st.applied.filter((e) => !(e.path === normalizePath(path ?? '') && e.client === client))
      if (st.applied.length === before) {
        ctx.err(`exportfs: Could not find '${client}:${path}' to unexport.\n`)
        return 1
      }
      return 0
    }
    if (flags.has('r') || flags.has('a')) {
      const msgs = reexport(sys)
      for (const m of msgs) ctx.err(m + '\n')
      if (flags.has('v')) for (const e of nfsState(sys).applied) ctx.out(`exporting ${e.client}:${e.path}\n`)
      return msgs.some((m) => /unknown keyword|bad path|syntax error/.test(m)) ? 1 : 0
    }
    const list = nfsState(sys).applied
    if (flags.has('s')) {
      const byPath = new Map<string, NfsExport[]>()
      for (const e of list) byPath.set(e.path, [...(byPath.get(e.path) ?? []), e])
      for (const [p, es] of byPath) ctx.out(`${p}  ${es.map((e) => `${e.client}(${optString(e.opts)})`).join(' ')}\n`)
      return 0
    }
    for (const e of list) {
      const client = e.client === '*' ? '<world>' : e.client
      const head = e.path.length > 14 ? `${e.path}\n\t\t` : `${e.path.padEnd(15)}\t`
      ctx.out(`${head}${client}${flags.has('v') ? `(${optString(e.opts)})` : ''}\n`)
    }
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// Cliente: showmount y mount.nfs
// ---------------------------------------------------------------------------------------

function clientTools(sys: System): boolean {
  return sys.installed.has(sys.distro === 'rocky' ? 'nfs-utils' : 'nfs-common')
}

register('showmount', {
  usage: 'showmount -e [servidor]',
  path: '/usr/sbin',
  run(ctx) {
    const host = ctx.args.find((a) => !a.startsWith('-')) ?? 'localhost'
    const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : host === 'localhost' ? '127.0.0.1' : ctx.sys.resolveHost(host)
    if (!ip) {
      ctx.err(`clnt_create: RPC: Unknown host\n`)
      return 1
    }
    // showmount habla con rpcbind (111) y con mountd (20048), no con el 2049.
    const r = reach(ctx.sys, ip, 111)
    if ('error' in r) {
      ctx.err(r.error === 'noroute' ? 'clnt_create: RPC: Port mapper failure - Unable to receive: errno 113 (No route to host)\n' : 'clnt_create: RPC: Timed out\n')
      return 1
    }
    if (!r.target.services.get('rpcbind')?.active) {
      ctx.err('clnt_create: RPC: Port mapper failure - Unable to receive: errno 111 (Connection refused)\n')
      return 1
    }
    const mountd = reach(ctx.sys, ip, 20048)
    if ('error' in mountd) {
      ctx.err(mountd.error === 'noroute' ? 'clnt_create: RPC: Unable to receive; errno = No route to host\n' : 'clnt_create: RPC: Timed out\n')
      return 1
    }
    if (!serverActive(r.target)) {
      ctx.err('clnt_create: RPC: Program not registered\n')
      return 1
    }
    const byPath = new Map<string, string[]>()
    for (const e of nfsState(r.target).applied) byPath.set(e.path, [...(byPath.get(e.path) ?? []), e.client])
    ctx.out(`Export list for ${host}:\n`)
    const w = Math.max(0, ...[...byPath.keys()].map((p) => p.length))
    for (const [p, cs] of byPath) ctx.out(`${p.padEnd(w)} ${cs.join(',')}\n`)
    return 0
  },
})

/** Montar server:/ruta (mount -t nfs, mount -t nfs4 o por fstab). */
export function nfsMount(ctx: CommandContext, spec: string, target: string, type: string | undefined, options: string, auto = false): string | undefined | null {
  return mountNfsOn(ctx.sys, spec, target, type, options, auto)
}

export function isNfsSpec(spec: string, type: string | undefined): boolean {
  const m = /^([^/\s:]+):(\/.*)$/.test(spec)
  return type === 'nfs' || type === 'nfs4' || (!type || type === 'auto' ? m : false)
}

/** auto: lo pide el automontador (el punto de montaje ya tiene su entrada autofs). */
export function mountNfsOn(sys: System, spec: string, target: string, type: string | undefined, options: string, auto = false): string | undefined | null {
  const m = /^([^/\s:]+):(\/.*)$/.exec(spec)
  if (!isNfsSpec(spec, type)) return null
  const abs = normalizePath(target)
  if (!clientTools(sys)) return 'bad option; for several filesystems (e.g. nfs, cifs) you might need a /sbin/mount.<type> helper program.'
  if (!m) return `mount.nfs: remote share not in 'host:dir' format`
  const [, host, rpath] = m
  if (!sys.vfs.exists(abs)) return `mount.nfs: mount point ${abs} does not exist`
  if (sys.storage.mounts.some((x) => x.target === abs && (!auto || x.fstype !== 'autofs'))) return `mount.nfs: ${spec} is already mounted on ${abs}`
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : sys.resolveHost(host)
  if (!ip) return `mount.nfs: Failed to resolve server ${host}: Name or service not known`
  const r = reach(sys, ip, 2049)
  if ('error' in r) return r.error === 'noroute' ? 'mount.nfs: No route to host' : 'mount.nfs: Connection timed out'
  const server = r.target
  if (!serverActive(server)) return 'mount.nfs: Connection refused'
  const exp = exportFor(server, rpath, r.clientIp, sys)
  if (!exp) return `mount.nfs: access denied by server while mounting ${spec}`
  if (!server.vfs.exists(rpath)) return `mount.nfs: mounting ${spec} failed, reason given by server: No such file or directory`
  const opts = options.split(',').filter((o) => o && o !== 'defaults')
  const ro = opts.includes('ro') || !exp.opts.rw
  const vers = opts.find((o) => /^(nfs)?vers=/.test(o))?.split('=')[1] ?? (type === 'nfs4' ? '4.2' : '4.2')
  const v3 = vers === '3'
  const shown = opts.filter((o) => !['ro', 'rw', 'nofail', 'noauto', 'auto', '_netdev', 'soft', 'hard'].includes(o) && !o.startsWith('x-systemd') && !/^(nfs)?vers=/.test(o))
  const final = [
    opts.includes('ro') ? 'ro' : 'rw',
    'relatime',
    ...shown.filter((o) => o !== 'relatime'),
    `vers=${vers}`,
    'rsize=262144',
    'wsize=262144',
    'namlen=255',
    opts.includes('soft') ? 'soft' : 'hard',
    'proto=tcp',
    'timeo=600',
    'retrans=2',
    'sec=sys',
    ...(v3 ? ['mountaddr=' + ip, 'mountvers=3', 'mountport=20048', 'mountproto=udp', 'local_lock=none'] : [`clientaddr=${r.clientIp}`, 'local_lock=none']),
    `addr=${ip}`,
  ].join(',')
  const exportMount = server.storage.mountOfPath(rpath)
  const sig = exportMount?.dev ? server.storage.sigs.get(exportMount.dev) : undefined
  sys.storage.mounts.push({
    source: spec,
    target: abs,
    fstype: v3 ? 'nfs' : 'nfs4',
    options: final,
    remote: { size: () => sig?.size ?? 0, used: () => (exportMount?.dev ? server.storage.used(exportMount.dev) : 0) },
  })
  sys.vfs.addRemote({ target: abs, vfs: server.vfs, path: rpath, cred: squash(exp.opts), readonly: ro })
  return undefined
}

NETWORK_MOUNTS.push(nfsMount)

// ---------------------------------------------------------------------------------------
// Montaje bajo demanda: x-systemd.automount en fstab y autofs
// ---------------------------------------------------------------------------------------

const NET_TYPES = new Set(['nfs', 'nfs4', 'cifs'])

/** Deja el punto de montaje esperando: se monta de verdad la primera vez que alguien entra. */
function placeholder(sys: System, source: string, target: string, options: string, mountIt: () => string | undefined | null) {
  const abs = normalizePath(target)
  if (sys.storage.mounts.some((x) => x.target === abs)) return
  sys.storage.mounts.push({ source, target: abs, fstype: 'autofs', options })
  sys.vfs.addRemote({
    target: abs,
    vfs: sys.vfs,
    path: abs,
    cred: (c) => c,
    readonly: false,
    activate: () => {
      const err = mountIt()
      if (err) sys.log('autofs.service', `mount(nfs): ${err}`, 3)
    },
  })
}

/** Unidad .automount o .mount de una carpeta, como la nombra systemd (/mnt/datos → mnt-datos). */
export function unitPath(target: string): string {
  return normalizePath(target).slice(1).replace(/-/g, '\\x2d').replace(/\//g, '-') || '-'
}

function fstabFromText(text: string) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/))
    .map((f) => ({ spec: f[0], target: f[1] ?? '', type: f[2] ?? '', options: f[3] ?? 'defaults' }))
}

let pipeIno = 21562

/** Lo que hace systemd con una línea de red de fstab al arrancar remote-fs.target. */
function startNetEntry(sys: System, e: { spec: string; target: string; type: string; options: string }): string | undefined {
  const abs = normalizePath(e.target)
  if (sys.storage.mounts.some((x) => x.target === abs)) return undefined
  const opts = e.options.split(',').filter((o) => !o.startsWith('x-systemd') && o !== '_netdev').join(',') || 'defaults'
  if (/x-systemd\.automount/.test(e.options)) {
    if (!sys.vfs.exists(abs)) sys.vfs.mkdirp(abs, ROOT_CRED)
    const timeout = /x-systemd\.idle-timeout=(\d+)/.exec(e.options)?.[1] ?? '0'
    placeholder(sys, 'systemd-1', abs, `rw,relatime,fd=${50 + sys.storage.mounts.length},pgrp=1,timeout=${timeout},minproto=5,maxproto=5,direct,pipe_ino=${pipeIno++}`, () => {
      for (const h of NETWORK_MOUNTS) {
        const r = h({ sys } as CommandContext, e.spec, abs, e.type, opts, true)
        if (r !== null) return r
      }
      return null
    })
    return undefined
  }
  for (const h of NETWORK_MOUNTS) {
    const r = h({ sys } as CommandContext, e.spec, abs, e.type, opts)
    if (r !== null) return r ?? undefined
  }
  return undefined
}

UNIT_HOOKS.push((ctx, verb, unit) => {
  if (!['start', 'restart', 'reload-or-restart', 'try-restart'].includes(verb)) return undefined
  const sys = ctx.sys
  // systemd usa el fstab que leyó en el último daemon-reload.
  const entries = fstabFromText(sys.storage.fstabSeen).filter((e) => NET_TYPES.has(e.type) && !/\bnoauto\b/.test(e.options))
  let picked: typeof entries
  if (unit === 'remote-fs.target') picked = entries
  else {
    const m = /^(.+)\.(automount|mount)$/.exec(unit)
    if (!m) return undefined
    picked = entries.filter((e) => unitPath(e.target) === m[1])
    if (!picked.length) {
      ctx.err(`Failed to ${verb} ${unit}: Unit ${unit} not found.\n`)
      return 5
    }
    if (m[2] === 'mount') picked = picked.map((e) => ({ ...e, options: e.options.replace(/,?x-systemd\.automount/, '') }))
  }
  if (ctx.sh.user !== 'root') {
    ctx.err(`Failed to ${verb} ${unit}: Access denied\nSee system logs and 'systemctl status ${unit}' for details.\n`)
    return 1
  }
  let failed = false
  for (const e of picked) {
    const err = startNetEntry(sys, e)
    if (err) {
      failed = true
      sys.log(`${unitPath(e.target)}.mount`, err, 3)
      sys.log(`${unitPath(e.target)}.mount`, `Failed to mount ${e.target}.`, 3)
    }
  }
  if (failed) {
    ctx.err(unit === 'remote-fs.target' ? `A dependency job for remote-fs.target failed. See 'journalctl -xe' for details.\n` : `Job for ${unit} failed.\nSee "systemctl status ${unit}" and "journalctl -xeu ${unit}" for details.\n`)
    return 1
  }
  return 0
})

/** autofs: lee /etc/auto.master y deja cada clave de los mapas esperando a que alguien entre. */
SERVICE_CHECKS['autofs'] = (ctx) => {
  const sys = ctx.sys
  const read = (f: string) => (sys.vfs.exists(f) ? sys.vfs.readFile(f, ROOT_CRED) : '')
  // Al reiniciar se desmonta lo anterior.
  for (const m of [...sys.storage.mounts].filter((x) => x.fstype === 'autofs' && x.source.startsWith('/etc/'))) {
    for (const sub of [...sys.storage.mounts].filter((x) => x.target.startsWith(m.target + '/'))) sys.storage.unmount(sub)
    for (const b of [...sys.vfs.remotes].filter((x) => x.target.startsWith(m.target + '/'))) sys.vfs.removeRemote(b.target)
    sys.storage.unmount(m)
  }
  const master: string[] = read('/etc/auto.master').split('\n')
  for (const l of master.filter((x) => x.startsWith('+dir:'))) {
    const dir = l.slice(5).trim()
    if (sys.vfs.exists(dir)) for (const f of sys.vfs.readdir(dir, ROOT_CRED)) if (f.endsWith('.autofs')) master.push(...read(`${dir}/${f}`).split('\n'))
  }
  for (const raw of master) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line || line.startsWith('+')) continue
    const [mp, mapFile, ...mopts] = line.split(/\s+/)
    if (!mp?.startsWith('/') || !mapFile) continue
    const timeout = /--timeout[= ](\d+)/.exec(mopts.join(' '))?.[1] ?? '300'
    if (!sys.vfs.exists(mp)) sys.vfs.mkdirp(mp, ROOT_CRED)
    sys.storage.mounts.push({ source: mapFile, target: normalizePath(mp), fstype: 'autofs', options: `rw,relatime,fd=${12 + sys.storage.mounts.length},pgrp=${1200 + sys.storage.mounts.length},timeout=${timeout},minproto=5,maxproto=5,indirect,pipe_ino=${pipeIno++}` })
    for (const ml of read(mapFile).split('\n')) {
      const ent = ml.replace(/#.*$/, '').trim()
      if (!ent) continue
      const parts = ent.split(/\s+/)
      const key = parts[0]
      const opt = parts[1]?.startsWith('-') ? parts[1].slice(1) : ''
      const loc = parts[1]?.startsWith('-') ? parts[2] : parts[1]
      if (!loc || loc.startsWith(':')) continue
      const fstype = /fstype=(\w+)/.exec(opt)?.[1] ?? 'nfs'
      const target = normalizePath(`${mp}/${key}`)
      sys.vfs.addRemote({
        target,
        vfs: sys.vfs,
        path: target,
        cred: (c) => c,
        readonly: false,
        activate: () => {
          if (!sys.vfs.exists(target)) sys.vfs.mkdirp(target, ROOT_CRED)
          let err: string | undefined | null = null
          for (const h of NETWORK_MOUNTS) {
            err = h({ sys } as CommandContext, loc, target, fstype, opt.split(',').filter((o) => !o.startsWith('fstype=')).join(',') || 'defaults', true)
            if (err !== null) break
          }
          if (err) {
            sys.log('autofs.service', `mount(nfs): ${err}`, 3)
            sys.vfs.rmdir(target, ROOT_CRED)
          }
        },
      })
    }
  }
  return undefined
}

// Si el ejercicio arranca con el servidor NFS o autofs funcionando, ya exportan y esperan.
System.initHooks.push((sys) => {
  if (sys.services.get('nfs-server')?.active) reexport(sys)
  if (sys.services.get('autofs')?.active) SERVICE_CHECKS['autofs']({ sys } as CommandContext)
})

/** Verificaciones de los ejercicios sobre NFS. */
export function verifyNfs(sys: System, check: object): { ok: boolean; label: string } | undefined {
  if (!('exportado' in check)) return undefined
  const c = check as { exportado: string; cliente?: string; opciones_incluye?: string; existe?: boolean }
  const existe = c.existe ?? true
  const path = normalizePath(c.exportado)
  const list = serverActive(sys) ? nfsState(sys).applied.filter((e) => e.path === path && (!c.cliente || e.client === c.cliente)) : []
  const want = (c.opciones_incluye ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  const ok = list.some((e) => want.every((w) => optString(e.opts).split(',').includes(w))) === existe
  const label = `${path} ${existe ? '' : 'no '}exportado por NFS${c.cliente ? ` a ${c.cliente}` : ''}${want.length ? ` con ${want.join(',')}` : ''}`
  return { ok, label }
}
