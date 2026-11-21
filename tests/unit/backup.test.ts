import { describe, expect, it } from 'vitest'
import { createBashSession, stripAnsi, verifyBash } from '@/engines/shell'
import { applyPolicy } from '@/engines/shell/backup'
import type { BashStateInput } from '@/engines/shell/schema'

async function session(st: BashStateInput) {
  const sh = createBashSession(st)
  const run = async (cmd: string) => {
    const r = await sh.run(cmd)
    return { out: stripAnsi(r.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join('')), err: stripAnsi(r.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join('')), code: sh.lastExit }
  }
  return { sh, run }
}

const fs01: BashStateInput = {
  distro: 'ubuntu',
  hostname: 'fs01',
  usuario: 'root',
  usuarios: [{ nombre: 'root', clave_ssh: true }],
  paquetes: { instalados: ['restic'] },
  red: { interfaces: [{ nombre: 'enp1s0', ip: '192.168.10.32/24', estado: 'UP' }], puerta_enlace: '192.168.10.1' },
  archivos: { '/srv/datos/balance.ods': { contenido: 'balance v1\n' }, '/srv/datos/clientes/lista.txt': { contenido: 'Rivas SA\n' } },
  servidores: [
    { hostname: 'backup01', ip: '192.168.10.70', clave_conocida: 'si', distro: 'ubuntu', usuarios: [{ nombre: 'root', clave_ssh: true }], paquetes: { instalados: ['rest-server', 'apache2-utils'] } },
    { hostname: 's3', ip: '192.168.10.80', clave_conocida: 'si', distro: 'ubuntu', usuarios: [{ nombre: 'root', clave_ssh: true }], objetos: { claves: [{ acceso: 'fs01', secreto: 'S3cr3t-fs01' }], buckets: [{ nombre: 'respaldos', bloqueo_dias: 30 }] } },
  ],
}

