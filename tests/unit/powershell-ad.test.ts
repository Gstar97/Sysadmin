import { describe, expect, it } from 'vitest'
import { createPsSession, verifyPs } from '@/engines/powershell'
import { computeRsop } from '@/engines/gpo/rsop'

type S = ReturnType<typeof createPsSession>
const run = async (s: S, line: string) => {
  const r = await s.run(line)
  return {
    out: r.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join(''),
    err: r.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join(''),
  }
}

const DOM = 'DC=empresa,DC=local'

describe('RSoP: qué GPO gana', () => {
  const setting = (v: string) => [{ scope: 'User' as const, key: 'HKEY_CURRENT_USER\\X', valueName: 'T', value: v }]
  const gpo = (id: string, v: string, apply = ['Authenticated Users']) => ({ id, name: id, status: 'AllSettingsEnabled' as const, settings: setting(v), apply })
  const base = { domainDn: DOM, containerDn: `OU=Ventas,OU=Empresa,${DOM}`, principals: ['mlopez', 'GG-Ventas'], scope: 'User' as const }

  it('gana la más cercana; exigir en un contenedor de arriba da vuelta el resultado', () => {
    const links = (enforced: boolean) => [
      { gpoId: 'dominio', target: DOM, enabled: true, enforced: false, order: 1 },
      { gpoId: 'empresa', target: `OU=Empresa,${DOM}`, enabled: true, enforced, order: 1 },
      { gpoId: 'ventas', target: `OU=Ventas,OU=Empresa,${DOM}`, enabled: true, enforced: false, order: 1 },
    ]
    const gpos = [gpo('dominio', '1'), gpo('empresa', '2'), gpo('ventas', '3')]
    const normal = computeRsop({ ...base, gpos, links: links(false), blocked: [] })
    expect(normal.applied.map((e) => e.gpo.name)).toEqual(['ventas', 'empresa', 'dominio'])
    expect(normal.settings[0].gpo.name).toBe('ventas')
    expect(computeRsop({ ...base, gpos, links: links(true), blocked: [] }).settings[0].gpo.name).toBe('empresa')
  })

  it('el bloqueo de herencia corta lo de arriba salvo lo exigido', () => {
    const gpos = [gpo('dominio', '1'), gpo('ventas', '3')]
    const links = (enforced: boolean) => [
      { gpoId: 'dominio', target: DOM, enabled: true, enforced, order: 1 },
      { gpoId: 'ventas', target: `OU=Ventas,OU=Empresa,${DOM}`, enabled: true, enforced: false, order: 1 },
    ]
    const blocked = [`OU=Ventas,OU=Empresa,${DOM}`]
    expect(computeRsop({ ...base, gpos, links: links(false), blocked }).applied.map((e) => e.gpo.name)).toEqual(['ventas'])
    const enforced = computeRsop({ ...base, gpos, links: links(true), blocked })
    expect(enforced.applied.map((e) => e.gpo.name)).toEqual(['dominio', 'ventas'])
    expect(enforced.settings[0].gpo.name).toBe('dominio')
  })

  it('orden de vínculos, filtrado de seguridad, vínculo deshabilitado y lectura del equipo', () => {
    const gpos = [gpo('a', '1'), gpo('b', '2', ['GG-Compras']), gpo('c', '3')]
    const links = [
      { gpoId: 'a', target: `OU=Ventas,OU=Empresa,${DOM}`, enabled: true, enforced: false, order: 1 },
      { gpoId: 'c', target: `OU=Ventas,OU=Empresa,${DOM}`, enabled: true, enforced: false, order: 2 },
      { gpoId: 'b', target: `OU=Ventas,OU=Empresa,${DOM}`, enabled: false, enforced: false, order: 3 },
    ]
    const r = computeRsop({ ...base, gpos, links, blocked: [] })
    expect(r.settings[0].gpo.name).toBe('a')
    expect(r.filtered.find((f) => f.gpo.name === 'b')?.reason).toBe('Disabled (Link)')
    links[2].enabled = true
    expect(computeRsop({ ...base, gpos, links, blocked: [] }).filtered.find((f) => f.gpo.name === 'b')?.reason).toBe('Denied (Security)')
    // Si el equipo no puede leer la GPO de usuario, no se aplica (MS16-072).
    const onlyGroup = [{ ...gpo('a', '1', ['GG-Ventas']), readers: [] }]
    const r2 = computeRsop({ ...base, gpos: onlyGroup, links: [links[0]], blocked: [], computerPrincipals: ['PC01', 'Domain Computers'] })
    expect(r2.filtered[0]?.reason).toBe('Denied (Security)')
  })
})

