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

const lab = () =>
  createPsSession({
    equipo: 'SRV-ADMIN',
    dominio: 'empresa.local',
    red: { ip: '192.168.10.5' },
    servidores: [
      { equipo: 'SRV01', dominio: 'empresa.local', red: { ip: '192.168.10.11' } },
      { equipo: 'SRV02', dominio: 'empresa.local', red: { ip: '192.168.10.12' }, remoting: false },
      { equipo: 'WEB01', red: { ip: '192.168.10.30' } },
    ],
  })

describe('PowerShell: lenguaje', () => {
  it('try/catch, throw y -ErrorAction Stop', async () => {
    const s = createPsSession()
    expect((await run(s, 'try { Get-Service NoExiste -ErrorAction Stop } catch { "atrapado: $($_.Exception.Message)" }')).out).toMatch(/atrapado: Cannot find any service/)
    expect((await run(s, 'try { throw "falló" } catch { $_.Exception.Message } finally { "fin" }')).out).toBe('falló\nfin\n')
    expect((await run(s, 'Get-Service NoExiste -ErrorAction SilentlyContinue; $Error.Count -gt 0')).out.trim()).toBe('True')
  })

  it('funciones con param, Mandatory, ValidateSet y splatting', async () => {
    const s = createPsSession()
    await run(s, 'function Saludar { param([Parameter(Mandatory)][string]$Nombre, [ValidateSet("Hola","Chau")][string]$Forma = "Hola") "$Forma, $Nombre" }')
    expect((await run(s, 'Saludar -Nombre Ana')).out.trim()).toBe('Hola, Ana')
    expect((await run(s, 'Saludar -Nombre Ana -Forma Buenas')).err).toMatch(/ValidateSet|does not belong to the set/)
    expect((await run(s, '$p = @{ Nombre = "Leo"; Forma = "Chau" }; Saludar @p')).out.trim()).toBe('Chau, Leo')
  })

  it('switch, for, -f y here-strings', async () => {
    const s = createPsSession()
    expect((await run(s, 'switch -Wildcard ("SRV-WEB01") { "SRV-DB*" { "base" } "SRV-WEB*" { "web" } default { "otro" } }')).out.trim()).toBe('web')
    expect((await run(s, '$t = 0; for ($i = 1; $i -le 4; $i++) { $t += $i }; $t')).out.trim()).toBe('10')
    expect((await run(s, '"{0,-6}|{1:N1}" -f "ab", 3.14159')).out.trim()).toBe('ab    |3.1')
    expect((await run(s, '$h = @"\nuno\ndos\n"@\n$h.Split("`n").Count')).out.trim()).toBe('2')
  })
})

describe('PowerShell: varios servidores', () => {
  it('Invoke-Command agrega PSComputerName y respeta $using:', async () => {
    const s = lab()
    const r = await run(s, '$svc = "Spooler"; Invoke-Command -ComputerName SRV01 -ScriptBlock { (Get-Service $using:svc).Status }')
    expect(r.out.trim()).toBe('Running')
    expect((await run(s, 'Invoke-Command -ComputerName SRV01 { hostname }')).out.trim()).toBe('SRV01')
    expect((await run(s, 'Invoke-Command -ComputerName SRV01 { Get-Service Spooler }')).out).toMatch(/PSComputerName[\s\S]*SRV01/)
  })

  it('errores reales de WinRM', async () => {
    const s = lab()
    expect((await run(s, 'Invoke-Command -ComputerName SRV02 { hostname }')).err).toMatch(/WinRM|cannot complete the operation/i)
    expect((await run(s, 'Invoke-Command -ComputerName 192.168.10.30 { hostname }')).err).toMatch(/TrustedHosts/)
    expect((await run(s, 'Invoke-Command -ComputerName NOEXISTE { hostname }')).err).toMatch(/cannot find the computer|NetworkPathNotFound/i)
  })

  it('una sesión guarda variables; -ComputerName no', async () => {
    const s = lab()
    await run(s, '$ses = New-PSSession -ComputerName SRV01')
    await run(s, 'Invoke-Command -Session $ses { $x = 42 }')
    expect((await run(s, 'Invoke-Command -Session $ses { $x }')).out.trim()).toBe('42')
    await run(s, 'Invoke-Command -ComputerName SRV01 { $y = 1 }')
    expect((await run(s, 'Invoke-Command -ComputerName SRV01 { $null -eq $y }')).out.trim()).toBe('True')
  })

  it('Enter-PSSession cambia el prompt y exit vuelve', async () => {
    const s = lab()
    await run(s, 'Enter-PSSession SRV01')
    expect(s.prompt()).toMatch(/^\[SRV01\]: PS /)
    expect((await run(s, 'hostname')).out.trim()).toBe('SRV01')
    await run(s, 'exit')
    expect(s.prompt()).not.toMatch(/\[SRV01\]/)
  })

  it('el firewall bloquea el ping por defecto pero deja pasar WinRM en el dominio', async () => {
    const s = lab()
    expect((await run(s, 'Test-NetConnection SRV01 -InformationLevel Quiet')).out).toMatch(/WARNING: Ping[\s\S]*False\s*$/)
    expect((await run(s, 'Test-NetConnection SRV01 -Port 5985 -InformationLevel Quiet')).out.trim()).toBe('True')
    expect((await run(s, 'ping SRV01')).out).toMatch(/Request timed out/)
  })
})

