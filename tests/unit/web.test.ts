import { describe, expect, it } from 'vitest'
import { createBashSession, stripAnsi, verifyBash } from '@/engines/shell'
import type { BashStateInput } from '@/engines/shell/schema'

async function session(state: BashStateInput) {
  const sh = createBashSession(state)
  const run = async (cmd: string) => {
    const r = await sh.run(cmd)
    return { out: stripAnsi(r.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join('')), err: stripAnsi(r.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join('')), code: sh.lastExit }
  }
  return { sh, run }
}

const proxyLab: BashStateInput = {
  usuario: 'root',
  hostname: 'web01',
  paquetes: { instalados: ['nginx'] },
  servicios: { nginx: { activo: true }, app1: { activo: true }, app2: { activo: true } },
  red: { registros_dns: { 'www.ejemplo.com': '127.0.0.1', 'tienda.ejemplo.com': '127.0.0.1' } },
  web: {
    aplicaciones: {
      app1: { escucha: '127.0.0.1:8001', cuerpo: 'Respondió app1', eco_encabezados: true },
      app2: { escucha: '127.0.0.1:8002', cuerpo: 'Respondió app2' },
    },
  },
  archivos: {
    '/var/www/sitio/index.html': '<h1>Sitio</h1>\n',
    '/etc/nginx/conf.d/sitios.conf':
      'server {\n    listen 80;\n    server_name www.ejemplo.com;\n    root /var/www/sitio;\n    location = /salud { return 200 "ok"; }\n    location /viejo/ { return 301 /nuevo/; }\n}\n\nupstream tienda {\n    server 127.0.0.1:8001;\n    server 127.0.0.1:8002;\n}\n\nserver {\n    listen 80;\n    server_name tienda.ejemplo.com;\n    location / {\n        proxy_pass http://tienda;\n    }\n}\n',
  },
}

