import { parseArgs } from '../args'
import { BUILTINS, register, type CommandContext } from '../shell'
import { ROOT_CRED } from '../vfs'

function needRoot(ctx: CommandContext, message: string): boolean {
  if (ctx.sh.user === 'root') return false
  ctx.err(message)
  return true
}

function logAuth(ctx: CommandContext, message: string) {
  ctx.sys.log('sudo', message, 5)
  const file = ctx.sys.distro === 'rocky' ? '/var/log/secure' : '/var/log/auth.log'
  const d = new Date()
  const stamp = `${d.toLocaleString('en', { month: 'short' })} ${String(d.getDate()).padStart(2)} ${d.toTimeString().slice(0, 8)}`
  try {
    ctx.sys.vfs.writeFile(file, `${stamp} ${ctx.sys.hostname} sudo[${ctx.sys.allocPid()}]: ${message}\n`, ROOT_CRED, { append: true })
  } catch {
    // ignorar
  }
}

register('whoami', {
  usage: 'whoami',
  run(ctx) {
    ctx.out(ctx.sh.user + '\n')
    return 0
  },
})

register('id', {
  usage: 'id [OPTION]... [USER]',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { u: ['u'], g: ['g'], G: ['G'], n: ['n'] } })
    const name = a.rest[0] ?? ctx.sh.user
    const u = ctx.sys.users.get(name)
    if (!u) {
      ctx.err(`id: '${name}': no such user\n`)
      return 1
    }
    const groups = ctx.sys.groupsOf(name).map((g) => ctx.sys.groups.get(g)!)
    if (a.flags.has('u')) ctx.out((a.flags.has('n') ? u.name : u.uid) + '\n')
    else if (a.flags.has('g')) ctx.out((a.flags.has('n') ? ctx.sys.groupName(u.gid) : u.gid) + '\n')
    else if (a.flags.has('G')) ctx.out(groups.map((g) => (a.flags.has('n') ? g.name : g.gid)).join(' ') + '\n')
    else ctx.out(`uid=${u.uid}(${u.name}) gid=${u.gid}(${ctx.sys.groupName(u.gid)}) groups=${groups.map((g) => `${g.gid}(${g.name})`).join(',')}\n`)
    return 0
  },
})

register('groups', {
  usage: 'groups [USER]...',
  run(ctx) {
    const names = ctx.args.length ? ctx.args : [ctx.sh.user]
    for (const n of names) {
      if (!ctx.sys.users.has(n)) {
        ctx.err(`groups: '${n}': no such user\n`)
        return 1
      }
      ctx.out((ctx.args.length ? `${n} : ` : '') + ctx.sys.groupsOf(n).join(' ') + '\n')
    }
    return 0
  },
})

