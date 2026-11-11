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
  /** Cuenta de servicio que crea el paquete al instalarse (sin contraseña ni shell de inicio de sesión). */
  user?: { name: string; uid: number; home: string; gecos: string }
  services?: PackageService[]
  files?: Record<string, string>
  /** Enlaces simbólicos que deja el paquete (enlace → destino). */
  links?: Record<string, string>
  commands?: string[]
  version: string
  /** Permisos y grupo de algunos archivos (por ejemplo /etc/named.conf es root:named 640). */
  perms?: Record<string, { mode: number; group?: string }>
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

const NAMED_CONF_ROCKY = `//
// named.conf
//
// Provided by Red Hat bind package to configure the ISC BIND named(8) DNS
// server as a caching only nameserver (as a localhost DNS resolver only).
//
// See /usr/share/doc/bind*/sample/ for example named configuration files.
//

options {
	listen-on port 53 { 127.0.0.1; };
	listen-on-v6 port 53 { ::1; };
	directory 	"/var/named";
	dump-file 	"/var/named/data/cache_dump.db";
	statistics-file "/var/named/data/named_stats.txt";
	memstatistics-file "/var/named/data/named_mem_stats.txt";
	secroots-file	"/var/named/data/named.secroots";
	recursing-file	"/var/named/data/named.recursing";
	allow-query     { localhost; };

	/*
	 - If you are building an AUTHORITATIVE DNS server, do NOT enable recursion.
	 - If you are building a RECURSIVE (caching) DNS server, you need to enable
	   recursion.
	 - If your recursive DNS server has a public IP address, you MUST enable access
	   control to limit queries to your legitimate users. Failing to do so will
	   cause your server to become part of large scale DNS amplification
	   attacks. Implementing BCP38 within your network would greatly
	   reduce such attack surface
	*/
	recursion yes;

	dnssec-validation yes;

	managed-keys-directory "/var/named/dynamic";
	geoip-directory "/usr/share/GeoIP";

	pid-file "/run/named/named.pid";
	session-keyfile "/run/named/session.key";

	/* https://fedoraproject.org/wiki/Changes/CryptoPolicy */
	include "/etc/crypto-policies/back-ends/bind.config";
};

logging {
        channel default_debug {
                file "data/named.run";
                severity dynamic;
        };
};

zone "." IN {
	type hint;
	file "named.ca";
};

include "/etc/named.rfc1912.zones";
include "/etc/named.root.key";
`

const RFC1912_ZONES = `// named.rfc1912.zones:
//
// Provided by Red Hat caching-nameserver package
//
// ISC BIND named zone configuration for zones recommended by
// RFC 1912 section 4.1 : localhost TLDs and address zones
// and https://tools.ietf.org/html/rfc6303
// (c)2007 R W Franks
//
// See /usr/share/doc/bind*/sample/ for example named configuration files.
//

zone "localhost.localdomain" IN {
	type primary;
	file "named.localhost";
	allow-update { none; };
};

zone "localhost" IN {
	type primary;
	file "named.localhost";
	allow-update { none; };
};

zone "1.0.0.127.in-addr.arpa" IN {
	type primary;
	file "named.loopback";
	allow-update { none; };
};
`

const NAMED_LOCALHOST = `$TTL 1D
@	IN SOA	@ rname.invalid. (
					0	; serial
					1D	; refresh
					1H	; retry
					1W	; expire
					3H )	; minimum
	NS	@
	A	127.0.0.1
	AAAA	::1
`

const NAMED_LOOPBACK = `$TTL 1D
@	IN SOA	@ rname.invalid. (
					0	; serial
					1D	; refresh
					1H	; retry
					1W	; expire
					3H )	; minimum
	NS	@
	A	127.0.0.1
	AAAA	::1
	PTR	localhost.
`

const BIND9_CONF = `// This is the primary configuration file for the BIND DNS server named.
//
// Please read /usr/share/doc/bind9/README.Debian for information on the
// structure of BIND configuration files in Debian, *BEFORE* you customize
// this configuration file.
//
// If you are just adding zones, please do that in /etc/bind/named.conf.local

include "/etc/bind/named.conf.options";
include "/etc/bind/named.conf.local";
include "/etc/bind/named.conf.default-zones";
`

