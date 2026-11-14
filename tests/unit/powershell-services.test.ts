import { describe, expect, it } from 'vitest'
import { createPsSession, verifyPs } from '@/engines/powershell'

type S = ReturnType<typeof createPsSession>
const run = async (s: S, line: string) => {
  const r = await s.run(line)
  return {
    out: r.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join(''),
    err: r.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join(''),
  }
}

const dcState = {
  equipo: 'DC01',
  dominio: 'empresa.local',
  red: { ip: '192.168.10.10', dns: ['127.0.0.1'] },
  ad: {
    usuarios: [
      { sam: 'mlopez', nombre: 'María', grupos: ['GG-Ventas'] },
      { sam: 'jperez', nombre: 'Juan', grupos: ['GG-Compras'] },
    ],
    grupos: [{ nombre: 'GG-Ventas' }, { nombre: 'GG-Compras' }, { nombre: 'DL-Ventas-M', ambito: 'DomainLocal' as const, miembros: ['GG-Ventas'] }],
  },
}

describe('Servidor DNS', () => {
  it('zona inversa: nslookup pasa de UnKnown al nombre del servidor', async () => {
    const s = createPsSession(dcState)
    expect((await run(s, 'nslookup dc01')).out).toMatch(/Server: {2}UnKnown/)
    await run(s, 'Add-DnsServerPrimaryZone -NetworkId 192.168.10.0/24 -ReplicationScope Domain')
    await run(s, 'Add-DnsServerResourceRecordPtr -ZoneName 10.168.192.in-addr.arpa -Name 10 -PtrDomainName dc01.empresa.local')
    expect((await run(s, 'nslookup dc01')).out).toMatch(/Server: {2}dc01\.empresa\.local[\s\S]*Name: {4}dc01\.empresa\.local/)
    expect(verifyPs(s, { zona_dns: '10.168.192.in-addr.arpa', inversa: true, integrada_ad: true }).ok).toBe(true)
  })

  it('CNAME, reenviador condicional y limpieza de registros viejos', async () => {
    const s = createPsSession({
      ...dcState,
      dns: [{ nombre: 'www.socio.local', valor: '10.20.0.80' }],
      dns_servidor: { zonas: [{ nombre: 'empresa.local', registros: [{ nombre: 'pc-vieja', valor: '192.168.10.77', hace_dias: 40 }, { nombre: 'srv-web01', valor: '192.168.10.30' }] }] },
    })
    await run(s, 'Add-DnsServerResourceRecordCName -ZoneName empresa.local -Name intranet -HostNameAlias srv-web01.empresa.local')
    expect((await run(s, 'Resolve-DnsName intranet.empresa.local')).out).toMatch(/192\.168\.10\.30/)
    expect((await run(s, 'Resolve-DnsName www.socio.local')).err).toMatch(/DNS name does not exist/)
    await run(s, 'Add-DnsServerConditionalForwarderZone -Name socio.local -MasterServers 10.20.0.5 -ReplicationScope Forest')
    expect((await run(s, 'Resolve-DnsName www.socio.local')).out).toMatch(/10\.20\.0\.80/)
    expect((await run(s, 'Start-DnsServerScavenging -Force')).out).toMatch(/deshabilitada/)
    await run(s, 'Set-DnsServerScavenging -ScavengingState $true -ApplyOnAllZones')
    await run(s, 'Start-DnsServerScavenging -Force')
    expect(verifyPs(s, { registro_dns: 'pc-vieja.empresa.local', existe: false }).ok).toBe(true)
    expect(verifyPs(s, { registro_dns: 'srv-web01.empresa.local', valor: '192.168.10.30' }).ok).toBe(true)
  })
})

