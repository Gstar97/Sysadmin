/** Lector de opciones estilo GNU: -la, -n 5, -n5, --lines=5, --all, y -- para cortar. */
export interface OptSpec {
  /** Opciones sin valor: letras cortas y nombres largos equivalentes. */
  flags?: Record<string, string[]>
  /** Opciones con valor. */
  values?: Record<string, string[]>
}

export interface ParsedArgs {
  flags: Set<string>
  values: Map<string, string>
  rest: string[]
  unknown?: string
}

export function parseArgs(args: string[], spec: OptSpec): ParsedArgs {
  const flags = new Set<string>()
  const values = new Map<string, string>()
  const rest: string[] = []
  const flagByShort = new Map<string, string>()
  const flagByLong = new Map<string, string>()
  const valueByShort = new Map<string, string>()
  const valueByLong = new Map<string, string>()
  for (const [key, names] of Object.entries(spec.flags ?? {})) {
    for (const n of names) (n.length === 1 ? flagByShort : flagByLong).set(n, key)
  }
  for (const [key, names] of Object.entries(spec.values ?? {})) {
    for (const n of names) (n.length === 1 ? valueByShort : valueByLong).set(n, key)
  }
  let unknown: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      rest.push(...args.slice(i + 1))
      break
    }
    if (a.startsWith('--') && a.length > 2) {
      const [name, inline] = a.slice(2).split(/=(.*)/s, 2)
      if (flagByLong.has(name)) flags.add(flagByLong.get(name)!)
      else if (valueByLong.has(name)) {
        const v = inline ?? args[++i]
        if (v !== undefined) values.set(valueByLong.get(name)!, v)
      } else unknown ??= a
      continue
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d+$/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j]
        if (flagByShort.has(ch)) flags.add(flagByShort.get(ch)!)
        else if (valueByShort.has(ch)) {
          const v = a.slice(j + 1) || args[++i]
          if (v !== undefined) values.set(valueByShort.get(ch)!, v)
          break
        } else {
          unknown ??= `-${ch}`
        }
      }
      continue
    }
    rest.push(a)
  }
  return { flags, values, rest, unknown }
}
