import { describe, expect, it } from 'vitest'
import { createPsSession, verifyPs } from '@/engines/powershell'
import type { PsStateInput } from '@/engines/powershell/schema'

type S = ReturnType<typeof createPsSession>
const run = async (s: S, line: string) => {
  const r = await s.run(line)
  return { out: r.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join(''), err: r.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join('') }
}

const iscsi = { numero: 2, tamano_gb: 500, bus: 'iSCSI' as const, estilo: 'GPT' as const }
const hv = (equipo: string, ip: string): PsStateInput => ({
  equipo,
  edicion: 'Datacenter',
  dominio: 'empresa.local',
  red: { ip, adaptador: 'Ethernet', dns: ['192.168.10.10'] },
  discos: [{ numero: 1, tamano_gb: 200, estilo: 'GPT', particiones: [{ letra: 'D', tamano_gb: 199, sistema: 'NTFS' }] }, iscsi],
  hyperv: { conmutadores: [{ nombre: 'Externo', tipo: 'External' }] },
})

const lab = (witness = true) =>
  createPsSession({
    ...hv('HV01', '192.168.10.31'),
    servidores: [
      { equipo: 'DC01', dominio: 'empresa.local', controlador_dominio: true, red: { ip: '192.168.10.10', dns: ['127.0.0.1'] }, ad: {} },
      hv('HV02', '192.168.10.32') as never,
      ...(witness ? [{ equipo: 'FS01', dominio: 'empresa.local', red: { ip: '192.168.10.20', dns: ['192.168.10.10'] }, archivos: { 'C:\\Testigo': { tipo: 'directorio' as const } } }] : []),
    ],
  })

const armar = async (s: S) => {
  for (const c of [
    'Invoke-Command -ComputerName HV01, HV02 { Install-WindowsFeature Failover-Clustering -IncludeManagementTools }',
    'Install-WindowsFeature Failover-Clustering -IncludeManagementTools',
    'New-Cluster -Name CLU01 -Node HV01, HV02 -StaticAddress 192.168.10.30',
  ])
    await run(s, c)
}

