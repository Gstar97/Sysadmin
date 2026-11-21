import { describe, expect, it } from 'vitest'
import { createBashSession, stripAnsi, verifyBash } from '@/engines/shell'
import type { BashStateInput } from '@/engines/shell/schema'

async function session(st: BashStateInput) {
  const sh = createBashSession(st)
  const run = async (cmd: string) => {
    const r = await sh.run(cmd)
    return { out: stripAnsi(r.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join('')), err: stripAnsi(r.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join('')), code: sh.lastExit }
  }
  return { sh, run }
}

const discos = ['sdb', 'sdc', 'sdd', 'sde'].map((n) => ({ nombre: n, tamano: '1T' }))
const nas: BashStateInput = { distro: 'ubuntu', hostname: 'nas01', usuario: 'root', red: { interfaces: [{ nombre: 'enp0s3', ip: '192.168.10.41/24', estado: 'UP' }], puerta_enlace: '192.168.10.1' }, usuarios: [{ nombre: 'root', clave_ssh: true }], paquetes: { instalados: ['zfsutils-linux'] }, discos }

describe('ZFS', () => {
  it('pool RAIDZ, datasets, propiedades, cuota e instantáneas con rollback', async () => {
    const { run, sh } = await session(nas)
    expect((await run('zpool create tank raidz sdb')).err).toContain('requires at least 2 devices')
    await run('zpool create tank raidz sdb sdc sdd')
    expect(verifyBash(sh, { zpool: 'tank', estado: 'ONLINE', tipo: 'raidz1' }).ok).toBe(true)
    expect((await run('zpool create otro sdb')).err).toContain("part of active pool 'tank'")
    await run('zfs create -o compression=lz4 tank/datos')
    await run('zfs set quota=100G tank/datos')
    expect((await run('zfs get -H -o value quota tank/datos')).out.trim()).toBe('100G')
    expect((await run('zfs list -o name,avail tank/datos')).out).toMatch(/tank\/datos\s+100G/)
    await run('echo hola > /tank/datos/a.txt')
    await run('zfs snapshot tank/datos@uno')
    await run('rm /tank/datos/a.txt')
    await run('zfs snapshot tank/datos@dos')
    expect((await run('zfs rollback tank/datos@uno')).err).toContain('more recent snapshots')
    await run('zfs rollback -r tank/datos@uno')
    expect((await run('cat /tank/datos/a.txt')).out).toBe('hola\n')
    expect(verifyBash(sh, { dataset: 'tank/datos', propiedad: { compression: 'lz4' }, instantanea: 'uno' }).ok).toBe(true)
    expect((await run('zfs destroy tank/datos')).err).toContain('has children')
  })
  it('send y receive a otro servidor por ssh, completo e incremental', async () => {
    const { run, sh } = await session({ ...nas, servidores: [{ hostname: 'nas02', ip: '192.168.10.42', clave_conocida: 'si', distro: 'ubuntu', usuarios: [{ nombre: 'root', clave_ssh: true }], paquetes: { instalados: ['zfsutils-linux'] }, discos, zfs: { pools: [{ nombre: 'backup', tipo: 'mirror', discos: ['sdb', 'sdc'] }] } }] })
    await run('zpool create tank mirror sdb sdc')
    await run('zfs create tank/docs')
    await run('echo v1 > /tank/docs/informe.txt')
    await run('zfs snapshot tank/docs@lunes')
    await run('zfs send tank/docs@lunes | ssh root@nas02 zfs receive backup/docs')
    expect(verifyBash(sh, { en: 'nas02', verificar: { dataset: 'backup/docs', instantanea: 'lunes' } }).ok).toBe(true)
    await run('echo v2 > /tank/docs/informe.txt')
    await run('zfs snapshot tank/docs@martes')
    expect((await run('zfs send -i lunes tank/docs@martes | ssh root@nas02 zfs receive backup/docs')).code).toBe(0)
    expect((await run('ssh root@nas02 cat /backup/docs/informe.txt')).out).toContain('v2')
    expect((await run('zfs send tank/docs@martes | ssh root@nas02 zfs receive backup/docs')).err).toContain('exists')
  })
  it('un disco fallado: DEGRADED, clear no lo arregla, replace con resilver', async () => {
    const { run, sh } = await session({ ...nas, zfs: { pools: [{ nombre: 'tank', tipo: 'raidz1', discos: ['sdb', 'sdc', 'sdd'], fallados: ['sdc'], datasets: [{ nombre: 'tank/vms', usado_gb: 600 }], ultimo_scrub_dias: 9 }] } })
    const st = (await run('zpool status tank')).out
    expect(st).toContain('state: DEGRADED')
    expect(st).toMatch(/sdc\s+FAULTED\s+47\s+212/)
    await run('zpool clear tank sdc')
    expect((await run('zpool status tank')).out).toContain('FAULTED')
    await run('zpool replace tank sdc sde')
    expect((await run('zpool status tank')).out).toContain('resilver in progress')
    await run('sleep 1h')
    expect(verifyBash(sh, { zpool: 'tank', estado: 'ONLINE', discos: ['sdb', 'sdd', 'sde'], resilver_hecho: true }).ok).toBe(true)
    await run('zpool scrub tank')
    await run('sleep 2h')
    expect(verifyBash(sh, { zpool: 'tank', scrub_hecho: true }).ok).toBe(true)
  })
})

