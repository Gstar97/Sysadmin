/**
 * Monitor de rendimiento desde PowerShell: Get-Counter con los contadores más usados. Los valores
 * salen del estado del ejercicio (rendimiento) o de valores tranquilos por defecto.
 */
import { connect } from './remoting'
import { asArray, cmdlet, PsError, PsSession, type CmdletContext } from './session'
import { disks } from './verify-system'
import { psObject, toText, VIEWS, type PsObject } from './values'

const param = (ctx: CmdletContext, n: string) => ctx.params.get(n.toLowerCase())
const has = (ctx: CmdletContext, n: string) => ctx.params.has(n.toLowerCase())

interface Perf {
  cpu: number
  memoria_disponible_mb: number
  memoria_total_mb: number
  cola_disco: number
  red_bytes_seg: number
  cola_procesador: number
}

function perf(s: PsSession): Perf {
  const r = s.state.rendimiento
  return { cpu: r?.cpu ?? 7.4, memoria_disponible_mb: r?.memoria_disponible_mb ?? 4120, memoria_total_mb: r?.memoria_total_mb ?? 8192, cola_disco: r?.cola_disco ?? 0.02, red_bytes_seg: r?.red_bytes_seg ?? 18432, cola_procesador: r?.cola_procesador ?? 0 }
}

/** Un poco de variación entre muestras, sin perder el valor de fondo. */
function jitter(v: number, i: number, pct = 0.06) {
  const f = [0, 1, -1, 0.5, -0.5][i % 5] * pct
  return Math.max(0, v * (1 + f))
}

const COUNTERS: { re: RegExp; path: (inst: string) => string; value: (s: PsSession, i: number, inst: string) => number }[] = [
  { re: /^\\processor\((_total|\*)\)\\% processor time$/i, path: () => '\\processor(_total)\\% processor time', value: (s, i) => Math.min(100, jitter(perf(s).cpu, i, 0.15)) },
  { re: /^\\memory\\available mbytes$/i, path: () => '\\memory\\available mbytes', value: (s, i) => Math.round(jitter(perf(s).memoria_disponible_mb, i, 0.01)) },
  { re: /^\\memory\\% committed bytes in use$/i, path: () => '\\memory\\% committed bytes in use', value: (s) => ((perf(s).memoria_total_mb - perf(s).memoria_disponible_mb) / perf(s).memoria_total_mb) * 100 },
  { re: /^\\physicaldisk\((_total|\*)\)\\avg\. disk queue length$/i, path: () => '\\physicaldisk(_total)\\avg. disk queue length', value: (s, i) => jitter(perf(s).cola_disco, i, 0.2) },
  { re: /^\\system\\processor queue length$/i, path: () => '\\system\\processor queue length', value: (s) => perf(s).cola_procesador },
  { re: /^\\network interface\((\*|[^)]+)\)\\bytes total\/sec$/i, path: () => '\\network interface(microsoft hyper-v network adapter)\\bytes total/sec', value: (s, i) => jitter(perf(s).red_bytes_seg, i, 0.3) },
  {
    re: /^\\logicaldisk\(([a-z]:|_total)\)\\% free space$/i,
    path: (inst) => `\\logicaldisk(${inst.toLowerCase()})\\% free space`,
    value: (s, _i, inst) => {
      const p = disks(s).flatMap((d) => d.particiones).find((x) => x.letra && `${x.letra}:`.toLowerCase() === inst.toLowerCase()) ?? disks(s).flatMap((d) => d.particiones).find((x) => x.letra === 'C')
      return p ? ((p.tamano_gb - p.usado_gb) / p.tamano_gb) * 100 : 0
    },
  },
]

VIEWS['Microsoft.PowerShell.Commands.GetCounter.PerformanceCounterSampleSet'] = { kind: 'lines', columns: [] }
VIEWS['Microsoft.PowerShell.Commands.GetCounter.PerformanceCounterSample'] = {
  kind: 'table',
  columns: [
    { label: 'Path', value: (o) => o.Path },
    { label: 'InstanceName', value: (o) => o.InstanceName },
    { label: 'CookedValue', value: (o) => o.CookedValue, align: 'right' },
  ],
}

cmdlet('Get-Counter', {
  params: ['Counter', 'SampleInterval', 'MaxSamples', 'ComputerName', 'ListSet'],
  switches: ['Continuous'],
  positional: ['Counter'],
  synopsis: 'Gets performance counter data from local and remote computers.',
  module: 'Microsoft.PowerShell.Diagnostics',
  run(ctx) {
    let s = ctx.s
    const cn = has(ctx, 'ComputerName') ? toText(param(ctx, 'ComputerName')) : undefined
    if (cn) {
      const t = connect(ctx.s, cn)
      if (t instanceof PsError) throw new PsError(`Unable to connect to the specified computer or the computer is offline.`, 'InvalidResult', 'CounterApiError,Microsoft.PowerShell.Commands.GetCounterCommand', cn)
      s = t
    }
    if (has(ctx, 'Continuous')) ctx.host('[simulador] -Continuous no termina nunca; se muestran 3 muestras.\n')
    const counters = has(ctx, 'Counter') ? asArray(param(ctx, 'Counter')).map(toText) : ['\\network interface(*)\\bytes total/sec', '\\processor(_total)\\% processor time', '\\memory\\% committed bytes in use', '\\physicaldisk(_total)\\avg. disk queue length']
    const samples = has(ctx, 'Continuous') ? 3 : Number(param(ctx, 'MaxSamples') ?? 1)
    const interval = Number(param(ctx, 'SampleInterval') ?? 1)
    const host = s.state.equipo.toLowerCase()
    const out: PsObject[] = []
    for (let i = 0; i < samples; i++) {
      const ts = new Date(Date.now() + i * interval * 1000)
      const list: PsObject[] = []
      for (const c of counters) {
        const def = COUNTERS.find((x) => x.re.test(c))
        if (!def) throw new PsError(`The specified object was not found on the computer.\n[simulador] Contadores disponibles: \\Processor(_Total)\\% Processor Time, \\Memory\\Available MBytes, \\Memory\\% Committed Bytes In Use, \\LogicalDisk(C:)\\% Free Space, \\PhysicalDisk(_Total)\\Avg. Disk Queue Length, \\System\\Processor Queue Length, \\Network Interface(*)\\Bytes Total/sec.`, 'InvalidResult', 'CounterApiError,Microsoft.PowerShell.Commands.GetCounterCommand', c)
        const inst = /\(([^)]+)\)/.exec(c)?.[1] ?? ''
        const v = def.value(s, i, inst)
        list.push(psObject('Microsoft.PowerShell.Commands.GetCounter.PerformanceCounterSample', { Path: `\\\\${host}${def.path(inst)}`, InstanceName: inst === '*' ? 'microsoft hyper-v network adapter' : inst.toLowerCase(), CookedValue: Number(v.toFixed(Number.isInteger(v) ? 0 : 6)), Timestamp: ts }))
      }
      const rows = list.map((x) => `${toText(x.Path)} :\n${toText(x.CookedValue)}\n`).join('\n')
      const when = ts.toLocaleString('en-US').replace(',', '')
      const text = `${i === 0 ? `Timestamp                 CounterSamples\n---------                 --------------\n` : ''}${when.padEnd(26)}${rows.replace(/^/, '').replace(/\n(?=.)/g, `\n${' '.repeat(26)}`)}`
      out.push(psObject('Microsoft.PowerShell.Commands.GetCounter.PerformanceCounterSampleSet', { Timestamp: ts, CounterSamples: list, Readings: rows, __toString: text }))
    }
    return out
  },
})
