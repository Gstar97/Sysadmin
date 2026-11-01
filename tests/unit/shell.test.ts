import { describe, expect, it } from 'vitest'
import { createBashSession, stripAnsi, verifyBash } from '@/engines/shell'
import { saveEditor, checkCrontab } from '@/engines/shell/editor'
import type { BashStateInput } from '@/engines/shell/schema'

async function session(state: BashStateInput = {}) {
  const sh = createBashSession(state)
  const run = async (cmd: string) => {
    const r = await sh.run(cmd)
    return { out: stripAnsi(r.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join('')), err: stripAnsi(r.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join('')), code: sh.lastExit }
  }
  return { sh, run }
}

describe('intérprete de bash', () => {
  it('variables, comillas, tuberías y redirecciones', async () => {
    const { run } = await session()
    await run('NOMBRE="mundo"')
    expect((await run('echo "hola $NOMBRE" \'$NOMBRE\'')).out).toBe('hola mundo $NOMBRE\n')
    await run('printf "b\\na\\nc\\na\\n" > lista.txt')
    expect((await run('sort lista.txt | uniq -c | sort -rn | head -1')).out.trim()).toBe('2 a')
    expect((await run('cat no-existe.txt')).err).toMatch(/No such file or directory/)
    expect((await run('cat no-existe.txt 2>/dev/null || echo fallo')).out).toBe('fallo\n')
    expect((await run('for i in 1 2 3; do echo -n $((i*2)); done')).out).toBe('246')
  })

  it('los permisos se aplican de verdad', async () => {
    const { run } = await session({ usuarios: [{ nombre: 'estudiante' }] })
    const r = await run('echo prueba > /etc/hosts')
    expect(r.err).toMatch(/Permission denied/)
    expect(r.code).not.toBe(0)
    expect((await run('touch archivo && chmod 640 archivo && stat -c %a archivo')).out.trim()).toBe('640')
  })

  it('sudo, usuarios y grupos', async () => {
    const { sh, run } = await session({ usuarios: [{ nombre: 'estudiante', sudo: true }] })
    await run('sudo groupadd soporte')
    await run('sudo useradd -m -G soporte -s /bin/bash maria')
    expect(verifyBash(sh, { usuario: 'maria', existe: true, en_grupos: ['soporte'], shell: '/bin/bash' }).ok).toBe(true)
    expect(verifyBash(sh, { archivo: '/home/maria', tipo: 'directorio', dueno: 'maria', existe: true }).ok).toBe(true)
  })

  it('servicios de systemd y paquetes (Rocky usa dnf)', async () => {
    const { sh, run } = await session({ usuarios: [{ nombre: 'estudiante', sudo: true }], paquetes: { instalados: [], disponibles: ['nginx'] } })
    expect((await run('sudo apt install nginx')).err).toMatch(/command not found/)
    await run('sudo dnf install -y nginx')
    expect(verifyBash(sh, { paquete: 'nginx', instalado: true }).ok).toBe(true)
    await run('sudo systemctl enable --now nginx')
    expect(verifyBash(sh, { servicio: 'nginx', activo: true, habilitado: true }).ok).toBe(true)
    expect((await run('curl -s localhost')).out.length).toBeGreaterThan(0)
  })
})

describe('editor de la terminal', () => {
  it('guarda respetando permisos y valida sudoers y crontab', async () => {
    const { sh, run } = await session({ usuarios: [{ nombre: 'estudiante', sudo: true }] })
    await run('nano notas.txt')
    const req = sh.pendingEditor!
    expect(saveEditor(sh, req, 'línea 1').ok).toBe(true)
    expect((await run('cat notas.txt')).out).toBe('línea 1\n')
    await run('nano /etc/passwd')
    expect(saveEditor(sh, sh.pendingEditor!, 'x').message).toMatch(/Permission denied/)
    expect(checkCrontab('*/5 * * * * /usr/local/bin/backup.sh')).toBeNull()
    expect(checkCrontab('61 * * * * /usr/local/bin/backup.sh')?.message).toBe('bad minute')
    expect(checkCrontab('@daily')?.message).toBe('bad command')
  })
})