describe('Active Directory: crear el dominio y operarlo', () => {
  it('Install-ADDSForest pide el rol, valida el nombre y deja un DC funcionando', async () => {
    const s = createPsSession({ equipo: 'DC01', red: { ip: '192.168.10.10', dns: ['192.168.10.10'] } })
    expect((await run(s, 'Install-ADDSForest -DomainName empresa.local')).err).toMatch(/not recognized/)
    await run(s, 'Install-WindowsFeature AD-Domain-Services -IncludeManagementTools')
    expect((await run(s, 'Install-ADDSForest -DomainName empresa')).err).toMatch(/single-label/)
    expect((await run(s, 'Install-ADDSForest -DomainName empresa.local -SafeModeAdministratorPassword "texto"')).err).toMatch(/SecureString/)
    await run(s, '$pw = ConvertTo-SecureString "Dsrm.2026!" -AsPlainText -Force')
    const r = await run(s, 'Install-ADDSForest -DomainName empresa.local -InstallDns -SafeModeAdministratorPassword $pw -Force')
    expect(r.out).toMatch(/Operation completed successfully/)
    expect(verifyPs(s, { es_controlador: true }).ok).toBe(true)
    expect((await run(s, '(Get-ADForest).ForestMode')).out.trim()).toBe('Windows2025Forest')
    expect((await run(s, 'Resolve-DnsName -Type SRV _ldap._tcp.dc._msdcs.empresa.local')).out).toMatch(/dc01\.empresa\.local/)
    expect((await run(s, 'dcdiag')).out).toMatch(/DC01 passed test Replications/)
    expect((await run(s, 'netdom query fsmo')).out).toMatch(/PDC\s+DC01\.empresa\.local/)
  })

  const domainLab = () =>
    createPsSession({
      equipo: 'DC02',
      red: { ip: '192.168.10.11', dns: ['192.168.10.10'] },
      caracteristicas: [{ nombre: 'AD-Domain-Services', nombre_visible: 'Active Directory Domain Services', instalada: true }],
      modulos: ['ADDSDeployment'],
      servidores: [
        { equipo: 'DC01', dominio: 'empresa.local', red: { ip: '192.168.10.10', dns: ['127.0.0.1'] }, ad: { ous: ['Empresa/Equipos'], usuarios: [{ sam: 'mlopez', nombre: 'María', apellido: 'López', grupos: ['GG-Ventas'] }] } },
        { equipo: 'PC01', red: { ip: '192.168.10.50', dns: ['8.8.8.8'] } },
      ],
    })

  it('segundo controlador, réplica, FSMO y falla de réplica', async () => {
    const s = domainLab()
    expect((await run(s, 'Install-ADDSDomainController -DomainName empresa.local -Force')).err).toMatch(/Credential/)
    await run(s, 'Install-ADDSDomainController -DomainName empresa.local -InstallDns -Credential (Get-Credential EMPRESA\\Administrador) -Force')
    expect((await run(s, '(Get-ADDomainController -Filter *).Count')).out.trim()).toBe('2')
    await run(s, 'Move-ADDirectoryServerOperationMasterRole -Identity DC02 -OperationMasterRole PDCEmulator -Confirm:$false')
    expect(verifyPs(s, { fsmo: 'PDCEmulator', en_equipo: 'DC02' }).ok).toBe(true)
    expect((await run(s, 'repadmin /replsummary')).out).not.toMatch(/1722/)
    await run(s, 'Invoke-Command DC01 { Stop-Service NTDS -Force }')
    expect((await run(s, 'repadmin /replsummary')).out).toMatch(/\(1722\) The RPC server is unavailable/)
    expect((await run(s, 'Move-ADDirectoryServerOperationMasterRole -Identity DC02 -OperationMasterRole RIDMaster -Confirm:$false')).err).toMatch(/could not be contacted/)
    await run(s, 'Move-ADDirectoryServerOperationMasterRole -Identity DC02 -OperationMasterRole RIDMaster -Force -Confirm:$false')
    expect(verifyPs(s, { fsmo: 'RIDMaster', en_equipo: 'DC02' }).ok).toBe(true)
  })

  it('unir un cliente: con DNS público falla; con el DC como DNS se une al reiniciar', async () => {
    const s = createPsSession({
      equipo: 'PC01',
      red: { ip: '192.168.10.50', dns: ['8.8.8.8'] },
      servidores: [{ equipo: 'DC01', dominio: 'empresa.local', red: { ip: '192.168.10.10', dns: ['127.0.0.1'] }, ad: { ous: ['Empresa/Equipos'] } }],
    })
    expect((await run(s, 'nslookup empresa.local')).out).toMatch(/Non-existent domain/)
    expect((await run(s, 'Add-Computer -DomainName empresa.local')).err).toMatch(/does not exist or could not be contacted/)
    await run(s, 'Set-DnsClientServerAddress -InterfaceAlias Ethernet -ServerAddresses 192.168.10.10')
    expect((await run(s, 'nltest /dsgetdc:empresa.local')).out).toMatch(/DC: \\\\DC01\.empresa\.local/)
    await run(s, 'Add-Computer -DomainName empresa.local -OUPath "OU=Equipos,OU=Empresa,DC=empresa,DC=local" -Credential EMPRESA\\Administrador')
    expect(verifyPs(s, { unido_a: 'empresa.local' }).ok).toBe(false)
    await run(s, 'Restart-Computer')
    expect(verifyPs(s, { unido_a: 'empresa.local' }).ok).toBe(true)
    expect((await run(s, 'Test-ComputerSecureChannel')).out.trim()).toBe('True')
    expect((await run(s, 'klist')).out).toMatch(/Cached Tickets: \(2\)/)
  })

  it('Kerberos y la hora: con el reloj corrido no hay tickets; w32tm /resync lo arregla', async () => {
    const s = createPsSession({
      equipo: 'PC01',
      dominio: 'empresa.local',
      desfase_reloj_min: 12,
      red: { ip: '192.168.10.50', dns: ['192.168.10.10'] },
      servidores: [{ equipo: 'DC01', dominio: 'empresa.local', red: { ip: '192.168.10.10', dns: ['127.0.0.1'] }, ad: {} }],
    })
    expect((await run(s, 'klist')).out).toMatch(/Cached Tickets: \(0\)/)
    expect((await run(s, 'gpupdate /force')).out).toMatch(/could not authenticate/)
    expect((await run(s, 'w32tm /query /source')).out.trim()).toBe('DC01.empresa.local')
    expect((await run(s, 'w32tm /resync')).out).toMatch(/completed successfully/)
    expect(verifyPs(s, { reloj_desfase_max: 5 }).ok).toBe(true)
    expect((await run(s, 'gpupdate /force')).out).toMatch(/User Policy update has completed successfully/)
  })

  it('papelera de reciclaje: sin activarla el objeto vuelve vacío; activada vuelve entero', async () => {
    const s = createPsSession({ equipo: 'DC01', dominio: 'empresa.local', ad: { usuarios: [{ sam: 'mlopez', nombre: 'María', departamento: 'Ventas', grupos: ['GG-Ventas'] }, { sam: 'jperez', nombre: 'Juan', departamento: 'Compras', grupos: ['GG-Compras'] }] } })
    await run(s, 'Remove-ADUser mlopez -Confirm:$false')
    await run(s, 'Get-ADObject -Filter \'SamAccountName -eq "mlopez"\' -IncludeDeletedObjects | Restore-ADObject')
    expect(verifyPs(s, { usuario_ad: 'mlopez', habilitado: false }).ok).toBe(true)
    expect(verifyPs(s, { usuario_ad: 'mlopez', en_grupos: ['GG-Ventas'] }).ok).toBe(false)

    await run(s, 'Enable-ADOptionalFeature "Recycle Bin Feature" -Scope ForestOrConfigurationSet -Target empresa.local -Confirm:$false')
    expect(verifyPs(s, { papelera_ad: true }).ok).toBe(true)
    await run(s, 'Remove-ADUser jperez -Confirm:$false')
    expect((await run(s, 'Get-ADObject -Filter \'isDeleted -eq $true\' -IncludeDeletedObjects | Select-Object -ExpandProperty Name')).out).toMatch(/Juan\s+DEL:/)
    await run(s, 'Get-ADObject -Filter \'SamAccountName -eq "jperez"\' -IncludeDeletedObjects | Restore-ADObject')
    expect(verifyPs(s, { usuario_ad: 'jperez', habilitado: true, en_grupos: ['GG-Compras'], departamento: 'Compras' }).ok).toBe(true)
  })

  it('gMSA: hace falta la clave de KDS y el equipo tiene que estar autorizado (y reiniciar)', async () => {
    const s = createPsSession({
      equipo: 'SRV-WEB',
      dominio: 'empresa.local',
      modulos: ['ActiveDirectory'],
      red: { ip: '192.168.10.20', dns: ['192.168.10.10'] },
      servidores: [{ equipo: 'DC01', dominio: 'empresa.local', red: { ip: '192.168.10.10', dns: ['127.0.0.1'] }, ad: { grupos: [{ nombre: 'Servidores-Web' }] } }],
    })
    s.data.ad = s.data.domainStore
    expect((await run(s, 'New-ADServiceAccount svc-web -DNSHostName svc-web.empresa.local -PrincipalsAllowedToRetrieveManagedPassword Servidores-Web')).err).toMatch(/Key does not exist/)
    await run(s, 'Add-KdsRootKey -EffectiveTime ((Get-Date).AddHours(-10))')
    await run(s, 'New-ADServiceAccount svc-web -DNSHostName svc-web.empresa.local -PrincipalsAllowedToRetrieveManagedPassword Servidores-Web')
    expect(verifyPs(s, { cuenta_servicio: 'svc-web' }).ok).toBe(true)
    await run(s, 'Add-ADGroupMember Servidores-Web -Members SRV-WEB$')
    expect((await run(s, 'Test-ADServiceAccount svc-web')).out).toMatch(/False/)
    await run(s, 'klist -li 0x3e7 purge')
    expect((await run(s, 'Test-ADServiceAccount svc-web')).out.trim()).toBe('True')
    await run(s, 'Install-ADServiceAccount svc-web')
    expect(verifyPs(s, { cuenta_servicio: 'svc-web', instalada: true }).ok).toBe(true)
  })

  it('directiva de contraseñas del dominio y FGPP', async () => {
    const s = createPsSession({ equipo: 'DC01', dominio: 'empresa.local', ad: { usuarios: [{ sam: 'admin.it', nombre: 'Admin', grupos: ['GG-Admins'] }] } })
    await run(s, 'Set-ADDefaultDomainPasswordPolicy -Identity empresa.local -MinPasswordLength 12 -LockoutThreshold 5')
    expect(verifyPs(s, { politica_contrasenas: { longitud_minima: 12, umbral_bloqueo: 5 } }).ok).toBe(true)
    await run(s, 'New-ADFineGrainedPasswordPolicy -Name "PSO-Admins" -Precedence 10 -MinPasswordLength 16')
    await run(s, 'Add-ADFineGrainedPasswordPolicySubject PSO-Admins -Subjects GG-Admins')
    expect(verifyPs(s, { politica_resultante: 'admin.it', politica: 'PSO-Admins' }).ok).toBe(true)
    expect((await run(s, 'Remove-ADFineGrainedPasswordPolicy PSO-Admins -Confirm:$false')).err).toMatch(/Access is denied/)
  })
})

