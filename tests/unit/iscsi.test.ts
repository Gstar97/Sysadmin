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

const IQN = 'iqn.2026-11.lan.empresa:san01'
const st: BashStateInput = {
  distro: 'ubuntu',
  hostname: 'san01',
  usuario: 'root',
  usuarios: [{ nombre: 'root', clave_ssh: true }],
  paquetes: { instalados: ['targetcli-fb'] },
  red: { interfaces: [{ nombre: 'enp0s3', ip: '192.168.10.60/24', estado: 'UP' }], puerta_enlace: '192.168.10.1' },
  discos: [{ nombre: 'sdb', tamano: '500G' }],
  servidores: [
    { hostname: 'pve01', ip: '192.168.10.21', clave_conocida: 'si', distro: 'ubuntu', usuarios: [{ nombre: 'root', clave_ssh: true }], equipo: { cpus: 16, memoria_gb: 64, fisico: true }, proxmox: { repos: 'no-subscription' } },
    { hostname: 'web01', ip: '192.168.10.30', clave_conocida: 'si', distro: 'rocky', usuarios: [{ nombre: 'root', clave_ssh: true }], paquetes: { instalados: ['iscsi-initiator-utils'] } },
  ],
}

describe('iSCSI', () => {
  it('destino con LUN y ACL; el iniciador ve el disco nuevo', async () => {
    const { run, sh } = await session(st)
    await run('targetcli /backstores/block create name=lun0 dev=/dev/sdb')
    await run(`targetcli /iscsi create ${IQN}`)
    await run(`targetcli /iscsi/${IQN}/tpg1/luns create /backstores/block/lun0`)
    const iqnWeb = (await run('ssh root@web01 cat /etc/iscsi/initiatorname.iscsi')).out.match(/InitiatorName=(\S+)/)![1]
    expect(iqnWeb).toMatch(/^iqn\.1994-05\.com\.redhat:/)
    await run('ssh root@web01 iscsiadm -m discovery -t sendtargets -p 192.168.10.60')
    expect((await run(`ssh root@web01 iscsiadm -m node -T ${IQN} --login`)).err).toContain('authorization failure')
    await run(`targetcli /iscsi/${IQN}/tpg1/acls create ${iqnWeb}`)
    expect((await run(`ssh root@web01 iscsiadm -m node -T ${IQN} --login`)).out).toContain('successful')
    expect((await run('ssh root@web01 lsblk')).out).toMatch(/sdb\s+8:16\s+0\s+500G\s+0 disk/)
    expect(verifyBash(sh, { en: 'web01', verificar: { iscsi_sesion: IQN, discos: 1 } }).ok).toBe(true)
    expect(verifyBash(sh, { iscsi_destino: IQN, luns: 1, permite: iqnWeb }).ok).toBe(true)
  })
  it('sin saveconfig, la configuración se pierde al reiniciar el servidor', async () => {
    const { run } = await session({
      distro: 'ubuntu',
      hostname: 'admin01',
      usuario: 'root',
      usuarios: [{ nombre: 'root', clave_ssh: true }],
      red: { interfaces: [{ nombre: 'enp0s3', ip: '192.168.10.5/24', estado: 'UP' }], puerta_enlace: '192.168.10.1' },
      servidores: [{ hostname: 'san01', ip: '192.168.10.60', clave_conocida: 'si', distro: 'ubuntu', usuarios: [{ nombre: 'root', clave_ssh: true }], paquetes: { instalados: ['targetcli-fb'] }, discos: [{ nombre: 'sdb', tamano: '500G' }] }],
    })
    await run('ssh root@san01 targetcli /iscsi create iqn.2026-11.lan.empresa:prueba')
    await run('ssh root@san01 reboot')
    expect((await run('ssh root@san01 targetcli ls')).out).toContain('[Targets: 0]')
    await run('ssh root@san01 targetcli /iscsi create iqn.2026-11.lan.empresa:prueba')
    await run('ssh root@san01 targetcli saveconfig')
    await run('ssh root@san01 reboot')
    expect((await run('ssh root@san01 targetcli ls')).out).toContain('[Targets: 1]')
  })
  it('Proxmox: almacenamiento iSCSI y LVM compartido encima', async () => {
    const { run, sh } = await session(st)
    await run('targetcli /backstores/block create name=lun0 dev=/dev/sdb')
    await run(`targetcli /iscsi create ${IQN}`)
    await run(`targetcli /iscsi/${IQN}/tpg1/luns create /backstores/block/lun0`)
    const iqnPve = (await run('ssh root@pve01 cat /etc/iscsi/initiatorname.iscsi')).out.match(/InitiatorName=(\S+)/)![1]
    expect((await run(`ssh root@pve01 pvesm add iscsi san01 --portal 192.168.10.60 --target ${IQN} --content none`)).err).toContain('authorization failure')
    await run(`targetcli /iscsi/${IQN}/tpg1/acls create ${iqnPve}`)
    expect((await run(`ssh root@pve01 pvesm add iscsi san01 --portal 192.168.10.60 --target ${IQN} --content none`)).code).toBe(0)
    expect((await run('ssh root@pve01 pvesm add lvm san-lvm --vgname vg_san --shared 1')).err).toContain("volume group 'vg_san' not found")
    await run('ssh root@pve01 pvcreate /dev/sdb')
    await run('ssh root@pve01 vgcreate vg_san /dev/sdb')
    expect((await run('ssh root@pve01 pvesm add lvm san-lvm --vgname vg_san --shared 1 --content images')).code).toBe(0)
    expect(verifyBash(sh, { en: 'pve01', verificar: { pve_almacenamiento: 'san-lvm', tipo: 'lvm' } }).ok).toBe(true)
  })
})
