import { describe, expect, it } from 'vitest'
import { createBashSession, stripAnsi, verifyBash } from '@/engines/shell'
import { saveEditor } from '@/engines/shell/editor'
import type { BashStateInput } from '@/engines/shell/schema'
import { calendarNext, normalizeCalendar, parseCalendar } from '@/engines/shell/units'
import { validateSystemd } from '@/engines/config/systemd'

async function session(state: BashStateInput = {}) {
  const sh = createBashSession({ usuario: 'root', ...state })
  const run = async (cmd: string) => {
    const r = await sh.run(cmd)
    return { out: stripAnsi(r.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join('')), err: stripAnsi(r.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join('')), code: sh.lastExit }
  }
  return { sh, run }
}

const BACKUP: BashStateInput = {
  archivos: {
    '/usr/local/bin/backup.sh': { contenido: '#!/bin/bash\necho "Copiando"\nmkdir -p /backup\ncp -r /srv/datos /backup/\n', modo: '0755' },
    '/srv/datos/a.txt': 'hola\n',
    '/etc/systemd/system/backup.service': '[Unit]\nDescription=Copia de seguridad\n\n[Service]\nType=oneshot\nExecStart=/usr/local/bin/backup.sh\n',
    '/etc/systemd/system/backup.timer': '[Unit]\nDescription=Copia diaria\n\n[Timer]\nOnCalendar=*-*-* 03:00:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n',
  },
}

describe('OnCalendar', () => {
  it('normaliza como systemd-analyze calendar', () => {
    expect(normalizeCalendar(parseCalendar('daily')!)).toBe('*-*-* 00:00:00')
    expect(normalizeCalendar(parseCalendar('Mon..Fri 08:30')!)).toBe('Mon..Fri *-*-* 08:30:00')
    expect(normalizeCalendar(parseCalendar('*:0/15')!)).toBe('*-*-* *:00/15:00')
    expect(normalizeCalendar(parseCalendar('Sat,Sun 10:00')!)).toBe('Sat,Sun *-*-* 10:00:00')
    expect(parseCalendar('25:00')).toBeUndefined()
    expect(parseCalendar('todos los días')).toBeUndefined()
  })

  it('calcula la próxima ejecución', () => {
    const from = new Date(2026, 10, 1, 3, 30, 0).getTime() // domingo 1 de noviembre, 03:30
    const at = (expr: string) => new Date(calendarNext(parseCalendar(expr)!, from)!)
    expect(at('*-*-* 03:00:00').getDate()).toBe(2)
    expect(at('*-*-* 04:00').getHours()).toBe(4)
    expect(at('Mon..Fri 08:30').getDay()).toBe(1)
    expect(at('*:0/15').getMinutes()).toBe(45)
    expect(at('monthly').getMonth()).toBe(11)
  })
})

