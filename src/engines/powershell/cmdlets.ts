import { asArray, ALIASES, CMDLETS, cmdlet, formatDotnetDate, psEquals, PsError, PsSession, truthy, wildcardToRegex, type CmdletContext } from './session'
import { formatDefault, formatList, formatTable, getProp, isPsObject, isScriptBlock, propNames, psObject, setProp, toText, typeName, VIEWS, type PsObject } from './values'

// ---------------------------------------------------------------------------------------
// Vistas por defecto (como las de Windows PowerShell 5.1)
// ---------------------------------------------------------------------------------------

VIEWS['System.ServiceProcess.ServiceController'] = {
  kind: 'table',
  columns: [
    { label: 'Status', value: (o) => o.Status },
    { label: 'Name', value: (o) => o.Name },
    { label: 'DisplayName', value: (o) => o.DisplayName },
  ],
}

VIEWS['System.Diagnostics.Process'] = {
  kind: 'table',
  columns: [
    { label: 'Handles', value: (o) => o.Handles, align: 'right' },
    { label: 'NPM(K)', value: (o) => o.NPM, align: 'right' },
    { label: 'PM(K)', value: (o) => Math.round(Number(o.PM) / 1024), align: 'right' },
    { label: 'WS(K)', value: (o) => Math.round(Number(o.WorkingSet) / 1024), align: 'right' },
    { label: 'CPU(s)', value: (o) => (o.CPU as number).toFixed(2), align: 'right' },
    { label: 'Id', value: (o) => o.Id, align: 'right' },
    { label: 'SI', value: (o) => o.SI, align: 'right' },
    { label: 'ProcessName', value: (o) => o.ProcessName },
  ],
}

const fileView = {
  kind: 'table' as const,
  groupBy: (o: PsObject) => `\n\n    Directory: ${o.PSParentPath}\n\n`,
  columns: [
    { label: 'Mode', value: (o: PsObject) => o.Mode },
    { label: '        LastWriteTime', value: (o: PsObject) => `${formatDotnetDate(o.LastWriteTime as Date, 'M/d/yyyy').padStart(10)} ${formatDotnetDate(o.LastWriteTime as Date, 'h:mm tt').padStart(8)}`.padStart(21) },
    { label: 'Length', value: (o: PsObject) => (o.__dir ? '' : o.Length), align: 'right' as const },
    { label: 'Name', value: (o: PsObject) => o.Name },
  ],
}
VIEWS['System.IO.FileInfo'] = fileView
VIEWS['System.IO.DirectoryInfo'] = fileView

VIEWS['Microsoft.Windows.ServerManager.Commands.Feature'] = {
  kind: 'table',
  columns: [
    { label: 'Display Name', value: (o) => `${o.Installed ? '[X]' : '[ ]'} ${o.DisplayName}` },
    { label: 'Name', value: (o) => o.Name },
    { label: 'Install State', value: (o) => o.InstallState },
  ],
}

VIEWS['Microsoft.PowerShell.Commands.GroupInfo'] = {
  kind: 'table',
  columns: [
    { label: 'Count', value: (o) => o.Count, align: 'right' },
    { label: 'Name', value: (o) => o.Name },
    { label: 'Group', value: (o) => asArray(o.Group).map((g) => toText(g)) },
  ],
}

VIEWS['Microsoft.PowerShell.Commands.GroupInfoNoElement'] = {
  kind: 'table',
  columns: [
    { label: 'Count', value: (o) => o.Count, align: 'right' },
    { label: 'Name', value: (o) => o.Name },
  ],
}

VIEWS['Microsoft.PowerShell.Commands.LocalUser'] = {
  kind: 'table',
  columns: [
    { label: 'Name', value: (o) => o.Name },
    { label: 'Enabled', value: (o) => o.Enabled },
    { label: 'Description', value: (o) => o.Description },
  ],
}

VIEWS['System.Diagnostics.Eventing.Reader.EventLogRecord'] = {
  kind: 'table',
  groupBy: (o) => `\n   ProviderName: ${o.ProviderName}\n\n`,
  columns: [
    { label: 'TimeCreated', value: (o) => formatDotnetDate(o.TimeCreated as Date, 'M/d/yyyy h:mm:ss tt') },
    { label: 'Id', value: (o) => o.Id, align: 'right' },
    { label: 'LevelDisplayName', value: (o) => o.LevelDisplayName },
    { label: 'Message', value: (o) => o.Message },
  ],
}

VIEWS['System.Management.Automation.CmdletInfo'] = {
  kind: 'table',
  columns: [
    { label: 'CommandType', value: (o) => o.CommandType },
    { label: 'Name', value: (o) => o.Name },
    { label: 'Version', value: (o) => o.Version },
    { label: 'Source', value: (o) => o.Source },
  ],
}

VIEWS['Microsoft.DnsClient.Commands.DnsRecord'] = {
  kind: 'table',
  columns: [
    { label: 'Name', value: (o) => o.Name },
    { label: 'Type', value: (o) => o.Type },
    { label: 'TTL', value: (o) => o.TTL, align: 'right' },
    { label: 'Section', value: (o) => o.Section },
    { label: 'IPAddress', value: (o) => o.IPAddress ?? o.NameHost },
  ],
}

// ---------------------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------------------

function param(ctx: CmdletContext, name: string): unknown {
  return ctx.params.get(name.toLowerCase())
}
function has(ctx: CmdletContext, name: string): boolean {
  return ctx.params.has(name.toLowerCase())
}
function str(ctx: CmdletContext, name: string): string | undefined {
  const v = param(ctx, name)
  return v === undefined || v === null ? undefined : toText(v)
}
function list(ctx: CmdletContext, name: string): unknown[] {
  return asArray(param(ctx, name))
}
function formatted(text: string): PsObject {
  return psObject('__formatted', { text })
}
function matchesAny(value: string, patterns: unknown[]): boolean {
  return patterns.some((p) => wildcardToRegex(toText(p)).test(value))
}
function data<T = PsObject>(s: PsSession, key: string): T[] {
  return (s.data[key] ??= []) as T[]
}

// ---------------------------------------------------------------------------------------
// Ayuda y descubrimiento
// ---------------------------------------------------------------------------------------

cmdlet(
  'Get-Command',
  {
    params: ['Name', 'Verb', 'Noun', 'Module', 'CommandType'],
    positional: ['Name'],
    synopsis: 'Gets all commands.',
    run(ctx) {
      const name = list(ctx, 'Name')
      const verb = str(ctx, 'Verb')
      const noun = str(ctx, 'Noun')
      const mod = str(ctx, 'Module')
      const out: PsObject[] = []
      for (const def of CMDLETS.values()) {
        const n = def.displayName!
        if (name.length && !matchesAny(n, name) && !matchesAny(n.split('-')[0], name)) continue
        if (verb && !wildcardToRegex(verb).test(n.split('-')[0])) continue
        if (noun && !wildcardToRegex(noun).test(n.split('-').slice(1).join('-'))) continue
        if (mod && !wildcardToRegex(mod).test(def.module ?? 'Microsoft.PowerShell.Management')) continue
        out.push(psObject('System.Management.Automation.CmdletInfo', { CommandType: n.includes('-') ? 'Cmdlet' : 'Application', Name: n, Version: '3.1.0.0', Source: def.module ?? 'Microsoft.PowerShell.Management' }))
      }
      if (name.length) {
        for (const [alias, target] of ALIASES) {
          if (matchesAny(alias, name)) out.push(psObject('System.Management.Automation.CmdletInfo', { CommandType: 'Alias', Name: `${alias} -> ${target}`, Version: '', Source: '' }))
        }
      }
      if (!out.length && name.length) {
        throw new PsError(`The term '${toText(name[0])}' is not recognized as the name of a cmdlet, function, script file, or operable program.`, 'ObjectNotFound', 'CommandNotFoundException,Microsoft.PowerShell.Commands.GetCommandCommand', toText(name[0]))
      }
      return out.sort((a, b) => toText(a.Name).localeCompare(toText(b.Name)))
    },
  },
  ['gcm'],
)

cmdlet(
  'Get-Help',
  {
    params: ['Name', 'Parameter'],
    switches: ['Examples', 'Detailed', 'Full', 'Online', 'ShowWindow'],
    positional: ['Name'],
    synopsis: 'Displays information about PowerShell commands and concepts.',
    run(ctx) {
      const name = str(ctx, 'Name')
      if (!name) {
        return [formatted('\nTOPIC\n    Windows PowerShell Help System\n\nSHORT DESCRIPTION\n    Displays help about Windows PowerShell cmdlets and concepts.\n\n    Get-Help <CmdletName>   Ejemplo: Get-Help Get-Service -Examples\n\n')]
      }
      const canonical = ALIASES.get(name.toLowerCase()) ?? name
      const def = CMDLETS.get(canonical.toLowerCase())
      if (!def) {
        const matches = [...CMDLETS.values()].filter((d) => wildcardToRegex(name.includes('*') ? name : `*${name}*`).test(d.displayName!))
        if (matches.length) return matches.map((d) => psObject('HelpInfoShort', { Name: d.displayName, Category: 'Cmdlet', Module: d.module ?? 'Microsoft.PowerShell.Management', Synopsis: d.synopsis ?? '' }))
        throw new PsError(`Get-Help could not find ${name} in a help file in this session.`, 'ResourceUnavailable', 'HelpNotFound,Microsoft.PowerShell.Commands.GetHelpCommand', name)
      }
      const aliases = [...ALIASES.entries()].filter(([, t]) => t.toLowerCase() === def.displayName!.toLowerCase()).map(([a]) => a)
      const syntax = def.syntax ?? `${def.displayName} ${[...(def.positional ?? []).map((p) => `[[-${p}] <Object>]`), ...(def.params ?? []).filter((p) => !(def.positional ?? []).includes(p)).map((p) => `[-${p} <Object>]`), ...(def.switches ?? []).map((s) => `[-${s}]`)].join(' ')} [<CommonParameters>]`
      let text = `\nNAME\n    ${def.displayName}\n\nSYNOPSIS\n    ${def.synopsis ?? ''}\n\n\nSYNTAX\n    ${syntax}\n\n\nALIASES\n    ${aliases.join('\n    ') || 'None'}\n\n\nREMARKS\n    Get-Help cannot find the Help files for this cmdlet on this computer. It is displaying only partial help.\n        -- To download and install Help files, type "Update-Help".\n\n`
      if (has(ctx, 'Examples')) text += `\nEXAMPLES\n    PS C:\\> ${def.displayName}\n\n`
      return [formatted(text)]
    },
  },
  ['help', 'man'],
)

