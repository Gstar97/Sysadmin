/** Catálogo de paquetes del sistema simulado, con sus servicios, archivos y comandos. */
import { ROCKY_DB, UBUNTU_DB } from './dbpkgs'
import { ROCKY_WEB, UBUNTU_WEB } from './webpkgs'
import { ROCKY_VIRT, UBUNTU_VIRT } from './virtpkgs'

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
  /** Timers de systemd que trae el paquete. */
  timers?: { name: string; description: string; calendar: string; enabled: boolean }[]
  version: string
  /** Permisos y grupo de algunos archivos (por ejemplo /etc/named.conf es root:named 640). */
  perms?: Record<string, { mode: number; group?: string }>
  /** Paquetes que se instalan junto con este (dependencias). */
  requires?: string[]
}

const SMB_CONF_ROCKY = `# See smb.conf.example for a more detailed config file or
# read the smb.conf manpage.
# Run 'testparm' to verify the config is correct after
# you modified it.
#
# Note:
# SMB1 is disabled by default. This means clients without support for SMB2 or
# SMB3 are no longer able to connect to smbd (by default).

[global]
	workgroup = SAMBA
	security = user

	passdb backend = tdbsam

	printing = cups
	printcap name = cups
	load printers = yes
	cups options = raw

[homes]
	comment = Home Directories
	valid users = %S, %D%w%S
	browseable = No
	read only = No
	inherit acls = Yes

[printers]
	comment = All Printers
	path = /var/tmp
	printable = Yes
	create mask = 0600
	browseable = No

[print$]
	comment = Printer Drivers
	path = /var/lib/samba/drivers
	write list = @printadmin root
	force group = @printadmin
	create mask = 0664
	directory mask = 0775
`

const SMB_CONF_UBUNTU = `#
# Sample configuration file for the Samba suite for Debian GNU/Linux.
#
#
# This is the main Samba configuration file. You should read the
# smb.conf(5) manual page in order to understand the options listed
# here. Samba has a huge number of configurable options most of which
# are not shown in this example
#
# Some options that are often worth tuning have been included as
# commented-out examples in this file.
#  - When such options are commented with ";", the proposed setting
#    differs from the default Samba behaviour
#  - When commented with "#", the proposed setting is the default
#    behaviour of Samba but the option is considered important
#    enough to be mentioned here
#
# NOTE: Whenever you modify this file you should run the command
# "testparm" to check that you have not made any basic syntactic
# errors.

#======================= Global Settings =======================

[global]

## Browsing/Identification ###

# Change this to the workgroup/NT-domain name your Samba server will part of
   workgroup = WORKGROUP

#### Networking ####

# The specific set of interfaces / networks to bind to
# This can be either the interface name or an IP address/netmask;
# interface names are normally preferred
;   interfaces = 127.0.0.0/8 eth0

#### Debugging/Accounting ####

# This tells Samba to use a separate log file for each machine
# that connects
   log file = /var/log/samba/log.%m

# Cap the size of the individual log files (in KiB).
   max log size = 1000

# We want Samba to only log to /var/log/samba/log.{smbd,nmbd}.
# Append syslog@1 if you want important messages to be sent to syslog too.
   logging = file

# Do something sensible when Samba crashes: mail the admin a backtrace
   panic action = /usr/share/samba/panic-action %d


####### Authentication #######

# Server role. Defines in which mode Samba will operate. Possible
# values are "standalone server", "member server", "classic primary
# domain controller", "classic backup domain controller", "active
# directory domain controller".
#
# Most people will want "standalone server" or "member server".
# Running as "active directory domain controller" will require first
# running "samba-tool domain provision" to wipe databases and create a
# new domain.
   server role = standalone server

   obey pam restrictions = yes

# This boolean parameter controls whether Samba attempts to sync the Unix
# password with the SMB password when the encrypted SMB password in the
# passdb is changed.
   unix password sync = yes

# For Unix password sync to work on a Debian GNU/Linux system, the following
# parameters must be set (thanks to Ian Kahan <kahan@informatik.tu-muenchen.de> for
# sending the correct chat script for the passwd program in Debian Sarge).
   passwd program = /usr/bin/passwd %u
   passwd chat = *Enter\\snew\\s*\\spassword:* %n\\n *Retype\\snew\\s*\\spassword:* %n\\n *password\\supdated\\ssuccessfully* .

# This boolean controls whether PAM will be used for password changes
# when requested by an SMB client instead of the program listed in
# 'passwd program'. The default is 'no'.
   pam password change = yes

# This option controls how unsuccessful authentication attempts are mapped
# to anonymous connections
   map to guest = bad user

############ Misc ############

# Allow users who've been granted usershare privileges to create
# public shares, not just authenticated ones
   usershare allow guests = yes

#======================= Share Definitions =======================

# Un-comment the following (and tweak the other settings below to suit)
# to enable the default home directory shares. This will share each
# user's home directory as \\\\server\\username
;[homes]
;   comment = Home Directories
;   browseable = no

# By default, the home directories are exported read-only. Change the
# next parameter to 'no' if you want to be able to write to them.
;   read only = yes

[printers]
   comment = All Printers
   browseable = no
   path = /var/tmp
   printable = yes
   guest ok = no
   read only = yes
   create mask = 0700

# Windows clients look for this share name as a source of downloadable
# printer drivers
[print$]
   comment = Printer Drivers
   path = /var/lib/samba/printers
   browseable = yes
   read only = yes
   guest ok = no
`

