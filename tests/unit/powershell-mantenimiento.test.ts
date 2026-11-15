import { describe, expect, it } from 'vitest'
import { createPsSession, verifyPs } from '@/engines/powershell'

type S = ReturnType<typeof createPsSession>
const run = async (s: S, line: string) => {
  const r = await s.run(line)
  return {
    out: r.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join(''),
    err: r.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join(''),
    all: r.chunks.map((c) => c.text).join(''),
  }
}
const K = 'HKLM\\Software\\Policies\\Microsoft\\Windows\\WindowsUpdate'

describe('WSUS y Windows Update', () => {
  const lab = () =>
    createPsSession({
      equipo: 'SRV-WSUS',
      dominio: 'empresa.local',
      red: { ip: '192.168.10.25', dns: ['192.168.10.10'] },
      discos: [{ numero: 1, tamano_gb: 200, estilo: 'GPT', particiones: [{ letra: 'D', tamano_gb: 199, sistema: 'NTFS', etiqueta: 'WSUS' }] }],
      servidores: [
        { equipo: 'DC01', dominio: 'empresa.local', red: { ip: '192.168.10.10', dns: ['127.0.0.1'] }, ad: { ous: ['Empresa/Equipos/Piloto', 'Empresa/Equipos/Produccion'], equipos: [{ nombre: 'PC01', ou: 'Empresa/Equipos/Piloto' }, { nombre: 'PC02', ou: 'Empresa/Equipos/Produccion' }] } },
        { equipo: 'PC01', dominio: 'empresa.local', red: { ip: '192.168.10.51', dns: ['192.168.10.10'] } },
        { equipo: 'PC02', dominio: 'empresa.local', red: { ip: '192.168.10.52', dns: ['192.168.10.10'] } },
      ],
    })

  it('del servidor recién instalado a una PC piloto actualizada', async () => {
    const s = lab()
    const dc = s.lab!.find('DC01')!
    const pc1 = s.lab!.find('PC01')!
    const pc2 = s.lab!.find('PC02')!
    await run(s, 'Install-WindowsFeature UpdateServices -IncludeManagementTools')
    expect((await run(s, 'Get-WsusServer')).err).toMatch(/postinstall/)
    expect((await run(s, "& 'C:\\Program Files\\Update Services\\Tools\\wsusutil.exe' postinstall CONTENT_DIR=D:\\WSUS")).out).toMatch(/successfully completed/)
    await run(s, "Get-WsusProduct | Where-Object { $_.Product.Title -in 'Microsoft Server Operating System-24H2','Windows 11' } | Set-WsusProduct")
    await run(s, '$w = Get-WsusServer; $w.GetSubscription().StartSynchronization()')
    await run(s, "$w.CreateComputerTargetGroup('Piloto'); $c = $w.GetConfiguration(); $c.TargetingMode = 'Client'; $c.Save()")
    expect(verifyPs(s, { wsus_listo: true }).ok).toBe(true)
    for (const c of [
      "New-GPO 'WU' | New-GPLink -Target 'OU=Equipos,OU=Empresa,DC=empresa,DC=local'",
      `Set-GPRegistryValue 'WU' -Key '${K}' -ValueName WUServer -Type String -Value 'http://srv-wsus.empresa.local:8530'`,
      `Set-GPRegistryValue 'WU' -Key '${K}\\AU' -ValueName UseWUServer -Type DWord -Value 1`,
      `Set-GPRegistryValue 'WU' -Key '${K}' -ValueName TargetGroupEnabled -Type DWord -Value 1`,
      "New-GPO 'Piloto' | New-GPLink -Target 'OU=Piloto,OU=Equipos,OU=Empresa,DC=empresa,DC=local'",
      `Set-GPRegistryValue 'Piloto' -Key '${K}' -ValueName TargetGroup -Type String -Value Piloto`,
    ])
      await run(dc, c)
    for (const pc of [pc1, pc2]) await run(pc, 'gpupdate /force; UsoClient StartScan')
    expect(verifyPs(s, { wsus_equipo: 'PC01', grupo: 'Piloto' }).ok).toBe(true)
    expect(verifyPs(s, { wsus_equipo: 'PC02', grupo: 'Unassigned Computers' }).ok).toBe(true)
    await run(s, 'Get-WsusUpdate -Classification Security -Approval Unapproved -Status FailedOrNeeded | Approve-WsusUpdate -Action Install -TargetGroupName Piloto')
    await run(pc1, 'UsoClient StartInstall')
    await run(pc2, 'UsoClient StartInstall')
    expect(verifyPs(pc1, { actualizacion: 'KB5072031' }).ok).toBe(true)
    expect(verifyPs(pc1, { actualizacion: 'KB5071950', instalada: false }).ok).toBe(true)
    expect(verifyPs(pc2, { actualizacion: 'KB5072031', instalada: false }).ok).toBe(true)
    await run(s, 'Invoke-WsusServerCleanup -DeclineSupersededUpdates')
    expect(verifyPs(s, { wsus_rechazada: 'KB5071950' }).ok).toBe(true)
    await run(pc1, 'wusa /uninstall /kb:5072031 /quiet /norestart')
    expect(verifyPs(pc1, { actualizacion: 'KB5072031', instalada: false }).ok).toBe(true)
  })
})

