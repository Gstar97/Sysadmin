import { describe, expect, it } from 'vitest'
import { CHALLENGES, curlFor, handle, HOST, rawRequest, SESSION, TOKEN, type SimRequest } from '@/engines/web/httpsim'

const base = (over: Partial<SimRequest> = {}): SimRequest => ({ method: 'GET', path: '/', version: 'HTTP/1.1', headers: [['Host', HOST]], body: '', ...over })
const hdr = (r: { headers: [string, string][] }, n: string) => r.headers.find(([k]) => k === n)?.[1]

describe('servidor de práctica HTTP', () => {
  it('GET, HEAD, 404, 405 con Allow y Host obligatorio en HTTP/1.1', () => {
    expect(handle(base({ path: '/productos' })).status).toBe(200)
    const head = handle(base({ method: 'HEAD' }))
    expect(head.body).toBe('')
    expect(Number(hdr(head, 'Content-Length'))).toBeGreaterThan(0)
    expect(handle(base({ path: '/productos/99' })).status).toBe(404)
    const r405 = handle(base({ method: 'PUT', path: '/productos' }))
    expect(r405.status).toBe(405)
    expect(hdr(r405, 'Allow')).toBe('GET, HEAD, POST')
    expect(handle(base({ headers: [] })).status).toBe(400)
  })

  it('crear un producto pide token, JSON y nombre', () => {
    const post = (headers: [string, string][], body: string) => handle(base({ method: 'POST', path: '/productos', headers: [['Host', HOST], ...headers], body }))
    expect(post([], '{"nombre":"Termo"}').status).toBe(401)
    expect(post([['Authorization', `Bearer ${TOKEN}`]], '{"nombre":"Termo"}').status).toBe(415)
    expect(post([['Authorization', `Bearer ${TOKEN}`], ['Content-Type', 'application/json']], '{nombre}').status).toBe(400)
    const ok = post([['Authorization', `Bearer ${TOKEN}`], ['Content-Type', 'application/json']], '{"nombre":"Termo"}')
    expect(ok.status).toBe(201)
    expect(hdr(ok, 'Location')).toBe('/productos/10')
  })

  it('cookies, ETag, redirección y host virtual', () => {
    expect(handle(base({ path: '/perfil' })).status).toBe(302)
    const login = handle(base({ method: 'POST', path: '/login', body: 'usuario=ana&clave=mate2026' }))
    expect(hdr(login, 'Set-Cookie')).toContain(`sesion=${SESSION}`)
    expect(handle(base({ path: '/perfil', headers: [['Host', HOST], ['Cookie', `sesion=${SESSION}`]] })).status).toBe(200)
    const etag = hdr(handle(base()), 'ETag')!
    expect(handle(base({ headers: [['Host', HOST], ['If-None-Match', etag]] })).status).toBe(304)
    expect(hdr(handle(base({ path: '/viejo' })), 'Location')).toBe(`https://${HOST}/productos`)
    expect(handle(base({ headers: [['Host', 'otro.ejemplo.com']] })).body).toContain('Sitio por defecto')
  })

  it('HTTP/2 se muestra con pseudoencabezados y curl equivalente', () => {
    const r = base({ version: 'HTTP/2', method: 'POST', path: '/productos', headers: [['Host', HOST], ['Content-Type', 'application/json']], body: '{"nombre":"x"}' })
    expect(rawRequest(r)).toMatch(/^:method: POST\n:scheme: https\n:authority: tienda\.ejemplo\.com\n:path: \/productos\ncontent-type: application\/json/)
    expect(curlFor(r)).toBe(`curl -i -H 'Content-Type: application/json' -d '{"nombre":"x"}' https://${HOST}/productos`)
  })

  it('cada desafío tiene un camino que lo cumple', () => {
    const tries: SimRequest[] = [
      base({ path: '/productos' }),
      base({ method: 'HEAD' }),
      base({ method: 'DELETE', path: '/productos' }),
      base({ method: 'POST', path: '/productos', headers: [['Host', HOST], ['Authorization', `Bearer ${TOKEN}`], ['Content-Type', 'application/json']], body: '{"nombre":"Termo"}' }),
      base({ path: '/perfil', headers: [['Host', HOST], ['Cookie', `sesion=${SESSION}`]] }),
      base({ headers: [['Host', 'otro.com']] }),
      base({ headers: [['Host', HOST], ['If-None-Match', '"v2-8c1f"']] }),
    ]
    for (const c of CHALLENGES) expect(tries.some((t) => c.ok(t, handle(t))), c.id).toBe(true)
  })
})