register('useradd', {
  usage: 'useradd [options] LOGIN',
  summary: '  -m  -M  -d HOME  -s SHELL  -u UID  -g GROUP  -G GROUPS  -c COMMENT  -e EXPIRE  -r',
  path: '/usr/sbin',
  run(ctx) {
    if (needRoot(ctx, 'useradd: Permission denied.\nuseradd: cannot lock /etc/passwd; try again later.\n')) return 1
    const a = parseArgs(ctx.args, {
      flags: { m: ['m', 'create-home'], M: ['M', 'no-create-home'], r: ['r', 'system'], N: ['N'], U: ['U'] },
      values: { d: ['d', 'home-dir'], s: ['s', 'shell'], u: ['u', 'uid'], g: ['g', 'gid'], G: ['G', 'groups'], c: ['c', 'comment'], e: ['e', 'expiredate'] },
    })
    const name = a.rest[0]
    if (!name) {
      ctx.err('Usage: useradd [options] LOGIN\n')
      return 2
    }
    if (!/^[a-z_][a-z0-9_-]*\$?$/.test(name)) {
      ctx.err(`useradd: invalid user name '${name}': use --badname to ignore\n`)
      return 3
    }
    if (ctx.sys.users.has(name)) {
      ctx.err(`useradd: user '${name}' already exists\n`)
      return 9
    }
    let gid: number | undefined
    if (a.values.has('g')) {
      const g = ctx.sys.groups.get(a.values.get('g')!) ?? [...ctx.sys.groups.values()].find((x) => String(x.gid) === a.values.get('g'))
      if (!g) {
        ctx.err(`useradd: group '${a.values.get('g')}' does not exist\n`)
        return 6
      }
      gid = g.gid
    }
    const extra = a.values.get('G')?.split(',').filter(Boolean) ?? []
    for (const g of extra) {
      if (!ctx.sys.groups.has(g)) {
        ctx.err(`useradd: group '${g}' does not exist\n`)
        return 6
      }
    }
    const uid = a.values.has('u') ? Number(a.values.get('u')) : undefined
    if (uid !== undefined && ctx.sys.userByUid(uid)) {
      ctx.err(`useradd: UID ${uid} is not unique\n`)
      return 4
    }
    // En la familia Red Hat useradd crea el home por defecto (CREATE_HOME yes); en Ubuntu, solo con -m.
    const createHome = a.flags.has('m') || (ctx.sys.distro === 'rocky' && !a.flags.has('M') && !a.flags.has('r'))
    const user = ctx.sys.addUser(name, {
      uid,
      gid,
      home: a.values.get('d'),
      shell: a.values.get('s') ?? (ctx.sys.distro === 'ubuntu' ? '/bin/sh' : '/bin/bash'),
      gecos: a.values.get('c'),
      createHome,
    })
    if (a.values.has('e')) user.expire = a.values.get('e')!
    for (const g of extra) ctx.sys.addMember(g, name)
    ctx.sys.syncAccountFiles()
    ctx.sys.log('useradd', `new user: name=${name}, UID=${user.uid}, GID=${user.gid}, home=${user.home}, shell=${user.shell}`, 6)
    return 0
  },
})

register('adduser', {
  usage: 'adduser [--disabled-password] USER  |  adduser USER GROUP',
  path: '/usr/sbin',
  run(ctx) {
    if (ctx.sys.distro !== 'ubuntu') {
      // En la familia Red Hat, adduser es un enlace a useradd.
      return ctx.sh.invoke(['useradd', ...ctx.args], { stdin: ctx.stdin, out: ctx.out, err: ctx.err, isTTY: ctx.isTTY }) as Promise<number>
    }
    if (needRoot(ctx, 'fatal: Only root may add a user or group to the system.\n')) return 1
    const rest = ctx.args.filter((x) => !x.startsWith('--'))
    if (rest.length === 2) {
      const [user, group] = rest
      if (!ctx.sys.users.has(user) || !ctx.sys.groups.has(group)) {
        ctx.err(`fatal: The user \`${user}' or group \`${group}' does not exist.\n`)
        return 1
      }
      ctx.out(`info: Adding user \`${user}' to group \`${group}' ...\n`)
      ctx.sys.addMember(group, user)
      ctx.sys.syncAccountFiles()
      return 0
    }
    const name = rest[0]
    if (!name) {
      ctx.err('fatal: Only one or two names allowed.\n')
      return 1
    }
    if (ctx.sys.users.has(name)) {
      ctx.err(`fatal: The user \`${name}' already exists.\n`)
      return 1
    }
    const user = ctx.sys.addUser(name, { shell: '/bin/bash', createHome: true })
    user.hasPassword = !ctx.args.includes('--disabled-password')
    user.locked = !user.hasPassword
    ctx.sys.syncAccountFiles()
    ctx.out(
      `info: Adding user \`${name}' ...\ninfo: Selecting UID/GID from range 1000 to 59999 ...\ninfo: Adding new group \`${name}' (${user.gid}) ...\ninfo: Adding new user \`${name}' (${user.uid}) with group \`${name} (${user.gid})' ...\ninfo: Creating home directory \`${user.home}' ...\ninfo: Copying files from \`/etc/skel' ...\n`,
    )
    if (user.hasPassword) ctx.out('[simulador] adduser pide la contraseña y los datos personales; aquí se dan por cargados.\n')
    return 0
  },
})

