/**
 * Hyper-V en Windows Server 2025: conmutadores virtuales, máquinas virtuales (generación 1 y 2,
 * memoria dinámica, procesadores, firmware), discos VHDX (dinámicos, fijos y diferenciales),
 * puntos de control, exportar e importar, VLAN y servicios de integración.
 *
 * El rol se instala con Install-WindowsFeature Hyper-V y recién funciona después de reiniciar.
 * Los discos son archivos del sistema de archivos del servidor con su tamaño virtual y lo que
 * ocupan; Remove-VM borra la máquina pero deja sus discos, como en el equipo real.
 */
import { BOOT_HOOKS, cmdlet, formatDotnetDate, PsError, PsSession, asArray, type CmdletContext } from './session'
import { psObject, toText, VIEWS, type PsObject } from './values'
import type { PsServerState } from './schema'

const GB = 1024 ** 3
const MB = 1024 ** 2

type HvState = NonNullable<PsServerState['hyperv']>

export interface HvSwitch {
  name: string
  type: 'External' | 'Internal' | 'Private'
  adapter?: string
  allowMgmt: boolean
  id: string
}

export interface HvCheckpoint {
  name: string
  type: 'Production' | 'Standard'
  created: number
  parent?: string
  id: string
}

export interface HvNic {
  name: string
  switchName?: string
  mac: string
  vlan?: number
}

export interface HvVm {
  name: string
  id: string
  state: 'Running' | 'Off' | 'Saved' | 'Paused'
  generation: 1 | 2
  cpus: number
  nested: boolean
  startup: number
  dynamic: boolean
  minimum: number
  maximum: number
  assigned: number
  disks: string[]
  dvd?: string
  nics: HvNic[]
  checkpoints: HvCheckpoint[]
  checkpointType: 'Production' | 'ProductionOnly' | 'Standard' | 'Disabled'
  secureBoot: boolean
  secureBootTemplate: string
  /** El sistema invitado es Linux (con la plantilla de arranque seguro de Windows no arranca). */
  linux: boolean
  /** El sistema invitado ya está instalado y tiene los servicios de integración. */
  guestReady: boolean
  autoStart: 'Nothing' | 'StartIfRunning' | 'Start'
  autoStop: 'Save' | 'TurnOff' | 'ShutDown'
  path: string
  startedAt?: number
  guestService: boolean
  notes: string
}

export interface HyperV {
  switches: HvSwitch[]
  vms: HvVm[]
  cpus: number
  memoryBytes: number
  vmPath: string
  vhdPath: string
}

const HV = new WeakMap<PsSession, HyperV>()

function guid(): string {
  const h = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('').toUpperCase()
  return `${h(8)}-${h(4)}-${h(4)}-${h(4)}-${h(12)}`
}

function newMac(): string {
  const b = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase()
  return `00155D${b()}${b()}${b()}`
}

const param = (ctx: CmdletContext, n: string) => ctx.params.get(n.toLowerCase())
const has = (ctx: CmdletContext, n: string) => ctx.params.has(n.toLowerCase())
const str = (ctx: CmdletContext, n: string) => (has(ctx, n) && param(ctx, n) !== null ? toText(param(ctx, n)) : undefined)
const num = (ctx: CmdletContext, n: string) => (has(ctx, n) ? Number(param(ctx, n)) : undefined)
const bool = (ctx: CmdletContext, n: string) => {
  if (!has(ctx, n)) return undefined
  const v = param(ctx, n)
  if (typeof v === 'boolean') return v
  if (v === undefined || v === null) return true
  return /^(true|on|1|\$true)$/i.test(toText(v))
}

function featureInstalled(s: PsSession) {
  return ((s.data.features ?? []) as PsObject[]).some((f) => toText(f.Name).toLowerCase() === 'hyper-v' && f.Installed)
}

/** El estado de Hyper-V del servidor (o un error si el rol no está o falta reiniciar). */
function hv(ctx: CmdletContext, cmd: string): HyperV {
  const s = ctx.s
  if (!featureInstalled(s)) throw new PsError(`The term '${cmd}' is not recognized as the name of a cmdlet, function, script file, or operable program.\n[simulador] Instalá el rol: Install-WindowsFeature Hyper-V -IncludeManagementTools -Restart`, 'ObjectNotFound', 'CommandNotFoundException', cmd)
  if (s.data.hvBooted?.[0] === false) throw new PsError(`The Hyper-V Management Tools could not access an expected WMI class on computer '${s.state.equipo}'. This may indicate that the Hyper-V Platform is not enabled on the computer or not fully installed.\n[simulador] Falta reiniciar el servidor después de instalar el rol (Restart-Computer).`, 'NotImplemented', `ObjectNotFound,Microsoft.HyperV.PowerShell.Commands.${cmd.replace('-', '')}Command`, '')
  let h = HV.get(s)
  if (!h) {
    const st = s.state.hyperv as HvState | undefined
    h = { switches: [], vms: [], cpus: st?.procesadores ?? 8, memoryBytes: (st?.memoria_gb ?? 32) * GB, vmPath: 'C:\\ProgramData\\Microsoft\\Windows\\Hyper-V', vhdPath: 'C:\\ProgramData\\Microsoft\\Windows\\Virtual Hard Disks' }
    HV.set(s, h)
  }
  return h
}

export function hyperVOf(s: PsSession): HyperV | undefined {
  return HV.get(s)
}

// ---------------------------------------------------------------------------------------
// Discos VHD/VHDX
// ---------------------------------------------------------------------------------------

export interface VhdMeta {
  format: 'VHDX' | 'VHD'
  type: 'Dynamic' | 'Fixed' | 'Differencing'
  size: number
  parent?: string
  id: string
}

export function readVhd(s: PsSession, path: string): VhdMeta | undefined {
  const node = s.fs.get(path)
  if (!node || node.type !== 'file' || !node.content.startsWith('vhd:')) return undefined
  try {
    return JSON.parse(node.content.slice(4)) as VhdMeta
  } catch {
    return undefined
  }
}

export function writeVhd(s: PsSession, path: string, meta: VhdMeta, fileSize: number) {
  s.fs.write(path, `vhd:${JSON.stringify(meta)}`)
  const node = s.fs.get(path)!
  node.size = Math.round(fileSize)
}

function vhdObject(s: PsSession, path: string, meta: VhdMeta): PsObject {
  const node = s.fs.get(path)!
  const attached = !!HV.get(s)?.vms.some((v) => v.disks.some((d) => d.toLowerCase() === path.toLowerCase()) && v.state === 'Running')
  return psObject('Microsoft.Vhd.PowerShell.VirtualHardDisk', {
    ComputerName: s.state.equipo,
    Path: path,
    VhdFormat: meta.format,
    VhdType: meta.type,
    FileSize: node.size ?? 0,
    Size: meta.size,
    MinimumSize: meta.size,
    LogicalSectorSize: 512,
    PhysicalSectorSize: 4096,
    BlockSize: meta.type === 'Fixed' ? 0 : 33554432,
    ParentPath: meta.parent ?? '',
    DiskIdentifier: meta.id,
    FragmentationPercentage: 0,
    Alignment: 1,
    Attached: attached,
    DiskNumber: null,
    IsPMEMCompatible: false,
    AddressAbstractionType: 'None',
    Number: null,
  })
}

function resolve(ctx: CmdletContext, p: string) {
  return ctx.s.resolvePath(p)
}

function vhdByPath(ctx: CmdletContext, raw: string, cmd: string): { path: string; meta: VhdMeta } {
  const path = resolve(ctx, raw)
  const meta = readVhd(ctx.s, path)
  if (!meta) {
    if (ctx.s.fs.get(path)) throw new PsError(`Failed to get the disk information.\nThe file or directory is corrupted and unreadable.`, 'InvalidArgument', `InvalidParameter,Microsoft.Vhd.PowerShell.Cmdlets.${cmd.replace('-', '')}`, raw)
    throw new PsError(`Getting the mounted storage instance for the path '${path}' failed.\nThe operation cannot be performed while the object is in use.\n\nCould not find file '${path}'.`, 'ObjectNotFound', `ObjectNotFound,Microsoft.Vhd.PowerShell.Cmdlets.${cmd.replace('-', '')}`, raw)
  }
  return { path, meta }
}

cmdlet('New-VHD', {
  params: ['Path', 'SizeBytes', 'ParentPath', 'BlockSizeBytes', 'ComputerName'],
  switches: ['Dynamic', 'Fixed', 'Differencing'],
  positional: ['Path', 'SizeBytes'],
  synopsis: 'Creates one or more new virtual hard disks.',
  module: 'Hyper-V',
  run(ctx) {
    hv(ctx, 'New-VHD')
    const raw = str(ctx, 'Path')
    if (!raw) throw new PsError(`Cannot process command because of one or more missing mandatory parameters: Path.`, 'InvalidArgument', 'MissingMandatoryParameter,Microsoft.Vhd.PowerShell.Cmdlets.NewVhd')
    const path = resolve(ctx, raw)
    if (ctx.s.fs.get(path)) throw new PsError(`Failed to create the virtual hard disk.\nThe system failed to create '${path}': The file exists. (0x80070050).`, 'ResourceExists', 'InvalidParameter,Microsoft.Vhd.PowerShell.Cmdlets.NewVhd', raw)
    const format = /\.vhd$/i.test(path) ? 'VHD' : 'VHDX'
    const parentRaw = str(ctx, 'ParentPath')
    if (parentRaw) {
      const parent = vhdByPath(ctx, parentRaw, 'New-VHD')
      const meta: VhdMeta = { format, type: 'Differencing', size: parent.meta.size, parent: parent.path, id: guid() }
      writeVhd(ctx.s, path, meta, 4 * MB)
      return [vhdObject(ctx.s, path, meta)]
    }
    const size = num(ctx, 'SizeBytes')
    if (!size) throw new PsError(`Cannot process command because of one or more missing mandatory parameters: SizeBytes.`, 'InvalidArgument', 'MissingMandatoryParameter,Microsoft.Vhd.PowerShell.Cmdlets.NewVhd')
    const type = has(ctx, 'Fixed') ? 'Fixed' : 'Dynamic'
    const meta: VhdMeta = { format, type, size, id: guid() }
    writeVhd(ctx.s, path, meta, type === 'Fixed' ? size + 4 * MB : 4 * MB)
    return [vhdObject(ctx.s, path, meta)]
  },
})