cmdlet('Update-Help', {
  switches: ['Force'],
  synopsis: 'Downloads and installs the newest help files on your computer.',
  run(ctx) {
    ctx.host('[simulador] Update-Help descarga la ayuda completa desde internet; en el simulador la ayuda ya viene incluida en forma abreviada.\n')
    return []
  },
})

cmdlet(
  'Get-Alias',
  {
    params: ['Name', 'Definition'],
    positional: ['Name'],
    synopsis: 'Gets the aliases for the current session.',
    run(ctx) {
      const name = list(ctx, 'Name')
      const def = str(ctx, 'Definition')
      return [...ALIASES.entries()]
        .filter(([a, t]) => (!name.length || matchesAny(a, name)) && (!def || wildcardToRegex(def).test(t)))
        .sort()
        .map(([a, t]) => psObject('System.Management.Automation.AliasInfo', { CommandType: 'Alias', Name: `${a} -> ${t}`, Version: '', Source: '' }))
    },
  },
  ['gal'],
)

// ---------------------------------------------------------------------------------------
// Pipeline: filtrar, seleccionar, ordenar, agrupar, medir, recorrer
// ---------------------------------------------------------------------------------------

const WHERE_OPS = ['EQ', 'NE', 'GT', 'GE', 'LT', 'LE', 'Like', 'NotLike', 'Match', 'NotMatch', 'Contains', 'NotContains', 'In', 'NotIn', 'CEQ']

cmdlet(
  'Where-Object',
  {
    params: ['FilterScript', 'Property', 'Value', ...WHERE_OPS],
    positional: ['FilterScript', 'Value'],
    synopsis: 'Selects objects from a collection based on their property values.',
    run(ctx) {
      const fs = param(ctx, 'FilterScript')
      if (isScriptBlock(fs)) return ctx.input.filter((item) => truthy(ctx.s.invokeScriptBlock(fs, item)[0]))
      const prop = toText(param(ctx, 'Property') ?? fs ?? '')
      const op = WHERE_OPS.find((o) => has(ctx, o))
      if (!op) return ctx.input.filter((item) => truthy(getProp(item, prop)))
      const value = param(ctx, op)
      return ctx.input.filter((item) => {
        const v = getProp(item, prop)
        switch (op.toLowerCase()) {
          case 'eq':
            return psEquals(v, value)
          case 'ceq':
            return psEquals(v, value, true)
          case 'ne':
            return !psEquals(v, value)
          case 'gt':
            return Number(v) > Number(value)
          case 'ge':
            return Number(v) >= Number(value)
          case 'lt':
            return Number(v) < Number(value)
          case 'le':
            return Number(v) <= Number(value)
          case 'like':
            return wildcardToRegex(toText(value)).test(toText(v))
          case 'notlike':
            return !wildcardToRegex(toText(value)).test(toText(v))
          case 'match':
            return new RegExp(toText(value), 'i').test(toText(v))
          case 'notmatch':
            return !new RegExp(toText(value), 'i').test(toText(v))
          case 'contains':
            return asArray(v).some((x) => psEquals(x, value))
          case 'notcontains':
            return !asArray(v).some((x) => psEquals(x, value))
          case 'in':
            return asArray(value).some((x) => psEquals(v, x))
          case 'notin':
            return !asArray(value).some((x) => psEquals(v, x))
        }
        return false
      })
    },
  },
  ['where', '?'],
)

cmdlet(
  'ForEach-Object',
  {
    params: ['Process', 'Begin', 'End', 'MemberName'],
    positional: ['Process'],
    synopsis: 'Performs an operation against each item in a collection of input objects.',
    run(ctx) {
      const out: unknown[] = []
      const begin = param(ctx, 'Begin')
      const end = param(ctx, 'End')
      const proc = param(ctx, 'Process') ?? param(ctx, 'MemberName')
      if (isScriptBlock(begin)) out.push(...ctx.s.invokeScriptBlock(begin, null))
      for (const item of ctx.input) {
        if (isScriptBlock(proc)) out.push(...ctx.s.invokeScriptBlock(proc, item))
        else if (proc !== undefined) {
          const v = getProp(item, toText(proc))
          if (v !== null) out.push(...asArray(v))
        }
      }
      if (isScriptBlock(end)) out.push(...ctx.s.invokeScriptBlock(end, null))
      return out
    },
  },
  ['foreach', '%'],
)

