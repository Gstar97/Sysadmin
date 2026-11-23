import { describe, expect, it } from 'vitest'
import { evaluateRsyslog, parseRsyslog, renderTemplate, validateRsyslog, type RsMessage } from '@/engines/config/rsyslog'
import { createBashSession, stripAnsi, verifyBash } from '@/engines/shell'
import { bashCheckSchema, type BashStateInput } from '@/engines/shell/schema'

const msg = (o: Partial<RsMessage> = {}): RsMessage => ({ facility: 'user', severity: 'notice', hostname: 'web01', fromhost: 'web01', fromhostIp: '127.0.0.1', programname: 'ana', msg: 'hola', time: Date.UTC(2026, 10, 23, 14, 2, 11), inputname: 'imuxsock', ...o })

describe('rsyslog: lectura y validación', () => {
  it('selectores clásicos, none y continuación de línea', () => {
    const cfg = parseRsyslog('*.info;mail.none;authpriv.none\t/var/log/messages\nauthpriv.*\t/var/log/secure\n*.=debug;\\\n\tauth,authpriv.none\t-/var/log/debug\n')
    expect(cfg.errors).toEqual([])
    const files = (m: RsMessage) => evaluateRsyslog(cfg, m).map((a) => (a.kind === 'file' ? a.path : a.kind))
    expect(files(msg())).toEqual(['/var/log/messages'])
    expect(files(msg({ facility: 'authpriv', severity: 'info' }))).toEqual(['/var/log/secure'])
    expect(files(msg({ severity: 'debug' }))).toEqual(['/var/log/debug'])
    expect(files(msg({ facility: 'mail', severity: 'err' }))).toEqual([])
  })

  it('RainerScript: módulos, entradas, plantillas, if con stop y reenvío', () => {
    const text = `module(load="imtcp")
input(type="imtcp" port="514" ruleset="remotos")
template(name="PorEquipo" type="string" string="/var/log/remote/%HOSTNAME%/%PROGRAMNAME%.log")
ruleset(name="remotos") {
  action(type="omfile" dynaFile="PorEquipo")
  stop
}
if $programname == 'app' and $msg contains 'ERROR' then {
  action(type="omfwd" target="logs01" port="514" protocol="tcp"
         queue.type="LinkedList" action.resumeRetryCount="-1")
  stop
}
*.* /var/log/todo.log
`
    const cfg = parseRsyslog(text)
    expect(cfg.errors).toEqual([])
    expect(cfg.inputs).toMatchObject([{ type: 'imtcp', port: 514, protocol: 'tcp', ruleset: 'remotos' }])
    const a = evaluateRsyslog(cfg, msg({ programname: 'app', msg: 'ERROR al pagar' }))
    expect(a).toMatchObject([{ kind: 'fwd', target: 'logs01', port: 514, protocol: 'tcp', queued: true }])
    expect(evaluateRsyslog(cfg, msg({ programname: 'app', msg: 'todo bien' }))).toMatchObject([{ kind: 'file', path: '/var/log/todo.log' }])
    const r = evaluateRsyslog(cfg, msg({ hostname: 'web01', programname: 'sshd' }), 'remotos')
    expect(r).toMatchObject([{ kind: 'file', dynaFile: 'PorEquipo' }])
    expect(renderTemplate(cfg.templates.get('PorEquipo')!.string, msg({ programname: 'sshd' }))).toBe('/var/log/remote/web01/sshd.log')
  })

  it('formato clásico de reenvío (@ y @@) y filtros por propiedad', () => {
    const cfg = parseRsyslog(':programname, isequal, "nginx" /var/log/nginx-sys.log\n& stop\nauthpriv.* @@192.168.10.40:10514\n*.* @logs01\n')
    expect(cfg.errors).toEqual([])
    expect(evaluateRsyslog(cfg, msg({ programname: 'nginx' }))).toMatchObject([{ kind: 'file', path: '/var/log/nginx-sys.log' }])
    expect(evaluateRsyslog(cfg, msg({ facility: 'authpriv', severity: 'info' }))).toMatchObject([
      { kind: 'fwd', target: '192.168.10.40', port: 10514, protocol: 'tcp' },
      { kind: 'fwd', target: 'logs01', port: 514, protocol: 'udp' },
    ])
  })

  it('errores con los mensajes de rsyslogd', () => {
    const errs = (t: string) => parseRsyslog(t).errors.map((e) => e.message)
    expect(errs('input(type="imtcp" port="514")\n')).toEqual(["input module name 'imtcp' is unknown"])
    expect(errs('$InputTCPServerRun 514\n')[0]).toContain("invalid or yet-unknown config file command 'InputTCPServerRun' - have you forgotten to load a module?")
    expect(errs('module(load="imtpc")\n')[0]).toContain("could not load module 'imtpc'")
    expect(errs('module(load="imtcp")\nmodule(load="imtcp")\n')).toEqual(["module 'imtcp' already in this config, cannot be added"])
    expect(errs('*.* action(type="omfwd" target="logs01" prot="tcp")\n')).toEqual(["omfwd: parameter 'prot' not known -- typo in config file?"])
    expect(errs('*.* action(type="omfwd" port="514")\n')[0]).toContain("parameter 'target' required")
    expect(errs('if $fromhostip != "127.0.0.1" then stop\n')).toEqual(["invalid property 'fromhostip'"])
    expect(errs('*.* ?NoExiste\n')).toEqual(["Could not find template 'NoExiste' - action disabled"])
    expect(errs('modul(load="imtcp")\n')).toEqual(["syntax error on token 'modul'"])
    expect(validateRsyslog('if $programname == "x" then {\n  stop\n').diagnostics[0].message).toContain('EOF')
  })
})