register('usermod', {
  usage: 'usermod [options] LOGIN',
  summary: '  -aG GROUPS  -G GROUPS  -g GROUP  -s SHELL  -d HOME [-m]  -l NEW_LOGIN  -L  -U  -c COMMENT  -e EXPIRE',
  path: '/usr/sbin',
  run(ctx) {
    if (needRoot(ctx, 'usermod: Permission denied.\nusermod: cannot lock /etc/passwd; try again later.\n')) return 1
    const a = parseArgs(ctx.args, {
      flags: { a: ['a', 'append'], L: ['L', 'lock'], U: ['U', 'unlock'], m: ['m', 'move-home'] },
      values: { G: ['G', 'groups'], g: ['g', 'gid'], s: ['s', 'shell'], d: ['d', 'home'], l: ['l', 'login'], c: ['c', 'comment'], e: ['e', 'expiredate'] },
    })
    const name = a.rest[0]
    const user = name ? ctx.sys.users.get(name) : undefined
    if (!user) {
      ctx.err(name ? `usermod: user '${name}' does not exist\n` : 'Usage: usermod [options] LOGIN\n')
      return 6
    }
    if (a.values.has('G')) {
      const groups = a.values.get('G')!.split(',').filter(Boolean)
      for (const g of groups) {
        if (!ctx.sys.groups.has(g)) {
          ctx.err(`usermod: group '${g}' does not exist\n`)
          return 6
        }
      }
      if (!a.flags.has('a')) {
        // Sin -a, -G reemplaza todos los grupos secundarios: un error clásico.
        for (const g of ctx.sys.groups.values()) g.members = g.members.filter((m) => m !== name)
      }
      for (const g of groups) ctx.sys.addMember(g, name)
    } else if (a.flags.has('a')) {
      ctx.err('usermod: -a flag is ONLY allowed with the -G flag\n')
      return 2
    }
    if (a.values.has('g')) {
      const g = ctx.sys.groups.get(a.values.get('g')!)
      if (!g) {
        ctx.err(`usermod: group '${a.values.get('g')}' does not exist\n`)
        return 6
      }
      user.gid = g.gid
    }
    if (a.values.has('s')) user.shell = a.values.get('s')!
    if (a.values.has('c')) user.gecos = a.values.get('c')!
    if (a.values.has('e')) user.expire = a.values.get('e')!
    if (a.flags.has('L')) user.locked = true
    if (a.flags.has('U')) {
      if (!user.hasPassword) {
        ctx.err("usermod: unlocking the user's password would result in a passwordless account.\n")
        return 1
      }
      user.locked = false
    }
    if (a.values.has('d')) {
      const newHome = a.values.get('d')!
      if (a.flags.has('m') && ctx.sys.vfs.exists(user.home)) ctx.sys.vfs.rename(user.home, newHome, ROOT_CRED)
      user.home = newHome
    }
    if (a.values.has('l')) {
      const newName = a.values.get('l')!
      ctx.sys.users.delete(name)
      user.name = newName
      ctx.sys.users.set(newName, user)
      for (const g of ctx.sys.groups.values()) g.members = g.members.map((m) => (m === name ? newName : m))
    }
    ctx.sys.syncAccountFiles()
    return 0
  },
})

register('userdel', {
  usage: 'userdel [options] LOGIN',
  summary: '  -r, --remove   remove home directory and mail spool',
  path: '/usr/sbin',
  run(ctx) {
    if (needRoot(ctx, 'userdel: Permission denied.\nuserdel: cannot lock /etc/passwd; try again later.\n')) return 1
    const a = parseArgs(ctx.args, { flags: { r: ['r', 'remove'], f: ['f', 'force'] } })
    const name = a.rest[0]
    const user = name ? ctx.sys.users.get(name) : undefined
    if (!user) {
      ctx.err(`userdel: user '${name}' does not exist\n`)
      return 6
    }
    if (name === ctx.sys.users.get(name)?.name && ctx.sys.procs.some((p) => p.user === name) && !a.flags.has('f')) {
      const p = ctx.sys.procs.find((x) => x.user === name)!
      ctx.err(`userdel: user ${name} is currently used by process ${p.pid}\n`)
      return 8
    }
    ctx.sys.users.delete(name)
    for (const g of ctx.sys.groups.values()) g.members = g.members.filter((m) => m !== name)
    const own = ctx.sys.groups.get(name)
    if (own && own.gid === user.gid && ![...ctx.sys.users.values()].some((u) => u.gid === own.gid)) ctx.sys.groups.delete(name)
    if (a.flags.has('r') && ctx.sys.vfs.exists(user.home)) ctx.sys.vfs.removeTree(user.home, ROOT_CRED)
    ctx.sys.syncAccountFiles()
    return 0
  },
})

