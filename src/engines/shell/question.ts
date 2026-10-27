import { bashCheckSchema, bashStateSchema } from './schema'
import { createBashSession, stripAnsi, verifyBash } from './index'

/**
 * Corrige una pregunta de "completar comando" ejecutándola en la terminal simulada:
 * así se aceptan todas las formas correctas de escribirla, no solo las previstas.
 */
export async function gradeWithSimulator(
  sim: { estado_inicial?: unknown; comparar_con?: string; verificar: unknown[] },
  text: string,
): Promise<boolean> {
  const state = bashStateSchema.parse(sim.estado_inicial ?? {})
  const sh = createBashSession(state)
  const { chunks } = await sh.run(text)
  const output = stripAnsi(chunks.filter((c) => c.stream === 'out').map((c) => c.text).join(''))
  if (sim.comparar_con) {
    const ref = createBashSession(state)
    const res = await ref.run(sim.comparar_con)
    const expected = stripAnsi(res.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join(''))
    if (output.trim() !== expected.trim()) return false
  }
  for (const raw of sim.verificar) {
    const check = bashCheckSchema.parse(raw)
    if (!verifyBash(sh, check).ok) return false
  }
  return sh.lastExit === 0 || sim.verificar.length > 0
}
