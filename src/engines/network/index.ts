import { formatIpv4, maskToPrefix, networkOf, parseCidr, parseIpv4 } from './ip'
import { IosSession, runningConfig } from './ios'
import { Network } from './model'
import { iosCheckSchema, iosStateSchema, type IosCheck, type ObjectiveSpec, type TopologySpec } from './schema'

export { Network } from './model'
export { IosSession, runningConfig } from './ios'

/** Crea una consola IOS conectada al equipo indicado de la topología del ejercicio. */
export function createIosSession(input: unknown): IosSession {
  const state = iosStateSchema.parse(input)
  return new IosSession(new Network(state.topologia), state.consola)
}

export interface CheckResult {
  ok: boolean
  label: string
}

/** Evalúa un objetivo de conectividad ("PC1 llega a SRV"). */
export function checkObjective(net: Network, o: ObjectiveSpec): CheckResult & { reason?: string } {
  const r = net.ping(o.desde, o.hacia)
  const expected = o.resultado === 'ok'
  const label = o.descripcion ?? `${o.desde} ${expected ? 'llega' : 'no llega'} a ${o.hacia}`
  return { ok: r.ok === expected, label, reason: r.ok ? undefined : r.reason }
}

export function networkFromSpec(spec: TopologySpec): Network {
  return new Network(spec)
}

function normalizeConfig(text: string) {
  return text
    .split('\n')
    .map((l) => l.trim().replace(/\s+/g, ' ').toLowerCase())
    .join('\n')
}

/** Comprueba una verificación de ejercicio IOS contra el estado de la red. */
export function verifyIos(s: IosSession, raw: IosCheck, defaultDevice?: string): CheckResult {
  const check = iosCheckSchema.parse(raw)
  const devName = ('equipo' in check && check.equipo) || defaultDevice || s.dev.id
  const d = s.net.device(devName)
  if ('ping' in check) return checkObjective(s.net, check.ping)
  if ('salida_contiene' in check) return { ok: s.lastOutput.toLowerCase().includes(check.salida_contiene.toLowerCase()), label: `la salida muestra "${check.salida_contiene}"` }
  if ('comando_usado' in check) {
    let re: RegExp | undefined
    try {
      re = new RegExp(check.comando_usado, 'i')
    } catch {
      re = undefined
    }
    return { ok: !!re && s.history.some((h) => re.test(h)), label: 'se usó el comando pedido' }
  }
  if (!d) return { ok: false, label: `no existe el equipo ${devName}` }
  if ('guardado' in check) return { ok: s.isSaved(d) === check.guardado, label: check.guardado ? `la configuración de ${d.hostname} está guardada` : `la configuración de ${d.hostname} no está guardada` }
  if ('config_contiene' in check) {
    const ok = normalizeConfig(runningConfig(d)).includes(normalizeConfig(check.config_contiene))
    return { ok, label: `la configuración de ${d.hostname} incluye "${check.config_contiene}"` }
  }
  if ('interfaz' in check) {
    const p = s.net.port(d, check.interfaz)
    if (!p) return { ok: false, label: `${check.interfaz} en ${d.hostname}` }
    let ok = true
    const parts: string[] = []
    if (check.modo) {
      ok &&= s.net.effectiveMode(d, p) === (check.modo === 'acceso' ? 'access' : 'trunk') && p.mode === (check.modo === 'acceso' ? 'access' : 'trunk')
      parts.push(`modo ${check.modo}`)
    }
    if (check.vlan !== undefined) {
      ok &&= p.accessVlan === check.vlan
      parts.push(`VLAN ${check.vlan}`)
    }
    if (check.apagada !== undefined) {
      ok &&= p.shutdown === check.apagada
      parts.push(check.apagada ? 'apagada' : 'encendida')
    }
    if (check.ip) {
      const c = parseCidr(check.ip)
      const ip = c?.ip ?? parseIpv4(check.ip)
      ok &&= !!p.ip && p.ip.ip === ip && (!c || p.ip.prefix === c.prefix)
      parts.push(`IP ${check.ip}`)
    }
    return { ok, label: `${p.name} de ${d.hostname}: ${parts.join(', ') || 'existe'}` }
  }
  if ('vlan' in check) {
    const exists = d.vlans.has(check.vlan)
    if (!check.existe) return { ok: !exists, label: `la VLAN ${check.vlan} no existe en ${d.hostname}` }
    const ok = exists && (!check.nombre || d.vlans.get(check.vlan)!.toLowerCase() === check.nombre.toLowerCase())
    return { ok, label: `VLAN ${check.vlan}${check.nombre ? ` (${check.nombre})` : ''} en ${d.hostname}` }
  }
  // ruta
  const target = parseCidr(check.ruta) ?? (() => {
    const [a, m] = check.ruta.split(/\s+/)
    const ip = parseIpv4(a ?? '')
    const prefix = m ? maskToPrefix(parseIpv4(m) ?? 0) : undefined
    return ip !== undefined && prefix !== undefined ? { ip, prefix } : undefined
  })()
  if (!target) return { ok: false, label: `ruta ${check.ruta}` }
  const via = check.via ? parseIpv4(check.via) : undefined
  const found = s.net.routingTable(d).some((r) => r.net === networkOf(target.ip, target.prefix) && r.prefix === target.prefix && (via === undefined || r.nextHop === via))
  return { ok: found, label: `${d.hostname} tiene ruta a ${formatIpv4(networkOf(target.ip, target.prefix))}/${target.prefix}${check.via ? ` por ${check.via}` : ''}` }
}
