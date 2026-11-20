/**
 * Paquetes de virtualización con KVM: QEMU, libvirt, virt-install, qemu-img y la consola web
 * (Cockpit). En Rocky 10 ya no está virt-manager: se administra con Cockpit o con virsh.
 */
import type { PackageInfo } from './packages'

export const ROCKY_VIRT: Record<string, PackageInfo> = {
  'qemu-img': { summary: 'QEMU command line tool for manipulating disk images', version: '9.1.0-15.el10', commands: ['qemu-img'] },
  'qemu-kvm': { summary: 'QEMU is a machine emulator and virtualizer', version: '9.1.0-15.el10', requires: ['qemu-img'], commands: [] },
  libvirt: {
    summary: 'Library providing a simple virtualization API',
    version: '10.10.0-7.el10',
    requires: ['qemu-kvm'],
    services: [
      { name: 'virtqemud', description: 'libvirt QEMU daemon', ports: [], enabledByDefault: true },
      { name: 'virtnetworkd', description: 'libvirt network daemon', ports: [], enabledByDefault: true },
      { name: 'virtstoraged', description: 'libvirt storage daemon', ports: [], enabledByDefault: true },
    ],
    commands: ['virsh', 'virt-host-validate'],
  },
  'virt-install': { summary: 'Utilities for installing virtual machines', version: '4.1.0-9.el10', commands: ['virt-install', 'virt-clone', 'virt-xml'] },
  cockpit: { summary: 'Web Console for Linux servers', version: '334-1.el10', services: [{ name: 'cockpit', description: 'Cockpit Web Service', ports: [9090] }], commands: [] },
  'cockpit-machines': { summary: 'Cockpit user interface for virtual machines', version: '330-1.el10', requires: ['cockpit', 'libvirt'], commands: [] },
}

export const UBUNTU_VIRT: Record<string, PackageInfo> = {
  'qemu-utils': { summary: 'QEMU utilities', version: '1:8.2.2+ds-0ubuntu1.4', commands: ['qemu-img'] },
  'qemu-system-x86': { summary: 'QEMU full system emulation binaries (x86)', version: '1:8.2.2+ds-0ubuntu1.4', requires: ['qemu-utils'], commands: ['qemu-system-x86_64'] },
  'qemu-kvm': { summary: 'QEMU Full virtualization on x86 hardware (transitional package)', version: '1:8.2.2+ds-0ubuntu1.4', requires: ['qemu-system-x86'], commands: [] },
  'libvirt-clients': { summary: 'Programs for the libvirt library', version: '10.0.0-2ubuntu8.6', commands: ['virsh', 'virt-host-validate'] },
  'libvirt-daemon-system': {
    summary: 'Libvirt daemon configuration files',
    version: '10.0.0-2ubuntu8.6',
    requires: ['libvirt-clients', 'qemu-system-x86'],
    user: { name: 'libvirt-qemu', uid: 64055, home: '/var/lib/libvirt', gecos: 'Libvirt Qemu' },
    services: [{ name: 'libvirtd', description: 'libvirt legacy monolithic daemon', ports: [], enabledByDefault: true, activeAfterInstall: true }],
    commands: [],
  },
  virtinst: { summary: 'Programs to create and clone virtual machines', version: '1:4.1.0-3ubuntu0.1', commands: ['virt-install', 'virt-clone', 'virt-xml'] },
  'virt-manager': { summary: 'desktop application for managing virtual machines', version: '1:4.1.0-3ubuntu0.1', requires: ['virtinst', 'libvirt-clients'], commands: ['virt-manager'] },
  'pve-qemu-kvm': { summary: 'Full virtualization on x86 hardware', version: '11.0.0-2', commands: ['qemu-img'] },
  'proxmox-ve': {
    summary: 'Proxmox Virtual Environment',
    version: '9.2.0',
    requires: ['pve-qemu-kvm'],
    services: [
      { name: 'pveproxy', description: 'PVE API Proxy Server', ports: [8006], enabledByDefault: true, activeAfterInstall: true },
      { name: 'pvedaemon', description: 'PVE API Daemon', ports: [85], enabledByDefault: true, activeAfterInstall: true },
      { name: 'pve-cluster', description: 'The Proxmox VE cluster filesystem', ports: [], enabledByDefault: true, activeAfterInstall: true },
      { name: 'pvestatd', description: 'PVE Status Daemon', ports: [], enabledByDefault: true, activeAfterInstall: true },
      { name: 'pve-firewall', description: 'Proxmox VE firewall', ports: [], enabledByDefault: true, activeAfterInstall: true },
      { name: 'pvescheduler', description: 'Proxmox VE scheduler', ports: [], enabledByDefault: true, activeAfterInstall: true },
      { name: 'spiceproxy', description: 'PVE SPICE Proxy Server', ports: [3128], enabledByDefault: true, activeAfterInstall: true },
      { name: 'pve-ha-lrm', description: 'PVE Local HA Resource Manager Daemon', ports: [], enabledByDefault: true, activeAfterInstall: true },
      { name: 'pve-ha-crm', description: 'PVE Cluster HA Resource Manager Daemon', ports: [], enabledByDefault: true, activeAfterInstall: true },
    ],
    commands: [],
  },
  'cloud-image-utils': { summary: 'cloud image management utilities', version: '0.33-1', commands: ['cloud-localds'] },
}