describe('systemctl con unidades propias', () => {
  it('un servicio oneshot ejecuta su script y deja la salida en el journal', async () => {
    const { run } = await session(BACKUP)
    expect((await run('systemctl start backup')).code).toBe(0)
    expect((await run('ls /backup/datos')).out).toBe('a.txt\n')
    const status = (await run('systemctl status backup')).out
    expect(status).toContain('inactive (dead)')
    expect(status).toContain('status=0/SUCCESS')
    expect((await run('journalctl -u backup -o cat')).out).toContain('Copiando')
    expect((await run('systemctl is-enabled backup')).out).toBe('static\n')
  })

  it('los timers se habilitan y aparecen en list-timers', async () => {
    const { sh, run } = await session(BACKUP)
    const r = await run('systemctl enable --now backup.timer')
    expect(r.err).toContain('timers.target.wants/backup.timer')
    expect((await run('systemctl list-timers')).out).toMatch(/03:00:00 UTC .*backup\.timer\s+backup\.service/)
    expect((await run('systemctl status backup.timer')).out).toContain('active (waiting)')
    expect(verifyBash(sh, { servicio: 'backup.timer', activo: true, habilitado: true }).ok).toBe(true)
    expect(verifyBash(sh, { servicio: 'backup.timer', activo: false }).ok).toBe(false)
  })

  it('explica por qué no arranca: ejecutable, permisos, shebang y usuario', async () => {
    const { run } = await session()
    await run("printf '[Unit]\\nDescription=App\\n[Service]\\nExecStart=/opt/app/run.sh\\nUser=app\\n[Install]\\nWantedBy=multi-user.target\\n' > /etc/systemd/system/app.service")
    expect((await run('systemctl start app')).code).toBe(1)
    expect((await run('journalctl -u app')).out).toContain('217/USER')
    await run('useradd -r app')
    await run('systemctl start app')
    expect((await run('journalctl -u app -n 4')).out).toContain('203/EXEC')
    await run("mkdir -p /opt/app; echo 'echo hola' > /opt/app/run.sh; chmod 755 /opt/app/run.sh")
    await run('systemctl start app')
    expect((await run('journalctl -u app')).out).toContain('Exec format error')
    await run("printf '#!/bin/bash\\nsleep infinity\\n' > /opt/app/run.sh")
    expect((await run('systemctl start app')).code).toBe(0)
    expect((await run('systemctl is-active app')).out).toBe('active\n')
  })

  it('pide daemon-reload si la unidad cambió y respeta los drop-ins', async () => {
    const { sh, run } = await session({ ...BACKUP, paquetes: { instalados: ['nginx'] } })
    await run('systemctl status backup')
    await run("sed -i 's/Copia de seguridad/Copia nocturna/' /etc/systemd/system/backup.service")
    expect((await run('systemctl status backup')).err).toContain("Run 'systemctl daemon-reload'")
    await run('systemctl daemon-reload')
    expect((await run('systemctl status backup')).out).toContain('Copia nocturna')
    // systemctl edit crea el drop-in y recarga solo.
    await run('systemctl edit nginx')
    const req = sh.pendingEditor!
    expect(req.content).toContain('### Edits below this comment will be discarded')
    const edited = req.content.replace('### Edits below', '[Service]\nRestart=always\n\n### Edits below')
    expect(saveEditor(sh, req, edited).ok).toBe(true)
    expect((await run('cat /etc/systemd/system/nginx.service.d/override.conf')).out).toBe('[Service]\nRestart=always\n')
    expect((await run('systemctl show -p Restart --value nginx')).out).toBe('always\n')
    // Un segundo ExecStart en un drop-in sin vaciar el anterior: unidad inválida.
    await run("printf '[Service]\\nExecStart=/usr/sbin/nginx -g x\\n' > /etc/systemd/system/nginx.service.d/mal.conf")
    await run('systemctl daemon-reload')
    expect((await run('systemctl restart nginx')).err).toContain('bad unit file setting')
  }, 15000)

  it('--failed, mask, targets y list-dependencies', async () => {
    const { run } = await session({ servicios: { inventario: { activo: false, habilitado: true, fallido: true } } })
    expect((await run('systemctl --failed')).out).toContain('inventario.service')
    expect((await run('systemctl --failed')).out).not.toContain('sshd.service')
    await run('systemctl mask chronyd')
    expect((await run('systemctl start chronyd')).err).toContain('masked')
    expect((await run('systemctl get-default')).out).toBe('multi-user.target\n')
    await run('systemctl set-default graphical.target')
    expect((await run('readlink /etc/systemd/system/default.target')).out).toContain('graphical.target')
    expect((await run('systemctl list-dependencies')).out).toContain('inventario.service')
  })
})