register('groupadd', {
  usage: 'groupadd [options] GROUP',
  path: '/usr/sbin',
  run(ctx) {
    if (needRoot(ctx, 'groupadd: Permission denied.\ngroupadd: cannot lock /etc/group; try again later.\n')) return 1
    const a = parseArgs(ctx.args, { flags: { r: ['r', 'system'], f: ['f', 'force'] }, values: { g: ['g', 'gid'] } })
    const name = a.rest[0]
    if (!name) {
      ctx.err('Usage: groupadd [options] GROUP\n')
      return 2
    }
    if (ctx.sys.groups.has(name)) {
      if (a.flags.has('f')) return 0
      ctx.err(`groupadd: group '${name}' already exists\n`)
      return 9
    }
    const gid = a.values.has('g') ? Number(a.values.get('g')) : undefined
    if (gid !== undefined && ctx.sys.groupByGid(gid)) {
      ctx.err(`groupadd: GID '${gid}' already exists\n`)
      return 4
    }
    ctx.sys.addGroup(name, gid)
    ctx.sys.syncAccountFiles()
    return 0
  },
})

register('groupdel', {
  usage: 'groupdel GROUP',
  path: '/usr/sbin',
  run(ctx) {
    if (needRoot(ctx, 'groupdel: Permission denied.\n')) return 1
    const name = ctx.args[0]
    const g = name ? ctx.sys.groups.get(name) : undefined
    if (!g) {
      ctx.err(`groupdel: group '${name}' does not exist\n`)
      return 6
    }
    const primaryOf = [...ctx.sys.users.values()].find((u) => u.gid === g.gid)
    if (primaryOf) {
      ctx.err(`groupdel: cannot remove the primary group of user '${primaryOf.name}'\n`)
      return 8
    }
    ctx.sys.groups.delete(name)
    ctx.sys.syncAccountFiles()
    return 0
  },
})

register('gpasswd', {
  usage: 'gpasswd [option] GROUP',
  summary: '  -a USER  add USER to GROUP\n  -d USER  remove USER from GROUP\n  -M USER,...  set the list of members',
  run(ctx) {
    if (needRoot(ctx, 'gpasswd: Permission denied.\n')) return 1
    const a = parseArgs(ctx.args, { values: { a: ['a', 'add'], d: ['d', 'delete'], M: ['M', 'members'] } })
    const group = a.rest[0]
    const g = group ? ctx.sys.groups.get(group) : undefined
    if (!g) {
      ctx.err(`gpasswd: group '${group}' does not exist in /etc/group\n`)
      return 3
    }
    if (a.values.has('a')) {
      const u = a.values.get('a')!
      if (!ctx.sys.users.has(u)) {
        ctx.err(`gpasswd: user '${u}' does not exist\n`)
        return 3
      }
      ctx.sys.addMember(group, u)
      ctx.out(`Adding user ${u} to group ${group}\n`)
    } else if (a.values.has('d')) {
      const u = a.values.get('d')!
      if (!g.members.includes(u)) {
        ctx.err(`gpasswd: user '${u}' is not a member of '${group}'\n`)
        return 3
      }
      g.members = g.members.filter((m) => m !== u)
      ctx.out(`Removing user ${u} from group ${group}\n`)
    } else if (a.values.has('M')) {
      g.members = a.values.get('M')!.split(',').filter(Boolean)
    }
    ctx.sys.syncAccountFiles()
    return 0
  },
})

