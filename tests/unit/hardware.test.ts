import { describe, expect, it } from 'vitest'
import { createBashSession, stripAnsi, verifyBash } from '@/engines/shell'
import type { BashStateInput } from '@/engines/shell/schema'

async function session(st: BashStateInput) {
  const sh = createBashSession(st)
  const run = async (cmd: string) => {
    const r = await sh.run(cmd)
    return { out: stripAnsi(r.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join('')), err: stripAnsi(r.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join('')) }
  }
  return { sh, run }
}

const discos = ['sdb', 'sdc', 'sdd', 'sde'].map((n) => ({ nombre: n, tamano: '10G' }))

describe('RAID con mdadm', () => {
  it('crear un RAID 1 (con la confirmación), formatear, fallar, reemplazar y reconstruir', async () => {
    const { sh, run } = await session({ distro: 'rocky', usuario: 'ana', usuarios: [{ nombre: 'ana', sudo: true }], paquetes: { instalados: ['mdadm'] }, discos })
    const c = await run('echo y | sudo mdadm --create /dev/md0 --level=1 --raid-devices=2 /dev/sdb /dev/sdc')
    expect(c.err).toContain('Continue creating array [y/N]?')
    expect(c.err).toContain('mdadm: array /dev/md0 started.')
    expect((await run('cat /proc/mdstat')).out).toContain('resync =')
    await run('sudo mdadm --wait /dev/md0')
    expect((await run('cat /proc/mdstat')).out).toMatch(/md0 : active raid1 sdc\[1\] sdb\[0\]\n\s+\d+ blocks super 1.2 \[2\/2\] \[UU\]/)
    await run('sudo mkfs.xfs /dev/md0 && sudo mkdir /datos && sudo mount /dev/md0 /datos && echo hola | sudo tee /datos/x')
    expect((await run('lsblk /dev/sdb')).out).toContain('└─md0')
    expect((await run('sudo mdadm /dev/md0 --fail /dev/sdc')).err).toContain('mdadm: set /dev/sdc faulty in /dev/md0')
    expect(verifyBash(sh, { raid: 'md0', estado: 'degradado' }).ok).toBe(true)
    expect((await run('cat /datos/x')).out).toBe('hola\n')
    expect((await run('sudo mdadm /dev/md0 --remove /dev/sdb')).err).toContain('hot remove failed for /dev/sdb: Device or resource busy')
    await run('sudo mdadm /dev/md0 --remove /dev/sdc')
    await run('sudo mdadm /dev/md0 --add /dev/sdd')
    expect(verifyBash(sh, { raid: 'md0', estado: 'reconstruyendo' }).ok).toBe(true)
    expect((await run('sudo mdadm --detail /dev/md0')).out).toMatch(/spare rebuilding {3}\/dev\/sdd/)
    await run('sudo mdadm --wait /dev/md0')
    expect(verifyBash(sh, { raid: 'md0', estado: 'sano', activos: 2 }).ok).toBe(true)
  })

  it('un segundo disco que falla durante la reconstrucción de un RAID 5 deja el sistema de archivos con errores', async () => {
    const { sh, run } = await session({
      distro: 'rocky',
      usuario: 'ana',
      usuarios: [{ nombre: 'ana', sudo: true }],
      paquetes: { instalados: ['mdadm'] },
      discos,
      raid: [{ nombre: 'md0', nivel: 5, discos: ['/dev/sdb', '/dev/sdc', '/dev/sdd'], repuestos: ['/dev/sde'], fallados: ['/dev/sdc'], fs: 'xfs', montaje: '/datos', usado: 0.4 }],
    })
    expect((await run('cat /proc/mdstat')).out).toContain('recovery =')
    await run('sudo mdadm /dev/md0 --fail /dev/sdd')
    expect(verifyBash(sh, { raid: 'md0', estado: 'fallado' }).ok).toBe(true)
    expect((await run('ls /datos')).err).toContain('Input/output error')
    expect((await run('sudo dmesg')).out).toContain('Filesystem has been shut down')
  })

  it('mdmonitor avisa por correo cuando falla un disco', async () => {
    const { run } = await session({ distro: 'rocky', usuario: 'ana', usuarios: [{ nombre: 'ana', sudo: true }], paquetes: { instalados: ['mdadm', 'postfix'] }, servicios: { postfix: { activo: true } }, discos, raid: [{ nombre: 'md0', nivel: 1, discos: ['/dev/sdb', '/dev/sdc'] }] })
    await run("echo 'MAILADDR root' | sudo tee -a /etc/mdadm.conf && sudo systemctl enable --now mdmonitor")
    await run('sudo mdadm /dev/md0 --fail /dev/sdb')
    expect((await run('sudo cat /var/spool/mail/root')).out).toMatch(/Subject: Fail event on \/dev\/md0:\w+/)
  })
})