const NOPASS = { '/etc/sudoers.d/ana': { contenido: 'ana ALL=(ALL) NOPASSWD: ALL\n' } }
const REMOTE = `module(load="imtcp")
input(type="imtcp" port="514" ruleset="remotos")
template(name="PorEquipo" type="string" string="/var/log/remote/%HOSTNAME%/%PROGRAMNAME%.log")
ruleset(name="remotos") {
  action(type="omfile" dynaFile="PorEquipo")
}
`

function lab(extra: Partial<BashStateInput> = {}, web01Files: Record<string, { contenido: string }> = {}): BashStateInput {
  return {
    distro: 'rocky',
    hostname: 'logs01',
    usuario: 'ana',
    usuarios: [{ nombre: 'ana', sudo: true, clave_ssh: true }],
    red: { interfaces: [{ nombre: 'enp1s0', ip: '192.168.10.40/24', estado: 'UP' }] },
    archivos: { ...NOPASS, '/etc/hosts': { contenido: '127.0.0.1 localhost\n192.168.10.11 web01\n192.168.10.40 logs01\n' } },
    servidores: [{ hostname: 'web01', ip: '192.168.10.11', distro: 'ubuntu', clave_conocida: 'si', usuarios: [{ nombre: 'ana', clave_ssh: true }], archivos: { ...NOPASS, '/etc/hosts': { contenido: '127.0.0.1 localhost\n192.168.10.40 logs01\n' }, ...web01Files } }],
    ...extra,
  } as BashStateInput
}

async function session(state: BashStateInput) {
  const sh = createBashSession(state)
  const run = async (cmd: string) => {
    const r = await sh.run(cmd)
    return { out: stripAnsi(r.chunks.map((c) => c.text).join('')), code: sh.lastExit }
  }
  const check = (c: object) => verifyBash(sh, bashCheckSchema.parse(c)).ok
  return { sh, run, check }
}