const MAIN_CF_ROCKY = `# Global Postfix configuration file. This file lists only a subset
# of all parameters. For the syntax, and for a complete parameter
# list, see the postconf(5) manual page (command: "man 5 postconf").
#
# For common configuration examples, see BASIC_CONFIGURATION_README
# and STANDARD_CONFIGURATION_README. To find these documents, use
# the command "postconf html_directory readme_directory", or go to
# http://www.postfix.org/BASIC_CONFIGURATION_README.html etc.
#
# For best results, change no more than 2-3 parameters at a time,
# and test if Postfix still works after every change.

# COMPATIBILITY
#
compatibility_level = 3.8

# SOFT BOUNCE
#
#soft_bounce = no

# LOCAL PATHNAME INFORMATION
#
queue_directory = /var/spool/postfix
command_directory = /usr/sbin
daemon_directory = /usr/libexec/postfix
data_directory = /var/lib/postfix

# QUEUE AND PROCESS OWNERSHIP
#
mail_owner = postfix

# INTERNET HOST AND DOMAIN NAMES
#
#myhostname = host.domain.tld
#myhostname = virtual.domain.tld

#mydomain = domain.tld

# SENDING MAIL
#
#myorigin = $myhostname
#myorigin = $mydomain

# RECEIVING MAIL

#inet_interfaces = all
#inet_interfaces = $myhostname
#inet_interfaces = $myhostname, localhost
inet_interfaces = localhost

# Enable IPv4, and IPv6 if supported
inet_protocols = all

mydestination = $myhostname, localhost.$mydomain, localhost

# REJECTING MAIL FOR UNKNOWN LOCAL USERS
#
unknown_local_recipient_reject_code = 550

# TRUST AND RELAY CONTROL
#
#mynetworks_style = class
#mynetworks_style = subnet
#mynetworks_style = host

#mynetworks = 168.100.3.0/28, 127.0.0.0/8
#mynetworks = $config_directory/mynetworks
#mynetworks = lmdb:/etc/postfix/network_table

# INTERNET OR INTRANET

# The relayhost parameter specifies the default host to send mail to
# when no entry is matched in the optional transport(5) table. When
# no relayhost is given, mail is routed directly to the destination.
#
# On an intranet, specify the organizational domain name. If your
# internal DNS uses no MX records, specify the name of the intranet
# gateway host instead.
#
# In the case of SMTP, specify a domain, host, host:port, [host]:port,
# [address] or [address]:port; the form [host] turns off MX lookups.
#
#relayhost = $mydomain
#relayhost = [gateway.my.domain]
#relayhost = [mailserver.isp.tld]
#relayhost = uucphost
#relayhost = [an.ip.add.ress]

# ALIAS DATABASE
#
#alias_maps = dbm:/etc/aliases
alias_maps = lmdb:/etc/aliases
#alias_maps = lmdb:/etc/aliases, nis:mail.aliases
#alias_maps = netinfo:/aliases

#alias_database = dbm:/etc/aliases
#alias_database = dbm:/etc/mail/aliases
alias_database = lmdb:/etc/aliases
#alias_database = lmdb:/etc/aliases, lmdb:/opt/majordomo/aliases

# DEBUGGING CONTROL
#
debug_peer_level = 2

debugger_command =
\t PATH=/bin:/usr/bin:/usr/local/bin:/usr/X11R6/bin
\t ddd $daemon_directory/$process_name $process_id & sleep 5

# INSTALL-TIME CONFIGURATION INFORMATION
#
sendmail_path = /usr/sbin/sendmail.postfix
newaliases_path = /usr/bin/newaliases.postfix
mailq_path = /usr/bin/mailq.postfix
setgid_group = postdrop
html_directory = no
manpage_directory = /usr/share/man
sample_directory = /usr/share/doc/postfix/samples
readme_directory = /usr/share/doc/postfix/README_FILES

# TLS CONFIGURATION
#
# Basic Postfix TLS configuration by default with self-signed certificate
# for inbound SMTP and also opportunistic TLS for outbound SMTP.

# The full pathname of a file with the Postfix SMTP server RSA certificate
# in PEM format. Intermediate certificates should be included in general,
# the server certificate first, then the issuing CA(s) (bottom-up order).
#
smtpd_tls_cert_file = /etc/pki/tls/certs/postfix.pem

# The full pathname of a file with the Postfix SMTP server RSA private key
# in PEM format. The private key must be accessible without a pass-phrase,
# i.e. it must not be encrypted.
#
smtpd_tls_key_file = /etc/pki/tls/private/postfix.key

# Announce STARTTLS support to remote SMTP clients, but do not require that
# clients use TLS encryption (opportunistic TLS inbound).
#
smtpd_tls_security_level = may

# Directory with PEM format Certification Authority certificates that the
# Postfix SMTP client uses to verify a remote SMTP server certificate.
#
smtp_tls_CApath = /etc/pki/tls/certs

# The full pathname of a file containing CA certificates of root CAs
# trusted to sign either remote SMTP server certificates or intermediate CA
# certificates.
#
smtp_tls_CAfile = /etc/pki/tls/certs/ca-bundle.crt

# Use TLS if this is supported by the remote SMTP server, otherwise use
# plaintext (opportunistic TLS outbound).
#
smtp_tls_security_level = may
meta_directory = /etc/postfix
shlib_directory = /usr/lib64/postfix
`

