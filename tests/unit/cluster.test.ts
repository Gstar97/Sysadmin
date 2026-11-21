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

const nodo = (n: number, extra: Record<string, unknown> = {}) => ({
  hostname: `pve0${n}`,
  ip: `192.168.10.2${n}`,
  distro: 'ubuntu' as const,
  usuarios: [{ nombre: 'root', clave_ssh: true }],
  equipo: { cpus: 16, memoria_gb: 64, fisico: true },
  bmc: { ip: `192.168.10.12${n}`, clave: 'Bmc-2026' },
  ...extra,
})

const almacenamientos = [
  { id: 'local', tipo: 'dir' as const, contenido: ['iso', 'vztmpl', 'backup'], ruta: '/var/lib/vz' },
  { id: 'local-lvm', tipo: 'lvmthin' as const, contenido: ['images', 'rootdir'] },
  { id: 'nfs-vms', tipo: 'nfs' as const, contenido: ['images'], servidor: '192.168.10.50', export: '/srv/vms', compartido: true },
]

const base: BashStateInput = {
  distro: 'ubuntu',
  hostname: 'pve01',
  usuario: 'root',
  usuarios: [{ nombre: 'root', clave_ssh: true }],
  paquetes: { instalados: ['ipmitool'] },
  equipo: { cpus: 16, memoria_gb: 64, fisico: true },
  red: { interfaces: [{ nombre: 'eno1', ip: '192.168.10.21/24', estado: 'UP' }], puerta_enlace: '192.168.10.1' },
  proxmox: {
    repos: 'no-subscription',
    almacenamientos,
    vms: [
      { id: 100, nombre: 'web01', estado: 'running', discos: { scsi0: 'nfs-vms:100/vm-100-disk-0.qcow2,size=20G' }, red: { net0: 'virtio,bridge=vmbr0' } },
      { id: 101, nombre: 'db01', estado: 'running', discos: { scsi0: 'local-lvm:vm-101-disk-0,size=40G' }, red: { net0: 'virtio,bridge=vmbr0' } },
    ],
  },
  servidores: [nodo(2, { proxmox: { repos: 'no-subscription' } }), nodo(3, { proxmox: { repos: 'no-subscription' } })],
}

const armado = (n: number, extra: Record<string, unknown> = {}): BashStateInput => ({
  ...base,
  proxmox: { ...base.proxmox!, cluster: 'lab', ...extra },
  servidores: Array.from({ length: n - 1 }, (_, i) => nodo(i + 2, { proxmox: { repos: 'no-subscription', almacenamientos, cluster: 'lab' } })),
})

