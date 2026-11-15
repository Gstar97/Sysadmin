/**
 * Paquetes web del catálogo: nginx con sus archivos de FastCGI y proxy, PHP-FPM, Apache
 * completo (httpd en Rocky, apache2 en Ubuntu con mods/sites available y enabled), mod_ssl y
 * certbot. Los textos siguen los de las distribuciones, recortados a lo que se usa.
 */
import type { PackageInfo } from './packages'
import { issue, newKey, toPem } from './tls'

/** Certificados autofirmados de prueba que generan las distribuciones (siempre iguales). */
function snakeoil(cn: string, seed: string): { cert: string; key: string } {
  const key = newKey('RSA', 2048, seed)
  const cert = issue({ subject: { CN: cn }, san: [`DNS:${cn}`], days: 3650, key, now: Date.UTC(2026, 0, 10) })
  return { cert: toPem(cert), key: toPem(key) }
}
const LOCALHOST = snakeoil('localhost.localdomain', 'rocky-localhost')
const SNAKEOIL = snakeoil('ubuntu', 'ubuntu-snakeoil')

const nginxIndex = `<!DOCTYPE html>
<html>
<head><title>Welcome to nginx!</title></head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and working.</p>
</body>
</html>
`

const LOG_FORMAT = `    log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '
                      '$status $body_bytes_sent "$http_referer" '
                      '"$http_user_agent" "$http_x_forwarded_for"';
`

export const NGINX_CONF_ROCKY = `# For more information on configuration, see:
#   * Official English Documentation: http://nginx.org/en/docs/

user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log notice;
pid /run/nginx.pid;

events {
    worker_connections 1024;
}

http {
${LOG_FORMAT}
    access_log  /var/log/nginx/access.log  main;

    sendfile            on;
    tcp_nopush          on;
    keepalive_timeout   65;
    types_hash_max_size 4096;

    include             /etc/nginx/mime.types;
    default_type        application/octet-stream;

    # Load modular configuration files from the /etc/nginx/conf.d directory.
    include /etc/nginx/conf.d/*.conf;

    server {
        listen       80;
        listen       [::]:80;
        server_name  _;
        root         /usr/share/nginx/html;

        # Load configuration files for the default server block.
        include /etc/nginx/default.d/*.conf;

        error_page 404 /404.html;
        location = /404.html {
        }

        error_page 500 502 503 504 /50x.html;
        location = /50x.html {
        }
    }
}
`

const NGINX_CONF_UBUNTU = `user www-data;
worker_processes auto;
pid /run/nginx.pid;
error_log /var/log/nginx/error.log;
include /etc/nginx/modules-enabled/*.conf;

events {
    worker_connections 768;
}

http {
    sendfile on;
    tcp_nopush on;
    types_hash_max_size 2048;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    access_log /var/log/nginx/access.log;

    gzip on;

    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
`

const UBUNTU_DEFAULT_SITE = `##
# You should look at the following URL's in order to grasp a solid understanding
# of Nginx configuration files in order to fully unleash the power of Nginx.
# https://www.nginx.com/resources/wiki/start/
##

# Default server configuration
#
server {
\tlisten 80 default_server;
\tlisten [::]:80 default_server;

\troot /var/www/html;

\t# Add index.php to the list if you are using PHP
\tindex index.html index.htm index.nginx-debian.html;

\tserver_name _;

\tlocation / {
\t\t# First attempt to serve request as file, then
\t\t# as directory, then fall back to displaying a 404.
\t\ttry_files $uri $uri/ =404;
\t}

\t# pass PHP scripts to FastCGI server
\t#
\t#location ~ \\.php$ {
\t#\tinclude snippets/fastcgi-php.conf;
\t#
\t#\t# With php-fpm (or other unix sockets):
\t#\tfastcgi_pass unix:/run/php/php8.5-fpm.sock;
\t#}
}
`

