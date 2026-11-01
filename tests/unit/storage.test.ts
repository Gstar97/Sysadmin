import { describe, expect, it } from 'vitest'
import { createBashSession, stripAnsi, verifyBash } from '@/engines/shell'
import type { BashStateInput } from '@/engines/shell/schema'

async function session(state: BashStateInput = {}) {
  const sh = createBashSession({ usuario: 'root', ...state })
  const run = async (cmd: string) => {
    const r = await sh.run(cmd)
    return { out: stripAnsi(r.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join('')), err: stripAnsi(r.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join('')), code: sh.lastExit }
  }
  return { sh, run }
}

describe('discos y sistemas de archivos', () => {
  it('el disco del sistema queda como lo deja el instalador', async () => {
    const { run } = await session({ discos: [{ nombre: 'sdb', tamano: '10G' }] })
    const l = (await run('lsblk')).out
    expect(l).toMatch(/├─sda1\s+8:1\s+0\s+1G\s+0 part \/boot/)
    expect(l).toMatch(/rl-root\s+253:0\s+0\s+17G/)
    expect(l).toMatch(/sdb\s+8:16\s+0\s+10G\s+0 disk/)
    expect((await run('sudo fdisk -l /dev/sda')).out).toContain('Disklabel type: dos')
    expect((await run('df -hT /')).out).toMatch(/\/dev\/mapper\/rl-root\s+xfs\s+17G/)
    expect((await run('swapon --show')).out).toContain('partition')
  })

  it('particionar, formatear, montar y persistir en fstab', async () => {
    const { sh, run } = await session({ discos: [{ nombre: 'sdb', tamano: '10G' }] })
    await run('parted -s /dev/sdb mklabel gpt mkpart datos xfs 1MiB 100%')
    expect((await run('lsblk /dev/sdb')).out).toMatch(/└─sdb1\s+8:17\s+0\s+10G/)
    await run('mkfs.xfs /dev/sdb1')
    expect((await run('mkfs.xfs /dev/sdb1')).err).toContain('appears to contain an existing filesystem (xfs)')
    await run('mkdir /datos && mount /dev/sdb1 /datos && echo hola > /datos/a.txt')
    expect(verifyBash(sh, { montaje: '/datos', montado: true, tipo: 'xfs' }).ok).toBe(true)
    await run('umount /datos')
    expect((await run('ls /datos')).out).toBe('')
    await run('echo "UUID=$(blkid -s UUID -o value /dev/sdb1) /datos xfs defaults 0 0" >> /etc/fstab')
    expect((await run('findmnt --verify')).out).toContain('Success, no errors')
    const m = await run('mount -a')
    expect(m.err).toContain("systemctl daemon-reload")
    expect((await run('cat /datos/a.txt')).out).toBe('hola\n')
    expect(verifyBash(sh, { fstab: '/datos', existe: true, por_uuid: true, tipo: 'xfs' }).ok).toBe(true)
    await run('cd /datos')
    expect((await run('umount /datos')).err).toContain('target is busy')
  })

  it('findmnt --verify encuentra los errores de fstab', async () => {
    const { run } = await session()
    await run("echo 'UUID=0000-1111 /nada xfs defaults 0 0' >> /etc/fstab")
    const v = (await run('findmnt --verify')).out
    expect(v).toContain('[E] target does not exist')
    expect(v).toContain('[E] unreachable source: UUID=0000-1111')
    expect((await run('mount -a')).err).toContain("can't find UUID=0000-1111")
  })

  it('LVM: crear, extender en caliente y agregar un disco', async () => {
    const { sh, run } = await session({ discos: [{ nombre: 'sdb', tamano: '10G' }, { nombre: 'sdc', tamano: '5G' }] })
    await run('vgcreate datos /dev/sdb')
    expect((await run('pvs')).out).toMatch(/\/dev\/sdb\s+datos\s+lvm2 a--\s+<10\.00g/)
    await run('lvcreate -n srv -L 4G datos && mkfs.xfs /dev/datos/srv && mkdir -p /srv/datos && mount /dev/datos/srv /srv/datos')
    await run('lvextend -L +2G datos/srv')
    expect((await run('df -h /srv/datos')).out).toMatch(/4\.0G/)
    await run('xfs_growfs /srv/datos')
    expect((await run('df -h /srv/datos')).out).toMatch(/6\.0G/)
    await run('vgextend datos /dev/sdc && lvextend -r -l +100%FREE datos/srv')
    expect(verifyBash(sh, { montaje: '/srv/datos', montado: true, tamano_min: '14G' }).ok).toBe(true)
    expect((await run('lvreduce -L 2G datos/srv')).err).toContain('not supported (xfs)')
    expect(verifyBash(sh, { grupo_volumenes: 'datos', existe: true, discos: ['sdb', 'sdc'] }).ok).toBe(true)
  })

  it('un archivo borrado que sigue abierto ocupa espacio hasta que el proceso termina', async () => {
    const { run } = await session({
      discos: [{ nombre: 'sdb', tamano: '5G' }],
      volumenes: [{ vg: 'datos', discos: ['sdb'], lvs: [{ nombre: 'logs', tamano: '4G', fs: 'xfs', montaje: '/var/log/app' }] }],
      usuarios: [{ nombre: 'app' }],
      archivos: { '/var/log/app/app.log': { contenido: 'x\n', tamano: '3.5G', dueno: 'app' } },
      procesos: [{ usuario: 'app', comando: '/opt/app/bin/app', abiertos: ['/var/log/app/app.log'] }],
    })
    await run('rm /var/log/app/app.log')
    expect((await run('df -h /var/log/app')).out).toMatch(/9\d%/)
    expect((await run('lsof +L1')).out).toContain('/var/log/app/app.log (deleted)')
    await run('pkill -f /opt/app')
    expect((await run('df -h /var/log/app')).out).toMatch(/\s[0-9]%/)
  })

  it('swap en un archivo', async () => {
    const { sh, run } = await session()
    await run('fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile')
    expect(verifyBash(sh, { swap: '/swapfile', activa: true }).ok).toBe(true)
    expect((await run('free -h')).out).toMatch(/Swap:\s+3\.0Gi/)
  })
})
