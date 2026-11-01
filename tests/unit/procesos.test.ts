import { describe, expect, it } from 'vitest'
import { createBashSession, stripAnsi } from '@/engines/shell'
import type { BashStateInput } from '@/engines/shell/schema'

async function session(state: BashStateInput = {}) {
  const sh = createBashSession({ usuario: 'root', ...state })
  const run = async (cmd: string) => {
    const r = await sh.run(cmd)
    return { out: stripAnsi(r.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join('')), err: stripAnsi(r.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join('')), code: sh.lastExit }
  }
  return { sh, run }
}

describe('procesos y rendimiento', () => {
  it('top, uptime y vmstat cuentan la misma historia', async () => {
    const { run } = await session({
      paquetes: { instalados: ['sysstat'] },
      procesos: [{ usuario: 'root', comando: '/usr/bin/python3 calculo.py', cpu: 99.5, mem: 1, estado: 'R' }],
    })
    const top = (await run('top -b -n 1')).out
    expect(top).toMatch(/%Cpu\(s\):\s+(49|50)\.\d us/)
    expect(top.split('\n').find((l) => /^\s+\d+ root/.test(l))).toContain('python3')
    expect(Number(/load average: ([\d.]+)/.exec((await run('uptime')).out)![1])).toBeGreaterThan(0.9)
    const mp = (await run('mpstat -P ALL')).out
    expect(mp).toMatch(/\s0\s+99\.40/)
  })

  it('señales: TERM, procesos que la ignoran, zombis y D', async () => {
    const { run } = await session({
      procesos: [
        { usuario: 'root', comando: '/opt/agente', ignora_term: true },
        { usuario: 'root', comando: '[defunct]', estado: 'Z' },
      ],
    })
    await run('kill $(pgrep agente)')
    expect((await run('pgrep agente')).code).toBe(0)
    await run('kill -9 $(pgrep agente)')
    expect((await run('pgrep agente')).code).toBe(1)
  })

  it('trabajos en segundo plano, nice y renice', async () => {
    const { run } = await session()
    expect((await run('sleep 300 &')).err).toMatch(/^\[1\] \d+/)
    await run('yes > /dev/null &')
    expect((await run('jobs')).out).toContain('[2]+  Running')
    await run('renice 15 -p $(jobs -p | tail -1)')
    expect((await run('ps -o ni,comm -C yes')).out).toMatch(/15 yes/)
    expect((await run('kill %2')).err).toContain('Terminated')
    expect((await run('jobs')).out).not.toContain('yes')
  })

  it('cron valida lo que se instala; at necesita atd', async () => {
    const { run } = await session()
    expect((await run("echo '0 25 * * * /bin/true' | crontab -")).err).toContain('bad hour')
    await run("echo '30 2 * * * /usr/local/bin/respaldo.sh' | crontab -")
    expect((await run('crontab -l')).out).toContain('respaldo.sh')
    await run('dnf install -y at && systemctl enable --now atd')
    expect((await run('echo "reboot" | at 03:00')).err).toMatch(/job 1 at/)
    expect((await run('atq')).out).toMatch(/^1\t/)
  })

  it('chrony, zona horaria, sysctl y módulos', async () => {
    const { run } = await session({ hora: { zona: 'UTC', desfase_segundos: 400, servidor_ntp: 'ntp.viejo.local' } })
    expect((await run('timedatectl')).out).toContain('synchronized: no')
    expect((await run('chronyc sources')).out).toMatch(/\^\? ntp\.viejo\.local/)
    await run("sed -i 's/^server ntp.viejo.local iburst/pool 2.rocky.pool.ntp.org iburst/' /etc/chrony.conf && systemctl restart chronyd")
    expect((await run('timedatectl')).out).toContain('synchronized: yes')
    await run('sysctl -w vm.swappiness=10')
    expect((await run('cat /proc/sys/vm/swappiness')).out).toBe('10\n')
    await run('modprobe br_netfilter')
    expect((await run('lsmod')).out).toMatch(/bridge\s+\d+\s+1 br_netfilter/)
  })
})

describe('hora y chrony', () => {
  it('la zona cambia la hora local pero no la UTC, y chrony sincroniza con el servidor interno', async () => {
    const { run } = await session({ distro: 'rocky', hora: { desfase_segundos: -437 }, red: { internet: false, alcanzables: ['ntp.empresa.local'] } })
    expect((await run('timedatectl')).out).toContain('synchronized: no')
    expect((await run('chronyc sources')).out).toMatch(/\^\? 2\.rocky\.pool\.ntp\.org/)
    await run('timedatectl set-timezone America/Bogota')
    const h = (await run('date +%H')).out.trim()
    const hu = (await run('date -u +%H')).out.trim()
    expect((Number(hu) - Number(h) + 24) % 24).toBe(5)
    expect((await run('date')).out).toContain(' -05 ')
    await run("sed -i 's/^pool .*/server ntp.empresa.local iburst/' /etc/chrony.conf")
    await run('systemctl restart chronyd')
    expect((await run('chronyc sources')).out).toContain('^* ntp.empresa.local')
    expect((await run('timedatectl')).out).toContain('synchronized: yes')
  })
})
