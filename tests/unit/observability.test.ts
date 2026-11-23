import { describe, expect, it } from 'vitest'
import { createBashSession, stripAnsi, verifyBash } from '@/engines/shell'
import { bashCheckSchema, type BashStateInput } from '@/engines/shell/schema'
import { formatAlloy, planAlloy, validateAlloy, AlloyError } from '@/engines/shell/alloyconf'

const NOPASS = { '/etc/sudoers.d/ana': { contenido: 'ana ALL=(ALL) NOPASSWD: ALL\n' } }

function lab(extra: Partial<BashStateInput> = {}, web01: object = {}, web02: object = {}): BashStateInput {
  return {
    distro: 'rocky',
    hostname: 'mon01',
    usuario: 'ana',
    usuarios: [{ nombre: 'ana', sudo: true, clave_ssh: true }],
    paquetes: { instalados: ['prometheus', 'alertmanager', 'grafana', 'loki', 'logcli', 'postfix', 's-nail'] },
    red: { interfaces: [{ nombre: 'enp1s0', ip: '192.168.10.30/24', estado: 'UP' }] },
    archivos: NOPASS,
    servidores: [
      { hostname: 'web01', ip: '192.168.10.11', distro: 'ubuntu', clave_conocida: 'si', usuarios: [{ nombre: 'ana', clave_ssh: true }], archivos: NOPASS, paquetes: { instalados: ['node_exporter', 'alloy', 'zabbix-agent2'] }, ...web01 },
      { hostname: 'web02', ip: '192.168.10.12', clave_conocida: 'si', usuarios: [{ nombre: 'ana', clave_ssh: true }], archivos: NOPASS, paquetes: { instalados: ['node_exporter', 'alloy'] }, ...web02 },
    ],
    ...extra,
  } as BashStateInput
}

async function session(state: BashStateInput) {
  const sh = createBashSession(state)
  const run = async (cmd: string) => {
    const r = await sh.run(cmd)
    return { out: stripAnsi(r.chunks.map((c) => c.text).join('')), code: sh.lastExit }
  }
  const check = (c: object) => verifyBash(sh, bashCheckSchema.parse(c)).ok
  return { sh, run, check }
}

const PROM = `global:
  scrape_interval: 15s
  evaluation_interval: 15s
alerting:
  alertmanagers:
    - static_configs:
        - targets: ["localhost:9093"]
rule_files:
  - "rules/*.yml"
scrape_configs:
  - job_name: "node"
    static_configs:
      - targets: ["web01:9100", "web02:9100"]
`
const RULES = `groups:
  - name: nodos
    rules:
      - alert: NodoCaido
        expr: up{job="node"} == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "{{ $labels.instance }} no responde"
`
const AM = `global:
  smtp_smarthost: "localhost:25"
  smtp_from: "alertas@mon01"
route:
  receiver: "correo"
receivers:
  - name: "correo"
    email_configs:
      - to: "ana@localhost"
`
const ALLOY = `local.file_match "sistema" {
  path_targets = [{"__path__" = "/var/log/*.log", job = "system", host = constants.hostname}]
}

loki.source.file "sistema" {
  targets    = local.file_match.sistema.targets
  forward_to = [loki.write.mon01.receiver]
}

loki.write "mon01" {
  endpoint {
    url = "http://mon01:3100/loki/api/v1/push"
  }
}
`