const BIND9_OPTIONS = `options {
	directory "/var/cache/bind";

	// If there is a firewall between you and nameservers you want
	// to talk to, you may need to fix the firewall to allow multiple
	// ports to talk.  See http://www.kb.cert.org/vuls/id/800113

	// If your ISP provided one or more IP addresses for stable
	// nameservers, you probably want to use them as forwarders.
	// Uncomment the following block, and insert the addresses replacing
	// the all-0's placeholder.

	// forwarders {
	// 	0.0.0.0;
	// };

	//========================================================================
	// If BIND logs error messages about the root key being expired,
	// you will need to update your keys.  See https://www.isc.org/bind-keys
	//========================================================================
	dnssec-validation auto;

	listen-on-v6 { any; };
};
`

const BIND9_LOCAL = `//
// Do any local configuration here
//

// Consider adding the 1918 zones here, if they are not used in your
// organization
//include "/etc/bind/zones.rfc1918";
`

const BIND9_DEFAULT_ZONES = `// prime the server with knowledge of the root servers
zone "." {
	type hint;
	file "/usr/share/dns/root.hints";
};

// be authoritative for the localhost forward and reverse zones, and for
// broadcast zones as per RFC 1912

zone "localhost" {
	type master;
	file "/etc/bind/db.local";
};

zone "127.in-addr.arpa" {
	type master;
	file "/etc/bind/db.127";
};
`

const BIND9_DB_LOCAL = `;
; BIND data file for local loopback interface
;
$TTL	604800
@	IN	SOA	localhost. root.localhost. (
			      2		; Serial
			 604800		; Refresh
			  86400		; Retry
			2419200		; Expire
			 604800 )	; Negative Cache TTL
;
@	IN	NS	localhost.
@	IN	A	127.0.0.1
@	IN	AAAA	::1
`

const BIND9_DB_127 = `;
; BIND reverse data file for local loopback interface
;
$TTL	604800
@	IN	SOA	localhost. root.localhost. (
			      1		; Serial
			 604800		; Refresh
			  86400		; Retry
			2419200		; Expire
			 604800 )	; Negative Cache TTL
;
@	IN	NS	localhost.
1.0.0	IN	PTR	localhost.
`

const UNBOUND_CONF_ROCKY = `#
# See unbound.conf(5) man page, version 1.24.
#
# this is a comment.

#Use this to include other text into the file.
#include: "otherfile.conf"

# The server clause sets the main parameters.
server:
	# whitespace is not necessary, but looks cleaner.

	# verbosity number, 0 is least verbose. 1 is default.
	verbosity: 1

	# specify the interfaces to answer queries from by ip-address.
	# The default is to listen to localhost (127.0.0.1 and ::1).
	# specify 0.0.0.0 and ::0 to bind to all available interfaces.
	# specify every interface[@port] on a new 'interface:' labelled line.
	# The listen interfaces are not changed on reload, only on restart.
	# interface: 192.0.2.153
	# interface: 0.0.0.0

	# control which clients are allowed to make (recursive) queries
	# to this server. Specify classless netblocks with /size and action.
	# By default everything is refused, except for localhost.
	# Choose deny (drop message), refuse (polite error reply),
	# allow (recursive ok), allow_snoop (recursive and nonrecursive ok)
	# access-control: 192.0.2.0/24 allow

	# the working directory.
	directory: "/etc/unbound"

	# the pid file. Can be an absolute path outside of chroot/work dir.
	pidfile: "/var/run/unbound/unbound.pid"

	# If given, after binding the port the user privileges are dropped.
	username: "unbound"

	# Enable IPv6
	do-ip6: yes

	# Harden against out of zone rrsets, to avoid spoofing attempts.
	harden-glue: yes

	# File with trust anchor for one zone, which is tracked with RFC5011 probes.
	auto-trust-anchor-file: "/var/lib/unbound/root.key"

# Remote control config section.
remote-control:
	control-enable: yes
	control-interface: 127.0.0.1

# Forward zones
# forward-zone:
# 	name: "."
# 	forward-addr: 1.1.1.1
`

