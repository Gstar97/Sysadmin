import { describe, expect, it } from 'vitest'
import { evaluateRules, validateConfig, valuesAt } from '@/engines/config'

const errors = (lang: Parameters<typeof validateConfig>[0], text: string) => validateConfig(lang, text).diagnostics.filter((d) => d.severity === 'error')

describe('nginx', () => {
  it('detecta el punto y coma faltante en la línea correcta', () => {
    const e = errors('nginx', 'server {\n    listen 80\n    server_name a.com;\n}\n')
    expect(e).toHaveLength(1)
    expect(e[0].line).toBe(2)
    expect(e[0].message).toMatch(/Falta ";"/)
  })
  it('llaves, directivas desconocidas, contexto y proxy_pass', () => {
    expect(errors('nginx', 'server {\n listen 80;\n')[0].message).toMatch(/Falta cerrar/)
    expect(errors('nginx', 'server { listen 80; }\n}')[0].message).toMatch(/Sobra una llave/)
    expect(errors('nginx', 'server { listen 80; rot /var/www; }')[0].message).toMatch(/desconocida "rot"/)
    expect(errors('nginx', 'server { listen 80; worker_processes 2; }')[0].message).toMatch(/no se puede usar dentro de "server"/)
    expect(errors('nginx', 'server { listen 80; location / { proxy_pass localhost:3000; } }')[0].message).toMatch(/http:\/\//)
    expect(errors('nginx', 'server { listen 443 ssl; server_name a; }')[0].message).toMatch(/ssl_certificate/)
    expect(errors('nginx', 'events { worker_connections 1024; }\nhttp { server { listen 80; location / { root /srv; } } }')).toHaveLength(0)
  })
  it('regla de directiva por contexto', () => {
    const text = 'server { listen 80; location /api { proxy_pass http://127.0.0.1:3000; } }'
    const [r] = evaluateRules('nginx', text, [{ tipo: 'directiva', contexto: 'server>location /api', nombre: 'proxy_pass', valor_regex: '3000', mensaje: 'ok' }])
    expect(r.ok).toBe(true)
  })
})

describe('docker compose', () => {
  it('referencias y valores inválidos', () => {
    const text = 'services:\n  web:\n    image: nginx:1.27\n    restart: allways\n    depends_on: [db]\n    ports: ["70000:80"]\n    volumes: [datos:/data]\n'
    const msgs = errors('compose', text).map((d) => d.message).join('\n')
    expect(msgs).toMatch(/restart "allways"/)
    expect(msgs).toMatch(/depends_on menciona "db"/)
    expect(msgs).toMatch(/fuera de rango/)
    expect(msgs).toMatch(/volumen "datos" no está declarado/)
  })
  it('un compose correcto no tiene errores y version da aviso', () => {
    const v = validateConfig('compose', 'version: "3.8"\nservices:\n  db:\n    image: postgres:17\n    volumes: [pg:/var/lib/postgresql/data]\nvolumes:\n  pg:\n')
    expect(v.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0)
    expect(v.diagnostics.some((d) => /version/.test(d.message))).toBe(true)
  })
  it('YAML mal sangrado o con tabulaciones', () => {
    expect(errors('yaml', 'a:\n\tb: 1\n')[0].message).toMatch(/tabulaciones/)
    expect(errors('yaml', 'a: 1\na: 2\n').length).toBeGreaterThan(0)
  })
  it('rutas de YAML', () => {
    const data = { services: { web: { ports: ['8080:80'] }, db: { image: 'postgres:17' } } }
    expect(valuesAt(data, 'services.*.image')).toEqual(['postgres:17'])
    expect(valuesAt([{ tasks: [{ name: 'x' }] }], '[0].tasks[0].name')).toEqual(['x'])
  })
})

describe('Ansible', () => {
  it('estructura, módulos y handlers', () => {
    const text = `- hosts: web\n  become: true\n  tasks:\n    - name: instalar\n      ansible.builtin.dnf:\n        name: nginx\n        state: instalado\n    - name: dos módulos\n      copy: { src: a, dest: /b }\n      file: { path: /c }\n    - name: notifica\n      service: name=nginx state=started\n      notify: reiniciar\n    - name: desconocido\n      instalar_paquete: nginx\n`
    const msgs = errors('ansible', text).map((d) => d.message).join('\n')
    expect(msgs).toMatch(/state "instalado" no es válido/)
    expect(msgs).toMatch(/dos módulos/)
    expect(msgs).toMatch(/no hay un handler/)
    expect(msgs).toMatch(/no conoce el módulo "instalar_paquete"/)
    expect(errors('ansible', 'hosts: all\n')[0].message).toMatch(/lista de plays/)
  })
})

describe('sshd_config y fstab', () => {
  it('sshd: valores y opciones', () => {
    const v = validateConfig('sshd', 'Port 2222\nPermitRootLogin maybe\nPasswordAuthentication no\nPasswordAuthentication yes\nFoo bar\n')
    const msgs = v.diagnostics.map((d) => `${d.line}:${d.severity}`)
    expect(msgs).toEqual(['2:error', '4:warning', '5:error'])
    const [r] = evaluateRules('sshd', 'PasswordAuthentication no\nPasswordAuthentication yes\n', [{ tipo: 'directiva', contexto: '', nombre: 'passwordauthentication', valor_regex: '^no$', mensaje: 'x' }])
    expect(r.ok).toBe(true)
  })
  it('fstab: campos y tipos', () => {
    expect(errors('fstab', 'UUID=3f9c2c1e-6c3a-4c0a-9b55-1d2f7e0a9c11 /datos ext5 defaults 0 2\n')[0].message).toMatch(/desconocido/)
    expect(errors('fstab', '/dev/sdb1 datos ext4 defaults 0 2\n')[0].message).toMatch(/absoluta/)
    expect(errors('fstab', 'UUID=3f9c2c1e-6c3a-4c0a-9b55-1d2f7e0a9c11 / xfs defaults 0 0\n')).toHaveLength(0)
  })
})