describe('Prometheus, Alertmanager y node_exporter en el simulador', () => {
  it('objetivos por la red, reglas, alerta que se dispara con el tiempo y correo', async () => {
    const { run, check } = await session(lab({ archivos: { ...NOPASS, '/etc/prometheus/prometheus.yml': { contenido: PROM }, '/etc/prometheus/rules/nodos.yml': { contenido: RULES }, '/etc/alertmanager/alertmanager.yml': { contenido: AM }, '/etc/hosts': { contenido: '127.0.0.1 localhost\n192.168.10.11 web01\n192.168.10.12 web02\n' } } }))
    await run('ssh web01 "sudo systemctl enable --now node_exporter"')
    expect((await run('curl -s web01:9100/metrics')).out).toMatch(/^node_filesystem_avail_bytes\{device=.*mountpoint="\/"\} \d+$/m)
    expect((await run('promtool check config /etc/prometheus/prometheus.yml')).out).toContain('SUCCESS: 1 rule files found')
    await run('sudo systemctl enable --now postfix alertmanager prometheus')
    expect(check({ prometheus_objetivo: 'web01:9100', estado: 'up' })).toBe(true)
    expect(check({ prometheus_objetivo: 'web02:9100', estado: 'down' })).toBe(true)
    const targets = (await run('curl -s localhost:9090/api/v1/targets')).out
    // web02 es Rocky: firewalld rechaza el 9100 (y el servicio ni siquiera está corriendo).
    expect(targets).toContain('"lastError":"Get \\"http://web02:9100/metrics\\": dial tcp 192.168.10.12:9100: connect: no route to host"')
    expect((await run('curl -s "localhost:9090/api/v1/query?query=up%7Bjob%3D%22node%22%7D%20%3D%3D%200"')).out).toContain('"instance":"web02:9100"')
    expect(check({ prometheus_alerta: 'NodoCaido', estado: 'firing' })).toBe(true)
    expect((await run('amtool alert query --alertmanager.url=http://localhost:9093')).out).toMatch(/NodoCaido .* web02:9100 no responde +active/)
    expect((await run('mail -H')).out).toContain('[FIRING:1] NodoCaido')
    // Silencio: deja de aparecer como activa.
    expect((await run('amtool silence add alertname=NodoCaido --comment="mantenimiento" --duration=1h --alertmanager.url=http://localhost:9093')).out).toMatch(/^[0-9a-f-]{36}$/m)
    expect(check({ alertmanager_alerta: 'NodoCaido', silenciada: true })).toBe(true)
  })

  it('una alerta reciente queda pendiente hasta que pasa el "for" (sleep hace avanzar el tiempo)', async () => {
    const { run, check } = await session(lab({ archivos: { ...NOPASS, '/etc/prometheus/prometheus.yml': { contenido: PROM }, '/etc/prometheus/rules/nodos.yml': { contenido: RULES } } }, { servicios: { node_exporter: { activo: true } } }, { servicios: { node_exporter: { activo: true } } }))
    await run('ssh web02 "sudo firewall-cmd --add-port=9100/tcp"')
    await run('sudo systemctl start prometheus')
    expect(check({ prometheus_alerta: 'NodoCaido', estado: 'inactive' })).toBe(true)
    await run('ssh web02 "sudo systemctl stop node_exporter"')
    await run('sleep 30')
    expect(check({ prometheus_alerta: 'NodoCaido', estado: 'pending' })).toBe(true)
    await run('sleep 150')
    expect(check({ prometheus_alerta: 'NodoCaido', estado: 'firing' })).toBe(true)
  })

  it('errores de configuración: el servicio no arranca y promtool/amtool dicen por qué', async () => {
    const bad = PROM.replace('scrape_configs:', 'scrape_config:')
    const { run } = await session(lab({ archivos: { ...NOPASS, '/etc/prometheus/prometheus.yml': { contenido: bad }, '/etc/alertmanager/alertmanager.yml': { contenido: AM.replace('receiver: "correo"', 'receiver: "mail"') } } }))
    const c = await run('promtool check config /etc/prometheus/prometheus.yml')
    expect(c.code).toBe(1)
    expect(c.out).toContain('field scrape_config not found in type config.plain')
    expect((await run('sudo systemctl start prometheus')).code).not.toBe(0)
    expect((await run('sudo journalctl -u prometheus --no-pager')).out).toContain('Error loading config')
    const a = await run('amtool check-config /etc/alertmanager/alertmanager.yml')
    expect(a.out).toContain('FAILED: undefined receiver "mail" used in route')
    const r = await run(`printf 'groups:\\n  - name: x\\n    rules:\\n      - alert: Mal\\n        expr: rate(up)\\n' > /tmp/r.yml; promtool check rules /tmp/r.yml`)
    expect(r.out).toContain('could not parse expression: expected type range vector in call to function "rate", got instant vector')
  })
})

