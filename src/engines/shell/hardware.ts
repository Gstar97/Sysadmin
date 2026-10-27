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