describe('restic', () => {
  it('repositorio local: backup, instantáneas, restore, retención y clave equivocada', async () => {
    const { run, sh } = await session(fs01)
    expect((await run('restic -r /srv/restic init')).err).toContain('empty password')
    await run('export RESTIC_PASSWORD=Clave-Larga-2026')
    expect((await run('restic -r /srv/restic init')).out).toContain('created restic repository')
    const b1 = await run('restic -r /srv/restic backup /srv/datos')
    expect(b1.out).toMatch(/Files:\s+2 new/)
    await run('echo "balance v2" > /srv/datos/balance.ods')
    const b2 = await run('restic -r /srv/restic backup /srv/datos --tag diario')
    expect(b2.out).toMatch(/1 changed,\s+1 unmodified/)
    expect((await run('restic -r /srv/restic snapshots')).out).toContain('2 snapshots')
    await run('rm /srv/datos/balance.ods')
    const first = /(\w{8})\s+\S+ \S+\s+fs01/.exec((await run('restic -r /srv/restic snapshots')).out)![1]
    expect((await run(`restic -r /srv/restic restore ${first} --target /tmp/r --include /srv/datos/balance.ods`)).code).toBe(0)
    expect((await run('cat /tmp/r/srv/datos/balance.ods')).out).toBe('balance v1\n')
    expect((await run('RESTIC_PASSWORD=otra restic -r /srv/restic snapshots')).err).toContain('wrong password')
    expect(verifyBash(sh, { restic_repo: '/srv/restic', instantaneas_min: 2, con_archivo: '/srv/datos/balance.ods' }).ok).toBe(true)
    const f = await run('restic -r /srv/restic forget --keep-last 1 --prune')
    expect(f.out).toContain('remove 1 snapshots')
    expect(f.out).toContain('done')
    await run('rm -rf /srv/restic')
    expect((await run('restic -r /srv/restic snapshots')).err).toContain('repository does not exist')
  })
  it('rest-server solo agregar: el cliente respalda pero no puede borrar', async () => {
    const { run, sh } = await session(fs01)
    await run(`ssh root@backup01 "sed -i 's#--listen :8000#--listen :8000 --append-only#' /etc/systemd/system/rest-server.service"`)
    await run('ssh root@backup01 htpasswd -B -b -c /srv/restic/.htpasswd fs01 Rest-fs01')
    await run('ssh root@backup01 systemctl daemon-reload')
    const st = await run('ssh root@backup01 systemctl enable --now rest-server')
    expect(st.code, st.err).toBe(0)
    expect(verifyBash(sh, { en: 'backup01', verificar: { rest_server: true, solo_agregar: true, con_clave: true } }).ok).toBe(true)
    await run('export RESTIC_PASSWORD=Clave-Larga-2026')
    expect((await run('restic -r rest:http://backup01:8000/fs01/ init')).err).toContain('401')
    const repo = 'rest:http://fs01:Rest-fs01@backup01:8000/fs01/'
    expect((await run(`restic -r ${repo} init`)).code).toBe(0)
    await run(`restic -r ${repo} backup /srv/datos`)
    await run(`restic -r ${repo} backup /srv/datos`)
    const f = await run(`restic -r ${repo} forget --keep-last 1`)
    expect(f.err).toContain('403 Forbidden')
    expect(verifyBash(sh, { en: 'backup01', verificar: { restic_repo: '/srv/restic/fs01', instantaneas_min: 2 } }).ok).toBe(true)
  })
  it('S3 con bloqueo de objetos: no se puede borrar, pero sí restaurar', async () => {
    const { run, sh } = await session(fs01)
    await run('export RESTIC_PASSWORD=Clave-Larga-2026')
    expect((await run('restic -r s3:http://s3:9000/respaldos/fs01 init')).err).toContain('no credentials')
    await run('export AWS_ACCESS_KEY_ID=fs01 AWS_SECRET_ACCESS_KEY=S3cr3t-fs01')
    expect((await run('restic -r s3:http://s3:9000/respaldos/fs01 init')).code).toBe(0)
    await run('restic -r s3:http://s3:9000/respaldos/fs01 backup /srv/datos')
    await run('restic -r s3:http://s3:9000/respaldos/fs01 backup /srv/datos')
    expect((await run('restic -r s3:http://s3:9000/respaldos/fs01 forget --keep-last 1 --prune')).err).toContain('WORM protected')
    expect(verifyBash(sh, { en: 's3', verificar: { restic_repo: 's3:respaldos/fs01', instantaneas_min: 2 } }).ok).toBe(true)
    expect((await run('restic -r s3:http://s3:9000/respaldos/fs01 restore latest --target /tmp/x')).code).toBe(0)
    expect((await run('cat /tmp/x/srv/datos/clientes/lista.txt')).out).toBe('Rivas SA\n')
  })
  it('repositorio del estado inicial con instantáneas viejas y retención', async () => {
    const { run } = await session({
      ...fs01,
      restic: { repos: [{ ruta: '/srv/restic', clave: 'x', instantaneas: Array.from({ length: 40 }, (_v, i) => ({ dias_atras: i, rutas: ['/srv/datos'] })) }] },
    })
    expect((await run('RESTIC_PASSWORD=x restic -r /srv/restic snapshots')).out).toContain('40 snapshots')
    const f = await run('RESTIC_PASSWORD=x restic -r /srv/restic forget --keep-daily 7 --keep-weekly 4')
    expect(f.out).toMatch(/keep (9|10|11) snapshots/)
  })
  it('política de retención como restic', () => {
    const day = 86_400_000
    const now = Date.UTC(2026, 10, 21, 12)
    const times = Array.from({ length: 100 }, (_v, i) => now - i * day)
    const r = applyPolicy(times, { daily: 7, weekly: 4, monthly: 3 }, now)
    expect(r.slice(0, 7).every((x) => x.keep)).toBe(true)
    const kept = r.filter((x) => x.keep).length
    expect(kept).toBeGreaterThanOrEqual(11)
    expect(kept).toBeLessThanOrEqual(14)
  })
})
