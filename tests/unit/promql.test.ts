import { describe, expect, it } from 'vitest'
import { instantQuery, parse, PromQLError, rangeQuery, fmt, type Value } from '@/engines/metrics/promql'
import { buildTsdb, parseDuration } from '@/engines/metrics/tsdb'
import { runPromql } from '@/engines/metrics/exercise'
import { evaluateQueryChecks } from '@/engines/query/checks'

// Un contador que sube exactamente 2 por segundo, otro que sube 1 por segundo y se reinicia, y un
// gauge que baja en línea recta: con eso los resultados se pueden calcular a mano.
const db = buildTsdb({
  ventana: '2h',
  paso: '15s',
  series: [
    { nombre: 'pedidos_total', tipo: 'contador', valor: 2, etiquetas: { job: 'api', instance: ['a:1', 'b:1'] } },
    { nombre: 'reinicios_total', tipo: 'contador', valor: 1, etiquetas: { job: 'api', instance: 'a:1' }, reinicios: ['-3m'] },
    { nombre: 'libre_bytes', valor: { lineal: { desde: 7200, hasta: 0 } }, etiquetas: { instance: 'a:1', job: 'node' } },
    { nombre: 'capacidad_bytes', valor: 10000, etiquetas: { instance: 'a:1', job: 'node' } },
    { nombre: 'viejo', valor: 1, etiquetas: { job: 'x' }, sin_datos: [{ desde: '-10m' }] },
  ],
})

const vec = (v: Value) => {
  if (v.type !== 'vector') throw new Error(`no es un vector: ${v.type}`)
  return v.v
}
const one = (q: string) => {
  const v = vec(instantQuery(db, q).value)
  expect(v).toHaveLength(1)
  return v[0].v
}

