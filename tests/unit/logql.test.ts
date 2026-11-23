import { describe, expect, it } from 'vitest'
import { buildLogDb } from '@/engines/logs/logdb'
import { evalMetric, LogQLError, parseGoDuration, parseBytes, parseLogQL, queryLogs, type VSample } from '@/engines/logs/logql'
import { runLogql } from '@/engines/logs/exercise'
import { evaluateQueryChecks } from '@/engines/query/checks'

// Líneas fijas: así cada resultado se puede contar a mano.
const db = buildLogDb({
  ventana: '1h',
  streams: [
    {
      etiquetas: { job: 'app', host: 'web01' },
      fijas: [
        { en: '-50m', linea: '{"level":"info","path":"/a","status":200,"ms":120}' },
        { en: '-40m', linea: '{"level":"error","path":"/b","status":500,"ms":900}' },
        { en: '-4m', linea: '{"level":"error","path":"/b","status":503,"ms":1500}' },
        { en: '-3m', linea: '{"level":"info","path":"/a","status":200,"ms":80}' },
        { en: '-2m', linea: 'texto que no es json' },
      ],
    },
    {
      etiquetas: { job: 'cron', host: 'db01' },
      fijas: [
        { en: '-30m', linea: 'level=info msg="backup ok" duration=45s size=1.2GB' },
        { en: '-1m', linea: 'level=error msg="backup failed" duration=2s size=0B' },
      ],
    },
    {
      etiquetas: { job: 'nginx', host: 'web01' },
      fijas: [
        { en: '-2m', linea: '10.0.0.1 - - [23/Nov/2026:13:58:00 +0000] "GET /api HTTP/1.1" 502 157' },
        { en: '-1m', linea: '10.0.0.2 - - [23/Nov/2026:13:59:00 +0000] "POST /login HTTP/1.1" 200 512' },
      ],
    },
  ],
})

const logs = (q: string) => {
  const p = parseLogQL(q)
  if (p.k !== 'log') throw new Error('no es una consulta de logs')
  return queryLogs(db, p.expr).lines
}
const metric = (q: string) => {
  const p = parseLogQL(q)
  if (p.k !== 'metric') throw new Error('no es una métrica')
  return evalMetric(db, p.expr, db.end) as VSample[]
}

describe('LogQL', () => {
  it('conversiones de duraciones y tamaños como Loki', () => {
    expect(parseGoDuration('1m30s')).toBe(90)
    expect(parseGoDuration('250ms')).toBe(0.25)
    expect(parseBytes('1.2GB')).toBe(1.2e9)
    expect(parseBytes('1KiB')).toBe(1024)
  })

  it('selector, filtros de línea y orden de más nueva a más vieja', () => {
    expect(logs('{job="app"}')).toHaveLength(5)
    expect(logs('{job="app"} |= "error"').map((l) => l.line)).toEqual(['{"level":"error","path":"/b","status":503,"ms":1500}', '{"level":"error","path":"/b","status":500,"ms":900}'])
    expect(logs('{job="app"} != "json" |~ "status\\":5\\\\d\\\\d"')).toHaveLength(2)
    expect(logs('{host=~"web.*"} |= "502" or "503"')).toHaveLength(2)
  })

  it('json, logfmt, pattern y regexp crean etiquetas; los filtros las usan', () => {
    const j = logs('{job="app"} | json | status >= 500')
    expect(j).toHaveLength(2)
    expect(j[0].labels).toMatchObject({ level: 'error', path: '/b', status: '503' })
    expect(logs('{job="cron"} | logfmt | duration > 10s').map((l) => l.labels.msg)).toEqual(['backup ok'])
    expect(logs('{job="cron"} | logfmt | size > 1GB')).toHaveLength(1)
    const p = logs('{job="nginx"} | pattern "<ip> - - [<_>] \\"<method> <path> <_>\\" <status> <size>" | status="502"')
    expect(p).toHaveLength(1)
    expect(p[0].labels).toMatchObject({ ip: '10.0.0.1', method: 'GET', path: '/api', size: '157' })
    expect(logs('{job="nginx"} | regexp "\\"(?P<metodo>\\\\w+) " | metodo="POST"')).toHaveLength(1)
  })

  it('line_format, label_format, drop y los errores de parseo', () => {
    expect(logs('{job="app"} | json | level="error" | line_format "{{.path}} {{ .status }}"').map((l) => l.line)).toEqual(['/b 503', '/b 500'])
    expect(logs('{job="app"} | json | label_format ruta=path | drop ms')[1].labels).not.toHaveProperty('ms')
    const bad = logs('{job="app"} | json | __error__!=""')
    expect(bad).toHaveLength(1)
    expect(bad[0].labels.__error__).toBe('JSONParserErr')
  })

  it('métricas: count_over_time, rate, unwrap y agregaciones', () => {
    expect(metric('count_over_time({job="app"} |= "error" [5m])')[0].v).toBe(1)
    expect(metric('sum(count_over_time({job=~"app|cron"} [1h]))')[0].v).toBe(7)
    expect(metric('sum by (host) (rate({host=~".+"} [5m]))').map((s) => [s.labels.host, +s.v.toFixed(4)])).toEqual([
      ['web01', +(5 / 300).toFixed(4)],
      ['db01', +(1 / 300).toFixed(4)],
    ])
    const q = metric('max_over_time({job="app"} | json | __error__="" | unwrap ms [1h]) by (path)')
    expect(Object.fromEntries(q.map((s) => [s.labels.path, s.v]))).toEqual({ '/a': 120, '/b': 1500 })
    expect(metric('sum(count_over_time({job="app"} | json | __error__="" | status >= 500 [1h])) > 1')).toHaveLength(1)
  })

  it('errores con el texto de Loki', () => {
    const msg = (q: string) => {
      try {
        const p = parseLogQL(q)
        if (p.k === 'metric') evalMetric(db, p.expr, db.end)
      } catch (e) {
        expect(e).toBeInstanceOf(LogQLError)
        return (e as Error).message
      }
      return ''
    }
    expect(msg('{job=~".*"}')).toMatch(/at least one regexp or equality matcher that does not have an empty-compatible value/)
    expect(msg('count_over_time({job="app"})')).toBe('parse error at line 1, col 28: syntax error: unexpected ), expecting |= or != or |~ or !~ or | or [')
    expect(msg('{job="app"} |= error')).toMatch(/unexpected IDENTIFIER, expecting STRING/)
    expect(msg('count_over_time({job="app"} | json [1h])')).toMatch(/^pipeline error: 'JSONParserErr'/)
    expect(msg('sum_over_time({job="app"} [1h])')).toBe('invalid aggregation sum_over_time without unwrap')
  })

  it('verificaciones de un paso sobre líneas y métricas', () => {
    const o = runLogql(db, '{job="app"} | json | level="error" | line_format "{{.path}}"')
    expect(o.kind).toBe('lineas')
    expect(evaluateQueryChecks(o, [{ lineas: 2 }, { lineas_contienen: '/b' }, { lineas_no_contienen: '{' }, { usa: 'json' }, { usa: 'line_format' }]).every((r) => r.ok)).toBe(true)
    const m = runLogql(db, 'sum by (host) (count_over_time({host=~".+"} [1h]))')
    expect(evaluateQueryChecks(m, [{ series: 2 }, { contiene: { host: 'db01' } }, { sin_etiqueta: 'job' }, { usa: 'count_over_time' }]).every((r) => r.ok)).toBe(true)
  })
})