const FASTCGI_PARAMS = `fastcgi_param  QUERY_STRING       $query_string;
fastcgi_param  REQUEST_METHOD     $request_method;
fastcgi_param  CONTENT_TYPE       $content_type;
fastcgi_param  CONTENT_LENGTH     $content_length;

fastcgi_param  SCRIPT_NAME        $fastcgi_script_name;
fastcgi_param  REQUEST_URI        $request_uri;
fastcgi_param  DOCUMENT_URI       $document_uri;
fastcgi_param  DOCUMENT_ROOT      $document_root;
fastcgi_param  SERVER_PROTOCOL    $server_protocol;
fastcgi_param  REQUEST_SCHEME     $scheme;
fastcgi_param  HTTPS              $https if_not_empty;

fastcgi_param  GATEWAY_INTERFACE  CGI/1.1;
fastcgi_param  SERVER_SOFTWARE    nginx/$nginx_version;

fastcgi_param  REMOTE_ADDR        $remote_addr;
fastcgi_param  REMOTE_PORT        $remote_port;
fastcgi_param  SERVER_ADDR        $server_addr;
fastcgi_param  SERVER_PORT        $server_port;
fastcgi_param  SERVER_NAME        $server_name;

# PHP only, required if PHP was built with --enable-force-cgi-redirect
fastcgi_param  REDIRECT_STATUS    200;
`

const FASTCGI_CONF = FASTCGI_PARAMS.replace('fastcgi_param  QUERY_STRING', 'fastcgi_param  SCRIPT_FILENAME    $document_root$fastcgi_script_name;\nfastcgi_param  QUERY_STRING')

const FASTCGI_PHP_SNIPPET = `# regex to split $uri to $fastcgi_script_name and $fastcgi_path
fastcgi_split_path_info ^(.+?\\.php)(/.*)$;

# Check that the PHP script exists before passing it
try_files $fastcgi_script_name =404;

# Bypass the fact that try_files resets $fastcgi_path_info
# see: http://trac.nginx.org/nginx/ticket/321
set $path_info $fastcgi_path_info;
fastcgi_param PATH_INFO $path_info;

fastcgi_index index.php;
include fastcgi.conf;
`

const PROXY_PARAMS = `proxy_set_header Host $http_host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
`

const ROCKY_404 = '<!DOCTYPE html>\n<html><head><title>404 Not Found</title></head>\n<body><h1>404 Not Found</h1><p>The page you are looking for is not found.</p></body></html>\n'
const ROCKY_50X = '<!DOCTYPE html>\n<html><head><title>The page is temporarily unavailable</title></head>\n<body><h1>The page you are looking for is temporarily unavailable.</h1><p>Please try again later.</p></body></html>\n'

const FPM_POOL_ROCKY = `; Start a new pool named 'www'.
[www]
user = apache
group = apache
listen = /run/php-fpm/www.sock
listen.acl_users = apache,nginx
listen.allowed_clients = 127.0.0.1
pm = dynamic
pm.max_children = 50
pm.start_servers = 5
pm.min_spare_servers = 5
pm.max_spare_servers = 35
slowlog = /var/log/php-fpm/www-slow.log
php_admin_value[error_log] = /var/log/php-fpm/www-error.log
php_admin_flag[log_errors] = on
`

const FPM_POOL_UBUNTU = `; Start a new pool named 'www'.
[www]
user = www-data
group = www-data
listen = /run/php/php8.5-fpm.sock
listen.owner = www-data
listen.group = www-data
pm = dynamic
pm.max_children = 5
pm.start_servers = 2
pm.min_spare_servers = 1
pm.max_spare_servers = 3
`

