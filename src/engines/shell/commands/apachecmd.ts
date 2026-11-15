/**
 * Apache: apachectl / httpd / apache2ctl, a2ensite y compañía (Ubuntu) y htpasswd.
 */
import { apacheDumpVhosts, apacheModules, apacheService, apacheStartCheck, apacheTest } from '../apache'
import { register, type CommandContext } from '../shell'
import { ROOT_CRED } from '../vfs'
import { SERVICE_CHECKS } from './sysinfo'

function apacheCtl(ctx: CommandContext): number {
  const sys = ctx.sys
  const a = ctx.args
  const svcName = apacheService(sys)
  if (a.includes('-v') || a.includes('-V')) {
    const v = sys.distro === 'rocky' ? '2.4.63 (Rocky Linux)' : '2.4.66 (Ubuntu)'
    ctx.out(`Server version: Apache/${v}\nServer built:   2026-03-10T00:00:00\n`)
    if (a.includes('-V')) ctx.out(`Server's Module Magic Number: 20120211:137\nServer loaded:  APR 1.7.5, APR-UTIL 1.6.3, PCRE 10.44 2024-06-07\nArchitecture:   64-bit\nServer MPM:     event\n  threaded:     yes (fixed thread count)\n    forked:     yes (variable process count)\n`)
    return 0
  }
  if (a.includes('-M') || (a.includes('-D') && a.includes('DUMP_MODULES'))) {
    const mods = apacheModules(sys)
    ctx.out('Loaded Modules:\n' + mods.map((m) => ` ${m} (${['core_module', 'so_module', 'http_module'].includes(m) ? 'static' : 'shared'})`).join('\n') + '\n')
    return 0
  }
  if (a.includes('-S')) {
    const t = apacheTest(sys)
    if (t.errors.length) {
      ctx.err(t.errors[0] + '\n')
      return 1
    }
    ctx.out(apacheDumpVhosts(sys))
    return 0
  }
  if (a.includes('-t') || a.includes('configtest')) {
    const t = apacheTest(sys)
    for (const w of t.warnings) ctx.err(w + '\n')
    if (t.errors.length) {
      ctx.err(t.errors[0] + '\n')
      return 1
    }
    ctx.err('Syntax OK\n')
    return 0
  }
  const verb = a[0]
  if (['start', 'stop', 'restart', 'graceful', 'graceful-stop', 'status'].includes(verb ?? '')) {
    ctx.err(`[simulador] Apache se maneja como servicio: sudo systemctl ${verb === 'graceful' ? 'reload' : verb} ${svcName}\n`)
    return 1
  }
  ctx.err(`Usage: ${ctx.name} [-D name] [-d directory] [-f file]\n       [-C "directive"] [-c "directive"]\n       [-k start|restart|graceful|graceful-stop|stop]\n       [-v] [-V] [-h] [-l] [-L] [-t] [-T] [-S] [-X]\n`)
  return 1
}

register(['apachectl', 'httpd'], { usage: 'apachectl -t | -S | -M | -V', path: '/usr/sbin', run: apacheCtl })
register(['apache2ctl', 'apache2'], { usage: 'apache2ctl -t | -S | -M | -V', path: '/usr/sbin', run: apacheCtl })

SERVICE_CHECKS.httpd = (ctx) => apacheStartCheck(ctx.sys)
SERVICE_CHECKS.apache2 = (ctx) => apacheStartCheck(ctx.sys)

const DEPS: Record<string, string[]> = { ssl: ['setenvif', 'mime', 'socache_shmcb'], proxy_http: ['proxy'], proxy_wstunnel: ['proxy'], proxy_balancer: ['proxy', 'alias', 'slotmem_shm', 'lbmethod_byrequests'] }

