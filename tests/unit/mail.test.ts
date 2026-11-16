import { describe, expect, it } from 'vitest'
import { createBashSession, stripAnsi, verifyBash } from '@/engines/shell'
import type { BashStateInput } from '@/engines/shell/schema'

const base = (distro: 'rocky' | 'ubuntu'): BashStateInput => ({
  distro,
  hostname: 'web01',
  usuario: 'ana',
  usuarios: [{ nombre: 'ana', sudo: true, uid: 1001 }],
  paquetes: { instalados: distro === 'rocky' ? ['postfix', 's-nail', 'bind-utils'] : ['postfix', 'mailutils'] },
  servicios: { postfix: { activo: true, habilitado: true } },
  red: {
    interfaces: [{ nombre: 'enp0s3', ip: '192.168.10.11/24', estado: 'UP' }],
    puerta_enlace: '192.168.10.1',
    dns: ['192.168.10.1'],
    registros_dns: {
      'MX gmail.com': '5 gmail-smtp-in.l.google.com',
      'TXT ejemplo.com.ar': 'v=spf1 include:_spf.proveedor.com -all\ngoogle-site-verification=abc',
      'TXT _dmarc.ejemplo.com.ar': 'v=DMARC1; p=quarantine; rua=mailto:dmarc@ejemplo.com.ar',
    },
  },
  correo: { relays: [{ servidor: 'smtp.proveedor.com', ip: '203.0.113.25', puerto: 587, usuario: 'notificaciones@ejemplo.com.ar', clave: 'Not-2026', remitentes: ['notificaciones@ejemplo.com.ar'] }] },
})

async function session(st: BashStateInput) {
  const sh = createBashSession(st)
  const run = async (cmd: string) => {
    const r = await sh.run(cmd)
    return { out: stripAnsi(r.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join('')), err: stripAnsi(r.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join('')) }
  }
  return { sh, run }
}

describe('Correo', () => {
  it('alias y entrega local; el puerto 25 bloqueado deja el correo en la cola', async () => {
    const { sh, run } = await session(base('rocky'))
    await run("echo 'root: ana' | sudo tee -a /etc/aliases && sudo newaliases")
    await run("echo 'disco al 91%' | mail -s 'Aviso' root")
    const mbox = (await run('sudo cat /var/spool/mail/ana')).out
    expect(mbox).toContain('Subject: Aviso')
    expect(mbox).toContain('disco al 91%')
    expect((await run('sudo grep orig_to /var/log/maillog')).out).toContain('orig_to=<root>, relay=local')
    await run("echo hola | mail -s Afuera soporte@gmail.com")
    expect((await run('mailq')).out).toContain('(connect to gmail-smtp-in.l.google.com[142.250.0.27]:25: Connection timed out)')
    expect(verifyBash(sh, { correo_enviado: 'soporte@gmail.com', estado: 'deferred' }).ok).toBe(true)
    expect(verifyBash(sh, { cola_vacia: false }).ok).toBe(true)
    expect((await run('sudo ss -tlnp')).out).toContain('127.0.0.1:25')
  })

  it('relay autenticado en Rocky 10: lmdb, noanonymous, cyrus-sasl-plain y el remitente', async () => {
    const { sh, run } = await session(base('rocky'))
    await run("sudo postconf -e 'relayhost = [smtp.proveedor.com]:587' 'smtp_sasl_auth_enable = yes' 'smtp_sasl_password_maps = hash:/etc/postfix/sasl_passwd'")
    await run("echo '[smtp.proveedor.com]:587 notificaciones@ejemplo.com.ar:Not-2026' | sudo tee /etc/postfix/sasl_passwd")
    expect((await run('sudo postmap hash:/etc/postfix/sasl_passwd')).err).toContain('unsupported dictionary type: hash')
    await run("sudo postconf -e 'smtp_sasl_password_maps = lmdb:/etc/postfix/sasl_passwd' && sudo postmap lmdb:/etc/postfix/sasl_passwd")
    expect((await run('ls /etc/postfix')).out).toContain('sasl_passwd.lmdb')
    await run('echo x | mail -s 1 soporte@gmail.com')
    expect((await run('mailq')).out).toContain('no mechanism available')
    await run("sudo postconf -e 'smtp_sasl_security_options = noanonymous' && sudo dnf install -y cyrus-sasl-plain && sudo postsuper -d ALL")
    await run('echo x | mail -s 2 soporte@gmail.com')
    expect((await run('sudo grep status=bounced /var/log/maillog')).out).toContain('553 5.7.1 <ana@web01.localdomain>: Sender address rejected')
    expect((await run('sudo cat /var/spool/mail/ana')).out).toContain('Undelivered Mail Returned to Sender')
    await run("echo '@web01.localdomain notificaciones@ejemplo.com.ar' | sudo tee /etc/postfix/generic && sudo postmap /etc/postfix/generic && sudo postconf -e 'smtp_generic_maps = lmdb:/etc/postfix/generic'")
    await run('echo x | mail -s 3 soporte@gmail.com')
    expect(verifyBash(sh, { correo_enviado: 'soporte@gmail.com', estado: 'sent', via: 'smtp.proveedor.com' }).ok).toBe(true)
    expect((await run('mailq')).out).toBe('Mail queue is empty\n')
  })

  it('Ubuntu usa hash y mail.log; un mapa sin postmap no se puede leer', async () => {
    const { sh, run } = await session(base('ubuntu'))
    expect((await run('postconf -h default_database_type myorigin')).out).toBe('hash\n/etc/mailname\n')
    await run("sudo postconf -e 'relayhost = [smtp.proveedor.com]:587' 'smtp_sasl_auth_enable = yes' 'smtp_sasl_password_maps = hash:/etc/postfix/sasl_passwd' 'smtp_sasl_security_options = noanonymous'")
    await run("echo '[smtp.proveedor.com]:587 notificaciones@ejemplo.com.ar:Not-2026' | sudo tee /etc/postfix/sasl_passwd")
    await run("echo x | mail -s 1 -a 'From: notificaciones@ejemplo.com.ar' soporte@gmail.com")
    expect((await run('sudo grep warning /var/log/mail.log')).out).toContain('open database /etc/postfix/sasl_passwd.db: No such file or directory')
    await run('sudo postmap /etc/postfix/sasl_passwd && sudo postqueue -f')
    expect(verifyBash(sh, { correo_enviado: 'soporte@gmail.com', estado: 'sent' }).ok).toBe(true)
  })

  it('dig y host muestran SPF y DMARC', async () => {
    const { run } = await session(base('rocky'))
    expect((await run('dig +short TXT ejemplo.com.ar')).out).toBe('"v=spf1 include:_spf.proveedor.com -all"\n"google-site-verification=abc"\n')
    expect((await run('host -t TXT _dmarc.ejemplo.com.ar')).out).toBe('_dmarc.ejemplo.com.ar descriptive text "v=DMARC1; p=quarantine; rua=mailto:dmarc@ejemplo.com.ar"\n')
  })
})
