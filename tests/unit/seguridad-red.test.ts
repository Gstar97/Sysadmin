import { describe, expect, it } from 'vitest'
import { OFICINA, REQUISITOS_LAN, evaluar, paquetesOficina } from '@/engines/redes/firewall'
import { parseAclLine, newAcl, addEntry, evaluateAcl, formatEntry } from '@/engines/network/acl'
import { validateNftables } from '@/engines/config/nftables'
import { validateWireguard } from '@/engines/config/wireguard'
import { OFICINA_APS, choque, sugerir24, vecinos } from '@/engines/redes/wifi'
import { createIosSession } from '@/engines/network'

describe('Firewall con estado', () => {
  it('las respuestas pasan por estado y la redirección se aplica antes de las reglas', () => {
    const ps = paquetesOficina()
    const r = ps.map((p) => evaluar(OFICINA, p).pasa)
    expect(r[0]).toBe(true) // web pública por la IP pública
    expect(r[1]).toBe(true) // su respuesta
    expect(r[2]).toBe(false) // SSH a la IP pública
    expect(ps.filter((p) => p.texto.includes('intenta SSH a una PC de la LAN')).map((p) => evaluar(OFICINA, p).pasa)).toEqual([false])
  })
  it('el orden correcto de la LAN cumple la política', () => {
    expect(REQUISITOS_LAN.every((q) => evaluar(OFICINA, q.paquete).pasa === q.pasa)).toBe(true)
    const mal = [...OFICINA.reglas.filter((x) => x.interfaz !== 'LAN'), ...OFICINA.reglas.filter((x) => x.interfaz === 'LAN').reverse()]
    expect(REQUISITOS_LAN.every((q) => evaluar(OFICINA, q.paquete, mal).pasa === q.pasa)).toBe(false)
  })
})

describe('ACL de IOS', () => {
  it('interpreta, evalúa con deny implícito y muestra como IOS', () => {
    const acl = newAcl('WEB', 'extended')
    for (const l of ['permit tcp any host 172.16.0.10 eq 443', 'permit tcp 192.168.1.0 0.0.0.255 any established']) {
      const e = parseAclLine('extended', l)
      if ('error' in e) throw new Error(e.error)
      addEntry(acl, e)
    }
    const ip = (s: string) => s.split('.').reduce((a, o) => a * 256 + Number(o), 0)
    expect(evaluateAcl(acl, { src: ip('8.8.8.8'), dst: ip('172.16.0.10'), proto: 'tcp', dstPort: 443 })?.seq).toBe(10)
    expect(evaluateAcl(acl, { src: ip('8.8.8.8'), dst: ip('172.16.0.10'), proto: 'tcp', dstPort: 22 })).toBeUndefined()
    expect(evaluateAcl(acl, { src: ip('192.168.1.5'), dst: ip('8.8.8.8'), proto: 'tcp', dstPort: 80 })).toBeUndefined()
    expect(evaluateAcl(acl, { src: ip('192.168.1.5'), dst: ip('8.8.8.8'), proto: 'tcp', dstPort: 80, established: true })?.seq).toBe(20)
    expect(formatEntry('extended', acl.entries[0])).toBe('permit tcp any host 172.16.0.10 eq 443')
    expect('error' in parseAclLine('extended', 'permit tcp any any eq 70000')).toBe(true)
  })
  it('una ACL mal aplicada corta las respuestas', async () => {
    const s = createIosSession({
      consola: 'R1',
      topologia: {
        dispositivos: [
          { id: 'R1', tipo: 'router', interfaces: [{ nombre: 'Gi0/0', ip: '192.168.1.1/24' }, { nombre: 'Gi0/1', ip: '172.16.0.1/24', acl_entrada: 'X' }], acls: [{ nombre: 'X', tipo: 'extendida', reglas: ['permit tcp any host 172.16.0.10 eq 443'] }] },
          { id: 'PC', tipo: 'pc', interfaces: [{ nombre: 'eth0', ip: '192.168.1.10/24' }], puerta_enlace: '192.168.1.1' },
          { id: 'WEB', tipo: 'servidor', interfaces: [{ nombre: 'eth0', ip: '172.16.0.10/24' }], puerta_enlace: '172.16.0.1' },
        ],
        enlaces: [
          { a: 'PC:eth0', b: 'R1:Gi0/0' },
          { a: 'WEB:eth0', b: 'R1:Gi0/1' },
        ],
      },
    })
    expect(s.net.probe({ desde: 'PC', hacia: 'WEB', proto: 'tcp', puerto: 443 }).ok).toBe(false)
    for (const c of ['enable', 'configure terminal', 'interface gi0/1', 'no ip access-group X in', 'ip access-group X out']) await s.run(c)
    expect(s.net.probe({ desde: 'PC', hacia: 'WEB', proto: 'tcp', puerto: 443 }).ok).toBe(true)
    expect(s.net.probe({ desde: 'PC', hacia: 'WEB', proto: 'tcp', puerto: 22 }).ok).toBe(false)
  })
})

describe('nftables y WireGuard', () => {
  it('nftables: avisa política drop sin respuestas y NAT fuera de lugar', () => {
    const d = validateNftables('table inet f {\n  chain input {\n    type filter hook input priority filter; policy drop;\n    tcp dport 22 accept\n    masquerade\n  }\n}\n').diagnostics
    expect(d.some((x) => x.severity === 'error' && /masquerade/.test(x.message))).toBe(true)
    expect(d.some((x) => x.severity === 'warning' && /established/.test(x.message))).toBe(true)
  })
  it('WireGuard: clave propia en el peer y AllowedIPs que se pisan', () => {
    const k1 = 'ZWq9mZ9rlPfp/DdzUl2JrH5++AHnst2zyg/WxfOCPG8='
    const k2 = 'REk0nfHw0RfgWf/svwuhlK1hV0N2/TgQdI5c92e7gyA='
    const d = validateWireguard(`[Interface]\nPrivateKey = ${k1}\nAddress = 10.99.0.1/24\nListenPort = 51820\n\n[Peer]\nPublicKey = ${k1}\nAllowedIPs = 10.99.0.2/32\n\n[Peer]\nPublicKey = ${k2}\nAllowedIPs = 10.99.0.0/24\n`).diagnostics
    expect(d.some((x) => x.severity === 'error' && /PrivateKey/.test(x.message))).toBe(true)
    expect(d.some((x) => x.severity === 'warning' && /se pisa/.test(x.message))).toBe(true)
  })
})

describe('Canales Wi-Fi', () => {
  it('1 y 3 se pisan, 1 y 6 no, y la solución sugerida no choca', () => {
    const a = { ...OFICINA_APS[0], canal: 1 }
    expect(choque(a, { ...a, id: 'b', canal: 3 })).toBe('solapado')
    expect(choque(a, { ...a, id: 'b', canal: 1 })).toBe('cocanal')
    expect(choque(a, { ...a, id: 'b', canal: 6 })).toBe('ninguno')
    const sol = sugerir24(OFICINA_APS, 200)
    const aps = OFICINA_APS.map((x, i) => ({ ...x, canal: sol[i] }))
    expect(vecinos(aps, 200).every(([i, j]) => choque(aps[i], aps[j]) === 'ninguno')).toBe(true)
  })
})
