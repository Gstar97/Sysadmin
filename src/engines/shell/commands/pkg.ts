import { register, type CommandContext } from '../shell'

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
  for (const n of names.filter((x) => sys.installed.has(x))) ctx.out(`Package ${n}-${sys.catalog[n].version}-1.el10.x86_64 is already installed.\n`)
  if (!toInstall.length) {
    ctx.out('Dependencies resolved.\nNothing to do.\nComplete!\n')
    return 0
  }
  ctx.out(`Dependencies resolved.\n${'='.repeat(80)}\n Package              Architecture     Version                 Repository      Size\n${'='.repeat(80)}\nInstalling:\n`)
  for (const n of toInstall) ctx.out(` ${n.padEnd(20)} x86_64           ${(sys.catalog[n].version + '-1.el10').padEnd(23)} ${EPEL_ONLY.has(n) ? 'epel' : 'appstream'}       48 k\n`)
  ctx.out(`\nTransaction Summary\n${'='.repeat(80)}\nInstall  ${toInstall.length} Package${toInstall.length > 1 ? 's' : ''}\n\nTotal download size: ${48 * toInstall.length} k\nInstalled size: ${132 * toInstall.length} k\n`)
  ctx.out(`Is this ok [y/N]: y\n`)
  if (!yes) ctx.err('[simulador] Se respondió "y" automáticamente. En scripts se usa -y para no tener que confirmar.\n')
  ctx.out('Downloading Packages:\nRunning transaction check\nTransaction check succeeded.\nRunning transaction test\nTransaction test succeeded.\nRunning transaction\n')
  for (const n of toInstall) {
    sys.installPackage(n)
    ctx.out(`  Installing       : ${n}-${sys.catalog[n].version}-1.el10.x86_64\n`)
  }
  ctx.out(`\nInstalled:\n${toInstall.map((n) => `  ${n}-${sys.catalog[n].version}-1.el10.x86_64`).join('\n')}\n\nComplete!\n`)
  sys.pkgHistory.push({ id: sys.pkgHistory.length + 1, cmdline: `install ${names.join(' ')}`, date: Date.now(), altered: toInstall.length })
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
        ctx.out(`Dependencies resolved.\nRemoving:\n${present.map((n) => ` ${n.padEnd(20)} x86_64   ${sys.catalog[n].version}-1.el10`).join('\n')}\n\nIs this ok [y/N]: y\nRunning transaction\n`)
        for (const n of present) sys.removePackage(n)
        ctx.out(`\nRemoved:\n${present.map((n) => `  ${n}-${sys.catalog[n].version}-1.el10.x86_64`).join('\n')}\n\nComplete!\n`)
        sys.pkgHistory.push({ id: sys.pkgHistory.length + 1, cmdline: `remove ${names.join(' ')}`, date: Date.now(), altered: present.length })
        return 0
      }
      case 'update':
      case 'upgrade':
        if (needRoot()) return 1
        ctx.out(`Last metadata expiration check: 0:02:11 ago on ${stamp(Date.now() - 131_000)}.\nDependencies resolved.\nNothing to do.\nComplete!\n`)
        return 0
      case 'check-update':
        return 0
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
        for (const n of [...sys.installed].sort()) ctx.out(`${(n + '.x86_64').padEnd(36)} ${(sys.catalog[n]?.version ?? '1.0') + '-1.el10'}    @appstream\n`)
        if (!installedOnly) {
          ctx.out('Available Packages\n')
          for (const n of Object.keys(sys.catalog).filter((x) => !sys.installed.has(x)).sort()) ctx.out(`${(n + '.x86_64').padEnd(36)} ${sys.catalog[n].version}-1.el10    appstream\n`)
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
      case 'history':
        ctx.out('ID     | Command line             | Date and time    | Action(s)      | Altered\n' + '-'.repeat(80) + '\n')
        for (const h of [...sys.pkgHistory].reverse()) ctx.out(`${String(h.id).padStart(6)} | ${h.cmdline.padEnd(24).slice(0, 24)} | ${new Date(h.date).toISOString().slice(0, 16).replace('T', ' ')} | ${h.cmdline.startsWith('remove') ? 'Removed' : 'Install'}        | ${String(h.altered).padStart(7)}\n`)
        return 0
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
        ctx.out('Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease\nGet:2 http://security.ubuntu.com/ubuntu noble-security InRelease [126 kB]\nHit:3 http://archive.ubuntu.com/ubuntu noble-updates InRelease\nFetched 126 kB in 1s (138 kB/s)\nReading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\nAll packages are up to date.\n')
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
        for (const n of names.filter((x) => sys.installed.has(x))) ctx.out(`${n} is already the newest version (${sys.catalog[n].version}).\n`)
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
          ctx.out(`Get:1 http://archive.ubuntu.com/ubuntu noble/main amd64 ${n} amd64 ${sys.catalog[n].version} [312 kB]\n`)
        }
        for (const n of toInstall) {
          sys.installPackage(n)
          ctx.out(`Selecting previously unselected package ${n}.\nUnpacking ${n} (${sys.catalog[n].version}) ...\nSetting up ${n} (${sys.catalog[n].version}) ...\n`)
          for (const s of sys.catalog[n].services ?? []) {
            if (s.enabledByDefault) ctx.out(`Created symlink /etc/systemd/system/multi-user.target.wants/${s.name}.service → /usr/lib/systemd/system/${s.name}.service.\n`)
          }
        }
        ctx.out('Processing triggers for man-db (2.12.0-4build2) ...\n')
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
          ctx.out(`Removing ${n} (${sys.catalog[n].version}) ...\n`)
        }
        return 0
      }
      case 'upgrade':
      case 'full-upgrade':
      case 'autoremove':
        if (lockError()) return 100
        ctx.out('Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\nCalculating upgrade... Done\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n')
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
        const list = ctx.args.includes('--installed') ? [...sys.installed] : Object.keys(sys.catalog)
        for (const n of list.sort()) ctx.out(`${n}/noble,now ${sys.catalog[n]?.version ?? '1.0'} amd64${sys.installed.has(n) ? ' [installed]' : ''}\n`)
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
      for (const n of [...sys.installed].sort()) ctx.out(`${n}-${sys.catalog[n]?.version ?? '1.0'}-1.el10.x86_64\n`)
      return 0
    }
    if (opt === '-q') {
      if (!sys.installed.has(arg)) {
        ctx.out(`package ${arg} is not installed\n`)
        return 1
      }
      ctx.out(`${arg}-${sys.catalog[arg].version}-1.el10.x86_64\n`)
      return 0
    }
    if (opt === '-qf') {
      const name = (arg ?? '').replace(/^.*\//, '')
      const hit = Object.entries(sys.catalog).find(([n, i]) => sys.installed.has(n) && (i.commands?.includes(name) || Object.keys(i.files ?? {}).includes(arg)))
      if (!hit) {
        ctx.out(`file ${arg} is not owned by any package\n`)
        return 1
      }
      ctx.out(`${hit[0]}-${hit[1].version}-1.el10.x86_64\n`)
      return 0
    }
    if (opt === '-ql') {
      const info = sys.catalog[arg]
      if (!info || !sys.installed.has(arg)) {
        ctx.out(`package ${arg} is not installed\n`)
        return 1
      }
      for (const c of info.commands ?? []) ctx.out(`/usr/bin/${c}\n`)
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
      for (const n of [...sys.installed].filter((x) => !arg || x.includes(arg.replace(/\*/g, ''))).sort()) ctx.out(`ii  ${n.padEnd(14)} ${(sys.catalog[n]?.version ?? '1.0').padEnd(12)} amd64        ${sys.catalog[n]?.summary ?? ''}\n`)
      return 0
    }
    if (opt === '-L') {
      const info = sys.catalog[arg]
      if (!info || !sys.installed.has(arg)) {
        ctx.err(`dpkg-query: package '${arg}' is not installed\n`)
        return 1
      }
      for (const c of info.commands ?? []) ctx.out(`/usr/bin/${c}\n`)
      for (const f of Object.keys(info.files ?? {})) ctx.out(f + '\n')
      return 0
    }
    if (opt === '-S') {
      const name = (arg ?? '').replace(/^.*\//, '')
      const hit = Object.entries(sys.catalog).find(([n, i]) => sys.installed.has(n) && (i.commands?.includes(name) || Object.keys(i.files ?? {}).includes(arg)))
      if (!hit) {
        ctx.err(`dpkg-query: no path found matching pattern ${arg}\n`)
        return 1
      }
      ctx.out(`${hit[0]}: ${arg}\n`)
      return 0
    }
    ctx.err('dpkg: error: need an action option\n')
    return 2
  },
})
