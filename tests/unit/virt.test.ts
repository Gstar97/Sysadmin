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

const kvm: BashStateInput = {
  distro: 'ubuntu',
  hostname: 'kvm01',
  usuario: 'ana',
  usuarios: [{ nombre: 'ana', sudo: true }],
  equipo: { cpus: 8, memoria_gb: 32, vmx: true },
  paquetes: { instalados: ['qemu-kvm', 'libvirt-daemon-system', 'virtinst'] },
  imagenes_disco: [{ ruta: '/var/lib/libvirt/images/noble.img', formato: 'qcow2', virtual_gb: 3.5, disco_gb: 0.6 }],
  archivos: { '/home/ana/user-data': '#cloud-config\nhostname: web01\nusers:\n  - name: ana\n' },
}

describe('El equipo', () => {
  it('los núcleos y la memoria salen del ejercicio (nproc, free, lscpu, /proc)', async () => {
    const { run } = await session({ equipo: { cpus: 16, memoria_gb: 64, fisico: true } })
    expect((await run('nproc')).out).toBe('16\n')
    expect((await run('grep -c processor /proc/cpuinfo')).out).toBe('16\n')
    expect((await run('lscpu')).out).toContain('Virtualization:         VT-x')
    expect((await run('lscpu')).out).not.toContain('Hypervisor vendor')
    expect((await run('free -g')).out).toMatch(/Mem:\s+62/)
  })
  it('sin cambios, sigue siendo la máquina virtual chica de siempre', async () => {
    const { run } = await session({})
    expect((await run('nproc')).out).toBe('2\n')
    expect((await run('grep -c vmx /proc/cpuinfo')).out).toBe('0\n')
  })
})

describe('qemu-img', () => {
  it('crea una imagen con archivo base, la agranda y la convierte', async () => {
    const { run, sh } = await session(kvm)
    const c = await run('cd /var/lib/libvirt/images && sudo qemu-img create -f qcow2 -b noble.img -F qcow2 web01.qcow2 20G')
    expect(c.out).toContain("Formatting 'web01.qcow2', fmt=qcow2")
    const info = (await run('sudo qemu-img info /var/lib/libvirt/images/web01.qcow2')).out
    expect(info).toContain('virtual size: 20 GiB (21474836480 bytes)')
    expect(info).toContain('disk size: 196 KiB')
    expect(info).toContain('backing file: noble.img')
    expect((await run('sudo qemu-img resize /var/lib/libvirt/images/web01.qcow2 10G')).err).toContain('--shrink')
    expect((await run('sudo qemu-img resize /var/lib/libvirt/images/web01.qcow2 +10G')).out).toBe('Image resized.\n')
    await run('sudo qemu-img convert -O vmdk /var/lib/libvirt/images/web01.qcow2 /tmp/web01.vmdk')
    expect((await run('sudo qemu-img info /tmp/web01.vmdk')).out).toContain('file format: vmdk')
    expect(verifyBash(sh, { imagen_disco: '/var/lib/libvirt/images/web01.qcow2', formato: 'qcow2', respaldo: 'noble.img', tamano_virtual_gb: 30 }).ok).toBe(true)
  })
})