describe('Loki, Alloy y Grafana en el simulador', () => {
  it('Alloy manda los archivos de log a Loki (si el firewall deja pasar) y logcli los consulta', async () => {
    const { run, check } = await session(lab({ archivos: { ...NOPASS, '/etc/hosts': { contenido: '127.0.0.1 localhost\n192.168.10.30 mon01\n' } } }, { archivos: { ...NOPASS, '/etc/alloy/config.alloy': { contenido: ALLOY }, '/etc/hosts': { contenido: '127.0.0.1 localhost\n192.168.10.30 mon01\n' } } }))
    await run('sudo systemctl enable --now loki')
    await run('ssh web01 "sudo systemctl enable --now alloy"')
    await run('ssh -o BatchMode=yes nadie@web01 true')
    expect(check({ loki_lineas: '{host="web01"} |= "Invalid user nadie"' })).toBe(false)
    expect((await run('ssh web01 "sudo journalctl -u alloy --no-pager"')).out).toContain('error sending batch, will retry')
    await run('sudo firewall-cmd --add-port=3100/tcp')
    expect(check({ loki_lineas: '{host="web01"} |= "Invalid user nadie"' })).toBe(true)
    const q = await run(`logcli query '{job="system"} |= "Invalid user"'`)
    expect(q.out).toContain('Common labels: {filename="/var/log/auth.log", host="web01", job="system"}')
    expect(q.out).toMatch(/^\d{4}-\d\d-\d\dT[\d:]+Z .* sshd\[\d+\]: Invalid user nadie from 192.168.10.30/m)
    expect((await run('logcli labels host')).out).toContain('web01')
  })

  it('en Rocky, /var/log/secure es solo de root: Alloy avisa que no puede leerlo', async () => {
    const conf = ALLOY.replace('/var/log/*.log', '/var/log/secure')
    const { run, check } = await session(lab({ servicios: { loki: { activo: true } }, archivos: { ...NOPASS, '/etc/hosts': { contenido: '127.0.0.1 localhost\n192.168.10.30 mon01\n' } } }, {}, { archivos: { ...NOPASS, '/etc/alloy/config.alloy': { contenido: conf }, '/etc/hosts': { contenido: '127.0.0.1 localhost\n192.168.10.30 mon01\n' } } }))
    await run('sudo firewall-cmd --add-port=3100/tcp')
    await run('ssh web02 "sudo systemctl start alloy"')
    expect(check({ loki_lineas: '{host="web02"}' })).toBe(false)
    expect((await run('ssh web02 "sudo journalctl -u alloy --no-pager"')).out).toContain('open /var/log/secure: permission denied')
    await run('ssh web02 "sudo setfacl -m u:alloy:r /var/log/secure"')
    expect(check({ loki_lineas: '{host="web02"}' })).toBe(true)
  })

  it('Grafana con orígenes de datos provisionados y su prueba de conexión', async () => {
    const ds = 'apiVersion: 1\ndatasources:\n  - name: Prometheus\n    type: prometheus\n    url: http://localhost:9090\n    isDefault: true\n  - name: Loki\n    type: loki\n    url: http://localhost:3100\n'
    const { run, check } = await session(lab({ archivos: { ...NOPASS, '/etc/grafana/provisioning/datasources/lab.yaml': { contenido: ds } } }))
    await run('sudo systemctl start grafana-server loki')
    expect((await run('curl -s localhost:3000/api/health')).out).toContain('"database":"ok"')
    expect((await run('curl -s localhost:3000/api/datasources')).out).toContain('Invalid username or password')
    expect(check({ grafana_datasource: 'Loki', tipo: 'loki', funciona: true })).toBe(true)
    expect(check({ grafana_datasource: 'Prometheus', funciona: true })).toBe(false)
    const h = (await run('curl -s -u admin:admin localhost:3000/api/datasources/uid/prometheus/health')).out
    expect(h).toContain('connect: connection refused - There was an error returned querying the Prometheus API.')
    await run(`printf 'apiVersion: 1\\ndatasources:\\n  - name: A\\n    type: loki\\n    isDefault: true\\n  - name: B\\n    type: loki\\n    isDefault: true\\n' | sudo tee /etc/grafana/provisioning/datasources/lab.yaml`)
    expect((await run('sudo systemctl restart grafana-server')).code).not.toBe(0)
    expect((await run('sudo journalctl -u grafana-server --no-pager')).out).toContain('Only one datasource per organization can be marked as default')
  })
})