describe('SMART, IPMI y UPS', () => {
  it('smartctl muestra un disco que va a fallar; en una VM no hay SMART', async () => {
    const { run } = await session({ distro: 'rocky', usuario: 'ana', usuarios: [{ nombre: 'ana', sudo: true }], paquetes: { instalados: ['smartmontools'] }, discos, smart: { '/dev/sdb': {}, '/dev/sdc': { reasignados: 1880, pendientes: 24 } } })
    expect((await run('sudo smartctl -H /dev/sdb')).out).toContain('test result: PASSED')
    const bad = (await run('sudo smartctl -a /dev/sdc')).out
    expect(bad).toContain('test result: FAILED!')
    expect(bad).toMatch(/Reallocated_Sector_Ct .* FAILING_NOW 1880/)
    expect((await run('sudo smartctl -H /dev/sda')).out).toContain('Unavailable - device lacks SMART capability')
  })

  it('ipmitool por la red: sensores y eventos de una fuente caída', async () => {
    const { run } = await session({
      distro: 'rocky',
      usuario: 'ana',
      usuarios: [{ nombre: 'ana', sudo: true }],
      paquetes: { instalados: ['ipmitool'] },
      red: { interfaces: [{ nombre: 'enp0s3', ip: '10.0.99.5/24', estado: 'UP' }] },
      servidores: [{ hostname: 'srv01', ip: '10.0.99.21', distro: 'rocky', bmc: { ip: '10.0.99.11', clave: 'Bmc-2026', fuente2: false, eventos: [{ fecha: '11/14/2026', hora: '03:12:44', texto: 'Power Supply PS2 Status | Power Supply AC lost' }] } }],
    })
    expect((await run('ipmitool -I lanplus -H 10.0.99.11 -U admin -P mala sdr')).err).toContain('Unable to establish IPMI v2 / RMCP+ session')
    expect((await run('ipmitool -I lanplus -H 10.0.99.11 -U admin -P Bmc-2026 sdr')).out).toMatch(/PS2 Status\s+\| 0x0b\s+\| cr/)
    expect((await run('ipmitool -I lanplus -H 10.0.99.11 -U admin -P Bmc-2026 sel elist')).out).toContain('Power Supply AC lost')
    expect((await run('sudo ipmitool sdr')).err).toContain('Could not open device at /dev/ipmi0')
  })

  it('NUT con dummy-ups: corte de luz, batería baja y apagado ordenado', async () => {
    const { sh, run } = await session({ distro: 'ubuntu', usuario: 'ana', usuarios: [{ nombre: 'ana', sudo: true }], paquetes: { instalados: ['nut'] } })
    await run('sudo systemctl start nut-server')
    expect((await run('sudo journalctl -u nut-server')).out).toContain('upsd disabled')
    await run("printf '[miups]\\n\\tdriver = dummy-ups\\n\\tport = miups.dev\\n' | sudo tee -a /etc/nut/ups.conf")
    await run("printf 'ups.status: OL\\nbattery.charge: 100\\n' | sudo tee /etc/nut/miups.dev")
    await run("sudo sed -i 's/^MODE=none/MODE=standalone/' /etc/nut/nut.conf")
    await run("printf '[monuser]\\n\\tpassword = Ups-2026\\n\\tupsmon primary\\n' | sudo tee -a /etc/nut/upsd.users")
    await run("echo 'MONITOR miups@localhost 1 monuser Ups-2026 primary' | sudo tee -a /etc/nut/upsmon.conf")
    await run('sudo systemctl restart nut-server nut-monitor')
    expect(verifyBash(sh, { ups_estado: 'OL', ups: 'miups' }).ok).toBe(true)
    await run("sudo sed -i 's/ups.status: OL/ups.status: OB LB/' /etc/nut/miups.dev")
    expect((await run('upsc miups ups.status')).out).toBe('OB LB\n')
    expect(verifyBash(sh, { apagado_ups: true }).ok).toBe(true)
    expect((await run('sudo journalctl -u nut-monitor')).out).toContain('Executing automatic power-fail shutdown')
  })
})