cmdlet('Get-VHD', {
  params: ['Path', 'VMId', 'ComputerName'],
  positional: ['Path'],
  synopsis: 'Gets the virtual hard disk object associated with a virtual hard disk.',
  module: 'Hyper-V',
  run(ctx) {
    hv(ctx, 'Get-VHD')
    return asArray(param(ctx, 'Path')).map((p) => {
      const v = vhdByPath(ctx, toText(p), 'Get-VHD')
      return vhdObject(ctx.s, v.path, v.meta)
    })
  },
})

cmdlet('Resize-VHD', {
  params: ['Path', 'SizeBytes', 'ComputerName'],
  switches: ['ToMinimumSize', 'Passthru'],
  positional: ['Path', 'SizeBytes'],
  synopsis: 'Resizes a virtual hard disk.',
  module: 'Hyper-V',
  run(ctx) {
    hv(ctx, 'Resize-VHD')
    const v = vhdByPath(ctx, str(ctx, 'Path') ?? '', 'Resize-VHD')
    const size = num(ctx, 'SizeBytes') ?? v.meta.size
    if (v.meta.type === 'Differencing') throw new PsError(`Failed to resize the virtual disk.\nThe system failed to resize '${v.path}': The requested operation could not be completed due to a virtual disk system limitation. Virtual hard disk files must be uncompressed and unencrypted and must not be sparse. (0xC03A001A).`, 'InvalidOperation', 'InvalidParameter,Microsoft.Vhd.PowerShell.Cmdlets.ResizeVhd', v.path)
    if (v.meta.format === 'VHD' && size < v.meta.size) throw new PsError(`Failed to resize the virtual disk.\nShrinking a VHD format virtual disk is not supported.`, 'InvalidOperation', 'InvalidParameter,Microsoft.Vhd.PowerShell.Cmdlets.ResizeVhd', v.path)
    const meta = { ...v.meta, size }
    const node = ctx.s.fs.get(v.path)!
    writeVhd(ctx.s, v.path, meta, meta.type === 'Fixed' ? size + 4 * MB : node.size ?? 4 * MB)
    return has(ctx, 'Passthru') ? [vhdObject(ctx.s, v.path, meta)] : []
  },
})

cmdlet('Convert-VHD', {
  params: ['Path', 'DestinationPath', 'VHDType', 'ParentPath', 'ComputerName'],
  switches: ['DeleteSource', 'Passthru'],
  positional: ['Path', 'DestinationPath'],
  synopsis: 'Converts the format, version type, and block size of a virtual hard disk file.',
  module: 'Hyper-V',
  run(ctx) {
    hv(ctx, 'Convert-VHD')
    const v = vhdByPath(ctx, str(ctx, 'Path') ?? '', 'Convert-VHD')
    const dest = resolve(ctx, str(ctx, 'DestinationPath') ?? '')
    if (ctx.s.fs.get(dest)) throw new PsError(`Failed to convert the virtual hard disk.\nThe file exists.`, 'ResourceExists', 'InvalidParameter,Microsoft.Vhd.PowerShell.Cmdlets.ConvertVhd', dest)
    const type = (str(ctx, 'VHDType') ?? (v.meta.type === 'Differencing' ? 'Dynamic' : v.meta.type)) as VhdMeta['type']
    const meta: VhdMeta = { format: /\.vhd$/i.test(dest) ? 'VHD' : 'VHDX', type, size: v.meta.size, id: guid() }
    const used = ctx.s.fs.get(v.path)!.size ?? 4 * MB
    writeVhd(ctx.s, dest, meta, type === 'Fixed' ? meta.size + 4 * MB : used)
    if (has(ctx, 'DeleteSource')) ctx.s.fs.remove(v.path)
    return has(ctx, 'Passthru') ? [vhdObject(ctx.s, dest, meta)] : []
  },
})

cmdlet('Optimize-VHD', {
  params: ['Path', 'Mode', 'ComputerName'],
  positional: ['Path'],
  synopsis: 'Optimizes the allocation of space used by virtual hard disk files.',
  module: 'Hyper-V',
  run(ctx) {
    hv(ctx, 'Optimize-VHD')
    const v = vhdByPath(ctx, str(ctx, 'Path') ?? '', 'Optimize-VHD')
    const node = ctx.s.fs.get(v.path)!
    if (v.meta.type === 'Dynamic') node.size = Math.max(4 * MB, Math.round((node.size ?? 0) * 0.82))
    return []
  },
})

// ---------------------------------------------------------------------------------------
// Conmutadores virtuales
// ---------------------------------------------------------------------------------------

function switchObject(sw: HvSwitch): PsObject {
  return psObject('Microsoft.HyperV.PowerShell.VMSwitch', { Name: sw.name, SwitchType: sw.type, NetAdapterInterfaceDescription: sw.adapter ? 'Microsoft Hyper-V Network Adapter' : '', AllowManagementOS: sw.allowMgmt, Id: sw.id, __toString: sw.name })
}
VIEWS['Microsoft.HyperV.PowerShell.VMSwitch'] = { kind: 'table', columns: ['Name', 'SwitchType', 'NetAdapterInterfaceDescription'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }

cmdlet('Get-VMSwitch', {
  params: ['Name', 'SwitchType', 'ComputerName'],
  positional: ['Name'],
  synopsis: 'Gets virtual switches from one or more virtual Hyper-V hosts.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Get-VMSwitch')
    const name = str(ctx, 'Name')
    const list = h.switches.filter((sw) => (!name || sw.name.toLowerCase() === name.toLowerCase()) && (!has(ctx, 'SwitchType') || sw.type.toLowerCase() === str(ctx, 'SwitchType')!.toLowerCase()))
    if (name && !list.length) throw new PsError(`Hyper-V was unable to find a virtual switch with name "${name}".`, 'InvalidArgument', 'InvalidParameter,Microsoft.HyperV.PowerShell.Commands.GetVMSwitch', name)
    return list.map(switchObject)
  },
})

cmdlet('New-VMSwitch', {
  params: ['Name', 'SwitchType', 'NetAdapterName', 'AllowManagementOS', 'ComputerName', 'Notes'],
  switches: ['EnableEmbeddedTeaming'],
  positional: ['Name'],
  synopsis: 'Creates a new virtual switch on one or more virtual machine hosts.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'New-VMSwitch')
    const name = str(ctx, 'Name')!
    if (h.switches.some((sw) => sw.name.toLowerCase() === name.toLowerCase())) throw new PsError(`Failed while adding virtual Ethernet switch connections.\nThe object already exists.`, 'ResourceExists', 'ObjectExists,Microsoft.HyperV.PowerShell.Commands.NewVMSwitch', name)
    const adapter = str(ctx, 'NetAdapterName')
    const type = str(ctx, 'SwitchType')
    if (!adapter && !type) throw new PsError(`Parameter set cannot be resolved using the specified named parameters. One or more parameters issued cannot be used together or an insufficient number of parameters were provided.`, 'InvalidArgument', 'AmbiguousParameterSet,Microsoft.HyperV.PowerShell.Commands.NewVMSwitch')
    if (adapter) {
      const real = ctx.s.state.red.adaptador
      if (adapter.toLowerCase() !== real.toLowerCase()) throw new PsError(`No MSFT_NetAdapter objects found with property 'Name' equal to '${adapter}'.  Verify the value of the property and retry.`, 'ObjectNotFound', 'CmdletizationQuery_NotFound_Name,Microsoft.HyperV.PowerShell.Commands.NewVMSwitch', adapter)
      if (h.switches.some((sw) => sw.type === 'External')) throw new PsError(`Failed while adding virtual Ethernet switch connections.\nThe network adapter is already bound to a virtual switch.`, 'InvalidOperation', 'InvalidParameter,Microsoft.HyperV.PowerShell.Commands.NewVMSwitch', adapter)
    }
    const sw: HvSwitch = { name, type: adapter ? 'External' : (/^internal$/i.test(type!) ? 'Internal' : 'Private'), adapter, allowMgmt: adapter ? bool(ctx, 'AllowManagementOS') ?? true : /^internal$/i.test(type ?? ''), id: guid() }
    h.switches.push(sw)
    if (adapter && sw.allowMgmt) ctx.host('[simulador] La red del servidor se corta unos segundos mientras la placa pasa a ser parte del conmutador.\n')
    return [switchObject(sw)]
  },
})

cmdlet('Remove-VMSwitch', {
  params: ['Name', 'ComputerName'],
  switches: ['Force'],
  positional: ['Name'],
  synopsis: 'Deletes a virtual switch.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Remove-VMSwitch')
    const name = str(ctx, 'Name')!
    const sw = h.switches.find((x) => x.name.toLowerCase() === name.toLowerCase())
    if (!sw) throw new PsError(`Hyper-V was unable to find a virtual switch with name "${name}".`, 'InvalidArgument', 'InvalidParameter,Microsoft.HyperV.PowerShell.Commands.RemoveVMSwitch', name)
    h.switches = h.switches.filter((x) => x !== sw)
    for (const vm of h.vms) for (const n of vm.nics) if (n.switchName === sw.name) n.switchName = undefined
    return []
  },
})