const HTTPD_CONF = `#
# This is the main Apache HTTP server configuration file.  It contains the
# configuration directives that give the server its instructions.
# See <URL:http://httpd.apache.org/docs/2.4/> for detailed information.
#
ServerRoot "/etc/httpd"

Listen 80

Include conf.modules.d/*.conf

User apache
Group apache

ServerAdmin root@localhost

<Directory />
    AllowOverride none
    Require all denied
</Directory>

DocumentRoot "/var/www/html"

<Directory "/var/www">
    AllowOverride None
    Require all granted
</Directory>

<Directory "/var/www/html">
    Options Indexes FollowSymLinks
    AllowOverride None
    Require all granted
</Directory>

<IfModule dir_module>
    DirectoryIndex index.html
</IfModule>

<Files ".ht*">
    Require all denied
</Files>

ErrorLog "logs/error_log"

LogLevel warn

<IfModule log_config_module>
    LogFormat "%h %l %u %t \\"%r\\" %>s %b \\"%{Referer}i\\" \\"%{User-Agent}i\\"" combined
    CustomLog "logs/access_log" combined
</IfModule>

AddDefaultCharset UTF-8

EnableSendfile on

# Load config files in the "/etc/httpd/conf.d" directory, if any.
IncludeOptional conf.d/*.conf
`

const HTTPD_BASE_MODULES = ['access_compat', 'actions', 'alias', 'allowmethods', 'auth_basic', 'authn_core', 'authn_file', 'authz_core', 'authz_host', 'authz_user', 'autoindex', 'dir', 'env', 'expires', 'filter', 'headers', 'log_config', 'mime', 'negotiation', 'remoteip', 'reqtimeout', 'rewrite', 'setenvif', 'socache_shmcb', 'status', 'unixd', 'version']
  .map((m) => `LoadModule ${m}_module modules/mod_${m}.so`)
  .join('\n')

const HTTPD_PROXY_MODULES = ['proxy', 'lbmethod_byrequests', 'proxy_balancer', 'proxy_fcgi', 'proxy_http', 'proxy_wstunnel'].map((m) => `LoadModule ${m}_module modules/mod_${m}.so`).join('\n')

const SSL_CONF_ROCKY = `#
# When we also provide SSL we have to listen to the
# standard HTTPS port in addition.
#
Listen 443 https

SSLPassPhraseDialog exec:/usr/libexec/httpd-ssl-pass-dialog
SSLSessionCache         shmcb:/run/httpd/sslcache(512000)
SSLSessionCacheTimeout  300
SSLCryptoDevice builtin

<VirtualHost _default_:443>
ErrorLog logs/ssl_error_log
CustomLog logs/ssl_access_log combined
LogLevel warn
SSLEngine on
SSLHonorCipherOrder on
SSLCipherSuite PROFILE=SYSTEM
SSLProtocol all -SSLv3 -TLSv1 -TLSv1.1
SSLCertificateFile /etc/pki/tls/certs/localhost.crt
SSLCertificateKeyFile /etc/pki/tls/private/localhost.key
</VirtualHost>
`

const APACHE2_CONF = `# This is the main Apache server configuration file.  It contains the
# configuration directives that give the server its instructions.
# See http://httpd.apache.org/docs/2.4/ for detailed information about
# the directives and /usr/share/doc/apache2/README.Debian about Debian specific
# hints.

DefaultRuntimeDir \${APACHE_RUN_DIR}
PidFile \${APACHE_PID_FILE}
Timeout 300
KeepAlive On
MaxKeepAliveRequests 100
KeepAliveTimeout 5

User \${APACHE_RUN_USER}
Group \${APACHE_RUN_GROUP}

HostnameLookups Off

ErrorLog \${APACHE_LOG_DIR}/error.log
LogLevel warn

# Include module configuration:
IncludeOptional mods-enabled/*.load
IncludeOptional mods-enabled/*.conf

# Include list of ports to listen on
Include ports.conf

<Directory />
\tOptions FollowSymLinks
\tAllowOverride None
\tRequire all denied
</Directory>

<Directory /usr/share>
\tAllowOverride None
\tRequire all granted
</Directory>

<Directory /var/www/>
\tOptions Indexes FollowSymLinks
\tAllowOverride None
\tRequire all granted
</Directory>

AccessFileName .htaccess

<FilesMatch "^\\.ht">
\tRequire all denied
</FilesMatch>

LogFormat "%v:%p %h %l %u %t \\"%r\\" %>s %O \\"%{Referer}i\\" \\"%{User-Agent}i\\"" vhost_combined
LogFormat "%h %l %u %t \\"%r\\" %>s %O \\"%{Referer}i\\" \\"%{User-Agent}i\\"" combined

# Include generic snippets of statements
IncludeOptional conf-enabled/*.conf

# Include the virtual host configurations:
IncludeOptional sites-enabled/*.conf
`