describe('libvirt', () => {
  it('virt-install con cloud-init, virsh y las verificaciones', async () => {
    const { run, sh } = await session(kvm)
    expect((await run('virsh list --all')).out).not.toContain('web01')
    await run('cd /var/lib/libvirt/images && sudo qemu-img create -f qcow2 -b noble.img -F qcow2 web01.qcow2 20G')
    const noOs = await run('sudo virt-install --name web01 --memory 2048 --vcpus 2 --disk /var/lib/libvirt/images/web01.qcow2 --import')
    expect(noOs.err).toContain('--os-variant/--osinfo OS name is required')
    const ok = await run('sudo virt-install --name web01 --memory 2048 --vcpus 2 --disk /var/lib/libvirt/images/web01.qcow2 --import --osinfo ubuntu24.04 --cloud-init user-data=/home/ana/user-data --noautoconsole')
    expect(ok.out).toContain('Domain creation completed.')
    expect((await run('sudo virsh list')).out).toMatch(/1\s+web01\s+running/)
    expect((await run('sudo virsh domifaddr web01')).out).toMatch(/192\.168\.122\.\d+\/24/)
    expect((await run('sudo virsh console web01')).out).toContain('web01 login:')
    expect((await run('sudo virsh setvcpus web01 4 --config')).err).toContain('greater than max allowable vcpus')
    await run('sudo virsh snapshot-create-as web01 limpio')
    await run('sudo virsh autostart web01')
    expect(verifyBash(sh, { dominio: 'web01', estado: 'running', vcpus: 2, memoria_mb: 2048, autostart: true, instantanea: 'limpio' }).ok).toBe(true)
    expect((await run('sudo virsh undefine web01')).err).toContain('with 1 snapshots')
    await run('sudo virsh destroy web01')
    await run('sudo virsh undefine web01 --snapshots-metadata --remove-all-storage')
    expect(verifyBash(sh, { dominio: 'web01', existe: false }).ok).toBe(true)
    expect((await run('sudo ls /var/lib/libvirt/images')).out).toBe('noble.img\n')
  })
  it('sin la extensión vmx avisa que va a emular, y en Rocky los servicios son modulares', async () => {
    const { run } = await session({ distro: 'rocky', usuario: 'ana', usuarios: [{ nombre: 'ana', sudo: true }], paquetes: { instalados: ['libvirt', 'virt-install'] } })
    expect((await run('sudo virsh list')).err).toContain('virtqemud-sock')
    await run('sudo systemctl enable --now virtqemud virtnetworkd virtstoraged')
    await run('sudo virsh net-start default')
    const r = await run('sudo virt-install --name t1 --memory 1024 --vcpus 1 --disk size=10 --import --osinfo rocky10 --noautoconsole')
    expect(r.err).toContain("KVM acceleration not available, using 'qemu'")
    expect((await run('sudo virsh list --all')).out).toContain('t1')
  })
})

const pve: BashStateInput = {
  distro: 'ubuntu',
  hostname: 'pve01',
  usuario: 'root',
  equipo: { cpus: 16, memoria_gb: 64, fisico: true },
  red: { interfaces: [{ nombre: 'eno1', ip: '192.168.10.21/24', estado: 'UP' }], puerta_enlace: '192.168.10.1' },
  proxmox: { vms: [{ id: 100, nombre: 'web01', estado: 'running', agente: true, otros: { agent: '1' } }] },
  imagenes_disco: [{ ruta: '/root/noble.img', formato: 'qcow2', virtual_gb: 3.5 }],
}