describe('Servidor DHCP', () => {
  const lab = () =>
    createPsSession({
      ...dcState,
      servidores: [
        { equipo: 'DC02', dominio: 'empresa.local', controlador_dominio: true, red: { ip: '192.168.10.11', dns: ['192.168.10.10'] } },
        { equipo: 'PC01', dominio: 'empresa.local', red: { ip: '169.254.1.1', prefijo: 16, dns: [], dhcp: true } },
      ],
    })

  it('sin autorizar no entrega; autorizado sí, con exclusiones y opciones', async () => {
    const s = lab()
    const pc = s.lab!.find('PC01')!
    await run(s, 'Install-WindowsFeature DHCP -IncludeManagementTools')
    await run(s, 'Add-DhcpServerv4Scope -Name Oficina -StartRange 192.168.10.100 -EndRange 192.168.10.199 -SubnetMask 255.255.255.0')
    await run(s, 'Add-DhcpServerv4ExclusionRange -ScopeId 192.168.10.0 -StartRange 192.168.10.100 -EndRange 192.168.10.109')
    expect((await run(s, 'Set-DhcpServerv4OptionValue -ScopeId 192.168.10.0 -DnsServer 192.168.10.99')).err).toMatch(/not a valid DNS server/)
    await run(s, 'Set-DhcpServerv4OptionValue -ScopeId 192.168.10.0 -Router 192.168.10.1 -DnsServer 192.168.10.10 -DnsDomain empresa.local')
    expect((await run(pc, 'ipconfig /renew')).out).toMatch(/unable to contact your DHCP server/)
    await run(s, 'Add-DhcpServerInDC -DnsName dc01.empresa.local -IPAddress 192.168.10.10')
    await run(pc, 'ipconfig /renew')
    expect(verifyPs(pc, { concesion_dhcp: true, direccion: '192.168.10.110', de: 'DC01' }).ok).toBe(true)
    expect(verifyPs(pc, { dns_cliente: ['192.168.10.10'] }).ok).toBe(true)
    expect(verifyPs(s, { ambito_dhcp: '192.168.10.0', excluye: '192.168.10.105', puerta_enlace: '192.168.10.1' }).ok).toBe(true)
  })

  it('con conmutación por error, si se cae uno atiende el otro', async () => {
    const s = lab()
    const pc = s.lab!.find('PC01')!
    for (const c of [
      'Install-WindowsFeature DHCP -IncludeManagementTools',
      'Add-DhcpServerInDC dc01.empresa.local 192.168.10.10',
      'Invoke-Command DC02 { Install-WindowsFeature DHCP -IncludeManagementTools }',
      'Add-DhcpServerInDC dc02.empresa.local 192.168.10.11',
      'Add-DhcpServerv4Scope -Name Oficina -StartRange 192.168.10.100 -EndRange 192.168.10.199 -SubnetMask 255.255.255.0',
      'Add-DhcpServerv4Failover -Name dc01-dc02 -PartnerServer DC02 -ScopeId 192.168.10.0 -LoadBalancePercent 50 -SharedSecret Secreto',
      'Stop-Service DHCPServer',
    ])
      await run(s, c)
    await run(pc, 'ipconfig /renew')
    expect(verifyPs(pc, { concesion_dhcp: true, de: 'DC02' }).ok).toBe(true)
    expect(verifyPs(s, { conmutacion_dhcp: 'DC02', modo: 'LoadBalance' }).ok).toBe(true)
  })
})

