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

const discos = [{ nombre: 'sdb', tamano: '1T' }, { nombre: 'sdc', tamano: '1T' }]
const nodo = (n: number, extra: Record<string, unknown> = {}) => ({
  hostname: `pve0${n}`,
  ip: `192.168.10.2${n}`,
  clave_conocida: 'si' as const,
  distro: 'ubuntu' as const,
  usuarios: [{ nombre: 'root', clave_ssh: true }],
  equipo: { cpus: 16, memoria_gb: 64, fisico: true },
  discos,
  bmc: { ip: `192.168.10.12${n}`, clave: 'Bmc-2026' },
  proxmox: { repos: 'no-subscription' as const, cluster: 'lab', ...extra },
})
const base = (ceph?: Record<string, unknown>): BashStateInput => ({
  distro: 'ubuntu',
  hostname: 'pve01',
  usuario: 'root',
  usuarios: [{ nombre: 'root', clave_ssh: true }],
  paquetes: { instalados: ['ipmitool'] },
  equipo: { cpus: 16, memoria_gb: 64, fisico: true },
  red: { interfaces: [{ nombre: 'eno1', ip: '192.168.10.21/24', estado: 'UP' }], puerta_enlace: '192.168.10.1' },
  discos,
  proxmox: { repos: 'no-subscription', cluster: 'lab', ...(ceph ? { ceph } : {}) },
  servidores: [nodo(2), nodo(3)],
})

describe('Ceph', () => {
  it('se instala, se inicia, monitores en los tres nodos, OSD y un pool con su almacenamiento', async () => {
    const { run, sh } = await session(base())
    expect((await run('pveceph install')).err).toContain('401')
    for (const n of ['', 'ssh root@pve02 ', 'ssh root@pve03 ']) await run(`${n}pveceph install --repository no-subscription`)
    expect((await run('pveceph mon create')).err).toContain('not initialized')
    await run('pveceph init --network 10.10.20.0/24')
    for (const n of ['', 'ssh root@pve02 ', 'ssh root@pve03 ']) {
      await run(`${n}pveceph mon create`)
      await run(`${n}pveceph osd create /dev/sdb`)
      await run(`${n}pveceph osd create /dev/sdc`)
    }
    expect((await run('pveceph osd create /dev/sdb')).err).toContain('already in use')
    expect((await run('ceph osd tree')).out).toMatch(/osd\.5\s+up/)
    await run('pveceph pool create vms --add_storages')
    expect(verifyBash(sh, { ceph: 'HEALTH_OK', mons: 3, osds: 6, pool: 'vms', size: 3, min_size: 2 }).ok).toBe(true)
    expect(verifyBash(sh, { pve_almacenamiento: 'vms', tipo: 'rbd' }).ok).toBe(true)
    expect((await run('ceph -s')).out).toContain('HEALTH_OK')
    expect((await run('lsblk')).out).toContain('ceph--')
  })
  it('se cae un nodo: degradado; a los 10 minutos los OSD pasan a out; con dos nodos caídos, I/O bloqueado', async () => {
    const { run, sh } = await session(base({ osds: [1, 2, 3].flatMap((n) => [{ nodo: `pve0${n}`, disco: 'sdb' }, { nodo: `pve0${n}`, disco: 'sdc' }]), pools: [{ nombre: 'vms', usado_gb: 400 }] }))
    expect(verifyBash(sh, { ceph: 'HEALTH_OK', osds_up: 6 }).ok).toBe(true)
    await run('ipmitool -I lanplus -H 192.168.10.123 -U admin -P Bmc-2026 chassis power off')
    const s = (await run('ceph -s')).out
    expect(s).toContain('HEALTH_WARN')
    expect(s).toContain('2 osds down')
    expect(s).toContain('1 host (2 osds) down')
    expect(s).toContain('Degraded data redundancy')
    expect((await run('ceph osd tree')).out).toMatch(/osd\.4\s+down\s+1\.00000/)
    await run('sleep 11m')
    expect((await run('ceph osd tree')).out).toMatch(/osd\.4\s+down\s+0/)
    // Con 3 copias y 2 hosts no se puede reconstruir: sigue degradado.
    expect((await run('ceph health')).out).toContain('Degraded data redundancy')
    await run('ipmitool -I lanplus -H 192.168.10.122 -U admin -P Bmc-2026 chassis power off')
    expect((await run('ceph -s')).err).toContain('authenticate timed out')
  })
  it('noout para un mantenimiento: los OSD no pasan a out', async () => {
    const { run, sh } = await session(base({ osds: [1, 2, 3].map((n) => ({ nodo: `pve0${n}`, disco: 'sdb' })), pools: [{ nombre: 'vms', usado_gb: 100 }] }))
    await run('ceph osd set noout')
    await run('ipmitool -I lanplus -H 192.168.10.123 -U admin -P Bmc-2026 chassis power off')
    await run('sleep 30m')
    expect((await run('ceph osd tree')).out).toMatch(/osd\.2\s+down\s+1\.00000/)
    expect(verifyBash(sh, { ceph: 'HEALTH_WARN', flag: 'noout' }).ok).toBe(true)
    await run('ipmitool -I lanplus -H 192.168.10.123 -U admin -P Bmc-2026 chassis power on')
    await run('ceph osd unset noout')
    expect(verifyBash(sh, { ceph: 'HEALTH_OK' }).ok).toBe(true)
  })
})
