import { describe, expect, it } from 'vitest'
import { createBashSession, stripAnsi } from '@/engines/shell'
import { parseSmbConf } from '@/engines/shell/samba'
import type { BashStateInput } from '@/engines/shell/schema'

const SHARE = '\n[conta]\n\tcomment = Contabilidad\n\tpath = /srv/samba/conta\n\tvalid users = @contabilidad\n\twritable = yes\n\tcreate mask = 0660\n\tdirectory mask = 2770\n'

function state(extra: Partial<BashStateInput['servidores'] extends (infer T)[] | undefined ? T : never> = {}): BashStateInput {
  return {
    distro: 'rocky',
    hostname: 'web01',
    usuario: 'ana',
    usuarios: [{ nombre: 'ana', sudo: true, uid: 1001 }],
    paquetes: { instalados: ['samba-client', 'cifs-utils'] },
    red: { interfaces: [{ nombre: 'enp0s3', ip: '192.168.10.11/24', estado: 'UP' }] },
    archivos: { '/home/ana/informe.txt': 'ventas\n' },
    servidores: [
      {
        hostname: 'files01',
        ip: '192.168.10.30',
        distro: 'rocky',
        clave_conocida: 'si',
        usuarios: [{ nombre: 'ana', sudo: true, uid: 1001, grupos: ['contabilidad'] }, { nombre: 'pedro', uid: 1002 }],
        grupos: [{ nombre: 'contabilidad', gid: 2001 }],
        paquetes: { instalados: ['samba', 'policycoreutils-python-utils'] },
        servicios: { smb: { activo: true, habilitado: true } },
        servicios_firewall: ['samba'],
        samba: { usuarios: [{ nombre: 'ana', clave: 'Clave2026' }, { nombre: 'pedro', clave: 'Pedro2026' }] },
        archivos: { '/srv/samba/conta/.keep': '' },
        ...extra,
      },
    ],
  }
}

async function session(st: BashStateInput) {
  const sh = createBashSession(st)
  const run = async (cmd: string) => {
    const r = await sh.run(cmd)
    return { out: stripAnsi(r.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join('')), err: stripAnsi(r.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join('')) }
  }
  return { sh, run }
}

describe('Samba', () => {
  it('smb.conf: sinónimos, parámetros desconocidos y booleanos inválidos', () => {
    const c = parseSmbConf('[global]\nworkgroup = EMPRESA\n[a]\npath = /srv/a\nwritable = yes\nwriteable2 = yes\n[b]\nread only = tal vez\n')
    expect(c.shares[0].params.get('read only')).toBe('No')
    expect(c.messages).toContain('Ignoring unknown parameter "writeable2"')
    expect(c.fatal[0]).toContain('value is not boolean')
  })

  it('SELinux bloquea hasta etiquetar la carpeta; valid users, permisos y create mask', async () => {
    const { run } = await session(state())
    await run(`ssh files01 "sudo chgrp contabilidad /srv/samba/conta && sudo chmod 2770 /srv/samba/conta && printf '${SHARE.replace(/\n/g, '\\n').replace(/\t/g, '\\t')}' | sudo tee -a /etc/samba/smb.conf"`)
    expect((await run("smbclient //files01/conta -U ana%Clave2026 -c 'ls'")).err).toContain('NT_STATUS_ACCESS_DENIED listing \\*')
    await run(`ssh files01 "sudo semanage fcontext -a -t samba_share_t '/srv/samba(/.*)?' && sudo restorecon -R /srv/samba"`)
    const put = await run("smbclient //files01/conta -U ana%Clave2026 -c 'put informe.txt; ls'")
    expect(put.out).toContain('putting file informe.txt as \\informe.txt')
    expect(put.out).toMatch(/informe\.txt\s+N\s+7/)
    expect((await run('ssh files01 ls -l /srv/samba/conta')).out).toMatch(/-rw-rw----\. 1 ana\s+contabilidad\s+7 .* informe\.txt/)
    expect((await run("smbclient //files01/conta -U pedro%Pedro2026 -c 'ls'")).err).toContain('tree connect failed: NT_STATUS_ACCESS_DENIED')
    expect((await run("smbclient //files01/conta -U ana%mala -c 'ls'")).err).toContain('session setup failed: NT_STATUS_LOGON_FAILURE')
    expect((await run("smbclient //files01/nada -U ana%Clave2026 -c 'ls'")).err).toContain('NT_STATUS_BAD_NETWORK_NAME')
  })

  it('mount -t cifs: sin uid= todo es de root; con uid= el usuario escribe', async () => {
    const { run } = await session(state({ selinux: 'permissive' }))
    await run(`ssh files01 "sudo chmod 777 /srv/samba/conta && printf '${SHARE.replace(/\n/g, '\\n').replace(/\t/g, '\\t')}' | sudo tee -a /etc/samba/smb.conf"`)
    await run('sudo mkdir /mnt/conta')
    await run("printf 'username=ana\\npassword=Clave2026\\n' | sudo tee /root/.smb-conta")
    expect((await run('sudo mount -t cifs //files01/conta /mnt/conta -o credentials=/root/.smb-conta')).err).toBe('')
    expect((await run('touch /mnt/conta/a')).err).toContain('Permission denied')
    await run('sudo umount /mnt/conta')
    expect((await run('ssh files01 sudo smbstatus -S')).out).not.toContain('conta ')
    await run('sudo mount -t cifs //files01/conta /mnt/conta -o credentials=/root/.smb-conta,uid=ana,gid=ana')
    expect((await run('touch /mnt/conta/a && ls -l /mnt/conta')).out).toMatch(/-rwxr-xr-x\. 1 ana ana 0 .* a/)
    expect((await run('ssh files01 ls -l /srv/samba/conta')).out).toMatch(/-rw-rw----\. 1 ana\s+ana\s+0 .* a/)
    expect((await run('mount')).out).toContain('//files01/conta on /mnt/conta type cifs (rw,relatime,vers=3.1.1')
    expect((await run("sudo mount -t cifs //files01/conta /mnt -o username=ana,password=mala")).err).toContain('mount error(13): Permission denied')
  })

  it('smbpasswd necesita el usuario de Linux; testparm muestra el recurso', async () => {
    const { run } = await session(state())
    await run('ssh files01')
    expect((await run('(echo x; echo x) | sudo smbpasswd -s -a juan')).err).toContain('Failed to add entry for user juan.')
    expect((await run('sudo pdbedit -L')).out).toBe('ana:1001:\npedro:1002:\n')
    await run(`printf '${SHARE.replace(/\n/g, '\\n').replace(/\t/g, '\\t')}' | sudo tee -a /etc/samba/smb.conf`)
    expect((await run('testparm -s')).out).toContain('[conta]\n\tcomment = Contabilidad\n\tpath = /srv/samba/conta\n\tvalid users = @contabilidad\n\tread only = No')
  })
})