// ---------------------------------------------------------------------------------------
// Máquinas virtuales
// ---------------------------------------------------------------------------------------

function uptime(vm: HvVm) {
  if (vm.state !== 'Running' || !vm.startedAt) return '00:00:00'
  const ms = Date.now() - vm.startedAt + 37_000
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor((ms % 3_600_000) / 60_000))}:${p(Math.floor((ms % 60_000) / 1000))}.${String(ms % 1000).padStart(3, '0')}0000`
}

function bootsOk(vm: HvVm) {
  return !(vm.generation === 2 && vm.linux && vm.secureBoot && vm.secureBootTemplate === 'MicrosoftWindows')
}

function vmObject(vm: HvVm): PsObject {
  return psObject('Microsoft.HyperV.PowerShell.VirtualMachine', {
    Name: vm.name,
    State: vm.state,
    CPUUsage: vm.state === 'Running' ? 2 : 0,
    MemoryAssigned: vm.state === 'Running' ? vm.assigned : 0,
    MemoryStartup: vm.startup,
    MemoryMinimum: vm.minimum,
    MemoryMaximum: vm.maximum,
    DynamicMemoryEnabled: vm.dynamic,
    ProcessorCount: vm.cpus,
    Generation: vm.generation,
    Uptime: uptime(vm),
    Status: 'Operating normally',
    Version: '12.0',
    VMId: vm.id,
    Path: vm.path,
    CheckpointType: vm.checkpointType,
    AutomaticStartAction: vm.autoStart,
    AutomaticStopAction: vm.autoStop,
    Notes: vm.notes,
    Heartbeat: vm.state === 'Running' && vm.guestReady && bootsOk(vm) ? 'OkApplicationsUnknown' : vm.state === 'Running' ? 'NoContact' : null,
    __toString: vm.name,
  })
}
VIEWS['Microsoft.HyperV.PowerShell.VirtualMachine'] = {
  kind: 'table',
  columns: [
    { label: 'Name', value: (o) => o.Name },
    { label: 'State', value: (o) => o.State },
    { label: 'CPUUsage(%)', value: (o) => o.CPUUsage, align: 'right' },
    { label: 'MemoryAssigned(M)', value: (o) => Math.round(Number(o.MemoryAssigned) / MB), align: 'right' },
    { label: 'Uptime', value: (o) => o.Uptime },
    { label: 'Status', value: (o) => o.Status },
    { label: 'Version', value: (o) => o.Version },
  ],
}

function findVm(ctx: CmdletContext, h: HyperV, name: string | undefined, cmd: string): HvVm {
  const fromPipe = ctx.input.find((x) => (x as PsObject)?.__type === 'Microsoft.HyperV.PowerShell.VirtualMachine') as PsObject | undefined
  const n = name ?? (fromPipe ? toText(fromPipe.Name) : undefined)
  const vm = h.vms.find((v) => v.name.toLowerCase() === (n ?? '').toLowerCase())
  if (!vm) throw new PsError(`Hyper-V was unable to find a virtual machine with name "${n ?? ''}".`, 'InvalidArgument', `InvalidParameter,Microsoft.HyperV.PowerShell.Commands.${cmd.replace('-', '')}`, n ?? '')
  return vm
}

function vmName(ctx: CmdletContext) {
  return str(ctx, 'VMName') ?? str(ctx, 'Name')
}

function usedMemory(h: HyperV, except?: HvVm) {
  return h.vms.filter((v) => v.state === 'Running' && v !== except).reduce((s, v) => s + v.assigned, 0)
}

export function startVm(h: HyperV, vm: HvVm): string | undefined {
  const free = h.memoryBytes - 2 * GB - usedMemory(h, vm)
  const need = vm.dynamic ? vm.startup : vm.startup
  if (need > free) return `'${vm.name}' failed to start.\n\nNot enough memory in the system to start the virtual machine ${vm.name}.\n\n'${vm.name}' could not initialize memory: Ran out of memory (0x8007000E).`
  if (!vm.disks.length && !vm.dvd) {
    // Arranca igual: el firmware no encuentra con qué iniciar (lo muestra la consola).
  }
  vm.state = 'Running'
  vm.startedAt = Date.now()
  vm.assigned = vm.dynamic ? Math.min(vm.maximum, Math.max(vm.minimum, Math.round(vm.startup * 0.8))) : vm.startup
  return undefined
}

cmdlet('Get-VM', {
  params: ['Name', 'Id', 'ComputerName'],
  positional: ['Name'],
  synopsis: 'Gets the virtual machines from one or more Hyper-V hosts.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Get-VM')
    const names = asArray(param(ctx, 'Name')).map(toText)
    if (!names.length) return h.vms.map(vmObject)
    const out: PsObject[] = []
    for (const n of names) {
      const re = new RegExp(`^${n.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
      const found = h.vms.filter((v) => re.test(v.name))
      if (!found.length && !n.includes('*')) ctx.writeError(`Hyper-V was unable to find a virtual machine with name "${n}".`, 'InvalidArgument', n, 'InvalidParameter,Microsoft.HyperV.PowerShell.Commands.GetVM')
      out.push(...found.map(vmObject))
    }
    return out
  },
})

cmdlet('New-VM', {
  params: ['Name', 'MemoryStartupBytes', 'Generation', 'NewVHDPath', 'NewVHDSizeBytes', 'VHDPath', 'SwitchName', 'Path', 'BootDevice', 'Version', 'ComputerName'],
  switches: ['NoVHD', 'Prerelease', 'Force'],
  positional: ['Name'],
  synopsis: 'Creates a new virtual machine.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'New-VM')
    const name = str(ctx, 'Name') ?? 'New Virtual Machine'
    if (h.vms.some((v) => v.name.toLowerCase() === name.toLowerCase()) && !has(ctx, 'Force')) ctx.host(`WARNING: A virtual machine named "${name}" already exists. Hyper-V allows it, but tools that use the name will be confused.\n`)
    const gen = (num(ctx, 'Generation') ?? 1) as 1 | 2
    if (gen !== 1 && gen !== 2) throw new PsError(`Cannot validate argument on parameter 'Generation'. The ${gen} argument is greater than the maximum allowed range of 2.`, 'InvalidData', 'ParameterArgumentValidationError,Microsoft.HyperV.PowerShell.Commands.NewVM')
    const sw = str(ctx, 'SwitchName')
    if (sw && !h.switches.some((x) => x.name.toLowerCase() === sw.toLowerCase())) throw new PsError(`Hyper-V was unable to find a virtual switch with name "${sw}".`, 'InvalidArgument', 'InvalidParameter,Microsoft.HyperV.PowerShell.Commands.NewVM', sw)
    const disks: string[] = []
    const newVhd = str(ctx, 'NewVHDPath')
    if (newVhd) {
      const size = num(ctx, 'NewVHDSizeBytes')
      if (!size) throw new PsError(`Cannot process command because of one or more missing mandatory parameters: NewVHDSizeBytes.`, 'InvalidArgument', 'MissingMandatoryParameter,Microsoft.HyperV.PowerShell.Commands.NewVM')
      const path = resolve(ctx, newVhd.includes('\\') ? newVhd : `${h.vhdPath}\\${newVhd}`)
      if (ctx.s.fs.get(path)) throw new PsError(`Failed to create the virtual hard disk.\nThe file exists.`, 'ResourceExists', 'InvalidParameter,Microsoft.HyperV.PowerShell.Commands.NewVM', path)
      writeVhd(ctx.s, path, { format: /\.vhd$/i.test(path) ? 'VHD' : 'VHDX', type: 'Dynamic', size, id: guid() }, 4 * MB)
      disks.push(path)
    }
    const existing = str(ctx, 'VHDPath')
    if (existing) {
      const v = vhdByPath(ctx, existing, 'New-VM')
      if (gen === 2 && v.meta.format === 'VHD') throw new PsError(`Failed to add device 'Virtual Hard Disk'.\nThe hard disk image file '${v.path}' is a VHD; generation 2 virtual machines only support VHDX.`, 'InvalidArgument', 'InvalidParameter,Microsoft.HyperV.PowerShell.Commands.NewVM', v.path)
      disks.push(v.path)
    }
    const startup = num(ctx, 'MemoryStartupBytes') ?? (gen === 2 ? 1 * GB : 512 * MB)
    const base = str(ctx, 'Path') ? resolve(ctx, str(ctx, 'Path')!) : h.vmPath
    const vm: HvVm = {
      name,
      id: guid(),
      state: 'Off',
      generation: gen,
      cpus: 1,
      nested: false,
      startup,
      dynamic: false,
      minimum: 512 * MB,
      maximum: 1024 * GB,
      assigned: 0,
      disks,
      nics: [{ name: 'Network Adapter', switchName: sw ? h.switches.find((x) => x.name.toLowerCase() === sw.toLowerCase())!.name : undefined, mac: newMac() }],
      checkpoints: [],
      checkpointType: 'Production',
      secureBoot: gen === 2,
      secureBootTemplate: 'MicrosoftWindows',
      linux: false,
      guestReady: !!existing,
      autoStart: 'StartIfRunning',
      autoStop: 'Save',
      path: base,
      guestService: false,
      notes: '',
    }
    ctx.s.fs.mkdirp(`${base}\\Virtual Machines`)
    ctx.s.fs.write(`${base}\\Virtual Machines\\${vm.id}.vmcx`, `vmcx:${vm.name}`)
    h.vms.push(vm)
    return [vmObject(vm)]
  },
})