cmdlet(
  'Select-Object',
  {
    params: ['Property', 'First', 'Last', 'Skip', 'ExpandProperty', 'ExcludeProperty'],
    switches: ['Unique'],
    positional: ['Property'],
    synopsis: 'Selects objects or object properties.',
    run(ctx) {
      let items = [...ctx.input]
      if (has(ctx, 'Skip')) items = items.slice(Number(param(ctx, 'Skip')))
      if (has(ctx, 'First')) items = items.slice(0, Number(param(ctx, 'First')))
      if (has(ctx, 'Last')) items = items.slice(-Number(param(ctx, 'Last')))
      if (has(ctx, 'ExpandProperty')) {
        const p = toText(param(ctx, 'ExpandProperty'))
        return items.flatMap((i) => asArray(getProp(i, p)))
      }
      const props = list(ctx, 'Property')
      if (props.length) {
        const expanded = props.flatMap((p) => (toText(p) === '*' ? [] : [p]))
        const all = props.some((p) => toText(p) === '*')
        items = items.map((item) => {
          const obj: Record<string, unknown> = {}
          if (all) for (const n of propNames(item)) obj[n] = getProp(item, n)
          for (const p of expanded) {
            if (typeof p === 'string' && p.includes('*')) {
              for (const n of propNames(item)) if (wildcardToRegex(p).test(n)) obj[n] = getProp(item, n)
            } else obj[ctx.s.propertyLabel(p)] = ctx.s.propertyValue(item, p)
          }
          return psObject(`Selected.${typeName(item)}`, obj)
        })
      }
      if (has(ctx, 'Unique')) {
        const seen = new Set<string>()
        items = items.filter((i) => {
          const key = JSON.stringify(propNames(i).map((n) => toText(getProp(i, n)))) + toText(i)
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      }
      return items
    },
  },
  ['select'],
)

cmdlet(
  'Sort-Object',
  {
    params: ['Property'],
    switches: ['Descending', 'Unique', 'CaseSensitive'],
    positional: ['Property'],
    synopsis: 'Sorts objects by property values.',
    run(ctx) {
      const props = list(ctx, 'Property')
      const key = (item: unknown) => (props.length ? props.map((p) => ctx.s.propertyValue(item, p)) : [item])
      const cmp = (a: unknown, b: unknown): number => {
        if (typeof a === 'number' && typeof b === 'number') return a - b
        if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
        return toText(a).localeCompare(toText(b), 'en', { sensitivity: 'base' })
      }
      let items = [...ctx.input].sort((x, y) => {
        const kx = key(x)
        const ky = key(y)
        for (let i = 0; i < kx.length; i++) {
          const c = cmp(kx[i], ky[i])
          if (c) return c
        }
        return 0
      })
      if (has(ctx, 'Descending')) items.reverse()
      if (has(ctx, 'Unique')) items = items.filter((v, i) => i === 0 || toText(key(v)) !== toText(key(items[i - 1])))
      return items
    },
  },
  ['sort'],
)

cmdlet(
  'Group-Object',
  {
    params: ['Property'],
    switches: ['NoElement', 'AsHashTable'],
    positional: ['Property'],
    synopsis: 'Groups objects that contain the same value for specified properties.',
    run(ctx) {
      const props = list(ctx, 'Property')
      const groups = new Map<string, unknown[]>()
      for (const item of ctx.input) {
        const k = props.length ? props.map((p) => toText(ctx.s.propertyValue(item, p))).join(', ') : toText(item)
        groups.set(k, [...(groups.get(k) ?? []), item])
      }
      if (has(ctx, 'AsHashTable')) return [new Map(groups)]
      return [...groups.entries()]
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
        .map(([Name, Group]) => (has(ctx, 'NoElement') ? psObject('Microsoft.PowerShell.Commands.GroupInfoNoElement', { Count: Group.length, Name }) : psObject('Microsoft.PowerShell.Commands.GroupInfo', { Count: Group.length, Name, Group })))
    },
  },
  ['group'],
)

cmdlet(
  'Measure-Object',
  {
    params: ['Property'],
    switches: ['Sum', 'Average', 'Maximum', 'Minimum', 'Line', 'Word', 'Character'],
    positional: ['Property'],
    synopsis: 'Calculates the numeric properties of objects, and the characters, words, and lines in string objects.',
    run(ctx) {
      if (has(ctx, 'Line') || has(ctx, 'Word') || has(ctx, 'Character')) {
        const text = ctx.input.map(toText).join('\n')
        return [psObject('Microsoft.PowerShell.Commands.TextMeasureInfo', { Lines: has(ctx, 'Line') ? ctx.input.length : null, Words: has(ctx, 'Word') ? text.split(/\s+/).filter(Boolean).length : null, Characters: has(ctx, 'Character') ? text.length : null, Property: '' })]
      }
      const prop = str(ctx, 'Property')
      const values = ctx.input.map((i) => Number(prop ? getProp(i, prop) : i)).filter((n) => !Number.isNaN(n))
      const sum = values.reduce((s, x) => s + x, 0)
      return [
        psObject('Microsoft.PowerShell.Commands.GenericMeasureInfo', {
          Count: ctx.input.length,
          Average: has(ctx, 'Average') ? (values.length ? sum / values.length : null) : null,
          Sum: has(ctx, 'Sum') ? sum : null,
          Maximum: has(ctx, 'Maximum') ? Math.max(...values) : null,
          Minimum: has(ctx, 'Minimum') ? Math.min(...values) : null,
          Property: prop ?? '',
        }),
      ]
    },
  },
  ['measure'],
)

cmdlet(
  'Get-Member',
  {
    params: ['Name', 'MemberType'],
    positional: ['Name'],
    synopsis: 'Gets the properties and methods of objects.',
    run(ctx) {
      if (!ctx.input.length) throw new PsError('You must specify an object for the Get-Member cmdlet.', 'CloseError', 'NoObjectInGetMember')
      const seen = new Set<string>()
      let text = ''
      for (const item of ctx.input) {
        const t = typeName(item)
        if (seen.has(t)) continue
        seen.add(t)
        const rows: { Name: string; MemberType: string; Definition: string }[] = []
        const methods = typeof item === 'string' ? ['Contains', 'EndsWith', 'IndexOf', 'Replace', 'Split', 'StartsWith', 'Substring', 'ToLower', 'ToString', 'ToUpper', 'Trim'] : ['Equals', 'GetHashCode', 'GetType', 'ToString']
        for (const m of methods) rows.push({ Name: m, MemberType: 'Method', Definition: `${m}()` })
        for (const p of propNames(item)) {
          const v = getProp(item, p)
          rows.push({ Name: p, MemberType: 'Property', Definition: `${typeName(v).replace('System.', '').toLowerCase()} ${p} {get;${isPsObject(item) ? 'set;' : ''}}` })
        }
        const filter = str(ctx, 'MemberType')
        const sel = rows.filter((r) => !filter || r.MemberType.toLowerCase().startsWith(filter.toLowerCase())).sort((a, b) => a.MemberType.localeCompare(b.MemberType) || a.Name.localeCompare(b.Name))
        text += `\n\n   TypeName: ${t}\n` + formatTable(sel, [
          { label: 'Name', value: (o) => (o as { Name: string }).Name },
          { label: 'MemberType', value: (o) => (o as { MemberType: string }).MemberType },
          { label: 'Definition', value: (o) => (o as { Definition: string }).Definition },
        ])
      }
      return [formatted(text)]
    },
  },
  ['gm'],
)

// ---------------------------------------------------------------------------------------
// Formato y salida
// ---------------------------------------------------------------------------------------

cmdlet(
  'Format-Table',
  {
    params: ['Property', 'GroupBy'],
    switches: ['AutoSize', 'Wrap', 'HideTableHeaders'],
    positional: ['Property'],
    synopsis: 'Formats the output as a table.',
    run(ctx) {
      const props = list(ctx, 'Property')
      if (!props.length) return [formatted(formatDefault(ctx.input))]
      const cols = props.flatMap((p) =>
        toText(p) === '*' && ctx.input[0] ? propNames(ctx.input[0]).map((n) => ({ label: n, value: (o: unknown) => getProp(o, n) })) : [{ label: ctx.s.propertyLabel(p), value: (o: unknown) => ctx.s.propertyValue(o, p) }],
      )
      return [formatted(formatTable(ctx.input, cols))]
    },
  },
  ['ft'],
)

cmdlet(
  'Format-List',
  {
    params: ['Property'],
    positional: ['Property'],
    synopsis: 'Formats the output as a list of properties in which each property appears on a new line.',
    run(ctx) {
      const props = list(ctx, 'Property')
      const all = !props.length || props.some((p) => toText(p) === '*')
      return [
        formatted(
          formatList(ctx.input, (o) =>
            all && !props.filter((p) => toText(p) !== '*').length
              ? (VIEWS[typeName(o)]?.kind === 'list' && !props.length ? VIEWS[typeName(o)].columns.map((c) => ({ label: c.label, value: c.value(o as PsObject) })) : propNames(o).map((n) => ({ label: n, value: getProp(o, n) })))
              : props.map((p) => ({ label: ctx.s.propertyLabel(p), value: ctx.s.propertyValue(o, p) })),
          ),
        ),
      ]
    },
  },
  ['fl'],
)

cmdlet('Out-String', { switches: ['Stream'], synopsis: 'Outputs input objects as a string.', run: (ctx) => [ctx.s.render(ctx.input)] })
cmdlet('Out-Null', { synopsis: 'Hides the output instead of sending it down the pipeline or displaying it.', run: () => [] })
cmdlet(
  'Out-File',
  {
    params: ['FilePath', 'Encoding', 'InputObject'],
    switches: ['Append', 'NoNewline', 'Force'],
    positional: ['FilePath'],
    synopsis: 'Sends output to a file.',
    run(ctx) {
      const path = str(ctx, 'FilePath')
      if (!path) throw new PsError("Cannot bind argument to parameter 'FilePath' because it is an empty string.", 'InvalidData', 'ParameterArgumentValidationErrorEmptyStringNotAllowed')
      const text = ctx.input.every((i) => typeof i === 'string') ? ctx.input.join('\r\n') + '\r\n' : ctx.s.render(ctx.input)
      ctx.s.fs.write(ctx.s.resolvePath(path), text, has(ctx, 'Append'))
      return []
    },
  },
)

cmdlet(
  'Write-Output',
  { params: ['InputObject'], positional: ['InputObject'], synopsis: 'Writes the specified objects to the pipeline.', run: (ctx) => [...ctx.positional.flatMap((p) => asArray(p)), ...ctx.input] },
  ['echo', 'write'],
)

cmdlet('Write-Host', {
  params: ['Object', 'ForegroundColor', 'BackgroundColor', 'Separator'],
  switches: ['NoNewline'],
  synopsis: 'Writes customized output to a host.',
  run(ctx) {
    ctx.host(ctx.positional.map(toText).join(' ') + (has(ctx, 'NoNewline') ? '' : '\n'))
    return []
  },
})

cmdlet('Write-Warning', {
  params: ['Message'],
  positional: ['Message'],
  synopsis: 'Writes a warning message.',
  run(ctx) {
    ctx.host(`WARNING: ${str(ctx, 'Message') ?? ''}\n`)
    return []
  },
})

cmdlet('Write-Error', {
  params: ['Message'],
  positional: ['Message'],
  synopsis: 'Writes an object to the error stream.',
  run(ctx) {
    ctx.writeError(str(ctx, 'Message') ?? '', 'NotSpecified')
    return []
  },
})

function csvLine(values: unknown[], delim: string) {
  return values.map((v) => `"${toText(v).replace(/"/g, '""')}"`).join(delim)
}

function toCsv(items: unknown[], delim = ',', typeInfo = false): string[] {
  if (!items.length) return []
  const props = propNames(items[0])
  const lines = props.length ? [csvLine(props, delim), ...items.map((i) => csvLine(props.map((p) => getProp(i, p)), delim))] : items.map(toText)
  return typeInfo ? [`#TYPE ${typeName(items[0])}`, ...lines] : lines
}

function parseCsv(text: string, delim = ','): PsObject[] {
  const rows = text
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith('#TYPE'))
    .map((l) => {
      const out: string[] = []
      let cur = ''
      let q = false
      for (let i = 0; i < l.length; i++) {
        const c = l[i]
        if (c === '"') {
          if (q && l[i + 1] === '"') {
            cur += '"'
            i++
          } else q = !q
        } else if (c === delim && !q) {
          out.push(cur)
          cur = ''
        } else cur += c
      }
      out.push(cur)
      return out
    })
  const [header, ...data] = rows
  return data.map((r) => psObject('System.Management.Automation.PSCustomObject', Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))))
}

cmdlet(
  'Export-Csv',
  {
    params: ['Path', 'Delimiter', 'Encoding', 'InputObject'],
    switches: ['NoTypeInformation', 'Append', 'Force', 'UseCulture'],
    positional: ['Path'],
    synopsis: 'Converts objects into a series of character-separated value (CSV) strings and saves the strings to a file.',
    run(ctx) {
      const path = str(ctx, 'Path')
      if (!path) throw new PsError("Cannot validate argument on parameter 'Path'.", 'InvalidData', 'ParameterArgumentValidationError')
      // Windows PowerShell 5.1 agrega la línea #TYPE salvo con -NoTypeInformation.
      const lines = toCsv(ctx.input, str(ctx, 'Delimiter') ?? ',', !has(ctx, 'NoTypeInformation'))
      ctx.s.fs.write(ctx.s.resolvePath(path), lines.join('\r\n') + '\r\n', has(ctx, 'Append'))
      return []
    },
  },
  ['epcsv'],
)

cmdlet(
  'Import-Csv',
  {
    params: ['Path', 'Delimiter', 'Header', 'Encoding'],
    positional: ['Path'],
    synopsis: 'Creates table-like custom objects from the items in a character-separated value (CSV) file.',
    run(ctx) {
      const path = ctx.s.resolvePath(str(ctx, 'Path') ?? '')
      const node = ctx.s.fs.get(path)
      if (!node || node.type !== 'file') throw new PsError(`Could not find file '${path}'.`, 'ObjectNotFound', 'FileOpenFailure,Microsoft.PowerShell.Commands.ImportCsvCommand', path)
      return parseCsv(node.content, str(ctx, 'Delimiter') ?? ',')
    },
  },
  ['ipcsv'],
)

cmdlet('ConvertTo-Csv', {
  params: ['Delimiter', 'InputObject'],
  switches: ['NoTypeInformation'],
  synopsis: 'Converts .NET objects into a series of character-separated value (CSV) strings.',
  run: (ctx) => toCsv(ctx.input, str(ctx, 'Delimiter') ?? ',', !has(ctx, 'NoTypeInformation')),
})

cmdlet('ConvertFrom-Csv', {
  params: ['Delimiter', 'InputObject'],
  synopsis: 'Converts object properties in character-separated value (CSV) format into CSV versions of the original objects.',
  run: (ctx) => parseCsv(ctx.input.map(toText).join('\n'), str(ctx, 'Delimiter') ?? ','),
})