describe('PromQL', () => {
  it('duraciones y formato de números como Prometheus', () => {
    expect(parseDuration('1h30m')).toBe(5400)
    expect(parseDuration('5x')).toBeUndefined()
    expect(fmt(1e21)).toBe('1000000000000000000000')
    expect(fmt(0.0000015)).toBe('0.0000015')
    expect(fmt(NaN)).toBe('NaN')
  })

  it('rate, increase e irate sobre un contador exacto', () => {
    expect(one('rate(pedidos_total{instance="a:1"}[5m])')).toBeCloseTo(2, 6)
    expect(one('increase(pedidos_total{instance="a:1"}[10m])')).toBeCloseTo(1200, 3)
    expect(one('irate(pedidos_total{instance="a:1"}[1m])')).toBeCloseTo(2, 6)
    // El reinicio de hace 3 minutos no cuenta como una caída del contador.
    expect(one('rate(reinicios_total[10m])')).toBeGreaterThan(0.9)
    expect(one('resets(reinicios_total[10m])')).toBe(1)
  })

  it('agregaciones, by y without, topk y count', () => {
    expect(one('sum(rate(pedidos_total[5m]))')).toBeCloseTo(4, 6)
    const by = vec(instantQuery(db, 'sum by (instance) (rate(pedidos_total[5m]))').value)
    expect(by.map((s) => s.labels)).toEqual([{ instance: 'a:1' }, { instance: 'b:1' }])
    const without = vec(instantQuery(db, 'sum without (instance) (pedidos_total)').value)
    expect(without[0].labels).toEqual({ job: 'api' })
    expect(vec(instantQuery(db, 'topk(1, pedidos_total)').value)[0].labels.__name__).toBe('pedidos_total')
    expect(one('count(pedidos_total)')).toBe(2)
  })

  it('operaciones entre vectores con on y group_left, comparaciones y bool', () => {
    expect(one('libre_bytes / capacidad_bytes')).toBeCloseTo(0, 2)
    expect(vec(instantQuery(db, 'pedidos_total > 1e12').value)).toHaveLength(0)
    expect(vec(instantQuery(db, 'pedidos_total > bool 1e12').value).map((s) => s.v)).toEqual([0, 0])
    const filtered = vec(instantQuery(db, 'pedidos_total > 0').value)
    expect(filtered[0].labels.__name__).toBe('pedidos_total')
    const g = vec(instantQuery(db, 'pedidos_total / on(instance) group_left capacidad_bytes').value)
    expect(g).toHaveLength(1)
    expect(g[0].labels).toEqual({ instance: 'a:1', job: 'api' })
    expect(() => instantQuery(db, 'pedidos_total / on(job) pedidos_total')).toThrow(/many-to-many matching not allowed/)
  })

  it('predict_linear, deriv, offset, subconsultas y *_over_time', () => {
    // libre_bytes baja 1 por segundo: en una hora más, -3600.
    expect(one('predict_linear(libre_bytes[30m], 3600)')).toBeCloseTo(-3600, 0)
    expect(one('deriv(libre_bytes[10m])')).toBeCloseTo(-1, 6)
    expect(one('libre_bytes offset 1h')).toBeCloseTo(3600, 0)
    // El rango es abierto a la izquierda (Prometheus 3): la muestra de hace justo 1h no entra.
    expect(one('max_over_time(libre_bytes[1h])')).toBeCloseTo(3585, 0)
    expect(one('max_over_time(rate(pedidos_total{instance="b:1"}[5m])[30m:1m])')).toBeCloseTo(2, 6)
    expect(one('count_over_time(capacidad_bytes[1m])')).toBe(4)
  })

  it('series sin datos recientes, absent y escalares', () => {
    expect(vec(instantQuery(db, 'viejo').value)).toHaveLength(0)
    expect(one('absent(viejo{job="x"})')).toBe(1)
    expect(vec(instantQuery(db, 'absent(viejo{job="x"})').value)[0].labels).toEqual({ job: 'x' })
    const t = instantQuery(db, 'time()').value
    expect(t).toEqual({ type: 'scalar', v: db.end })
    expect(instantQuery(db, '2 > bool 1').value).toEqual({ type: 'scalar', v: 1 })
  })

  it('histogram_quantile con buckets', () => {
    const h = buildTsdb({ http: [{ instancia: 'api:8080', rps: 100, latencia_ms: 100 }] })
    const v = vec(instantQuery(h, 'histogram_quantile(0.5, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))').value)
    expect(v[0].v).toBeGreaterThan(0.05)
    expect(v[0].v).toBeLessThan(0.2)
  })

  it('errores con el texto de Prometheus', () => {
    const msg = (q: string) => {
      try {
        parse(q)
      } catch (e) {
        expect(e).toBeInstanceOf(PromQLError)
        return (e as Error).message
      }
      return ''
    }
    expect(msg('rate(pedidos_total)')).toBe('expected type range vector in call to function "rate", got instant vector')
    expect(msg('sum(pedidos_total[5m])')).toBe('expected type instant vector in aggregation expression, got range vector')
    expect(msg('foo{a="b"')).toMatch(/^1:10: parse error: unexpected end of input/)
    expect(msg('2 > 1')).toBe('comparisons between scalars must use BOOL modifier')
    expect(msg('nofunc(up)')).toBe('1:1: parse error: unknown function with name "nofunc"')
    expect(msg('{job=""}')).toMatch(/at least one non-empty matcher/)
  })

  it('consulta por rango y verificaciones de un paso', () => {
    const r = rangeQuery(db, 'rate(pedidos_total[5m])')
    expect(r.series).toHaveLength(2)
    expect(r.series[0].samples.length).toBeGreaterThan(50)
    const o = runPromql(db, 'sum by (instance) (rate(pedidos_total[5m]))')
    const res = evaluateQueryChecks(o, [{ series: 2 }, { sin_etiqueta: 'job' }, { usa: 'rate' }, { usa: 'by' }, { valor: { min: 1.9, max: 2.1 } }, { contiene: { instance: 'b:1' } }])
    expect(res.every((x) => x.ok)).toBe(true)
    expect(evaluateQueryChecks(runPromql(db, 'rate(x)'), [{ sin_error: true }])[0].ok).toBe(false)
  })
})