register('passwd', {
  usage: 'passwd [options] [LOGIN]',
  summary: '  -l  lock  -u  unlock  -S  status  -e  expire (force change at next login)  -d  delete password',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { l: ['l', 'lock'], u: ['u', 'unlock'], S: ['S', 'status'], e: ['e', 'expire'], d: ['d', 'delete'], stdin: ['stdin'] } })
    const name = a.rest[0] ?? ctx.sh.user
    if (name !== ctx.sh.user && ctx.sh.user !== 'root') {
      ctx.err('passwd: Only root can specify a user name.\n')
      return 1
    }
    const user = ctx.sys.users.get(name)
    if (!user) {
      ctx.err(`passwd: user '${name}' does not exist\n`)
      return 1
    }
    if (a.flags.has('S')) {
      const st = user.locked ? 'LK' : user.hasPassword ? 'PS' : 'NP'
      ctx.out(`${name} ${st} ${new Date(user.lastChange * 86_400_000).toISOString().slice(0, 10)} ${user.minDays} ${user.maxDays} ${user.warnDays} -1 (${st === 'LK' ? 'Password locked.' : st === 'PS' ? 'Password set, SHA512 crypt.' : 'Empty password.'})\n`)
      return 0
    }
    if ((a.flags.has('l') || a.flags.has('u') || a.flags.has('e') || a.flags.has('d')) && ctx.sh.user !== 'root') {
      ctx.err('passwd: Only root can do that.\n')
      return 1
    }
    if (a.flags.has('l')) {
      user.locked = true
      ctx.out(`Locking password for user ${name}.\npasswd: Success\n`)
    } else if (a.flags.has('u')) {
      user.locked = false
      ctx.out(`Unlocking password for user ${name}.\npasswd: Success\n`)
    } else if (a.flags.has('e')) {
      user.lastChange = 0
      ctx.out(`Expiring password for user ${name}.\npasswd: Success\n`)
    } else if (a.flags.has('d')) {
      user.hasPassword = false
      user.locked = false
      ctx.out(`Removing password for user ${name}.\npasswd: Success\n`)
    } else {
      user.hasPassword = true
      user.locked = false
      user.lastChange = Math.floor(Date.now() / 86_400_000)
      ctx.out(`Changing password for user ${name}.\nNew password: \nRetype new password: \npasswd: all authentication tokens updated successfully.\n`)
      ctx.err('[simulador] En un servidor real passwd pide escribir la contraseña dos veces (sin mostrarla en pantalla).\n')
    }
    ctx.sys.syncAccountFiles()
    return 0
  },
})

register('chage', {
  usage: 'chage [options] LOGIN',
  summary: '  -l  list  -M MAX_DAYS  -m MIN_DAYS  -W WARN_DAYS  -E EXPIRE_DATE  -d LAST_DAY',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { l: ['l', 'list'] }, values: { M: ['M', 'maxdays'], m: ['m', 'mindays'], W: ['W', 'warndays'], E: ['E', 'expiredate'], d: ['d', 'lastday'], I: ['I', 'inactive'] } })
    const name = a.rest[0]
    const user = name ? ctx.sys.users.get(name) : undefined
    if (!user) {
      ctx.err(name ? `chage: user '${name}' does not exist in /etc/passwd\n` : 'Usage: chage [options] LOGIN\n')
      return 1
    }
    if (a.flags.has('l')) {
      if (ctx.sh.user !== 'root' && ctx.sh.user !== name) {
        ctx.err('chage: Permission denied.\n')
        return 1
      }
      const fmt = (days: number) => new Date(days * 86_400_000).toLocaleDateString('en', { month: 'short', day: '2-digit', year: 'numeric' })
      ctx.out(
        [
          `Last password change\t\t\t\t\t: ${user.lastChange === 0 ? 'password must be changed' : fmt(user.lastChange)}`,
          `Password expires\t\t\t\t\t: ${user.maxDays >= 99999 ? 'never' : fmt(user.lastChange + user.maxDays)}`,
          `Password inactive\t\t\t\t\t: never`,
          `Account expires\t\t\t\t\t\t: ${user.expire ? new Date(user.expire).toLocaleDateString('en', { month: 'short', day: '2-digit', year: 'numeric' }) : 'never'}`,
          `Minimum number of days between password change\t\t: ${user.minDays}`,
          `Maximum number of days between password change\t\t: ${user.maxDays}`,
          `Number of days of warning before password expires\t: ${user.warnDays}`,
        ].join('\n') + '\n',
      )
      return 0
    }
    if (needRoot(ctx, 'chage: Permission denied.\n')) return 1
    if (a.values.has('M')) user.maxDays = Number(a.values.get('M'))
    if (a.values.has('m')) user.minDays = Number(a.values.get('m'))
    if (a.values.has('W')) user.warnDays = Number(a.values.get('W'))
    if (a.values.has('E')) user.expire = a.values.get('E') === '-1' ? '' : a.values.get('E')!
    if (a.values.has('d')) user.lastChange = Number(a.values.get('d'))
    ctx.sys.syncAccountFiles()
    return 0
  },
})

