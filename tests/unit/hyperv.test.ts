import { describe, expect, it } from 'vitest'
import { createPsSession, verifyPs } from '@/engines/powershell'
import type { PsStateInput } from '@/engines/powershell/schema'

type S = ReturnType<typeof createPsSession>
const run = async (s: S, line: string) => {
  const r = await s.run(line)
  return { out: r.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join(''), err: r.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join('') }
}

const host: PsStateInput = {
  equipo: 'HV01',
  edicion: 'Datacenter',
  red: { ip: '192.168.10.31', adaptador: 'Ethernet' },
  discos: [{ numero: 1, tamano_gb: 500, estilo: 'GPT', particiones: [{ letra: 'D', tamano_gb: 499, sistema: 'NTFS', etiqueta: 'VMs' }] }],
}

describe('Hyper-V', () => {
  it('el rol funciona recién después de reiniciar', async () => {
    const s = createPsSession({ ...host, hyperv: { instalado: false } })
    expect((await run(s, 'Get-VM')).err).toContain("is not recognized")
    await run(s, 'Install-WindowsFeature Hyper-V -IncludeManagementTools')
    expect((await run(s, 'Get-VM')).err).toContain('could not access an expected WMI class')
    await run(s, 'Restart-Computer')
    expect((await run(s, 'Get-VM')).err).toBe('')
    expect(verifyPs(s, { caracteristica: 'Hyper-V' }).ok).toBe(true)
  })
  it('sin virtualización en la CPU no se puede instalar', async () => {
    const s = createPsSession({ ...host, hyperv: { instalado: false, cpu_virtualizacion: false } })
    expect((await run(s, 'Install-WindowsFeature Hyper-V')).err).toContain('does not have required virtualization capabilities')
  })
  it('conmutadores, una VM de generación 2, memoria dinámica, VLAN y puntos de control', async () => {
    const s = createPsSession({ ...host, hyperv: { procesadores: 16, memoria_gb: 64 } })
    await run(s, 'New-VMSwitch -Name Externo -NetAdapterName Ethernet -AllowManagementOS $true')
    expect((await run(s, 'New-VMSwitch -Name Otro -NetAdapterName Ethernet')).err).toContain('already bound')
    await run(s, 'New-VMSwitch -Name Lab -SwitchType Private')
    expect(verifyPs(s, { conmutador_hyperv: 'Externo', tipo: 'External' }).ok).toBe(true)
    await run(s, 'New-VM -Name web01 -Generation 2 -MemoryStartupBytes 2GB -NewVHDPath D:\\VMs\\web01.vhdx -NewVHDSizeBytes 60GB -SwitchName Externo')
    expect(verifyPs(s, { vhd: 'D:\\VMs\\web01.vhdx', tipo: 'Dynamic', tamano_gb: 60 }).ok).toBe(true)
    await run(s, 'Set-VM -Name web01 -ProcessorCount 2 -DynamicMemory -MemoryMinimumBytes 1GB -MemoryMaximumBytes 4GB')
    await run(s, 'Set-VMNetworkAdapterVlan -VMName web01 -Access -VlanId 20')
    await run(s, 'Start-VM web01')
    expect((await run(s, 'Set-VM -Name web01 -ProcessorCount 4')).err).toContain('running virtual machine is not supported')
    expect((await run(s, 'Get-VM web01')).out).toMatch(/web01\s+Running/)
    await run(s, "Checkpoint-VM -Name web01 -SnapshotName 'antes'")
    expect(verifyPs(s, { vm_hyperv: 'web01', estado: 'Running', procesadores: 2, memoria_dinamica: true, conmutador: 'Externo', vlan: 20, generacion: 2, punto_de_control: 'antes' }).ok).toBe(true)
    expect((await run(s, 'Stop-VM web01')).err).toContain('-TurnOff')
    await run(s, 'Stop-VM web01 -TurnOff')
    await run(s, 'Remove-VM web01 -Force')
    expect(verifyPs(s, { vm_hyperv: 'web01', existe: false }).ok).toBe(true)
    // Remove-VM deja el disco
    expect(verifyPs(s, { vhd: 'D:\\VMs\\web01.vhdx' }).ok).toBe(true)
  })
  it('no arranca si no alcanza la memoria del host', async () => {
    const s = createPsSession({ ...host, hyperv: { memoria_gb: 8, vms: [{ nombre: 'grande', memoria_mb: 4096, estado: 'Running' }, { nombre: 'otra', memoria_mb: 4096 }] } })
    expect((await run(s, 'Start-VM otra')).err).toContain('Not enough memory in the system')
  })
  it('discos diferenciales, conversión y exportar e importar', async () => {
    const s = createPsSession({ ...host, hyperv: {} })
    await run(s, 'New-VHD -Path D:\\base.vhdx -SizeBytes 40GB -Fixed')
    await run(s, 'New-VHD -Path D:\\hijo.vhdx -ParentPath D:\\base.vhdx -Differencing')
    expect(verifyPs(s, { vhd: 'D:\\hijo.vhdx', tipo: 'Differencing', padre: 'base.vhdx' }).ok).toBe(true)
    await run(s, 'Convert-VHD -Path D:\\hijo.vhdx -DestinationPath D:\\suelto.vhdx -VHDType Dynamic')
    expect(verifyPs(s, { vhd: 'D:\\suelto.vhdx', tipo: 'Dynamic', tamano_gb: 40 }).ok).toBe(true)
    await run(s, 'New-VM -Name a -Generation 2 -VHDPath D:\\suelto.vhdx')
    await run(s, 'Export-VM -Name a -Path D:\\Export')
    const vmcx = (await run(s, '(Get-ChildItem "D:\\Export\\a\\Virtual Machines").FullName')).out.trim()
    expect((await run(s, `Import-VM -Path '${vmcx}'`)).err).toContain('same identifier already exists')
    await run(s, `Import-VM -Path '${vmcx}' -Copy -GenerateNewId -VhdDestinationPath D:\\Copia`)
    expect((await run(s, '(Get-VM).Count')).out.trim()).toBe('2')
  })
  it('Linux de generación 2: la plantilla de arranque seguro y la instalación desde la ISO', async () => {
    const s = createPsSession({ ...host, archivos: { 'D:\\ISO\\ubuntu.iso': { tamano_mb: 3000 } }, hyperv: {} })
    await run(s, 'New-VMSwitch -Name Externo -NetAdapterName Ethernet -AllowManagementOS $true')
    await run(s, 'New-VM -Name lx -Generation 2 -MemoryStartupBytes 2GB -NewVHDPath D:\\lx.vhdx -NewVHDSizeBytes 20GB -SwitchName Externo')
    await run(s, 'Add-VMDvdDrive -VMName lx -Path D:\\ISO\\ubuntu.iso')
    expect((await run(s, 'Start-VM lx')).out).toContain('not allowed (DB)')
    expect((await run(s, 'Get-VMNetworkAdapter -VMName lx')).out).not.toContain('192.168.')
    await run(s, 'Stop-VM lx -TurnOff')
    await run(s, 'Set-VMFirmware -VMName lx -SecureBootTemplate MicrosoftUEFICertificateAuthority')
    expect((await run(s, 'Start-VM lx')).out).toContain('se da por terminada')
    expect((await run(s, 'Get-VMNetworkAdapter -VMName lx')).out).toContain('192.168.')
    expect((await run(s, 'Checkpoint-VM -Name lx -SnapshotName a')).out).not.toContain('standard checkpoint')
  })
})
