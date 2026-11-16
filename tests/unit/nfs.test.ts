import { describe, expect, it } from 'vitest'
import { createBashSession, stripAnsi, verifyBash } from '@/engines/shell'
import { parseExports } from '@/engines/shell/nfs'
import type { BashStateInput } from '@/engines/shell/schema'

const state: BashStateInput = {
  distro: 'rocky',
  hostname: 'web01',
  usuario: 'ana',
  usuarios: [{ nombre: 'ana', sudo: true, uid: 1001, clave_ssh: true }],
  paquetes: { instalados: ['nfs-utils'] },
  red: { interfaces: [{ nombre: 'enp0s3', ip: '192.168.10.11/24', estado: 'UP' }] },
  servidores: [
    {
      hostname: 'files01',
      ip: '192.168.10.30',
      distro: 'rocky',
      clave_conocida: 'si',
      usuarios: [{ nombre: 'ana', sudo: true, uid: 1001, clave_ssh: true }],
      paquetes: { instalados: ['nfs-utils', 'firewalld'] },
      servicios: { firewalld: { activo: true, habilitado: true } },
      archivos: { '/srv/compartido/leeme.txt': 'hola\n' },
    },
  ],
}

async function session(st: BashStateInput) {
  const sh = createBashSession(st)
  const run = async (cmd: string) => {
    const r = await sh.run(cmd)
    return { out: stripAnsi(r.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join('')), err: stripAnsi(r.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join('')) }
  }
  return { sh, run }
}

describe('NFS', () => {
  it('un espacio antes del paréntesis exporta a todo el mundo', () => {
    const r = parseExports('/srv/a 192.168.10.0/24 (rw,sync)\n/srv/b 10.0.0.1(rww)\n')
    expect(r.exports.map((e) => [e.client, e.opts.rw])).toEqual([['192.168.10.0/24', false], ['*', true]])
    expect(r.errors[0].message).toContain('unknown keyword "rww"')
    expect(r.warnings.join('\n')).toContain('No host name given with /srv/a (rw,sync)')
  })

  it('exportar, abrir el firewall, montar y root_squash', async () => {
    const { sh, run } = await session(state)
    expect((await run('sudo mount -t nfs files01:/srv/compartido /mnt')).err).toContain('mount.nfs: No route to host')
    await run('ssh files01')
    await run("echo '/srv/compartido 192.168.10.0/24(rw,sync)' | sudo tee /etc/exports")
    await run('sudo systemctl enable --now nfs-server')
    await run('sudo firewall-cmd --permanent --add-service=nfs && sudo firewall-cmd --reload')
    expect((await run('sudo exportfs -v')).out).toContain('192.168.10.0/24(sync,wdelay,hide,no_subtree_check,sec=sys,rw,secure,root_squash,no_all_squash)')
    expect(verifyBash(sh, { en: 'files01', verificar: { exportado: '/srv/compartido', cliente: '192.168.10.0/24', opciones_incluye: 'rw,root_squash', existe: true } }).ok).toBe(true)
    await run('sudo chmod 1777 /srv/compartido')
    await run('exit')
    expect((await run('showmount -e files01')).err).toContain('Port mapper failure')
    expect((await run('sudo mount -t nfs files01:/srv/compartido /mnt')).err).toBe('')
    expect((await run('mount')).out).toMatch(/files01:\/srv\/compartido on \/mnt type nfs4 \(rw,relatime,vers=4\.2/)
    expect((await run('cat /mnt/leeme.txt')).out).toBe('hola\n')
    await run('sudo touch /mnt/de-root')
    await run('touch /mnt/de-ana')
    const ls = (await run('ssh files01 ls -l /srv/compartido')).out
    expect(ls).toMatch(/nobody\s+nobody\s+0 .* de-root/)
    expect(ls).toMatch(/ana\s+ana\s+0 .* de-ana/)
    expect(verifyBash(sh, { montaje: '/mnt', montado: true, dispositivo: 'files01:/srv/compartido', tipo: 'nfs4' }).ok).toBe(true)
    await run('sudo umount /mnt')
    expect((await run('ls /mnt')).out).toBe('')
  })

  it('el cliente que no está en /etc/exports recibe access denied; exportfs -r aplica los cambios', async () => {
    const st = structuredClone(state)
    st.servidores![0].servicios = { 'nfs-server': { activo: true, habilitado: true } }
    st.servidores![0].servicios_firewall = ['nfs']
    st.servidores![0].archivos!['/etc/exports'] = '/srv/compartido 192.168.20.0/24(rw)\n'
    const { run } = await session(st)
    expect((await run('sudo mount files01:/srv/compartido /mnt')).err).toContain('access denied by server while mounting files01:/srv/compartido')
    await run("ssh files01 \"echo '/srv/compartido 192.168.10.11(ro)' | sudo tee /etc/exports\"")
    expect((await run('sudo mount files01:/srv/compartido /mnt')).err).toContain('access denied')
    await run('ssh files01 sudo exportfs -ra')
    expect((await run('sudo mount files01:/srv/compartido /mnt')).err).toBe('')
    expect((await run('sudo touch /mnt/x')).err).toContain('Read-only file system')
  })

  it('automount de systemd y autofs montan al entrar', async () => {
    const st = structuredClone(state)
    st.paquetes = { instalados: ['nfs-utils', 'autofs'] }
    st.servidores![0].servicios = { 'nfs-server': { activo: true, habilitado: true } }
    st.servidores![0].paquetes = { instalados: ['nfs-utils'] }
    st.servidores![0].servicios_firewall = ['nfs']
    st.servidores![0].archivos!['/etc/exports'] = '/srv/compartido 192.168.10.0/24(rw)\n'
    const { run } = await session(st)
    await run('sudo mkdir /mnt/compartido')
    await run("echo 'files01:/srv/compartido /mnt/compartido nfs _netdev,x-systemd.automount 0 0' | sudo tee -a /etc/fstab")
    await run('sudo systemctl daemon-reload && sudo systemctl restart remote-fs.target')
    expect((await run('mount')).out).toContain('systemd-1 on /mnt/compartido type autofs')
    expect((await run('cat /mnt/compartido/leeme.txt')).out).toBe('hola\n')
    expect((await run('mount')).out).toContain('files01:/srv/compartido on /mnt/compartido type nfs4')
    await run("echo '/datos /etc/auto.datos' | sudo tee /etc/auto.master.d/datos.autofs")
    await run("echo 'comp -rw files01:/srv/compartido' | sudo tee /etc/auto.datos")
    await run('sudo systemctl enable --now autofs')
    expect((await run('ls /datos')).out).toBe('')
    expect((await run('cat /datos/comp/leeme.txt')).out).toBe('hola\n')
  })
})

describe('Editor de /etc/exports', () => {
  it('marca el espacio antes de las opciones y las opciones mal escritas', async () => {
    const { validateExports } = await import('@/engines/config/exports')
    const d = validateExports('/srv/a 192.168.10.0/24 (rw)\n/srv/b 10.0.0.1(rw,no_root_sqush)\n/srv/c 10.0.0.2(rw,sync)\n').diagnostics
    expect(d.filter((x) => x.severity === 'error').map((x) => x.line).sort()).toEqual([1, 2])
    expect(d.find((x) => x.line === 1)?.message).toContain('son dos clientes distintos')
  })
})
