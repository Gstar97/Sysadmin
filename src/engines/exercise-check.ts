/**
 * Comprobaciones de los ejercicios que no se pueden hacer solo con el esquema: que la solución de
 * referencia de una terminal realmente cumpla sus verificaciones, que un archivo de configuración
 * corregido pase sus reglas y que una topología no tenga referencias rotas.
 * Lo usan el validador de contenido (npm run validar) y las pruebas automáticas.
 */
import type { ConfigExercise, TerminalExercise } from '@/content/exercise-schemas'
import { evaluateRules, validateConfig } from './config'
import { createIosSession, verifyIos } from './network'
import { parseIpv4 } from './network/ip'
import { Network, normalizeIfName } from './network/model'
import type { TopologyExercise } from './network/schema'
import { createPsSession, verifyPs } from './powershell'
import type { PsCheck } from './powershell/schema'
import { createBashSession, verifyBash } from './shell'
import type { BashCheck } from './shell/schema'
import type { IosCheck } from './network/schema'

export interface ExerciseProblem {
  level: 'error' | 'warning'
  message: string
}

/** Ejecuta la solución de cada paso en el simulador y comprueba que cumple todas sus verificaciones. */
export async function checkTerminalExercise(ex: TerminalExercise): Promise<ExerciseProblem[]> {
  const problems: ExerciseProblem[] = []
  let run: (cmd: string) => Promise<void>
  let verify: (check: unknown) => { ok: boolean; label: string }
  if (ex.shell === 'bash') {
    const sh = createBashSession(ex.estado_inicial)
    run = async (c) => void (await sh.run(c))
    verify = (c) => verifyBash(sh, c as BashCheck)
  } else if (ex.shell === 'powershell') {
    const s = createPsSession(ex.estado_inicial)
    run = async (c) => void (await s.run(c))
    verify = (c) => verifyPs(s, c as PsCheck)
  } else {
    const s = createIosSession(ex.estado_inicial)
    const consola = ex.estado_inicial.consola
    run = async (c) => void (await s.run(c))
    verify = (c) => verifyIos(s, c as IosCheck, consola)
  }
  for (const [i, paso] of ex.pasos.entries()) {
    if (!paso.solucion.length) {
      problems.push({ level: 'warning', message: `el paso ${i + 1} no tiene solución de referencia: no se puede comprobar que tenga solución` })
      continue
    }
    const before = paso.verificar.map((c) => verify(c).ok)
    if (before.every(Boolean) && !paso.verificar.some((c) => 'comando_usado' in (c as object) || 'salida_contiene' in (c as object))) {
      problems.push({ level: 'warning', message: `el paso ${i + 1} ya se cumple antes de escribir nada` })
    }
    for (const cmd of paso.solucion) await run(cmd)
    for (const c of paso.verificar) {
      const r = verify(c)
      if (!r.ok) problems.push({ level: 'error', message: `el paso ${i + 1} no se cumple con su solución de referencia: falla "${r.label}"` })
    }
  }
  return problems
}

export function checkConfigExercise(ex: ConfigExercise): ExerciseProblem[] {
  const problems: ExerciseProblem[] = []
  const initial = evaluateRules(ex.lenguaje, ex.archivo_inicial, ex.reglas)
  if (initial.every((r) => r.ok)) problems.push({ level: 'warning', message: 'el archivo inicial ya cumple todas las reglas: no hay nada que corregir' })
  if (ex.solucion) {
    const v = validateConfig(ex.lenguaje, ex.solucion)
    for (const d of v.diagnostics.filter((x) => x.severity === 'error')) problems.push({ level: 'error', message: `la solución tiene un error en la línea ${d.line}: ${d.message}` })
    for (const r of evaluateRules(ex.lenguaje, ex.solucion, ex.reglas, v)) if (!r.ok) problems.push({ level: 'error', message: `la solución no cumple la regla "${r.mensaje}"` })
  } else problems.push({ level: 'warning', message: 'no tiene solución de referencia' })
  return problems
}

export function checkTopologyExercise(ex: TopologyExercise): ExerciseProblem[] {
  const problems: ExerciseProblem[] = []
  const ids = new Set(ex.dispositivos.map((d) => d.id))
  for (const d of ex.dispositivos) {
    for (const i of d.interfaces) if (!normalizeIfName(i.nombre, d.tipo)) problems.push({ level: 'error', message: `${d.id}: nombre de interfaz no reconocido "${i.nombre}"` })
  }
  const used = new Map<string, string>()
  for (const l of ex.enlaces) {
    for (const end of [l.a, l.b]) {
      const [dev, port] = end.split(':')
      const d = ex.dispositivos.find((x) => x.id === dev)
      if (!d) {
        problems.push({ level: 'error', message: `el enlace ${l.a} ↔ ${l.b} usa el equipo "${dev}", que no existe` })
        continue
      }
      const norm = normalizeIfName(port, d.tipo)
      if (!norm) problems.push({ level: 'error', message: `el enlace ${l.a} ↔ ${l.b} usa una interfaz no reconocida "${port}"` })
      const key = `${dev}:${norm ?? port}`.toLowerCase()
      if (used.has(key)) problems.push({ level: 'error', message: `la interfaz ${end} tiene dos cables (también en ${used.get(key)})` })
      used.set(key, `${l.a} ↔ ${l.b}`)
    }
  }
  for (const o of ex.objetivos) {
    for (const t of [o.desde, o.hacia]) if (!ids.has(t) && parseIpv4(t) === undefined) problems.push({ level: 'error', message: `el objetivo "${o.desde} → ${o.hacia}" menciona "${t}", que no es un equipo ni una IP` })
  }
  if (!problems.length) {
    try {
      new Network(ex)
    } catch (e) {
      problems.push({ level: 'error', message: `la topología no se puede construir: ${(e as Error).message}` })
    }
  }
  return problems
}