describe('detalles que usa el Nivel 0', () => {
  it('Ubuntu arranca y ls no muestra el punto de SELinux', async () => {
    const { run } = await session({ distro: 'ubuntu' })
    expect((await run('cat /etc/os-release')).out).toMatch(/Ubuntu/)
    expect((await run('ls -ld /tmp')).out).toMatch(/^drwxrwxrwt \d/)
  })

  it('aritmética en otras bases y operadores de bits', async () => {
    const { run } = await session()
    expect((await run('echo $((2#11000000)) $((16#ff)) $((0x1F)) $((017)) $((192 & 255)) $((10 | 5)) $((6 ^ 3)) $((1 << 4))')).out).toBe('192 255 31 15 192 15 5 16\n')
    expect((await run('echo $((08))')).err).toMatch(/value too great for base/)
  })

  it('bytes, codificación y finales de línea', async () => {
    const { run } = await session({ archivos: { '/home/estudiante/s.sh': { contenido: '#!/bin/bash\r\necho hola\r\n', modo: '0755' } }, paquetes: { instalados: ['dos2unix'], disponibles: [] } })
    expect((await run('echo -n "ñ" | od -An -tx1')).out).toBe(' c3 b1\n')
    expect((await run('cat -A s.sh')).out).toBe('#!/bin/bash^M$\necho hola^M$\n')
    expect((await run('./s.sh')).err).toMatch(/bad interpreter/)
    await run('dos2unix s.sh')
    expect((await run('./s.sh')).out).toBe('hola\n')
    expect((await run('free -h')).out.split('\n')[0]).toBe('               total        used        free      shared  buff/cache   available')
  })

  it('inventario de hardware: lscpu, cpuinfo, dmidecode y firmware BIOS', async () => {
    const { run } = await session({ usuarios: [{ nombre: 'estudiante', sudo: true }] })
    expect((await run('grep -o avx2 /proc/cpuinfo | sort -u')).out).toBe('avx2\n')
    expect((await run('grep -c processor /proc/cpuinfo')).out).toBe('2\n')
    expect((await run('lscpu')).out).toContain('Core(s) per socket:   2')
    expect((await run('dmidecode -t system')).code).toBe(1)
    expect((await run('sudo dmidecode -t memory')).out).toContain('Error Correction Type: Multi-bit ECC')
    expect((await run('sudo dmidecode -s bios-vendor')).out).toBe('SeaBIOS\n')
    expect((await run('ls /sys/firmware/efi')).err).toContain('No such file or directory')
  })

  it('arranque BIOS o UEFI: fdisk, efibootmgr, mokutil y /sys/firmware/efi', async () => {
    const bios = await session({ usuarios: [{ nombre: 'estudiante', sudo: true }] })
    expect((await bios.run('sudo fdisk -l')).out).toContain('Disklabel type: dos')
    expect((await bios.run('efibootmgr')).err).toContain('not supported')
    const uefi = await session({ distro: 'ubuntu', firmware: 'uefi', secure_boot: false, usuarios: [{ nombre: 'estudiante', sudo: true }] })
    expect((await uefi.run('ls /sys/firmware/efi')).out).toContain('efivars')
    expect((await uefi.run('sudo fdisk -l')).out).toMatch(/Disklabel type: gpt[\s\S]*\/dev\/sda1 +2048 +2099199 +2097152 +1G EFI System/)
    expect((await uefi.run('efibootmgr')).out).toContain('Boot0004* ubuntu')
    expect((await uefi.run('mokutil --sb-state')).out).toBe('SecureBoot disabled\n')
    expect((await uefi.run('lsblk')).out).toContain('/boot/efi')
    expect((await uefi.run('sudo dmidecode -s bios-vendor')).out).toBe('EDK II\n')
  })

  it('sumas de verificación (md5, sha1, sha256, sha512) y base64', async () => {
    const { run } = await session()
    expect((await run('echo -n "abc" | md5sum')).out).toBe('900150983cd24fb0d6963f7d28e17f72  -\n')
    expect((await run('echo -n "abc" | sha1sum')).out).toBe('a9993e364706816aba3e25717850c26c9cd0d89d  -\n')
    expect((await run('echo -n "abc" | sha256sum')).out).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  -\n')
    await run('echo hola > a.txt; sha256sum a.txt > a.sha256')
    expect((await run('sha256sum -c a.sha256')).out).toBe('a.txt: OK\n')
    await run('echo chau >> a.txt')
    expect((await run('sha256sum -c a.sha256')).code).toBe(1)
    expect((await run('echo -n "hola" | base64')).out).toBe('aG9sYQ==\n')
  })

  it('el camino de un pedido web: ip, dig, ping y curl con TLS', async () => {
    const { run } = await session({
      distro: 'ubuntu',
      paquetes: { instalados: ['dnsutils'] },
      red: {
        interfaces: [{ nombre: 'enp0s3', ip: '192.168.1.20/24' }],
        puerta_enlace: '192.168.1.1',
        dns: ['192.168.1.53'],
        alcanzables: ['192.168.1.53'],
        registros_dns: { 'tienda.example.com': '198.51.100.20' },
      },
    })
    expect((await run('ip route')).out).toContain('default via 192.168.1.1')
    expect((await run('dig +short tienda.example.com')).out).toBe('198.51.100.20\n')
    expect((await run('ping -c 1 tienda.example.com')).out).toContain('1 received')
    const v = await run('curl -v https://tienda.example.com')
    expect(v.err).toMatch(/Trying 198\.51\.100\.20:443[\s\S]*TLSv1\.3[\s\S]*subject: CN=tienda\.example\.com[\s\S]*expire date: \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4} GMT[\s\S]*< HTTP\/1\.1 200 OK/)
    expect((await run('curl -v http://tienda.example.com')).err).not.toContain('TLSv1.3')
  })
})

