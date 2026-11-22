/**
 * Lo común para correr ejercicios de Python con Pyodide, en el navegador (en un worker) o en
 * Node (para revisar las soluciones): preparar el entorno (archivos de ejemplo, un requests
 * simulado que responde lo que define el ejercicio, y un subprocess.run simulado para los
 * comandos), correr el código capturando la salida, y evaluar las verificaciones.
 */
import type { PythonCheck, PythonExercise } from '@/content/exercise-schemas'

/** Lo que usamos de Pyodide (así este archivo no depende de cómo se cargó). */
export interface PyLike {
  runPythonAsync(code: string, opts?: { globals?: unknown; filename?: string }): Promise<unknown>
  runPython(code: string, opts?: { globals?: unknown }): unknown
  setStdout(o: { batched?: (s: string) => void; write?: (b: Uint8Array) => number }): void
  setStderr(o: { batched?: (s: string) => void; write?: (b: Uint8Array) => number }): void
  setStdin(o: { stdin?: () => string | null | undefined; error?: boolean }): void
  globals: { get(name: string): unknown }
  FS: {
    writeFile(path: string, data: string): void
    mkdirTree(path: string): void
    analyzePath(path: string): { exists: boolean }
    readFile(path: string, opts: { encoding: 'utf8' }): string
    unlink(path: string): void
    readdir(path: string): string[]
    rmdir(path: string): void
    stat(path: string): { mode: number }
    isDir(mode: number): boolean
    chdir(path: string): void
  }
}

export type Setup = Pick<PythonExercise, 'archivos' | 'api' | 'comandos' | 'argumentos' | 'directorio' | 'entorno'>

const SIM_DIR = '/opt/sim'

/** requests simulado: responde lo que dice /opt/sim/api.json; lo demás, "no se pudo conectar". */
const REQUESTS_PY = `"""requests (simulado por la plataforma): responde con datos de ejemplo del ejercicio."""
import json as _json
from urllib.parse import urlsplit as _split, urlencode as _urlencode

class RequestException(Exception):
    pass
class HTTPError(RequestException):
    def __init__(self, msg, response=None):
        super().__init__(msg)
        self.response = response
class ConnectionError(RequestException):
    pass
class Timeout(RequestException):
    pass
class ConnectTimeout(ConnectionError, Timeout):
    pass
class JSONDecodeError(RequestException, ValueError):
    pass

class _Exceptions:
    RequestException = RequestException
    HTTPError = HTTPError
    ConnectionError = ConnectionError
    Timeout = Timeout
    ConnectTimeout = ConnectTimeout
    JSONDecodeError = JSONDecodeError
exceptions = _Exceptions()

_REASONS = {200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable'}

class Response:
    def __init__(self, url, status, text, headers=None):
        self.url = url
        self.status_code = status
        self.text = text
        self.content = text.encode()
        self.headers = headers or {}
        self.reason = _REASONS.get(status, '')
        self.ok = status < 400
    def json(self):
        try:
            return _json.loads(self.text)
        except ValueError as e:
            raise JSONDecodeError(str(e))
    def raise_for_status(self):
        if self.status_code >= 400:
            kind = 'Client' if self.status_code < 500 else 'Server'
            raise HTTPError(f"{self.status_code} {kind} Error: {self.reason} for url: {self.url}", response=self)
    def __repr__(self):
        return f"<Response [{self.status_code}]>"

def _load():
    try:
        with open('${SIM_DIR}/api.json') as f:
            return _json.load(f)
    except OSError:
        return {}

def request(method, url, params=None, json=None, data=None, headers=None, timeout=None, auth=None, **kwargs):
    method = method.upper()
    full = url + ('?' + _urlencode(params) if params else '')
    api = _load()
    base = url.split('?')[0]
    spec = api.get(f"{method} {full}") or api.get(f"{method} {base}") or (api.get(full) or api.get(base) if method == 'GET' else None)
    if spec is None:
        host = _split(url).hostname or url
        raise ConnectionError(f"HTTPSConnectionPool(host='{host}', port=443): Max retries exceeded with url: {_split(url).path or '/'} (Caused by NameResolutionError: Failed to resolve '{host}')")
    if spec.get('token'):
        dado = {k.lower(): v for k, v in (headers or {}).items()}.get('authorization', '')
        if dado != f"Bearer {spec['token']}":
            return Response(full, 401, _json.dumps({'error': 'token inválido o ausente'}), {'Content-Type': 'application/json'})
    if spec.get('demora') and timeout is not None and timeout < spec['demora']:
        host = _split(url).hostname or url
        raise Timeout(f"HTTPSConnectionPool(host='{host}', port=443): Read timed out. (read timeout={timeout})")
    if 'json' in spec:
        text = _json.dumps(spec['json'])
        hdr = {'Content-Type': 'application/json'}
    else:
        text = spec.get('texto', '')
        hdr = {'Content-Type': 'text/plain'}
    return Response(full, spec.get('estado', 200), text, hdr)

def get(url, **kw): return request('GET', url, **kw)
def post(url, **kw): return request('POST', url, **kw)
def put(url, **kw): return request('PUT', url, **kw)
def patch(url, **kw): return request('PATCH', url, **kw)
def delete(url, **kw): return request('DELETE', url, **kw)

class Session:
    def __init__(self):
        self.headers = {}
    def request(self, method, url, **kw):
        h = dict(self.headers); h.update(kw.pop('headers', None) or {})
        return request(method, url, headers=h, **kw)
    def get(self, url, **kw): return self.request('GET', url, **kw)
    def post(self, url, **kw): return self.request('POST', url, **kw)
    def __enter__(self): return self
    def __exit__(self, *a): pass
`