const MAIN_CF_UBUNTU = `# See /usr/share/postfix/main.cf.dist for a commented, more complete version


# Debian specific:  Specifying a file name will cause the first
# line of that file to be used as the name.  The Debian default
# is /etc/mailname.
#myorigin = /etc/mailname

smtpd_banner = $myhostname ESMTP $mail_name (Ubuntu)
biff = no

# appending .domain is the MUA's job.
append_dot_mydomain = no

# Uncomment the next line to generate "delayed mail" warnings
#delay_warning_time = 4h

readme_directory = no

# See http://www.postfix.org/COMPATIBILITY_README.html -- default to 3.6 on
# fresh installs.
compatibility_level = 3.6



# TLS parameters
smtpd_tls_cert_file=/etc/ssl/certs/ssl-cert-snakeoil.pem
smtpd_tls_key_file=/etc/ssl/private/ssl-cert-snakeoil.key
smtpd_tls_security_level=may

smtp_tls_CApath=/etc/ssl/certs
smtp_tls_security_level=may
smtp_tls_session_cache_database = btree:\${data_directory}/smtp_scache


smtpd_relay_restrictions = permit_mynetworks permit_sasl_authenticated defer_unauth_destination
myhostname = __HOST__
alias_maps = hash:/etc/aliases
alias_database = hash:/etc/aliases
myorigin = /etc/mailname
mydestination = $myhostname, __SHORT__, localhost.localdomain, , localhost
relayhost = 
mynetworks = 127.0.0.0/8 [::ffff:127.0.0.0]/104 [::1]/128
mailbox_size_limit = 0
recipient_delimiter = +
inet_interfaces = all
inet_protocols = all
`

const MASTER_CF = `#
# Postfix master process configuration file.  For details on the format
# of the file, see the master(5) manual page (command: "man 5 master" or
# on-line: http://www.postfix.org/master.5.html).
#
# Do not forget to execute "postfix reload" after editing this file.
#
# ==========================================================================
# service type  private unpriv  chroot  wakeup  maxproc command + args
#               (yes)   (yes)   (no)    (never) (100)
# ==========================================================================
smtp      inet  n       -       n       -       -       smtpd
#submission inet n       -       n       -       -       smtpd
#  -o syslog_name=postfix/submission
#  -o smtpd_tls_security_level=encrypt
#  -o smtpd_sasl_auth_enable=yes
pickup    unix  n       -       n       60      1       pickup
cleanup   unix  n       -       n       -       0       cleanup
qmgr      unix  n       -       n       300     1       qmgr
tlsmgr    unix  -       -       n       1000?   1       tlsmgr
rewrite   unix  -       -       n       -       -       trivial-rewrite
bounce    unix  -       -       n       -       0       bounce
defer     unix  -       -       n       -       0       bounce
trace     unix  -       -       n       -       0       bounce
verify    unix  -       -       n       -       1       verify
flush     unix  n       -       n       1000?   0       flush
proxymap  unix  -       -       n       -       -       proxymap
proxywrite unix -       -       n       -       1       proxymap
smtp      unix  -       -       n       -       -       smtp
relay     unix  -       -       n       -       -       smtp
        -o syslog_name=\${multiservice_name}/$service_name
showq     unix  n       -       n       -       -       showq
error     unix  -       -       n       -       -       error
retry     unix  -       -       n       -       -       error
discard   unix  -       -       n       -       -       discard
local     unix  -       n       n       -       -       local
virtual   unix  -       n       n       -       -       virtual
lmtp      unix  -       -       n       -       -       lmtp
anvil     unix  -       -       n       -       1       anvil
scache    unix  -       -       n       -       1       scache
postlog   unix-dgram n  -       n       -       1       postlogd
`