for (const [verb, synopsis] of [
  ['Start-VM', 'Starts a virtual machine.'],
  ['Stop-VM', 'Shuts down, turns off, or saves a virtual machine.'],
  ['Restart-VM', 'Restarts a virtual machine.'],
  ['Suspend-VM', 'Suspends, or pauses, a virtual machine.'],
  ['Resume-VM', 'Resumes a suspended (paused) virtual machine.'],
  ['Save-VM', 'Saves a virtual machine.'],
] as const) {
  cmdlet(verb, {
    params: ['Name', 'VM', 'ComputerName'],
    switches: ['Force', 'TurnOff', 'Save', 'Passthru', 'AsJob'],
    positional: ['Name'],
    synopsis,
    module: 'Hyper-V',
    run(ctx) {
      const h = hv(ctx, verb)
      const names = asArray(param(ctx, 'Name')).map(toText)
      const targets = names.length ? names.map((n) => findVm(ctx, h, n, verb)) : [findVm(ctx, h, undefined, verb)]
      for (const vm of targets) {
        if (verb === 'Start-VM') {
          if (vm.state === 'Running') {
            ctx.host(`WARNING: The virtual machine '${vm.name}' is already in the specified state.\n`)
            continue
          }
          const e = startVm(h, vm)
          if (e) throw new PsError(e, 'ResourceUnavailable', 'OutOfMemory,Microsoft.HyperV.PowerShell.Commands.StartVM', vm.name)
          continue
        }
        if (verb === 'Resume-VM') {
          if (vm.state === 'Paused') vm.state = 'Running'
          continue
        }
        if (vm.state === 'Off') {
          if (verb === 'Stop-VM') ctx.host(`WARNING: The virtual machine '${vm.name}' is already in the specified state.\n`)
          else throw new PsError(`The operation cannot be performed while the virtual machine is in its current state.`, 'InvalidOperation', `InvalidState,Microsoft.HyperV.PowerShell.Commands.${verb.replace('-', '')}`, vm.name)
          continue
        }
        if (verb === 'Suspend-VM') vm.state = 'Paused'
        else if (verb === 'Save-VM' || (verb === 'Stop-VM' && has(ctx, 'Save'))) {
          vm.state = 'Saved'
          vm.startedAt = undefined
        } else if (verb === 'Restart-VM') {
          if (!has(ctx, 'Force')) ctx.host(`[simulador] Sin -Force pide confirmación; se tomó como Sí.\n`)
          vm.startedAt = Date.now()
        } else {
          if (!has(ctx, 'TurnOff') && !(vm.guestReady && bootsOk(vm))) throw new PsError(`The virtual machine '${vm.name}' could not be shut down because the Shutdown integration service is not available. Use -TurnOff to power it off.`, 'NotImplemented', 'Unspecified,Microsoft.HyperV.PowerShell.Commands.StopVM', vm.name)
          vm.state = 'Off'
          vm.startedAt = undefined
          vm.assigned = 0
        }
      }
      return has(ctx, 'Passthru') ? targets.map(vmObject) : []
    },
  })
}

cmdlet('Remove-VM', {
  params: ['Name', 'ComputerName'],
  switches: ['Force'],
  positional: ['Name'],
  synopsis: 'Deletes a virtual machine.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Remove-VM')
    const vm = findVm(ctx, h, str(ctx, 'Name'), 'Remove-VM')
    if (vm.state === 'Running') throw new PsError(`The operation cannot be performed while the virtual machine is in its current state.\nTurn off the virtual machine before removing it.`, 'InvalidOperation', 'InvalidState,Microsoft.HyperV.PowerShell.Commands.RemoveVM', vm.name)
    if (!has(ctx, 'Force')) ctx.host(`[simulador] Sin -Force pide confirmación; se tomó como Sí.\n`)
    h.vms = h.vms.filter((x) => x !== vm)
    const cfg = `${vm.path}\\Virtual Machines\\${vm.id}.vmcx`
    if (ctx.s.fs.get(cfg)) ctx.s.fs.remove(cfg)
    return []
  },
})

cmdlet('Set-VM', {
  params: ['Name', 'ProcessorCount', 'MemoryStartupBytes', 'MemoryMinimumBytes', 'MemoryMaximumBytes', 'AutomaticStartAction', 'AutomaticStopAction', 'AutomaticStartDelay', 'CheckpointType', 'Notes', 'NewVMName', 'SnapshotFileLocation', 'ComputerName'],
  switches: ['DynamicMemory', 'StaticMemory', 'Passthru'],
  positional: ['Name'],
  synopsis: 'Configures a virtual machine.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Set-VM')
    const vm = findVm(ctx, h, str(ctx, 'Name'), 'Set-VM')
    const running = vm.state !== 'Off'
    if (has(ctx, 'ProcessorCount')) {
      if (running) throw new PsError(`Failed to modify device 'Processor'.\nChanging the number of virtual processors of a running virtual machine is not supported.`, 'InvalidOperation', 'InvalidState,Microsoft.HyperV.PowerShell.Commands.SetVM', vm.name)
      const n = num(ctx, 'ProcessorCount')!
      if (n > h.cpus) throw new PsError(`Failed to modify device 'Processor'.\nThe virtual machine '${vm.name}' has more virtual processors (${n}) than the number of logical processors on the host (${h.cpus}).`, 'InvalidArgument', 'InvalidParameter,Microsoft.HyperV.PowerShell.Commands.SetVM', vm.name)
      vm.cpus = n
    }
    if ((has(ctx, 'DynamicMemory') || has(ctx, 'StaticMemory')) && running) throw new PsError(`Failed to modify device 'Memory'.\nDynamic memory cannot be enabled or disabled while the virtual machine is running.`, 'InvalidOperation', 'InvalidState,Microsoft.HyperV.PowerShell.Commands.SetVM', vm.name)
    if (has(ctx, 'DynamicMemory')) vm.dynamic = true
    if (has(ctx, 'StaticMemory')) vm.dynamic = false
    if (has(ctx, 'MemoryStartupBytes')) {
      if (running && !vm.dynamic) throw new PsError(`Failed to modify device 'Memory'.\nThe startup memory of a running virtual machine with static memory cannot be changed.`, 'InvalidOperation', 'InvalidState,Microsoft.HyperV.PowerShell.Commands.SetVM', vm.name)
      vm.startup = num(ctx, 'MemoryStartupBytes')!
    }
    if (has(ctx, 'MemoryMinimumBytes')) vm.minimum = num(ctx, 'MemoryMinimumBytes')!
    if (has(ctx, 'MemoryMaximumBytes')) vm.maximum = num(ctx, 'MemoryMaximumBytes')!
    if (vm.dynamic && (vm.minimum > vm.startup || vm.startup > vm.maximum)) throw new PsError(`Failed to modify device 'Memory'.\nThe minimum memory must be less than or equal to the startup memory, and the startup memory less than or equal to the maximum.`, 'InvalidArgument', 'InvalidParameter,Microsoft.HyperV.PowerShell.Commands.SetVM', vm.name)
    if (has(ctx, 'AutomaticStartAction')) vm.autoStart = str(ctx, 'AutomaticStartAction') as HvVm['autoStart']
    if (has(ctx, 'AutomaticStopAction')) vm.autoStop = str(ctx, 'AutomaticStopAction') as HvVm['autoStop']
    if (has(ctx, 'CheckpointType')) vm.checkpointType = str(ctx, 'CheckpointType') as HvVm['checkpointType']
    if (has(ctx, 'Notes')) vm.notes = str(ctx, 'Notes')!
    if (has(ctx, 'NewVMName')) vm.name = str(ctx, 'NewVMName')!
    return has(ctx, 'Passthru') ? [vmObject(vm)] : []
  },
})

cmdlet('Set-VMProcessor', {
  params: ['VMName', 'Count', 'ExposeVirtualizationExtensions', 'Reserve', 'Maximum', 'RelativeWeight', 'CompatibilityForMigrationEnabled', 'ComputerName'],
  switches: ['Passthru'],
  positional: ['VMName'],
  synopsis: 'Configures one or more processors of a virtual machine.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Set-VMProcessor')
    const vm = findVm(ctx, h, vmName(ctx), 'Set-VMProcessor')
    if (vm.state !== 'Off' && (has(ctx, 'Count') || has(ctx, 'ExposeVirtualizationExtensions'))) throw new PsError(`Failed to modify device 'Processor'.\nThe operation cannot be performed while the virtual machine is in its current state.`, 'InvalidOperation', 'InvalidState,Microsoft.HyperV.PowerShell.Commands.SetVMProcessor', vm.name)
    if (has(ctx, 'Count')) {
      const n = num(ctx, 'Count')!
      if (n > h.cpus) throw new PsError(`Failed to modify device 'Processor'.\nThe virtual machine '${vm.name}' has more virtual processors (${n}) than the number of logical processors on the host (${h.cpus}).`, 'InvalidArgument', 'InvalidParameter,Microsoft.HyperV.PowerShell.Commands.SetVMProcessor', vm.name)
      vm.cpus = n
    }
    if (has(ctx, 'ExposeVirtualizationExtensions')) vm.nested = !!bool(ctx, 'ExposeVirtualizationExtensions')
    return []
  },
})