const PORTS_CONF = `# If you just change the port or add more ports here, you will likely also
# have to change the VirtualHost statement in
# /etc/apache2/sites-enabled/000-default.conf

Listen 80

<IfModule ssl_module>
\tListen 443
</IfModule>

<IfModule mod_gnutls.c>
\tListen 443
</IfModule>
`

const DEFAULT_SITE_APACHE = `<VirtualHost *:80>
\t# The ServerName directive sets the request scheme, hostname and port that
\t# the server uses to identify itself.
\t#ServerName www.example.com

\tServerAdmin webmaster@localhost
\tDocumentRoot /var/www/html

\tErrorLog \${APACHE_LOG_DIR}/error.log
\tCustomLog \${APACHE_LOG_DIR}/access.log combined
</VirtualHost>
`

const DEFAULT_SSL_SITE = `<VirtualHost *:443>
\tServerAdmin webmaster@localhost
\tDocumentRoot /var/www/html

\tErrorLog \${APACHE_LOG_DIR}/error.log
\tCustomLog \${APACHE_LOG_DIR}/access.log combined

\tSSLEngine on
\tSSLCertificateFile      /etc/ssl/certs/ssl-cert-snakeoil.pem
\tSSLCertificateKeyFile   /etc/ssl/private/ssl-cert-snakeoil.key
</VirtualHost>
`

/** Módulos disponibles en Ubuntu (y cuáles vienen habilitados). */
const UBUNTU_MODS: [string, boolean][] = [
  ['access_compat', true],
  ['alias', true],
  ['auth_basic', true],
  ['authn_core', true],
  ['authn_file', true],
  ['authz_core', true],
  ['authz_host', true],
  ['authz_user', true],
  ['autoindex', true],
  ['deflate', true],
  ['dir', true],
  ['env', true],
  ['filter', true],
  ['mime', true],
  ['mpm_event', true],
  ['negotiation', true],
  ['reqtimeout', true],
  ['setenvif', true],
  ['status', true],
  ['headers', false],
  ['rewrite', false],
  ['ssl', false],
  ['socache_shmcb', false],
  ['proxy', false],
  ['proxy_http', false],
  ['proxy_fcgi', false],
  ['proxy_wstunnel', false],
  ['proxy_balancer', false],
  ['lbmethod_byrequests', false],
  ['slotmem_shm', false],
  ['http2', false],
  ['expires', false],
  ['remoteip', false],
  ['log_config', true],
]

