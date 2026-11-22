import { describe, expect, it } from 'vitest'
import { pythonExerciseSchema } from '@/content/exercise-schemas'
import { checkPythonExercise, evaluar } from '@/engines/python/check'

const base = pythonExerciseSchema.parse({
  tipo: 'python',
  titulo: 'prueba',
  archivos: { '/datos/servidores.txt': 'web01\ndb01\n', 'config.ini': '[app]\npuerto = 8080\n' },
  api: {
    'https://api.ejemplo/estado': { json: { ok: true, version: '2.1' } },
    'POST https://api.ejemplo/alertas': { estado: 201, json: { id: 7 } },
    'https://api.ejemplo/roto': { estado: 503, texto: 'mantenimiento' },
    'https://api.ejemplo/lento': { json: {}, demora: 5 },
  },
  comandos: { 'df -h /': { salida: 'Filesystem Size Use%\n/dev/sda1 20G 91%\n' }, 'systemctl is-active nginx': { salida: 'failed\n', codigo: 3 } },
  argumentos: ['--umbral', '80'],
  pasos: [{ consigna: 'c', solucion: 'pass', verificar: [{ sin_error: true }] }],
})

const run = (code: string, verificar = base.pasos[0].verificar) => evaluar({ ...base, pasos: [{ ...base.pasos[0], verificar }] }, 0, code)

describe('consola de Python (Pyodide)', () => {
  it('corre Python de verdad, con archivos de ejemplo y rutas relativas a la carpeta de trabajo', async () => {
    const { result } = await run(`
import configparser, os
from pathlib import Path
print(Path('/datos/servidores.txt').read_text().split())
c = configparser.ConfigParser(); c.read('config.ini')
print(c['app'].getint('puerto') + 1, os.getcwd())`)
    expect(result.error).toBeUndefined()
    expect(result.stdout).toBe("['web01', 'db01']\n8081 /home/estudiante\n")
  }, 60_000)

  it('simula requests: JSON, POST, errores HTTP, servidores inexistentes y tiempos de espera', async () => {
    const { result } = await run(`
import requests
r = requests.get('https://api.ejemplo/estado', timeout=5)
print(r.status_code, r.json()['version'], r.ok)
print(requests.post('https://api.ejemplo/alertas', json={'x': 1}).status_code)
try:
    requests.get('https://api.ejemplo/roto').raise_for_status()
except requests.HTTPError as e:
    print('HTTP', e.response.status_code)
try:
    requests.get('https://no.existe/', timeout=3)
except requests.exceptions.ConnectionError:
    print('sin conexión')
try:
    requests.get('https://api.ejemplo/lento', timeout=2)
except requests.Timeout:
    print('timeout')
print(requests.get('https://api.ejemplo/lento', timeout=10).status_code)`)
    expect(result.error).toBeUndefined()
    expect(result.stdout).toBe('200 2.1 True\n201\nHTTP 503\nsin conexión\ntimeout\n200\n')
  }, 60_000)

  it('simula subprocess.run con las salidas del ejercicio y respeta check y los códigos de salida', async () => {
    const { result } = await run(`
import subprocess, sys
r = subprocess.run(['df', '-h', '/'], capture_output=True, text=True)
print(r.returncode, r.stdout.splitlines()[1].split()[-1])
print(subprocess.run('systemctl is-active nginx', shell=True, capture_output=True, text=True).returncode)
try:
    subprocess.run(['systemctl', 'is-active', 'nginx'], check=True, capture_output=True)
except subprocess.CalledProcessError as e:
    print('falló con', e.returncode)
print(sys.argv[1:])`)
    expect(result.error).toBeUndefined()
    expect(result.stdout).toBe("0 91%\n3\nfalló con 3\n['--umbral', '80']\n")
  }, 60_000)

  it('atrapa sys.exit y los errores, y muestra el traceback del programa', async () => {
    const salida = await run('import sys\nprint("a")\nsys.exit("no encontré el archivo")', [{ codigo_salida: 1 }, { error_contiene: 'no encontré' }])
    expect(salida.result.codigo).toBe(1)
    expect(salida.checks.every((c) => c.ok)).toBe(true)
    const err = await run('def f(x):\n    return x / 0\nf(1)')
    expect(err.result.error).toContain('File "programa.py", line 2, in f')
    expect(err.result.error).toContain('ZeroDivisionError')
    expect(err.result.error).not.toContain('_simrun')
    expect(err.checks[0]).toMatchObject({ ok: false, detalle: 'ZeroDivisionError: division by zero' })
  }, 60_000)

  it('cada corrida empieza de cero: no quedan archivos, variables ni módulos de la anterior', async () => {
    await run(`
from pathlib import Path
Path('reporte.json').write_text('{}')
Path('/tmp/x').write_text('1')
Path('utilidades.py').write_text('VALOR = 1')
import utilidades
global_viejo = 1`)
    const { result } = await run(`
import os
print(os.path.exists('reporte.json'), os.path.exists('/tmp/x'), 'global_viejo' in globals())
try:
    import utilidades
except ImportError:
    print('sin módulo')`)
    expect(result.stdout).toBe('False False False\nsin módulo\n')
  }, 60_000)

  it('las pruebas corren funciones del programa y los archivos se verifican', async () => {
    const { checks } = await run(
      `
import json
def porcentaje(usado, total):
    return round(usado * 100 / total, 1)
with open('estado.json', 'w') as f:
    json.dump({'disco': porcentaje(91, 100)}, f)`,
      [
        { prueba: 'assert porcentaje(1, 4) == 25.0', mensaje: 'porcentaje calcula bien' },
        { prueba: 'assert porcentaje(1, 3) == 33.4', mensaje: 'redondeo' },
        { archivo: 'estado.json', existe: true, contenido_incluye: '"disco": 91' },
        { usa: 'with open', mensaje: 'abre el archivo con with' },
      ],
    )
    expect(checks.map((c) => c.ok)).toEqual([true, false, true, true])
  }, 60_000)

  it('revisa las soluciones de un ejercicio y avisa si el código inicial ya pasa', async () => {
    const ex = pythonExerciseSchema.parse({
      tipo: 'python',
      titulo: 't',
      codigo_inicial: 'print("hola")',
      pasos: [
        { consigna: 'a', solucion: 'print("hola")', verificar: [{ salida_contiene: 'hola' }] },
        { consigna: 'b', solucion: 'print("chau")', verificar: [{ salida_contiene: 'hola' }] },
      ],
    })
    const problems = await checkPythonExercise(ex)
    expect(problems.map((p) => p.level)).toEqual(['error', 'warning'])
    expect(problems[0].message).toContain('paso 2')
  }, 60_000)
})