describe('Zabbix y repositorios de terceros', () => {
  it('los paquetes de Grafana y Zabbix necesitan su repositorio; zabbix_get respeta Server=', async () => {
    const { run } = await session(lab({ paquetes: { instalados: [] } }))
    expect((await run('sudo dnf install -y zabbix-get')).out).toContain('No match for argument: zabbix-get')
    await run(`printf '[zabbix]\\nname=Zabbix\\nbaseurl=https://repo.zabbix.com/zabbix/8.0/release/rocky/10/x86_64/\\nenabled=1\\n' | sudo tee /etc/yum.repos.d/zabbix.repo`)
    expect((await run('sudo dnf install -y zabbix-get')).code).toBe(0)
    await run('ssh web01 "sudo systemctl start zabbix-agent2"')
    const denied = await run('zabbix_get -s 192.168.10.11 -k agent.ping')
    expect(denied.out).toContain('Check access restrictions in Zabbix agent configuration')
    await run(`ssh web01 "sudo sed -i 's/^Server=127.0.0.1/Server=127.0.0.1,192.168.10.30/' /etc/zabbix/zabbix_agent2.conf && sudo systemctl restart zabbix-agent2"`)
    expect((await run('zabbix_get -s 192.168.10.11 -k agent.ping')).out.trim()).toBe('1')
    expect(Number((await run('zabbix_get -s 192.168.10.11 -k "vfs.fs.size[/,pfree]"')).out)).toBeGreaterThan(0)
    expect((await run('zabbix_get -s 192.168.10.11 -k nada.de.nada')).out).toContain('ZBX_NOTSUPPORTED: Unknown metric nada.de.nada')
  })
})

describe('configuración de Alloy', () => {
  it('valida bloques, atributos y referencias, formatea y arma el plan', () => {
    const blocks = validateAlloy(ALLOY)
    const plan = planAlloy(blocks, { hostname: 'web01', env: {} })
    expect(plan.logs[0].targets?.[0]).toMatchObject({ __path__: '/var/log/*.log', job: 'system', host: 'web01' })
    expect(plan.logs[0].sinks[0].urls).toEqual(['http://mon01:3100/loki/api/v1/push'])
    const err = (src: string) => {
      try {
        validateAlloy(src)
      } catch (e) {
        expect(e).toBeInstanceOf(AlloyError)
        return `${(e as AlloyError).line}:${(e as AlloyError).col}: ${(e as Error).message}`
      }
      return ''
    }
    expect(err(ALLOY.replace('loki.write.mon01.receiver', 'loki.write.local.receiver'))).toBe('7:17: component "loki.write.local" does not exist or is out of scope')
    expect(err(ALLOY.replace('targets    =', 'targetz    ='))).toBe('6:3: unrecognized attribute name "targetz"')
    expect(err(ALLOY.replace('loki.source.file', 'loki.source.files'))).toBe('5:1: unrecognized block name "loki.source.files"')
    expect(formatAlloy('loki.write "x" {\nendpoint {\nurl="http://a:3100/loki/api/v1/push"\n}\n}\n')).toBe('loki.write "x" {\n  endpoint {\n    url = "http://a:3100/loki/api/v1/push"\n  }\n}\n')
  })
})

describe('jq', () => {
  it('lee las respuestas de las APIs: campos, select, objetos, cadenas y errores', async () => {
    const { run } = await session(lab({ paquetes: { instalados: ['jq'] } }))
    await run(`echo '{"data":{"result":[{"metric":{"instance":"web01"},"value":[1,"0.5"]},{"metric":{"instance":"web02"},"value":[1,"2"]}]}}' > /tmp/r.json`)
    expect((await run(`jq -r '.data.result[] | select((.value[1]|tonumber) > 1) | "\\(.metric.instance) \\(.value[1])"' /tmp/r.json`)).out).toBe('web02 2\n')
    expect((await run(`jq -c '[.data.result[].metric.instance]' /tmp/r.json`)).out).toBe('["web01","web02"]\n')
    expect((await run(`jq '.data.result | map(.value[1] | tonumber) | add' /tmp/r.json`)).out).toBe('2.5\n')
    expect((await run(`jq '.data.result[0] | {i: .metric.instance}' /tmp/r.json`)).out).toBe('{\n  "i": "web01"\n}\n')
    expect((await run(`jq '.data.nada[]' /tmp/r.json`)).out).toContain('Cannot iterate over null (null)')
  })
})