function memObject(vm: HvVm): PsObject {
  return psObject('Microsoft.HyperV.PowerShell.VMMemory', { VMName: vm.name, DynamicMemoryEnabled: vm.dynamic, Minimum: vm.minimum, Startup: vm.startup, Maximum: vm.maximum, Buffer: 20, Priority: 50 })
}
VIEWS['Microsoft.HyperV.PowerShell.VMMemory'] = {
  kind: 'table',
  columns: [
    { label: 'VMName', value: (o) => o.VMName },
    { label: 'DynamicMemoryEnabled', value: (o) => o.DynamicMemoryEnabled },
    { label: 'Minimum(M)', value: (o) => Math.round(Number(o.Minimum) / MB), align: 'right' },
    { label: 'Startup(M)', value: (o) => Math.round(Number(o.Startup) / MB), align: 'right' },
    { label: 'Maximum(M)', value: (o) => Math.round(Number(o.Maximum) / MB), align: 'right' },
  ],
}

cmdlet('Get-VMMemory', {
  params: ['VMName', 'ComputerName'],
  positional: ['VMName'],
  synopsis: 'Gets the memory of a virtual machine.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Get-VMMemory')
    return [memObject(findVm(ctx, h, vmName(ctx), 'Get-VMMemory'))]
  },
})

cmdlet('Set-VMMemory', {
  params: ['VMName', 'DynamicMemoryEnabled', 'StartupBytes', 'MinimumBytes', 'MaximumBytes', 'Buffer', 'Priority', 'ComputerName'],
  switches: ['Passthru'],
  positional: ['VMName'],
  synopsis: 'Configures the memory of a virtual machine.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Set-VMMemory')
    const vm = findVm(ctx, h, vmName(ctx), 'Set-VMMemory')
    const running = vm.state !== 'Off'
    if (has(ctx, 'DynamicMemoryEnabled')) {
      if (running) throw new PsError(`Failed to modify device 'Memory'.\nDynamic memory cannot be enabled or disabled while the virtual machine is running.`, 'InvalidOperation', 'InvalidState,Microsoft.HyperV.PowerShell.Commands.SetVMMemory', vm.name)
      vm.dynamic = !!bool(ctx, 'DynamicMemoryEnabled')
    }
    if (has(ctx, 'StartupBytes')) vm.startup = num(ctx, 'StartupBytes')!
    if (has(ctx, 'MinimumBytes')) {
      if (running && num(ctx, 'MinimumBytes')! > vm.minimum) throw new PsError(`Failed to modify device 'Memory'.\nThe minimum memory of a running virtual machine can only be decreased.`, 'InvalidOperation', 'InvalidState,Microsoft.HyperV.PowerShell.Commands.SetVMMemory', vm.name)
      vm.minimum = num(ctx, 'MinimumBytes')!
    }
    if (has(ctx, 'MaximumBytes')) {
      if (running && num(ctx, 'MaximumBytes')! < vm.maximum) throw new PsError(`Failed to modify device 'Memory'.\nThe maximum memory of a running virtual machine can only be increased.`, 'InvalidOperation', 'InvalidState,Microsoft.HyperV.PowerShell.Commands.SetVMMemory', vm.name)
      vm.maximum = num(ctx, 'MaximumBytes')!
    }
    if (vm.dynamic && (vm.minimum > vm.startup || vm.startup > vm.maximum)) throw new PsError(`Failed to modify device 'Memory'.\nThe minimum memory must be less than or equal to the startup memory, and the startup memory less than or equal to the maximum.`, 'InvalidArgument', 'InvalidParameter,Microsoft.HyperV.PowerShell.Commands.SetVMMemory', vm.name)
    return has(ctx, 'Passthru') ? [memObject(vm)] : []
  },
})

cmdlet('Set-VMFirmware', {
  params: ['VMName', 'EnableSecureBoot', 'SecureBootTemplate', 'FirstBootDevice', 'ComputerName'],
  switches: ['Passthru'],
  positional: ['VMName'],
  synopsis: 'Sets the firmware configuration of a virtual machine.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Set-VMFirmware')
    const vm = findVm(ctx, h, vmName(ctx), 'Set-VMFirmware')
    if (vm.generation !== 2) throw new PsError(`The cmdlet only supports generation 2 virtual machines.`, 'InvalidArgument', 'InvalidParameter,Microsoft.HyperV.PowerShell.Commands.SetVMFirmware', vm.name)
    if (vm.state !== 'Off') throw new PsError(`The operation cannot be performed while the virtual machine is in its current state.`, 'InvalidOperation', 'InvalidState,Microsoft.HyperV.PowerShell.Commands.SetVMFirmware', vm.name)
    if (has(ctx, 'EnableSecureBoot')) vm.secureBoot = /^on$/i.test(str(ctx, 'EnableSecureBoot')!)
    if (has(ctx, 'SecureBootTemplate')) {
      const t = str(ctx, 'SecureBootTemplate')!
      if (!/^(MicrosoftWindows|MicrosoftUEFICertificateAuthority|OpenSourceShieldedVM)$/i.test(t)) throw new PsError(`Cannot find a secure boot template with the name '${t}'.`, 'InvalidArgument', 'InvalidParameter,Microsoft.HyperV.PowerShell.Commands.SetVMFirmware', t)
      vm.secureBootTemplate = /^microsoftwindows$/i.test(t) ? 'MicrosoftWindows' : /^microsoftuefi/i.test(t) ? 'MicrosoftUEFICertificateAuthority' : 'OpenSourceShieldedVM'
    }
    return []
  },
})

cmdlet('Get-VMFirmware', {
  params: ['VMName', 'ComputerName'],
  positional: ['VMName'],
  synopsis: 'Gets the firmware configuration of a virtual machine.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Get-VMFirmware')
    const vm = findVm(ctx, h, vmName(ctx), 'Get-VMFirmware')
    if (vm.generation !== 2) throw new PsError(`The cmdlet only supports generation 2 virtual machines.`, 'InvalidArgument', 'InvalidParameter,Microsoft.HyperV.PowerShell.Commands.GetVMFirmware', vm.name)
    return [psObject('Microsoft.HyperV.PowerShell.VMFirmware', { VMName: vm.name, SecureBoot: vm.secureBoot ? 'On' : 'Off', SecureBootTemplate: vm.secureBootTemplate, PreferredNetworkBootProtocol: 'IPv4', BootOrder: '{File, Drive, Drive, Network}' })]
  },
})
VIEWS['Microsoft.HyperV.PowerShell.VMFirmware'] = { kind: 'table', columns: ['VMName', 'SecureBoot', 'SecureBootTemplate', 'PreferredNetworkBootProtocol', 'BootOrder'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }

// ---------------------------------------------------------------------------------------
// Discos, DVD y red de cada VM
// ---------------------------------------------------------------------------------------

cmdlet('Add-VMHardDiskDrive', {
  params: ['VMName', 'Path', 'ControllerType', 'ControllerNumber', 'ControllerLocation', 'ComputerName'],
  switches: ['Passthru'],
  positional: ['VMName', 'Path'],
  synopsis: 'Adds a hard disk drive to a virtual machine.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Add-VMHardDiskDrive')
    const vm = findVm(ctx, h, vmName(ctx), 'Add-VMHardDiskDrive')
    const v = vhdByPath(ctx, str(ctx, 'Path') ?? '', 'Add-VMHardDiskDrive')
    if (vm.generation === 2 && v.meta.format === 'VHD') throw new PsError(`Failed to add device 'Virtual Hard Disk'.\nGeneration 2 virtual machines only support VHDX.`, 'InvalidArgument', 'InvalidParameter,Microsoft.HyperV.PowerShell.Commands.AddVMHardDiskDrive', v.path)
    if (h.vms.some((x) => x.disks.some((d) => d.toLowerCase() === v.path.toLowerCase()))) throw new PsError(`Failed to add device 'Virtual Hard Disk'.\nThe process cannot access the file '${v.path}' because it is being used by another process.`, 'ResourceBusy', 'InvalidParameter,Microsoft.HyperV.PowerShell.Commands.AddVMHardDiskDrive', v.path)
    vm.disks.push(v.path)
    if (vm.disks.length === 1) vm.guestReady = true
    return []
  },
})

cmdlet('Get-VMHardDiskDrive', {
  params: ['VMName', 'ComputerName'],
  positional: ['VMName'],
  synopsis: 'Gets the virtual hard disk drives attached to one or more virtual machines.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Get-VMHardDiskDrive')
    const vm = findVm(ctx, h, vmName(ctx), 'Get-VMHardDiskDrive')
    return vm.disks.map((d, i) => psObject('Microsoft.HyperV.PowerShell.HardDiskDrive', { VMName: vm.name, ControllerType: vm.generation === 2 ? 'SCSI' : 'IDE', ControllerNumber: 0, ControllerLocation: i, DiskNumber: null, Path: d }))
  },
})
VIEWS['Microsoft.HyperV.PowerShell.HardDiskDrive'] = { kind: 'table', columns: ['VMName', 'ControllerType', 'ControllerNumber', 'ControllerLocation', 'DiskNumber', 'Path'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }

cmdlet(['Add-VMDvdDrive', 'Set-VMDvdDrive'], {
  params: ['VMName', 'Path', 'ControllerNumber', 'ControllerLocation', 'ComputerName'],
  switches: ['Passthru'],
  positional: ['VMName', 'Path'],
  synopsis: 'Adds or configures a DVD drive of a virtual machine.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Add-VMDvdDrive')
    const vm = findVm(ctx, h, vmName(ctx), 'Add-VMDvdDrive')
    const p = str(ctx, 'Path')
    if (p) {
      const path = resolve(ctx, p)
      if (!ctx.s.fs.get(path)) throw new PsError(`Failed to add device 'Virtual CD/DVD Disk'.\nThe system cannot find the file specified. '${path}'`, 'ObjectNotFound', 'ObjectNotFound,Microsoft.HyperV.PowerShell.Commands.AddVMDvdDrive', path)
      vm.dvd = path
      if (/ubuntu|debian|rocky|alma|linux/i.test(path)) vm.linux = true
    } else vm.dvd = undefined
    return []
  },
})

