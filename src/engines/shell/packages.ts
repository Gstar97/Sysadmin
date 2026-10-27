/** Catálogo de paquetes del sistema simulado, con sus servicios, archivos y comandos. */

export interface PackageService {
  name: string
  description: string
  ports: number[]
  enabledByDefault?: boolean
  activeAfterInstall?: boolean
}

export interface PackageInfo {
  summary: string
  services?: PackageService[]
  files?: Record<string, string>
  commands?: string[]
  version: string
}

const nginxIndex = `<!DOCTYPE html>
<html>
<head><title>Welcome to nginx!</title></head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and working.</p>
</body>
</html>
`

const nginxConf = `user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log notice;
pid /run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '
                      '$status $body_bytes_sent "$http_referer" '
                      '"$http_user_agent" "$http_x_forwarded_for"';
    access_log  /var/log/nginx/access.log  main;
    sendfile            on;
    keepalive_timeout   65;
    include             /etc/nginx/mime.types;
    default_type        application/octet-stream;
    include /etc/nginx/conf.d/*.conf;

    server {
        listen       80;
        listen       [::]:80;
        server_name  _;
        root         /usr/share/nginx/html;
    }
}
`

const common: Record<string, PackageInfo> = {
  bash: { summary: 'The GNU Bourne Again shell', version: '5.2.26' },
  coreutils: { summary: 'A set of basic GNU tools commonly used in shell scripts', version: '9.5' },
  sudo: { summary: 'Allows restricted root access for specified users', version: '1.9.15' },
  curl: { summary: 'A utility for getting files from remote servers', version: '8.9.1', commands: ['curl'] },
  wget: { summary: 'A utility for retrieving files using the HTTP or FTP protocols', version: '1.24.5', commands: ['wget'] },
  nano: { summary: 'A small text editor', version: '8.1', commands: ['nano'] },
  git: { summary: 'Fast Version Control System', version: '2.47.1', commands: ['git'] },
  tree: { summary: 'File system tree viewer', version: '2.1.0', commands: ['tree'] },
  htop: { summary: 'Interactive process viewer', version: '3.3.0', commands: ['htop'] },
  rsync: { summary: 'A program for synchronizing files over a network', version: '3.3.0', commands: ['rsync'] },
  lsof: { summary: 'A utility which lists open files on a Linux/UNIX system', version: '4.98.0', commands: ['lsof'] },
  tcpdump: { summary: 'Command-line tool for monitoring network traffic', version: '4.99.5', commands: ['tcpdump'] },
  nmap: { summary: 'Network exploration tool and security scanner', version: '7.92', commands: ['nmap'] },
  python3: { summary: 'Python 3 interpreter', version: '3.12.8', commands: ['python3'] },
  tar: { summary: 'GNU file archiving program', version: '1.35', commands: ['tar'] },
  sysstat: { summary: 'Collection of performance monitoring tools for Linux', version: '12.7.5', commands: ['iostat', 'sar', 'mpstat'] },
  iotop: { summary: 'Top like utility for I/O', version: '0.6', commands: ['iotop'] },
  traceroute: { summary: 'Traces the route taken by packets over an IPv4/IPv6 network', version: '2.1.5', commands: ['traceroute'] },
  dos2unix: { summary: 'Text file format converters', version: '7.5.2', commands: ['dos2unix', 'unix2dos'] },
  xxd: { summary: 'A hex dump utility', version: '9.1.083', commands: ['xxd'] },
}