function toJsonValue(v: unknown, depth: number): unknown {
  if (v === null || v === undefined || typeof v !== 'object') return v ?? null
  if (v instanceof Date) return `\\/Date(${v.getTime()})\\/`
  if (depth <= 0) return toText(v)
  if (Array.isArray(v)) return v.map((x) => toJsonValue(x, depth - 1))
  if (v instanceof Map) return Object.fromEntries([...v.entries()].map(([k, x]) => [k, toJsonValue(x, depth - 1)]))
  return Object.fromEntries(propNames(v).map((k) => [k, toJsonValue(getProp(v, k), depth - 1)]))
}

cmdlet('ConvertTo-Json', {
  params: ['Depth', 'InputObject'],
  switches: ['Compress'],
  positional: ['InputObject'],
  synopsis: 'Converts an object to a JSON-formatted string.',
  run(ctx) {
    const items = ctx.input.length ? ctx.input : asArray(param(ctx, 'InputObject'))
    const depth = Number(param(ctx, 'Depth') ?? 2)
    const value = items.length === 1 ? toJsonValue(items[0], depth) : items.map((i) => toJsonValue(i, depth))
    return [has(ctx, 'Compress') ? JSON.stringify(value) : JSON.stringify(value, null, 4)]
  },
})

cmdlet('ConvertFrom-Json', {
  params: ['InputObject'],
  positional: ['InputObject'],
  synopsis: 'Converts a JSON-formatted string to a custom object.',
  run(ctx) {
    const text = (ctx.input.length ? ctx.input : [param(ctx, 'InputObject')]).map(toText).join('\n')
    try {
      const toPs = (v: unknown): unknown =>
        Array.isArray(v) ? v.map(toPs) : v && typeof v === 'object' ? psObject('System.Management.Automation.PSCustomObject', Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toPs(x)]))) : v
      return asArray(toPs(JSON.parse(text)))
    } catch {
      throw new PsError('Invalid JSON primitive.', 'NotSpecified', 'System.ArgumentException,Microsoft.PowerShell.Commands.ConvertFromJsonCommand')
    }
  },
})

cmdlet('ConvertTo-Html', {
  params: ['Property', 'Title', 'Head', 'Body', 'PreContent', 'PostContent'],
  switches: ['Fragment'],
  positional: ['Property'],
  synopsis: 'Converts .NET objects into HTML that can be displayed in a Web browser.',
  run(ctx) {
    const props = list(ctx, 'Property').length ? list(ctx, 'Property').map(toText) : ctx.input[0] ? propNames(ctx.input[0]) : []
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const rows = ctx.input.map((i) => `<tr>${props.map((p) => `<td>${esc(toText(getProp(i, p)))}</td>`).join('')}</tr>`)
    const table = ['<table>', `<colgroup>${props.map(() => '<col/>').join('')}</colgroup>`, `<tr>${props.map((p) => `<th>${esc(p)}</th>`).join('')}</tr>`, ...rows, '</table>']
    if (has(ctx, 'Fragment')) return table
    return ['<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"  "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">', '<html xmlns="http://www.w3.org/1999/xhtml">', '<head>', `<title>${esc(str(ctx, 'Title') ?? 'HTML TABLE')}</title>`, toText(param(ctx, 'Head') ?? ''), '</head><body>', toText(param(ctx, 'PreContent') ?? ''), ...table, toText(param(ctx, 'PostContent') ?? ''), '</body></html>']
  },
})

// ---------------------------------------------------------------------------------------
// Varios
// ---------------------------------------------------------------------------------------

cmdlet('Get-Date', {
  params: ['Format', 'UFormat', 'Date'],
  positional: ['Date'],
  synopsis: 'Gets the current date and time.',
  run(ctx) {
    const d = has(ctx, 'Date') ? new Date(toText(param(ctx, 'Date'))) : new Date()
    if (has(ctx, 'Format')) return [formatDotnetDate(d, str(ctx, 'Format')!)]
    return [d]
  },
})

cmdlet('Get-Random', {
  params: ['Minimum', 'Maximum', 'InputObject', 'Count'],
  positional: ['Maximum'],
  synopsis: 'Gets a random number, or selects objects randomly from a collection.',
  run(ctx) {
    if (ctx.input.length) return [ctx.input[Math.floor(Math.random() * ctx.input.length)]]
    const min = Number(param(ctx, 'Minimum') ?? 0)
    const max = Number(param(ctx, 'Maximum') ?? 2147483647)
    return [min + Math.floor(Math.random() * (max - min))]
  },
})

cmdlet('Start-Sleep', { params: ['Seconds', 'Milliseconds'], positional: ['Seconds'], synopsis: 'Suspends the activity in a script or session for the specified period of time.', run: () => [] }, ['sleep'])

cmdlet(
  'Clear-Host',
  {
    synopsis: 'Clears the display in the host program.',
    run(ctx) {
      ctx.s.pendingClear = true
      return []
    },
  },
  ['cls', 'clear'],
)

cmdlet(
  'Get-History',
  {
    params: ['Count'],
    synopsis: 'Gets a list of the commands entered during the current session.',
    run(ctx) {
      const n = Number(param(ctx, 'Count') ?? ctx.s.history.length)
      return ctx.s.history.slice(-n).map((h, i, arr) => psObject('Microsoft.PowerShell.Commands.HistoryInfo', { Id: ctx.s.history.length - arr.length + i + 1, CommandLine: h }))
    },
  },
  ['h', 'history', 'ghy'],
)

cmdlet('Get-Variable', {
  params: ['Name'],
  positional: ['Name'],
  synopsis: 'Gets the variables in the current console.',
  run(ctx) {
    const name = str(ctx, 'Name')
    return [...ctx.s.vars.entries()]
      .filter(([k]) => !name || wildcardToRegex(name).test(k))
      .map(([Name, Value]) => psObject('System.Management.Automation.PSVariable', { Name, Value }))
  },
}, ['gv'])

cmdlet('Read-Host', {
  params: ['Prompt'],
  switches: ['AsSecureString'],
  positional: ['Prompt'],
  synopsis: 'Reads a line of input from the console.',
  run(ctx) {
    ctx.host(`${str(ctx, 'Prompt') ?? ''}: \n[simulador] Read-Host espera que la persona escriba; en el simulador se devuelve un valor vacío.\n`)
    return has(ctx, 'AsSecureString') ? [psObject('System.Security.SecureString', { __secure: true, Length: 8 })] : ['']
  },
})

cmdlet('ConvertTo-SecureString', {
  params: ['String', 'Key'],
  switches: ['AsPlainText', 'Force'],
  positional: ['String'],
  synopsis: 'Converts plain text or encrypted strings to secure strings.',
  run(ctx) {
    if (has(ctx, 'AsPlainText') && !has(ctx, 'Force')) throw new PsError('The system cannot protect plain text input. To suppress this warning and convert the plain text to a SecureString, reissue the command specifying the Force parameter.', 'InvalidArgument', 'ImportSecureString_InvalidArgument')
    return [psObject('System.Security.SecureString', { __secure: true, Length: toText(param(ctx, 'String') ?? ctx.input[0]).length })]
  },
})

cmdlet('Get-ExecutionPolicy', {
  switches: ['List'],
  params: ['Scope'],
  synopsis: 'Gets the execution policies for the current session.',
  run: (ctx) => [ctx.s.executionPolicy],
})

cmdlet('Set-ExecutionPolicy', {
  params: ['ExecutionPolicy', 'Scope'],
  switches: ['Force'],
  positional: ['ExecutionPolicy'],
  synopsis: 'Sets the PowerShell execution policies for Windows computers.',
  run(ctx) {
    const p = str(ctx, 'ExecutionPolicy') ?? ''
    const valid = ['Restricted', 'AllSigned', 'RemoteSigned', 'Unrestricted', 'Bypass', 'Undefined']
    const match = valid.find((v) => v.toLowerCase() === p.toLowerCase())
    if (!match) throw new PsError(`Cannot bind parameter 'ExecutionPolicy'. Cannot convert value "${p}" to type "Microsoft.PowerShell.ExecutionPolicy".`, 'InvalidArgument', 'CannotConvertArgumentNoMessage')
    if (!has(ctx, 'Force')) ctx.host('\nExecution Policy Change\nThe execution policy helps protect you from scripts that you do not trust. Changing the execution policy might expose you to the security risks described in the about_Execution_Policies help topic.\nDo you want to change the execution policy?\n[Y] Yes  [A] Yes to All  [N] No  [L] No to All  [S] Suspend  [?] Help (default is "N"): Y\n')
    ctx.s.executionPolicy = match
    return []
  },
})

// ---------------------------------------------------------------------------------------
// Archivos
// ---------------------------------------------------------------------------------------

function fileObject(s: PsSession, path: string): PsObject {
  const node = s.fs.get(path)!
  const dir = node.type === 'dir'
  return psObject(dir ? 'System.IO.DirectoryInfo' : 'System.IO.FileInfo', {
    Name: node.name,
    FullName: path,
    Length: dir ? null : new TextEncoder().encode(node.content).length,
    LastWriteTime: new Date(node.mtime),
    Mode: dir ? 'd-----' : '-a----',
    Extension: dir ? '' : (/\.[^.\\]+$/.exec(node.name)?.[0] ?? ''),
    PSParentPath: s.fs.parent(path),
    PSIsContainer: dir,
    __dir: dir,
  })
}

function requirePath(ctx: CmdletContext, raw: string | undefined, verb = 'find'): string {
  const path = ctx.s.resolvePath(raw ?? '.')
  if (!ctx.s.fs.get(path) && !/^[A-Za-z]:\\$/.test(path)) {
    throw new PsError(`Cannot ${verb} path '${path}' because it does not exist.`, 'ObjectNotFound', 'PathNotFound,Microsoft.PowerShell.Commands.GetChildItemCommand', path)
  }
  return path
}

