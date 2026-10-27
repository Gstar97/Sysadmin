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
