/**
 * Paquetes de monitoreo y logs. Prometheus, node_exporter y Alertmanager no tienen repositorio
 * oficial: se instalan desde los binarios de GitHub (para el laboratorio vienen empaquetados, como
 * rest-server). Grafana, Loki, Alloy y logcli vienen del repositorio de Grafana; el agente de
 * Zabbix y zabbix_get, del de Zabbix: esos solo aparecen con su repositorio agregado.
 */
import type { PackageInfo } from './packages'

export const PROMETHEUS_VERSION = '3.13.5'
export const NODE_EXPORTER_VERSION = '1.12.1'
export const ALERTMANAGER_VERSION = '0.32.1'
export const GRAFANA_VERSION = '13.0.3'
export const LOKI_VERSION = '3.7.10'
export const ALLOY_VERSION = '1.18.0'
export const ZABBIX_VERSION = '8.0.0'

export const PROMETHEUS_YML = `# Configuración de Prometheus.
global:
  scrape_interval: 15s
  evaluation_interval: 15s

alerting:
  alertmanagers:
    - static_configs:
        - targets: []

rule_files: []

scrape_configs:
  - job_name: "prometheus"
    static_configs:
      - targets: ["localhost:9090"]
`

export const ALERTMANAGER_YML = `route:
  receiver: "default"
  group_by: ["alertname"]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

receivers:
  - name: "default"
`

export const LOKI_YML = `auth_enabled: false

server:
  http_listen_port: 3100
  grpc_listen_port: 9096
  log_level: info

common:
  instance_addr: 127.0.0.1
  path_prefix: /var/lib/loki
  storage:
    filesystem:
      chunks_directory: /var/lib/loki/chunks
      rules_directory: /var/lib/loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  retention_period: 744h

ruler:
  alertmanager_url: http://localhost:9093
`

export const ALLOY_CONFIG = `// Configuración de ejemplo de Alloy.
// Referencia completa: https://grafana.com/docs/alloy
logging {
  level = "warn"
}

prometheus.exporter.unix "default" {
  include_exporter_metrics = true
}

prometheus.scrape "default" {
  targets    = prometheus.exporter.unix.default.targets
  forward_to = []
}
`

export const GRAFANA_INI = `# Configuración de Grafana: lo que no está acá usa el valor de fábrica (defaults.ini).
[server]
http_port = 3000

[security]
admin_user = admin
;admin_password = admin

[paths]
provisioning = /etc/grafana/provisioning
`

export function zabbixAgentConf(): string {
  return `# Configuración del agente 2 de Zabbix. Lo comentado usa el valor de fábrica.
PidFile=/run/zabbix/zabbix_agent2.pid
LogFile=/var/log/zabbix/zabbix_agent2.log
LogFileSize=0

### Servidores que pueden consultar a este agente (chequeos pasivos, puerto 10050)
Server=127.0.0.1

### Servidores a los que el agente les manda datos por su cuenta (chequeos activos)
ServerActive=127.0.0.1

### Nombre del equipo tal como está dado de alta en Zabbix
Hostname=Zabbix server

# ListenPort=10050
Include=/etc/zabbix/zabbix_agent2.d/*.conf
`
}

const unit = (desc: string, user: string, exec: string, after = 'network-online.target') => `[Unit]
Description=${desc}
Wants=network-online.target
After=${after}

[Service]
Type=simple
User=${user}
Group=${user}
ExecStart=${exec}
Restart=on-failure

[Install]
WantedBy=multi-user.target
`

export const PROMETHEUS_EXEC = '/usr/local/bin/prometheus --config.file=/etc/prometheus/prometheus.yml --storage.tsdb.path=/var/lib/prometheus'
export const ALERTMANAGER_EXEC = '/usr/local/bin/alertmanager --config.file=/etc/alertmanager/alertmanager.yml --storage.path=/var/lib/alertmanager'