/** Ayudante del lado de Python: prepara subprocess y sys.argv, y corre el código atrapando sys.exit y los errores. */
const SIMRUN_PY = `"""Ayudante de la plataforma para correr los programas del estudiante."""
import sys, os, json, shlex, subprocess, traceback, linecache

_REAL_RUN = subprocess.run

def _load_cmds():
    try:
        with open('${SIM_DIR}/comandos.json') as f:
            return json.load(f)
    except OSError:
        return {}

def _sim_run(args, *a, capture_output=False, text=False, check=False, shell=False, stdout=None, stderr=None, timeout=None, **kw):
    cmds = _load_cmds()
    quoted = args if isinstance(args, str) else ' '.join(shlex.quote(str(x)) for x in args)
    plain = args if isinstance(args, str) else ' '.join(str(x) for x in args)
    spec = cmds.get(plain) or cmds.get(quoted)
    if spec is None:
        prog = (plain.split() or [''])[0]
        raise FileNotFoundError(2, 'No such file or directory', prog)
    out, err, code = spec.get('salida', ''), spec.get('error', ''), spec.get('codigo', 0)
    as_text = text or kw.get('universal_newlines') or kw.get('encoding')
    want_out = capture_output or stdout is subprocess.PIPE
    want_err = capture_output or stderr is subprocess.PIPE or stderr is subprocess.STDOUT
    if stderr is subprocess.STDOUT:
        out, err = out + err, ''
    if not want_out and out:
        print(out, end='')
    if not want_err and err:
        print(err, end='', file=sys.stderr)
    r_out = (out if as_text else out.encode()) if want_out else None
    r_err = (err if as_text else err.encode()) if want_err and stderr is not subprocess.STDOUT else None
    r = subprocess.CompletedProcess(args, code, r_out, r_err)
    if check and code != 0:
        raise subprocess.CalledProcessError(code, args, r.stdout, r.stderr)
    return r

def _sim_check_output(args, *a, text=False, **kw):
    kw.pop('capture_output', None)
    return _sim_run(args, capture_output=True, text=text, check=True, **kw).stdout

subprocess.run = _sim_run
subprocess.check_output = _sim_check_output

def _forget_modules():
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, '__file__', None) or ''
        if name == 'requests' or (f and not f.startswith('/lib/')):
            if name != __name__:
                del sys.modules[name]

if not hasattr(sys, '_sim_env_base'):
    sys._sim_env_base = dict(os.environ)
_ENV_BASE = sys._sim_env_base

def _reset_env():
    os.environ.clear()
    os.environ.update(_ENV_BASE)
    try:
        with open('${SIM_DIR}/entorno.json') as f:
            os.environ.update(json.load(f))
    except OSError:
        pass

def run(src, filename, ns, argv, cwd, fresh=True):
    """Corre src en ns. Devuelve JSON: error (traceback o null) y código de salida."""
    _forget_modules()
    if fresh:
        _reset_env()
    sys.argv = [filename] + list(argv)
    os.chdir(cwd)
    if sys.path[0] != cwd:
        sys.path[:] = [cwd, '${SIM_DIR}'] + [p for p in sys.path if p not in ('', cwd, '${SIM_DIR}')]
    code, error = 0, None
    linecache.cache[filename] = (len(src), None, [l + '\\n' for l in src.split('\\n')], filename)
    try:
        exec(compile(src, filename, 'exec'), ns)
    except SystemExit as e:
        if e.code is None:
            code = 0
        elif isinstance(e.code, int):
            code = e.code
        else:
            print(e.code, file=sys.stderr)
            code = 1
    except BaseException as e:
        tb = e.__traceback__.tb_next if e.__traceback__ is not None else None
        te = traceback.TracebackException(type(e), e, tb)
        te.stack = traceback.StackSummary.from_list([f for f in te.stack if not f.filename.startswith('${SIM_DIR}')])
        error = ''.join(te.format()).rstrip()
        code = 1
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
    return json.dumps({'error': error, 'codigo': code})
`