const UNBOUND_CONF_UBUNTU = `# Unbound configuration file for Debian.
#
# See the unbound.conf(5) man page.
#
# See /usr/share/doc/unbound/examples/unbound.conf for a commented
# reference config file.
#
# The following line includes additional configuration files from the
# /etc/unbound/unbound.conf.d directory.
include-toplevel: "/etc/unbound/unbound.conf.d/*.conf"
`

const KEA_DHCP4_CONF = `// This is a basic configuration for the Kea DHCPv4 server. Subnet declarations
// are mostly commented out and no interfaces are listed. Therefore, the servers
// will not listen or respond to any queries.
// The basic configuration must be extended to specify interfaces on which
// the servers should listen. Make sure you at least update the following,
// before running this example in your network:
// - change the network interface names
// - change the subnets to match your network
// - change the option values to match your network
{
"Dhcp4": {
    // Add names of your network interfaces to listen on.
    "interfaces-config": {
        // You probably want to add just interface name (e.g. "eth0") or
        // specific IPv4 address on that interface name (e.g. "eth0/192.0.2.1").
        "interfaces": [ ]
    },

    // Use Memfile lease database backend to store leases in a CSV file.
    "lease-database": {
        "type": "memfile",
        "lfc-interval": 3600
    },

    // Addresses will be assigned with a lifetime of 4000 seconds.
    "valid-lifetime": 4000,

    // Global options, valid for all subnets.
    "option-data": [
        {
            "name": "domain-name-servers",
            "data": "192.0.2.1, 192.0.2.2"
        }
    ],

    "subnet4": [
        {
            // Every subnet needs an id: leases are stored with it.
            "id": 1,
            "subnet": "192.0.2.0/24",
            "pools": [ { "pool": "192.0.2.100 - 192.0.2.200" } ],
            "option-data": [
                {
                    "name": "routers",
                    "data": "192.0.2.1"
                }
            ]
        }
    ],

    "loggers": [
    {
        "name": "kea-dhcp4",
        "output-options": [
            {
                "output": "/var/log/kea/kea-dhcp4.log"
            }
        ],
        "severity": "INFO",
        "debuglevel": 0
    }
  ]
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
  mtr: { summary: 'Network diagnostic tool combining traceroute and ping', version: '0.95', commands: ['mtr'] },
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
    user: { name: 'nginx', uid: 990, home: '/var/lib/nginx', gecos: 'Nginx web server' },
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
    user: { name: 'apache', uid: 48, home: '/usr/share/httpd', gecos: 'Apache' },
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
    user: { name: 'mysql', uid: 27, home: '/var/lib/mysql', gecos: 'MySQL Server' },
    version: '10.11.11',
    services: [{ name: 'mariadb', description: 'MariaDB 10.11 database server', ports: [3306] }],
    files: { '/etc/my.cnf.d/mariadb-server.cnf': '[mysqld]\ndatadir=/var/lib/mysql\nsocket=/var/lib/mysql/mysql.sock\nlog-error=/var/log/mariadb/mariadb.log\n' },
    commands: ['mariadb', 'mysql'],
  },
  'postgresql-server': {
    summary: 'The programs needed to create and run a PostgreSQL server',
    user: { name: 'postgres', uid: 26, home: '/var/lib/pgsql', gecos: 'PostgreSQL Server' },
    version: '16.8',
    services: [{ name: 'postgresql', description: 'PostgreSQL database server', ports: [5432] }],
    commands: ['postgresql-setup', 'psql'],
  },
  'policycoreutils-python-utils': { summary: 'SELinux policy core python utilities', version: '3.8', commands: ['semanage', 'audit2allow', 'audit2why', 'sepolicy'] },
  'bind-utils': { summary: 'Utilities for querying DNS name servers', version: '9.18.33', commands: ['dig', 'nslookup', 'host'] },
  bind: {
    summary: 'The Berkeley Internet Name Domain (BIND) DNS (Domain Name System) server',
    user: { name: 'named', uid: 25, home: '/var/named', gecos: 'Named' },
    version: '9.18.33',
    services: [{ name: 'named', description: 'Berkeley Internet Name Domain (DNS)', ports: [53] }],
    files: {
      '/etc/named.conf': NAMED_CONF_ROCKY,
      '/etc/named.rfc1912.zones': RFC1912_ZONES,
      '/etc/named.root.key': '',
      '/var/named/named.ca': '; root hints (servidores raíz de internet)\n',
      '/var/named/named.localhost': NAMED_LOCALHOST,
      '/var/named/named.loopback': NAMED_LOOPBACK,
      '/var/named/data/.keep': '',
      '/var/named/dynamic/.keep': '',
    },
    perms: { '/etc/named.conf': { mode: 0o640, group: 'named' }, '/var/named': { mode: 0o771, group: 'named' }, '/var/named/named.localhost': { mode: 0o640, group: 'named' }, '/var/named/named.loopback': { mode: 0o640, group: 'named' } },
    commands: ['named', 'named-checkconf', 'named-checkzone', 'rndc'],
  },
  unbound: {
    summary: 'Validating, recursive, and caching DNS(SEC) resolver',
    user: { name: 'unbound', uid: 989, home: '/etc/unbound', gecos: 'Unbound DNS resolver' },
    version: '1.24.2',
    services: [{ name: 'unbound', description: 'Unbound recursive Domain Name Server', ports: [53] }],
    files: { '/etc/unbound/unbound.conf': UNBOUND_CONF_ROCKY, '/etc/unbound/conf.d/.keep': '', '/etc/unbound/local.d/.keep': '' },
    commands: ['unbound', 'unbound-checkconf', 'unbound-control'],
  },
  kea: {
    summary: 'DHCPv4, DHCPv6 and DDNS server from ISC',
    user: { name: 'kea', uid: 988, home: '/var/lib/kea', gecos: 'Kea DHCP' },
    version: '2.6.3',
    services: [
      { name: 'kea-dhcp4', description: 'Kea DHCPv4 Server', ports: [67] },
      { name: 'kea-dhcp6', description: 'Kea DHCPv6 Server', ports: [547] },
      { name: 'kea-ctrl-agent', description: 'Kea Control Agent', ports: [8000] },
    ],
    files: { '/etc/kea/kea-dhcp4.conf': KEA_DHCP4_CONF, '/var/lib/kea/.keep': '', '/var/log/kea/.keep': '' },
    commands: ['kea-dhcp4', 'kea-dhcp6', 'keactrl', 'kea-lfc'],
  },
  dnsmasq: {
    summary: 'A lightweight DHCP/caching DNS server',
    user: { name: 'dnsmasq', uid: 987, home: '/var/lib/dnsmasq', gecos: 'Dnsmasq DHCP and DNS server' },
    version: '2.90',
    services: [{ name: 'dnsmasq', description: 'DNS caching server.', ports: [53] }],
    files: { '/etc/dnsmasq.conf': '# Configuration file for dnsmasq.\n#\n# Format is one option per line, legal options are the same\n# as the long options legal on the command line.\n\n#interface=\n#dhcp-range=192.168.0.50,192.168.0.150,12h\nconf-dir=/etc/dnsmasq.d,.rpmnew,.rpmsave,.rpmorig\n', '/etc/dnsmasq.d/.keep': '' },
    commands: ['dnsmasq'],
  },
  ipcalc: { summary: 'IP network address calculator', version: '1.0.3', commands: ['ipcalc'] },
  iputils: { summary: 'Network monitoring tools including ping', version: '20240905', commands: ['arping', 'tracepath'] },
  ethtool: { summary: 'Settings tool for Ethernet NICs', version: '6.11', commands: ['ethtool'] },
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
  at: {
    summary: 'Job spooling tools',
    version: '3.2.5',
    services: [{ name: 'atd', description: 'Deferred execution scheduler', ports: [], enabledByDefault: false, activeAfterInstall: false }],
    commands: ['at', 'atq', 'atrm'],
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
  apparmor: { summary: 'user-space parser utility for AppArmor', version: '4.0.1', commands: ['aa-status', 'apparmor_parser', 'aa-enabled'] },
  'apparmor-utils': { summary: 'utilities for controlling AppArmor', version: '4.0.1', commands: ['aa-complain', 'aa-enforce', 'aa-disable', 'aa-logprof', 'aa-genprof'] },
  nginx: {
    summary: 'small, powerful, scalable web/proxy server',
    version: '1.26.3',
    services: [{ name: 'nginx', description: 'A high performance web server and a reverse proxy server', ports: [80], enabledByDefault: true, activeAfterInstall: true }],
    files: {
      '/etc/nginx/nginx.conf': nginxConf
        .replace('user nginx;', 'user www-data;')
        .replace('include /etc/nginx/conf.d/*.conf;', 'include /etc/nginx/conf.d/*.conf;\n    include /etc/nginx/sites-enabled/*;')
        .replace(/\n {4}server \{[\s\S]*?\n {4}\}\n/, '\n'),
      '/etc/nginx/sites-available/default': 'server {\n\tlisten 80 default_server;\n\troot /var/www/html;\n\tindex index.html index.nginx-debian.html;\n\tserver_name _;\n}\n',
      '/var/www/html/index.nginx-debian.html': nginxIndex,
      '/usr/share/nginx/html/index.html': nginxIndex,
      '/var/log/nginx/access.log': '',
      '/var/log/nginx/error.log': '',
    },
    links: { '/etc/nginx/sites-enabled/default': '/etc/nginx/sites-available/default' },
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
    user: { name: 'mysql', uid: 112, home: '/nonexistent', gecos: 'MySQL Server' },
    summary: 'MariaDB database server',
    version: '11.4.5',
    services: [{ name: 'mariadb', description: 'MariaDB 11.4 database server', ports: [3306], enabledByDefault: true, activeAfterInstall: true }],
    commands: ['mariadb', 'mysql'],
  },
  postgresql: {
    user: { name: 'postgres', uid: 113, home: '/var/lib/postgresql', gecos: 'PostgreSQL administrator' },
    summary: 'object-relational SQL database',
    version: '16.8',
    services: [{ name: 'postgresql', description: 'PostgreSQL RDBMS', ports: [5432], enabledByDefault: true, activeAfterInstall: true }],
    commands: ['psql'],
  },
  dnsutils: { summary: 'Clients provided with BIND 9', version: '9.18.30', commands: ['dig', 'nslookup', 'host'] },
  bind9: {
    user: { name: 'bind', uid: 114, home: '/var/cache/bind', gecos: '' },
    summary: 'Internet Domain Name Server',
    version: '9.18.30',
    services: [{ name: 'named', description: 'BIND Domain Name Server', ports: [53], enabledByDefault: true, activeAfterInstall: true }],
    files: {
      '/etc/bind/named.conf': BIND9_CONF,
      '/etc/bind/named.conf.options': BIND9_OPTIONS,
      '/etc/bind/named.conf.local': BIND9_LOCAL,
      '/etc/bind/named.conf.default-zones': BIND9_DEFAULT_ZONES,
      '/etc/bind/db.local': BIND9_DB_LOCAL,
      '/etc/bind/db.127': BIND9_DB_127,
      '/var/cache/bind/.keep': '',
      '/var/lib/bind/.keep': '',
    },
    perms: { '/etc/bind': { mode: 0o2755, group: 'bind' }, '/etc/bind/named.conf': { mode: 0o644, group: 'bind' }, '/var/cache/bind': { mode: 0o775, group: 'bind' } },
    commands: ['named', 'named-checkconf', 'named-checkzone', 'rndc'],
  },
  unbound: {
    user: { name: 'unbound', uid: 115, home: '/var/lib/unbound', gecos: '' },
    summary: 'validating, recursive, caching DNS resolver',
    version: '1.19.2',
    services: [{ name: 'unbound', description: 'Unbound DNS server', ports: [53], enabledByDefault: true, activeAfterInstall: true }],
    files: { '/etc/unbound/unbound.conf': UNBOUND_CONF_UBUNTU, '/etc/unbound/unbound.conf.d/remote-control.conf': 'remote-control:\n  control-enable: yes\n  control-interface: /run/unbound.ctl\n' },
    commands: ['unbound', 'unbound-checkconf', 'unbound-control'],
  },
  'kea-dhcp4-server': {
    user: { name: '_kea', uid: 116, home: '/var/lib/kea', gecos: 'Kea DHCP' },
    summary: 'IPv4 DHCP server',
    version: '2.4.1',
    services: [{ name: 'kea-dhcp4-server', description: 'Kea IPv4 DHCP daemon', ports: [67], enabledByDefault: true, activeAfterInstall: true }],
    files: { '/etc/kea/kea-dhcp4.conf': KEA_DHCP4_CONF, '/var/lib/kea/.keep': '', '/var/log/kea/.keep': '' },
    commands: ['kea-dhcp4', 'kea-lfc'],
  },
  dnsmasq: {
    summary: 'Small caching DNS proxy and DHCP/TFTP server',
    version: '2.90',
    services: [{ name: 'dnsmasq', description: 'dnsmasq - A lightweight DHCP and caching DNS server', ports: [53], enabledByDefault: true, activeAfterInstall: true }],
    files: { '/etc/dnsmasq.conf': '# Configuration file for dnsmasq.\n#interface=\n#dhcp-range=192.168.0.50,192.168.0.150,12h\n', '/etc/dnsmasq.d/.keep': '' },
    commands: ['dnsmasq'],
  },
  ipcalc: { summary: 'parameter calculator for IPv4 addresses', version: '0.51', commands: ['ipcalc'] },
  'iputils-arping': { summary: 'Tool to send ICMP echo requests to an ARP address', version: '20240117', commands: ['arping'] },
  ethtool: { summary: 'display or change Ethernet device settings', version: '6.7', commands: ['ethtool'] },
  chrony: {
    user: { name: '_chrony', uid: 111, home: '/var/lib/chrony', gecos: 'Chrony daemon' },
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
  at: {
    summary: 'Delayed job execution and batch processing',
    version: '3.2.5',
    services: [{ name: 'atd', description: 'Deferred execution scheduler', ports: [], enabledByDefault: true, activeAfterInstall: true }],
    commands: ['at', 'atq', 'atrm'],
  },
  cron: {
    summary: 'process scheduling daemon',
    version: '3.0pl1',
    services: [{ name: 'cron', description: 'Regular background program processing daemon', ports: [], enabledByDefault: true, activeAfterInstall: true }],
    commands: ['crontab'],
  },
  rsyslog: {
    user: { name: 'syslog', uid: 104, home: '/nonexistent', gecos: '' },
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
  rocky: ['bash', 'coreutils', 'sudo', 'curl', 'nano', 'tar', 'rsync', 'python3', 'chrony', 'openssh-server', 'firewalld', 'cronie', 'lsof', 'ipcalc', 'iputils', 'ethtool'],
  ubuntu: ['bash', 'coreutils', 'sudo', 'curl', 'wget', 'nano', 'vim', 'xxd', 'tar', 'rsync', 'python3', 'chrony', 'openssh-server', 'ufw', 'cron', 'rsyslog', 'lsof', 'apparmor', 'dnsutils', 'ethtool'],
}

/** Comandos que solo existen si su paquete está instalado. */
/** Herramientas que solo existen en la otra familia de distribuciones (en esta, "command not found"). */
export const OTHER_FAMILY: Record<'rocky' | 'ubuntu', string[]> = {
  rocky: ['apt', 'apt-get', 'apt-cache', 'dpkg', 'adduser', 'ufw', 'grub-mkconfig', 'update-grub', 'update-initramfs'],
  ubuntu: ['dnf', 'yum', 'rpm', 'firewall-cmd', 'nmcli', 'authselect', 'grub2-mkconfig', 'grubby', 'dracut', 'lsinitrd'],
}

export function commandPackage(distro: 'rocky' | 'ubuntu', command: string): string | undefined {
  if (OTHER_FAMILY[distro].includes(command)) return '(otra familia)'
  const catalog = distro === 'rocky' ? ROCKY_PACKAGES : UBUNTU_PACKAGES
  for (const [name, info] of Object.entries(catalog)) {
    if (info.commands?.includes(command)) return name
  }
  return undefined
}
