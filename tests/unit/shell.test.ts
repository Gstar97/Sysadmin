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
})
