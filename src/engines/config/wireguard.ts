/**
 * Configuración de WireGuard (/etc/wireguard/wg0.conf, la que leen wg-quick y la app de los
 * clientes): una sección [Interface] y una [Peer] por cada otro extremo. Avisa lo que diría
 * wg-quick (líneas desconocidas, claves mal copiadas) y los errores de diseño habituales:
 * AllowedIPs que se pisan entre peers, túnel completo sin querer, falta de keepalive detrás de NAT.
 */
import type { Diagnostic } from './types'

const INTERFACE_KEYS = ['privatekey', 'address', 'listenport', 'dns', 'mtu', 'table', 'preup', 'postup', 'predown', 'postdown', 'saveconfig', 'fwmark']
const PEER_KEYS = ['publickey', 'presharedkey', 'allowedips', 'endpoint', 'persistentkeepalive']

function ipv4(s: string): number | undefined {
  const p = s.split('.')
  if (p.length !== 4 || !p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return undefined
  return p.reduce((a, b) => a * 256 + Number(b), 0)
}

function cidr(s: string): { net: number; prefix: number; host: boolean } | undefined {
  const [a, p] = s.split('/')
  const ip = ipv4(a)
  const prefix = p === undefined ? 32 : Number(p)
  if (ip === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return undefined
  const size = 2 ** (32 - prefix)
  const net = Math.floor(ip / size) * size
  return { net, prefix, host: net !== ip }
}

const isKey = (s: string) => /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/.test(s)

export function validateWireguard(text: string): { diagnostics: Diagnostic[]; entries: { key: string; value: string; line: number }[] } {
  const diagnostics: Diagnostic[] = []
  const entries: { key: string; value: string; line: number }[] = []
  const err = (line: number, message: string) => diagnostics.push({ line, severity: 'error', message })
  const warn = (line: number, message: string) => diagnostics.push({ line, severity: 'warning', message })
  let section: 'none' | 'interface' | 'peer' = 'none'
  let interfaces = 0
  const peers: { line: number; keys: Map<string, { value: string; line: number }> }[] = []
  let iface = new Map<string, { value: string; line: number }>()
  text.split('\n').forEach((raw, i) => {
    const n = i + 1
    const t = raw.replace(/#.*$/, '').trim()
    if (!t) return
    const sec = /^\[(\w+)\]$/.exec(t)
    if (sec) {
      const name = sec[1].toLowerCase()
      if (name === 'interface') {
        section = 'interface'
        interfaces++
        if (interfaces > 1) err(n, 'Hay más de una sección [Interface]: va una sola por archivo.')
      } else if (name === 'peer') {
        section = 'peer'
        peers.push({ line: n, keys: new Map() })
      } else err(n, `Sección desconocida [${sec[1]}]: son [Interface] y [Peer].`)
      return
    }
    const kv = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(t)
    if (!kv) {
      err(n, `Line unrecognized: '${t}' (cada línea es Clave = valor).`)
      return
    }
    const key = kv[1].toLowerCase()
    const value = kv[2].trim()
    if (section === 'none') {
      err(n, `${kv[1]} va dentro de una sección: falta [Interface] o [Peer] arriba.`)
      return
    }
    const allowed = section === 'interface' ? INTERFACE_KEYS : PEER_KEYS
    if (!allowed.includes(key)) {
      const other = section === 'interface' ? PEER_KEYS.includes(key) : INTERFACE_KEYS.includes(key)
      err(n, other ? `${kv[1]} va en la sección [${section === 'interface' ? 'Peer' : 'Interface'}], no en [${section === 'interface' ? 'Interface' : 'Peer'}].` : `Line unrecognized: '${kv[1]}' (revisa cómo está escrito).`)
      return
    }
    entries.push({ key: `${section === 'interface' ? 'Interface' : 'Peer'}.${kv[1]}`, value, line: n })
    const map = section === 'interface' ? iface : peers.at(-1)!.keys
    if (map.has(key) && !['address', 'allowedips', 'dns', 'postup', 'postdown', 'preup', 'predown'].includes(key)) err(n, `${kv[1]} está repetida en esta sección.`)
    map.set(key, map.has(key) ? { value: `${map.get(key)!.value}, ${value}`, line: map.get(key)!.line } : { value, line: n })
    if ((key === 'privatekey' || key === 'publickey' || key === 'presharedkey') && !isKey(value)) err(n, `${kv[1]} no parece una clave de WireGuard: son 44 caracteres en base64 que terminan en "=" (copiala completa, sin espacios).`)
    if (key === 'address' || key === 'allowedips') {
      for (const part of value.split(',').map((x) => x.trim()).filter(Boolean)) {
        if (part.includes(':')) continue
        const c = cidr(part)
        if (!c) err(n, `Dirección inválida: ${part}.`)
        else if (key === 'allowedips' && c.host) warn(n, `${part} tiene bits de host; wg la guarda como ${[24, 16, 8, 0].map((s) => (c.net >>> s) & 255).join('.')}/${c.prefix}.`)
      }
    }
    if (key === 'listenport' && !(Number(value) >= 1 && Number(value) <= 65535)) err(n, 'ListenPort va de 1 a 65535 (el habitual es 51820).')
    if (key === 'persistentkeepalive' && !(Number(value) >= 0 && Number(value) <= 65535)) err(n, 'PersistentKeepalive es una cantidad de segundos (25 es lo habitual).')
    if (key === 'endpoint' && !/^(\[[0-9a-f:]+\]|[\w.-]+):\d{1,5}$/i.test(value)) err(n, 'Endpoint es host:puerto (por ejemplo, vpn.empresa.com:51820).')
    if (key === 'dns') for (const d of value.split(',').map((x) => x.trim())) if (ipv4(d) === undefined && !d.includes(':') && !/^[a-z0-9.-]+$/i.test(d)) err(n, `DNS inválido: ${d}.`)
  })
  if (!interfaces) err(1, 'Falta la sección [Interface].')
  else {
    if (!iface.has('privatekey')) err(1, 'Falta PrivateKey en [Interface].')
    if (!iface.has('address')) warn(1, 'Sin Address en [Interface]: wg-quick no le pone IP al túnel.')
  }
  if (!peers.length) warn(1, 'No hay ninguna sección [Peer]: el túnel no tiene con quién hablar.')
  const ranges: { net: number; prefix: number; peer: number; text: string }[] = []
  const pubs = new Map<string, number>()
  peers.forEach((p, idx) => {
    if (!p.keys.has('publickey')) err(p.line, 'Este [Peer] no tiene PublicKey.')
    else {
      const k = p.keys.get('publickey')!.value
      if (pubs.has(k)) err(p.keys.get('publickey')!.line, 'Dos [Peer] con la misma PublicKey: es el mismo equipo dos veces.')
      pubs.set(k, idx)
      if (iface.get('privatekey')?.value === k) err(p.keys.get('publickey')!.line, 'Esta PublicKey es igual a tu PrivateKey: en [Peer] va la clave pública del otro extremo.')
    }
    if (!p.keys.has('allowedips')) err(p.line, 'Este [Peer] no tiene AllowedIPs: no va a pasar ningún tráfico por él.')
    else {
      for (const part of p.keys.get('allowedips')!.value.split(',').map((x) => x.trim())) {
        const c = cidr(part)
        if (!c) continue
        for (const r of ranges) {
          if (r.peer === idx) continue
          const small = Math.max(c.prefix, r.prefix)
          const size = 2 ** (32 - Math.min(c.prefix, r.prefix))
          if (Math.floor(c.net / size) === Math.floor(r.net / size) && small >= Math.min(c.prefix, r.prefix)) warn(p.keys.get('allowedips')!.line, `${part} se pisa con ${r.text} de otro [Peer]: cada dirección debería ser de un solo peer (wg se la asigna al último).`)
        }
        ranges.push({ net: c.net, prefix: c.prefix, peer: idx, text: part })
        if (c.prefix === 0 && peers.length > 1) warn(p.keys.get('allowedips')!.line, '0.0.0.0/0 en un [Peer] cuando hay varios: todo el tráfico va a este peer y los demás quedan sin rutas.')
      }
    }
    if (p.keys.has('endpoint') && !p.keys.has('persistentkeepalive') && !iface.has('listenport')) warn(p.line, 'Este equipo no escucha en un puerto fijo y no tiene PersistentKeepalive: si está detrás de NAT, el otro extremo no va a poder iniciar el contacto. Agregá PersistentKeepalive = 25.')
  })
  iface = new Map()
  return { diagnostics, entries }
}
