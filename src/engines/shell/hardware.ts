/** Datos de hardware de la máquina virtual simulada (KVM, 2 vCPU, 4 GB de RAM, firmware BIOS). */

export const CPU_FLAGS =
  'fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ss syscall nx pdpe1gb rdtscp lm constant_tsc arch_perfmon rep_good nopl xtopology cpuid tsc_known_freq pni pclmulqdq ssse3 fma cx16 pcid sse4_1 sse4_2 x2apic movbe popcnt tsc_deadline_timer aes xsave avx f16c rdrand hypervisor lahf_lm abm 3dnowprefetch invpcid_single pti ssbd ibrs ibpb stibp fsgsbase tsc_adjust bmi1 hle avx2 smep bmi2 erms invpcid rtm rdseed adx smap xsaveopt arat md_clear arch_capabilities'

/** Contenido de /proc/cpuinfo de la máquina virtual simulada (2 vCPU). */
export function cpuinfoText(): string {
  return [0, 1]
    .map(
      (n) =>
        `processor\t: ${n}\nvendor_id\t: GenuineIntel\ncpu family\t: 6\nmodel\t\t: 79\nmodel name\t: Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz\nstepping\t: 1\nmicrocode\t: 0xb000040\ncpu MHz\t\t: 2399.998\ncache size\t: 35840 KB\nphysical id\t: 0\nsiblings\t: 2\ncore id\t\t: ${n}\ncpu cores\t: 2\napicid\t\t: ${n}\nfpu\t\t: yes\nflags\t\t: ${CPU_FLAGS}\nbogomips\t: 4799.99\naddress sizes\t: 46 bits physical, 48 bits virtual\n\n`,
    )
    .join('')
}

type Distro = 'rocky' | 'ubuntu'
type Firmware = 'bios' | 'uefi'

/** Entradas de arranque de la NVRAM de UEFI (efibootmgr). */
export function efibootmgrText(distro: Distro, verbose: boolean): string {
  const name = distro === 'rocky' ? 'Rocky Linux' : 'ubuntu'
  const dir = distro === 'rocky' ? 'rocky' : 'ubuntu'
  const size = distro === 'rocky' ? '0x12c000' : '0x200000'
  const path = (p: string) => (verbose ? `\t${p}` : '')
  return [
    'BootCurrent: 0004',
    'Timeout: 0 seconds',
    'BootOrder: 0004,0001,0002,0000,0003',
    `Boot0000* UiApp${path('FvVol(7cb8bdc9-f8eb-4f34-aaea-3ee4af6516a1)/FvFile(462caa21-7614-4503-836e-8ab6f4662331)')}`,
    `Boot0001* UEFI QEMU DVD-ROM QM00003 ${path('PciRoot(0x0)/Pci(0x1f,0x2)/Sata(1,65535,0){auto_created_boot_option}')}`,
    `Boot0002* UEFI QEMU HARDDISK QM00001 ${path('PciRoot(0x0)/Pci(0x1f,0x2)/Sata(0,65535,0){auto_created_boot_option}')}`,
    `Boot0003* EFI Internal Shell${path('FvVol(7cb8bdc9-f8eb-4f34-aaea-3ee4af6516a1)/FvFile(7c04a583-9e3e-4f1c-ad65-e05268d0b4d1)')}`,
    `Boot0004* ${name}${path(`HD(1,GPT,5f1c2b8e-1a7d-4c1e-9d5a-2b6f0c3e8a11,0x800,${size})/File(\\EFI\\${dir}\\shimx64.efi)`)}`,
  ].join('\n') + '\n'
}

export function dmiBiosText(firmware: Firmware): string {
  return firmware === 'bios'
    ? 'Handle 0x0000, DMI type 0, 24 bytes\nBIOS Information\n\tVendor: SeaBIOS\n\tVersion: 1.16.3-debian-1.16.3-2\n\tRelease Date: 04/01/2014\n\tAddress: 0xE8000\n\tRuntime Size: 96 kB\n\tROM Size: 64 kB\n\tCharacteristics:\n\t\tBIOS characteristics not supported\n\t\tTargeted content distribution is supported\n\tBIOS Revision: 0.0\n'
    : 'Handle 0x0000, DMI type 0, 26 bytes\nBIOS Information\n\tVendor: EDK II\n\tVersion: edk2-stable202408-prebuilt.qemu.org\n\tRelease Date: 08/13/2024\n\tROM Size: 64 kB\n\tCharacteristics:\n\t\tBIOS characteristics not supported\n\t\tTargeted content distribution is supported\n\t\tUEFI is supported\n\t\tSystem is a virtual machine\n\tBIOS Revision: 0.0\n'
}