function apache2Files(): { files: Record<string, string>; links: Record<string, string> } {
  const files: Record<string, string> = {
    '/etc/apache2/apache2.conf': APACHE2_CONF,
    '/etc/apache2/ports.conf': PORTS_CONF,
    '/etc/apache2/envvars': 'export APACHE_RUN_USER=www-data\nexport APACHE_RUN_GROUP=www-data\nexport APACHE_PID_FILE=/var/run/apache2$SUFFIX/apache2.pid\nexport APACHE_RUN_DIR=/var/run/apache2$SUFFIX\nexport APACHE_LOCK_DIR=/var/lock/apache2$SUFFIX\nexport APACHE_LOG_DIR=/var/log/apache2$SUFFIX\n',
    '/etc/apache2/sites-available/000-default.conf': DEFAULT_SITE_APACHE,
    '/etc/apache2/sites-available/default-ssl.conf': DEFAULT_SSL_SITE,
    '/etc/apache2/conf-available/security.conf': 'ServerTokens OS\nServerSignature On\nTraceEnable Off\n',
    '/etc/apache2/conf-enabled/.keep': '',
    '/var/www/html/index.html': '<!DOCTYPE html>\n<html><head><title>Apache2 Ubuntu Default Page: It works</title></head>\n<body><h1>Apache2 Default Page</h1><p>It works!</p></body></html>\n',
    '/var/log/apache2/access.log': '',
    '/var/log/apache2/error.log': '',
    '/etc/ssl/certs/ssl-cert-snakeoil.pem': SNAKEOIL.cert,
    '/etc/ssl/private/ssl-cert-snakeoil.key': SNAKEOIL.key,
  }
  const links: Record<string, string> = {
    '/etc/apache2/sites-enabled/000-default.conf': '../sites-available/000-default.conf',
    '/etc/apache2/conf-enabled/security.conf': '../conf-available/security.conf',
  }
  for (const [m, on] of UBUNTU_MODS) {
    const so = m === 'log_config' ? '' : `LoadModule ${m}_module /usr/lib/apache2/modules/mod_${m}.so\n`
    if (!so) continue
    files[`/etc/apache2/mods-available/${m}.load`] = so
    if (on) links[`/etc/apache2/mods-enabled/${m}.load`] = `../mods-available/${m}.load`
  }
  files['/etc/apache2/mods-available/ssl.conf'] = '<IfModule mod_ssl.c>\n\tSSLRandomSeed startup builtin\n\tSSLRandomSeed startup file:/dev/urandom 512\n\tSSLSessionCache\t\tshmcb:${APACHE_RUN_DIR}/ssl_scache(512000)\n\tSSLSessionCacheTimeout  300\n\tSSLProtocol all -SSLv3\n</IfModule>\n'
  return { files, links }
}

const ap2 = apache2Files()