const MDADM_CONF_UBUNTU = `# mdadm.conf
#
# !NB! Run update-initramfs -u after updating this file.
# !NB! This will ensure that initramfs has an uptodate copy.
#
# Please refer to mdadm.conf(5) for information about this file.
#

# by default (built-in), scan all partitions (/proc/partitions) and all
# containers for MD superblocks. alternatively, specify devices to scan, using
# wildcards if desired.
#DEVICE partitions containers

# automatically tag new arrays as belonging to the local system
HOMEHOST <system>

# instruct the monitoring daemon where to send mail alerts
MAILADDR root

# definitions of existing MD arrays

# This configuration was auto-generated on Mon, 16 Nov 2026 00:00:00 +0000 by mkconf
`

const SMARTD_CONF = `# Sample configuration file for smartd.  See man smartd.conf.

# The word DEVICESCAN will cause any remaining lines in this
# configuration file to be ignored: it tells smartd to scan for all
# ATA and SCSI devices.  DEVICESCAN may be followed by any of the
# Directives listed below, which will be applied to all devices that
# are found.  Most users should comment out DEVICESCAN and explicitly
# list the devices that they wish to monitor.
DEVICESCAN -H -m root -n standby,10,q
`

const NUT_CONF = `# Network UPS Tools: example nut.conf
#
##############################################################################
# General section
##############################################################################
# The MODE determines which part of the NUT is to be started, and which
# configuration files must be modified.
#
# This file try to standardize the various files being found in the field, like
# /etc/default/nut on Debian based systems, /etc/sysconfig/ups on RedHat based
# systems, ... Distribution's init script should source this file to see which
# component(s) has to be started.
#
# The values of MODE can be:
# - none: NUT is not configured, or use the Integrated Power Management, or use
#   some external system to startup NUT components. So nothing is to be started.
# - standalone: This mode address a local only configuration, with 1 UPS
#   protecting the local system. This implies to start the 3 NUT layers (driver,
#   upsd and upsmon) and the matching configuration files. This mode can also
#   address UPS redundancy.
# - netserver: same as for the standalone configuration, but also
#   need some more network access controls (firewall, tcp-wrappers) and possibly
#   a specific LISTEN directive in upsd.conf.
#   Since this MODE is opened to the network, a special care should be applied
#   to security concerns.
# - netclient: this mode only requires upsmon.

MODE=none
`

const UPS_CONF = `# Network UPS Tools: example ups.conf
#
# --- SECURITY NOTE ---
#
# If you use snmp-ups and set a community string in here, you
# will have to secure this file to keep other users from obtaining
# that string.  It needs to be readable by upsdrvctl and any drivers,
# and by upsd.
#
# ---
#
# This is where you configure all the UPSes that this system will be
# monitoring directly.  These are usually attached to serial ports, but
# USB devices and SNMP devices are also supported.
#
# This file is used by upsdrvctl to start and stop your driver(s), and
# is also used by upsd to determine which drivers to monitor.  The
# drivers themselves also read this file for configuration directives.
#
# Example:
#
# [myups]
#	driver = usbhid-ups
#	port = auto
#	desc = "Workstation"
`

const UPSD_CONF = `# Network UPS Tools: example upsd configuration file
#
# This file contains access control data, you should keep it secure.
#
# It should only be readable by the user that upsd becomes.  See the FAQ.
#
# =======================================================================
# LISTEN <address> [<port>]
# LISTEN 127.0.0.1 3493
# LISTEN ::1 3493
#
# This defaults to the localhost listening addresses and port 3493.
`

const UPSD_USERS = `# Network UPS Tools: Example upsd.users
#
# This file sets the permissions for upsd - the UPS network daemon.
# Users are defined here, are given passwords, and their privileges are
# controlled here too.  Since this file will contain passwords, keep it
# secure, with only enough permissions for upsd to read it.
#
# --------------------------------------------------------------------------
#
# To add a user for upsmon, use this example:
#
#	[monuser]
#		password  = pass
#		upsmon primary
#	or
#		upsmon secondary
`

const UPSMON_CONF = `# Network UPS Tools: example upsmon configuration
#
# This file contains passwords, so keep it secure.
#
# --------------------------------------------------------------------------
# MONITOR <system> <powervalue> <username> <password> ("primary"|"secondary")
#
# List systems you want to monitor.  Not all of these may supply power
# to the system running upsmon, but if you want to watch it, it has to
# be in this section.
#
# Examples:
#
# MONITOR myups@bigserver 1 upswired blah primary
# MONITOR su700@server.example.com 1 monuser secretpass secondary

MINSUPPLIES 1

SHUTDOWNCMD "/sbin/shutdown -h +0"

POLLFREQ 5
POLLFREQALERT 5
HOSTSYNC 15
DEADTIME 15
POWERDOWNFLAG /etc/killpower
FINALDELAY 5
`