describe('Monitoreo y respaldo', () => {
  it('Get-Counter y Get-WinEvent con filtros', async () => {
    const s = createPsSession({
      equipo: 'SRV-APP01',
      rendimiento: { cpu: 96, memoria_disponible_mb: 180 },
      eventos: [{ log: 'System', id: 41, nivel: 'Critical', origen: 'Microsoft-Windows-Kernel-Power', mensaje: 'The system has rebooted without cleanly shutting down first.', hace_minutos: 60 }],
    })
    expect((await run(s, "(Get-Counter '\\Memory\\Available MBytes').CounterSamples.CookedValue")).out.trim()).toBe('180')
    expect((await run(s, "Get-Counter '\\Processor(_Total)\\% Processor Time' -MaxSamples 3")).out).toMatch(/processor time :\n\s+\d+/)
    expect((await run(s, "Get-WinEvent -FilterHashtable @{ LogName = 'System'; Level = 1 }")).out).toMatch(/41 Critical/)
    expect((await run(s, "Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'EventLog'; Id = 41 }")).err).toMatch(/No events were found/)
  })

  it('wbadmin: respaldo de carpetas y recuperación de un archivo', async () => {
    const s = createPsSession({
      equipo: 'SRV-ARCH01',
      caracteristicas: [{ nombre: 'Windows-Server-Backup', nombre_visible: 'Windows Server Backup', instalada: true }],
      archivos: { 'D:\\Datos\\Ventas\\precios.xlsx': 'v1' },
      discos: [
        { numero: 1, tamano_gb: 200, estilo: 'GPT', particiones: [{ letra: 'D', tamano_gb: 199, sistema: 'NTFS' }] },
        { numero: 2, tamano_gb: 500, estilo: 'GPT', particiones: [{ letra: 'E', tamano_gb: 499, sistema: 'NTFS', etiqueta: 'Respaldos' }] },
      ],
    })
    expect((await run(s, 'wbadmin start backup -backupTarget:D: -include:D:\\Datos -quiet')).out).toMatch(/included in the backup/)
    await run(s, 'wbadmin start backup -backupTarget:E: -include:D:\\Datos -quiet')
    expect(verifyPs(s, { respaldo_en: 'E:', incluye: 'D:\\Datos' }).ok).toBe(true)
    const id = /Version identifier: (\S+)/.exec((await run(s, 'wbadmin get versions')).out)![1]
    await run(s, 'Remove-Item D:\\Datos\\Ventas\\precios.xlsx')
    await run(s, `wbadmin start recovery -version:${id} -itemType:File -items:D:\\Datos\\Ventas\\precios.xlsx -quiet`)
    expect((await run(s, 'Get-Content D:\\Datos\\Ventas\\precios.xlsx')).out.trim()).toBe('v1')
    await run(s, 'wbadmin enable backup -addtarget:E: -schedule:21:00 -include:D:\\Datos -allCritical -quiet')
    expect(verifyPs(s, { respaldo_programado: true, hora: '21:00' }).ok).toBe(true)
  })
})