describe('lo que usa el Nivel 1 (primeros pasos)', () => {
  it('expansión de llaves', async () => {
    const { run } = await session()
    await run('mkdir -p p/{src,docs}/v{1..3}')
    expect((await run('ls p/docs')).out).toBe('v1  v2  v3\n')
    expect((await run('echo f{01..03}.log {c..a} x{1..7..3}')).out).toBe('f01.log f02.log f03.log c b a x1 x4 x7\n')
    expect((await run("echo '{a,b}' {solo}")).out).toBe('{a,b} {solo}\n')
  })

  it('historial con !! y !$, y alias de la distribución', async () => {
    const { run } = await session({ usuarios: [{ nombre: 'estudiante', sudo: true }] })
    await run('ls /etc/hosts')
    const r = await run('echo !$')
    expect(r.out).toBe('echo /etc/hosts\n/etc/hosts\n')
    expect((await run('!!')).out).toBe('echo /etc/hosts\n/etc/hosts\n')
    expect((await run('!noexiste')).err).toContain('event not found')
    expect((await run("echo 'sin !! expansión'")).out).toBe('sin !! expansión\n')
    expect((await run('type ll')).out).toContain('aliased to `ls -l --color=auto')
    await run("alias hola='echo hola mundo'")
    expect((await run('hola')).out).toBe('hola mundo\n')
    await run('unalias hola')
    expect((await run('hola')).err).toContain('command not found')
    const ub = await session({ distro: 'ubuntu' })
    expect((await ub.run('alias ll')).out).toBe("alias ll='ls -alF'\n")
  })

  it('ayuda: secciones del manual, whatis, whereis y nl', async () => {
    const { run } = await session()
    expect((await run('whatis passwd')).out).toMatch(/passwd \(1\)[\s\S]*passwd \(5\)/)
    expect((await run('man 5 passwd')).out).toContain('seven colon-separated fields')
    expect((await run('man 5 ls')).err).toContain('No entry for ls in section 5')
    expect((await run('whereis ls')).out).toBe('ls: /usr/bin/ls /usr/share/man/man1/ls.1.gz\n')
    expect((await run('printf "a\\n\\nb\\n" | nl')).out).toBe('     1\ta\n       \n     2\tb\n')
    expect((await run('ls -lhd /etc')).out).toMatch(/ 4\.0K /)
  })
})