export const ROCKY_PACKAGES: Record<string, PackageInfo> = {
  ...common,
  nginx: {
    summary: 'A high performance web server and reverse proxy server',
    version: '1.26.3',
    services: [{ name: 'nginx', description: 'The nginx HTTP and reverse proxy server', ports: [80] }],
    files: {
      '/etc/nginx/nginx.conf': nginxConf,
      '/etc/nginx/conf.d/.keep': '',
      '/usr/share/nginx/html/index.html': nginxIndex,
      '/var/log/nginx/access.log': '',
      '/var/log/nginx/error.log': '',
    },
    commands: ['nginx'],
  },
  httpd: {
    summary: 'Apache HTTP Server',
    version: '2.4.63',
    services: [{ name: 'httpd', description: 'The Apache HTTP Server', ports: [80] }],
    files: {
      '/etc/httpd/conf/httpd.conf': 'ServerRoot "/etc/httpd"\nListen 80\nInclude conf.modules.d/*.conf\nUser apache\nGroup apache\nDocumentRoot "/var/www/html"\nIncludeOptional conf.d/*.conf\n',
      '/var/www/html/.keep': '',
    },
    commands: ['httpd', 'apachectl'],
  },
  'mariadb-server': {
    summary: 'The MariaDB server and related files',
    version: '10.11.11',
    services: [{ name: 'mariadb', description: 'MariaDB 10.11 database server', ports: [3306] }],
    files: { '/etc/my.cnf.d/mariadb-server.cnf': '[mysqld]\ndatadir=/var/lib/mysql\nsocket=/var/lib/mysql/mysql.sock\nlog-error=/var/log/mariadb/mariadb.log\n' },
    commands: ['mariadb', 'mysql'],
  },
  'postgresql-server': {
    summary: 'The programs needed to create and run a PostgreSQL server',
    version: '16.8',
    services: [{ name: 'postgresql', description: 'PostgreSQL database server', ports: [5432] }],
    commands: ['postgresql-setup', 'psql'],
  },
  'bind-utils': { summary: 'Utilities for querying DNS name servers', version: '9.18.33', commands: ['dig', 'nslookup', 'host'] },
  bind: {
    summary: 'The Berkeley Internet Name Domain (BIND) DNS server',
    version: '9.18.33',
    services: [{ name: 'named', description: 'Berkeley Internet Name Domain (DNS)', ports: [53] }],
    files: { '/etc/named.conf': 'options {\n\tlisten-on port 53 { 127.0.0.1; };\n\tdirectory \t"/var/named";\n\trecursion yes;\n};\n' },
  },
  chrony: {
    summary: 'An NTP client/server',
    version: '4.6.1',
    services: [{ name: 'chronyd', description: 'NTP client/server', ports: [123], enabledByDefault: true, activeAfterInstall: true }],
    commands: ['chronyc'],
  },
  'openssh-server': {
    summary: 'An open source SSH server daemon',
    version: '9.9p1',
    services: [{ name: 'sshd', description: 'OpenSSH server daemon', ports: [22], enabledByDefault: true, activeAfterInstall: true }],
  },
  firewalld: {
    summary: 'A firewall daemon with D-Bus interface providing a dynamic firewall',
    version: '2.3.0',
    services: [{ name: 'firewalld', description: 'firewalld - dynamic firewall daemon', ports: [], enabledByDefault: true, activeAfterInstall: true }],
    commands: ['firewall-cmd'],
  },
  cronie: {
    summary: 'Cron daemon for executing programs at set times',
    version: '1.7.0',
    services: [{ name: 'crond', description: 'Command Scheduler', ports: [], enabledByDefault: true, activeAfterInstall: true }],
    commands: ['crontab'],
  },
  'vim-enhanced': { summary: 'A version of the VIM editor which includes recent enhancements', version: '9.1.083', commands: ['vim'] },
  'net-tools': { summary: 'Basic networking tools (obsolete: use iproute)', version: '2.0', commands: ['ifconfig', 'netstat', 'route'] },
  'epel-release': { summary: 'Extra Packages for Enterprise Linux repository configuration', version: '10' },
  samba: {
    summary: 'Server and Client software to interoperate with Windows machines',
    version: '4.21.3',
    services: [{ name: 'smb', description: 'Samba SMB Daemon', ports: [139, 445] }],
    files: { '/etc/samba/smb.conf': '[global]\n\tworkgroup = SAMBA\n\tsecurity = user\n' },
  },
  'nfs-utils': {
    summary: 'NFS utilities and supporting clients and daemons for the kernel NFS server',
    version: '2.8.2',
    services: [{ name: 'nfs-server', description: 'NFS server and services', ports: [2049] }],
    files: { '/etc/exports': '' },
  },
}

