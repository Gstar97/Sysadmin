import { describe, expect, it } from 'vitest'
import { createBashSession, stripAnsi, verifyBash } from '@/engines/shell'
import type { BashStateInput } from '@/engines/shell/schema'

async function session(state: BashStateInput) {
  const sh = createBashSession(state)
  const run = async (cmd: string) => {
    const r = await sh.run(cmd)
    return { out: stripAnsi(r.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join('')), err: stripAnsi(r.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join('')), code: sh.lastExit }
  }
  return { sh, run }
}

const red: BashStateInput = {
  distro: 'rocky',
  hostname: 'admin01',
  usuario: 'ana',
  usuarios: [{ nombre: 'ana', sudo: true }],
  red: { interfaces: [{ nombre: 'enp0s3', ip: '192.168.10.5/24' }] },
  servidores: [
    { ip: '192.168.10.20', hostname: 'web01', distro: 'ubuntu', usuarios: [{ nombre: 'ana', sudo: true }] },
    { ip: '192.168.10.30', hostname: 'bastion', usuarios: [{ nombre: 'ana' }], red: { interfaces: [{ nombre: 'enp0s3', ip: '192.168.10.30/24' }, { nombre: 'enp0s8', ip: '10.0.5.1/24' }] } },
    { ip: '10.0.5.20', hostname: 'db01', usuarios: [{ nombre: 'ana' }] },
  ],
}

describe('ssh entre servidores', () => {
  it('entra con contraseña, guarda la clave del servidor y vuelve con exit', async () => {
    const { sh, run } = await session(red)
    const r = await run('ssh web01')
    expect(r.err).toContain("can't be established")
    expect(r.err).toContain("Permanently added 'web01'")
    expect(sh.sys.hostname).toBe('web01')
    expect((await run('hostname')).out).toBe('web01\n')
    expect((await run('exit')).out).toContain('Connection to web01 closed.')
    expect(sh.sys.hostname).toBe('admin01')
    expect((await run('ssh web01 hostname')).err).not.toContain('authenticity')
  })

  it('con clave: ssh-keygen, ssh-copy-id y después sin contraseña; verifica en el otro servidor', async () => {
    const { sh, run } = await session(red)
    await run('ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519')
    await run('ssh-copy-id -o StrictHostKeyChecking=accept-new web01')
    const r = await run('ssh -o PasswordAuthentication=no web01 whoami')
    expect(r.out).toBe('ana\n')
    expect(r.err).not.toContain('password')
    expect(verifyBash(sh, { en: 'web01', verificar: { archivo: '/home/ana/.ssh/authorized_keys', existe: true, modo: '0600' } }).ok).toBe(true)
  })

  it('la clave privada con permisos abiertos se ignora, y StrictModes rechaza un authorized_keys escribible', async () => {
    const { run } = await session(red)
    await run('ssh-keygen -N "" -f ~/.ssh/id_ed25519')
    await run('ssh-copy-id -o StrictHostKeyChecking=accept-new web01')
    await run('chmod 644 ~/.ssh/id_ed25519')
    expect((await run('ssh -o BatchMode=yes web01 true')).err).toContain('UNPROTECTED PRIVATE KEY FILE')
    await run('chmod 600 ~/.ssh/id_ed25519')
    await run('ssh web01 chmod 666 .ssh/authorized_keys')
    expect((await run('ssh -o BatchMode=yes web01 true')).err).toContain('Permission denied (publickey')
  })

  it('db01 solo se alcanza a través del bastión', async () => {
    const { sh, run } = await session(red)
    expect((await run('ssh db01')).err).toContain('Connection timed out')
    await run('ssh -o StrictHostKeyChecking=accept-new -J bastion db01')
    expect(sh.sys.hostname).toBe('db01')
  })

  it('clave de servidor cambiada: advertencia, y ssh-keygen -R la quita', async () => {
    const { run } = await session({ ...red, servidores: [{ ip: '192.168.10.20', hostname: 'web01', usuarios: [{ nombre: 'ana' }], clave_conocida: 'cambiada' }] })
    expect((await run('ssh web01')).err).toContain('REMOTE HOST IDENTIFICATION HAS CHANGED')
    expect((await run('ssh-keygen -R web01')).out).toContain('known_hosts updated')
  })

  it('firewall y sshd apagado dan errores distintos', async () => {
    const { run } = await session({ ...red, servidores: [{ ip: '192.168.10.20', hostname: 'web01', usuarios: [{ nombre: 'ana' }], servicios: { sshd: { activo: false } } }] })
    expect((await run('ssh web01')).err).toContain('Connection refused')
  })
})

describe('SELinux y nginx', () => {
  it('mv conserva la etiqueta, el puerto necesita semanage y restorecon arregla el 403', async () => {
    const { run } = await session({
      distro: 'rocky',
      usuario: 'root',
      usuarios: [{ nombre: 'ana' }],
      paquetes: { instalados: ['nginx', 'policycoreutils-python-utils'] },
      servicios: { nginx: { activo: true } },
      archivos: { '/home/ana/index.html': '<h1>Hola</h1>\n', '/etc/nginx/conf.d/sitio.conf': 'server {\n    listen 8090;\n    root /srv/sitio;\n}\n' },
    })
    await run('mkdir /srv/sitio && mv /home/ana/index.html /srv/sitio/')
    expect((await run('ls -Z /srv/sitio')).out).toContain('user_home_t')
    expect((await run('systemctl restart nginx')).code).not.toBe(0)
    expect((await run('ausearch -m avc')).out).toContain('name_bind')
    await run('semanage port -a -t http_port_t -p tcp 8090')
    await run('systemctl restart nginx')
    expect((await run('curl -s localhost:8090')).out).toContain('403')
    await run('semanage fcontext -a -t httpd_sys_content_t "/srv/sitio(/.*)?"')
    expect((await run('restorecon -Rv /srv/sitio')).out).toContain('httpd_sys_content_t')
    expect((await run('curl -s localhost:8090')).out).toContain('Hola')
  })

  it('sshd en otro puerto: sshd -t, SELinux y el firewall', async () => {
    const { run } = await session({ distro: 'rocky', usuario: 'root', paquetes: { instalados: ['policycoreutils-python-utils'] } })
    await run("echo 'Port 2222' > /etc/ssh/sshd_config.d/10-puerto.conf")
    expect((await run('sshd -t')).code).toBe(0)
    expect((await run('systemctl restart sshd')).code).not.toBe(0)
    await run('semanage port -a -t ssh_port_t -p tcp 2222')
    expect((await run('systemctl restart sshd')).code).toBe(0)
    expect((await run('ss -tln')).out).toContain(':2222')
  })
})
