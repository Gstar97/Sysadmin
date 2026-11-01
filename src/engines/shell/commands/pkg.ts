import { COMMANDS, register, type CommandContext } from '../shell'
import { EPEL_REPO, type System } from '../system'
import { ROOT_CRED } from '../vfs'

/** Versión instalada (o la del catálogo si nunca se actualizó). */
export function ver(sys: System, n: string): string {
  return sys.versions.get(n) ?? sys.catalog[n]?.version ?? '1.0'
}

const SBIN = new Set(['nginx', 'httpd', 'apache2', 'sshd', 'named', 'mariadbd', 'chronyd', 'crond', 'rsyslogd'])
const binDir = (c: string) => COMMANDS.get(c)?.path ?? (SBIN.has(c) ? '/usr/sbin' : '/usr/bin')

/** Paquete dueño de los comandos básicos del sistema (rpm -qf, dpkg -S): [Rocky, Ubuntu, versión]. */
const BASE_OWNERS: [string[], string, string, string][] = [
  [['ls', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'cat', 'touch', 'chmod', 'chown', 'chgrp', 'ln', 'head', 'tail', 'sort', 'uniq', 'wc', 'cut', 'tr', 'tee', 'stat', 'du', 'df', 'date', 'echo', 'printf', 'basename', 'dirname', 'realpath', 'id', 'whoami', 'pwd', 'env', 'nl', 'true', 'false', 'sleep', 'base64', 'od', 'test', 'nproc', 'uname', 'groups', 'who', 'readlink'], 'coreutils', 'coreutils', '9.5'],
  [['grep'], 'grep', 'grep', '3.11'],
  [['sed'], 'sed', 'sed', '4.9'],
  [['awk', 'gawk'], 'gawk', 'gawk', '5.3.0'],
  [['find', 'xargs'], 'findutils', 'findutils', '4.10.0'],
  [['less'], 'less', 'less', '661'],
  [['ps', 'top', 'free', 'kill', 'pgrep', 'pkill', 'uptime'], 'procps-ng', 'procps', '4.0.4'],
  [['systemctl', 'journalctl', 'hostnamectl', 'timedatectl', 'systemd-analyze', 'loginctl'], 'systemd', 'systemd', '257'],
  [['ip', 'ss'], 'iproute', 'iproute2', '6.11.0'],
  [['useradd', 'usermod', 'userdel', 'groupadd', 'groupdel', 'chage', 'gpasswd', 'newgrp'], 'shadow-utils', 'passwd', '4.15.0'],
  [['passwd'], 'passwd', 'passwd', '0.80'],
  [['su', 'lsblk', 'fdisk', 'mount', 'umount', 'rev', 'column', 'dmesg', 'lscpu'], 'util-linux', 'util-linux', '2.40.2'],
  [['bash', 'sh'], 'bash', 'bash', '5.2.26'],
  [['sudo', 'visudo'], 'sudo', 'sudo', '1.9.15'],
  [['logrotate'], 'logrotate', 'logrotate', '3.22.0'],
  [['getfacl', 'setfacl'], 'acl', 'acl', '2.3.2'],
  [['file'], 'file', 'file', '5.45'],
  [['man', 'whatis', 'apropos'], 'man-db', 'man-db', '2.12.1'],
]