const pveZfs = (n: number, cluster = 'lab') => ({
  hostname: `pve0${n}`,
  ip: `192.168.10.2${n}`,
  distro: 'ubuntu' as const,
  usuarios: [{ nombre: 'root', clave_ssh: true }],
  equipo: { cpus: 16, memoria_gb: 64, fisico: true },
  discos: [{ nombre: 'sdb', tamano: '1T' }, { nombre: 'sdc', tamano: '1T' }],
  bmc: { ip: `192.168.10.12${n}`, clave: 'Bmc-2026' },
  zfs: { pools: [{ nombre: 'tank', tipo: 'mirror' as const, discos: ['sdb', 'sdc'], datasets: [{ nombre: 'tank/vms' }] }] },
  proxmox: { repos: 'no-subscription' as const, cluster, almacenamientos: [{ id: 'local', tipo: 'dir' as const, contenido: ['iso', 'backup'], ruta: '/var/lib/vz' }, { id: 'local-zfs', tipo: 'zfspool' as const, contenido: ['images', 'rootdir'], ruta: 'tank/vms' }] },
})

describe('ZFS en Proxmox y pvesr', () => {
  it('replica la VM, migra usando la réplica y la HA la recupera en el nodo con réplica', async () => {
    const base = pveZfs(1)
    const st: BashStateInput = {
      ...base,
      usuario: 'root',
      paquetes: { instalados: ['ipmitool'] },
      red: { interfaces: [{ nombre: 'eno1', ip: '192.168.10.21/24', estado: 'UP' }], puerta_enlace: '192.168.10.1' },
      proxmox: { ...base.proxmox, vms: [{ id: 100, nombre: 'web01', estado: 'running', discos: { scsi0: 'local-zfs:vm-100-disk-0,size=32G' }, red: { net0: 'virtio,bridge=vmbr0' } }] },
      servidores: [pveZfs(2), pveZfs(3)],
    }
    delete (st as Record<string, unknown>).ip
    delete (st as Record<string, unknown>).hostname
    const { run, sh } = await session({ ...st, hostname: 'pve01' })
    expect((await run('zfs list -r tank')).out).toContain('tank/vms/vm-100-disk-0')
    expect((await run('qm migrate 100 pve02 --online')).err).toContain('with-local-disks')
    await run("pvesr create-local-job 100-0 pve02 --schedule '*/15'")
    expect(verifyBash(sh, { replica_pve: '100-0', destino: 'pve02', ok: true }).ok).toBe(true)
    expect((await run('pvesr status')).out).toMatch(/100-0\s+Yes\s+local\/pve02/)
    expect((await run('ssh root@pve02 zfs list -r tank')).out).toContain('vm-100-disk-0')
    const m = await run('qm migrate 100 pve02 --online')
    expect(m.out).toContain('replicated disk')
    expect(m.out).toContain('migration finished successfully')
    expect(verifyBash(sh, { pve_vm: 100, nodo: 'pve02', estado: 'running' }).ok).toBe(true)
    await run('ha-manager add vm:100')
    await run('ipmitool -I lanplus -H 192.168.10.122 -U admin -P Bmc-2026 chassis power off')
    await run('sleep 3m')
    // Vuelve en pve01, que tiene la réplica (pve03 no tiene el disco).
    expect(verifyBash(sh, { pve_ha: 'vm:100', nodo: 'pve01', estado: 'started' }).ok).toBe(true)
  })
})