cmdlet(
  'Get-ChildItem',
  {
    params: ['Path', 'Filter', 'Include', 'Exclude', 'Depth'],
    switches: ['Recurse', 'File', 'Directory', 'Force', 'Name'],
    positional: ['Path'],
    synopsis: 'Gets the items and child items in one or more specified locations.',
    run(ctx) {
      const raw = str(ctx, 'Path')
      let pattern: RegExp | undefined
      let base = raw
      if (raw && /[*?]/.test(raw.split(/[\\/]/).pop() ?? '')) {
        pattern = wildcardToRegex(raw.split(/[\\/]/).pop()!)
        base = raw.split(/[\\/]/).slice(0, -1).join('\\') || '.'
      }
      const root = requirePath(ctx, base)
      if (ctx.s.fs.get(root)?.type === 'file') return [fileObject(ctx.s, root)]
      const filter = str(ctx, 'Filter')
      const fre = filter ? wildcardToRegex(filter) : undefined
      const out: PsObject[] = []
      const walk = (dir: string, depth: number) => {
        for (const c of ctx.s.fs.children(dir)) {
          if (c.node.hidden && !has(ctx, 'Force')) continue
          const okType = (!has(ctx, 'File') || c.node.type === 'file') && (!has(ctx, 'Directory') || c.node.type === 'dir')
          const okName = (!fre || fre.test(c.node.name)) && (!pattern || pattern.test(c.node.name))
          if (okType && okName) out.push(fileObject(ctx.s, c.path))
          if (c.node.type === 'dir' && has(ctx, 'Recurse') && (!has(ctx, 'Depth') || depth < Number(param(ctx, 'Depth')))) walk(c.path, depth + 1)
        }
      }
      walk(root, 0)
      return has(ctx, 'Name') ? out.map((o) => o.Name) : out
    },
  },
  ['gci', 'ls', 'dir'],
)

cmdlet(
  'Get-Item',
  {
    params: ['Path'],
    switches: ['Force'],
    positional: ['Path'],
    synopsis: 'Gets the item at the specified location.',
    run(ctx) {
      return list(ctx, 'Path').map((p) => fileObject(ctx.s, requirePath(ctx, toText(p))))
    },
  },
  ['gi'],
)

cmdlet(
  'Set-Location',
  {
    params: ['Path'],
    positional: ['Path'],
    synopsis: 'Sets the current working location to a specified location.',
    run(ctx) {
      const raw = str(ctx, 'Path') ?? ctx.s.home
      const path = ctx.s.resolvePath(raw)
      const node = ctx.s.fs.get(path)
      if (!/^[A-Za-z]:\\$/.test(path) && (!node || node.type !== 'dir')) {
        throw new PsError(`Cannot find path '${path}' because it does not exist.`, 'ObjectNotFound', 'PathNotFound,Microsoft.PowerShell.Commands.SetLocationCommand', path)
      }
      ctx.s.cwd = path
      return []
    },
  },
  ['cd', 'sl', 'chdir'],
)

cmdlet(
  'Get-Location',
  { synopsis: 'Gets information about the current working location.', run: (ctx) => [psObject('System.Management.Automation.PathInfo', { Path: ctx.s.cwd })] },
  ['pwd', 'gl'],
)

cmdlet(
  'Get-Content',
  {
    params: ['Path', 'TotalCount', 'Tail', 'Encoding'],
    switches: ['Raw'],
    positional: ['Path'],
    synopsis: 'Gets the content of the item at the specified location.',
    run(ctx) {
      const out: unknown[] = []
      for (const p of list(ctx, 'Path')) {
        const path = ctx.s.resolvePath(toText(p))
        const node = ctx.s.fs.get(path)
        if (!node) {
          ctx.writeError(`Cannot find path '${path}' because it does not exist.`, 'ObjectNotFound', path, 'PathNotFound,Microsoft.PowerShell.Commands.GetContentCommand')
          continue
        }
        if (node.type === 'dir') {
          ctx.writeError(`Access to the path '${path}' is denied.`, 'PermissionDenied', path)
          continue
        }
        if (has(ctx, 'Raw')) {
          out.push(node.content)
          continue
        }
        let lines = node.content.split(/\r?\n/)
        if (lines[lines.length - 1] === '') lines.pop()
        if (has(ctx, 'TotalCount')) lines = lines.slice(0, Number(param(ctx, 'TotalCount')))
        if (has(ctx, 'Tail')) lines = lines.slice(-Number(param(ctx, 'Tail')))
        out.push(...lines)
      }
      return out
    },
  },
  ['gc', 'cat', 'type'],
)

function writeContent(ctx: CmdletContext, append: boolean) {
  const path = ctx.s.resolvePath(str(ctx, 'Path') ?? '')
  const value = has(ctx, 'Value') ? asArray(param(ctx, 'Value')) : ctx.input
  const text = value.map(toText).join('\r\n') + (has(ctx, 'NoNewline') ? '' : '\r\n')
  const node = ctx.s.fs.get(path)
  if (node?.type === 'dir') throw new PsError(`Access to the path '${path}' is denied.`, 'PermissionDenied', 'GetContentWriterUnauthorizedAccessError', path)
  if (!ctx.s.fs.get(ctx.s.fs.parent(path)) && !/^[A-Za-z]:\\$/.test(ctx.s.fs.parent(path))) {
    throw new PsError(`Could not find a part of the path '${path}'.`, 'ObjectNotFound', 'GetContentWriterDirectoryNotFoundError', path)
  }
  ctx.s.fs.write(path, text, append)
  return []
}

cmdlet('Set-Content', { params: ['Path', 'Value', 'Encoding'], switches: ['NoNewline', 'Force'], positional: ['Path', 'Value'], synopsis: 'Writes new content or replaces existing content in a file.', run: (ctx) => writeContent(ctx, false) }, ['sc'])
cmdlet('Add-Content', { params: ['Path', 'Value', 'Encoding'], switches: ['NoNewline', 'Force'], positional: ['Path', 'Value'], synopsis: 'Adds content to the specified items, such as adding words to a file.', run: (ctx) => writeContent(ctx, true) }, ['ac'])
cmdlet('Clear-Content', {
  params: ['Path'],
  positional: ['Path'],
  synopsis: 'Deletes the contents of an item, but does not delete the item.',
  run(ctx) {
    const path = requirePath(ctx, str(ctx, 'Path'))
    ctx.s.fs.write(path, '')
    return []
  },
}, ['clc'])

cmdlet(
  'New-Item',
  {
    params: ['Path', 'Name', 'ItemType', 'Value'],
    switches: ['Force'],
    positional: ['Path'],
    synopsis: 'Creates a new item.',
    run(ctx) {
      const base = str(ctx, 'Path') ?? '.'
      const name = str(ctx, 'Name')
      const path = ctx.s.resolvePath(name ? `${base}\\${name}` : base)
      const type = (str(ctx, 'ItemType') ?? 'File').toLowerCase()
      if (ctx.s.fs.get(path) && !has(ctx, 'Force')) {
        throw new PsError(`An item with the specified name ${path} already exists.`, 'ResourceExists', 'DirectoryExist,Microsoft.PowerShell.Commands.NewItemCommand', path)
      }
      if (type === 'directory') ctx.s.fs.mkdirp(path)
      else if (type === 'file') {
        const parent = ctx.s.fs.parent(path)
        if (!ctx.s.fs.get(parent) && !/^[A-Za-z]:\\$/.test(parent) && !has(ctx, 'Force')) {
          throw new PsError(`Could not find a part of the path '${path}'.`, 'WriteError', 'NewItemIOError,Microsoft.PowerShell.Commands.NewItemCommand', path)
        }
        ctx.s.fs.write(path, has(ctx, 'Value') ? toText(param(ctx, 'Value')) : '')
      } else throw new PsError(`The type '${type}' is not a valid item type. Use File or Directory.`, 'InvalidArgument', 'NewItemNotSupported')
      return [fileObject(ctx.s, path)]
    },
  },
  ['ni'],
)

cmdlet('mkdir', {
  params: ['Path', 'Name'],
  switches: ['Force'],
  positional: ['Path'],
  synopsis: 'Creates a directory (function that calls New-Item -ItemType Directory).',
  run(ctx) {
    const path = ctx.s.resolvePath(str(ctx, 'Path') ?? str(ctx, 'Name') ?? '')
    if (ctx.s.fs.get(path) && !has(ctx, 'Force')) throw new PsError(`An item with the specified name ${path} already exists.`, 'ResourceExists', 'DirectoryExist,Microsoft.PowerShell.Commands.NewItemCommand', path)
    ctx.s.fs.mkdirp(path)
    return [fileObject(ctx.s, path)]
  },
}, ['md'])

cmdlet(
  'Remove-Item',
  {
    params: ['Path', 'Include', 'Exclude'],
    switches: ['Recurse', 'Force', 'Confirm', 'WhatIf'],
    positional: ['Path'],
    synopsis: 'Deletes the specified items.',
    run(ctx) {
      for (const p of list(ctx, 'Path')) {
        const path = ctx.s.resolvePath(toText(p))
        const node = ctx.s.fs.get(path)
        if (!node) {
          ctx.writeError(`Cannot find path '${path}' because it does not exist.`, 'ObjectNotFound', path)
          continue
        }
        if (has(ctx, 'WhatIf')) {
          ctx.host(`What if: Performing the operation "Remove ${node.type === 'dir' ? 'Directory' : 'File'}" on target "${path}".\n`)
          continue
        }
        if (node.type === 'dir' && ctx.s.fs.children(path).length && !has(ctx, 'Recurse')) {
          ctx.host(`\nConfirm\nThe item at ${path} has children and the Recurse parameter was not specified. If you continue, all children will be removed with the item. Are you sure you want to continue?\n[Y] Yes  [A] Yes to All  [N] No  [L] No to All  [S] Suspend  [?] Help (default is "Y"): N\n[simulador] Para borrar una carpeta con contenido sin confirmar, usar -Recurse.\n`)
          continue
        }
        ctx.s.fs.remove(path)
      }
      return []
    },
  },
  ['rm', 'del', 'ri', 'rmdir', 'rd', 'erase'],
)