export const UBUNTU_PACKAGES: Record<string, PackageInfo> = {
  ...common,
  nginx: {
    summary: 'small, powerful, scalable web/proxy server',
    version: '1.26.3',
    services: [{ name: 'nginx', description: 'A high performance web server and a reverse proxy server', ports: [80], enabledByDefault: true, activeAfterInstall: true }],
    files: {
      '/etc/nginx/nginx.conf': nginxConf.replace('user nginx;', 'user www-data;').replace('include /etc/nginx/conf.d/*.conf;', 'include /etc/nginx/conf.d/*.conf;\n    include /etc/nginx/sites-enabled/*;'),
      '/etc/nginx/sites-available/default': 'server {\n\tlisten 80 default_server;\n\troot /var/www/html;\n\tindex index.html index.nginx-debian.html;\n\tserver_name _;\n}\n',
      '/var/www/html/index.nginx-debian.html': nginxIndex,
      '/var/log/nginx/access.log': '',
      '/var/log/nginx/error.log': '',
    },
    commands: ['nginx'],
  },
  apache2: {
    summary: 'Apache HTTP Server',
    version: '2.4.63',
    services: [{ name: 'apache2', description: 'The Apache HTTP Server', ports: [80], enabledByDefault: true, activeAfterInstall: true }],
    files: { '/etc/apache2/apache2.conf': 'IncludeOptional sites-enabled/*.conf\n', '/var/www/html/index.html': '<h1>Apache2 Default Page</h1>\n' },
    commands: ['apache2ctl', 'a2ensite', 'a2dissite'],
  },
  'mariadb-server': {
    summary: 'MariaDB database server',
    version: '11.4.5',
    services: [{ name: 'mariadb', description: 'MariaDB 11.4 database server', ports: [3306], enabledByDefault: true, activeAfterInstall: true }],
    commands: ['mariadb', 'mysql'],
  },
  postgresql: {
    summary: 'object-relational SQL database',
    version: '16.8',
    services: [{ name: 'postgresql', description: 'PostgreSQL RDBMS', ports: [5432], enabledByDefault: true, activeAfterInstall: true }],
    commands: ['psql'],
  },
  dnsutils: { summary: 'Clients provided with BIND 9', version: '9.20.4', commands: ['dig', 'nslookup', 'host'] },
  bind9: {
    summary: 'Internet Domain Name Server',
    version: '9.20.4',
    services: [{ name: 'named', description: 'BIND Domain Name Server', ports: [53], enabledByDefault: true, activeAfterInstall: true }],
  },
  chrony: {
    summary: 'Versatile implementation of the Network Time Protocol',
    version: '4.6.1',
    services: [{ name: 'chrony', description: 'chrony, an NTP client/server', ports: [123], enabledByDefault: true, activeAfterInstall: true }],
    commands: ['chronyc'],
  },
  'openssh-server': {
    summary: 'secure shell (SSH) server, for secure access from remote machines',
    version: '9.9p1',
    services: [{ name: 'ssh', description: 'OpenBSD Secure Shell server', ports: [22], enabledByDefault: true, activeAfterInstall: true }],
  },
  ufw: { summary: 'program for managing a Netfilter firewall', version: '0.36.2', commands: ['ufw'] },
  cron: {
    summary: 'process scheduling daemon',
    version: '3.0pl1',
    services: [{ name: 'cron', description: 'Regular background program processing daemon', ports: [], enabledByDefault: true, activeAfterInstall: true }],
    commands: ['crontab'],
  },
  rsyslog: {
    summary: 'reliable system and kernel logging daemon',
    version: '8.2406.0',
    services: [{ name: 'rsyslog', description: 'System Logging Service', ports: [], enabledByDefault: true, activeAfterInstall: true }],
  },
  vim: { summary: 'Vi IMproved - enhanced vi editor', version: '9.1.0016', commands: ['vim'] },
  'net-tools': { summary: 'NET-3 networking toolkit (obsolete: use iproute2)', version: '2.10', commands: ['ifconfig', 'netstat', 'route'] },
  samba: {
    summary: 'SMB/CIFS file, print, and login server for Unix',
    version: '4.21.4',
    services: [{ name: 'smbd', description: 'Samba SMB Daemon', ports: [139, 445], enabledByDefault: true, activeAfterInstall: true }],
    files: { '/etc/samba/smb.conf': '[global]\n   workgroup = WORKGROUP\n   server role = standalone server\n' },
  },
  'nfs-kernel-server': {
    summary: 'support for NFS kernel server',
    version: '2.8.2',
    services: [{ name: 'nfs-server', description: 'NFS server and services', ports: [2049], enabledByDefault: true, activeAfterInstall: true }],
    files: { '/etc/exports': '' },
  },
}

export const BASE_INSTALLED = {
  rocky: ['bash', 'coreutils', 'sudo', 'curl', 'nano', 'tar', 'rsync', 'python3', 'chrony', 'openssh-server', 'firewalld', 'cronie', 'lsof'],
  ubuntu: ['bash', 'coreutils', 'sudo', 'curl', 'wget', 'nano', 'vim', 'xxd', 'tar', 'rsync', 'python3', 'chrony', 'openssh-server', 'ufw', 'cron', 'rsyslog', 'lsof'],
}

/** Comandos que solo existen si su paquete está instalado. */
export function commandPackage(distro: 'rocky' | 'ubuntu', command: string): string | undefined {
  const catalog = distro === 'rocky' ? ROCKY_PACKAGES : UBUNTU_PACKAGES
  for (const [name, info] of Object.entries(catalog)) {
    if (info.commands?.includes(command)) return name
  }
  return undefined
}