function writeTree(py: PyLike, path: string, data: string) {
  const dir = path.slice(0, path.lastIndexOf('/')) || '/'
  py.FS.mkdirTree(dir)
  py.FS.writeFile(path, data)
}

function removeTree(py: PyLike, path: string) {
  if (!py.FS.analyzePath(path).exists) return
  const st = py.FS.stat(path)
  if (py.FS.isDir(st.mode)) {
    for (const n of py.FS.readdir(path)) if (n !== '.' && n !== '..') removeTree(py, `${path}/${n}`)
    py.FS.rmdir(path)
  } else py.FS.unlink(path)
}

/** Lo que es de Pyodide y no se toca entre corridas. */
const SYSTEM = new Set(['lib', 'dev', 'proc', 'home', 'tmp'])

/** Una ruta del ejercicio: absoluta, o relativa a la carpeta de trabajo. */
export function absPath(setup: Pick<Setup, 'directorio'>, p: string) {
  return p.startsWith('/') ? p : `${setup.directorio.replace(/\/$/, '')}/${p}`
}

/** Deja el entorno como al principio del ejercicio: borra lo que dejó la corrida anterior y escribe los archivos de ejemplo. */
export function prepare(py: PyLike, setup: Setup) {
  py.FS.chdir('/')
  for (const n of py.FS.readdir('/')) if (n !== '.' && n !== '..' && !SYSTEM.has(n)) removeTree(py, `/${n}`)
  for (const d of ['/tmp', '/home']) for (const n of py.FS.readdir(d)) if (n !== '.' && n !== '..' && n !== 'web_user' && n !== 'pyodide') removeTree(py, `${d}/${n}`)
  for (const n of py.FS.readdir('/home/pyodide')) if (n !== '.' && n !== '..') removeTree(py, `/home/pyodide/${n}`)
  py.FS.mkdirTree(setup.directorio)
  for (const [p, data] of Object.entries(setup.archivos)) writeTree(py, absPath(setup, p), data)
  py.FS.mkdirTree(SIM_DIR)
  py.FS.writeFile(`${SIM_DIR}/requests.py`, REQUESTS_PY)
  py.FS.writeFile(`${SIM_DIR}/_simrun.py`, SIMRUN_PY)
  py.FS.writeFile(`${SIM_DIR}/api.json`, JSON.stringify(setup.api))
  py.FS.writeFile(`${SIM_DIR}/comandos.json`, JSON.stringify(setup.comandos))
  py.FS.writeFile(`${SIM_DIR}/entorno.json`, JSON.stringify(setup.entorno ?? {}))
}

export interface RunResult {
  stdout: string
  stderr: string
  /** Traceback de Python, si el programa terminó con una excepción. */
  error?: string
  /** Código de salida (0, el de sys.exit, o 1 si hubo una excepción). */
  codigo: number
}

interface PyDict {
  set(k: string, v: unknown): void
  get(k: string): unknown
  destroy?(): void
}

/** Corre código en un espacio de nombres a través del ayudante (atrapa sys.exit y los errores). */
async function execIn(py: PyLike, setup: Setup, ns: PyDict, code: string, filename: string, fresh = true): Promise<{ error?: string; codigo: number }> {
  const dict = py.globals.get('dict') as () => PyDict
  const h = dict()
  h.set('src', code)
  h.set('ns', ns)
  h.set('fn', filename)
  h.set('argv', JSON.stringify(setup.argumentos))
  h.set('cwd', setup.directorio)
  h.set('fresh', fresh)
  await py.runPythonAsync(`import sys, json\nif '${SIM_DIR}' not in sys.path: sys.path.insert(0, '${SIM_DIR}')\nimport _simrun\nres = _simrun.run(src, fn, ns, json.loads(argv), cwd, fresh)`, { globals: h })
  const res = JSON.parse(String(h.get('res'))) as { error: string | null; codigo: number }
  h.destroy?.()
  return { error: res.error ?? undefined, codigo: res.codigo }
}