describe('PowerShell: configuración de un servidor', () => {
  const nuevo = () =>
    createPsSession({
      equipo: 'WIN-7H2K9Q',
      red: { ip: '169.254.12.34', dhcp: true, puerta_enlace: '' },
      discos: [{ numero: 1, tamano_gb: 100, modelo: 'Msft Virtual Disk', estilo: 'RAW', offline: true, bus: 'SCSI', particiones: [] }],
    })

  it('IP fija, DNS y nombre pendiente hasta reiniciar', async () => {
    const s = nuevo()
    expect((await run(s, 'ipconfig')).out).toMatch(/Autoconfiguration IPv4 Address[\s\S]*255\.255\.0\.0/)
    await run(s, 'New-NetIPAddress -InterfaceAlias Ethernet -IPAddress 192.168.10.20 -PrefixLength 24 -DefaultGateway 192.168.10.1')
    await run(s, 'Set-DnsClientServerAddress -InterfaceAlias Ethernet -ServerAddresses 192.168.10.10')
    expect(verifyPs(s, { ip: '192.168.10.20', prefijo: 24, puerta_enlace: '192.168.10.1', dns: ['192.168.10.10'] }).ok).toBe(true)
    expect((await run(s, 'New-NetIPAddress -InterfaceAlias Wifi -IPAddress 10.0.0.1')).err).toMatch(/InterfaceAlias/)

    expect((await run(s, 'Rename-Computer -NewName SRV-FS01')).all).toMatch(/restart the computer/)
    expect(verifyPs(s, { nombre_equipo: 'SRV-FS01', pendiente: true }).ok).toBe(true)
    expect(verifyPs(s, { nombre_equipo: 'SRV-FS01' }).ok).toBe(false)
    await run(s, 'Restart-Computer')
    expect((await run(s, 'hostname')).out.trim()).toBe('SRV-FS01')
    expect((await run(s, 'Rename-Computer -NewName "SRV FS"')).err).toMatch(/not valid/)
  })

  it('perfil de red: DomainAuthenticated no se puede elegir a mano', async () => {
    const s = nuevo()
    expect((await run(s, 'Set-NetConnectionProfile -InterfaceAlias Ethernet -NetworkCategory DomainAuthenticated')).err).toMatch(/set automatically/)
    await run(s, 'Set-NetConnectionProfile -InterfaceAlias Ethernet -NetworkCategory Private')
    expect(verifyPs(s, { perfil_red: 'Private' }).ok).toBe(true)
    const d = lab()
    expect((await run(d, 'Set-NetConnectionProfile -InterfaceAlias Ethernet -NetworkCategory Private')).err).toMatch(/DomainAuthenticated/)
  })

  it('firewall: reglas por grupo, reglas nuevas y verificación de acceso', async () => {
    const s = nuevo()
    expect(verifyPs(s, { permite: '3389/tcp', permite_acceso: false }).ok).toBe(true)
    await run(s, 'Enable-NetFirewallRule -DisplayGroup "Remote Desktop"')
    await run(s, 'Set-ItemProperty -Path "HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server" -Name fDenyTSConnections -Value 0')
    expect(verifyPs(s, { escritorio_remoto: true }).ok).toBe(true)
    expect(verifyPs(s, { permite: '3389/tcp', permite_acceso: true }).ok).toBe(true)

    await run(s, 'New-NetFirewallRule -DisplayName "App 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow')
    expect(verifyPs(s, { regla_firewall: 'App 8080', habilitada: true }).ok).toBe(true)
    expect((await run(s, 'Get-NetFirewallRule -DisplayName "App 8080" | Get-NetFirewallPortFilter | Select-Object -ExpandProperty LocalPort')).out.trim()).toBe('8080')
    expect((await run(s, 'New-NetFirewallRule -DisplayName x -LocalPort 80')).err).toMatch(/TCP and UDP/)
    expect((await run(s, 'Get-NetFirewallRule -DisplayName Nada')).err).toMatch(/No MSFT_NetFirewallRule objects found/)
  })

  it('disco nuevo: en línea, inicializar, particionar y formatear', async () => {
    const s = nuevo()
    expect((await run(s, 'Initialize-Disk -Number 1')).err).toMatch(/offline/)
    await run(s, 'Set-Disk -Number 1 -IsOffline $false')
    await run(s, 'Initialize-Disk -Number 1 -PartitionStyle GPT')
    expect(verifyPs(s, { disco: 1, estilo: 'GPT', offline: false }).ok).toBe(true)
    expect((await run(s, 'Initialize-Disk -Number 1')).err).toMatch(/already been initialized/)
    await run(s, 'New-Partition -DiskNumber 1 -UseMaximumSize -DriveLetter E | Format-Volume -FileSystem NTFS -NewFileSystemLabel Datos -Confirm:$false')
    expect(verifyPs(s, { volumen: 'E', sistema: 'NTFS', etiqueta: 'Datos', tamano_min_gb: 90 }).ok).toBe(true)
    expect((await run(s, 'New-Partition -DiskNumber 0 -Size 1GB -DriveLetter C')).err).toMatch(/capacity|in use/)
    expect((await run(s, 'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Measure-Object | Select-Object -ExpandProperty Count')).out.trim()).toBe('2')
  })

  it('zona horaria, política de ejecución y módulos', async () => {
    const s = nuevo()
    await run(s, 'Set-TimeZone -Id "Argentina Standard Time"')
    expect(verifyPs(s, { zona_horaria: 'Argentina Standard Time' }).ok).toBe(true)
    expect((await run(s, 'Set-TimeZone -Id "Marte"')).err).toMatch(/was not found/)

    await run(s, 'Set-ExecutionPolicy -Scope Process Bypass -Force')
    expect((await run(s, 'Get-ExecutionPolicy')).out.trim()).toBe('Bypass')
    expect((await run(s, 'Get-ExecutionPolicy -Scope LocalMachine')).out.trim()).toBe('RemoteSigned')

    expect((await run(s, 'Import-Module ImportExcel')).err).toMatch(/no valid module file/)
    expect((await run(s, 'Get-ADUser -Filter *')).err).toMatch(/is not recognized/)
    expect((await run(s, 'Install-Module ImportExcel')).err).toMatch(/Unable to resolve package source/)
  })
})