function nicObject(vm: HvVm, n: HvNic): PsObject {
  const ip = vm.state === 'Running' && vm.guestReady && bootsOk(vm) && n.switchName ? [`192.168.${n.vlan ?? 1}.${50 + (vm.name.length * 7) % 150}`, `fe80::215:5dff:fe${n.mac.slice(6, 8).toLowerCase()}:${n.mac.slice(8).toLowerCase()}`] : []
  return psObject('Microsoft.HyperV.PowerShell.VMNetworkAdapter', { Name: n.name, IsManagementOs: false, VMName: vm.name, SwitchName: n.switchName ?? '', MacAddress: n.mac, Status: vm.state === 'Running' ? '{Ok}' : '{}', IPAddresses: ip })
}
VIEWS['Microsoft.HyperV.PowerShell.VMNetworkAdapter'] = { kind: 'table', columns: ['Name', 'IsManagementOs', 'VMName', 'SwitchName', 'MacAddress', 'Status', 'IPAddresses'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }

cmdlet('Get-VMNetworkAdapter', {
  params: ['VMName', 'Name', 'ComputerName'],
  switches: ['ManagementOS', 'All'],
  positional: ['VMName'],
  synopsis: 'Gets the virtual network adapters of a virtual machine.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Get-VMNetworkAdapter')
    if (has(ctx, 'ManagementOS')) return h.switches.filter((s) => s.allowMgmt).map((s) => psObject('Microsoft.HyperV.PowerShell.VMNetworkAdapter', { Name: s.name, IsManagementOs: true, VMName: '', SwitchName: s.name, MacAddress: newMac(), Status: '{Ok}', IPAddresses: [] }))
    const vms = vmName(ctx) ? [findVm(ctx, h, vmName(ctx), 'Get-VMNetworkAdapter')] : h.vms
    return vms.flatMap((vm) => vm.nics.map((n) => nicObject(vm, n)))
  },
})

cmdlet(['Connect-VMNetworkAdapter', 'Disconnect-VMNetworkAdapter', 'Add-VMNetworkAdapter'], {
  params: ['VMName', 'SwitchName', 'Name', 'ComputerName'],
  switches: ['Passthru'],
  positional: ['VMName'],
  synopsis: 'Connects, disconnects or adds a virtual network adapter.',
  module: 'Hyper-V',
  run(ctx) {
    const cmd = ctx.name.toLowerCase().startsWith('connect') ? 'Connect-VMNetworkAdapter' : ctx.name.toLowerCase().startsWith('disconnect') ? 'Disconnect-VMNetworkAdapter' : 'Add-VMNetworkAdapter'
    const h = hv(ctx, cmd)
    const vm = findVm(ctx, h, vmName(ctx), cmd)
    const swName = str(ctx, 'SwitchName')
    const sw = swName ? h.switches.find((x) => x.name.toLowerCase() === swName.toLowerCase()) : undefined
    if (swName && !sw) throw new PsError(`Hyper-V was unable to find a virtual switch with name "${swName}".`, 'InvalidArgument', `InvalidParameter,Microsoft.HyperV.PowerShell.Commands.${cmd.replace(/-/g, '')}`, swName)
    if (cmd === 'Add-VMNetworkAdapter') {
      if (vm.state !== 'Off' && vm.generation === 1) throw new PsError(`Failed to add device 'Ethernet Connection'.\nThe operation cannot be performed while the virtual machine is in its current state.`, 'InvalidOperation', 'InvalidState,Microsoft.HyperV.PowerShell.Commands.AddVMNetworkAdapter', vm.name)
      vm.nics.push({ name: str(ctx, 'Name') ?? 'Network Adapter', switchName: sw?.name, mac: newMac() })
      return []
    }
    const nics = str(ctx, 'Name') ? vm.nics.filter((n) => n.name.toLowerCase() === str(ctx, 'Name')!.toLowerCase()) : vm.nics
    for (const n of nics) n.switchName = cmd === 'Connect-VMNetworkAdapter' ? sw?.name : undefined
    return []
  },
})

cmdlet('Set-VMNetworkAdapterVlan', {
  params: ['VMName', 'VlanId', 'VMNetworkAdapterName', 'ComputerName'],
  switches: ['Access', 'Untagged', 'Trunk', 'Passthru'],
  positional: ['VMName'],
  synopsis: 'Configures the virtual LAN settings of a virtual network adapter.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Set-VMNetworkAdapterVlan')
    const vm = findVm(ctx, h, vmName(ctx), 'Set-VMNetworkAdapterVlan')
    if (has(ctx, 'Access') && !has(ctx, 'VlanId')) throw new PsError(`Cannot process command because of one or more missing mandatory parameters: VlanId.`, 'InvalidArgument', 'MissingMandatoryParameter,Microsoft.HyperV.PowerShell.Commands.SetVMNetworkAdapterVlan')
    for (const n of vm.nics) n.vlan = has(ctx, 'Untagged') ? undefined : num(ctx, 'VlanId')
    return []
  },
})

cmdlet('Get-VMNetworkAdapterVlan', {
  params: ['VMName', 'ComputerName'],
  positional: ['VMName'],
  synopsis: 'Gets the virtual LAN settings of a virtual network adapter.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Get-VMNetworkAdapterVlan')
    const vms = vmName(ctx) ? [findVm(ctx, h, vmName(ctx), 'Get-VMNetworkAdapterVlan')] : h.vms
    return vms.flatMap((vm) => vm.nics.map((n) => psObject('Microsoft.HyperV.PowerShell.VMNetworkAdapterVlanSetting', { VMName: vm.name, VMNetworkAdapterName: n.name, Mode: n.vlan ? 'Access' : 'Untagged', VlanList: n.vlan ?? '' })))
  },
})
VIEWS['Microsoft.HyperV.PowerShell.VMNetworkAdapterVlanSetting'] = { kind: 'table', columns: ['VMName', 'VMNetworkAdapterName', 'Mode', 'VlanList'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }

const INTEGRATION = ['Guest Service Interface', 'Heartbeat', 'Key-Value Pair Exchange', 'Shutdown', 'Time Synchronization', 'VSS']

cmdlet('Get-VMIntegrationService', {
  params: ['VMName', 'Name', 'ComputerName'],
  positional: ['VMName'],
  synopsis: 'Gets the integration services of a virtual machine.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Get-VMIntegrationService')
    const vm = findVm(ctx, h, vmName(ctx), 'Get-VMIntegrationService')
    const ok = vm.state === 'Running' && vm.guestReady && bootsOk(vm)
    return INTEGRATION.map((n) => {
      const enabled = n === 'Guest Service Interface' ? vm.guestService : true
      return psObject('Microsoft.HyperV.PowerShell.VMIntegrationComponent', { VMName: vm.name, Name: n, Enabled: enabled, PrimaryStatusDescription: !enabled || vm.state !== 'Running' ? '' : ok ? 'OK' : 'No Contact', SecondaryStatusDescription: '' })
    })
  },
})
VIEWS['Microsoft.HyperV.PowerShell.VMIntegrationComponent'] = { kind: 'table', columns: ['VMName', 'Name', 'Enabled', 'PrimaryStatusDescription', 'SecondaryStatusDescription'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }

cmdlet(['Enable-VMIntegrationService', 'Disable-VMIntegrationService'], {
  params: ['VMName', 'Name', 'ComputerName'],
  switches: ['Passthru'],
  positional: ['Name', 'VMName'],
  synopsis: 'Enables or disables an integration service on a virtual machine.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, ctx.name)
    const vm = findVm(ctx, h, str(ctx, 'VMName'), ctx.name)
    const n = str(ctx, 'Name') ?? ''
    if (!INTEGRATION.some((x) => x.toLowerCase() === n.toLowerCase())) throw new PsError(`An integration service named "${n}" was not found.`, 'ObjectNotFound', 'ObjectNotFound,Microsoft.HyperV.PowerShell.Commands.EnableVMIntegrationService', n)
    if (/guest service/i.test(n)) vm.guestService = /^enable/i.test(ctx.name)
    return []
  },
})

// ---------------------------------------------------------------------------------------
// Puntos de control
// ---------------------------------------------------------------------------------------

function cpObject(vm: HvVm, c: HvCheckpoint): PsObject {
  return psObject('Microsoft.HyperV.PowerShell.VMCheckpoint', { VMName: vm.name, Name: c.name, SnapshotType: c.type, CreationTime: new Date(c.created), ParentSnapshotName: c.parent ?? '', Id: c.id })
}
VIEWS['Microsoft.HyperV.PowerShell.VMCheckpoint'] = {
  kind: 'table',
  columns: [
    { label: 'VMName', value: (o) => o.VMName },
    { label: 'Name', value: (o) => o.Name },
    { label: 'SnapshotType', value: (o) => o.SnapshotType },
    { label: 'CreationTime', value: (o) => formatDotnetDate(o.CreationTime as Date, 'M/d/yyyy h:mm:ss tt') },
    { label: 'ParentSnapshotName', value: (o) => o.ParentSnapshotName },
  ],
}