/** Reglas de sudo: se leen de /etc/sudoers y /etc/sudoers.d/*. */
export function sudoRules(ctx: CommandContext): string[] {
  const files = ['/etc/sudoers']
  try {
    for (const f of ctx.sys.vfs.readdir('/etc/sudoers.d', ROOT_CRED)) if (!f.includes('.') && !f.endsWith('~')) files.push(`/etc/sudoers.d/${f}`)
  } catch {
    // sin sudoers.d
  }
  const rules: string[] = []
  for (const f of files) {
    try {
      for (const line of ctx.sys.vfs.readFile(f, ROOT_CRED).split('\n')) {
        const l = line.trim()
        if (!l || l.startsWith('#') || l.startsWith('@') || l.startsWith('Defaults') || /_Alias\s/.test(l)) continue
        rules.push(l)
      }
    } catch {
      // archivo ilegible
    }
  }
  return rules
}

/** Verifica la sintaxis de un archivo sudoers. Devuelve null si está bien o el número de línea con error. */
export function checkSudoers(text: string): number | null {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim()
    if (!l || /^#(?!include)/.test(l) || /^[#@]include(dir)?\s+\S+/.test(l) || l.startsWith('Defaults')) continue
    if (/^(User|Runas|Host|Cmnd)_Alias\s+[A-Z][A-Z0-9_]*\s*=\s*.+$/.test(l)) continue
    const rule = /^(%?[\w.$-]+|ALL|[A-Z][A-Z0-9_]*)(\s*,\s*(%?[\w.$-]+))*\s+(ALL|[\w.-]+)\s*=\s*(\([^)]*\)\s*)?((NO)?PASSWD:\s*)?(ALL|\/\S+(\s+[^,]*)?|[A-Z][A-Z0-9_]*)(\s*,\s*(ALL|\/\S+(\s+[^,]*)?|[A-Z][A-Z0-9_]*))*$/
    if (!rule.test(l)) return i + 1
  }
  return null
}

function sudoAllowed(ctx: CommandContext, user: string, command: string[]): 'ok' | 'noentry' | 'denied' {
  if (user === 'root') return 'ok'
  const groups = ctx.sys.groupsOf(user)
  let hasEntry = false
  for (const rule of sudoRules(ctx)) {
    const m = /^(\S+)\s+\S+\s*=\s*(\([^)]*\)\s*)?((NO)?PASSWD:\s*)?(.+)$/.exec(rule)
    if (!m) continue
    const who = m[1].split(',')
    const applies = who.some((w) => w === user || w === 'ALL' || (w.startsWith('%') && groups.includes(w.slice(1))))
    if (!applies) continue
    hasEntry = true
    const cmds = m[5].split(',').map((c) => c.trim())
    if (cmds.includes('ALL')) return 'ok'
    const def = command[0]
    const full = def.startsWith('/') ? def : `${defPath(def)}/${def}`
    const invoked = [full, ...command.slice(1)].join(' ')
    if (cmds.some((c) => (c.includes(' ') ? invoked === c : invoked === c || invoked.startsWith(c + ' ')))) return 'ok'
  }
  return hasEntry ? 'denied' : 'noentry'
}

const SBIN = new Set(['useradd', 'usermod', 'userdel', 'groupadd', 'groupdel', 'visudo', 'adduser', 'ip', 'ss', 'nft', 'iptables', 'fdisk', 'mkfs', 'lvcreate', 'reboot', 'shutdown'])
function defPath(cmd: string) {
  return SBIN.has(cmd) ? '/usr/sbin' : '/usr/bin'
}