describe('PowerShell: detalles del lenguaje usados en el Nivel 3', () => {
  it('alias ? y %, [math]::Round con dos argumentos, if como valor y rutas', async () => {
    const s = createPsSession()
    expect((await run(s, '1,2,3 | ? { $_ -gt 1 } | % { $_ * 10 }')).out).toBe('20\n30\n')
    expect((await run(s, '[math]::Round(1500000 / 1MB, 2)')).out.trim()).toBe('1.43')
    expect((await run(s, '$h = @{ Estado = if (5 -lt 10) { "BAJO" } else { "OK" } }; $h.Estado')).out.trim()).toBe('BAJO')
    expect((await run(s, 'Join-Path C:\\Informes inventario.csv')).out.trim()).toBe('C:\\Informes\\inventario.csv')
    expect((await run(s, 'Split-Path C:\\Informes\\a.csv -Leaf')).out.trim()).toBe('a.csv')
    expect((await run(s, '(Get-Date).GetType().Name')).out.trim()).toBe('DateTime')
    expect((await run(s, '((Get-Date) - (Get-Date).AddDays(-3)).Days')).out.trim()).toBe('3')
    expect((await run(s, '[string]::Join("-", @("a","b"))')).out.trim()).toBe('a-b')
    expect((await run(s, 'Get-Service | Format-Table Name | Export-Csv C:\\Temp\\x.csv; Get-Content C:\\Temp\\x.csv | Select-Object -First 1')).out).toMatch(/FormatStartData/)
  })

  it('el editor marca errores de sintaxis y alias en un script', async () => {
    const { validateConfig } = await import('@/engines/config')
    const bad = validateConfig('powershell', 'param([int]$x = 1)\n$y = gci | ? { $_.Length -gt $x }\nif ($y {\n')
    expect(bad.diagnostics.some((d) => d.severity === 'error')).toBe(true)
    expect(bad.diagnostics.filter((d) => d.severity === 'warning').map((d) => d.message).join(' ')).toMatch(/gci.*Get-ChildItem|Where-Object/)
    expect(validateConfig('powershell', 'foreach ($a in 1..3) { Write-Output $a }').diagnostics).toEqual([])
  })
})
