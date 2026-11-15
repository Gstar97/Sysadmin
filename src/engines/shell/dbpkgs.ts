/**
 * Paquetes de bases de datos (MariaDB y PostgreSQL) con los archivos de configuración que trae
 * cada distribución, y lo que pasa al instalarlos.
 */
import type { PackageInfo } from './packages'

const MY_CNF_ROCKY = `#
# This group is read both both by the client and the server
# use it for options that affect everything
#
[client-server]

#
# include all files from the config directory
#
!includedir /etc/my.cnf.d

`

const MARIADB_SERVER_CNF_ROCKY = `#
# These groups are read by MariaDB server.
# Use it for options that only the server (but not clients) should see
#
# See the examples of server my.cnf files in /usr/share/mysql/
#

# this is read by the standalone daemon and embedded servers
[server]

# this is only for the mysqld standalone daemon
# Settings user and group are ignored when systemd is used.
# If you need to run mysqld under a different user or group,
# customize your systemd unit file for mysqld/mariadb according to the
# instructions in http://fedoraproject.org/wiki/Systemd
[mysqld]
datadir=/var/lib/mysql
socket=/var/lib/mysql/mysql.sock
log-error=/var/log/mariadb/mariadb.log
pid-file=/run/mariadb/mariadb.pid


#
# * Galera-related settings
#
[galera]
# Mandatory settings
#wsrep_on=ON
#wsrep_provider=
#wsrep_cluster_address=
#binlog_format=row
#default_storage_engine=InnoDB
#innodb_autoinc_lock_mode=2
#
# Allow server to accept connections on all interfaces.
#
#bind-address=0.0.0.0
#
# Optional setting
#wsrep_slave_threads=1
#innodb_flush_log_at_trx_commit=0

# this is only for embedded server
[embedded]

# This group is only read by MariaDB servers, not by MySQL.
# If you use the same .cnf file for MySQL and MariaDB,
# you can put MariaDB-only options here
[mariadb]

# This group is only read by MariaDB-10.11 servers.
# If you use the same .cnf file for MariaDB of different versions,
# use this group for options that older servers don't understand
[mariadb-10.11]

`

const CLIENT_CNF_ROCKY = `#
# These two groups are read by the client library
# Use it for options that affect all clients, but not the server
#


[client]

# This group is not read by mysql client library,
# If you use the same .cnf file for MySQL and MariaDB,
# use it for MariaDB-only client options
[client-mariadb]

`

const MY_CNF_UBUNTU = `# The MariaDB configuration file
#
# The MariaDB/MySQL tools read configuration files in the following order:
# 0. "/etc/mysql/my.cnf" symlinks to this file, reason why all the rest is read.
# 1. "/etc/mysql/mariadb.cnf" (this file) to set global defaults,
# 2. "/etc/mysql/conf.d/*.cnf" to set global options.
# 3. "/etc/mysql/mariadb.conf.d/*.cnf" to set MariaDB-only options.
# 4. "~/.my.cnf" to set user-specific options.
#
# If the same option is defined multiple times, the last one will apply.

[client-server]
# Port or socket location where to connect
# port = 3306
socket = /run/mysqld/mysqld.sock

# Import all .cnf files from configuration directory
!includedir /etc/mysql/conf.d/
!includedir /etc/mysql/mariadb.conf.d/
`