function a2(kind: 'site' | 'mod' | 'conf', enable: boolean) {
  return (ctx: CommandContext) => {
    const sys = ctx.sys
    if (sys.distro !== 'ubuntu') {
      ctx.err(`bash: ${ctx.name}: command not found\n[simulador] En Rocky no hay a2ensite: los sitios son archivos en /etc/httpd/conf.d/ y los módulos se cargan en /etc/httpd/conf.modules.d/.\n`)
      return 127
    }
    if (ctx.sh.user !== 'root') {
      ctx.err(`ERROR: ${ctx.name} must be run as root\n`)
      return 1
    }
    const names = ctx.args.filter((x) => !x.startsWith('-'))
    const avail = `/etc/apache2/${kind}s-available`
    const en = `/etc/apache2/${kind}s-enabled`
    if (!names.length) {
      const list = sys.vfs.exists(avail) ? sys.vfs.readdir(avail, ROOT_CRED).filter((f) => f.endsWith(kind === 'mod' ? '.load' : '.conf')).map((f) => f.replace(/\.(load|conf)$/, '')) : []
      ctx.out(`Your choices are: ${list.join(' ')}\nWhich ${kind === 'site' ? 'site(s)' : kind === 'mod' ? 'module(s)' : 'conf(s)'} do you want to ${enable ? 'enable' : 'disable'} (wildcards ok)?\n`)
      return 1
    }
    const Label = kind === 'site' ? 'Site' : kind === 'mod' ? 'Module' : 'Conf'
    const label = kind === 'site' ? 'site' : kind === 'mod' ? 'module' : 'conf'
    let restart = false
    if (!sys.vfs.exists(en)) sys.vfs.mkdirp(en, ROOT_CRED)
    for (const raw of names) {
      const name = raw.replace(/\.(conf|load)$/, '')
      const files = kind === 'mod' ? [`${name}.load`, `${name}.conf`] : [`${name}.conf`]
      if (!sys.vfs.exists(`${avail}/${files[0]}`)) {
        ctx.err(`ERROR: ${Label} ${name} does not exist!\n`)
        return 1
      }
      if (enable && kind === 'mod') {
        for (const dep of DEPS[name] ?? []) {
          if (!sys.vfs.exists(`${avail}/${dep}.load`)) continue
          ctx.out(`Considering dependency ${dep} for ${name}:\n`)
          if (sys.vfs.exists(`${en}/${dep}.load`, ROOT_CRED, false)) ctx.out(`Module ${dep} already enabled\n`)
          else {
            ctx.out(`Enabling module ${dep}.\n`)
            sys.vfs.symlink(`../mods-available/${dep}.load`, `${en}/${dep}.load`, ROOT_CRED)
          }
        }
      }
      const already = sys.vfs.exists(`${en}/${files[0]}`, ROOT_CRED, false)
      if (enable && already) {
        ctx.out(`${Label} ${name} already enabled\n`)
        continue
      }
      if (!enable && !already) {
        ctx.out(`${Label} ${name} already disabled\n`)
        continue
      }
      for (const f of files) {
        if (!sys.vfs.exists(`${avail}/${f}`)) continue
        if (enable) sys.vfs.symlink(`../${kind}s-available/${f}`, `${en}/${f}`, ROOT_CRED)
        else if (sys.vfs.exists(`${en}/${f}`, ROOT_CRED, false)) sys.vfs.unlink(`${en}/${f}`, ROOT_CRED)
      }
      ctx.out(enable ? `Enabling ${label} ${name}.\n` : `${Label} ${name} disabled.\n`)
      if (enable && name === 'ssl') ctx.out('See /usr/share/doc/apache2/README.Debian.gz on how to configure SSL and create self-signed certificates.\n')
      if (kind === 'mod') restart = true
    }
    ctx.out(`To activate the new configuration, you need to run:\n  systemctl ${restart ? 'restart' : 'reload'} apache2\n`)
    return 0
  }
}

register('a2ensite', { usage: 'a2ensite SITIO', path: '/usr/sbin', run: a2('site', true) })
register('a2dissite', { usage: 'a2dissite SITIO', path: '/usr/sbin', run: a2('site', false) })
register('a2enmod', { usage: 'a2enmod MÓDULO', path: '/usr/sbin', run: a2('mod', true) })
register('a2dismod', { usage: 'a2dismod MÓDULO', path: '/usr/sbin', run: a2('mod', false) })
register('a2enconf', { usage: 'a2enconf CONF', path: '/usr/sbin', run: a2('conf', true) })
register('a2disconf', { usage: 'a2disconf CONF', path: '/usr/sbin', run: a2('conf', false) })

register('htpasswd', {
  usage: 'htpasswd [-c] [-B] archivo usuario',
  run(ctx) {
    const flags = ctx.args.filter((x) => x.startsWith('-')).join('')
    const [file, user] = ctx.args.filter((x) => !x.startsWith('-'))
    if (!file || !user) {
      ctx.err('Usage:\n\thtpasswd [-cimB25dpsDv] [-C cost] [-r rounds] passwordfile username\n')
      return 2
    }
    const path = ctx.sh.resolve(file)
    const exists = ctx.sys.vfs.exists(path)
    if (!exists && !flags.includes('c')) {
      ctx.err(`htpasswd: cannot modify file ${file}; use '-c' to create it\n`)
      return 1
    }
    if (!flags.includes('b')) ctx.err('New password: \nRe-type new password: \n')
    const hash = `$2y$05$${btoa(`${user}:${Math.random()}`).replace(/[^a-zA-Z0-9]/g, '').padEnd(53, 'x').slice(0, 53)}`
    let text = exists && !flags.includes('c') ? ctx.sys.vfs.readFile(path, ctx.sh.cred) : ''
    const had = text.split('\n').some((l) => l.startsWith(`${user}:`))
    text = had ? text.replace(new RegExp(`^${user}:.*$`, 'm'), `${user}:${hash}`) : text + `${user}:${hash}\n`
    try {
      ctx.sys.vfs.writeFile(path, text, ctx.sh.cred, { mode: 0o640, umask: ctx.sh.umask })
    } catch {
      ctx.err(`htpasswd: cannot create file ${file}\n`)
      return 1
    }
    ctx.err(`${had ? 'Updating' : 'Adding'} password for user ${user}\n`)
    return 0
  },
})