/** Corre un programa en un espacio de nombres nuevo; devuelve la salida y ese espacio (para las verificaciones). */
export async function runProgram(py: PyLike, setup: Setup, code: string, onOutput?: (stream: 'out' | 'err', text: string) => void): Promise<{ result: RunResult; ns: unknown }> {
  prepare(py, setup)
  // El ayudante se vuelve a cargar en cada corrida (por si el estudiante pisó subprocess).
  await py.runPythonAsync(`import sys\nsys.modules.pop('_simrun', None)`)
  let stdout = ''
  let stderr = ''
  py.setStdout({
    batched: (s) => {
      stdout += s + '\n'
      onOutput?.('out', s + '\n')
    },
  })
  py.setStderr({
    batched: (s) => {
      stderr += s + '\n'
      onOutput?.('err', s + '\n')
    },
  })
  py.setStdin({ stdin: () => null })
  const dict = py.globals.get('dict') as () => PyDict
  const ns = dict()
  ns.set('__name__', '__main__')
  let r: { error?: string; codigo: number }
  try {
    r = await execIn(py, setup, ns, code, 'programa.py')
  } catch (e) {
    r = { error: String((e as Error).message ?? e), codigo: 1 }
  }
  return { result: { stdout, stderr, error: r.error, codigo: r.codigo }, ns }
}

export interface CheckResult {
  ok: boolean
  label: string
  detalle?: string
}

/** Lo que pide una verificación, en palabras (se muestra antes de correr el programa). */
export function checkLabel(c: PythonCheck): string {
  if ('salida_contiene' in c) return `La salida muestra “${c.salida_contiene}”`
  if ('salida_no_contiene' in c) return `La salida no muestra “${c.salida_no_contiene}”`
  if ('error_contiene' in c) return `Los mensajes de error (stderr) muestran “${c.error_contiene}”`
  if ('codigo_salida' in c) return `El programa termina con código ${c.codigo_salida}`
  if ('sin_error' in c) return 'El programa termina sin errores'
  if ('usa' in c) return c.mensaje ?? `El código usa ${c.usa}`
  if ('archivo' in c) return c.existe ? `Existe ${c.archivo}${c.contenido_incluye ? ` con “${c.contenido_incluye}”` : ''}` : `No existe ${c.archivo}`
  return c.mensaje
}

/** Evalúa las verificaciones de un paso sobre lo que dejó el programa. */
export async function runChecks(py: PyLike, setup: Setup, ns: unknown, result: RunResult, code: string, checks: PythonCheck[]): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  const last = (e?: string) => e?.trim().split('\n').pop()
  for (const c of checks) {
    const label = checkLabel(c)
    if ('salida_contiene' in c) out.push({ ok: result.stdout.includes(c.salida_contiene), label })
    else if ('salida_no_contiene' in c) out.push({ ok: !result.stdout.includes(c.salida_no_contiene), label })
    else if ('error_contiene' in c) out.push({ ok: result.stderr.includes(c.error_contiene), label })
    else if ('codigo_salida' in c) out.push({ ok: result.codigo === c.codigo_salida && !result.error, label, detalle: result.error ? last(result.error) : result.codigo !== c.codigo_salida ? `terminó con código ${result.codigo}` : undefined })
    else if ('sin_error' in c) out.push({ ok: !result.error && result.codigo === 0, label, detalle: last(result.error) ?? (result.codigo ? `terminó con código ${result.codigo}` : undefined) })
    else if ('usa' in c) out.push({ ok: code.includes(c.usa), label })
    else if ('archivo' in c) {
      const path = absPath(setup, c.archivo)
      const exists = py.FS.analyzePath(path).exists
      let ok = exists === c.existe
      if (ok && exists && c.contenido_incluye) ok = py.FS.readFile(path, { encoding: 'utf8' }).includes(c.contenido_incluye)
      out.push({ ok, label })
    } else {
      let ok = !result.error
      let detalle: string | undefined
      if (ok) {
        py.setStdout({ batched: () => {} })
        py.setStderr({ batched: () => {} })
        const r = await execIn(py, setup, ns as PyDict, c.prueba, 'prueba.py', false)
        if (r.error || r.codigo) {
          ok = false
          const l = last(r.error) ?? ''
          detalle = /^AssertionError\s*$/.test(l) ? undefined : l || undefined
        }
      }
      out.push({ ok, label, detalle })
    }
  }
  return out
}