const SERVER_CNF_UBUNTU = `#
# These groups are read by MariaDB server.
# Use it for options that only the server (but not clients) should see

# this is read by the standalone daemon and embedded servers
[server]

# this is only for the mariadbd daemon
[mariadbd]

#
# * Basic Settings
#

#user                    = mysql
pid-file                = /run/mysqld/mysqld.pid
basedir                 = /usr
#datadir                 = /var/lib/mysql
#tmpdir                  = /tmp

# Broken reverse DNS slows down connections considerably and name resolve is
# safe to skip if there are no "host by domain name" access grants
#skip-name-resolve

# Instead of skip-networking the default is now to listen only on
# localhost which is more compatible and is not less secure.
bind-address            = 127.0.0.1

#
# * Fine Tuning
#

#key_buffer_size        = 128M
#max_allowed_packet     = 1G
#thread_stack           = 192K
#thread_cache_size      = 8
# This replaces the startup script and checks MyISAM tables if needed
# the first time they are touched
#myisam_recover_options = BACKUP
#max_connections        = 100
#table_cache            = 64

#
# * Logging and Replication
#

# Note: The configured log file or its directory need to be created
# and be writable by the mysql user, e.g.:
# $ sudo mkdir -m 2750 /var/log/mysql
# $ sudo chown mysql /var/log/mysql

# Both location gets rotated by the cronjob.
# Be aware that this log type is a performance killer.
# Recommend only changing this at runtime for short testing periods if needed!
#general_log_file       = /var/log/mysql/mysql.log
#general_log            = 1

# When running under systemd, error logging goes via stdout/stderr to journald
# and when running legacy init error logging goes to syslog due to
# /etc/mysql/conf.d/mariadb.conf.d/50-mysqld_safe.cnf
# Enable this if you want to have error logging into a separate file
#log_error = /var/log/mysql/error.log
# Enable the slow query log to see queries with especially long duration
#log_slow_query_file    = /var/log/mysql/mariadb-slow.log
#log_slow_query_time    = 10
#log_slow_verbosity     = query_plan,explain
#log-queries-not-using-indexes
#log_slow_min_examined_row_limit = 1000

# The following can be used as easy to replay backup logs or for replication.
# note: if you are setting up a replica, see README.Debian about other
#       settings you may need to change.
#server-id              = 1
#log_bin                = /var/log/mysql/mysql-bin.log
expire_logs_days        = 10
#max_binlog_size        = 100M

#
# * SSL/TLS
#

# For documentation, please read
# https://mariadb.com/kb/en/securing-connections-for-client-and-server/
#ssl-ca = /etc/mysql/cacert.pem
#ssl-cert = /etc/mysql/server-cert.pem
#ssl-key = /etc/mysql/server-key.pem
#require-secure-transport = on

#
# * Character sets
#

# MariaDB default is Latin1, but in Debian we rather default to the full
# utf8 4-byte character set. See also client.cnf
character-set-server  = utf8mb4
collation-server      = utf8mb4_general_ci

#
# * InnoDB
#

# InnoDB is enabled by default with a 10MB datafile in /var/lib/mysql/.
# Read the manual for more InnoDB related options. There are many!
# Most important is to give InnoDB 80 % of the system RAM for buffer use:
# https://mariadb.com/kb/en/innodb-system-variables/#innodb_buffer_pool_size
#innodb_buffer_pool_size = 8G

# this is only for embedded server
[embedded]

# This group is only read by MariaDB servers, not by MySQL.
# If you use the same .cnf file for MySQL and MariaDB,
# you can put MariaDB-only options here
[mariadbd]

# This group is only read by MariaDB-11.8 servers.
# If you use the same .cnf file for MariaDB of different versions,
# use this group for options that older servers don't understand
[mariadb-11.8]
`

const CLIENT_CNF_UBUNTU = `#
# This group is read by the client library
# Use it for options that affect all clients, but not the server
#

[client]
# Example of client certificate usage
#ssl-cert = /etc/mysql/client-cert.pem
#ssl-key  = /etc/mysql/client-key.pem
#
# Allow only TLS encrypted connections
#ssl-verify-server-cert = on

# This group is *never* read by mysql client library, though this
# /etc/mysql/mariadb.cnf.d/client.cnf file is not read by Oracle MySQL
# client anyway.
# If you use the same .cnf file for MySQL and MariaDB,
# use it for MariaDB-only client options
[client-mariadb]
`

