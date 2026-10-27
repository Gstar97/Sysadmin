import { psCheckSchema, psStateSchema } from './schema'
import { createPsSession, verifyPs } from './index'

/**
 * Corrige una pregunta de "completar comando" de PowerShell ejecutándola en la consola simulada,
 * para aceptar todas las formas válidas (alias, parámetros abreviados, otro orden).
 */
export async function gradeWithPsSimulator(
  sim: { estado_inicial?: unknown; comparar_con?: string; verificar: unknown[] },
  text: string,
): Promise<boolean> {
  const state = psStateSchema.parse(sim.estado_inicial ?? {})
  const s = createPsSession(state)
  const { chunks } = await s.run(text)
  if (chunks.some((c) => c.stream === 'err')) return false
  const output = chunks.map((c) => c.text).join('')
  if (sim.comparar_con) {
    const ref = createPsSession(state)
    const res = await ref.run(sim.comparar_con)
    const expected = res.chunks.map((c) => c.text).join('')
    if (output.trim().toLowerCase() !== expected.trim().toLowerCase()) return false
  }
  for (const raw of sim.verificar) {
    if (!verifyPs(s, psCheckSchema.parse(raw)).ok) return false
  }
  return true
}