describe('Servidor de archivos', () => {
  const lab = () =>
    createPsSession({
      equipo: 'SRV-ARCH01',
      dominio: 'empresa.local',
      red: { ip: '192.168.10.20', dns: ['192.168.10.10'] },
      archivos: { 'D:\\Datos\\Ventas\\precios.xlsx': 'precios', 'D:\\Datos\\Compras\\proveedores.xlsx': 'prov' },
      servidores: [
        { ...dcState },
        { equipo: 'PC01', dominio: 'empresa.local', usuario: 'mlopez', red: { ip: '192.168.10.50', dns: ['192.168.10.10'] } },
      ],
    })

  it('NTFS + recurso compartido + enumeración basada en acceso, probado como usuario', async () => {
    const s = lab()
    const pc = s.lab!.find('PC01')!
    await run(s, "New-SmbShare -Name Datos -Path D:\\Datos -FullAccess 'Authenticated Users' -FolderEnumerationMode AccessBased")
    await run(s, "icacls D:\\Datos /inheritance:r /grant 'Administrators:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' 'EMPRESA\\Domain Users:RX'")
    await run(s, "icacls D:\\Datos\\Ventas /grant 'DL-Ventas-M:(OI)(CI)M'")
    const ls = (await run(pc, 'Get-ChildItem \\\\SRV-ARCH01\\Datos')).out
    expect(ls).toMatch(/Ventas/)
    expect(ls).not.toMatch(/Compras/)
    expect((await run(pc, 'Get-ChildItem \\\\SRV-ARCH01\\Datos\\Compras')).err).toMatch(/Access to the path .* is denied/)
    expect((await run(pc, "Set-Content \\\\SRV-ARCH01\\Datos\\Ventas\\nuevo.txt 'hola'")).err).toBe('')
    expect(verifyPs(s, { acceso_red: '\\\\SRV-ARCH01\\Datos\\Ventas', usuario: 'mlopez', nivel: 'Modify' }).ok).toBe(true)
    expect(verifyPs(s, { acceso_red: '\\\\SRV-ARCH01\\Datos\\Ventas', usuario: 'jperez', nivel: 'None' }).ok).toBe(true)
    // Recurso en solo lectura: gana el más restrictivo.
    await run(s, "Grant-SmbShareAccess -Name Datos -AccountName 'Authenticated Users' -AccessRight Read -Force")
    expect((await run(pc, "Set-Content \\\\SRV-ARCH01\\Datos\\Ventas\\otro.txt 'x'")).err).toMatch(/denied/)
    expect(verifyPs(s, { acceso_red: '\\\\SRV-ARCH01\\Datos\\Ventas', usuario: 'mlopez', nivel: 'ReadAndExecute' }).ok).toBe(true)
  })

  it('Get-Acl y Set-Acl con una regla nueva y sin herencia', async () => {
    const s = lab()
    await run(s, '$acl = Get-Acl D:\\Datos\\Compras')
    await run(s, '$acl.SetAccessRuleProtection($true, $false)')
    await run(s, "$r = New-Object System.Security.AccessControl.FileSystemAccessRule('EMPRESA\\GG-Compras', 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')")
    await run(s, '$acl.AddAccessRule($r)')
    await run(s, "$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new('Administrators', 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))")
    await run(s, 'Set-Acl -Path D:\\Datos\\Compras -AclObject $acl')
    expect(verifyPs(s, { herencia_ntfs: 'D:\\Datos\\Compras', habilitada: false }).ok).toBe(true)
    expect(verifyPs(s, { permiso_ntfs: 'D:\\Datos\\Compras', para: 'jperez', nivel: 'Modify' }).ok).toBe(true)
    expect(verifyPs(s, { permiso_ntfs: 'D:\\Datos\\Compras', para: 'mlopez', nivel: 'None' }).ok).toBe(true)
    expect((await run(s, 'icacls D:\\Datos\\Compras')).out).toMatch(/EMPRESA\\GG-Compras:\(OI\)\(CI\)\(M\)/)
  })

  it('cuotas, filtros de archivos y DFS', async () => {
    const s = lab()
    const pc = s.lab!.find('PC01')!
    await run(s, "New-SmbShare -Name Datos -Path D:\\Datos -FullAccess 'Authenticated Users'")
    await run(s, "icacls D:\\Datos\\Ventas /grant 'GG-Ventas:(OI)(CI)M'")
    await run(s, 'Install-WindowsFeature FS-Resource-Manager, FS-DFS-Namespace -IncludeManagementTools')
    await run(s, 'New-FsrmQuota -Path D:\\Datos\\Ventas -Size 1KB')
    await run(s, "New-FsrmFileScreen -Path D:\\Datos -IncludeGroup 'Audio and Video Files' -Active")
    expect((await run(pc, "Set-Content \\\\SRV-ARCH01\\Datos\\Ventas\\tema.mp3 'x'")).err).toMatch(/\\\\SRV-ARCH01\\Datos\\Ventas\\tema\.mp3' is denied/)
    expect((await run(pc, "Set-Content \\\\SRV-ARCH01\\Datos\\Ventas\\grande.txt ('x' * 2000)")).err).toMatch(/not enough space/)
    await run(s, 'New-Item -ItemType Directory D:\\DFSRoots\\Empresa')
    await run(s, 'New-SmbShare -Name Empresa -Path D:\\DFSRoots\\Empresa')
    await run(s, 'New-DfsnRoot -Path \\\\empresa.local\\Empresa -TargetPath \\\\SRV-ARCH01\\Empresa -Type DomainV2')
    await run(s, 'New-DfsnFolder -Path \\\\empresa.local\\Empresa\\Datos -TargetPath \\\\SRV-ARCH01\\Datos')
    expect((await run(pc, 'Get-ChildItem \\\\empresa.local\\Empresa\\Datos')).out).toMatch(/Ventas/)
    await run(pc, 'net use S: \\\\empresa.local\\Empresa\\Datos\\Ventas')
    expect(verifyPs(pc, { unidad_red: 'S:', ruta: '\\\\empresa.local\\Empresa\\Datos\\Ventas' }).ok).toBe(true)
    expect((await run(pc, 'Get-ChildItem S:\\')).out).toMatch(/precios\.xlsx/)
  })
})