describe('Clúster de Proxmox', () => {
  it('se crea, se unen dos nodos por ssh y comparten los almacenamientos', async () => {
    const { run, sh } = await session(base)
    expect((await run('pvecm status')).err).toContain('is this node part of a cluster')
    expect((await run('pvecm create lab')).out).toContain('Writing corosync config')
    expect((await run('ssh root@pve02 pvecm add 192.168.10.21')).out).toContain("successfully added node 'pve02' to cluster.")
    await run('ssh root@pve03 pvecm add pve01')
    const st = (await run('pvecm status')).out
    expect(st).toMatch(/Expected votes:\s+3/)
    expect(st).toMatch(/Quorate:\s+Yes/)
    expect((await run('pvecm nodes')).out).toMatch(/3\s+1 pve03/)
    expect((await run('ssh root@pve02 pvesm status')).out).toContain('nfs-vms')
    expect((await run('ssh root@pve03 cat /etc/pve/corosync.conf')).out).toContain('ring0_addr: 192.168.10.23')
    expect(verifyBash(sh, { pve_cluster: 'lab', nodos: 3, quorum: true }).ok).toBe(true)
    expect(verifyBash(sh, { en: 'pve02', verificar: { pve_cluster: 'lab', nodos: 3 } }).ok).toBe(true)
  })
  it('no se une un nodo que ya tiene invitados, y los ID son únicos en el clúster', async () => {
    const { run } = await session({ ...base, servidores: [nodo(2, { proxmox: { repos: 'no-subscription', vms: [{ id: 200, nombre: 'x' }] } })] })
    await run('pvecm create lab')
    expect((await run('ssh root@pve02 pvecm add 192.168.10.21')).err).toContain('this host already contains virtual guests')
    const { run: run2 } = await session(armado(2))
    expect((await run2('ssh root@pve02 qm create 100 --name repetida')).err).toContain('config file already exists')
  })
  it('migración en vivo con almacenamiento compartido y los errores de discos locales', async () => {
    const { run, sh } = await session(armado(3, { isos: ['debian-13.iso'] }))
    expect((await run('qm migrate 100 pve02')).err).toContain("can't migrate running VM without --online")
    const m = await run('qm migrate 100 pve02 --online')
    expect(m.out).toContain('migration finished successfully')
    expect(verifyBash(sh, { pve_vm: 100, nodo: 'pve02', estado: 'running' }).ok).toBe(true)
    expect((await run('qm migrate 101 pve02 --online')).err).toContain('with-local-disks')
    await run('qm set 101 --ide2 local:iso/debian-13.iso,media=cdrom')
    expect((await run('qm migrate 101 pve02 --online --with-local-disks')).err).toContain('local cdrom image')
    await run('qm set 101 --ide2 none,media=cdrom')
    expect((await run('qm migrate 101 pve02 --online --with-local-disks')).out).toContain('drive mirror is starting')
    expect((await run('ssh root@pve02 qm list')).out).toMatch(/101 db01\s+running/)
    expect((await run('qm migrate 999 pve02')).err).toContain('does not exist')
  })
  it('alta disponibilidad: el nodo se cae, se cerca y la VM vuelve a arrancar en otro', async () => {
    const { run, sh } = await session(armado(3))
    await run('qm migrate 100 pve03 --online')
    await run('ha-manager add vm:100')
    await run('ha-manager rules add node-affinity prefer-pve03 --resources vm:100 --nodes pve03:2,pve02:1')
    expect((await run('ha-manager status')).out).toContain('service vm:100 (pve03, started)')
    await run('ipmitool -I lanplus -H 192.168.10.123 -U admin -P Bmc-2026 chassis power off')
    expect(verifyBash(sh, { pve_encendido: 'pve03', encendido: false }).ok).toBe(true)
    let st = (await run('ha-manager status')).out
    expect(st).toContain('lrm pve03 (old timestamp - dead?')
    expect(st).toContain('service vm:100 (pve03, fence)')
    expect(verifyBash(sh, { pve_cluster: 'lab', en_linea: 2, quorum: true }).ok).toBe(true)
    await run('sleep 2m')
    st = (await run('ha-manager status')).out
    expect(st).toContain('service vm:100 (pve02, started)')
    expect(verifyBash(sh, { pve_ha: 'vm:100', nodo: 'pve02', estado: 'started' }).ok).toBe(true)
    // db01 tiene el disco en local-lvm: si estuviera bajo HA en el nodo caído, no se podría recuperar.
    await run('ipmitool -I lanplus -H 192.168.10.123 -U admin -P Bmc-2026 chassis power on')
    expect((await run('ha-manager status')).out).toContain('service vm:100 (pve03, started)')
  })
  it('una VM con disco local bajo HA queda en error si su nodo se cae', async () => {
    const { run } = await session(armado(3))
    await run('qm migrate 101 pve03 --online --with-local-disks')
    await run('ha-manager add vm:101')
    await run('ipmitool -I lanplus -H 192.168.10.123 -U admin -P Bmc-2026 chassis power off')
    await run('sleep 150')
    expect((await run('ha-manager status')).out).toContain('service vm:101 (pve03, error)')
  })
  it('dos nodos sin dispositivo de quórum: el que queda no puede hacer nada', async () => {
    const { run, sh } = await session(armado(2))
    await run('ha-manager add vm:100')
    await run('ipmitool -I lanplus -H 192.168.10.122 -U admin -P Bmc-2026 chassis power off')
    const st = (await run('pvecm status')).out
    expect(st).toMatch(/Quorate:\s+No/)
    expect(st).toContain('Activity blocked')
    expect((await run('qm start 101')).err).toContain('cluster not ready - no quorum?')
    expect((await run('ha-manager add vm:101')).err).toContain('no quorum')
    // Con recursos de HA activos y sin quórum, el watchdog reinicia el nodo al minuto.
    await run('sleep 70')
    expect(verifyBash(sh, { pve_vm: 100, estado: 'stopped' }).ok).toBe(true)
    // Votos esperados a 1: vuelve el quórum y la HA lo arranca.
    await run('pvecm expected 1')
    expect(verifyBash(sh, { pve_cluster: 'lab', quorum: true, votos_esperados: 1 }).ok).toBe(true)
    expect(verifyBash(sh, { pve_vm: 100, estado: 'running' }).ok).toBe(true)
  })
  it('dispositivo de quórum en un clúster de dos nodos', async () => {
    const qnetd = { hostname: 'qdev01', ip: '192.168.10.40', distro: 'ubuntu' as const, usuarios: [{ nombre: 'root', clave_ssh: true }], paquetes: { instalados: ['corosync-qnetd'] } }
    const st = armado(2)
    const { run, sh } = await session({ ...st, paquetes: { instalados: ['ipmitool', 'corosync-qdevice'] }, servidores: [nodo(2, { proxmox: { repos: 'no-subscription', almacenamientos, cluster: 'lab' } }), qnetd] })
    expect((await run('pvecm qdevice setup 192.168.10.40')).err).toContain('corosync-qdevice')
    await run('ssh root@pve02 apt-get install -y corosync-qdevice')
    expect((await run('pvecm qdevice setup 192.168.10.40')).out).toContain('Reloading corosync.conf')
    expect((await run('pvecm status')).out).toMatch(/Expected votes:\s+3/)
    await run('ipmitool -I lanplus -H 192.168.10.122 -U admin -P Bmc-2026 chassis power off')
    expect(verifyBash(sh, { pve_cluster: 'lab', quorum: true, qdevice: true, en_linea: 1 }).ok).toBe(true)
    expect((await run('qm stop 101')).code).toBe(0)
    expect((await run('qm start 101')).code).toBe(0)
  })
  it('modo mantenimiento: las VM bajo HA se van del nodo', async () => {
    const { run, sh } = await session(armado(3))
    await run('ha-manager add vm:100')
    await run('ha-manager crm-command node-maintenance enable pve01')
    expect(verifyBash(sh, { pve_mantenimiento: 'pve01' }).ok).toBe(true)
    expect((await run('ha-manager status')).out).toContain('lrm pve01 (maintenance mode')
    expect(verifyBash(sh, { pve_vm: 100, nodo: 'pve01' }).ok).toBe(false)
    await run('ha-manager crm-command node-maintenance disable pve01')
  })
  it('poweroff adentro de un nodo corta la sesión y lo apaga', async () => {
    const { run, sh } = await session(armado(3))
    await run('ssh root@pve03')
    const r = await run('poweroff')
    expect(r.out).toContain('Connection to pve03 closed by remote host.')
    expect(sh.sys.hostname).toBe('pve01')
    expect(verifyBash(sh, { pve_cluster: 'lab', en_linea: 2 }).ok).toBe(true)
    expect((await run('ssh root@pve03 uptime')).err).toMatch(/No route to host|timed out/)
  })
})

describe('qm disk move', () => {
  it('pasa un disco local a un almacenamiento compartido con la VM andando, y después se puede poner bajo HA', async () => {
    const { run, sh } = await session(armado(3))
    const r = await run('qm disk move 101 scsi0 nfs-vms --delete 1')
    expect(r.out).toContain('drive mirror is starting')
    expect(verifyBash(sh, { pve_vm: 101, config: { scsi0: 'nfs-vms:101/vm-101-disk-0.qcow2' } }).ok).toBe(true)
    expect((await run('qm migrate 101 pve02 --online')).out).toContain('migration finished successfully')
    expect((await run('qm disk move 101 scsi0 nfs-vms')).err).toBeTruthy()
  })
})