function copyTree(s: PsSession, from: string, to: string) {
  const node = s.fs.get(from)!
  if (node.type === 'file') {
    s.fs.write(to, node.content)
    return
  }
  s.fs.mkdirp(to)
  for (const c of s.fs.children(from)) copyTree(s, c.path, `${to}\\${c.node.name}`)
}

function copyOrMove(ctx: CmdletContext, move: boolean) {
  const src = requirePath(ctx, str(ctx, 'Path'), 'find')
  let dest = ctx.s.resolvePath(str(ctx, 'Destination') ?? '.')
  if (ctx.s.fs.get(dest)?.type === 'dir' || /^[A-Za-z]:\\$/.test(dest)) dest = `${dest.replace(/\\$/, '')}\\${ctx.s.fs.get(src)!.name}`
  if (ctx.s.fs.get(src)!.type === 'dir' && !move && !has(ctx, 'Recurse')) {
    ctx.s.fs.mkdirp(dest)
    return []
  }
  copyTree(ctx.s, src, dest)
  if (move) ctx.s.fs.remove(src)
  return []
}

cmdlet('Copy-Item', { params: ['Path', 'Destination'], switches: ['Recurse', 'Force'], positional: ['Path', 'Destination'], synopsis: 'Copies an item from one location to another.', run: (ctx) => copyOrMove(ctx, false) }, ['copy', 'cp', 'cpi'])
cmdlet('Move-Item', { params: ['Path', 'Destination'], switches: ['Force'], positional: ['Path', 'Destination'], synopsis: 'Moves an item from one location to another.', run: (ctx) => copyOrMove(ctx, true) }, ['move', 'mv', 'mi'])

cmdlet(
  'Rename-Item',
  {
    params: ['Path', 'NewName'],
    switches: ['Force'],
    positional: ['Path', 'NewName'],
    synopsis: 'Renames an item in a PowerShell provider namespace.',
    run(ctx) {
      const src = requirePath(ctx, str(ctx, 'Path'), 'rename item at')
      const dest = `${ctx.s.fs.parent(src).replace(/\\$/, '')}\\${str(ctx, 'NewName')}`
      copyTree(ctx.s, src, dest)
      ctx.s.fs.remove(src)
      return []
    },
  },
  ['ren', 'rni'],
)

cmdlet('Test-Path', {
  params: ['Path', 'PathType'],
  positional: ['Path'],
  synopsis: 'Determines whether all elements of a path exist.',
  run(ctx) {
    return list(ctx, 'Path').map((p) => {
      const path = ctx.s.resolvePath(toText(p))
      const node = ctx.s.fs.get(path)
      const type = str(ctx, 'PathType')?.toLowerCase()
      if (/^[A-Za-z]:\\$/.test(path)) return true
      if (!node) return false
      if (type === 'leaf') return node.type === 'file'
      if (type === 'container') return node.type === 'dir'
      return true
    })
  },
})

// ---------------------------------------------------------------------------------------
// Servicios y procesos
// ---------------------------------------------------------------------------------------

function findServices(ctx: CmdletContext, names: unknown[], display?: unknown[]): PsObject[] {
  const all = data(ctx.s, 'services')
  if (!names.length && !display?.length) return all
  const out: PsObject[] = []
  for (const n of names) {
    const found = all.filter((s) => wildcardToRegex(toText(n)).test(toText(s.Name)))
    if (!found.length && !/[*?]/.test(toText(n))) ctx.writeError(`Cannot find any service with service name '${toText(n)}'.`, 'ObjectNotFound', toText(n), 'NoServiceFoundForGivenName,Microsoft.PowerShell.Commands.GetServiceCommand')
    out.push(...found)
  }
  for (const d of display ?? []) out.push(...all.filter((s) => wildcardToRegex(toText(d)).test(toText(s.DisplayName))))
  return [...new Set(out)]
}

cmdlet(
  'Get-Service',
  {
    params: ['Name', 'DisplayName', 'ComputerName'],
    switches: ['DependentServices', 'RequiredServices'],
    positional: ['Name'],
    synopsis: 'Gets the services on the computer.',
    module: 'Microsoft.PowerShell.Management',
    run(ctx) {
      const names = ctx.input.length && !has(ctx, 'Name') ? ctx.input.map((i) => (isPsObject(i) ? i.Name : i)) : list(ctx, 'Name')
      return findServices(ctx, names, list(ctx, 'DisplayName')).sort((a, b) => toText(a.Name).localeCompare(toText(b.Name)))
    },
  },
  ['gsv'],
)

function serviceTargets(ctx: CmdletContext): PsObject[] {
  if (ctx.input.length && !has(ctx, 'Name')) return ctx.input.filter(isPsObject).filter((o) => o.__type === 'System.ServiceProcess.ServiceController')
  return findServices(ctx, list(ctx, 'Name'), list(ctx, 'DisplayName'))
}

function changeService(ctx: CmdletContext, action: 'start' | 'stop' | 'restart') {
  const out: PsObject[] = []
  for (const svc of serviceTargets(ctx)) {
    if (action !== 'stop') {
      if (svc.StartType === 'Disabled') {
        ctx.writeError(`Service '${svc.DisplayName} (${svc.Name})' cannot be started due to the following error: Cannot start service ${svc.Name} on computer '.'.`, 'OpenError', toText(svc.Name), 'CouldNotStartService,Microsoft.PowerShell.Commands.StartServiceCommand')
        continue
      }
      if (svc.__fail) {
        svc.Status = 'Stopped'
        ctx.writeError(`Service '${svc.DisplayName} (${svc.Name})' cannot be started due to the following error: ${svc.__fail}`, 'OpenError', toText(svc.Name), 'CouldNotStartService,Microsoft.PowerShell.Commands.StartServiceCommand')
        data(ctx.s, 'events').push(psObject('System.Diagnostics.Eventing.Reader.EventLogRecord', { TimeCreated: new Date(), Id: 7000, LevelDisplayName: 'Error', ProviderName: 'Service Control Manager', LogName: 'System', Message: `The ${svc.DisplayName} service failed to start due to the following error: ${svc.__fail}` }))
        continue
      }
      if (action === 'restart' && svc.Status === 'Running') ctx.host(`WARNING: Waiting for service '${svc.DisplayName} (${svc.Name})' to stop...\n`)
      svc.Status = 'Running'
    } else {
      svc.Status = 'Stopped'
    }
    if (has(ctx, 'PassThru')) out.push(svc)
  }
  return out
}

cmdlet('Start-Service', { params: ['Name', 'DisplayName', 'InputObject'], switches: ['PassThru'], positional: ['Name'], synopsis: 'Starts one or more stopped services.', run: (ctx) => changeService(ctx, 'start') }, ['sasv'])
cmdlet('Stop-Service', { params: ['Name', 'DisplayName', 'InputObject'], switches: ['PassThru', 'Force', 'NoWait'], positional: ['Name'], synopsis: 'Stops one or more running services.', run: (ctx) => changeService(ctx, 'stop') }, ['spsv'])
cmdlet('Restart-Service', { params: ['Name', 'DisplayName', 'InputObject'], switches: ['PassThru', 'Force'], positional: ['Name'], synopsis: 'Stops and then starts one or more services.', run: (ctx) => changeService(ctx, 'restart') })

cmdlet('Set-Service', {
  params: ['Name', 'StartupType', 'Status', 'DisplayName', 'Description', 'InputObject'],
  switches: ['PassThru'],
  positional: ['Name'],
  synopsis: 'Starts, stops, and suspends a service, and changes its properties.',
  run(ctx) {
    const valid = ['Automatic', 'Manual', 'Disabled', 'AutomaticDelayedStart']
    for (const svc of serviceTargets(ctx)) {
      if (has(ctx, 'StartupType')) {
        const st = valid.find((v) => v.toLowerCase() === str(ctx, 'StartupType')!.toLowerCase())
        if (!st) throw new PsError(`Cannot bind parameter 'StartupType'. Cannot convert value "${str(ctx, 'StartupType')}" to type "Microsoft.PowerShell.Commands.ServiceStartupType".`, 'InvalidArgument', 'CannotConvertArgumentNoMessage')
        svc.StartType = st === 'AutomaticDelayedStart' ? 'Automatic' : st
      }
      if (has(ctx, 'Status')) svc.Status = str(ctx, 'Status')!.toLowerCase() === 'running' ? 'Running' : 'Stopped'
      if (has(ctx, 'DisplayName')) svc.DisplayName = str(ctx, 'DisplayName')
    }
    return []
  },
})

cmdlet(
  'Get-Process',
  {
    params: ['Name', 'Id', 'ComputerName'],
    switches: ['IncludeUserName'],
    positional: ['Name'],
    synopsis: 'Gets the processes that are running on the local computer.',
    run(ctx) {
      const all = data(ctx.s, 'processes')
      if (has(ctx, 'Id')) {
        const ids = list(ctx, 'Id').map(Number)
        const found = all.filter((p) => ids.includes(Number(p.Id)))
        for (const id of ids) if (!found.some((p) => p.Id === id)) ctx.writeError(`Cannot find a process with the process identifier ${id}.`, 'ObjectNotFound', String(id))
        return found
      }
      const names = list(ctx, 'Name')
      if (!names.length) return [...all].sort((a, b) => toText(a.ProcessName).localeCompare(toText(b.ProcessName)))
      const out: PsObject[] = []
      for (const n of names) {
        const found = all.filter((p) => wildcardToRegex(toText(n)).test(toText(p.ProcessName)))
        if (!found.length && !/[*?]/.test(toText(n))) ctx.writeError(`Cannot find a process with the name "${toText(n)}". Verify the process name and call the cmdlet again.`, 'ObjectNotFound', toText(n), 'NoProcessFoundForGivenName,Microsoft.PowerShell.Commands.GetProcessCommand')
        out.push(...found)
      }
      return out
    },
  },
  ['gps', 'ps'],
)