describe('Proxmox VE', () => {
  it('es un Debian 13 con su kernel, y el repositorio enterprise da 401 sin suscripción', async () => {
    const { run } = await session(pve)
    expect((await run('cat /etc/os-release')).out).toContain('trixie')
    expect((await run('pveversion')).out).toMatch(/^pve-manager\/9\./)
    const u = await run('apt update')
    expect(u.out).toContain('401  Unauthorized')
    expect(u.code).toBe(100)
    await run("sed -i '1i Enabled: no' /etc/apt/sources.list.d/pve-enterprise.sources /etc/apt/sources.list.d/ceph.sources")
    await run("printf 'Types: deb\\nURIs: http://download.proxmox.com/debian/pve\\nSuites: trixie\\nComponents: pve-no-subscription\\nSigned-By: /usr/share/keyrings/proxmox-archive-keyring.gpg\\n' > /etc/apt/sources.list.d/proxmox.sources")
    const u2 = await run('apt update')
    expect(u2.code).toBe(0)
    expect(u2.out).toContain('download.proxmox.com/debian/pve trixie')
  })
  it('plantilla con cloud-init, clon enlazado, instantánea, respaldo y restauración', async () => {
    const { run, sh } = await session(pve)
    await run('qm create 9000 --name plantilla --memory 2048 --cores 2 --net0 virtio,bridge=vmbr0 --scsihw virtio-scsi-single --agent 1')
    expect((await run('qm disk import 9000 /root/noble.img local-lvm')).out).toContain("unused0: successfully imported disk 'local-lvm:vm-9000-disk-0'")
    await run('qm set 9000 --scsi0 local-lvm:vm-9000-disk-0 --ide2 local-lvm:cloudinit --boot order=scsi0')
    await run('qm set 9000 --ciuser ana --ipconfig0 ip=dhcp')
    expect((await run('qm template 9000')).out).toContain('base-9000-disk-0')
    expect(verifyBash(sh, { pve_vm: 9000, plantilla: true }).ok).toBe(true)
    expect((await run('qm clone 9000 201 --name web02')).out).toContain('create linked clone of drive scsi0')
    expect((await run('qm start 201')).out).toContain('generating cloud-init ISO')
    expect((await run('qm destroy 9000')).err).toContain('still in use by linked cloned')
    await run('qm snapshot 100 antes')
    expect((await run('qm listsnapshot 100')).out).toContain('antes')
    expect(verifyBash(sh, { pve_vm: 100, instantanea: 'antes', estado: 'running' }).ok).toBe(true)
    expect((await run('vzdump 100 --storage local-lvm')).err).toContain("does not support content-type 'backup'")
    expect((await run('vzdump 100 --storage local --mode snapshot --compress zstd')).out).toContain('Backup job finished successfully')
    expect(verifyBash(sh, { pve_respaldo: 100, almacenamiento: 'local' }).ok).toBe(true)
    const file = (await run('ls /var/lib/vz/dump')).out.trim().split(/\s+/).find((f) => f.endsWith('.vma.zst'))!
    expect((await run('ls /var/lib/vz/dump')).out).toContain('.log')
    expect(file).toMatch(/^vzdump-qemu-100-\d{4}_\d\d_\d\d-\d\d_\d\d_\d\d\.vma\.zst$/)
    expect((await run(`qmrestore /var/lib/vz/dump/${file} 100`)).err).toContain('already exists')
    await run(`qmrestore /var/lib/vz/dump/${file} 150 --unique 1`)
    expect(verifyBash(sh, { pve_vm: 150, nombre: 'web01' }).ok).toBe(true)
  })
  it('contenedores LXC desde una plantilla descargada', async () => {
    const { run, sh } = await session(pve)
    expect((await run('pct create 200 local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst --rootfs local-lvm:8')).err).toContain('does not exist')
    await run('pveam update')
    await run('pveam download local debian-13-standard_13.1-2_amd64.tar.zst')
    const c = await run('pct create 200 local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst --hostname dns01 --memory 512 --rootfs local-lvm:8 --net0 name=eth0,bridge=vmbr0,ip=dhcp --unprivileged 1')
    expect(c.out).toContain('Logical volume "vm-200-disk-0" created.')
    await run('pct start 200')
    expect((await run('pct exec 200 -- hostname')).out).toBe('dns01\n')
    expect(verifyBash(sh, { pve_ct: 200, estado: 'running', config: { unprivileged: '1', memory: '512' } }).ok).toBe(true)
  })
  it('un puente con VLAN, ifreload y la VM en la VLAN 20', async () => {
    const { run, sh } = await session(pve)
    await run("sed -i 's/\\tbridge-fd 0/\\tbridge-fd 0\\n\\tbridge-vlan-aware yes\\n\\tbridge-vids 2-4094/' /etc/network/interfaces")
    await run('ifreload -a')
    await run('qm set 100 --net0 virtio,bridge=vmbr0,tag=20')
    expect((await run('bridge vlan show')).out).toMatch(/tap100i0\s+20 PVID/)
    expect(verifyBash(sh, { pve_puente: 'vmbr0', vlan_aware: true, puerto: 'eno1' }).ok).toBe(true)
    await run('qm set 100 --net0 virtio,bridge=vmbr9')
    await run('qm stop 100')
    expect((await run('qm start 100')).err).toContain("bridge 'vmbr9' does not exist")
  })
  it('usuarios y permisos, y un Proxmox Backup Server como almacenamiento', async () => {
    const { run, sh } = await session(pve)
    await run("pveum user add ana@pve --comment 'Ana'")
    await run('pveum acl modify /vms/100 --users ana@pve --roles PVEVMUser')
    expect(verifyBash(sh, { pve_usuario: 'ana@pve', rol: 'PVEVMUser', ruta_acl: '/vms/100' }).ok).toBe(true)
    expect((await run('pvesm add pbs pbs01 --server 192.168.10.40 --datastore principal --username root@pam --password x')).err).toContain('fingerprint')
    await run('pvesm add pbs pbs01 --server 192.168.10.40 --datastore principal --username root@pam --password x --fingerprint aa:bb')
    expect(verifyBash(sh, { pve_almacenamiento: 'pbs01', tipo: 'pbs', contenido_incluye: 'backup' }).ok).toBe(true)
    expect((await run('vzdump 100 --storage pbs01')).out).toContain('dirty-bitmap status: created new')
    expect((await run('vzdump 100 --storage pbs01')).out).toContain('using fast incremental mode')
    expect(verifyBash(sh, { pve_respaldo: 100, almacenamiento: 'pbs01', cantidad: 2 }).ok).toBe(true)
  })
})