describe('logrotate', () => {
  it('rota, comprime y explica los errores típicos', async () => {
    const { run } = await session()
    await run('mkdir -p /var/log/app; echo uno > /var/log/app/app.log')
    await run("printf '/var/log/app/*.log {\\n    daily\\n    rotate 2\\n    compress\\n    missingok\\n    notifempty\\n    create 0640 root root\\n}\\n' > /etc/logrotate.d/app")
    expect((await run('logrotate -d /etc/logrotate.d/app')).out).toContain('considering log /var/log/app/app.log')
    await run('logrotate -f /etc/logrotate.d/app')
    expect((await run('ls /var/log/app')).out.trim().split(/\s+/)).toEqual(['app.log', 'app.log.1.gz'])
    for (const t of ['dos', 'tres']) await run(`echo ${t} >> /var/log/app/app.log; logrotate -f /etc/logrotate.d/app`)
    expect((await run('ls /var/log/app')).out.trim().split(/\s+/)).toEqual(['app.log', 'app.log.1.gz', 'app.log.2.gz'])
    expect((await run('zcat /var/log/app/app.log.1.gz')).out).toBe('tres\n')
    await run('chmod 666 /etc/logrotate.d/app')
    expect((await run('logrotate /etc/logrotate.conf')).err).toContain('bad file mode')
    await run('chmod 644 /etc/logrotate.d/app; chmod 775 /var/log/app; chgrp wheel /var/log/app; echo x > /var/log/app/app.log')
    expect((await run('logrotate -f /etc/logrotate.d/app')).err).toContain('insecure permissions')
  })
})

describe('arranque', () => {
  it('grubby cambia los parámetros del kernel en Rocky', async () => {
    const { run } = await session()
    await run("grubby --update-kernel=ALL --args='console=ttyS0' --remove-args=crashkernel")
    const info = (await run('grubby --info=DEFAULT')).out
    expect(info).toContain('console=ttyS0')
    expect(info).not.toContain('crashkernel')
    expect((await run('cat /proc/cmdline')).out).toContain('crashkernel')
    expect((await run('update-grub')).code).toBe(127)
  })

  it('update-grub usa /etc/default/grub en Ubuntu', async () => {
    const { run } = await session({ distro: 'ubuntu' })
    await run(`sed -i 's/CMDLINE_LINUX=""/CMDLINE_LINUX="quiet"/' /etc/default/grub`)
    await run('update-grub')
    expect((await run('grep -c "ro quiet" /boot/grub/grub.cfg')).out.trim()).toBe('1')
    expect((await run('grubby --info=ALL')).code).toBe(127)
  })
})

describe('validador de unidades de systemd', () => {
  const errs = (t: string) => validateSystemd(t).diagnostics.map((d) => d.message).join(' | ')
  it('acepta una unidad correcta', () => {
    const r = validateSystemd('[Unit]\nDescription=App\nAfter=network.target\n\n[Service]\nExecStart=/usr/bin/python3 -m http.server 8080\nUser=app\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n')
    expect(r.diagnostics).toEqual([])
    expect(r.entries.find((e) => e.key === 'Service.Restart')?.value).toBe('on-failure')
  })
  it('explica los errores típicos', () => {
    expect(errs('[service]\nExecStart=/bin/true\n')).toContain('¿Quisiste decir [Service]?')
    expect(errs('[Service]\nExecstart=/bin/true\n')).toContain('¿Quisiste decir ExecStart?')
    expect(errs('[Service]\nExecStart=/bin/a\nExecStart=/bin/b\n[Install]\nWantedBy=multi-user.target\n')).toContain('más de un ExecStart')
    expect(errs('[Service]\nExecStart=/bin/true\n[Install]\nRestart=always\nWantedBy=multi-user\n')).toContain('va en la sección [Service]')
    expect(errs('[Service]\nExecStart=/bin/true\n[Install]\nWantedBy=multi-user\n')).toContain('le falta la extensión')
    expect(errs('[Service]\nExecStart=/usr/bin/echo hola > /tmp/x\n')).toContain('sin una shell')
    expect(errs('[Timer]\nOnCalendar=todos los dias\n[Install]\nWantedBy=timers.target\n')).toContain('no entiende')
    expect(errs('[Timer]\nPersistent=true\n')).toContain('no dice cuándo activarse')
  })
})