register('sudo', {
  usage: 'sudo [-u user] [-i | -s] [command [arg ...]]',
  summary: '  -i  login shell as root\n  -s  shell as root\n  -u USER  run as USER\n  -l  list allowed commands',
  async run(ctx) {
    const args = [...ctx.args]
    let target = 'root'
    let mode: 'cmd' | 'login' | 'shell' | 'list' = 'cmd'
    while (args.length && args[0].startsWith('-')) {
      const o = args.shift()!
      if (o === '-u') target = args.shift() ?? 'root'
      else if (o === '-i') mode = 'login'
      else if (o === '-s') mode = 'shell'
      else if (o === '-l') mode = 'list'
      else if (o === '--') break
    }
    const user = ctx.sh.user
    if (mode === 'list') {
      if (sudoAllowed(ctx, user, ['true']) === 'noentry' && user !== 'root') {
        ctx.err(`Sorry, user ${user} may not run sudo on ${ctx.sys.hostname}.\n`)
        return 1
      }
      const groups = ctx.sys.groupsOf(user)
      ctx.out(`User ${user} may run the following commands on ${ctx.sys.hostname}:\n`)
      for (const r of sudoRules(ctx)) {
        const who = r.split(/\s+/)[0].split(',')
        if (who.some((w) => w === user || w === 'ALL' || (w.startsWith('%') && groups.includes(w.slice(1))))) {
          ctx.out(`    ${r.replace(/^\S+\s+\S+\s*=\s*/, '')}\n`)
        }
      }
      return 0
    }
    if (!ctx.sys.users.has(target)) {
      ctx.err(`sudo: unknown user ${target}\nsudo: error initializing audit plugin sudoers_audit\n`)
      return 1
    }
    const shellLike = mode !== 'cmd' || (args[0] === 'su' && (args.length === 1 || args[1] === '-')) || args[0] === 'bash' || args[0] === '-i'
    const command = shellLike ? ['/bin/bash'] : args
    if (!command.length) {
      ctx.err('usage: sudo -h | -K | -k | -V\nusage: sudo [-u user] [-i | -s] [command [arg ...]]\n')
      return 1
    }
    const verdict = sudoAllowed(ctx, user, command)
    if (verdict !== 'ok') {
      if (verdict === 'noentry') {
        ctx.err(`${user} is not in the sudoers file.\n`)
        logAuth(ctx, `${user} : user NOT in sudoers ; TTY=pts/0 ; PWD=${ctx.sh.cwd} ; USER=${target} ; COMMAND=${command.join(' ')}`)
      } else {
        ctx.err(`Sorry, user ${user} is not allowed to execute '${command[0].startsWith('/') ? '' : defPath(command[0]) + '/'}${command.join(' ')}' as ${target} on ${ctx.sys.hostname}.\n`)
        logAuth(ctx, `${user} : command not allowed ; TTY=pts/0 ; PWD=${ctx.sh.cwd} ; USER=${target} ; COMMAND=${command.join(' ')}`)
      }
      return 1
    }
    logAuth(ctx, `${user} : TTY=pts/0 ; PWD=${ctx.sh.cwd} ; USER=${target} ; COMMAND=${command[0].startsWith('/') ? '' : defPath(command[0]) + '/'}${command.join(' ')}`)
    if (shellLike) {
      ctx.sh.pushUser(target, mode === 'login' || (args[0] === 'su' && args[1] === '-'))
      return 0
    }
    return ctx.sh.asUser(target, () => ctx.sh.invoke(command, { stdin: ctx.stdin, out: ctx.out, err: ctx.err, isTTY: ctx.isTTY }))
  },
})