export const ROCKY_WEB: Record<string, PackageInfo> = {
  nginx: {
    summary: 'A high performance web server and reverse proxy server',
    user: { name: 'nginx', uid: 990, home: '/var/lib/nginx', gecos: 'Nginx web server' },
    version: '1.26.3',
    services: [{ name: 'nginx', description: 'The nginx HTTP and reverse proxy server', ports: [80] }],
    files: {
      '/etc/nginx/nginx.conf': NGINX_CONF_ROCKY,
      '/etc/nginx/conf.d/.keep': '',
      '/etc/nginx/default.d/.keep': '',
      '/etc/nginx/fastcgi_params': FASTCGI_PARAMS,
      '/etc/nginx/fastcgi.conf': FASTCGI_CONF,
      '/etc/nginx/mime.types': 'types {\n    text/html  html htm shtml;\n    text/css   css;\n    application/javascript  js;\n}\n',
      '/usr/share/nginx/html/index.html': nginxIndex,
      '/usr/share/nginx/html/404.html': ROCKY_404,
      '/usr/share/nginx/html/50x.html': ROCKY_50X,
      '/var/log/nginx/access.log': '',
      '/var/log/nginx/error.log': '',
    },
    commands: ['nginx'],
  },
  'php-fpm': {
    summary: 'PHP FastCGI Process Manager',
    version: '8.3.19',
    services: [{ name: 'php-fpm', description: 'The PHP FastCGI Process Manager', ports: [] }],
    files: {
      '/etc/php-fpm.conf': '[global]\npid = /run/php-fpm/php-fpm.pid\nerror_log = /var/log/php-fpm/error.log\ninclude=/etc/php-fpm.d/*.conf\n',
      '/etc/php-fpm.d/www.conf': FPM_POOL_ROCKY,
      '/etc/nginx/conf.d/php-fpm.conf': '# PHP-FPM FastCGI server\n# network or unix domain socket configuration\n\nupstream php-fpm {\n        server unix:/run/php-fpm/www.sock;\n}\n',
      '/etc/nginx/default.d/php.conf': '# pass the PHP scripts to FastCGI server\n#\n# See conf.d/php-fpm.conf for socket configuration\n#\nindex index.php index.html index.htm;\n\nlocation ~ \\.(php|phar)(/.*)?$ {\n    fastcgi_split_path_info ^(.+\\.(?:php|phar))(/.*)$;\n\n    fastcgi_intercept_errors on;\n    fastcgi_index  index.php;\n    include        fastcgi_params;\n    fastcgi_param  SCRIPT_FILENAME  $document_root$fastcgi_script_name;\n    fastcgi_param  PATH_INFO $fastcgi_path_info;\n    fastcgi_pass   php-fpm;\n}\n',
      '/var/log/php-fpm/.keep': '',
    },
    commands: ['php-fpm'],
  },
  'php-cli': { summary: 'Command-line interface for PHP', version: '8.3.19', commands: ['php'] },
  httpd: {
    summary: 'Apache HTTP Server',
    user: { name: 'apache', uid: 48, home: '/usr/share/httpd', gecos: 'Apache' },
    version: '2.4.63',
    services: [{ name: 'httpd', description: 'The Apache HTTP Server', ports: [80] }],
    files: {
      '/etc/httpd/conf/httpd.conf': HTTPD_CONF,
      '/etc/httpd/conf.modules.d/00-base.conf': HTTPD_BASE_MODULES + '\n',
      '/etc/httpd/conf.modules.d/00-mpm.conf': 'LoadModule mpm_event_module modules/mod_mpm_event.so\n',
      '/etc/httpd/conf.modules.d/00-proxy.conf': HTTPD_PROXY_MODULES + '\n',
      '/etc/httpd/conf.modules.d/00-systemd.conf': 'LoadModule systemd_module modules/mod_systemd.so\n',
      '/etc/httpd/conf.d/.keep': '',
      '/var/www/html/.keep': '',
      '/var/log/httpd/.keep': '',
    },
    links: { '/etc/httpd/logs': '../../var/log/httpd' },
    commands: ['httpd', 'apachectl', 'htpasswd'],
  },
  mod_ssl: {
    summary: 'SSL/TLS module for the Apache HTTP Server',
    version: '2.4.63',
    files: { '/etc/httpd/conf.modules.d/00-ssl.conf': 'LoadModule ssl_module modules/mod_ssl.so\n', '/etc/httpd/conf.d/ssl.conf': SSL_CONF_ROCKY, '/etc/pki/tls/certs/localhost.crt': LOCALHOST.cert, '/etc/pki/tls/private/localhost.key': LOCALHOST.key },
  },
  certbot: { summary: 'A free, automated certificate authority client (EPEL)', version: '4.1.1', commands: ['certbot'], timers: [{ name: 'certbot-renew', description: 'This is the timer to set the schedule for automated renewals', calendar: '*-*-* 00/12:00:00', enabled: false }] },
  'python3-certbot-nginx': { summary: 'The nginx plugin for certbot (EPEL)', version: '4.1.1' },
  'python3-certbot-apache': { summary: 'The Apache plugin for certbot (EPEL)', version: '4.1.1' },
  testssl: { summary: 'Testing TLS/SSL encryption anywhere on any port', version: '3.2.1', commands: ['testssl', 'testssl.sh'] },
  haproxy: { summary: 'HAProxy reverse proxy for high availability environments', version: '3.0.5', services: [{ name: 'haproxy', description: 'HAProxy Load Balancer', ports: [] }], files: { '/etc/haproxy/haproxy.cfg': '' }, commands: ['haproxy'] },
}