describe('Clúster de conmutación por error', () => {
  it('validar, crear, testigo y CSV', async () => {
    const s = lab()
    const t = await run(s, 'Invoke-Command -ComputerName HV02 { Get-WindowsFeature Failover-Clustering }')
    expect(t.out).toContain('Failover Clustering')
    await run(s, 'Install-WindowsFeature Failover-Clustering -IncludeManagementTools')
    expect((await run(s, 'Test-Cluster -Node HV01, HV02')).out).toContain('Failed')
    await run(s, 'Invoke-Command -ComputerName HV02 { Install-WindowsFeature Failover-Clustering -IncludeManagementTools }')
    expect((await run(s, 'Test-Cluster -Node HV01, HV02')).out).toContain('ClusterConditionallyApproved')
    expect((await run(s, 'New-Cluster -Name CLU01 -Node HV01, HV02 -StaticAddress 192.168.10.30')).out).toContain('testigo')
    expect((await run(s, 'Get-ClusterNode')).out).toMatch(/HV02\s+Up/)
    expect((await run(s, 'Get-ClusterQuorum')).out).toContain('CLU01')
    expect((await run(s, 'Set-ClusterQuorum -FileShareWitness \\\\FS01\\Testigo')).err).toContain('network name cannot be found')
    await run(s, "Invoke-Command -ComputerName FS01 { New-SmbShare -Name Testigo -Path C:\\Testigo -FullAccess 'EMPRESA\\CLU01$' }")
    await run(s, 'Set-ClusterQuorum -FileShareWitness \\\\FS01\\Testigo')
    expect((await run(s, 'Get-ClusterSharedVolume')).out.trim()).toBe('')
    await run(s, "Add-ClusterSharedVolume -Name 'Cluster Disk 1'")
    expect(verifyPs(s, { cluster_win: 'CLU01', nodos: 2, testigo: 'FileShare', quorum: true, csv: 1 }).ok).toBe(true)
  })
  it('una VM en el CSV como rol: se mueve en vivo, se drena el nodo y sobrevive a su caída', async () => {
    const s = lab()
    await armar(s)
    await run(s, "Invoke-Command -ComputerName FS01 { New-SmbShare -Name Testigo -Path C:\\Testigo -FullAccess 'EMPRESA\\CLU01$' }")
    await run(s, 'Set-ClusterQuorum -FileShareWitness \\\\FS01\\Testigo')
    await run(s, "Add-ClusterSharedVolume -Name 'Cluster Disk 1'")
    await run(s, 'New-VM -Name web01 -Generation 2 -MemoryStartupBytes 2GB -Path C:\\ClusterStorage\\Volume1 -NewVHDPath C:\\ClusterStorage\\Volume1\\web01\\web01.vhdx -NewVHDSizeBytes 40GB -SwitchName Externo')
    await run(s, 'New-VM -Name local01 -Generation 2 -MemoryStartupBytes 1GB -Path D:\\VMs -NewVHDPath D:\\VMs\\local01.vhdx -NewVHDSizeBytes 20GB -SwitchName Externo')
    await run(s, 'Start-VM web01, local01')
    await run(s, 'Add-ClusterVirtualMachineRole -VMName web01')
    expect((await run(s, 'Add-ClusterVirtualMachineRole -VMName local01')).out).toContain('local storage')
    expect((await run(s, 'Get-ClusterGroup')).out).toMatch(/web01\s+HV01\s+Online/)
    await run(s, 'Move-ClusterVirtualMachineRole -Name web01 -Node HV02 -MigrationType Live')
    expect(verifyPs(s, { rol_cluster: 'web01', propietario: 'HV02', estado: 'Online' }).ok).toBe(true)
    expect((await run(s, 'Move-ClusterVirtualMachineRole -Name local01 -Node HV02')).err).toContain('local storage')
    await run(s, 'Suspend-ClusterNode -Name HV02 -Drain')
    expect(verifyPs(s, { nodo_cluster: 'HV02', estado: 'Paused' }).ok).toBe(true)
    expect(verifyPs(s, { rol_cluster: 'web01', propietario: 'HV01' }).ok).toBe(true)
    await run(s, 'Resume-ClusterNode -Name HV02 -Failback Immediate')
    expect(verifyPs(s, { rol_cluster: 'web01', propietario: 'HV02' }).ok).toBe(true)
    await run(s, 'Stop-Computer -ComputerName HV02 -Force')
    expect(verifyPs(s, { nodo_cluster: 'HV02', estado: 'Down' }).ok).toBe(true)
    expect(verifyPs(s, { rol_cluster: 'web01', propietario: 'HV01', estado: 'Online' }).ok).toBe(true)
    expect(verifyPs(s, { cluster_win: 'CLU01', quorum: true }).ok).toBe(true)
  })
  it('dos nodos sin testigo: si se cae el nodo que tiene el voto, se cae el clúster', async () => {
    const s = lab(false)
    await armar(s)
    expect((await run(s, 'Get-ClusterNode | Select-Object Name, NodeWeight')).out).toMatch(/HV02\s+0/)
    await run(s, 'Stop-ClusterNode -Name HV02')
    expect(verifyPs(s, { cluster_win: 'CLU01', quorum: true }).ok).toBe(true)
    await run(s, 'Start-ClusterNode -Name HV02')
    await run(s, 'Invoke-Command -ComputerName HV02 { Stop-ClusterNode -Name HV01 }')
    expect(verifyPs(s, { cluster_win: 'CLU01', quorum: false }).ok).toBe(true)
  })
})

describe('Iniciador iSCSI de Windows', () => {
  it('servicio, portal, conexión persistente y los discos que aparecen desconectados', async () => {
    const s = createPsSession({ equipo: 'HV01', dominio: 'empresa.local', red: { ip: '192.168.10.31' }, iscsi: { portales: [{ ip: '192.168.10.60', destinos: [{ iqn: 'iqn.2026-11.lan.empresa:san01', luns_gb: [500, 1] }] }] } })
    expect((await run(s, 'New-IscsiTargetPortal -TargetPortalAddress 192.168.10.60')).err).toContain('has not been started')
    await run(s, 'Set-Service MSiSCSI -StartupType Automatic')
    await run(s, 'Start-Service MSiSCSI')
    await run(s, 'New-IscsiTargetPortal -TargetPortalAddress 192.168.10.60')
    expect((await run(s, 'Get-IscsiTarget')).out).toContain('iqn.2026-11.lan.empresa:san01')
    expect((await run(s, 'Get-InitiatorPort')).out).toContain('iqn.1991-05.com.microsoft:hv01.empresa.local')
    await run(s, 'Get-IscsiTarget | Connect-IscsiTarget -IsPersistent $true')
    expect(verifyPs(s, { iscsi_conectado: 'iqn.2026-11.lan.empresa:san01', persistente: true }).ok).toBe(true)
    const d = (await run(s, 'Get-Disk | Where-Object BusType -eq iSCSI')).out
    expect(d).toMatch(/500 GB/)
    expect(d).toContain('Offline')
  })
})
