import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanContent } from '../../build/content-scan'

describe('escáner de contenido', () => {
  it('el contenido de prueba está completo y sin errores', () => {
    const r = scanContent('tests/fixtures/content')
    expect(r.errors).toEqual([])
    const lesson = r.index.levels[0].modules[0].lessons[0]
    expect(lesson.id).toBe('n0-m1-l1')
    expect(lesson.preguntas).toBe(8)
    expect(lesson.secciones.map((s) => s.slug)).toEqual(['para-que-sirve-un-puerto', 'tcp-y-udp', 'ver-que-escucha-en-un-servidor'])
    expect(r.searchDocs.some((d) => d.url === '/leccion/n0-m1-l1#tcp-y-udp')).toBe(true)
  })

  it('el contenido real de la carrera no tiene errores', () => {
    const r = scanContent('content')
    expect(r.errors).toEqual([])
    expect(r.index.levels).toHaveLength(10)
  })

  it('informa los problemas de una lección incompleta', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contenido-'))
    fs.cpSync('tests/fixtures/content', tmp, { recursive: true })
    const lessonDir = path.join(tmp, 'niveles/00-prueba/01-redes-basicas/01-puertos')
    const mdx = fs.readFileSync(path.join(lessonDir, 'leccion.mdx'), 'utf8')
    fs.writeFileSync(path.join(lessonDir, 'leccion.mdx'), mdx.replace(/<Resumen>[\s\S]*<\/Resumen>/, 'Contenido pendiente.'))
    fs.writeFileSync(path.join(lessonDir, 'preguntas.yaml'), '- id: x\n  tipo: opcion_multiple\n  enunciado: ¿?\n  opciones:\n    - { texto: a, correcta: true, explicacion: b }\n    - { texto: c, explicacion: "" }\n')
    const r = scanContent(tmp)
    const all = r.errors.join('\n')
    expect(all).toMatch(/falta el resumen/)
    expect(all).toMatch(/relleno/)
    expect(all).toMatch(/explicar por qué/)
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})