describe('Migrar a Proxmox desde otro hipervisor', () => {
  const origen: BashStateInput = {
    ...pve,
    proxmox: { isos: ['virtio-win-0.1.285.iso'] },
    imagenes_disco: [
      { ruta: '/mnt/migracion/erp01.vhdx', formato: 'vhdx', virtual_gb: 80, disco_gb: 34, sistema: { so: 'windows', uefi: true } },
      { ruta: '/mnt/migracion/web02.vmdk', formato: 'vmdk', virtual_gb: 40, disco_gb: 9, sistema: { so: 'linux', uefi: false } },
    ],
  }
  it('Windows UEFI sin drivers VirtIO: firmware, SATA, drivers y después SCSI', async () => {
    const { run, sh } = await session(origen)
    await run('qm create 120 --name erp01 --memory 8192 --cores 4 --ostype win11 --scsihw virtio-scsi-single --net0 virtio,bridge=vmbr0 --agent 1')
    await run('qm disk import 120 /mnt/migracion/erp01.vhdx local-lvm')
    await run('qm set 120 --scsi0 local-lvm:vm-120-disk-0 --boot order=scsi0')
    expect((await run('qm start 120')).out).toContain('not a bootable disk')
    expect(verifyBash(sh, { pve_vm: 120, arranca: false }).ok).toBe(true)
    await run('qm stop 120')
    await run('qm set 120 --bios ovmf --efidisk0 local-lvm:1,efitype=4m,pre-enrolled-keys=1')
    expect((await run('qm start 120')).out).toContain('INACCESSIBLE_BOOT_DEVICE')
    await run('qm stop 120')
    await run('qm set 120 --delete scsi0')
    expect((await run('qm config 120')).out).toMatch(/unused0: local-lvm:vm-120-disk-0/)
    await run('qm set 120 --sata0 local-lvm:vm-120-disk-0 --boot order=sata0')
    expect((await run('qm start 120')).out).toContain('sin red')
    expect(verifyBash(sh, { pve_vm: 120, arranca: true, con_red: false }).ok).toBe(true)
    await run('qm stop 120')
    await run('qm set 120 --ide2 local:iso/virtio-win-0.1.285.iso,media=cdrom')
    expect((await run('qm start 120')).out).toContain('se dan por instalados')
    await run('qm shutdown 120')
    await run('qm set 120 --delete sata0')
    expect((await run('qm start 120')).out).toContain('No bootable device')
    await run('qm stop 120')
    await run('qm set 120 --scsi0 local-lvm:vm-120-disk-0 --boot order=scsi0 --delete ide2')
    expect((await run('qm start 120')).out).not.toContain('[simulador]')
    expect(verifyBash(sh, { pve_vm: 120, arranca: true, con_red: true }).ok).toBe(true)
    expect((await run('qm agent 120 ping')).code).toBe(0)
  })
  it('un Linux de VMware convertido con qemu-img arranca con SeaBIOS', async () => {
    const { run, sh } = await session(origen)
    await run('qemu-img convert -p -f vmdk -O qcow2 /mnt/migracion/web02.vmdk /root/web02.qcow2')
    await run('qm create 121 --name web02 --memory 2048 --cores 2 --net0 virtio,bridge=vmbr0 --scsihw virtio-scsi-single --scsi0 local-lvm:0,import-from=/root/web02.qcow2 --boot order=scsi0')
    expect((await run('qm start 121')).out).toBe('')
    expect(verifyBash(sh, { pve_vm: 121, arranca: true, con_red: true }).ok).toBe(true)
  })
})