cmdlet(
  'Stop-Process',
  {
    params: ['Name', 'Id', 'InputObject'],
    switches: ['Force', 'PassThru'],
    positional: ['Id'],
    synopsis: 'Stops one or more running processes.',
    run(ctx) {
      const all = data(ctx.s, 'processes')
      let targets: PsObject[] = []
      if (ctx.input.length) targets = ctx.input.filter(isPsObject)
      else if (has(ctx, 'Name')) targets = all.filter((p) => list(ctx, 'Name').some((n) => wildcardToRegex(toText(n)).test(toText(p.ProcessName))))
      else targets = all.filter((p) => list(ctx, 'Id').map(Number).includes(Number(p.Id)))
      if (!targets.length) ctx.writeError('Cannot find a process with the specified name or identifier.', 'ObjectNotFound')
      ctx.s.data.processes = all.filter((p) => !targets.includes(p))
      return []
    },
  },
  ['kill', 'spps'],
)

// ---------------------------------------------------------------------------------------
// Roles y características
// ---------------------------------------------------------------------------------------

cmdlet('Get-WindowsFeature', {
  params: ['Name', 'ComputerName'],
  positional: ['Name'],
  synopsis: 'Gets information about Windows Server roles, role services, and features.',
  module: 'ServerManager',
  run(ctx) {
    const names = list(ctx, 'Name')
    return data(ctx.s, 'features').filter((f) => !names.length || matchesAny(toText(f.Name), names) || matchesAny(toText(f.DisplayName), names))
  },
})

function featureChange(ctx: CmdletContext, install: boolean) {
  const names = list(ctx, 'Name').map(toText)
  const features = data(ctx.s, 'features')
  const changed: string[] = []
  for (const n of names) {
    const f = features.find((x) => toText(x.Name).toLowerCase() === n.toLowerCase())
    if (!f) throw new PsError(`ArgumentNotValid: The role, role service, or feature name is not valid: '${n}'. The name was not found.`, 'InvalidArgument', 'NameDoesNotExist,Microsoft.Windows.ServerManager.Commands.AddWindowsFeatureCommand', n)
    if (Boolean(f.Installed) !== install) {
      f.Installed = install
      f.InstallState = install ? 'Installed' : 'Available'
      changed.push(toText(f.DisplayName))
    }
  }
  const restart = changed.some((c) => /Active Directory|Hyper-V/.test(c)) && install
  return [
    psObject('Microsoft.Windows.ServerManager.Commands.FeatureOperationResult', {
      Success: true,
      'Restart Needed': restart ? 'Yes' : 'No',
      'Exit Code': changed.length ? 'Success' : 'NoChangeNeeded',
      'Feature Result': changed.length ? `{${changed.join(', ')}}` : '{}',
    }),
  ]
}

cmdlet('Install-WindowsFeature', { params: ['Name', 'ComputerName', 'Source'], switches: ['IncludeManagementTools', 'IncludeAllSubFeature', 'Restart'], positional: ['Name'], synopsis: 'Installs one or more roles, role services, or features.', module: 'ServerManager', run: (ctx) => featureChange(ctx, true) }, ['Add-WindowsFeature'])
cmdlet('Uninstall-WindowsFeature', { params: ['Name'], switches: ['IncludeManagementTools', 'Remove', 'Restart'], positional: ['Name'], synopsis: 'Uninstalls specified roles, role services, and features.', module: 'ServerManager', run: (ctx) => featureChange(ctx, false) }, ['Remove-WindowsFeature'])

VIEWS['Microsoft.Windows.ServerManager.Commands.FeatureOperationResult'] = {
  kind: 'table',
  columns: [
    { label: 'Success', value: (o) => o.Success },
    { label: 'Restart Needed', value: (o) => o['Restart Needed'] },
    { label: 'Exit Code', value: (o) => o['Exit Code'] },
    { label: 'Feature Result', value: (o) => o['Feature Result'] },
  ],
}

// ---------------------------------------------------------------------------------------
// Usuarios y grupos locales
// ---------------------------------------------------------------------------------------

cmdlet('Get-LocalUser', {
  params: ['Name'],
  positional: ['Name'],
  synopsis: 'Gets local user accounts.',
  module: 'Microsoft.PowerShell.LocalAccounts',
  run(ctx) {
    const names = list(ctx, 'Name')
    const all = data(ctx.s, 'localUsers')
    if (!names.length) return all
    const out = all.filter((u) => matchesAny(toText(u.Name), names))
    if (!out.length) ctx.writeError(`User ${toText(names[0])} was not found.`, 'ObjectNotFound', toText(names[0]))
    return out
  },
})

cmdlet('New-LocalUser', {
  params: ['Name', 'Password', 'Description', 'FullName'],
  switches: ['NoPassword', 'PasswordNeverExpires', 'Disabled', 'AccountNeverExpires'],
  positional: ['Name'],
  synopsis: 'Creates a local user account.',
  module: 'Microsoft.PowerShell.LocalAccounts',
  run(ctx) {
    const name = str(ctx, 'Name')!
    const users = data(ctx.s, 'localUsers')
    if (users.some((u) => toText(u.Name).toLowerCase() === name.toLowerCase())) throw new PsError(`User ${name} already exists.`, 'ResourceExists', 'UserExists,Microsoft.PowerShell.Commands.NewLocalUserCommand', name)
    if (!has(ctx, 'Password') && !has(ctx, 'NoPassword')) ctx.host('[simulador] Sin -Password ni -NoPassword, PowerShell pide la contraseña; aquí se da por cargada.\n')
    const u = psObject('Microsoft.PowerShell.Commands.LocalUser', { Name: name, Enabled: !has(ctx, 'Disabled'), Description: str(ctx, 'Description') ?? '', FullName: str(ctx, 'FullName') ?? '' })
    users.push(u)
    return [u]
  },
})

cmdlet('Remove-LocalUser', {
  params: ['Name'],
  positional: ['Name'],
  synopsis: 'Deletes local user accounts.',
  module: 'Microsoft.PowerShell.LocalAccounts',
  run(ctx) {
    const names = list(ctx, 'Name').map((n) => toText(n).toLowerCase())
    ctx.s.data.localUsers = data(ctx.s, 'localUsers').filter((u) => !names.includes(toText(u.Name).toLowerCase()))
    return []
  },
})

for (const [verb, enabled] of [['Enable', true], ['Disable', false]] as const) {
  cmdlet(`${verb}-LocalUser`, {
    params: ['Name'],
    positional: ['Name'],
    synopsis: `${verb}s a local user account.`,
    module: 'Microsoft.PowerShell.LocalAccounts',
    run(ctx) {
      for (const u of data(ctx.s, 'localUsers')) if (list(ctx, 'Name').some((n) => psEquals(u.Name, n))) u.Enabled = enabled
      return []
    },
  })
}

cmdlet('Get-LocalGroup', {
  params: ['Name'],
  positional: ['Name'],
  synopsis: 'Gets the local security groups.',
  module: 'Microsoft.PowerShell.LocalAccounts',
  run(ctx) {
    const names = list(ctx, 'Name')
    return data(ctx.s, 'localGroups').filter((g) => !names.length || matchesAny(toText(g.Name), names))
  },
})

cmdlet('Get-LocalGroupMember', {
  params: ['Group', 'Name'],
  positional: ['Group'],
  synopsis: 'Gets members from a local group.',
  module: 'Microsoft.PowerShell.LocalAccounts',
  run(ctx) {
    const g = data(ctx.s, 'localGroups').find((x) => psEquals(x.Name, param(ctx, 'Group')))
    if (!g) throw new PsError(`Group ${str(ctx, 'Group')} was not found.`, 'ObjectNotFound', 'GroupNotFound', str(ctx, 'Group'))
    return asArray(g.__members).map((m) => psObject('Microsoft.PowerShell.Commands.LocalPrincipal', { ObjectClass: 'User', Name: `${ctx.s.state.equipo}\\${toText(m)}`, PrincipalSource: 'Local' }))
  },
})

cmdlet('Add-LocalGroupMember', {
  params: ['Group', 'Member'],
  positional: ['Group', 'Member'],
  synopsis: 'Adds members to a local group.',
  module: 'Microsoft.PowerShell.LocalAccounts',
  run(ctx) {
    const g = data(ctx.s, 'localGroups').find((x) => psEquals(x.Name, param(ctx, 'Group')))
    if (!g) throw new PsError(`Group ${str(ctx, 'Group')} was not found.`, 'ObjectNotFound', 'GroupNotFound', str(ctx, 'Group'))
    const members = asArray(g.__members)
    for (const m of list(ctx, 'Member')) {
      if (members.some((x) => psEquals(x, m))) {
        ctx.writeError(`${ctx.s.state.equipo}\\${toText(m)} is already a member of group ${toText(g.Name)}.`, 'ResourceExists', toText(m))
        continue
      }
      members.push(toText(m))
    }
    g.__members = members
    return []
  },
})

// ---------------------------------------------------------------------------------------
// Red
// ---------------------------------------------------------------------------------------

function netCfg(s: PsSession) {
  return s.state.red
}

cmdlet('Get-NetIPAddress', {
  params: ['AddressFamily', 'InterfaceAlias', 'IPAddress'],
  synopsis: 'Gets the IP address configuration.',
  module: 'NetTCPIP',
  run(ctx) {
    const r = netCfg(ctx.s)
    const items = [
      psObject('MSFT_NetIPAddress', { IPAddress: r.ip, InterfaceIndex: 6, InterfaceAlias: 'Ethernet', AddressFamily: 'IPv4', Type: 'Unicast', PrefixLength: r.prefijo, PrefixOrigin: 'Manual', SuffixOrigin: 'Manual', AddressState: 'Preferred' }),
      psObject('MSFT_NetIPAddress', { IPAddress: '127.0.0.1', InterfaceIndex: 1, InterfaceAlias: 'Loopback Pseudo-Interface 1', AddressFamily: 'IPv4', Type: 'Unicast', PrefixLength: 8, PrefixOrigin: 'WellKnown', SuffixOrigin: 'WellKnown', AddressState: 'Preferred' }),
    ]
    return items.filter((i) => (!has(ctx, 'AddressFamily') || psEquals(i.AddressFamily, param(ctx, 'AddressFamily'))) && (!has(ctx, 'InterfaceAlias') || psEquals(i.InterfaceAlias, param(ctx, 'InterfaceAlias'))))
  },
})