const NFS_CONF = `#
# This is a general configuration for the
# NFS daemons and tools
#
[general]
# pipefs-directory=/var/lib/nfs/rpc_pipefs
#
[nfsd]
# debug=0
# threads=16
# host=
# port=0
# grace-time=90
# lease-time=90
# udp=n
# tcp=y
# vers3=y
# vers4=y
# vers4.0=y
# vers4.1=y
# vers4.2=y
# rdma=n
#
[mountd]
# debug=0
# manage-gids=n
# descriptors=0
# port=0
#
[statd]
# debug=0
# port=0
`

const EXPORTS_UBUNTU = `# /etc/exports: the access control list for filesystems which may be exported
#\t\tto NFS clients.  See exports(5).
#
# Example for NFSv2 and NFSv3:
# /srv/homes       hostname1(rw,sync,no_subtree_check) hostname2(ro,sync,no_subtree_check)
#
# Example for NFSv4:
# /srv/nfs4        gss/krb5i(rw,sync,fsid=0,crossmnt,no_subtree_check)
# /srv/nfs4/homes  gss/krb5i(rw,sync,no_subtree_check)
#
`

const AUTO_MASTER = `#
# Sample auto.master file
# This is a 'master' automounter map and it has the following format:
# mount-point [map-type[,format]:]map [options]
# For details of the format look at auto.master(5).
#
/misc\t/etc/auto.misc
#
# Include /etc/auto.master.d/*.autofs
# To add an extra map using this mechanism you will need to add
# two configuration items - one /etc/auto.master.d/extra.autofs file
# (using the same line format as the auto.master file)
# and a separate mount map (e.g. /etc/auto.extra or an auto.extra NIS map)
# that is referred to by the extra.autofs file.
#
+dir:/etc/auto.master.d
`