function common(distro: 'rocky' | 'ubuntu'): Record<string, PackageInfo> {
  const u = distro === 'rocky' ? 970 : 990
  return {
    prometheus: {
      summary: 'Prometheus monitoring system and time series database (binario oficial, empaquetado para el laboratorio)',
      version: PROMETHEUS_VERSION,
      user: { name: 'prometheus', uid: u, home: '/var/lib/prometheus', gecos: 'Prometheus' },
      services: [{ name: 'prometheus', description: 'Prometheus', ports: [9090], enabledByDefault: false, activeAfterInstall: false }],
      files: {
        '/etc/prometheus/prometheus.yml': PROMETHEUS_YML,
        '/etc/systemd/system/prometheus.service': unit('Prometheus', 'prometheus', PROMETHEUS_EXEC),
      },
      commands: ['prometheus', 'promtool'],
    },
    node_exporter: {
      summary: 'Prometheus exporter for machine metrics (binario oficial, empaquetado para el laboratorio)',
      version: NODE_EXPORTER_VERSION,
      user: { name: 'node_exporter', uid: u + 1, home: '/', gecos: 'node_exporter' },
      services: [{ name: 'node_exporter', description: 'Prometheus Node Exporter', ports: [9100], enabledByDefault: false, activeAfterInstall: false }],
      files: { '/etc/systemd/system/node_exporter.service': unit('Prometheus Node Exporter', 'node_exporter', '/usr/local/bin/node_exporter') },
      commands: ['node_exporter'],
    },
    alertmanager: {
      summary: 'Prometheus Alertmanager (binario oficial, empaquetado para el laboratorio)',
      version: ALERTMANAGER_VERSION,
      user: { name: 'alertmanager', uid: u + 2, home: '/var/lib/alertmanager', gecos: 'Alertmanager' },
      services: [{ name: 'alertmanager', description: 'Prometheus Alertmanager', ports: [9093, 9094], enabledByDefault: false, activeAfterInstall: false }],
      files: {
        '/etc/alertmanager/alertmanager.yml': ALERTMANAGER_YML,
        '/etc/systemd/system/alertmanager.service': unit('Prometheus Alertmanager', 'alertmanager', ALERTMANAGER_EXEC),
      },
      commands: ['alertmanager', 'amtool'],
    },
    grafana: {
      summary: 'Grafana: dashboards, alerting and visualization',
      version: GRAFANA_VERSION,
      user: { name: 'grafana', uid: u + 3, home: '/usr/share/grafana', gecos: 'grafana user' },
      services: [{ name: 'grafana-server', description: 'Grafana instance', ports: [3000], enabledByDefault: false, activeAfterInstall: false }],
      files: {
        '/etc/grafana/grafana.ini': GRAFANA_INI,
        '/etc/grafana/provisioning/datasources/.keep': '',
        '/etc/grafana/provisioning/dashboards/.keep': '',
        '/etc/grafana/provisioning/alerting/.keep': '',
        '/var/lib/grafana/.keep': '',
      },
      commands: ['grafana', 'grafana-server', 'grafana-cli'],
    },
    loki: {
      summary: 'Loki: like Prometheus, but for logs',
      version: LOKI_VERSION,
      user: { name: 'loki', uid: u + 4, home: '/var/lib/loki', gecos: 'Loki' },
      services: [{ name: 'loki', description: 'Loki service', ports: [3100, 9096], enabledByDefault: false, activeAfterInstall: false }],
      files: { '/etc/loki/config.yml': LOKI_YML, '/var/lib/loki/rules/fake/.keep': '' },
      commands: ['loki'],
    },
    logcli: { summary: 'LogCLI: command line client for Loki', version: LOKI_VERSION, commands: ['logcli'] },
    alloy: {
      summary: 'Grafana Alloy: OpenTelemetry collector with Prometheus and Loki pipelines',
      version: ALLOY_VERSION,
      user: { name: 'alloy', uid: u + 5, home: '/var/lib/alloy', gecos: 'Alloy' },
      services: [{ name: 'alloy', description: 'Vendor-agnostic OpenTelemetry Collector distribution with programmable pipelines', ports: [12345], enabledByDefault: false, activeAfterInstall: false }],
      files: {
        '/etc/alloy/config.alloy': ALLOY_CONFIG,
        [distro === 'rocky' ? '/etc/sysconfig/alloy' : '/etc/default/alloy']: '## Path:\n## Description: Grafana Alloy settings\n## Type:        string\nCONFIG_FILE="/etc/alloy/config.alloy"\nCUSTOM_ARGS=""\nRESTART_ON_UPGRADE=true\n',
      },
      commands: ['alloy'],
    },
    'zabbix-agent2': {
      summary: 'Zabbix Agent 2',
      version: `${ZABBIX_VERSION}-1`,
      user: { name: 'zabbix', uid: u + 6, home: '/var/lib/zabbix', gecos: 'Zabbix Monitoring System' },
      services: [{ name: 'zabbix-agent2', description: 'Zabbix Agent 2', ports: [10050], enabledByDefault: false, activeAfterInstall: false }],
      files: { '/etc/zabbix/zabbix_agent2.conf': zabbixAgentConf(), '/etc/zabbix/zabbix_agent2.d/.keep': '', '/var/log/zabbix/zabbix_agent2.log': '' },
      commands: ['zabbix_agent2'],
    },
    'zabbix-get': { summary: 'Zabbix Get: pide un dato a un agente', version: `${ZABBIX_VERSION}-1`, commands: ['zabbix_get'] },
  }
}

export const ROCKY_MON = common('rocky')
export const UBUNTU_MON = common('ubuntu')

export const GRAFANA_PKGS = ['grafana', 'loki', 'logcli', 'alloy']
export const ZABBIX_PKGS = ['zabbix-agent2', 'zabbix-get']
