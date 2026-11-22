import { describe, expect, it } from 'vitest'
import { createBashSession, stripAnsi, verifyBash } from '@/engines/shell'
import { bashCheckSchema, type BashStateInput } from '@/engines/shell/schema'
import { matchPattern, parseIni, parseYamlInventory, groupHosts } from '@/engines/ansible/inventory'
import { decrypt, encrypt } from '@/engines/ansible/vault'
import { lintFiles } from '@/engines/ansible/lint'

const NOPASSWD = { '/etc/sudoers.d/ana': { contenido: 'ana ALL=(ALL) NOPASSWD: ALL\n' } }

function lab(files: Record<string, string>, extra: Partial<BashStateInput> = {}): BashStateInput {
  return {
    distro: 'rocky',
    hostname: 'admin01',
    usuario: 'ana',
    usuarios: [{ nombre: 'ana', clave_ssh: true }],
    paquetes: { instalados: ['ansible-core', 'ansible-lint'] },
    red: { interfaces: [{ nombre: 'enp0s3', ip: '192.168.10.5/24' }] },
    archivos: {
      '/home/ana/ansible/ansible.cfg': { contenido: '[defaults]\ninventory = inventario.ini\nhost_key_checking = False\n', dueno: 'ana' },
      '/home/ana/ansible/inventario.ini': { contenido: '[web]\nweb01\nweb02\n\n[db]\ndb01\n', dueno: 'ana' },
      ...Object.fromEntries(Object.entries(files).map(([p, c]) => [`/home/ana/ansible/${p}`, { contenido: c, dueno: 'ana' }])),
    },
    directorio: '/home/ana/ansible',
    servidores: [
      { ip: '192.168.10.20', hostname: 'web01', usuarios: [{ nombre: 'ana', clave_ssh: true }], archivos: NOPASSWD },
      { ip: '192.168.10.21', hostname: 'web02', distro: 'ubuntu', usuarios: [{ nombre: 'ana', clave_ssh: true }], archivos: NOPASSWD },
      { ip: '192.168.10.30', hostname: 'db01', usuarios: [{ nombre: 'ana', clave_ssh: true, sudo: true }] },
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
  return { sh, run }
}

const WEB = `- name: Servidores web
  hosts: web
  become: true
  vars:
    puerto: 8080
  tasks:
    - name: Instalar nginx
      ansible.builtin.package:
        name: nginx
        state: present
    - name: Sitio
      ansible.builtin.template:
        src: sitio.conf.j2
        dest: /etc/nginx/conf.d/tienda.conf
        mode: '0644'
      notify: Recargar nginx
    - name: nginx activo
      ansible.builtin.service:
        name: nginx
        state: started
        enabled: true
  handlers:
    - name: Recargar nginx
      ansible.builtin.service:
        name: nginx
        state: reloaded
`
const TPL = '# {{ ansible_managed }}\nserver {\n    listen {{ puerto }};\n    server_name {{ inventory_hostname }}.lab;\n}\n'

describe('inventarios', () => {
  it('INI con rangos, variables, hijos y patrones', () => {
    const inv = parseIni('[web]\nweb[01:03] puerto=80\n\n[db]\ndb01 ansible_host=10.0.0.5\n\n[prod:children]\nweb\ndb\n\n[web:vars]\nnginx=true\n', 'h.ini')
    expect(groupHosts(inv, 'prod')).toEqual(['web01', 'web02', 'web03', 'db01'])
    expect(inv.hosts.get('web02')).toEqual({ puerto: 80 })
    expect(inv.groups.get('web')!.vars).toEqual({ nginx: true })
    expect(matchPattern(inv, 'web:!web02').hosts).toEqual(['web01', 'web03'])
    expect(matchPattern(inv, 'prod:&db').hosts).toEqual(['db01'])
    expect(matchPattern(inv, 'web0*').hosts).toEqual(['web01', 'web02', 'web03'])
    expect(matchPattern(inv, 'webs').unmatched).toEqual(['webs'])
  })

  it('YAML con hijos y variables', () => {
    const inv = parseYamlInventory('all:\n  children:\n    web:\n      hosts:\n        web01:\n          ansible_host: 10.0.0.11\n      vars:\n        puerto: 80\n', 'h.yml')
    expect(groupHosts(inv, 'web')).toEqual(['web01'])
    expect(inv.hosts.get('web01')).toEqual({ ansible_host: '10.0.0.11' })
  })
})

describe('vault', () => {
  it('cifra, descifra y rechaza la contraseña equivocada', () => {
    const v = encrypt('db_password: secreto\n', 'clave')
    expect(v.startsWith('$ANSIBLE_VAULT;1.1;AES256\n')).toBe(true)
    expect(v.split('\n')[1].length).toBe(80)
    expect(decrypt(v, 'clave')).toBe('db_password: secreto\n')
    expect(() => decrypt(v, 'otra', 'vault.yml')).toThrow('Decryption failed (no vault secrets were found that could decrypt) on vault.yml')
  })
})

describe('ansible en el simulador', () => {
  it('ad hoc: ping a todos y el error de sudo con contraseña', async () => {
    const { run } = await session(lab({}))
    const r = await run('ansible all -m ping')
    expect(r.out).toContain('web01 | SUCCESS => {')
    expect(r.out).toContain('"ping": "pong"')
    expect(r.out).toContain('db01 | SUCCESS')
    const b = await run('ansible db01 -b -m package -a "name=nginx"')
    expect(b.out).toContain('Missing sudo password')
    const k = await run('ansible web01 -m command -a "cat /etc/hostname"')
    expect(k.out).toContain('web01 | CHANGED | rc=0 >>\nweb01')
  })

  it('playbook: instala, configura con plantilla, handler una sola vez y la segunda corrida no cambia nada', async () => {
    const { sh, run } = await session(lab({ 'web.yml': WEB, 'templates/sitio.conf.j2': TPL }))
    const r1 = await run('ansible-playbook web.yml')
    expect(r1.out).toContain('PLAY [Servidores web] ****')
    expect(r1.out).toContain('TASK [Gathering Facts]')
    expect(r1.out).toContain('RUNNING HANDLER [Recargar nginx]')
    expect(r1.out).toMatch(/web01\s+: ok=5\s+changed=4\s+unreachable=0\s+failed=0/)
    expect(r1.code).toBe(0)
    const r2 = await run('ansible-playbook web.yml')
    expect(r2.out).not.toContain('RUNNING HANDLER')
    expect(r2.out).toMatch(/web02\s+: ok=4\s+changed=0/)
    expect(verifyBash(sh, bashCheckSchema.parse({ en: 'web02', verificar: { archivo: '/etc/nginx/conf.d/tienda.conf', contenido_incluye: 'listen 8080;' } })).ok).toBe(true)
    expect(verifyBash(sh, bashCheckSchema.parse({ en: 'web01', verificar: { servicio: 'nginx', activo: true, habilitado: true } })).ok).toBe(true)
  })

  it('--check no cambia nada y --diff muestra las diferencias', async () => {
    const { sh, run } = await session(lab({ 'p.yml': "- name: P\n  hosts: web01\n  become: true\n  gather_facts: false\n  tasks:\n    - name: Motd\n      ansible.builtin.copy:\n        content: \"Bienvenido\\n\"\n        dest: /etc/motd\n        mode: '0644'\n" }))
    const c = await run('ansible-playbook p.yml --check --diff')
    expect(c.out).toContain('+Bienvenido')
    expect(c.out).toContain('changed: [web01]')
    expect(verifyBash(sh, bashCheckSchema.parse({ en: 'web01', verificar: { archivo: '/etc/motd', contenido_incluye: 'Bienvenido' } })).ok).toBe(false)
    await run('ansible-playbook p.yml')
    expect(verifyBash(sh, bashCheckSchema.parse({ en: 'web01', verificar: { archivo: '/etc/motd', contenido_incluye: 'Bienvenido' } })).ok).toBe(true)
  })

  it('loops, register, when, failed_when, ignore_errors y bloques con rescue', async () => {
    const pb = `- name: Lógica
  hosts: web
  gather_facts: true
  tasks:
    - name: Paquetes según la familia
      ansible.builtin.debug:
        msg: "{{ item }}"
      loop: "{{ ['httpd'] if ansible_facts['os_family'] == 'RedHat' else ['apache2'] }}"
    - name: Comando
      ansible.builtin.command: cat /etc/hostname
      register: salida
      changed_when: false
    - name: Solo Ubuntu
      ansible.builtin.debug:
        var: salida.stdout
      when: ansible_facts['distribution'] == 'Ubuntu'
    - name: Bloque
      block:
        - name: Falla
          ansible.builtin.command: /bin/false
      rescue:
        - name: Rescate
          ansible.builtin.debug:
            msg: rescatado
`
    const { run } = await session(lab({ 'l.yml': pb }))
    const r = await run('ansible-playbook l.yml')
    expect(r.out).toContain('ok: [web01] => (item=httpd)')
    expect(r.out).toContain('ok: [web02] => (item=apache2)')
    expect(r.out).toContain('skipping: [web01]')
    expect(r.out).toContain('"salida.stdout": "web02"')
    expect(r.out).toContain('"msg": "rescatado"')
    expect(r.out).toMatch(/web01\s+: .*failed=0\s+skipped=1\s+rescued=1/)
    expect(r.code).toBe(0)
  })

  it('roles con defaults, colecciones que faltan y el handler que no existe', async () => {
    const files = {
      'sitio.yml': '- name: Web\n  hosts: web01\n  become: true\n  roles:\n    - web\n',
      'roles/web/defaults/main.yml': 'mensaje: hola\n',
      'roles/web/tasks/main.yml': "- name: Página\n  ansible.builtin.copy:\n    content: \"{{ mensaje }}\\n\"\n    dest: /tmp/pagina\n    mode: '0644'\n",
      'fw.yml': '- name: Fw\n  hosts: web01\n  tasks:\n    - name: http\n      ansible.posix.firewalld:\n        service: http\n        state: enabled\n',
      'h.yml': "- name: H\n  hosts: web01\n  gather_facts: false\n  tasks:\n    - name: Archivo\n      ansible.builtin.copy:\n        content: x\n        dest: /tmp/x\n        mode: '0644'\n      notify: No existe\n",
    }
    const { run } = await session(lab(files))
    const r = await run('ansible-playbook sitio.yml -e mensaje=chau')
    expect(r.out).toContain('TASK [web : Página]')
    expect((await run('ssh web01 cat /tmp/pagina')).out).toContain('chau')
    const f = await run('ansible-playbook fw.yml')
    expect(f.out).toContain("couldn't resolve module/action 'ansible.posix.firewalld'")
    expect(f.out).toContain("line 4, column 7")
    await run('ansible-galaxy collection install ansible.posix')
    expect((await run('ansible-playbook fw.yml --syntax-check')).code).toBe(0)
    const h = await run('ansible-playbook h.yml')
    expect(h.out).toContain("The requested handler 'No existe' was not found")
  })

  it('vault en group_vars y errores de sintaxis con la línea', async () => {
    const { run } = await session(lab({ 'group_vars/web.yml': 'clave_db: S3cr3to\n', 'v.yml': "- name: V\n  hosts: web01\n  gather_facts: false\n  tasks:\n    - name: Largo\n      ansible.builtin.debug:\n        msg: \"{{ clave_db | length }}\"\n", 'mal.yml': '- name: M\n  hosts: web01\n  tasks:\n    - name: x\n      ansible.builtin.dnf: name: nginx\n' }))
    await run('echo secreto > .vault_pass')
    expect((await run('ansible-vault encrypt group_vars/web.yml --vault-password-file .vault_pass')).out).toContain('Encryption successful')
    expect((await run('ansible-playbook v.yml')).out).toContain('Attempting to decrypt but no vault secrets found')
    expect((await run('ansible-playbook v.yml --vault-password-file .vault_pass')).out).toContain('"msg": "7"')
    const m = await run('ansible-playbook mal.yml')
    expect(m.out).toContain('mapping values are not allowed in this context')
    expect(m.out).toContain("line 5, column 28")
  })

  it('ansible-lint y ansible-galaxy role init', async () => {
    const { run } = await session(lab({ 'x.yml': '- hosts: web\n  tasks:\n    - shell: systemctl restart nginx\n    - name: Copia\n      copy:\n        src: a\n        dest: /tmp/a\n      become: yes\n' }))
    const l = await run('ansible-lint x.yml')
    for (const rule of ['name[play]', 'name[missing]', 'no-changed-when', 'command-instead-of-module', 'fqcn[action-core]', 'risky-file-permissions', 'yaml[truthy]']) expect(l.out).toContain(rule)
    expect(l.code).toBe(2)
    expect((await run('ansible-galaxy role init roles/base')).out).toContain('Role roles/base was created successfully')
    expect((await run('ls roles/base')).out).toContain('tasks')
  })
})

describe('ansible-lint (reglas)', () => {
  it('un playbook prolijo pasa', () => {
    const r = lintFiles([{ name: 'ok.yml', text: "- name: Web\n  hosts: web\n  tasks:\n    - name: Instalar nginx\n      ansible.builtin.package:\n        name: nginx\n        state: present\n    - name: Página\n      ansible.builtin.copy:\n        content: hola\n        dest: /tmp/a\n        mode: '0644'\n" }])
    expect(r.failures).toBe(0)
    expect(r.output).toContain("Last profile that met the validation criteria was 'production'")
  })
})

describe('editor de inventarios', () => {
  it('valida y expone los grupos con sus hijos para las reglas', async () => {
    const { validateConfig, evaluateRules } = await import('@/engines/config')
    const text = '[web]\nweb01\nweb02 ansible_host=10.0.0.12\n\n[db]\ndb01\n\n[produccion:children]\nweb\ndb\n'
    const v = validateConfig('inventario', text)
    expect(v.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const r = evaluateRules('inventario', text, [{ tipo: 'yaml_ruta', ruta: 'grupos.produccion', igual: ['web01', 'web02', 'db01'], existe: true, mensaje: 'prod' }, { tipo: 'yaml_ruta', ruta: 'equipos.web02.ansible_host', igual: '10.0.0.12', existe: true, mensaje: 'ip' }])
    expect(r.every((x) => x.ok)).toBe(true)
    expect(validateConfig('inventario', '[mis servidores]\nweb01\n').diagnostics.some((d) => d.severity === 'error')).toBe(true)
    expect(validateConfig('inventario', '[web]\nweb01 ansible_host = 10.0.0.1\n').diagnostics.some((d) => d.severity === 'error')).toBe(true)
  })
})