const MY_CLIENT = ['mysql', 'mariadb', 'mysqldump', 'mariadb-dump', 'mysqladmin', 'mariadb-admin', 'mysqlbinlog', 'mariadb-binlog']
const PG_CLIENT = ['psql', 'pg_dump', 'pg_dumpall', 'pg_restore', 'createdb', 'dropdb', 'createuser', 'pg_isready']

export const ROCKY_DB: Record<string, PackageInfo> = {
  mariadb: { summary: 'A very fast and robust SQL database server', version: '10.11.11', commands: MY_CLIENT },
  'mariadb-server': {
    summary: 'The MariaDB server and related files',
    user: { name: 'mysql', uid: 27, home: '/var/lib/mysql', gecos: 'MySQL Server' },
    version: '10.11.11',
    requires: ['mariadb'],
    services: [{ name: 'mariadb', description: 'MariaDB 10.11 database server', ports: [3306] }],
    files: { '/etc/my.cnf': MY_CNF_ROCKY, '/etc/my.cnf.d/mariadb-server.cnf': MARIADB_SERVER_CNF_ROCKY, '/etc/my.cnf.d/client.cnf': CLIENT_CNF_ROCKY },
    commands: ['mysql_secure_installation', 'mariadb-secure-installation'],
  },
  'mariadb-backup': { summary: 'The mariabackup tool for physical online backups', version: '10.11.11', commands: ['mariabackup', 'mariadb-backup'] },
  postgresql: { summary: 'PostgreSQL client programs', version: '16.10', commands: PG_CLIENT },
  'postgresql-server': {
    summary: 'The programs needed to create and run a PostgreSQL server',
    user: { name: 'postgres', uid: 26, home: '/var/lib/pgsql', gecos: 'PostgreSQL Server' },
    version: '16.10',
    requires: ['postgresql'],
    services: [{ name: 'postgresql', description: 'PostgreSQL database server', ports: [5432] }],
    commands: ['postgresql-setup'],
  },
}

export const UBUNTU_DB: Record<string, PackageInfo> = {
  'mariadb-client': { summary: 'MariaDB database client (metapackage)', version: '1:11.8.6-5ubuntu0.1', commands: MY_CLIENT },
  'mariadb-server': {
    user: { name: 'mysql', uid: 112, home: '/nonexistent', gecos: 'MariaDB Server' },
    summary: 'MariaDB database server (metapackage)',
    version: '1:11.8.6-5ubuntu0.1',
    requires: ['mariadb-client'],
    services: [{ name: 'mariadb', description: 'MariaDB 11.8.6 database server', ports: [3306], enabledByDefault: true, activeAfterInstall: true }],
    files: { '/etc/mysql/mariadb.cnf': MY_CNF_UBUNTU, '/etc/mysql/mariadb.conf.d/50-server.cnf': SERVER_CNF_UBUNTU, '/etc/mysql/mariadb.conf.d/50-client.cnf': CLIENT_CNF_UBUNTU, '/etc/mysql/conf.d/.keep': '' },
    links: { '/etc/mysql/my.cnf': '/etc/alternatives/my.cnf', '/etc/alternatives/my.cnf': '/etc/mysql/mariadb.cnf' },
    commands: ['mysql_secure_installation', 'mariadb-secure-installation'],
  },
  'mariadb-backup': { summary: 'Backup tool for MariaDB server', version: '1:11.8.6-5ubuntu0.1', commands: ['mariabackup', 'mariadb-backup'] },
  'postgresql-client': { summary: 'front-end programs for PostgreSQL (supported version)', version: '18+278', commands: PG_CLIENT },
  postgresql: {
    user: { name: 'postgres', uid: 113, home: '/var/lib/postgresql', gecos: 'PostgreSQL administrator' },
    summary: 'object-relational SQL database (supported version)',
    version: '18+278',
    requires: ['postgresql-client'],
    services: [{ name: 'postgresql', description: 'PostgreSQL RDBMS', ports: [5432], enabledByDefault: true, activeAfterInstall: true }],
    commands: ['pg_lsclusters'],
  },
}