describe('rsyslog en el simulador', () => {
  it('las configuraciones de fábrica no tienen errores y los archivos de siempre se siguen escribiendo', async () => {
    const { run } = await session(lab())
    const n = await run('rsyslogd -N1')
    expect(n.out).toContain('config validation run (level 1), master config /etc/rsyslog.conf')
    expect(n.out).toContain('End of config validation run. Bye.')
    expect(n.code).toBe(0)
    expect((await run('ssh web01 rsyslogd -N1')).out).not.toContain('error')
    await run('logger -t prueba hola desde logs01')
    expect((await run('sudo tail -1 /var/log/messages')).out).toMatch(/^[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d logs01 prueba: hola desde logs01$/m)
    await run('ssh web01 "logger -p auth.warning acceso raro"')
    expect((await run('ssh web01 "sudo grep acceso /var/log/auth.log"')).out).toContain('web01 ana: acceso raro')
    expect((await run('ssh web01 "sudo grep -c acceso /var/log/syslog"')).out.trim()).toBe('0')
  })

  it('reenvío por TCP: firewall, recepción con plantilla por equipo y SSH fallido', async () => {
    const { run, check } = await session(lab())
    await run(`printf '%s' '${REMOTE.replace(/'/g, "'\\''")}' | sudo tee /etc/rsyslog.d/10-remotos.conf >/dev/null`)
    expect((await run('rsyslogd -N1')).code).toBe(0)
    await run('sudo systemctl restart rsyslog')
    expect((await run('sudo ss -tlnp')).out).toMatch(/0\.0\.0\.0:514 .*rsyslogd/)
    await run(`ssh web01 "echo '*.* @@logs01:514' | sudo tee /etc/rsyslog.d/90-reenvio.conf && sudo systemctl restart rsyslog"`)
    await run('ssh web01 "logger -t app primer mensaje"')
    // firewalld de logs01 rechaza el 514: el mensaje no llega y web01 lo avisa en su journal.
    expect((await run('ssh web01 "sudo journalctl -u rsyslog --no-pager"')).out).toContain('cannot connect to 192.168.10.40:514: No route to host')
    expect(check({ archivo: '/var/log/remote/web01/app.log', existe: false })).toBe(true)
    await run('sudo firewall-cmd --permanent --add-port=514/tcp && sudo firewall-cmd --reload')
    await run('ssh web01 "logger -t app segundo mensaje"')
    const app = (await run('sudo cat /var/log/remote/web01/app.log')).out
    expect(app).toMatch(/web01 app: segundo mensaje/)
    expect(app).not.toContain('primer mensaje')
    expect((await run('ssh web01 "sudo journalctl -u rsyslog --no-pager"')).out).toContain("action 'action-1-builtin:omfwd' resumed")
    // Un intento de SSH fallido en web01 llega a logs01.
    await run('ssh nadie@web01 true <<< "mala"')
    await run('sshpass -p mala ssh nadie@web01 true')
    expect((await run('sudo cat /var/log/remote/web01/sshd.log')).out).toMatch(/web01 sshd\[\d+\]: (Invalid user|Failed password|Connection closed)/)
  })

  it('con cola, los mensajes esperan a que vuelva el servidor; por UDP se pierden sin aviso', async () => {
    const queued = `*.* action(type="omfwd" target="logs01" port="514" protocol="tcp" queue.type="LinkedList" queue.filename="fwd" action.resumeRetryCount="-1")\n`
    const { run } = await session(lab({ servicios: { rsyslog: { activo: false } } }, { '/etc/rsyslog.d/90-reenvio.conf': { contenido: queued } }))
    await run(`printf '%s' '${REMOTE.replace(/'/g, "'\\''")}' | sudo tee /etc/rsyslog.d/10-remotos.conf >/dev/null`)
    await run('sudo firewall-cmd --add-port=514/tcp')
    await run('ssh web01 "logger -t app mientras logs01 estaba apagado"')
    expect((await run('ssh web01 "sudo journalctl -u rsyslog --no-pager"')).out).toContain('Connection refused')
    await run('sudo systemctl start rsyslog')
    await run('ssh web01 "logger -t app ya volvió"')
    const app = (await run('sudo cat /var/log/remote/web01/app.log')).out
    expect(app).toContain('mientras logs01 estaba apagado')
    expect(app).toContain('ya volvió')
    expect(app.indexOf('mientras')).toBeLessThan(app.indexOf('ya volvió'))
  })

  it('SELinux: un puerto que no es de syslog no se puede abrir hasta etiquetarlo', async () => {
    const { run } = await session(lab({ paquetes: { instalados: ['policycoreutils-python-utils'] } }))
    await run(`printf 'module(load="imtcp")\\ninput(type="imtcp" port="1514")\\n' | sudo tee /etc/rsyslog.d/10-remotos.conf >/dev/null`)
    await run('sudo systemctl restart rsyslog')
    expect((await run('ss -tln')).out).not.toContain(':1514')
    expect((await run('sudo journalctl -u rsyslog --no-pager')).out).toContain('cannot bind socket for port 1514: Permission denied')
    await run('sudo semanage port -a -t syslogd_port_t -p tcp 1514')
    await run('sudo systemctl restart rsyslog')
    expect((await run('ss -tln')).out).toContain(':1514')
  })
})