cmdlet('Checkpoint-VM', {
  params: ['Name', 'SnapshotName', 'ComputerName'],
  switches: ['Passthru', 'AsJob'],
  positional: ['Name', 'SnapshotName'],
  synopsis: 'Creates a checkpoint of a virtual machine.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Checkpoint-VM')
    const vm = findVm(ctx, h, str(ctx, 'Name'), 'Checkpoint-VM')
    if (vm.checkpointType === 'Disabled') throw new PsError(`Checkpoint operation failed.\nCheckpoints are disabled for '${vm.name}'.`, 'InvalidOperation', 'InvalidState,Microsoft.HyperV.PowerShell.Commands.CheckpointVM', vm.name)
    const prodPossible = vm.state !== 'Running' || (vm.guestReady && bootsOk(vm))
    if (vm.checkpointType === 'ProductionOnly' && !prodPossible) throw new PsError(`Checkpoint operation failed.\nCould not create a production checkpoint for '${vm.name}': the guest did not respond to the backup (VSS) request.`, 'InvalidOperation', 'InvalidState,Microsoft.HyperV.PowerShell.Commands.CheckpointVM', vm.name)
    const type = vm.checkpointType === 'Standard' || !prodPossible ? 'Standard' : 'Production'
    if (vm.checkpointType === 'Production' && type === 'Standard') ctx.host(`WARNING: Production checkpoint could not be created for '${vm.name}'; a standard checkpoint was created instead.\n`)
    const name = str(ctx, 'SnapshotName') ?? `${vm.name} - (${formatDotnetDate(new Date(), 'M/d/yyyy - h:mm:ss tt')})`
    const c: HvCheckpoint = { name, type, created: Date.now(), parent: vm.checkpoints.at(-1)?.name, id: guid() }
    vm.checkpoints.push(c)
    // Cada punto de control deja un disco diferencial (.avhdx) al lado del original.
    for (const d of vm.disks) {
      const avhd = d.replace(/\.vhdx?$/i, `_${c.id}.avhdx`)
      const meta = readVhd(ctx.s, d)
      if (meta) writeVhd(ctx.s, avhd, { format: 'VHDX', type: 'Differencing', size: meta.size, parent: d, id: guid() }, 4 * MB)
    }
    return has(ctx, 'Passthru') ? [cpObject(vm, c)] : []
  },
})

cmdlet(['Get-VMCheckpoint', 'Get-VMSnapshot'], {
  params: ['VMName', 'Name', 'ComputerName'],
  positional: ['VMName'],
  synopsis: 'Gets checkpoints associated with a virtual machine or checkpoint.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Get-VMCheckpoint')
    const vms = vmName(ctx) && !has(ctx, 'VMName') ? [findVm(ctx, h, vmName(ctx), 'Get-VMCheckpoint')] : has(ctx, 'VMName') ? [findVm(ctx, h, str(ctx, 'VMName'), 'Get-VMCheckpoint')] : h.vms
    const only = has(ctx, 'VMName') ? str(ctx, 'Name') : undefined
    return vms.flatMap((vm) => vm.checkpoints.filter((c) => !only || c.name.toLowerCase() === only.toLowerCase()).map((c) => cpObject(vm, c)))
  },
})

cmdlet(['Restore-VMCheckpoint', 'Restore-VMSnapshot', 'Remove-VMCheckpoint', 'Remove-VMSnapshot'], {
  params: ['VMName', 'Name', 'ComputerName'],
  switches: ['Confirm', 'Passthru', 'IncludeAllChildCheckpoints'],
  positional: ['Name'],
  synopsis: 'Restores or deletes a virtual machine checkpoint.',
  module: 'Hyper-V',
  run(ctx) {
    const restoring = /^restore/i.test(ctx.name)
    const cmd = restoring ? 'Restore-VMCheckpoint' : 'Remove-VMCheckpoint'
    const h = hv(ctx, cmd)
    const fromPipe = ctx.input.find((x) => (x as PsObject)?.__type === 'Microsoft.HyperV.PowerShell.VMCheckpoint') as PsObject | undefined
    const vm = findVm(ctx, h, str(ctx, 'VMName') ?? (fromPipe ? toText(fromPipe.VMName) : undefined), cmd)
    const name = str(ctx, 'Name') ?? (fromPipe ? toText(fromPipe.Name) : undefined)
    const targets = name === '*' ? [...vm.checkpoints] : vm.checkpoints.filter((c) => c.name.toLowerCase() === (name ?? '').toLowerCase())
    if (!targets.length) throw new PsError(`Hyper-V was unable to find a checkpoint named "${name}" for virtual machine '${vm.name}'.`, 'InvalidArgument', `InvalidParameter,Microsoft.HyperV.PowerShell.Commands.${cmd.replace('-', '')}`, name ?? '')
    if (restoring) {
      const c = targets[0]
      if (vm.state !== 'Off') {
        vm.state = c.type === 'Standard' ? 'Running' : 'Off'
        if (vm.state === 'Off') vm.assigned = 0
      }
      if (c.type === 'Production') {
        vm.state = 'Off'
        vm.assigned = 0
      }
      return []
    }
    for (const c of targets) {
      vm.checkpoints = vm.checkpoints.filter((x) => x !== c)
      for (const d of vm.disks) {
        const avhd = d.replace(/\.vhdx?$/i, `_${c.id}.avhdx`)
        if (ctx.s.fs.get(avhd)) ctx.s.fs.remove(avhd)
      }
    }
    return []
  },
})

// ---------------------------------------------------------------------------------------
// Exportar, importar y el host
// ---------------------------------------------------------------------------------------

const EXPORTS = new WeakMap<PsSession, Map<string, HvVm>>()

cmdlet('Export-VM', {
  params: ['Name', 'Path', 'CaptureLiveState', 'ComputerName'],
  switches: ['Passthru', 'AsJob'],
  positional: ['Name', 'Path'],
  synopsis: 'Exports a virtual machine to disk.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Export-VM')
    const vm = findVm(ctx, h, str(ctx, 'Name'), 'Export-VM')
    const dest = resolve(ctx, str(ctx, 'Path') ?? '')
    const root = `${dest}\\${vm.name}`
    if (ctx.s.fs.get(root)) throw new PsError(`Failed to export the virtual machine.\nThe folder '${root}' already exists. Export requires an empty folder.`, 'ResourceExists', 'ObjectExists,Microsoft.HyperV.PowerShell.Commands.ExportVM', root)
    ctx.s.fs.mkdirp(`${root}\\Virtual Machines`)
    ctx.s.fs.mkdirp(`${root}\\Snapshots`)
    ctx.s.fs.write(`${root}\\Virtual Machines\\${vm.id}.vmcx`, `vmcx:${vm.name}`)
    ctx.s.fs.mkdirp(`${root}\\Virtual Hard Disks`)
    const copy: HvVm = structuredClone({ ...vm, state: 'Off' as const, startedAt: undefined, assigned: 0 })
    copy.disks = []
    for (const d of vm.disks) {
      const meta = readVhd(ctx.s, d)
      const name = d.slice(d.lastIndexOf('\\') + 1)
      const target = `${root}\\Virtual Hard Disks\\${name}`
      if (meta) writeVhd(ctx.s, target, { ...meta, parent: undefined, type: meta.type === 'Differencing' ? 'Dynamic' : meta.type }, ctx.s.fs.get(d)!.size ?? 4 * MB)
      copy.disks.push(target)
    }
    let m = EXPORTS.get(ctx.s)
    if (!m) EXPORTS.set(ctx.s, (m = new Map()))
    m.set(`${root}\\Virtual Machines\\${vm.id}.vmcx`.toLowerCase(), copy)
    return []
  },
})

cmdlet('Import-VM', {
  params: ['Path', 'VirtualMachinePath', 'VhdDestinationPath', 'SnapshotFilePath', 'ComputerName'],
  switches: ['Copy', 'GenerateNewId', 'Register'],
  positional: ['Path'],
  synopsis: 'Imports a virtual machine from a file.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Import-VM')
    const path = resolve(ctx, str(ctx, 'Path') ?? '')
    const src = EXPORTS.get(ctx.s)?.get(path.toLowerCase())
    if (!ctx.s.fs.get(path) || !src) throw new PsError(`Failed to import a virtual machine.\nThe system cannot find the file specified. ('${path}')`, 'ObjectNotFound', 'ObjectNotFound,Microsoft.HyperV.PowerShell.Commands.ImportVM', path)
    const vm: HvVm = structuredClone(src)
    if (h.vms.some((x) => x.id === vm.id)) {
      if (!has(ctx, 'GenerateNewId')) throw new PsError(`Failed to import a virtual machine.\nThe operation failed because a virtual machine with the same identifier already exists. Select a new identifier and try the operation again.`, 'ResourceExists', 'ObjectExists,Microsoft.HyperV.PowerShell.Commands.ImportVM', path)
    }
    if (has(ctx, 'GenerateNewId')) vm.id = guid()
    if (has(ctx, 'Copy')) {
      const dir = str(ctx, 'VhdDestinationPath') ? resolve(ctx, str(ctx, 'VhdDestinationPath')!) : h.vhdPath
      ctx.s.fs.mkdirp(dir)
      vm.disks = vm.disks.map((d) => {
        const meta = readVhd(ctx.s, d)
        const target = `${dir}\\${d.slice(d.lastIndexOf('\\') + 1)}`
        if (ctx.s.fs.get(target)) throw new PsError(`Failed to import a virtual machine.\nThe file '${target}' already exists.`, 'ResourceExists', 'ObjectExists,Microsoft.HyperV.PowerShell.Commands.ImportVM', target)
        if (meta) writeVhd(ctx.s, target, meta, ctx.s.fs.get(d)!.size ?? 4 * MB)
        return target
      })
      vm.path = str(ctx, 'VirtualMachinePath') ? resolve(ctx, str(ctx, 'VirtualMachinePath')!) : h.vmPath
    }
    for (const n of vm.nics) if (n.switchName && !h.switches.some((s) => s.name === n.switchName)) {
      ctx.host(`WARNING: The virtual switch '${n.switchName}' was not found on this host; the network adapter of '${vm.name}' was left disconnected.\n`)
      n.switchName = undefined
    }
    h.vms.push(vm)
    return [vmObject(vm)]
  },
})