const AUTO_MISC = `#
# This is an automounter map and it has the following format
# key [ -mount-options-separated-by-comma ] location
# Details may be found in the autofs(5) manpage

cd\t\t-fstype=iso9660,ro,nosuid,nodev\t:/dev/cdrom

# the following entries are samples to pique your imagination
#linux\t\t-ro,soft\t\tftp.example.org:/pub/linux
#boot\t\t-fstype=ext2\t\t:/dev/hda1
#floppy\t\t-fstype=auto\t\t:/dev/fd0
#floppy\t\t-fstype=ext2\t\t:/dev/fd0
#e2floppy\t-fstype=ext2\t\t:/dev/fd0
#jaz\t\t-fstype=ext2\t\t:/dev/sdc1
#removable\t-fstype=ext2\t\t:/dev/hdd
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
  gitleaks: { summary: 'Scan git repos (or files) for secrets', version: '8.18.2', commands: ['gitleaks'] },
  'ansible-lint': { summary: 'Best practices checker for Ansible', version: '6.17.2', commands: ['ansible-lint'], requires: ['ansible-core'] },
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
  'ansible-core': { summary: 'SSH-based configuration management, deployment, and task execution system', version: '2.16.14', commands: ['ansible', 'ansible-playbook', 'ansible-inventory', 'ansible-vault', 'ansible-galaxy', 'ansible-doc', 'ansible-config'], files: {
      '/etc/ansible/ansible.cfg': '# Since Ansible 2.12 (core):\n# To generate an example config file (a "disabled" one with all default settings, commented out):\n#               $ ansible-config init --disabled > ansible.cfg\n#\n# Also you can now have a more complete file by including existing plugins:\n# ansible-config init --disabled -t all > ansible.cfg\n\n# For previous versions of Ansible you can check for examples in the \'stable\' branches of each version\n# Note that this file was always incomplete  and lagging changes to configuration settings\n\n# for example, for 2.9: https://github.com/ansible/ansible/blob/stable-2.9/examples/ansible.cfg\n',
      '/etc/ansible/hosts': '# This is the default ansible \'hosts\' file.\n#\n# It should live in /etc/ansible/hosts\n#\n#   - Comments begin with the \'#\' character\n#   - Blank lines are ignored\n#   - Groups of hosts are delimited by [header] elements\n#   - You can enter hostnames or ip addresses\n#   - A hostname/ip can be a member of multiple groups\n\n# Ex 1: Ungrouped hosts, specify before any group headers:\n\n## green.example.com\n## blue.example.com\n## 192.168.100.1\n## 192.168.100.10\n\n# Ex 2: A collection of hosts belonging to the \'webservers\' group:\n\n## [webservers]\n## alpha.example.org\n## beta.example.org\n## 192.168.1.100\n## 192.168.1.110\n',
    } },
  ...common,
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
    version: '4.23.5',
    services: [
      { name: 'smb', description: 'Samba SMB Daemon', ports: [139, 445] },
      { name: 'nmb', description: 'Samba NMB Daemon', ports: [] },
    ],
    files: { '/etc/samba/smb.conf': SMB_CONF_ROCKY, '/etc/samba/smb.conf.example': SMB_CONF_ROCKY, '/etc/samba/lmhosts': '127.0.0.1 localhost\n', '/var/lib/samba/private/.keep': '' },
    commands: ['testparm', 'smbpasswd', 'pdbedit', 'smbstatus', 'smbcontrol'],
  },
  'samba-client': { summary: 'Samba client programs', version: '4.23.5', commands: ['smbclient', 'nmblookup', 'smbget'] },
  postfix: {
    summary: 'Postfix Mail Transport Agent',
    version: '3.8.5',
    user: { name: 'postfix', uid: 89, home: '/var/spool/postfix', gecos: '' },
    services: [{ name: 'postfix', description: 'Postfix Mail Transport Agent', ports: [25] }],
    files: { '/etc/postfix/main.cf': MAIN_CF_ROCKY, '/etc/postfix/master.cf': MASTER_CF, '/var/log/maillog': '' },
    perms: { '/var/log/maillog': { mode: 0o600 } },
    commands: ['postconf', 'postmap', 'postalias', 'newaliases', 'postqueue', 'postsuper', 'postfix', 'mailq', 'sendmail', 'sendmail.postfix', 'postcat', 'postlog'],
  },
  mdadm: {
    summary: 'The mdadm program controls Linux md devices (software RAID arrays)',
    version: '4.3',
    services: [{ name: 'mdmonitor', description: 'Software RAID monitoring and management', ports: [], enabledByDefault: true }],
    commands: ['mdadm', 'mdmon'],
  },
  smartmontools: {
    summary: 'Tools for monitoring SMART capable hard disks',
    version: '7.4',
    services: [{ name: 'smartd', description: 'Self Monitoring and Reporting Technology (SMART) Daemon', ports: [], enabledByDefault: true, activeAfterInstall: true }],
    files: { '/etc/smartmontools/smartd.conf': SMARTD_CONF },
    commands: ['smartctl', 'smartd'],
  },
  ipmitool: { summary: 'Utility for IPMI control', version: '1.8.19', commands: ['ipmitool'] },
  nut: {
    summary: 'Network UPS Tools',
    version: '2.8.1',
    requires: ['nut-client'],
    services: [{ name: 'nut-server', description: 'Network UPS Tools - power devices information server', ports: [3493] }],
    files: { '/etc/ups/nut.conf': NUT_CONF, '/etc/ups/ups.conf': UPS_CONF, '/etc/ups/upsd.conf': UPSD_CONF, '/etc/ups/upsd.users': UPSD_USERS },
    perms: { '/etc/ups/upsd.users': { mode: 0o640, group: 'nut' } },
    user: { name: 'nut', uid: 57, home: '/var/lib/ups', gecos: 'Network UPS Tools' },
    commands: ['upsdrvctl', 'upsd'],
  },
  'nut-client': {
    summary: 'Network UPS Tools client monitoring utilities',
    version: '2.8.1',
    services: [{ name: 'nut-monitor', description: 'Network UPS Tools - power device monitor and shutdown controller', ports: [] }],
    files: { '/etc/ups/upsmon.conf': UPSMON_CONF, '/etc/ups/nut.conf': NUT_CONF },
    perms: { '/etc/ups/upsmon.conf': { mode: 0o640 } },
    commands: ['upsc', 'upsmon', 'upscmd', 'upsrw'],
  },
  's-nail': { summary: 'Environment for sending and receiving mail, providing functionality of POSIX mailx', version: '14.9.24', commands: ['mail', 'mailx', 's-nail'] },
  'cyrus-sasl-plain': { summary: 'PLAIN and LOGIN authentication support for Cyrus SASL', version: '2.1.28' },
  'cifs-utils': { summary: 'Utilities for mounting and managing CIFS mounts', version: '7.2', commands: ['mount.cifs', 'mount.smb3', 'cifscreds'] },
  'nfs-utils': {
    summary: 'NFS utilities and supporting clients and daemons for the kernel NFS server',
    version: '2.8.3',
    requires: ['rpcbind'],
    services: [{ name: 'nfs-server', description: 'NFS server and services', ports: [2049, 20048] }],
    files: { '/etc/exports': '', '/etc/exports.d/.keep': '', '/etc/nfs.conf': NFS_CONF },
    commands: ['exportfs', 'showmount', 'mount.nfs', 'mount.nfs4', 'nfsstat'],
  },
  rpcbind: {
    summary: 'Universal Addresses to RPC Program Number Mapper',
    version: '1.2.7',
    services: [{ name: 'rpcbind', description: 'RPC Bind', ports: [111], enabledByDefault: true, activeAfterInstall: true }],
    commands: ['rpcinfo'],
  },
  autofs: {
    summary: 'A tool for automatically mounting and unmounting filesystems',
    version: '5.1.9',
    requires: ['nfs-utils'],
    services: [{ name: 'autofs', description: 'Automounts filesystems on demand', ports: [] }],
    files: { '/etc/auto.master': AUTO_MASTER, '/etc/auto.master.d/.keep': '', '/etc/auto.misc': AUTO_MISC },
    commands: ['automount'],
  },
  ...ROCKY_WEB,
  ...ROCKY_DB,
  ...ROCKY_VIRT,
}

export const UBUNTU_PACKAGES: Record<string, PackageInfo> = {
  'ansible-core': { summary: 'Configuration management, deployment, and task execution system', version: '2.16.3-0ubuntu2', commands: ['ansible', 'ansible-playbook', 'ansible-inventory', 'ansible-vault', 'ansible-galaxy', 'ansible-doc', 'ansible-config'], files: {
      '/etc/ansible/ansible.cfg': '# Since Ansible 2.12 (core):\n# To generate an example config file (a "disabled" one with all default settings, commented out):\n#               $ ansible-config init --disabled > ansible.cfg\n#\n# Also you can now have a more complete file by including existing plugins:\n# ansible-config init --disabled -t all > ansible.cfg\n\n# For previous versions of Ansible you can check for examples in the \'stable\' branches of each version\n# Note that this file was always incomplete  and lagging changes to configuration settings\n\n# for example, for 2.9: https://github.com/ansible/ansible/blob/stable-2.9/examples/ansible.cfg\n',
      '/etc/ansible/hosts': '# This is the default ansible \'hosts\' file.\n#\n# It should live in /etc/ansible/hosts\n#\n#   - Comments begin with the \'#\' character\n#   - Blank lines are ignored\n#   - Groups of hosts are delimited by [header] elements\n#   - You can enter hostnames or ip addresses\n#   - A hostname/ip can be a member of multiple groups\n\n# Ex 1: Ungrouped hosts, specify before any group headers:\n\n## green.example.com\n## blue.example.com\n## 192.168.100.1\n## 192.168.100.10\n\n# Ex 2: A collection of hosts belonging to the \'webservers\' group:\n\n## [webservers]\n## alpha.example.org\n## beta.example.org\n## 192.168.1.100\n## 192.168.1.110\n',
    } },
  ansible: { summary: 'Configuration management, deployment, and task execution system (with collections)', version: '9.2.0+dfsg-0ubuntu5', requires: ['ansible-core'] },
  ...common,
  apparmor: { summary: 'user-space parser utility for AppArmor', version: '4.0.1', commands: ['aa-status', 'apparmor_parser', 'aa-enabled'] },
  'apparmor-utils': { summary: 'utilities for controlling AppArmor', version: '4.0.1', commands: ['aa-complain', 'aa-enforce', 'aa-disable', 'aa-logprof', 'aa-genprof'] },
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
    version: '2:4.23.6+dfsg-0ubuntu1',
    services: [
      { name: 'smbd', description: 'Samba SMB Daemon', ports: [139, 445], enabledByDefault: true, activeAfterInstall: true },
      { name: 'nmbd', description: 'Samba NMB Daemon', ports: [], enabledByDefault: true, activeAfterInstall: true },
    ],
    files: { '/etc/samba/smb.conf': SMB_CONF_UBUNTU, '/var/lib/samba/private/.keep': '' },
    commands: ['testparm', 'smbpasswd', 'pdbedit', 'smbstatus', 'smbcontrol'],
  },
  smbclient: { summary: 'command-line SMB/CIFS clients for Unix', version: '2:4.23.6+dfsg-0ubuntu1', commands: ['smbclient', 'nmblookup', 'smbget'] },
  postfix: {
    summary: 'High-performance mail transport agent',
    version: '3.10.6-4ubuntu2.1',
    user: { name: 'postfix', uid: 112, home: '/var/spool/postfix', gecos: '' },
    requires: ['libsasl2-modules'],
    services: [{ name: 'postfix', description: 'Postfix Mail Transport Agent', ports: [25], enabledByDefault: true, activeAfterInstall: true }],
    files: { '/etc/postfix/main.cf': MAIN_CF_UBUNTU, '/etc/postfix/master.cf': MASTER_CF, '/var/log/mail.log': '' },
    perms: { '/var/log/mail.log': { mode: 0o640, group: 'adm' } },
    commands: ['postconf', 'postmap', 'postalias', 'newaliases', 'postqueue', 'postsuper', 'postfix', 'mailq', 'sendmail', 'postcat', 'postlog'],
  },
  mdadm: {
    summary: 'Tool to administer Linux MD arrays (software RAID)',
    version: '4.3-1ubuntu2',
    services: [{ name: 'mdmonitor', description: 'MD array monitor', ports: [], enabledByDefault: true, activeAfterInstall: true }],
    files: { '/etc/mdadm/mdadm.conf': MDADM_CONF_UBUNTU },
    commands: ['mdadm', 'mdmon'],
  },
  smartmontools: {
    summary: 'control and monitor storage systems using S.M.A.R.T.',
    version: '7.4-3',
    services: [{ name: 'smartmontools', description: 'Self Monitoring and Reporting Technology (SMART) Daemon', ports: [], enabledByDefault: true, activeAfterInstall: true }],
    files: { '/etc/smartd.conf': SMARTD_CONF },
    commands: ['smartctl', 'smartd'],
  },
  ipmitool: { summary: 'utility for IPMI control with kernel driver or LAN interface (daemon)', version: '1.8.19-7', commands: ['ipmitool'] },
  nut: { summary: 'network UPS tools - metapackage', version: '2.8.1-3.1ubuntu1', requires: ['nut-server', 'nut-client'] },
  'nut-server': {
    summary: 'network UPS tools - core system',
    version: '2.8.1-3.1ubuntu1',
    requires: ['nut-client'],
    services: [{ name: 'nut-server', description: 'Network UPS Tools - power devices information server', ports: [3493], enabledByDefault: true }],
    files: { '/etc/nut/nut.conf': NUT_CONF, '/etc/nut/ups.conf': UPS_CONF, '/etc/nut/upsd.conf': UPSD_CONF, '/etc/nut/upsd.users': UPSD_USERS },
    perms: { '/etc/nut/upsd.users': { mode: 0o640, group: 'nut' } },
    user: { name: 'nut', uid: 120, home: '/var/lib/nut', gecos: '' },
    commands: ['upsdrvctl', 'upsd'],
  },
  'nut-client': {
    summary: 'network UPS tools - clients',
    version: '2.8.1-3.1ubuntu1',
    services: [{ name: 'nut-monitor', description: 'Network UPS Tools - power device monitor and shutdown controller', ports: [], enabledByDefault: true }],
    files: { '/etc/nut/upsmon.conf': UPSMON_CONF, '/etc/nut/nut.conf': NUT_CONF },
    perms: { '/etc/nut/upsmon.conf': { mode: 0o640 } },
    commands: ['upsc', 'upsmon', 'upscmd', 'upsrw'],
  },
  'libsasl2-modules': { summary: 'Cyrus SASL - pluggable authentication modules', version: '2.1.28+dfsg1-9ubuntu1' },
  mailutils: { summary: 'GNU mailutils utilities for handling mail', version: '1:3.20-1', commands: ['mail', 'mailx'] },
  'cifs-utils': { summary: 'Common Internet File System utilities', version: '2:7.4-1', commands: ['mount.cifs', 'mount.smb3', 'cifscreds'] },
  'nfs-kernel-server': {
    summary: 'support for NFS kernel server',
    version: '1:2.8.3-1ubuntu1',
    requires: ['nfs-common'],
    services: [{ name: 'nfs-server', description: 'NFS server and services', ports: [2049, 20048], enabledByDefault: true, activeAfterInstall: true }],
    files: { '/etc/exports': EXPORTS_UBUNTU, '/etc/exports.d/.keep': '' },
    commands: ['exportfs'],
  },
  'nfs-common': {
    summary: 'NFS support files common to client and server',
    version: '1:2.8.3-1ubuntu1',
    requires: ['rpcbind'],
    files: { '/etc/nfs.conf': NFS_CONF },
    commands: ['showmount', 'mount.nfs', 'mount.nfs4', 'nfsstat'],
  },
  rpcbind: {
    summary: 'converts RPC program numbers into universal addresses',
    version: '1.2.7-1',
    services: [{ name: 'rpcbind', description: 'RPC bind portmap service', ports: [111], enabledByDefault: true, activeAfterInstall: true }],
    commands: ['rpcinfo'],
  },
  autofs: {
    summary: 'kernel-based automounter for Linux',
    version: '5.1.9-1ubuntu4',
    requires: ['nfs-common'],
    services: [{ name: 'autofs', description: 'Automounts filesystems on demand', ports: [], enabledByDefault: true, activeAfterInstall: true }],
    files: { '/etc/auto.master': AUTO_MASTER, '/etc/auto.master.d/.keep': '', '/etc/auto.misc': AUTO_MISC },
    commands: ['automount'],
  },
  ...UBUNTU_WEB,
  ...UBUNTU_DB,
  ...UBUNTU_VIRT,
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

/**
 * El paquete que trae un comando. Si varios lo traen (qemu-img viene en qemu-utils y en el
 * pve-qemu-kvm de Proxmox) y se pasa lo instalado, devuelve el que esté instalado.
 */
export function commandPackage(distro: 'rocky' | 'ubuntu', command: string, installed?: Set<string>): string | undefined {
  if (OTHER_FAMILY[distro].includes(command)) return '(otra familia)'
  const catalog = distro === 'rocky' ? ROCKY_PACKAGES : UBUNTU_PACKAGES
  let first: string | undefined
  for (const [name, info] of Object.entries(catalog)) {
    if (!info.commands?.includes(command)) continue
    if (!installed || installed.has(name)) return name
    first ??= name
  }
  return first
}
