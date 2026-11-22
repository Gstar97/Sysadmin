import { describe, expect, it } from 'vitest'
import { evaluate, JinjaError, lazyScope, render, templateValue } from '@/engines/ansible/jinja'

const vars = {
  nombre: 'web01',
  puerto: 8080,
  paquetes: ['nginx', 'firewalld'],
  usuarios: [
    { nombre: 'ana', grupos: ['wheel'], activo: true },
    { nombre: 'pablo', grupos: [], activo: false },
  ],
  sitio: { dominio: 'tienda.lab', ssl: true },
  ansible_facts: { distribution: 'Rocky', distribution_major_version: '9', os_family: 'RedHat' },
}

describe('Jinja2 para Ansible', () => {
  it('arma texto con variables, atributos, índices y filtros', () => {
    expect(render('Servidor {{ nombre | upper }} en el puerto {{ puerto }}', vars)).toBe('Servidor WEB01 en el puerto 8080')
    expect(render("{{ sitio.dominio }} {{ sitio['ssl'] }} {{ paquetes[0] }} {{ paquetes | join(', ') }}", vars)).toBe('tienda.lab True nginx nginx, firewalld')
    expect(render('{{ usuarios | selectattr("activo") | map(attribute="nombre") | list }}', vars)).toBe("['ana']")
    expect(render("{{ faltante | default('80') }} {{ '' | default('x', true) }} {{ paquetes | length }}", vars)).toBe('80 x 2')
    expect(render('{{ "a" ~ puerto ~ "b" }} {{ puerto // 3 }} {{ puerto % 7 }} {{ 2 ** 3 }}', vars)).toBe('a8080b 2693 2 8')
  })

  it('if, elif, else, for con loop, set, comentarios y raw, con trim_blocks como Ansible', () => {
    const tpl = `{# comentario #}
server {
    listen {{ puerto }};
{% if sitio.ssl %}
    listen 443 ssl;
{% elif puerto == 80 %}
    # solo http
{% else %}
    # nada
{% endif %}
{% for p in paquetes %}
    # {{ loop.index }}/{{ loop.length }} {{ p }}{% if not loop.last %},{% endif %}

{% endfor %}
{% set total = paquetes | length * 2 %}
    # total {{ total }}
{% raw %}    {{ sin_resolver }}{% endraw %}
}
`
    expect(render(tpl, vars)).toBe(`server {
    listen 8080;
    listen 443 ssl;
    # 1/2 nginx,
    # 2/2 firewalld
    # total 4
    {{ sin_resolver }}}
`)
  })

  it('for sobre diccionarios, con else y filtro if, y control de espacios con -', () => {
    expect(render('{% for k, v in sitio.items() %}{{ k }}={{ v }};{% endfor %}', vars)).toBe('dominio=tienda.lab;ssl=True;')
    expect(render('{% for u in usuarios if u.activo %}{{ u.nombre }}{% else %}nadie{% endfor %}', vars)).toBe('ana')
    expect(render('{% for u in [] %}x{% else %}nadie{% endfor %}', vars)).toBe('nadie')
    expect(render('a   {{- " b " -}}   c', vars)).toBe('a b c')
  })

  it('tests: defined, version, in, match y los de resultados registrados', () => {
    expect(evaluate('faltante is defined', vars)).toBe(false)
    expect(evaluate('nombre is defined and puerto > 80', vars)).toBe(true)
    expect(evaluate("ansible_facts.distribution_major_version is version('9', '>=')", vars)).toBe(true)
    expect(evaluate("ansible_facts['os_family'] == 'RedHat' and 'nginx' in paquetes", vars)).toBe(true)
    expect(evaluate("'httpd' not in paquetes", vars)).toBe(true)
    expect(evaluate("nombre is match('web')", vars)).toBe(true)
    expect(evaluate('r is changed and r is not failed', { r: { changed: true, failed: false } })).toBe(true)
    expect(evaluate("puerto if sitio.ssl else 'no'", vars)).toBe(8080)
  })

  it('las variables que faltan dan el error de Ansible', () => {
    expect(() => render('{{ puertos }}', vars)).toThrow(new JinjaError("'puertos' is undefined"))
    expect(() => render('{{ sitio.certificado }}', vars)).toThrow(/has no attribute 'certificado'/)
    expect(() => render('{% if x %}', vars)).toThrow(/endif/)
    expect(() => render('{{ nombre | inexistente }}', vars)).toThrow(/No filter named 'inexistente'/)
  })

  it('una expresión sola conserva el tipo y las variables se resuelven en cadena', () => {
    expect(templateValue('{{ paquetes }}', vars)).toEqual(['nginx', 'firewalld'])
    expect(templateValue('{{ puerto + 1 }}', vars)).toBe(8081)
    expect(templateValue('puerto {{ puerto }}', vars)).toBe('puerto 8080')
    expect(templateValue({ a: ['{{ nombre }}'], b: 3 }, vars)).toEqual({ a: ['web01'], b: 3 })
    const scope = lazyScope({ base: '/srv', web: '{{ base }}/www', sitio: '{{ web }}/tienda', bucle: '{{ bucle }}' })
    expect(render('{{ sitio }}', scope)).toBe('/srv/www/tienda')
    expect(() => render('{{ bucle }}', scope)).toThrow(/recursive loop/)
  })

  it('filtros de Ansible: combine, dict2items, regex, to_json, password_hash, ternary', () => {
    expect(templateValue("{{ {'a': 1, 'b': {'x': 1}} | combine({'b': {'y': 2}}, recursive=true) }}", {})).toEqual({ a: 1, b: { x: 1, y: 2 } })
    expect(templateValue('{{ sitio | dict2items }}', vars)).toEqual([{ key: 'dominio', value: 'tienda.lab' }, { key: 'ssl', value: true }])
    expect(render("{{ 'web01.lab' | regex_replace('\\\\.lab$', '.empresa.com') }}", vars)).toBe('web01.empresa.com')
    expect(render('{{ sitio | to_json }}', vars)).toBe('{"dominio":"tienda.lab","ssl":true}')
    const h = render("{{ 'secreto' | password_hash('sha512') }}", vars)
    expect(h).toMatch(/^\$6\$[./\w]{16}\$[./\w]{86}$/)
    expect(render("{{ 'secreto' | password_hash('sha512') }}", vars)).toBe(h)
    expect(render("{{ sitio.ssl | ternary('https', 'http') }}", vars)).toBe('https')
    expect(templateValue("{{ ['a', ['b', ['c']]] | flatten }}", {})).toEqual(['a', 'b', 'c'])
    expect(render("{{ 'Hola' | b64encode }}", {})).toBe('SG9sYQ==')
  })
})