export const UBUNTU_WEB: Record<string, PackageInfo> = {
  nginx: {
    summary: 'small, powerful, scalable web/proxy server',
    version: '1.28.3',
    services: [{ name: 'nginx', description: 'A high performance web server and a reverse proxy server', ports: [80], enabledByDefault: true, activeAfterInstall: true }],
    files: {
      '/etc/nginx/nginx.conf': NGINX_CONF_UBUNTU,
      '/etc/nginx/sites-available/default': UBUNTU_DEFAULT_SITE,
      '/etc/nginx/conf.d/.keep': '',
      '/etc/nginx/modules-enabled/.keep': '',
      '/etc/nginx/fastcgi_params': FASTCGI_PARAMS,
      '/etc/nginx/fastcgi.conf': FASTCGI_CONF,
      '/etc/nginx/snippets/fastcgi-php.conf': FASTCGI_PHP_SNIPPET,
      '/etc/nginx/snippets/snakeoil.conf': '# Self signed certificates generated by the ssl-cert package\n# Don\'t use them in a production server!\n\nssl_certificate /etc/ssl/certs/ssl-cert-snakeoil.pem;\nssl_certificate_key /etc/ssl/private/ssl-cert-snakeoil.key;\n',
      '/etc/nginx/proxy_params': PROXY_PARAMS,
      '/etc/nginx/mime.types': 'types {\n    text/html  html htm shtml;\n    text/css   css;\n    application/javascript  js;\n}\n',
      '/var/www/html/index.nginx-debian.html': nginxIndex,
      '/usr/share/nginx/html/index.html': nginxIndex,
      '/var/log/nginx/access.log': '',
      '/var/log/nginx/error.log': '',
    },
    links: { '/etc/nginx/sites-enabled/default': '/etc/nginx/sites-available/default' },
    commands: ['nginx'],
  },
  'php-fpm': {
    summary: 'server-side, HTML-embedded scripting language (FPM-CGI binary)',
    version: '8.5.4',
    services: [{ name: 'php8.5-fpm', description: 'The PHP 8.5 FastCGI Process Manager', ports: [], enabledByDefault: true, activeAfterInstall: true }],
    files: { '/etc/php/8.5/fpm/pool.d/www.conf': FPM_POOL_UBUNTU, '/etc/php/8.5/fpm/php.ini': '[PHP]\nmemory_limit = 128M\nupload_max_filesize = 2M\npost_max_size = 8M\n' },
    commands: ['php-fpm8.5'],
  },
  'php-cli': { summary: 'command-line interpreter for the PHP scripting language', version: '8.5.4', commands: ['php'] },
  apache2: {
    summary: 'Apache HTTP Server',
    version: '2.4.66',
    services: [{ name: 'apache2', description: 'The Apache HTTP Server', ports: [80], enabledByDefault: true, activeAfterInstall: true }],
    files: ap2.files,
    links: ap2.links,
    commands: ['apache2ctl', 'a2ensite', 'a2dissite', 'a2enmod', 'a2dismod', 'a2enconf', 'a2disconf'],
  },
  'apache2-utils': { summary: 'Apache HTTP Server (utility programs for web servers)', version: '2.4.66', commands: ['htpasswd', 'ab'] },
  certbot: { summary: 'automatically configure HTTPS using Let\'s Encrypt', version: '4.0.0', commands: ['certbot'], timers: [{ name: 'certbot', description: 'Run certbot twice daily', calendar: '*-*-* 00,12:00:00', enabled: true }] },
  'python3-certbot-nginx': { summary: 'Nginx plugin for Certbot', version: '4.0.0' },
  'python3-certbot-apache': { summary: 'Apache plugin for Certbot', version: '4.0.0' },
  'testssl.sh': { summary: 'Testing TLS/SSL encryption', version: '3.2.1', commands: ['testssl', 'testssl.sh'] },
  haproxy: { summary: 'fast and reliable load balancing reverse proxy', version: '3.0.5', services: [{ name: 'haproxy', description: 'HAProxy Load Balancer', ports: [], enabledByDefault: true, activeAfterInstall: true }], files: { '/etc/haproxy/haproxy.cfg': '' }, commands: ['haproxy'] },
}
