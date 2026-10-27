import { describe, expect, it } from 'vitest'
import { createPsSession, verifyPs } from '@/engines/powershell'

const out = async (s: ReturnType<typeof createPsSession>, line: string) => {
  const r = await s.run(line)
  return { out: r.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join(''), err: r.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join('') }
}

describe('PowerShell', () => {
  it('pipeline de objetos', async () => {
    const s = createPsSession()
    expect((await out(s, '1..10 | Where-Object { $_ % 2 -eq 0 } | Measure-Object -Sum | Select-Object -ExpandProperty Sum')).out.trim()).toBe('30')
    expect((await out(s, "(Get-Service -Name Spooler).Status")).out.trim()).toBe('Running')
    expect((await out(s, 'Get-Service | Where-Object Status -eq Stopped | Select-Object -First 1 -ExpandProperty Name')).out.trim()).toBe('BITS')
    expect((await out(s, '"a,b,c" -split ","')).out).toBe('a\nb\nc\n')
    expect((await out(s, 'gsv spooler | Stop-Service -PassThru')).out).toMatch(/Stopped\s+Spooler/)
  })

  it('errores con el formato de Windows PowerShell', async () => {
    const s = createPsSession()
    const r = await out(s, 'Get-Servise')
    expect(r.err).toMatch(/The term 'Get-Servise' is not recognized/)
    expect(r.err).toMatch(/CategoryInfo\s+: ObjectNotFound/)
    expect((await out(s, 'Get-Service -Name NoExiste')).err).toMatch(/Cannot find any service with service name 'NoExiste'/)
  })

  it('archivos y CSV', async () => {
    const s = createPsSession()
    await out(s, 'New-Item -ItemType Directory C:\\Informes')
    await out(s, 'Get-Service | Select-Object Name, Status | Export-Csv C:\\Informes\\servicios.csv -NoTypeInformation')
    expect(verifyPs(s, { archivo: 'C:\\Informes\\servicios.csv', existe: true, contenido_incluye: '"Name","Status"' }).ok).toBe(true)
    expect((await out(s, '(Import-Csv C:\\Informes\\servicios.csv | Where-Object Status -eq Running).Count')).out.trim()).toMatch(/^\d+$/)
  })

  it('Active Directory', async () => {
    const s = createPsSession({ dominio: 'empresa.local', ad: { ous: ['Empresa/IT'], usuarios: [{ sam: 'mlopez', nombre: 'María', apellido: 'López', ou: 'Empresa/IT', habilitado: false }] } })
    expect((await out(s, 'Get-ADUser -Filter {Enabled -eq $false} | Select-Object -ExpandProperty SamAccountName')).out).toMatch(/mlopez/)
    const sinClave = await out(s, 'New-ADUser -Name "Ana Ruiz" -SamAccountName aruiz -Enabled $true')
    expect(sinClave.err).toMatch(/password/)
    const textoPlano = await out(s, 'New-ADUser -Name "Ana Ruiz" -SamAccountName aruiz -AccountPassword "Clave.2026" -Enabled $true')
    expect(textoPlano.err).toMatch(/SecureString/)
    await out(s, 'New-ADUser -Name "Ana Ruiz" -SamAccountName aruiz -Path "OU=IT,OU=Empresa,DC=empresa,DC=local" -AccountPassword (ConvertTo-SecureString "Clave.2026" -AsPlainText -Force) -Enabled $true')
    await out(s, 'New-ADGroup -Name GG-IT -GroupScope Global -Path "OU=IT,OU=Empresa,DC=empresa,DC=local"')
    await out(s, 'Add-ADGroupMember GG-IT -Members aruiz,mlopez')
    expect(verifyPs(s, { usuario_ad: 'aruiz', existe: true, habilitado: true, ou: 'Empresa/IT', en_grupos: ['GG-IT'] }).ok).toBe(true)
    expect((await out(s, 'Remove-ADOrganizationalUnit "OU=IT,OU=Empresa,DC=empresa,DC=local"')).err).toMatch(/Access is denied/)
    expect((await out(s, 'Get-ADUser -Filter "Name -match \'a\'"')).err).toMatch(/Error parsing query/)
  })

  it('sin dominio, los cmdlets de AD no existen', async () => {
    const s = createPsSession()
    expect((await out(s, 'Get-ADUser -Filter *')).err).toMatch(/is not recognized/)
  })
})