describe('lo que usa el Nivel 1 (usuarios y permisos)', () => {
  const state = {
    usuarios: [{ nombre: 'ana', sudo: true }, { nombre: 'laura' }, { nombre: 'pedro' }],
    usuario: 'ana',
    grupos: [
      { nombre: 'ventas', miembros: ['laura'] },
      { nombre: 'auditoria', miembros: ['pedro'] },
    ],
  }

  it('ACL: acceso extra, máscara y herencia por defecto', async () => {
    const { run } = await session(state)
    await run('sudo mkdir /srv/ventas; sudo chgrp ventas /srv/ventas; sudo chmod 2770 /srv/ventas')
    await run('sudo setfacl -m g:auditoria:rx /srv/ventas')
    await run('sudo setfacl -d -m g:ventas:rwx,g:auditoria:rx /srv/ventas')
    expect((await run('ls -ld /srv/ventas')).out).toMatch(/^drwxrws---\+ /)
    await run('sudo -u laura touch /srv/ventas/informe.txt')
    const acl = (await run('sudo getfacl /srv/ventas/informe.txt')).out
    expect(acl).toContain('group:auditoria:r-x')
    expect(acl).toMatch(/group:ventas:rwx\t+#effective:rw-/)
    expect((await run('sudo -u pedro cat /srv/ventas/informe.txt')).code).toBe(0)
    expect((await run('sudo -u pedro touch /srv/ventas/otro')).err).toContain('Permission denied')
    expect((await run('cat /srv/ventas/informe.txt')).err).toContain('Permission denied')
    await run('sudo setfacl -b /srv/ventas')
    expect((await run('ls -ld /srv/ventas')).out).toMatch(/^drwxrws---\. /)
  })

  it('sudo con reglas acotadas, sudo su - y sudo -l -U', async () => {
    const { run } = await session(state)
    await run('echo "laura ALL=(root) /usr/bin/journalctl" | sudo tee /etc/sudoers.d/laura > /dev/null')
    expect((await run('sudo -l -U laura')).out).toContain('(root) /usr/bin/journalctl')
    await run('sudo su - laura')
    expect((await run('whoami')).out).toBe('laura\n')
    expect((await run('sudo cat /etc/shadow')).err).toContain('is not allowed to execute')
    await run('exit')
    expect((await run('whoami')).out).toBe('ana\n')
  })

  it('cuentas de sistema, SUID, getent shadow, chage y faillock', async () => {
    const { run } = await session({ ...state, faillock: { laura: 3 } })
    await run('sudo useradd -r -s /sbin/nologin svc_app')
    expect((await run('id -u svc_app')).out).toBe('999\n')
    expect((await run('ls -l /usr/bin/passwd')).out).toMatch(/^-rwsr-xr-x/)
    expect((await run('getent shadow ana')).out).toBe('')
    expect((await run('sudo getent shadow ana')).out).toMatch(/^ana:/)
    await run('sudo chage -d 0 laura')
    expect((await run('sudo chage -l laura')).out).toMatch(/Password expires\s+: password must be changed/)
    expect((await run('sudo faillock --user laura')).out.split('\n').filter((l) => l.includes('RHOST')).length).toBe(3)
    await run('sudo faillock --user laura --reset')
    expect((await run('sudo faillock --user laura')).out).not.toContain('RHOST')
    await run('sudo authselect enable-feature with-faillock')
    expect((await run('sudo grep -c pam_faillock /etc/pam.d/system-auth')).out).toBe('3\n')
  })
})

describe('umask con sudo y su', () => {
  it('sudo suma 022 a la umask; su - usa la de la cuenta', async () => {
    const { run } = await session({ usuarios: [{ nombre: 'ana', sudo: true }, { nombre: 'marta' }], usuario: 'ana' })
    await run('sudo mkdir -m 1777 /srv/c')
    await run('sudo -u marta touch /srv/c/a.txt')
    await run("sudo su - marta -c 'touch /srv/c/b.txt'")
    await run('echo hola | sudo tee /srv/c/c.txt')
    const ls = (await run('ls -l /srv/c')).out
    expect(ls).toMatch(/-rw-r--r--\. 1 marta .* a\.txt/)
    expect(ls).toMatch(/-rw-rw-r--\. 1 marta .* b\.txt/)
    expect(ls).toMatch(/-rw-r--r--\. 1 root .* c\.txt/)
    expect((await run('whoami')).out).toBe('ana\n')
  })
})