function ownerOf(sys: System, path: string): { name: string; version: string } | undefined {
  const cmd = path.replace(/^.*\//, '')
  const hit = Object.entries(sys.catalog).find(([n, i]) => sys.installed.has(n) && (i.commands?.includes(cmd) || Object.keys(i.files ?? {}).includes(path)))
  if (hit) return { name: hit[0], version: ver(sys, hit[0]) }
  if (!/^\/(usr\/)?s?bin\//.test(path) || !sys.vfs.exists(path)) return undefined
  const base = BASE_OWNERS.find(([cmds]) => cmds.includes(cmd))
  if (!base) return undefined
  return { name: sys.distro === 'rocky' ? base[1] : base[2], version: base[3] }
}

/** Repositorio de donde viene cada paquete en Rocky. */
function repoOf(n: string): string {
  if (EPEL_ONLY.has(n)) return 'epel'
  if (n === 'epel-release') return 'extras'
  if (['kernel', 'bash', 'coreutils', 'sudo', 'systemd', 'openssh-server', 'chrony', 'cronie', 'firewalld', 'rsyslog', 'tar', 'lsof', 'rsync'].includes(n)) return 'baseos'
  return 'appstream'
}

/** Versión siguiente: sube el último número (1.26.3 → 1.26.4). */
function bump(v: string): string {
  return v.replace(/(\d+)(?!.*\d)/, (d) => String(Number(d) + 1))
}

/** Aplica las actualizaciones pendientes (todas o las indicadas) y devuelve [nombre, vieja, nueva]. */
function applyUpgrades(sys: System, only: string[]): [string, string, string][] {
  const targets = [...sys.upgradable].filter((n) => !only.length || only.includes(n)).sort()
  const done: [string, string, string][] = []
  for (const n of targets) {
    const old = ver(sys, n)
    const next = bump(old)
    sys.versions.set(n, next)
    sys.upgradable.delete(n)
    done.push([n, old, next])
  }
  return done
}

function aptHistory(sys: System, cmd: string, action: string, items: string[]) {
  const d = new Date().toISOString().slice(0, 19).replace('T', '  ')
  try {
    sys.vfs.writeFile('/var/log/apt/history.log', `\nStart-Date: ${d}\nCommandline: apt ${cmd}\nRequested-By: ana (1000)\n${action}: ${items.join(', ')}\nEnd-Date: ${d}\n`, ROOT_CRED, { append: true })
  } catch {
    // sin registro de apt
  }
}

/** Paquetes que en la familia Red Hat vienen del repositorio EPEL. */
const EPEL_ONLY = new Set(['htop', 'ncdu', 'nethogs'])

function stamp(ms: number) {
  const d = new Date(ms)
  return `${d.toDateString().slice(0, 3)} ${String(d.getDate()).padStart(2, '0')} ${d.toDateString().slice(4, 7)} ${d.getFullYear()} ${d.toTimeString().slice(0, 8)}`
}

function dnfInstall(ctx: CommandContext, names: string[], yes: boolean): number {
  const sys = ctx.sys
  const missing = names.filter((n) => !sys.catalog[n] || (EPEL_ONLY.has(n) && !sys.installed.has('epel-release')))
  ctx.out(`Last metadata expiration check: 0:14:08 ago on ${stamp(Date.now() - 848_000)}.\n`)
  if (missing.length) {
    for (const m of missing) ctx.err(`No match for argument: ${m}\n`)
    ctx.err(`Error: Unable to find a match: ${missing.join(' ')}\n`)
    return 1
  }
  const toInstall = names.filter((n) => !sys.installed.has(n))
  for (const n of names.filter((x) => sys.installed.has(x))) ctx.out(`Package ${n}-${ver(sys, n)}-1.el10.x86_64 is already installed.\n`)
  if (!toInstall.length) {
    ctx.out('Dependencies resolved.\nNothing to do.\nComplete!\n')
    return 0
  }
  ctx.out(`Dependencies resolved.\n${'='.repeat(80)}\n Package              Architecture     Version                 Repository      Size\n${'='.repeat(80)}\nInstalling:\n`)
  for (const n of toInstall) ctx.out(` ${n.padEnd(20)} x86_64           ${(ver(sys, n) + '-1.el10').padEnd(23)} ${repoOf(n).padEnd(9)}       48 k\n`)
  ctx.out(`\nTransaction Summary\n${'='.repeat(80)}\nInstall  ${toInstall.length} Package${toInstall.length > 1 ? 's' : ''}\n\nTotal download size: ${48 * toInstall.length} k\nInstalled size: ${132 * toInstall.length} k\n`)
  ctx.out(`Is this ok [y/N]: y\n`)
  if (!yes) ctx.err('[simulador] Se respondió "y" automáticamente. En scripts se usa -y para no tener que confirmar.\n')
  ctx.out('Downloading Packages:\nRunning transaction check\nTransaction check succeeded.\nRunning transaction test\nTransaction test succeeded.\nRunning transaction\n')
  for (const n of toInstall) {
    sys.installPackage(n)
    if (n === 'epel-release') sys.vfs.writeFile('/etc/yum.repos.d/epel.repo', EPEL_REPO, ROOT_CRED)
    ctx.out(`  Installing       : ${n}-${ver(sys, n)}-1.el10.x86_64\n`)
  }
  ctx.out(`\nInstalled:\n${toInstall.map((n) => `  ${n}-${ver(sys, n)}-1.el10.x86_64`).join('\n')}\n\nComplete!\n`)
  sys.pkgHistory.push({ id: sys.pkgHistory.length + 1, cmdline: `install ${names.join(' ')}`, date: Date.now(), altered: toInstall.length, action: 'Install', names: toInstall })
  return 0
}

register(['dnf', 'yum'], {
  usage: 'dnf [options] COMMAND',
  summary: '  install | remove | update | upgrade | search | info | list [--installed] | provides | history | repolist | makecache | clean all',
  path: '/usr/bin',
  run(ctx) {
    if (ctx.sys.distro !== 'rocky') {
      ctx.err(`bash: ${ctx.name}: command not found\n`)
      return 127
    }
    const yes = ctx.args.includes('-y') || ctx.args.includes('--assumeyes')
    const [verb, ...names] = ctx.args.filter((a) => !a.startsWith('-'))
    const sys = ctx.sys
    const needRoot = () => {
      if (ctx.sh.user === 'root') return false
      ctx.err('Error: This command has to be run with superuser privileges (under the root user on most systems).\n')
      return true
    }
    switch (verb) {
      case 'install':
        if (needRoot()) return 1
        if (!names.length) {
          ctx.err('Error: Need to pass a list of pkgs to install\n')
          return 1
        }
        return dnfInstall(ctx, names, yes)
      case 'remove':
      case 'erase': {
        if (needRoot()) return 1
        const present = names.filter((n) => sys.installed.has(n))
        if (!present.length) {
          ctx.out(`No match for argument: ${names.join(' ')}\nNo packages marked for removal.\nDependencies resolved.\nNothing to do.\nComplete!\n`)
          return 0
        }
        ctx.out(`Dependencies resolved.\nRemoving:\n${present.map((n) => ` ${n.padEnd(20)} x86_64   ${ver(sys, n)}-1.el10`).join('\n')}\n\nIs this ok [y/N]: y\nRunning transaction\n`)
        for (const n of present) sys.removePackage(n)
        ctx.out(`\nRemoved:\n${present.map((n) => `  ${n}-${ver(sys, n)}-1.el10.x86_64`).join('\n')}\n\nComplete!\n`)
        sys.pkgHistory.push({ id: sys.pkgHistory.length + 1, cmdline: `remove ${names.join(' ')}`, date: Date.now(), altered: present.length, action: 'Removed', names: present })
        return 0
      }
      case 'update':
      case 'upgrade': {
        if (needRoot()) return 1
        ctx.out(`Last metadata expiration check: 0:02:11 ago on ${stamp(Date.now() - 131_000)}.\nDependencies resolved.\n`)
        const pending = [...sys.upgradable].filter((n) => !names.length || names.includes(n))
        if (!pending.length) {
          ctx.out('Nothing to do.\nComplete!\n')
          return 0
        }
        ctx.out(`${'='.repeat(80)}\n Package              Architecture     Version                 Repository      Size\n${'='.repeat(80)}\nUpgrading:\n`)
        for (const n of pending.sort()) ctx.out(` ${n.padEnd(20)} x86_64           ${(bump(ver(sys, n)) + '-1.el10').padEnd(23)} ${n === 'kernel' ? 'baseos   ' : 'appstream'}       96 k\n`)
        ctx.out(`\nTransaction Summary\n${'='.repeat(80)}\nUpgrade  ${pending.length} Package${pending.length > 1 ? 's' : ''}\n\nIs this ok [y/N]: y\n`)
        if (!yes) ctx.err('[simulador] Se respondió "y" automáticamente. En scripts se usa -y para no tener que confirmar.\n')
        const done = applyUpgrades(sys, names)
        ctx.out('Running transaction\n')
        for (const [n, , nv] of done) ctx.out(`  Upgrading        : ${n}-${nv}-1.el10.x86_64\n`)
        ctx.out(`\nUpgraded:\n${done.map(([n, , nv]) => `  ${n}-${nv}-1.el10.x86_64`).join('\n')}\n\nComplete!\n`)
        sys.pkgHistory.push({ id: sys.pkgHistory.length + 1, cmdline: verb + (names.length ? ' ' + names.join(' ') : ''), date: Date.now(), altered: done.length, action: 'Upgrade', names: done.map((d) => d[0]) })
        return 0
      }
      case 'check-update': {
        ctx.out(`Last metadata expiration check: 0:02:11 ago on ${stamp(Date.now() - 131_000)}.\n`)
        if (!sys.upgradable.size) return 0
        ctx.out('\n')
        for (const n of [...sys.upgradable].sort()) ctx.out(`${(n + '.x86_64').padEnd(36)} ${(bump(ver(sys, n)) + '-1.el10').padEnd(20)} ${n === 'kernel' ? 'baseos' : 'appstream'}\n`)
        // dnf check-update devuelve 100 cuando hay actualizaciones (útil en scripts).
        return 100
      }
      case 'search': {
        const term = (names[0] ?? '').toLowerCase()
        const hits = Object.entries(sys.catalog).filter(([n, i]) => (n.includes(term) || i.summary.toLowerCase().includes(term)) && (!EPEL_ONLY.has(n) || sys.installed.has('epel-release')))
        ctx.out(`Last metadata expiration check: 0:14:08 ago.\n`)
        if (!hits.length) {
          ctx.out(`No matches found.\n`)
          return 1
        }
        ctx.out(`${'='.repeat(20)} Name Matched: ${term} ${'='.repeat(20)}\n`)
        for (const [n, i] of hits) ctx.out(`${n}.x86_64 : ${i.summary}\n`)
        return 0
      }
      case 'info': {
        const n = names[0]
        const info = n ? sys.catalog[n] : undefined
        if (!info) {
          ctx.err('Error: No matching Packages to list\n')
          return 1
        }
        ctx.out(`${sys.installed.has(n) ? 'Installed' : 'Available'} Packages\nName         : ${n}\nVersion      : ${info.version}\nRelease      : 1.el10\nArchitecture : x86_64\nRepository   : ${sys.installed.has(n) ? '@System' : 'appstream'}\nSummary      : ${info.summary}\n`)
        return 0
      }
      case 'list': {
        const installedOnly = ctx.args.includes('--installed') || names[0] === 'installed'
        ctx.out(installedOnly ? 'Installed Packages\n' : 'Installed Packages\n')
        for (const n of [...sys.installed].sort()) ctx.out(`${(n + '.x86_64').padEnd(36)} ${(ver(sys, n)) + '-1.el10'}    @appstream\n`)
        if (!installedOnly) {
          ctx.out('Available Packages\n')
          for (const n of Object.keys(sys.catalog).filter((x) => !sys.installed.has(x)).sort()) ctx.out(`${(n + '.x86_64').padEnd(36)} ${ver(sys, n)}-1.el10    appstream\n`)
        }
        return 0
      }
      case 'provides':
      case 'whatprovides': {
        const target = (names[0] ?? '').replace(/^.*\//, '')
        const hit = Object.entries(sys.catalog).find(([, i]) => i.commands?.includes(target))
        if (!hit) {
          ctx.err(`Error: No matches found. If searching for a file, try specifying the full path or using a wildcard prefix ("*/") at the beginning.\n`)
          return 1
        }
        ctx.out(`${hit[0]}-${hit[1].version}-1.el10.x86_64 : ${hit[1].summary}\nRepo        : appstream\nMatched from:\nFilename    : /usr/bin/${target}\n`)
        return 0
      }
      case 'history': {
        const sub = names[0]
        const id = Number(names[1])
        const entry = sys.pkgHistory.find((h) => h.id === id)
        if ((sub === 'info' || sub === 'undo') && !entry) {
          ctx.err(`Error: No transaction ID or package name given.\n`)
          return 1
        }
        if (sub === 'info' && entry) {
          ctx.out(`Transaction ID : ${entry.id}\nBegin time     : ${stamp(entry.date)}\nUser           : ${ctx.sh.user === 'root' ? 'root' : ctx.sh.user} <${ctx.sh.user}>\nReturn-Code    : Success\nCommand Line   : ${entry.cmdline}\nPackages Altered:\n${(entry.names ?? []).map((n) => `    ${(entry.action === 'Removed' ? 'Removed' : entry.action === 'Upgrade' ? 'Upgrade' : 'Install').padEnd(8)} ${n}-${ver(sys, n)}-1.el10.x86_64 @appstream`).join('\n')}\n`)
          return 0
        }
        if (sub === 'undo' && entry) {
          if (needRoot()) return 1
          const list = entry.names ?? []
          if (entry.action === 'Install') {
            for (const n of list) sys.removePackage(n)
            ctx.out(`Dependencies resolved.\nRemoving:\n${list.map((n) => ` ${n}`).join('\n')}\n\nComplete!\n`)
          } else if (entry.action === 'Removed') {
            for (const n of list) sys.installPackage(n)
            ctx.out(`Dependencies resolved.\nInstalling:\n${list.map((n) => ` ${n}`).join('\n')}\n\nComplete!\n`)
          } else {
            ctx.err('Error: The following problems occurred while running a transaction:\n  Cannot find rpm nevra for downgrade.\n')
            return 1
          }
          sys.pkgHistory.push({ id: sys.pkgHistory.length + 1, cmdline: `history undo ${id}`, date: Date.now(), altered: list.length, action: entry.action === 'Install' ? 'Removed' : 'Install', names: list })
          return 0
        }
        ctx.out('ID     | Command line             | Date and time    | Action(s)      | Altered\n' + '-'.repeat(80) + '\n')
        for (const h of [...sys.pkgHistory].reverse()) ctx.out(`${String(h.id).padStart(6)} | ${h.cmdline.padEnd(24).slice(0, 24)} | ${new Date(h.date).toISOString().slice(0, 16).replace('T', ' ')} | ${(h.action ?? (h.cmdline.startsWith('remove') ? 'Removed' : 'Install')).padEnd(14)} | ${String(h.altered).padStart(7)}\n`)
        return 0
      }
      case 'repolist':
        ctx.out(`repo id                     repo name\nappstream                   Rocky Linux 10 - AppStream\nbaseos                      Rocky Linux 10 - BaseOS\nextras                      Rocky Linux 10 - Extras\n${sys.installed.has('epel-release') ? 'epel                        Extra Packages for Enterprise Linux 10 - x86_64\n' : ''}`)
        return 0
      case 'makecache':
        ctx.out('Metadata cache created.\n')
        return 0
      case 'clean':
        ctx.out('25 files removed\n')
        return 0
      default:
        ctx.err(verb ? `No such command: ${verb}. Please use /usr/bin/dnf --help\n` : 'usage: dnf [options] COMMAND\n')
        return 1
    }
  },
})

register(['apt', 'apt-get'], {
  usage: 'apt [options] command',
  summary: '  update | install | remove | purge | upgrade | search | show | list [--installed] | autoremove',
  run(ctx) {
    if (ctx.sys.distro !== 'ubuntu') {
      ctx.err(`bash: ${ctx.name}: command not found\n`)
      return 127
    }
    const yes = ctx.args.includes('-y') || ctx.args.includes('--yes')
    const [verb, ...names] = ctx.args.filter((a) => !a.startsWith('-'))
    const sys = ctx.sys
    const lockError = () => {
      if (ctx.sh.user === 'root') return false
      ctx.err('E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?\n')
      return true
    }
    switch (verb) {
      case 'update':
        if (ctx.sh.user !== 'root') {
          ctx.err('Reading package lists... Done\nE: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)\nE: Unable to lock directory /var/lib/apt/lists/\n')
          return 100
        }
        ctx.out(`Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease\nGet:2 http://security.ubuntu.com/ubuntu noble-security InRelease [126 kB]\nHit:3 http://archive.ubuntu.com/ubuntu noble-updates InRelease\nFetched 126 kB in 1s (138 kB/s)\nReading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\n${sys.upgradable.size ? `${sys.upgradable.size} package${sys.upgradable.size > 1 ? 's' : ''} can be upgraded. Run 'apt list --upgradable' to see ${sys.upgradable.size > 1 ? 'them' : 'it'}.` : 'All packages are up to date.'}\n`)
        return 0
      case 'install': {
        if (lockError()) return 100
        ctx.out('Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\n')
        const missing = names.filter((n) => !sys.catalog[n])
        if (missing.length) {
          ctx.err(`E: Unable to locate package ${missing[0]}\n`)
          return 100
        }
        const toInstall = names.filter((n) => !sys.installed.has(n))
        for (const n of names.filter((x) => sys.installed.has(x))) ctx.out(`${n} is already the newest version (${ver(sys, n)}).\n`)
        if (!toInstall.length) {
          ctx.out('0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n')
          return 0
        }
        ctx.out(`The following NEW packages will be installed:\n  ${toInstall.join(' ')}\n0 upgraded, ${toInstall.length} newly installed, 0 to remove and 0 not upgraded.\nNeed to get ${312 * toInstall.length} kB of archives.\nAfter this operation, ${1024 * toInstall.length} kB of additional disk space will be used.\n`)
        if (!yes) {
          ctx.out('Do you want to continue? [Y/n] Y\n')
          ctx.err('[simulador] Se respondió "Y" automáticamente. En scripts se usa -y.\n')
        }
        for (const n of toInstall) {
          ctx.out(`Get:1 http://archive.ubuntu.com/ubuntu noble/main amd64 ${n} amd64 ${ver(sys, n)} [312 kB]\n`)
        }
        for (const n of toInstall) {
          sys.installPackage(n)
          ctx.out(`Selecting previously unselected package ${n}.\nUnpacking ${n} (${ver(sys, n)}) ...\nSetting up ${n} (${ver(sys, n)}) ...\n`)
          for (const s of sys.catalog[n].services ?? []) {
            if (s.enabledByDefault) ctx.out(`Created symlink /etc/systemd/system/multi-user.target.wants/${s.name}.service → /usr/lib/systemd/system/${s.name}.service.\n`)
          }
        }
        ctx.out('Processing triggers for man-db (2.12.0-4build2) ...\n')
        aptHistory(sys, `install ${names.join(' ')}`, 'Install', toInstall.map((n) => `${n}:amd64 (${ver(sys, n)})`))
        return 0
      }
      case 'remove':
      case 'purge': {
        if (lockError()) return 100
        const present = names.filter((n) => sys.installed.has(n))
        ctx.out('Reading package lists... Done\nBuilding dependency tree... Done\n')
        if (!present.length) {
          ctx.out(`Package '${names[0]}' is not installed, so not removed\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n`)
          return 0
        }
        ctx.out(`The following packages will be REMOVED:\n  ${present.join(' ')}\n0 upgraded, 0 newly installed, ${present.length} to remove and 0 not upgraded.\n`)
        for (const n of present) {
          sys.removePackage(n)
          ctx.out(`Removing ${n} (${ver(sys, n)}) ...\n`)
        }
        aptHistory(sys, `${verb} ${names.join(' ')}`, verb === 'purge' ? 'Purge' : 'Remove', present.map((n) => `${n}:amd64 (${ver(sys, n)})`))
        return 0
      }
      case 'upgrade':
      case 'full-upgrade': {
        if (lockError()) return 100
        ctx.out('Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\nCalculating upgrade... Done\n')
        const pending = [...sys.upgradable].sort()
        if (!pending.length) {
          ctx.out('0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n')
          return 0
        }
        ctx.out(`The following packages will be upgraded:\n  ${pending.join(' ')}\n${pending.length} upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n`)
        if (!yes) {
          ctx.out('Do you want to continue? [Y/n] Y\n')
          ctx.err('[simulador] Se respondió "Y" automáticamente. En scripts se usa -y.\n')
        }
        const done = applyUpgrades(sys, [])
        for (const [n, old, nv] of done) ctx.out(`Preparing to unpack .../${n}_${nv}_amd64.deb ...\nUnpacking ${n} (${nv}) over (${old}) ...\nSetting up ${n} (${nv}) ...\n`)
        aptHistory(sys, verb, 'Upgrade', done.map(([n, old, nv]) => `${n}:amd64 (${old}, ${nv})`))
        return 0
      }
      case 'autoremove':
        if (lockError()) return 100
        ctx.out('Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n')
        return 0
      case 'search': {
        const term = (names[0] ?? '').toLowerCase()
        ctx.out('Sorting... Done\nFull Text Search... Done\n')
        for (const [n, i] of Object.entries(sys.catalog).filter(([n, i]) => n.includes(term) || i.summary.toLowerCase().includes(term))) {
          ctx.out(`${n}/noble ${i.version} amd64${sys.installed.has(n) ? ' [installed]' : ''}\n  ${i.summary}\n\n`)
        }
        return 0
      }
      case 'show': {
        const info = sys.catalog[names[0] ?? '']
        if (!info) {
          ctx.err(`N: Unable to locate package ${names[0]}\nE: No packages found\n`)
          return 100
        }
        ctx.out(`Package: ${names[0]}\nVersion: ${info.version}\nPriority: optional\nSection: web\nOrigin: Ubuntu\nDescription: ${info.summary}\n`)
        return 0
      }
      case 'list': {
        ctx.out('Listing... Done\n')
        if (ctx.args.includes('--upgradable')) {
          for (const n of [...sys.upgradable].sort()) ctx.out(`${n}/noble-updates ${bump(ver(sys, n))} amd64 [upgradable from: ${ver(sys, n)}]\n`)
          return 0
        }
        const list = ctx.args.includes('--installed') ? [...sys.installed] : Object.keys(sys.catalog)
        for (const n of list.sort()) ctx.out(`${n}/noble,now ${ver(sys, n)} amd64${sys.installed.has(n) ? ' [installed]' : ''}\n`)
        return 0
      }
      default:
        ctx.err(verb ? `E: Invalid operation ${verb}\n` : 'apt 2.7.14 (amd64)\nUsage: apt [options] command\n')
        return 100
    }
  },
})

register('rpm', {
  usage: 'rpm -q PACKAGE | -qa | -qf FILE | -ql PACKAGE',
  run(ctx) {
    if (ctx.sys.distro !== 'rocky') {
      ctx.err('bash: rpm: command not found\n')
      return 127
    }
    const [opt, arg] = ctx.args
    const sys = ctx.sys
    if (opt === '-qa') {
      for (const n of [...sys.installed].sort()) ctx.out(`${n}-${ver(sys, n)}-1.el10.x86_64\n`)
      return 0
    }
    if (opt === '-q') {
      if (!sys.installed.has(arg)) {
        ctx.out(`package ${arg} is not installed\n`)
        return 1
      }
      ctx.out(`${arg}-${ver(sys, arg)}-1.el10.x86_64\n`)
      return 0
    }
    if (opt === '-qf') {
      const path = arg?.startsWith('/') ? arg : ctx.sh.resolve(arg ?? '')
      const hit = ownerOf(sys, path)
      if (!hit) {
        ctx.out(sys.vfs.exists(path) ? `file ${path} is not owned by any package\n` : `error: file ${path}: No such file or directory\n`)
        return 1
      }
      ctx.out(`${hit.name}-${hit.version}-1.el10.x86_64\n`)
      return 0
    }
    if (opt === '-qi') {
      const info = sys.catalog[arg]
      if (!info || !sys.installed.has(arg)) {
        ctx.out(`package ${arg} is not installed\n`)
        return 1
      }
      ctx.out(`Name        : ${arg}\nVersion     : ${ver(sys, arg)}\nRelease     : 1.el10\nArchitecture: x86_64\nInstall Date: ${new Date().toUTCString()}\nGroup       : Unspecified\nSignature   : RSA/SHA256, Rocky Enterprise Software Foundation\nSource RPM  : ${arg}-${ver(sys, arg)}-1.el10.src.rpm\nVendor      : Rocky Enterprise Software Foundation\nSummary     : ${info.summary}\n`)
      return 0
    }
    if (opt === '-ql') {
      const info = sys.catalog[arg]
      if (!info || !sys.installed.has(arg)) {
        ctx.out(`package ${arg} is not installed\n`)
        return 1
      }
      for (const c of info.commands ?? []) ctx.out(`${binDir(c)}/${c}\n`)
      for (const f of Object.keys(info.files ?? {})) ctx.out(f + '\n')
      return 0
    }
    ctx.err('rpm: no arguments given for query\n')
    return 1
  },
})

register('dpkg', {
  usage: 'dpkg -l [PATTERN] | -L PACKAGE | -S FILE',
  run(ctx) {
    if (ctx.sys.distro !== 'ubuntu') {
      ctx.err('bash: dpkg: command not found\n')
      return 127
    }
    const [opt, arg] = ctx.args
    const sys = ctx.sys
    if (opt === '-l') {
      ctx.out('Desired=Unknown/Install/Remove/Purge/Hold\n||/ Name           Version      Architecture Description\n+++-==============-============-============-=================================\n')
      for (const n of [...sys.installed].filter((x) => !arg || x.includes(arg.replace(/\*/g, ''))).sort()) ctx.out(`ii  ${n.padEnd(14)} ${(ver(sys, n)).padEnd(12)} amd64        ${sys.catalog[n]?.summary ?? ''}\n`)
      return 0
    }
    if (opt === '-L') {
      const info = sys.catalog[arg]
      if (!info || !sys.installed.has(arg)) {
        ctx.err(`dpkg-query: package '${arg}' is not installed\n`)
        return 1
      }
      for (const c of info.commands ?? []) ctx.out(`${binDir(c)}/${c}\n`)
      for (const f of Object.keys(info.files ?? {})) ctx.out(f + '\n')
      return 0
    }
    if (opt === '-S') {
      const path = arg?.startsWith('/') ? arg : (arg ?? '')
      const hit = path.startsWith('/') ? ownerOf(sys, path) : undefined
      if (!hit) {
        ctx.err(`dpkg-query: no path found matching pattern ${arg}\n`)
        return 1
      }
      ctx.out(`${hit.name}: ${path}\n`)
      return 0
    }
    ctx.err('dpkg: error: need an action option\n')
    return 2
  },
})

register('apt-cache', {
  usage: 'apt-cache policy PACKAGE | show PACKAGE',
  run(ctx) {
    if (ctx.sys.distro !== 'ubuntu') {
      ctx.err('bash: apt-cache: command not found\n')
      return 127
    }
    const [verb, name] = ctx.args
    const sys = ctx.sys
    if (verb !== 'policy' || !name) {
      ctx.err('E: Invalid operation\n')
      return 100
    }
    if (!sys.catalog[name]) {
      ctx.out(`N: Unable to locate package ${name}\n`)
      return 0
    }
    const installed = sys.installed.has(name) ? ver(sys, name) : '(none)'
    const candidate = sys.upgradable.has(name) ? bump(ver(sys, name)) : ver(sys, name)
    ctx.out(`${name}:\n  Installed: ${installed}\n  Candidate: ${candidate}\n  Version table:\n${sys.upgradable.has(name) ? `     ${candidate} 500\n        500 http://archive.ubuntu.com/ubuntu noble-updates/main amd64 Packages\n` : ''} ${sys.installed.has(name) ? '***' : '   '} ${ver(sys, name)} 500\n        500 http://archive.ubuntu.com/ubuntu noble/main amd64 Packages\n${sys.installed.has(name) ? '        100 /var/lib/dpkg/status\n' : ''}`)
    return 0
  },
})