describe('Directivas de grupo en la terminal', () => {
  const lab = () =>
    createPsSession({
      equipo: 'DC01',
      dominio: 'empresa.local',
      red: { ip: '192.168.10.10', dns: ['127.0.0.1'] },
      ad: {
        ous: ['Empresa/Ventas'],
        usuarios: [{ sam: 'mlopez', nombre: 'María', apellido: 'López', ou: 'Empresa/Ventas', grupos: ['GG-Ventas'] }],
        equipos: [{ nombre: 'PC01', ou: 'Empresa/Ventas' }],
        gpos: [{ nombre: 'Empresa - Protector', vinculos: [{ a: 'Empresa' }], configuracion: [{ clave: 'HKCU\\Software\\Policies\\Microsoft\\Windows\\Control Panel\\Desktop', valor_nombre: 'ScreenSaveTimeOut', valor: '900' }] }],
      },
      servidores: [{ equipo: 'PC01', dominio: 'empresa.local', usuario: 'mlopez', red: { ip: '192.168.10.50', dns: ['192.168.10.10'] } }],
    })
  const key = 'HKCU\\Software\\Policies\\Microsoft\\Windows\\Control Panel\\Desktop'

  it('crear, configurar y vincular; el cliente no lo ve hasta gpupdate', async () => {
    const s = lab()
    await run(s, 'New-GPO -Name "Ventas - Protector"')
    await run(s, `Set-GPRegistryValue -Name "Ventas - Protector" -Key "${key}" -ValueName ScreenSaveTimeOut -Type String -Value 300`)
    await run(s, 'New-GPLink -Name "Ventas - Protector" -Target "OU=Ventas,OU=Empresa,DC=empresa,DC=local"')
    expect(verifyPs(s, { gpo: 'Ventas - Protector', vinculada_a: 'Empresa/Ventas', configura: { clave: key, valor_nombre: 'ScreenSaveTimeOut', valor: '300' } }).ok).toBe(true)
    expect(verifyPs(s, { gpo_ganadora: 'Ventas - Protector', a: 'mlopez', clave: key, valor_nombre: 'ScreenSaveTimeOut' }).ok).toBe(true)
    expect((await run(s, 'Invoke-Command PC01 { gpresult /r /scope user }')).out).not.toMatch(/Ventas - Protector/)
    expect((await run(s, 'Invoke-Command PC01 { gpupdate /force; gpresult /r /scope user }')).out).toMatch(/Ventas - Protector/)
    expect((await run(s, 'New-GPLink -Name "Ventas - Protector" -Target "CN=Users,DC=empresa,DC=local"')).err).toMatch(/not valid/)
  })

  it('exigir, bloquear herencia y filtrar por grupo', async () => {
    const s = lab()
    await run(s, 'New-GPO -Name "Ventas - Protector"')
    await run(s, `Set-GPRegistryValue -Name "Ventas - Protector" -Key "${key}" -ValueName ScreenSaveTimeOut -Type String -Value 300`)
    await run(s, 'New-GPLink -Name "Ventas - Protector" -Target "OU=Ventas,OU=Empresa,DC=empresa,DC=local"')
    await run(s, 'Set-GPLink -Name "Empresa - Protector" -Target "OU=Empresa,DC=empresa,DC=local" -Enforced Yes')
    expect(verifyPs(s, { gpo_ganadora: 'Empresa - Protector', a: 'mlopez', clave: key, valor_nombre: 'ScreenSaveTimeOut' }).ok).toBe(true)
    await run(s, 'Set-GPLink -Name "Empresa - Protector" -Target "OU=Empresa,DC=empresa,DC=local" -Enforced No')
    await run(s, 'Set-GPInheritance -Target "OU=Ventas,OU=Empresa,DC=empresa,DC=local" -IsBlocked Yes')
    expect(verifyPs(s, { herencia_bloqueada: 'Empresa/Ventas' }).ok).toBe(true)
    expect(verifyPs(s, { gpo_aplicada: 'Empresa - Protector', a: 'mlopez', aplicada: false }).ok).toBe(true)
    await run(s, 'Set-GPPermission -Name "Ventas - Protector" -TargetName "Authenticated Users" -TargetType Group -PermissionLevel GpoRead -Replace')
    await run(s, 'Set-GPPermission -Name "Ventas - Protector" -TargetName "GG-Ventas" -TargetType Group -PermissionLevel GpoApply')
    expect(verifyPs(s, { gpo_aplicada: 'Ventas - Protector', a: 'mlopez' }).ok).toBe(true)
    await run(s, 'Set-GPPermission -Name "Ventas - Protector" -TargetName "Authenticated Users" -TargetType Group -PermissionLevel None -Replace')
    expect((await run(s, 'Invoke-Command PC01 { gpupdate /force; gpresult /r /scope user }')).out).toMatch(/Ventas - Protector\s+Filtering:\s+Denied \(Security\)/)
  })

  it('(Get-GPO X).GpoStatus = ... cambia la GPO, y valida el valor', async () => {
    const s = lab()
    await run(s, "(Get-GPO 'Empresa - Protector').GpoStatus = 'ComputerSettingsDisabled'")
    expect((await run(s, "(Get-GPO 'Empresa - Protector').GpoStatus")).out.trim()).toBe('ComputerSettingsDisabled')
    const r = await run(s, "(Get-GPO 'Empresa - Protector').GpoStatus = 'Nada'")
    expect(r.err).toMatch(/Exception setting "GpoStatus"/)
    expect(r.err).toMatch(/\+ \(Get-GPO 'Empresa - Protector'\)\.GpoStatus = 'Nada'/)
    expect((await run(s, "Set-GPO 'Empresa - Protector' -GpoStatus AllSettingsEnabled")).err).toMatch(/not recognized/)
  })

  it('respaldo y restauración: la GPO borrada vuelve sin vínculos', async () => {
    const s = lab()
    await run(s, 'New-Item -ItemType Directory C:\\Backups')
    await run(s, 'Backup-GPO -Name "Empresa - Protector" -Path C:\\Backups')
    await run(s, 'Remove-GPO -Name "Empresa - Protector"')
    expect(verifyPs(s, { gpo: 'Empresa - Protector', existe: false }).ok).toBe(true)
    const r = await run(s, 'Restore-GPO -Name "Empresa - Protector" -Path C:\\Backups')
    expect(r.out).toMatch(/sin vínculos/)
    expect(verifyPs(s, { gpo: 'Empresa - Protector', vinculada_a: 'Empresa' }).ok).toBe(false)
  })
})

describe('Comandos clásicos y Select-String', () => {
  it('nslookup -type=srv, ping -n y Select-String', async () => {
    const s = createPsSession({ equipo: 'DC01', dominio: 'empresa.local', red: { ip: '192.168.10.10', dns: ['127.0.0.1'] }, ad: {} })
    expect((await run(s, 'nslookup -type=srv _ldap._tcp.dc._msdcs.empresa.local')).out).toMatch(/svr hostname\s+= dc01\.empresa\.local/)
    expect((await run(s, 'ping -n 2 127.0.0.1')).out).toMatch(/Sent = 2/)
    expect((await run(s, 'ipconfig /all | Select-String "DNS Servers"')).out).toMatch(/DNS Servers.*127\.0\.0\.1/)
    expect((await run(s, '"uno","dos","tres" | Select-String -Pattern "^d" | ForEach-Object Line')).out.trim()).toBe('dos')
    expect((await run(s, '"uno" | Select-String -Pattern "x" -Quiet')).out.trim()).toBe('False')
  })
})