cmdlet('Get-VMHost', {
  params: ['ComputerName'],
  synopsis: 'Gets a Hyper-V host.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Get-VMHost')
    return [psObject('Microsoft.HyperV.PowerShell.VMHost', { Name: ctx.s.state.equipo, LogicalProcessorCount: h.cpus, MemoryCapacity: h.memoryBytes, VirtualMachinePath: h.vmPath, VirtualHardDiskPath: h.vhdPath, VirtualMachineMigrationEnabled: false, NumaSpanningEnabled: true })]
  },
})
VIEWS['Microsoft.HyperV.PowerShell.VMHost'] = {
  kind: 'table',
  columns: [
    { label: 'Name', value: (o) => o.Name },
    { label: 'LogicalProcessorCount', value: (o) => o.LogicalProcessorCount, align: 'right' },
    { label: 'MemoryCapacity(M)', value: (o) => Math.round(Number(o.MemoryCapacity) / MB), align: 'right' },
    { label: 'VirtualMachineMigrationEnabled', value: (o) => o.VirtualMachineMigrationEnabled },
  ],
}

cmdlet('Set-VMHost', {
  params: ['VirtualMachinePath', 'VirtualHardDiskPath', 'ComputerName'],
  switches: ['Passthru'],
  synopsis: 'Configures a Hyper-V host.',
  module: 'Hyper-V',
  run(ctx) {
    const h = hv(ctx, 'Set-VMHost')
    if (has(ctx, 'VirtualMachinePath')) {
      h.vmPath = resolve(ctx, str(ctx, 'VirtualMachinePath')!)
      ctx.s.fs.mkdirp(h.vmPath)
    }
    if (has(ctx, 'VirtualHardDiskPath')) {
      h.vhdPath = resolve(ctx, str(ctx, 'VirtualHardDiskPath')!)
      ctx.s.fs.mkdirp(h.vhdPath)
    }
    return []
  },
})

// ---------------------------------------------------------------------------------------
// Estado inicial, reinicio y verificaciones
// ---------------------------------------------------------------------------------------

/** Al reiniciar después de instalar el rol, Hyper-V queda funcionando. */
BOOT_HOOKS.push((s) => {
  if (featureInstalled(s)) s.data.hvBooted = [true]
})

/** Lo que el ejercicio trae armado: conmutadores, discos y máquinas virtuales. */
export function initialHyperV(s: PsSession) {
  const st = s.state.hyperv as HvState | undefined
  if (!st) return
  const features = (s.data.features ?? []) as PsObject[]
  const f = features.find((x) => toText(x.Name).toLowerCase() === 'hyper-v')
  if (f && st.instalado) {
    f.Installed = true
    f.InstallState = 'Installed'
    const mods = (s.data.modules ??= []) as string[]
    if (!mods.includes('Hyper-V')) mods.push('Hyper-V')
  }
  if (!st.instalado) return
  const h: HyperV = { switches: [], vms: [], cpus: st.procesadores, memoryBytes: st.memoria_gb * GB, vmPath: 'C:\\ProgramData\\Microsoft\\Windows\\Hyper-V', vhdPath: 'C:\\ProgramData\\Microsoft\\Windows\\Virtual Hard Disks' }
  HV.set(s, h)
  for (const sw of st.conmutadores) h.switches.push({ name: sw.nombre, type: sw.tipo, adapter: sw.tipo === 'External' ? s.state.red.adaptador : undefined, allowMgmt: sw.tipo !== 'Private', id: guid() })
  for (const d of st.discos) {
    const path = s.resolvePath(d.ruta)
    writeVhd(s, path, { format: /\.vhd$/i.test(path) ? 'VHD' : 'VHDX', type: d.tipo, size: d.tamano_gb * GB, parent: d.padre, id: guid() }, d.ocupado_gb !== undefined ? d.ocupado_gb * GB : d.tipo === 'Fixed' ? d.tamano_gb * GB : 4 * MB)
  }
  for (const v of st.vms) {
    const vm: HvVm = {
      name: v.nombre,
      id: guid(),
      state: 'Off',
      generation: v.generacion,
      cpus: v.procesadores,
      nested: false,
      startup: v.memoria_mb * MB,
      dynamic: v.memoria_dinamica,
      minimum: (v.memoria_min_mb ?? 512) * MB,
      maximum: (v.memoria_max_mb ?? 1048576) * MB,
      assigned: 0,
      disks: v.discos.map((d) => s.resolvePath(d)),
      nics: [{ name: 'Network Adapter', switchName: v.conmutador, mac: newMac(), vlan: v.vlan }],
      checkpoints: v.puntos_de_control.map((n, i, all) => ({ name: n, type: 'Production' as const, created: Date.now() - (all.length - i) * 86_400_000, parent: i ? all[i - 1] : undefined, id: guid() })),
      checkpointType: 'Production',
      secureBoot: v.generacion === 2,
      secureBootTemplate: v.plantilla_arranque ?? 'MicrosoftWindows',
      linux: v.linux,
      guestReady: true,
      autoStart: 'StartIfRunning',
      autoStop: 'Save',
      path: h.vmPath,
      guestService: false,
      notes: '',
    }
    h.vms.push(vm)
    if (v.estado === 'Running') startVm(h, vm)
  }
}

export function verifyHyperV(s: PsSession, check: Record<string, unknown>): { ok: boolean; label: string } | undefined {
  const h = HV.get(s)
  if ('vm_hyperv' in check) {
    const c = check as { vm_hyperv: string; existe?: boolean; estado?: string; procesadores?: number; memoria_mb?: number; memoria_dinamica?: boolean; conmutador?: string; vlan?: number; generacion?: number; punto_de_control?: string; arranque_automatico?: string; con_disco?: string }
    const vm = h?.vms.find((v) => v.name.toLowerCase() === c.vm_hyperv.toLowerCase())
    if (c.existe === false) return { ok: !vm, label: `la máquina virtual ${c.vm_hyperv} no existe` }
    let ok = !!vm
    const parts: string[] = []
    const want = (cond: boolean, text: string) => {
      if (ok) ok = cond
      parts.push(text)
    }
    if (c.estado !== undefined) want(vm?.state === c.estado, c.estado === 'Running' ? 'encendida' : `en estado ${c.estado}`)
    if (c.procesadores !== undefined) want(vm?.cpus === c.procesadores, `con ${c.procesadores} procesadores`)
    if (c.memoria_mb !== undefined) want(vm?.startup === c.memoria_mb * MB, `con ${c.memoria_mb} MB de memoria de inicio`)
    if (c.memoria_dinamica !== undefined) want(vm?.dynamic === c.memoria_dinamica, c.memoria_dinamica ? 'con memoria dinámica' : 'con memoria fija')
    if (c.conmutador !== undefined) want(!!vm?.nics.some((n) => n.switchName?.toLowerCase() === c.conmutador!.toLowerCase()), `conectada a ${c.conmutador}`)
    if (c.vlan !== undefined) want(!!vm?.nics.some((n) => n.vlan === c.vlan), `en la VLAN ${c.vlan}`)
    if (c.generacion !== undefined) want(vm?.generation === c.generacion, `de generación ${c.generacion}`)
    if (c.punto_de_control !== undefined) want(!!vm?.checkpoints.some((x) => x.name === c.punto_de_control), `con el punto de control ${c.punto_de_control}`)
    if (c.arranque_automatico !== undefined) want(vm?.autoStart === c.arranque_automatico, `con AutomaticStartAction ${c.arranque_automatico}`)
    if (c.con_disco !== undefined) want(!!vm?.disks.some((d) => d.toLowerCase().endsWith(c.con_disco!.toLowerCase())), `con el disco ${c.con_disco}`)
    return { ok, label: `la máquina virtual ${c.vm_hyperv} existe${parts.length ? ' ' + parts.join(', ') : ''}` }
  }
  if ('conmutador_hyperv' in check) {
    const c = check as { conmutador_hyperv: string; tipo?: string }
    const sw = h?.switches.find((x) => x.name.toLowerCase() === c.conmutador_hyperv.toLowerCase())
    return { ok: !!sw && (!c.tipo || sw.type === c.tipo), label: `el conmutador virtual ${c.conmutador_hyperv}${c.tipo ? ` de tipo ${c.tipo}` : ''}` }
  }
  if ('vhd' in check) {
    const c = check as { vhd: string; tipo?: string; tamano_gb?: number; padre?: string }
    const meta = readVhd(s, s.resolvePath(c.vhd))
    let ok = !!meta
    if (ok && c.tipo) ok = meta!.type === c.tipo
    if (ok && c.tamano_gb !== undefined) ok = Math.round(meta!.size / GB) === c.tamano_gb
    if (ok && c.padre) ok = (meta!.parent ?? '').toLowerCase().endsWith(c.padre.toLowerCase())
    return { ok, label: `el disco ${c.vhd}${c.tipo ? ` de tipo ${c.tipo}` : ''}${c.tamano_gb !== undefined ? ` de ${c.tamano_gb} GB` : ''}` }
  }
  return undefined
}
