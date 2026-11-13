/**
 * Administración remota: Invoke-Command, sesiones (New/Get/Remove/Enter-PSSession), Test-WSMan,
 * Enable-PSRemoting y TrustedHosts. Cada equipo es una PsSession propia del laboratorio.
 */
import { stableGuid } from './ad'
import { reach } from './machine'
import { parsePs, type Stmt } from './parser'
import { asArray, cmdlet, PsError, PsSession, wildcardToRegex, type CmdletContext } from './session'
import { isPsObject, isScriptBlock, psObject, toText, VIEWS, type PsObject, type ScriptBlock } from './values'


function param(ctx: CmdletContext, name: string): unknown {
  return ctx.params.get(name.toLowerCase())
}

function trusted(from: PsSession, target: string): boolean {
  const list = toText(from.data.trustedHosts?.[0] ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  return list.some((p) => wildcardToRegex(p).test(target))
}

/** Abre una conexión de WinRM con otro equipo, o explica por qué no se puede (como PowerShell). */
export function connect(from: PsSession, target: string): PsSession | PsError {
  const name = target
  const fail = (msg: string, id: string) => new PsError(`Connecting to remote server ${name} failed with the following error message : ${msg} For more information, see the about_Remote_Troubleshooting Help topic.`, 'OpenError', `${id},PSSessionStateBroken`, name)
  const local = ['localhost', '.', '127.0.0.1', from.state.equipo.toLowerCase()].includes(target.toLowerCase())
  const r = local ? { ok: true, target: from } : reach(from, target, 5985)
  if (!r.target) {
    if (from.state.dominio) return fail(`WinRM cannot process the request. The following error occurred while using Kerberos authentication: Cannot find the computer ${name}. Verify that the computer exists on the network and that the name provided is spelled correctly.`, 'NetworkPathNotFound')
    return fail('WinRM cannot complete the operation. Verify that the specified computer name is valid, that the computer is accessible over the network, and that a firewall exception for the WinRM service is enabled and allows access from this computer. By default, the WinRM firewall exception for public profiles limits access to remote computers within the same local subnet.', 'WinRMOperationTimeout')
  }
  const t = r.target
  if (!r.ok) {
    if ('reason' in r && r.reason === 'closed') return fail('The client cannot connect to the destination specified in the request. Verify that the service on the destination is running and is accepting requests. Consult the logs and documentation for the WS-Management service running on the destination, most commonly IIS or WinRM. If the destination is the WinRM service, run the following command on the destination to analyze and configure the WinRM service: "winrm quickconfig".', '2150858770')
    return fail('WinRM cannot complete the operation. Verify that the specified computer name is valid, that the computer is accessible over the network, and that a firewall exception for the WinRM service is enabled and allows access from this computer. By default, the WinRM firewall exception for public profiles limits access to remote computers within the same local subnet.', 'WinRMOperationTimeout')
  }
  if (t === from) return t
  // Kerberos solo sirve entre equipos del mismo dominio y por nombre; si no, hace falta TrustedHosts.
  const kerberos = !!from.state.dominio && from.state.dominio.toLowerCase() === t.state.dominio?.toLowerCase() && !/^\d+\.\d+\.\d+\.\d+$/.test(target)
  if (!kerberos && !trusted(from, target)) {
    return fail('The WinRM client cannot process the request. If the authentication scheme is different from Kerberos, or if the client computer is not joined to a domain, then HTTPS transport must be used or the destination machine must be added to the TrustedHosts configuration setting. Use winrm.cmd to configure TrustedHosts. Note that computers in the TrustedHosts list might not be authenticated. You can get more information about that by running the following command: winrm help config.', 'ServerNotTrusted')
  }
  if (kerberos && Math.abs(from.state.desfase_reloj_min - t.state.desfase_reloj_min) > 5) {
    return fail('WinRM cannot process the request. The following error with errorcode 0x80090324 occurred while using Kerberos authentication: There is a time and/or date difference between the client and server.', '-2144108387')
  }
  return t
}

/** Los objetos que vuelven de otro equipo llegan "deserializados": con PSComputerName y sin métodos. */
function tag(item: unknown, computer: string, hide: boolean): unknown {
  if (!isPsObject(item)) return item
  // La salida de un programa clásico (ipconfig, gpresult...) vuelve como texto.
  if (item.__type === '__formatted') return item
  const copy: PsObject = { ...item }
  for (const k of Object.keys(copy)) if (k.startsWith('__method_')) delete copy[k]
  copy.__type = item.__type.startsWith('Deserialized.') ? item.__type : `Deserialized.${item.__type}`
  if (!hide) copy.PSComputerName = computer
  copy.__runspaceId = stableGuid(`rs:${computer}`)
  return copy
}

function scriptBlockOf(ctx: CmdletContext): ScriptBlock {
  const sb = param(ctx, 'ScriptBlock')
  if (isScriptBlock(sb)) return sb
  const file = param(ctx, 'FilePath')
  if (file !== undefined) {
    const full = ctx.s.resolvePath(toText(file))
    const node = ctx.s.fs.get(full)
    if (!node || node.type !== 'file') throw new PsError(`Cannot find path '${full}' because it does not exist.`, 'ObjectNotFound', 'PathNotFound,Microsoft.PowerShell.Commands.InvokeCommandCommand', full)
    return { __sb: true, src: node.content, body: parsePs(node.content) }
  }
  throw new PsError("Cannot validate argument on parameter 'ScriptBlock'. The argument is null. Provide a valid value for the argument, and then try running the command again.", 'InvalidData', 'ParameterArgumentValidationError,Microsoft.PowerShell.Commands.InvokeCommandCommand')
}

/** Corre un bloque en otro equipo: $using: se resuelve acá, -ArgumentList va a param() o a $args. */
function runRemote(ctx: CmdletContext, remote: PsSession, sb: ScriptBlock, persistent: boolean): unknown[] {
  const using = new Map<string, unknown>()
  for (const m of sb.src.matchAll(/\$using:([A-Za-z_][A-Za-z0-9_]*)/gi)) using.set(m[1].toLowerCase(), ctx.s.getVar(m[1]))
  const args = asArray(param(ctx, 'ArgumentList')).map((v) => ({ k: 'value' as const, e: { k: 'lit', v } as never }))
  const body = sb.body as Stmt[]
  const exec = () => {
    remote.usingVars = using
    try {
      const params = body[0]?.k === 'param' ? body[0].params : []
      remote.bindParams('Invoke-Command', params, args)
      return remote.execBlock(body, ctx.errRaw, ctx.host)
    } finally {
      remote.usingVars = undefined
    }
  }
  // Con -ComputerName cada llamada es una sesión nueva; con -Session, las variables se conservan.
  return persistent ? exec() : remote.withScope(exec)
}

function sessions(s: PsSession): PsObject[] {
  return ((s.data.pssessions ??= []) as PsObject[])
}

function openSession(ctx: CmdletContext, computer: string): PsObject | undefined {
  const r = connect(ctx.s, computer)
  if (r instanceof PsError) {
    ctx.writeError(`[${computer}] ${r.message}`, r.category, computer, r.errorId)
    return undefined
  }
  const list = sessions(ctx.s)
  const id = (ctx.s.data.pssessionNext?.[0] as number | undefined) ?? 1
  ctx.s.data.pssessionNext = [id + 1]
  const o = psObject('System.Management.Automation.Runspaces.PSSession', { Id: id, Name: `WinRM${id}`, ComputerName: r.state.equipo, ComputerType: 'RemoteMachine', State: 'Opened', ConfigurationName: 'Microsoft.PowerShell', Availability: 'Available', __remote: r })
  list.push(o)
  return o
}

VIEWS['System.Management.Automation.Runspaces.PSSession'] = {
  kind: 'table',
  columns: [
    { label: 'Id', value: (o) => o.Id, align: 'right' },
    { label: 'Name', value: (o) => o.Name },
    { label: 'ComputerName', value: (o) => o.ComputerName },
    { label: 'ComputerType', value: (o) => o.ComputerType },
    { label: 'State', value: (o) => o.State },
    { label: 'ConfigurationName', value: (o) => o.ConfigurationName },
    { label: 'Availability', value: (o) => o.Availability },
  ],
}

cmdlet(
  'Invoke-Command',
  {
    params: ['ComputerName', 'ScriptBlock', 'FilePath', 'ArgumentList', 'Session', 'ThrottleLimit', 'JobName', 'ConfigurationName'],
    switches: ['HideComputerName', 'AsJob', 'EnableNetworkAccess'],
    synopsis: 'Runs commands on local and remote computers.',
    module: 'Microsoft.PowerShell.Core',
    run(ctx) {
      // Posicionales: Invoke-Command { ... } o Invoke-Command SRV01 { ... }
      for (const v of ctx.positional) {
        if (isScriptBlock(v) && !ctx.params.has('scriptblock')) ctx.params.set('scriptblock', v)
        else if (!isScriptBlock(v) && !ctx.params.has('computername')) ctx.params.set('computername', v)
      }
      const sb = scriptBlockOf(ctx)
      const hide = !!param(ctx, 'HideComputerName')
      const out: unknown[] = []
      const sess = asArray(param(ctx, 'Session')).filter(isPsObject)
      if (sess.length) {
        for (const so of sess) {
          const remote = so.__remote as PsSession
          if (so.State !== 'Opened') {
            ctx.writeError(`[${toText(so.ComputerName)}] The session state is Closed and cannot be used.`, 'InvalidOperation', toText(so.ComputerName))
            continue
          }
          out.push(...runRemote(ctx, remote, sb, true).map((x) => tag(x, remote.state.equipo, hide)))
        }
        return out
      }
      const computers = asArray(param(ctx, 'ComputerName')).map(toText)
      if (!computers.length) return ctx.s.withScope(() => runRemote(ctx, ctx.s, sb, true))
      for (const c of computers) {
        const remote = connect(ctx.s, c)
        if (remote instanceof PsError) {
          ctx.writeError(`[${c}] ${remote.message}`, remote.category, c, remote.errorId)
          continue
        }
        out.push(...runRemote(ctx, remote, sb, false).map((x) => tag(x, remote === ctx.s ? remote.state.equipo : remote.state.equipo, hide)))
      }
      return out
    },
  },
  ['icm'],
)

cmdlet(
  'New-PSSession',
  {
    params: ['ComputerName', 'Name', 'ConfigurationName'],
    positional: ['ComputerName'],
    synopsis: 'Creates a persistent connection to a local or remote computer.',
    module: 'Microsoft.PowerShell.Core',
    run(ctx) {
      const out: PsObject[] = []
      for (const c of asArray(param(ctx, 'ComputerName') ?? 'localhost').map(toText)) {
        const o = openSession(ctx, c)
        if (o) {
          if (param(ctx, 'Name')) o.Name = toText(param(ctx, 'Name'))
          out.push(o)
        }
      }
      return out
    },
  },
  ['nsn'],
)

cmdlet(
  'Get-PSSession',
  {
    params: ['ComputerName', 'Id', 'Name'],
    synopsis: 'Gets the PowerShell sessions on local and remote computers.',
    module: 'Microsoft.PowerShell.Core',
    run(ctx) {
      let list = sessions(ctx.s).filter((x) => x.State !== 'Removed')
      if (ctx.params.has('computername')) list = list.filter((x) => asArray(param(ctx, 'ComputerName')).some((c) => toText(c).toLowerCase() === toText(x.ComputerName).toLowerCase()))
      if (ctx.params.has('id')) list = list.filter((x) => asArray(param(ctx, 'Id')).some((i) => Number(i) === x.Id))
      return list
    },
  },
  ['gsn'],
)

cmdlet(
  'Remove-PSSession',
  {
    params: ['Session', 'Id', 'ComputerName', 'Name'],
    positional: ['Session'],
    synopsis: 'Closes one or more PowerShell sessions (PSSessions).',
    module: 'Microsoft.PowerShell.Core',
    run(ctx) {
      const targets = [...asArray(param(ctx, 'Session')), ...ctx.input].filter(isPsObject)
      const ids = asArray(param(ctx, 'Id')).map(Number)
      const comps = asArray(param(ctx, 'ComputerName')).map((c) => toText(c).toLowerCase())
      for (const so of sessions(ctx.s)) {
        if (targets.includes(so) || ids.includes(Number(so.Id)) || comps.includes(toText(so.ComputerName).toLowerCase())) so.State = 'Removed'
      }
      ctx.s.data.pssessions = sessions(ctx.s).filter((x) => x.State !== 'Removed')
      return []
    },
  },
  ['rsn'],
)

cmdlet(
  'Enter-PSSession',
  {
    params: ['ComputerName', 'Session', 'Id'],
    positional: ['ComputerName'],
    synopsis: 'Starts an interactive session with a remote computer.',
    module: 'Microsoft.PowerShell.Core',
    run(ctx) {
      if (ctx.s.isRemote) throw new PsError('Enter-PSSession : The command cannot be invoked within a remote session that was started with Enter-PSSession.', 'InvalidOperation', 'EnterPSSessionInRemoteSession')
      let remote: PsSession | undefined
      const so = param(ctx, 'Session')
      if (isPsObject(so)) remote = so.__remote as PsSession
      else if (ctx.params.has('id')) remote = sessions(ctx.s).find((x) => Number(x.Id) === Number(param(ctx, 'Id')))?.__remote as PsSession | undefined
      else {
        const c = toText(param(ctx, 'ComputerName'))
        const r = connect(ctx.s, c)
        if (r instanceof PsError) throw r
        remote = r
      }
      if (!remote) throw new PsError('The remote session could not be found.', 'InvalidArgument', 'RemoteSessionNotFound')
      if (remote === ctx.s) throw new PsError('Enter-PSSession : Connecting to the local computer is not supported in this simulator.', 'InvalidOperation', 'LocalComputer')
      remote.isRemote = true
      remote.cwd = `C:\\Users\\${remote.state.usuario}\\Documents`
      remote.fs.mkdirp(remote.cwd)
      ctx.s.activeRemote = remote
      return []
    },
  },
  ['etsn'],
)

cmdlet('Exit-PSSession', { synopsis: 'Ends an interactive session with a remote computer.', module: 'Microsoft.PowerShell.Core', run: () => [] }, ['exsn'])

cmdlet('Test-WSMan', {
  params: ['ComputerName', 'Authentication'],
  positional: ['ComputerName'],
  synopsis: 'Tests whether the WinRM service is running on a local or remote computer.',
  module: 'Microsoft.WSMan.Management',
  run(ctx) {
    const c = toText(param(ctx, 'ComputerName') ?? 'localhost')
    const local = ['localhost', '.', ctx.s.state.equipo.toLowerCase()].includes(c.toLowerCase())
    const r = local ? (ctx.s.data.winrm?.[0] ? { ok: true } : { ok: false, reason: 'closed' }) : reach(ctx.s, c, 5985)
    if (!r.ok) {
      const why = 'reason' in r && r.reason === 'closed' ? 'The client cannot connect to the destination specified in the request. Verify that the service on the destination is running and is accepting requests.' : 'WinRM cannot complete the operation. Verify that the specified computer name is valid, that the computer is accessible over the network, and that a firewall exception for the WinRM service is enabled and allows access from this computer.'
      throw new PsError(`<f:WSManFault xmlns:f="http://schemas.microsoft.com/wbem/wsman/1/wsmanfault" Code="2150858770" Machine="${ctx.s.state.equipo}"><f:Message>${why} </f:Message></f:WSManFault>`, 'InvalidOperation', 'WsManError,Microsoft.WSMan.Management.TestWSManCommand', c)
    }
    return [psObject('System.Xml.XmlElement#http://schemas.dmtf.org/wbem/wsman/identity/1/wsmanidentity.xsd#IdentifyResponse', { wsmid: 'http://schemas.dmtf.org/wbem/wsman/identity/1/wsmanidentity.xsd', ProtocolVersion: 'http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd', ProductVendor: 'Microsoft Corporation', ProductVersion: 'OS: 0.0.0 SP: 0.0 Stack: 3.0' })]
  },
})

function enableRemoting(s: PsSession, enable: boolean) {
  s.data.winrm = [enable]
  const svc = ((s.data.services ?? []) as PsObject[]).find((x) => toText(x.Name).toLowerCase() === 'winrm')
  if (svc && enable) {
    svc.Status = 'Running'
    svc.StartType = 'Automatic'
  }
  for (const r of (s.data.firewallRules ?? []) as PsObject[]) if (toText(r.DisplayGroup) === 'Windows Remote Management' && enable) r.Enabled = 'True'
}

cmdlet('Enable-PSRemoting', {
  switches: ['Force', 'SkipNetworkProfileCheck'],
  synopsis: 'Configures the computer to receive remote commands.',
  module: 'Microsoft.PowerShell.Core',
  run(ctx) {
    const already = !!ctx.s.data.winrm?.[0]
    enableRemoting(ctx.s, true)
    if (already) ctx.host('WinRM is already set up to receive requests on this computer.\nWinRM is already set up for remote management on this computer.\n')
    else ctx.host('WinRM has been updated to receive requests.\nWinRM service type changed successfully.\nWinRM service started.\n\nWinRM has been updated for remote management.\nCreated a WinRM listener on HTTP://* to accept WS-Man requests to any IP on this machine.\nWinRM firewall exception enabled.\nConfigured LocalAccountTokenFilterPolicy to grant administrative rights remotely to local users.\n')
    return []
  },
})

cmdlet('Disable-PSRemoting', {
  switches: ['Force'],
  synopsis: 'Prevents remote users from running commands on the local computer.',
  module: 'Microsoft.PowerShell.Core',
  run(ctx) {
    ctx.s.data.winrm = [false]
    ctx.host('WARNING: Disabling the session configurations does not undo all the changes made by the Enable-PSRemoting or Enable-PSSessionConfiguration cmdlet. You might have to manually undo the changes by following these steps:\n    1. Stop and disable the WinRM service.\n    2. Delete the listener that accepts requests on any IP address.\n    3. Disable the firewall exceptions for WS-Management communications.\n')
    return []
  },
})

cmdlet('winrm', {
  native: true,
  synopsis: 'winrm.cmd',
  run(ctx) {
    const a = ctx.positional.map((x) => toText(x).toLowerCase())
    if (a[0] === 'quickconfig' || a[0] === 'qc') {
      const already = !!ctx.s.data.winrm?.[0]
      enableRemoting(ctx.s, true)
      return [already ? 'WinRM service is already running on this machine.\nWinRM is already set up for remote management on this computer.' : 'WinRM service started.\nWinRM has been updated for remote management.\nCreated a WinRM listener on HTTP://* to accept WS-Man requests to any IP on this machine.\nWinRM firewall exception enabled.']
    }
    if (a[0] === 'get' && /winrm\/config\/client/.test(a[1] ?? '')) return [`Client\n    NetworkDelayms = 5000\n    URLPrefix = wsman\n    AllowUnencrypted = false\n    Auth\n        Basic = true\n        Digest = true\n        Kerberos = true\n        Negotiate = true\n        Certificate = true\n        CredSSP = false\n    DefaultPorts\n        HTTP = 5985\n        HTTPS = 5986\n    TrustedHosts = ${toText(ctx.s.data.trustedHosts?.[0] ?? '')}`]
    return ['Windows Remote Management Command Line Tool\n\n[simulador] Opciones disponibles: winrm quickconfig, winrm get winrm/config/client.']
  },
})

/** WSMan:\localhost\Client\TrustedHosts para Get-Item y Set-Item. */
export function wsmanItem(s: PsSession, path: string): PsObject | undefined {
  if (!/^wsman:\\localhost\\client\\trustedhosts$/i.test(path.replace(/\//g, '\\'))) return undefined
  return psObject('Microsoft.WSMan.Management.WSManConfigLeafElement', { WSManConfig: 'Microsoft.WSMan.Management\\WSMan::localhost\\Client', Type: 'System.String', Name: 'TrustedHosts', SourceOfValue: '', Value: toText(s.data.trustedHosts?.[0] ?? '') })
}

export function setTrustedHosts(ctx: CmdletContext, value: string, concatenate: boolean) {
  const current = toText(ctx.s.data.trustedHosts?.[0] ?? '')
  const next = concatenate && current ? `${current},${value}` : value
  if (!ctx.params.get('force')) ctx.host('[simulador] Sin -Force, PowerShell pide confirmar el cambio ("WinRM Security Configuration"); acá se da por aceptado.\n')
  ctx.s.data.trustedHosts = [next]
}