cmdlet('Get-NetIPConfiguration', {
  synopsis: 'Gets IP network configuration.',
  module: 'NetTCPIP',
  run(ctx) {
    const r = netCfg(ctx.s)
    return [formatted(`\n\nInterfaceAlias       : Ethernet\nInterfaceIndex       : 6\nInterfaceDescription : Microsoft Hyper-V Network Adapter\nNetProfile.Name      : ${ctx.s.state.dominio ?? 'Network'}\nIPv4Address          : ${r.ip}\nIPv4DefaultGateway   : ${r.puerta_enlace}\nDNSServer            : ${r.dns.join('\n                       ')}\n\n`)]
  },
}, ['gip'])

cmdlet('ipconfig', {
  params: ['all'],
  switches: ['all'],
  synopsis: 'Displays all current TCP/IP network configuration values (ipconfig.exe).',
  run(ctx) {
    const r = netCfg(ctx.s)
    const all = ctx.positional.some((p) => toText(p).toLowerCase() === '/all')
    const mask = r.prefijo === 24 ? '255.255.255.0' : r.prefijo === 16 ? '255.255.0.0' : '255.255.255.0'
    const text = `\nWindows IP Configuration\n\n${all ? `   Host Name . . . . . . . . . . . . : ${ctx.s.state.equipo}\n   Primary Dns Suffix  . . . . . . . : ${ctx.s.state.dominio ?? ''}\n\n` : ''}\nEthernet adapter Ethernet:\n\n   Connection-specific DNS Suffix  . : \n${all ? '   Physical Address. . . . . . . . . : 00-15-5D-01-0A-14\n   DHCP Enabled. . . . . . . . . . . : No\n' : ''}   IPv4 Address. . . . . . . . . . . : ${r.ip}\n   Subnet Mask . . . . . . . . . . . : ${mask}\n   Default Gateway . . . . . . . . . : ${r.puerta_enlace}\n${all ? `   DNS Servers . . . . . . . . . . . : ${r.dns.join('\n                                       ')}\n` : ''}`
    return [formatted(text)]
  },
})

function reachable(s: PsSession, target: string): boolean {
  const r = netCfg(s)
  return target === '127.0.0.1' || target.toLowerCase() === 'localhost' || target === r.ip || target === r.puerta_enlace || r.alcanzables.some((a) => a.toLowerCase() === target.toLowerCase()) || r.dns.includes(target)
}

cmdlet('Test-Connection', {
  params: ['ComputerName', 'Count', 'TargetName'],
  switches: ['Quiet'],
  positional: ['ComputerName'],
  synopsis: 'Sends ICMP echo request packets, or pings, to one or more computers.',
  run(ctx) {
    const target = str(ctx, 'ComputerName') ?? str(ctx, 'TargetName') ?? ''
    const count = Number(param(ctx, 'Count') ?? 4)
    const ok = reachable(ctx.s, target)
    if (has(ctx, 'Quiet')) return [ok]
    if (!ok) {
      ctx.writeError(`Testing connection to computer '${target}' failed: Error due to lack of resources`, 'ResourceUnavailable', target)
      return []
    }
    return Array.from({ length: count }, () => psObject('System.Management.ManagementObject#root\\cimv2\\Win32_PingStatus', { Source: ctx.s.state.equipo, Destination: target, IPV4Address: target, Bytes: 32, 'Time(ms)': 1 }))
  },
})

cmdlet('ping', {
  synopsis: 'ping.exe',
  run(ctx) {
    const target = toText(ctx.positional.find((p) => !toText(p).startsWith('-')) ?? '')
    const ok = reachable(ctx.s, target)
    let text = `\nPinging ${target} with 32 bytes of data:\n`
    for (let i = 0; i < 4; i++) text += ok ? `Reply from ${target}: bytes=32 time<1ms TTL=128\n` : 'Request timed out.\n'
    text += `\nPing statistics for ${target}:\n    Packets: Sent = 4, Received = ${ok ? 4 : 0}, Lost = ${ok ? 0 : 4} (${ok ? 0 : 100}% loss),\n`
    return [formatted(text)]
  },
})

cmdlet('Test-NetConnection', {
  params: ['ComputerName', 'Port', 'CommonTCPPort'],
  switches: ['InformationLevel'],
  positional: ['ComputerName'],
  synopsis: 'Displays diagnostic information for a connection.',
  module: 'NetTCPIP',
  run(ctx) {
    const target = str(ctx, 'ComputerName') ?? 'internetbeacon.msedge.net'
    const ok = reachable(ctx.s, target)
    const port = param(ctx, 'Port')
    return [
      formatted(
        `\nComputerName     : ${target}\nRemoteAddress    : ${target}\n${port !== undefined ? `RemotePort       : ${toText(port)}\n` : ''}InterfaceAlias   : Ethernet\nSourceAddress    : ${netCfg(ctx.s).ip}\n${port !== undefined ? `TcpTestSucceeded : ${ok ? 'True' : 'False'}` : `PingSucceeded    : ${ok ? 'True' : 'False'}`}\n\n`,
      ),
    ]
  },
}, ['tnc'])

cmdlet('Resolve-DnsName', {
  params: ['Name', 'Type', 'Server'],
  positional: ['Name'],
  synopsis: 'Performs a DNS name query resolution for the specified name.',
  module: 'DnsClient',
  run(ctx) {
    const name = str(ctx, 'Name') ?? ''
    const records = (ctx.s.data.dnsRecords ?? []) as PsObject[]
    const type = (str(ctx, 'Type') ?? 'A').toUpperCase()
    const found = records.filter((r) => psEquals(r.Name, name) && psEquals(r.Type, type))
    if (!found.length) throw new PsError(`${name} : DNS name does not exist`, 'ResourceUnavailable', 'DNS_ERROR_RCODE_NAME_ERROR,Microsoft.DnsClient.Commands.ResolveDnsName', name)
    return found
  },
})

cmdlet('hostname', { synopsis: 'hostname.exe', run: (ctx) => [ctx.s.state.equipo] })
cmdlet('whoami', {
  synopsis: 'whoami.exe',
  run: (ctx) => [`${(ctx.s.state.dominio?.split('.')[0] ?? ctx.s.state.equipo).toLowerCase()}\\${ctx.s.state.usuario.toLowerCase()}`],
})

for (const n of ['Restart-Computer', 'Stop-Computer']) {
  cmdlet(n, {
    params: ['ComputerName'],
    switches: ['Force'],
    synopsis: n === 'Restart-Computer' ? 'Restarts the operating system on local and remote computers.' : 'Stops (shuts down) local and remote computers.',
    run(ctx) {
      ctx.host('[simulador] El servidor no se reinicia ni se apaga en el simulador.\n')
      return []
    },
  })
}

// ---------------------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------------------

cmdlet('Get-WinEvent', {
  params: ['LogName', 'MaxEvents', 'FilterHashtable', 'ProviderName'],
  switches: ['Oldest', 'ListLog'],
  positional: ['LogName'],
  synopsis: 'Gets events from event logs and event tracing log files on local and remote computers.',
  module: 'Microsoft.PowerShell.Diagnostics',
  run(ctx) {
    let events = [...data(ctx.s, 'events')].sort((a, b) => (b.TimeCreated as Date).getTime() - (a.TimeCreated as Date).getTime())
    const fh = param(ctx, 'FilterHashtable')
    const logName = fh instanceof Map ? getProp(fh, 'LogName') : param(ctx, 'LogName')
    if (logName !== null && logName !== undefined) events = events.filter((e) => asArray(logName).some((l) => psEquals(e.LogName, l)))
    if (fh instanceof Map) {
      const id = getProp(fh, 'Id')
      const level = getProp(fh, 'Level')
      const start = getProp(fh, 'StartTime')
      if (id !== null) events = events.filter((e) => asArray(id).some((x) => Number(x) === e.Id))
      if (level !== null) events = events.filter((e) => asArray(level).some((l) => ({ 1: 'Critical', 2: 'Error', 3: 'Warning', 4: 'Information' })[Number(l) as 1] === e.LevelDisplayName))
      if (start instanceof Date) events = events.filter((e) => (e.TimeCreated as Date) >= start)
    }
    if (has(ctx, 'ProviderName')) events = events.filter((e) => matchesAny(toText(e.ProviderName), list(ctx, 'ProviderName')))
    if (has(ctx, 'Oldest')) events.reverse()
    if (has(ctx, 'MaxEvents')) events = events.slice(0, Number(param(ctx, 'MaxEvents')))
    if (!events.length) throw new PsError('No events were found that match the specified selection criteria.', 'ObjectNotFound', 'NoMatchingEventsFound,Microsoft.PowerShell.Commands.GetWinEventCommand')
    return events
  },
})

cmdlet('Get-EventLog', {
  params: ['LogName', 'Newest', 'EntryType', 'Source', 'InstanceId'],
  positional: ['LogName'],
  synopsis: 'Gets the events in an event log, or a list of the event logs, on the local computer or remote computers.',
  run(ctx) {
    let events = [...data(ctx.s, 'events')].filter((e) => psEquals(e.LogName, param(ctx, 'LogName'))).sort((a, b) => (b.TimeCreated as Date).getTime() - (a.TimeCreated as Date).getTime())
    if (has(ctx, 'EntryType')) events = events.filter((e) => asArray(param(ctx, 'EntryType')).some((t) => psEquals(e.LevelDisplayName, t)))
    if (has(ctx, 'Newest')) events = events.slice(0, Number(param(ctx, 'Newest')))
    return events.map((e, i) => psObject('System.Diagnostics.EventLogEntry', { Index: 9000 - i, Time: formatDotnetDate(e.TimeCreated as Date, 'MMM dd HH:mm'), EntryType: e.LevelDisplayName, Source: e.ProviderName, InstanceID: e.Id, Message: e.Message }))
  },
})

export { setProp, truthy }
