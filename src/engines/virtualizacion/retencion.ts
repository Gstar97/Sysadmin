/**
 * Políticas de retención como las de restic forget (y las de Proxmox Backup Server, que siguen
 * la misma lógica): de cada período (hora, día, semana, mes, año) se queda la copia más nueva,
 * empezando por el período actual, hasta completar la cantidad pedida.
 */
export interface KeepPolicy {
  last?: number
  hourly?: number
  daily?: number
  weekly?: number
  monthly?: number
  yearly?: number
  withinDays?: number
}

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const y = t.getUTCFullYear()
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7)
  return `${y}-${w}`
}

/** Qué instantáneas se quedan (por índice, ordenadas de la más nueva a la más vieja) y por qué. */
export function applyPolicy(times: number[], p: KeepPolicy, now = Date.now()): { keep: boolean; reasons: string[] }[] {
  const res = times.map(() => ({ keep: false, reasons: [] as string[] }))
  const rules: [keyof KeepPolicy, string, (d: Date) => string][] = [
    ['last', 'last snapshot', (d) => String(d.getTime())],
    ['hourly', 'hourly snapshot', (d) => `${d.toDateString()} ${d.getHours()}`],
    ['daily', 'daily snapshot', (d) => d.toDateString()],
    ['weekly', 'weekly snapshot', isoWeek],
    ['monthly', 'monthly snapshot', (d) => `${d.getFullYear()}-${d.getMonth()}`],
    ['yearly', 'yearly snapshot', (d) => String(d.getFullYear())],
  ]
  for (const [k, label, key] of rules) {
    let left = p[k] ?? 0
    let lastKey: string | undefined
    for (let i = 0; i < times.length && left !== 0; i++) {
      const kk = key(new Date(times[i]))
      if (kk !== lastKey) {
        res[i].keep = true
        res[i].reasons.push(label)
        lastKey = kk
        if (left > 0) left--
      }
    }
  }
  if (p.withinDays) times.forEach((t, i) => {
    if (now - t <= p.withinDays! * 86_400_000) {
      res[i].keep = true
      res[i].reasons.push(`within ${p.withinDays}d`)
    }
  })
  return res
}


export interface Simulacion {
  copias: { t: number; keep: boolean; reasons: string[] }[]
  guardadas: number
  /** Días hacia atrás de la copia más vieja que queda. */
  masVieja: number
  /** Espacio aproximado (GB) con deduplicación: la primera copia entera y lo que cambia en cada una. */
  espacioGb: number
}

/** Simula copias cada tantas horas durante unos días y aplica la política. */
export function simular(o: { frecuenciaHoras: number; dias: number; politica: KeepPolicy; tamanoGb: number; cambioDiarioPct: number; ahora?: number }): Simulacion {
  const ahora = o.ahora ?? Date.now()
  const paso = o.frecuenciaHoras * 3_600_000
  const n = Math.floor((o.dias * 86_400_000) / paso)
  const times = Array.from({ length: n }, (_v, i) => ahora - i * paso)
  const r = applyPolicy(times, o.politica, ahora)
  const copias = times.map((t, i) => ({ t, keep: r[i].keep, reasons: r[i].reasons }))
  const keep = copias.filter((c) => c.keep)
  const masVieja = keep.length ? Math.round((ahora - keep[keep.length - 1].t) / 86_400_000) : 0
  // Lo que cambió entre una copia guardada y la siguiente (con un tope: no puede cambiar más que todo).
  let espacio = keep.length ? o.tamanoGb : 0
  for (let i = 1; i < keep.length; i++) {
    const dias = (keep[i - 1].t - keep[i].t) / 86_400_000
    // Si cada día cambia al azar una parte de los datos, en d días cambió 1 - (1 - p)^d.
    espacio += o.tamanoGb * (1 - Math.pow(1 - o.cambioDiarioPct / 100, Math.max(dias, o.frecuenciaHoras / 24)))
  }
  return { copias, guardadas: keep.length, masVieja, espacioGb: Math.round(espacio * 10) / 10 }
}

/** La copia guardada más nueva que es anterior a un daño de hace tantos días. */
export function copiaAnterior(sim: Simulacion, diasAtras: number, ahora = Date.now()): { dias: number } | undefined {
  const limite = ahora - diasAtras * 86_400_000
  const c = sim.copias.find((x) => x.keep && x.t <= limite)
  return c ? { dias: Math.round(((ahora - c.t) / 86_400_000) * 10) / 10 } : undefined
}