describe('nginx', () => {
  it('elige el server por nombre y la location por la regla de nginx', async () => {
    const { run } = await session(proxyLab)
    expect((await run('curl -s www.ejemplo.com')).out).toContain('<h1>Sitio</h1>')
    expect((await run('curl -s www.ejemplo.com/salud')).out).toBe('ok')
    expect((await run('curl -sI www.ejemplo.com/viejo/x')).out).toMatch(/301 Moved Permanently[\s\S]*Location: http:\/\/www\.ejemplo\.com\/nuevo\//)
    // Un nombre que no está: sin default_server, nginx usa el primer server que leyó (el de conf.d,
    // que se incluye antes que el de nginx.conf).
    expect((await run('curl -s -H "Host: otro.com" 127.0.0.1')).out).toContain('<h1>Sitio</h1>')
  })

  it('proxy con balanceo, SELinux, Host del proxy y 502 cuando no hay backend', async () => {
    const { sh, run } = await session(proxyLab)
    // Rocky: SELinux no deja a nginx conectarse al 8001 sin el booleano.
    expect((await run('curl -s tienda.ejemplo.com')).out).toContain('502 Bad Gateway')
    expect((await run('tail -1 /var/log/nginx/error.log')).out).toContain('(13: Permission denied) while connecting to upstream')
    await run('setsebool -P httpd_can_network_connect 1')
    expect(verifyBash(sh, { booleano_selinux: 'httpd_can_network_connect', valor: true }).ok).toBe(true)
    const a = (await run('curl -s tienda.ejemplo.com')).out
    const b = (await run('curl -s tienda.ejemplo.com')).out
    expect([a, b].sort().map((x) => x.split('\n')[0])).toEqual(['Respondió app1', 'Respondió app2'])
    // Sin proxy_set_header, la aplicación ve como Host el nombre del upstream.
    const echo = a.includes('app1') ? a : b
    expect(echo).toContain('host: tienda\n')
    expect(echo).toContain('x-forwarded-for: (sin enviar)')
    await run('systemctl stop app1')
    for (let i = 0; i < 3; i++) expect((await run('curl -s tienda.ejemplo.com')).out).toContain('Respondió app2')
    await run('systemctl stop app2')
    expect((await run('curl -s -o /dev/null -w "%{http_code}" tienda.ejemplo.com')).out).toBe('502')
    expect(verifyBash(sh, { http: 'http://tienda.ejemplo.com', estado: 502, inseguro: false, desde_internet: false }).ok).toBe(true)
  })

  it('proxy_set_header y la URI que se reemplaza con proxy_pass terminado en /', async () => {
    const { run } = await session({
      ...proxyLab,
      selinux: 'permissive',
      archivos: { '/etc/nginx/conf.d/app.conf': 'server {\n    listen 80;\n    server_name www.ejemplo.com;\n    location /api/ {\n        proxy_pass http://127.0.0.1:8001/;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n    }\n}\n' },
    })
    const out = (await run('curl -s www.ejemplo.com/api/clientes?id=3')).out
    expect(out).toContain('Ruta pedida: /clientes?id=3')
    expect(out).toContain('host: www.ejemplo.com')
    expect(out).toContain('x-forwarded-for: 127.0.0.1')
    expect(out).toContain('x-forwarded-proto: http')
  })

  it('la configuración nueva vale recién después de recargar', async () => {
    const { run } = await session(proxyLab)
    await run(`sed -i 's|<h1>Sitio</h1>|x|' /var/www/sitio/index.html`)
    await run(`sed -i 's|root /var/www/sitio;|root /var/www/otro;|' /etc/nginx/conf.d/sitios.conf`)
    expect((await run('curl -s www.ejemplo.com')).out).toBe('x\n')
    await run('systemctl reload nginx')
    expect((await run('curl -s -o /dev/null -w "%{http_code}" www.ejemplo.com')).out).toBe('404')
  })

  it('PHP: fastcgi_params solo no alcanza (falta SCRIPT_FILENAME)', async () => {
    const conf = (inc: string) => `server {\n    listen 80;\n    server_name www.ejemplo.com;\n    root /var/www/php;\n    index index.php;\n    location ~ \\.php$ {\n        include ${inc};\n        fastcgi_pass unix:/run/php-fpm/www.sock;\n    }\n}\n`
    const { run } = await session({ ...proxyLab, paquetes: { instalados: ['nginx', 'php-fpm'] }, servicios: { nginx: { activo: true }, 'php-fpm': { activo: true } }, archivos: { '/var/www/php/index.php': '<?php echo "Hola desde PHP"; ?>\n', '/etc/nginx/conf.d/php.conf': conf('fastcgi_params') } })
    await run('rm -f /etc/nginx/default.d/php.conf /etc/nginx/conf.d/php-fpm.conf && systemctl reload nginx')
    expect((await run('curl -s www.ejemplo.com')).out).toBe('File not found.\n')
    expect((await run('tail -1 /var/log/nginx/error.log')).out).toContain('Primary script unknown')
    await run(`sed -i 's/fastcgi_params/fastcgi.conf/' /etc/nginx/conf.d/php.conf && systemctl reload nginx`)
    expect((await run('curl -s www.ejemplo.com')).out).toBe('Hola desde PHP') // PHP se come el salto de línea que sigue a ?>
    await run('systemctl stop php-fpm')
    expect((await run('curl -s www.ejemplo.com')).out).toContain('502')
    expect((await run('tail -1 /var/log/nginx/error.log')).out).toContain('connect() to unix:/run/php-fpm/www.sock failed (2: No such file or directory)')
  })
})

describe('aplicaciones', () => {
  it('Ubuntu: unidad de gunicorn, snippet de PHP dentro de la location y echo con PHP_VERSION', async () => {
    const { run } = await session({
      distro: 'ubuntu',
      usuario: 'root',
      usuarios: [{ nombre: 'pedidos', uid: 998, shell: '/usr/sbin/nologin', home: '/opt/pedidos' }],
      paquetes: { instalados: ['nginx', 'php-fpm'] },
      servicios: { nginx: { activo: true } },
      red: { registros_dns: { 'pagos.ejemplo.com': '127.0.0.1' } },
      archivos: {
        '/opt/pedidos/venv/bin/gunicorn': { contenido: '#!/opt/pedidos/venv/bin/python3\n', modo: '0755', dueno: 'pedidos' },
        '/var/www/pagos/index.php': '<?php echo "Pagos ", "PHP " . PHP_VERSION; ?>\n',
      },
      web: { aplicaciones: { pedidos: { cuerpo: 'Sistema de pedidos' } } },
    })
    await run(`printf '[Service]\\nUser=pedidos\\nWorkingDirectory=/opt/pedidos\\nExecStart=/opt/pedidos/venv/bin/gunicorn --bind 127.0.0.1:8001 app:app\\n' > /etc/systemd/system/pedidos.service`)
    await run('systemctl daemon-reload && systemctl start pedidos')
    expect((await run('curl -s 127.0.0.1:8001')).out).toContain('Sistema de pedidos')
    await run(`printf 'server {\\n listen 80;\\n server_name pagos.ejemplo.com;\\n root /var/www/pagos;\\n index index.php;\\n location ~ \\\\.php$ {\\n  include snippets/fastcgi-php.conf;\\n  fastcgi_pass unix:/run/php/php8.5-fpm.sock;\\n }\\n}\\n' > /etc/nginx/sites-enabled/pagos`)
    expect((await run('nginx -t')).err).toContain('test is successful')
    await run('systemctl reload nginx')
    expect((await run('curl -s pagos.ejemplo.com')).out).toBe('Pagos PHP 8.5.4')
  })
})

describe('HTTPS y certificados', () => {
  const tlsLab: BashStateInput = {
    usuario: 'root',
    paquetes: { instalados: ['nginx'] },
    servicios: { nginx: { activo: true } },
    red: { registros_dns: { 'www.ejemplo.com': '127.0.0.1', 'otro.ejemplo.com': '127.0.0.1' } },
    web: {
      certificados: [
        { certificado: '/etc/pki/tls/certs/vencido.pem', clave: '/etc/pki/tls/private/vencido.key', cn: 'www.ejemplo.com', dias_restantes: -3, dias_emitido: 87 },
        { certificado: '/etc/pki/tls/certs/sin-intermedio.pem', clave: '/etc/pki/tls/private/sin-intermedio.key', cn: 'www.ejemplo.com', con_intermedio: false },
        { certificado: '/etc/pki/tls/certs/bien.pem', clave: '/etc/pki/tls/private/bien.key', cn: 'www.ejemplo.com' },
      ],
    },
    archivos: { '/var/www/sitio/index.html': 'seguro\n' },
  }
  const site = (cert: string) => `printf 'server {\\n listen 443 ssl;\\n server_name www.ejemplo.com otro.ejemplo.com;\\n ssl_certificate /etc/pki/tls/certs/${cert}.pem;\\n ssl_certificate_key /etc/pki/tls/private/${cert}.key;\\n root /var/www/sitio;\\n}\\n' > /etc/nginx/conf.d/tls.conf && systemctl reload nginx`

  it('vencido, sin intermedio, nombre equivocado y bien', async () => {
    const { sh, run } = await session(tlsLab)
    await run(site('vencido'))
    expect((await run('curl https://www.ejemplo.com')).err).toContain('curl: (60) SSL certificate problem: certificate has expired')
    expect((await run('openssl s_client -connect www.ejemplo.com:443 -servername www.ejemplo.com')).out).toContain('Verify return code: 10 (certificate has expired)')
    await run(site('sin-intermedio'))
    expect((await run('curl https://www.ejemplo.com')).err).toContain('unable to get local issuer certificate')
    expect((await run('openssl s_client -connect www.ejemplo.com:443')).out).toContain('Verify return code: 21 (unable to verify the first certificate)')
    await run(site('bien'))
    expect((await run('curl -s https://www.ejemplo.com')).out).toBe('seguro\n')
    expect((await run('curl https://otro.ejemplo.com')).err).toContain("no alternative certificate subject name matches target host name 'otro.ejemplo.com'")
    expect(verifyBash(sh, { http: 'https://www.ejemplo.com', tls_valido: true, inseguro: false, desde_internet: false }).ok).toBe(true)
    expect(verifyBash(sh, { certificado: '/etc/pki/tls/certs/bien.pem', emisor_contiene: "Let's Encrypt", con_cadena: true, clave: '/etc/pki/tls/private/bien.key', vigente: true }).ok).toBe(true)
  })

  it('nginx -t detecta clave que no corresponde', async () => {
    const { run } = await session(tlsLab)
    await run(`printf 'server {\\n listen 443 ssl;\\n ssl_certificate /etc/pki/tls/certs/bien.pem;\\n ssl_certificate_key /etc/pki/tls/private/vencido.key;\\n}\\n' > /etc/nginx/conf.d/tls.conf`)
    expect((await run('nginx -t')).err).toContain('key values mismatch')
  })

  it('CA interna: firmar, el SAN que se pierde sin -copy_extensions, y confiar con update-ca-trust', async () => {
    const { sh, run } = await session({ ...tlsLab, web: { ca_interna: { cn: 'Ejemplo Root CA', certificado: '/root/ca/ca.crt', clave: '/root/ca/ca.key' } } })
    await run(`openssl req -new -newkey rsa:2048 -noenc -keyout /etc/pki/tls/private/www.key -out /root/www.csr -subj '/CN=www.ejemplo.com' -addext 'subjectAltName=DNS:www.ejemplo.com'`)
    expect((await run('openssl req -in /root/www.csr -noout -text')).out).toContain('DNS:www.ejemplo.com')
    await run('openssl x509 -req -in /root/www.csr -CA /root/ca/ca.crt -CAkey /root/ca/ca.key -CAcreateserial -out /root/sin-san.crt -days 365')
    expect((await run('openssl x509 -in /root/sin-san.crt -noout -ext subjectAltName')).out).toContain('No extensions')
    await run('openssl x509 -req -in /root/www.csr -CA /root/ca/ca.crt -CAkey /root/ca/ca.key -out /etc/pki/tls/certs/www.crt -days 365 -copy_extensions copy')
    expect((await run('openssl verify -CAfile /root/ca/ca.crt /etc/pki/tls/certs/www.crt')).out).toBe('/etc/pki/tls/certs/www.crt: OK\n')
    expect((await run('openssl verify /etc/pki/tls/certs/www.crt')).err).toContain('error 20 at 0 depth lookup: unable to get local issuer certificate')
    await run(`printf 'server {\\n listen 443 ssl;\\n server_name www.ejemplo.com;\\n ssl_certificate /etc/pki/tls/certs/www.crt;\\n ssl_certificate_key /etc/pki/tls/private/www.key;\\n root /var/www/sitio;\\n}\\n' > /etc/nginx/conf.d/tls.conf && systemctl reload nginx`)
    expect((await run('curl https://www.ejemplo.com')).err).toContain('unable to get local issuer certificate')
    await run('cp /root/ca/ca.crt /etc/pki/ca-trust/source/anchors/ && update-ca-trust')
    expect(verifyBash(sh, { confia_en: 'Ejemplo Root CA', confia: true }).ok).toBe(true)
    expect((await run('curl -s https://www.ejemplo.com')).out).toBe('seguro\n')
  })

  it('en Ubuntu, update-ca-certificates solo toma archivos .crt', async () => {
    const { run } = await session({ distro: 'ubuntu', usuario: 'root', web: { ca_interna: { cn: 'Ejemplo Root CA', certificado: '/root/ca.pem', clave: '/root/ca.key' } } })
    await run('cp /root/ca.pem /usr/local/share/ca-certificates/ejemplo.pem')
    expect((await run('update-ca-certificates')).out).toContain('0 added')
    await run('mv /usr/local/share/ca-certificates/ejemplo.pem /usr/local/share/ca-certificates/ejemplo.crt')
    expect((await run('update-ca-certificates')).out).toContain('1 added')
  })
})

describe("Let's Encrypt con certbot", () => {
  const leLab: BashStateInput = {
    usuario: 'root',
    paquetes: { instalados: ['nginx', 'epel-release', 'certbot', 'python3-certbot-nginx'] },
    servicios: { nginx: { activo: true }, firewalld: { activo: true } },
    red: { registros_dns: { 'www.ejemplo.com.ar': '127.0.0.1' } },
    web: { dominios_publicos: { 'www.ejemplo.com.ar': '203.0.113.10' }, ip_publica: '203.0.113.10', puertos_publicados: [80, 443] },
    archivos: { '/var/www/sitio/index.html': 'hola\n', '/etc/nginx/conf.d/sitio.conf': 'server {\n    listen 80;\n    server_name www.ejemplo.com.ar;\n    root /var/www/sitio;\n}\n' },
  }

  it('el firewall cerrado hace fallar la validación; abierto, certbot instala HTTPS y la redirección', async () => {
    const { sh, run } = await session(leLab)
    const fail = await run('certbot --nginx -d www.ejemplo.com.ar -m yo@ejemplo.com.ar --agree-tos')
    expect(fail.out).toContain('Timeout during connect (likely firewall problem)')
    await run('firewall-cmd --add-service=http --add-service=https')
    expect((await run('certbot --nginx -d www.ejemplo.com.ar')).out).toContain('Congratulations! You have successfully enabled HTTPS')
    expect(verifyBash(sh, { http: 'https://www.ejemplo.com.ar', tls_valido: true, contiene: 'hola', inseguro: false, desde_internet: false }).ok).toBe(true)
    expect((await run('curl -sI http://www.ejemplo.com.ar')).out).toContain('Location: https://www.ejemplo.com.ar/')
    expect((await run('certbot renew --dry-run')).out).toContain('all simulated renewals succeeded')
  })

  it('webroot equivocado: 404 al buscar el archivo de prueba', async () => {
    const { run } = await session(leLab)
    await run('firewall-cmd --add-service=http')
    const r = await run('certbot certonly --webroot -w /usr/share/nginx/html -d www.ejemplo.com.ar -m yo@ejemplo.com.ar --agree-tos')
    expect(r.out).toMatch(/Type: {3}unauthorized[\s\S]*Invalid response from http:\/\/www\.ejemplo\.com\.ar\/\.well-known\/acme-challenge\/\S+: 404/)
    expect((await run('certbot certonly --webroot -w /var/www/sitio -d www.ejemplo.com.ar')).out).toContain('Successfully received certificate')
  })

  it('renovado pero sin recargar nginx: sigue sirviendo el viejo', async () => {
    const { run } = await session({ ...leLab, servicios: { nginx: { activo: true }, firewalld: { activo: false } }, web: { ...leLab.web, certbot: { dominios: ['www.ejemplo.com.ar'], metodo: 'webroot', webroot: '/var/www/sitio', dias_restantes: 10 } }, archivos: { ...leLab.archivos, '/etc/nginx/conf.d/tls.conf': 'server {\n    listen 443 ssl;\n    server_name www.ejemplo.com.ar;\n    ssl_certificate /etc/letsencrypt/live/www.ejemplo.com.ar/fullchain.pem;\n    ssl_certificate_key /etc/letsencrypt/live/www.ejemplo.com.ar/privkey.pem;\n    root /var/www/sitio;\n}\n' } })
    const before = (await run('echo | openssl s_client -connect www.ejemplo.com.ar:443 2>/dev/null | grep NotAfter | head -1')).out
    expect((await run('certbot renew')).out).toContain('Congratulations, all renewals succeeded')
    expect((await run('echo | openssl s_client -connect www.ejemplo.com.ar:443 2>/dev/null | grep NotAfter | head -1')).out).toBe(before)
    await run('systemctl reload nginx')
    expect((await run('echo | openssl s_client -connect www.ejemplo.com.ar:443 2>/dev/null | grep NotAfter | head -1')).out).not.toBe(before)
  })
})

describe('Apache', () => {
  it('Ubuntu: sitio nuevo con a2ensite, .htaccess ignorado sin AllowOverride y rewrite sin el módulo', async () => {
    const { sh, run } = await session({
      distro: 'ubuntu',
      usuario: 'root',
      paquetes: { instalados: ['apache2'] },
      red: { registros_dns: { 'blog.ejemplo.com': '127.0.0.1' } },
      archivos: {
        '/var/www/blog/index.html': 'blog\n',
        '/var/www/blog/privado/index.html': 'secreto\n',
        '/var/www/blog/privado/.htaccess': 'Require all denied\n',
        '/etc/apache2/sites-available/blog.conf': '<VirtualHost *:80>\n    ServerName blog.ejemplo.com\n    DocumentRoot /var/www/blog\n    <Directory /var/www/blog>\n        AllowOverride None\n    </Directory>\n</VirtualHost>\n',
      },
    })
    expect((await run('curl -s blog.ejemplo.com')).out).toContain('Apache2 Default Page')
    expect((await run('a2ensite blog')).out).toContain('Enabling site blog.')
    await run('systemctl reload apache2')
    expect((await run('curl -s blog.ejemplo.com')).out).toBe('blog\n')
    expect((await run('curl -s blog.ejemplo.com/privado/')).out).toBe('secreto\n')
    await run(`sed -i 's/AllowOverride None/AllowOverride All/' /etc/apache2/sites-available/blog.conf && systemctl reload apache2`)
    expect((await run('curl -s -o /dev/null -w "%{http_code}" blog.ejemplo.com/privado/')).out).toBe('403')
    await run(`printf 'RewriteEngine On\\nRewriteRule ^viejo$ /index.html [R=301,L]\\n' > /var/www/blog/.htaccess`)
    expect((await run('curl -s -o /dev/null -w "%{http_code}" blog.ejemplo.com/viejo')).out).toBe('500')
    expect((await run('tail -1 /var/log/apache2/error.log')).out).toContain("Invalid command 'RewriteEngine'")
    expect(verifyBash(sh, { modulo_apache: 'rewrite', cargado: false }).ok).toBe(true)
    await run('a2enmod rewrite && systemctl restart apache2')
    expect((await run('curl -sI blog.ejemplo.com/viejo')).out).toContain('301 Moved Permanently')
  })

  it('apachectl -t marca la directiva de un módulo que no está y ProxyPass da 503 sin backend', async () => {
    const { run } = await session({
      distro: 'ubuntu',
      usuario: 'root',
      paquetes: { instalados: ['apache2'] },
      archivos: { '/etc/apache2/sites-enabled/app.conf': '<VirtualHost *:80>\n    ServerName app.local\n    ProxyPass / http://127.0.0.1:8001/\n</VirtualHost>\n' },
    })
    const t = await run('apachectl -t')
    expect(t.err).toContain("Invalid command 'ProxyPass', perhaps misspelled or defined by a module not included in the server configuration")
    await run('a2enmod proxy_http && systemctl restart apache2')
    expect((await run('apachectl -t')).err).toContain('Syntax OK')
    expect((await run('curl -s -o /dev/null -w "%{http_code}" -H "Host: app.local" 127.0.0.1')).out).toBe('503')
  })
})