register('su', {
  usage: 'su [options] [-] [USER [argument...]]',
  async run(ctx) {
    const args = [...ctx.args]
    let login = false
    let cmd: string | undefined
    while (args.length && args[0].startsWith('-')) {
      const o = args.shift()!
      if (o === '-' || o === '-l' || o === '--login') login = true
      else if (o === '-c') cmd = args.shift()
    }
    const target = args[0] ?? 'root'
    if (!ctx.sys.users.has(target)) {
      ctx.err(`su: user ${target} does not exist or the user entry does not contain all the required fields\n`)
      return 1
    }
    if (ctx.sh.user !== 'root') {
      ctx.out('Password: \n')
      ctx.err(`[simulador] su pide la contraseña de ${target}. En este simulador se usa sudo: sudo -i (root) o sudo su - ${target}.\n`)
      return 1
    }
    if (cmd) {
      return ctx.sh.asUser(target, async () => {
        const res = await ctx.sh.captureCommand(cmd!)
        ctx.out(res)
        return ctx.sh.lastExit
      })
    }
    ctx.sh.pushUser(target, login)
    return 0
  },
})

register('visudo', {
  usage: 'visudo [-c] [-f sudoers]',
  path: '/usr/sbin',
  run(ctx) {
    if (needRoot(ctx, 'visudo: /etc/sudoers: Permission denied\n')) return 1
    const a = parseArgs(ctx.args, { flags: { c: ['c', 'check'] }, values: { f: ['f', 'file'] } })
    const file = a.values.get('f') ?? '/etc/sudoers'
    if (a.flags.has('c')) {
      const files = a.values.has('f') ? [file] : ['/etc/sudoers', ...ctx.sys.vfs.readdir('/etc/sudoers.d', ROOT_CRED).map((f) => `/etc/sudoers.d/${f}`)]
      let code = 0
      for (const f of files) {
        try {
          const bad = checkSudoers(ctx.sys.vfs.readFile(ctx.sh.resolve(f), ROOT_CRED))
          if (bad) {
            ctx.err(`${f}:${bad}:1: syntax error\n`)
            code = 1
          } else ctx.out(`${f}: parsed OK\n`)
        } catch {
          ctx.err(`visudo: unable to open ${f}: No such file or directory\n`)
          code = 1
        }
      }
      return code
    }
    const abs = ctx.sh.resolve(file)
    const content = ctx.sys.vfs.exists(abs) ? ctx.sys.vfs.readFile(abs, ROOT_CRED) : ''
    ctx.sh.pendingEditor = { path: abs, content, editor: 'visudo' }
    return 0
  },
})

register('getent', {
  usage: 'getent database [key ...]',
  run(ctx) {
    const [db, key] = ctx.args
    const file = db === 'passwd' ? '/etc/passwd' : db === 'group' ? '/etc/group' : db === 'hosts' ? '/etc/hosts' : null
    if (!file) {
      ctx.err(`Unknown database: ${db}\n`)
      return 1
    }
    const ls = ctx.sys.vfs.readFile(file, ROOT_CRED).split('\n').filter(Boolean)
    const sel = key ? ls.filter((l) => (db === 'hosts' ? l.split(/\s+/).includes(key) : l.split(':')[0] === key)) : ls
    if (!sel.length) return 2
    ctx.out(sel.join('\n') + '\n')
    return 0
  },
})

register(['who', 'w'], {
  usage: 'who',
  run(ctx) {
    const login = new Date(Date.now() - 25 * 60_000)
    const t = `${login.toISOString().slice(0, 10)} ${login.toTimeString().slice(0, 5)}`
    if (ctx.name === 'w') {
      ctx.out(` ${new Date().toTimeString().slice(0, 8)} up 3 days,  4:02,  1 user,  load average: 0.08, 0.12, 0.09\nUSER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU WHAT\n${ctx.sh.user.padEnd(8)} pts/0    192.168.1.50     ${login.toTimeString().slice(0, 5)}    0.00s  0.04s  0.00s w\n`)
    } else ctx.out(`${ctx.sh.user.padEnd(8)} pts/0        ${t} (192.168.1.50)\n`)
    return 0
  },
})

// "test" también existe como comando externo en /usr/bin.
register('test', { usage: 'test EXPRESSION', run: (ctx) => BUILTINS.test(ctx.sh, ctx.args, { stdin: ctx.stdin, out: ctx.out, err: ctx.err, isTTY: ctx.isTTY }) })
