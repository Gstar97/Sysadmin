/**
 * Hardware del servidor: la salud de los discos (smartctl), la placa de gestión (ipmitool, local
 * o por la red) y la UPS con NUT (upsc, upsd, upsmon), incluido el apagado ordenado cuando la
 * batería se agota. En una máquina virtual no hay SMART ni placa de gestión: el simulador lo
 * muestra igual que el equipo real.
 */
import { SERVICE_CHECKS } from './commands/sysinfo'
import { inSubnet } from './hosts'
import { reach } from './http'
import { register, type CommandContext } from './shell'
import { System, KERNEL_VERSION } from './system'
import { ROOT_CRED } from './vfs'
import type { BashState } from './schema'

type SmartSpec = NonNullable<BashState['smart']>[string]
type BmcSpec = NonNullable<BashState['bmc']>
type UpsSpec = NonNullable<BashState['ups']>

const SMART = new WeakMap<System, Record<string, SmartSpec & { selftest?: { start: number; kind: string } }>>()
const BMC = new WeakMap<System, BmcSpec & { power: 'on' | 'off' }>()
const UPS = new WeakMap<System, UpsSpec>()

System.initHooks.push((sys, state) => {
  if (state.smart) SMART.set(sys, structuredClone(state.smart))
  if (state.bmc) BMC.set(sys, { ...structuredClone(state.bmc), power: 'on' })
  if (state.ups) UPS.set(sys, structuredClone(state.ups))
})

// ---------------------------------------------------------------------------------------
// smartctl
// ---------------------------------------------------------------------------------------

function smartHeader(sys: System) {
  const k = sys.distro === 'rocky' ? KERNEL_VERSION.rocky : KERNEL_VERSION.ubuntu
  return `smartctl 7.4 2023-08-01 r5530 [x86_64-linux-${k}] (local build)\nCopyright (C) 2002-23, Bruce Allen, Christian Franke, www.smartmontools.org\n\n`
}

function attrs(s: SmartSpec) {
  const realloc = s.reasignados
  const reallocVal = realloc > 0 ? Math.max(1, 100 - Math.ceil(realloc / 20)) : 100
  const rows: [number, string, string, number, number, number, string, string, string][] = [
    [1, 'Raw_Read_Error_Rate', '0x000f', 82, 64, 44, 'Pre-fail', 'Always', '153478920'],
    [3, 'Spin_Up_Time', '0x0003', 92, 91, 0, 'Pre-fail', 'Always', '0'],
    [5, 'Reallocated_Sector_Ct', '0x0033', reallocVal, reallocVal, 10, 'Pre-fail', 'Always', String(realloc)],
    [9, 'Power_On_Hours', '0x0032', Math.max(1, 100 - Math.floor(s.horas / 876)), Math.max(1, 100 - Math.floor(s.horas / 876)), 0, 'Old_age', 'Always', String(s.horas)],
    [12, 'Power_Cycle_Count', '0x0032', 100, 100, 20, 'Old_age', 'Always', '24'],
    [187, 'Reported_Uncorrect', '0x0032', s.pendientes > 0 ? 97 : 100, s.pendientes > 0 ? 97 : 100, 0, 'Old_age', 'Always', String(Math.floor(s.pendientes / 2))],
    [194, 'Temperature_Celsius', '0x0022', s.temperatura, 48, 0, 'Old_age', 'Always', `${s.temperatura} (0 21 0 0 0)`],
    [197, 'Current_Pending_Sector', '0x0012', s.pendientes > 0 ? 99 : 100, s.pendientes > 0 ? 99 : 100, 0, 'Old_age', 'Always', String(s.pendientes)],
    [198, 'Offline_Uncorrectable', '0x0010', s.pendientes > 0 ? 99 : 100, s.pendientes > 0 ? 99 : 100, 0, 'Old_age', 'Offline', String(s.pendientes)],
    [199, 'UDMA_CRC_Error_Count', '0x003e', 200, 200, 0, 'Old_age', 'Always', '0'],
  ]
  return rows
}

function failing(s: SmartSpec) {
  return s.estado === 'fallando' || attrs(s).some((r) => r[6] === 'Pre-fail' && r[3] <= r[5] && r[5] > 0)
}

register('smartctl', {
  usage: 'smartctl -H|-i|-A|-a|-t short|-l selftest /dev/sdX',
  summary: '  -H  salud general (PASSED o FAILED)\n  -i  modelo, número de serie, capacidad\n  -A  atributos (sectores reasignados, pendientes, horas, temperatura)\n  -a  todo\n  -t short|long  empieza una prueba   -l selftest  resultados de las pruebas',
  path: '/usr/sbin',
  run(ctx) {
    const sys = ctx.sys
    const dev = ctx.args.find((a) => a.startsWith('/dev/'))
    if (ctx.sh.user !== 'root') {
      ctx.out(smartHeader(sys))
      ctx.out(`Smartctl open device: ${dev ?? ''} failed: Permission denied\n`)
      return 2
    }
    if (!dev || sys.storage.size(dev) === undefined) {
      ctx.out(smartHeader(sys))
      ctx.out(`Smartctl open device: ${dev ?? ''} failed: No such device\n`)
      return 2
    }
    const flags = new Set(ctx.args.filter((a) => /^-[a-zA-Z]+$/.test(a)).flatMap((a) => [...a.slice(1)]))
    const long = (n: string) => ctx.args.includes(n)
    const all = flags.has('a') || long('--all') || long('-x')
    const spec = SMART.get(sys)?.[dev]
    let out = smartHeader(sys)
    if (!spec) {
      // Disco virtual: no hay SMART.
      const disk = sys.storage.disks.get(dev.replace('/dev/', ''))
      out += `=== START OF INFORMATION SECTION ===\nVendor:               QEMU\nProduct:              QEMU HARDDISK\nRevision:             2.5+\nUser Capacity:        ${(disk?.size ?? 0).toLocaleString('en-US')} bytes\nLogical block size:   512 bytes\nRotation Rate:        Solid State Device\nDevice type:          disk\nLocal Time is:        ${new Date().toUTCString()}\nSMART support is:     Unavailable - device lacks SMART capability.\n\n`
      ctx.out(out)
      ctx.err('[simulador] Los discos de una máquina virtual no tienen SMART: smartctl sirve en el servidor físico (o en el hipervisor).\n')
      return 4
    }
    const st = SMART.get(sys)![dev]
    const tIdx = ctx.args.indexOf('-t')
    if (tIdx >= 0 || long('--test')) {
      const kind = ctx.args[tIdx + 1] ?? 'short'
      st.selftest = { start: Date.now(), kind }
      out += `=== START OF OFFLINE IMMEDIATE AND SELF-TEST SECTION ===\nSending command: "Execute SMART ${kind === 'long' ? 'Extended' : 'Short'} self-test routine immediately in off-line mode".\nDrive command "Execute SMART ${kind === 'long' ? 'Extended' : 'Short'} self-test routine immediately in off-line mode" successful.\nTesting has begun.\nPlease wait ${kind === 'long' ? 480 : 2} minutes for test to complete.\nTest will complete after ${new Date(Date.now() + (kind === 'long' ? 480 : 2) * 60000).toString().slice(0, 24)}\nUse smartctl -X to abort test.\n`
      ctx.out(out)
      return 0
    }
    if (flags.has('i') || all) {
      out += `=== START OF INFORMATION SECTION ===\nModel Family:     ${st.familia}\nDevice Model:     ${st.modelo}\nSerial Number:    ${st.serie}\nFirmware Version: SN02\nUser Capacity:    ${(sys.storage.size(dev) ?? 0).toLocaleString('en-US')} bytes [${((sys.storage.size(dev) ?? 0) / 1e12).toFixed(2)} TB]\nSector Sizes:     512 bytes logical, 4096 bytes physical\nRotation Rate:    7200 rpm\nForm Factor:      3.5 inches\nDevice is:        In smartctl database 7.3/5528\nATA Version is:   ACS-4 (minor revision not indicated)\nSATA Version is:  SATA 3.3, 6.0 Gb/s (current: 6.0 Gb/s)\nLocal Time is:    ${new Date().toString().slice(0, 24)} UTC\nSMART support is: Available - device has SMART capability.\nSMART support is: Enabled\n\n`
    }
    const bad = failing(st)
    if (flags.has('H') || all) {
      out += `=== START OF READ SMART DATA SECTION ===\nSMART overall-health self-assessment test result: ${bad ? 'FAILED!' : 'PASSED'}\n`
      if (bad) out += 'Drive failure expected in less than 24 hours. SAVE ALL DATA.\nSee vendor-specific Attribute list for failed Attributes.\n'
      out += '\n'
    }
    if (flags.has('A') || all) {
      if (!flags.has('H') && !all) out += '=== START OF READ SMART DATA SECTION ===\n'
      out += 'SMART Attributes Data Structure revision number: 10\nVendor Specific SMART Attributes with Thresholds:\nID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE\n'
      for (const [id, name, flag, v, w, t, type, upd, raw] of attrs(st)) {
        const when = type === 'Pre-fail' && v <= t && t > 0 ? 'FAILING_NOW' : '-'
        out += `${String(id).padStart(3)} ${name.padEnd(23)} ${flag}   ${String(v).padStart(3, '0')}   ${String(w).padStart(3, '0')}   ${String(t).padStart(3, '0')}    ${type.padEnd(9)} ${upd.padEnd(9)}${when === '-' ? '    -       ' : when.padEnd(12)}${raw}\n`
      }
      out += '\n'
    }
    if (flags.has('l') || long('selftest') || all) {
      out += 'SMART Self-test log structure revision number 1\n'
      if (!st.selftest) out += 'No self-tests have been logged.  [To run self-tests, use: smartctl -t]\n'
      else {
        const done = Date.now() - st.selftest.start > 120000
        const res = !done ? 'Self-test routine in progress' : st.pendientes > 0 ? 'Completed: read failure' : 'Completed without error'
        out += `Num  Test_Description    Status                  Remaining  LifeTime(hours)  LBA_of_first_error\n# 1  ${st.selftest.kind === 'long' ? 'Extended offline' : 'Short offline   '}    ${res.padEnd(24)}${done ? '00%' : '90%'}      ${st.horas}         ${st.pendientes > 0 && done ? '1953520' : '-'}\n`
      }
      out += '\n'
    }
    ctx.out(out)
    return bad ? 8 : 0
  },
})

// ---------------------------------------------------------------------------------------
// ipmitool
// ---------------------------------------------------------------------------------------

function sensors(b: BmcSpec & { power: 'on' | 'off' }) {
  const s = b.sensores
  const rows: [string, string, string][] = [
    ['Fan1', `${s.ventilador1} RPM`, s.ventilador1 > 600 ? 'ok' : 'cr'],
    ['Fan2', `${s.ventilador2} RPM`, s.ventilador2 > 600 ? 'ok' : 'cr'],
    ['Inlet Temp', `${s.temp_entrada} degrees C`, s.temp_entrada < 42 ? 'ok' : 'cr'],
    ['Exhaust Temp', `${s.temp_salida} degrees C`, s.temp_salida < 70 ? 'ok' : 'cr'],
    ['Temp', `${s.temp_cpu} degrees C`, s.temp_cpu < 90 ? 'ok' : 'cr'],
    ['Current 1', b.fuente1 ? '0.40 Amps' : 'no reading', b.fuente1 ? 'ok' : 'ns'],
    ['Current 2', b.fuente2 ? '0.40 Amps' : 'no reading', b.fuente2 ? 'ok' : 'ns'],
    ['Voltage 1', b.fuente1 ? '228 Volts' : 'no reading', b.fuente1 ? 'ok' : 'ns'],
    ['Voltage 2', b.fuente2 ? '228 Volts' : 'no reading', b.fuente2 ? 'ok' : 'ns'],
    ['Pwr Consumption', `${b.power === 'on' ? s.consumo : 0} Watts`, 'ok'],
    ['PS Redundancy', b.fuente1 && b.fuente2 ? '0x00' : '0x00', b.fuente1 && b.fuente2 ? 'ok' : 'cr'],
    ['PS1 Status', b.fuente1 ? '0x01' : '0x0b', b.fuente1 ? 'ok' : 'cr'],
    ['PS2 Status', b.fuente2 ? '0x01' : '0x0b', b.fuente2 ? 'ok' : 'cr'],
  ]
  return rows
}

function ipmiRun(ctx: CommandContext, b: BmcSpec & { power: 'on' | 'off' }, cmd: string[], remote: boolean, target: System): number {
  const [a, b2, c] = cmd
  const pad = (t: string, n: number) => t.padEnd(n)
  if (a === 'sdr' || a === 'sensor') {
    let rows = sensors(b)
    if (b2 === 'type' && c) rows = rows.filter(([n]) => (c.toLowerCase().startsWith('temp') ? /Temp/.test(n) : c.toLowerCase().startsWith('fan') ? /Fan/.test(n) : /PS|Current|Voltage/.test(n)))
    for (const [n, v, st] of rows) ctx.out(a === 'sensor' ? `${pad(n, 17)}| ${pad(v.replace(/ (RPM|degrees C|Amps|Volts|Watts)$/, ''), 10)} | ${pad(v.match(/(RPM|degrees C|Amps|Volts|Watts)$/)?.[1] ?? 'discrete', 10)} | ${st}\n` : `${pad(n, 17)}| ${pad(v, 18)}| ${st}\n`)
    return 0
  }
  if (a === 'sel') {
    if (b2 === 'clear') {
      b.eventos = []
      ctx.out('Clearing SEL.  Please allow a few seconds to erase.\n')
      return 0
    }
    if (b2 === 'info') {
      ctx.out(`SEL Information\nVersion          : 1.5 (v1.5, v2 compliant)\nEntries          : ${b.eventos.length}\nFree Space       : ${(1024 - b.eventos.length) * 16} bytes\nPercent Used     : ${Math.round((b.eventos.length / 1024) * 100)}%\n`)
      return 0
    }
    if (!b.eventos.length) {
      ctx.out('SEL has no entries\n')
      return 0
    }
    b.eventos.forEach((e, i) => ctx.out(`${String(i + 1).padStart(4)} | ${e.fecha} | ${e.hora} | ${e.texto} | Asserted\n`))
    return 0
  }
  if (a === 'chassis') {
    if (b2 === 'status') {
      ctx.out(`System Power         : ${b.power}\nPower Overload       : false\nPower Interlock      : inactive\nMain Power Fault     : false\nPower Control Fault  : false\nPower Restore Policy : always-off\nLast Power Event     : \nChassis Intrusion    : inactive\nFront-Panel Lockout  : inactive\nDrive Fault          : false\nCooling/Fan Fault    : ${b.sensores.ventilador1 < 600 || b.sensores.ventilador2 < 600}\n`)
      return 0
    }
    if (b2 === 'power') {
      if (c === 'status') ctx.out(`Chassis Power is ${b.power}\n`)
      else if (c === 'on' || c === 'off' || c === 'cycle' || c === 'reset' || c === 'soft') {
        if (!remote) ctx.err('[simulador] Apagar desde el propio servidor corta tu sesión: en la práctica, esto se hace por la red (-I lanplus -H ...) desde otro equipo.\n')
        b.power = c === 'off' || c === 'soft' ? 'off' : 'on'
        // Por la red, el servidor se apaga, se prende o se reinicia de verdad (en el propio, no: cortaría la sesión).
        if (remote) {
          if (c === 'cycle' || c === 'reset') {
            target.setPower(false)
            target.setPower(true)
          } else target.setPower(c === 'on')
        }
        ctx.out(`Chassis Power Control: ${c === 'on' ? 'Up/On' : c === 'off' ? 'Down/Off' : c === 'soft' ? 'Soft' : c === 'cycle' ? 'Cycle' : 'Reset'}\n`)
      } else ctx.err('chassis power Commands: status, on, off, cycle, reset, diag, soft\n')
      return 0
    }
    ctx.err('Chassis Commands:  status, power, policy, restart_cause, poh, identify, selftest, bootdev, bootparam, bootmbox\n')
    return 1
  }
  if (a === 'lan' && b2 === 'print') {
    ctx.out(`Set in Progress         : Set Complete\nAuth Type Support       : MD5 \nIP Address Source       : Static Address\nIP Address              : ${b.ip}\nSubnet Mask             : 255.255.255.0\nMAC Address             : d0:94:66:3a:12:7f\nDefault Gateway IP      : ${b.ip.replace(/\.\d+$/, '.1')}\n802.1q VLAN ID          : Disabled\nCipher Suite Priv Max   : Xaaaaaaaaaaaaaa\n`)
    return 0
  }
  if (a === 'mc' && b2 === 'info') {
    ctx.out(`Device ID                 : 32\nDevice Revision           : 1\nFirmware Revision         : 7.10\nIPMI Version              : 2.0\nManufacturer ID           : 674\nManufacturer Name         : DELL Inc\nProduct ID                : 256 (0x0100)\nProduct Name              : ${b.modelo}\nDevice Available          : yes\n`)
    return 0
  }
  if (a === 'user' && b2 === 'list') {
    ctx.out(`ID  Name\t     Callin  Link Auth\tIPMI Msg   Channel Priv Limit\n1                    true    false      false      Unknown (0x00)\n2   ${b.usuario.padEnd(17)}true    true       true       ADMINISTRATOR\n`)
    return 0
  }
  ctx.err(`Invalid command: ${cmd.join(' ')}\n[simulador] Disponibles: sdr, sensor, sel list|elist|info|clear, chassis status, chassis power status|on|off|cycle|soft, lan print 1, mc info, user list 1.\n`)
  return 1
}

register('ipmitool', {
  usage: 'ipmitool [-I lanplus -H ip -U usuario -P clave] sdr|sensor|sel elist|chassis status|chassis power status|lan print 1',
  path: '/usr/bin',
  run(ctx) {
    const sys = ctx.sys
    const args = [...ctx.args]
    let host: string | undefined
    let user: string | undefined
    let pass: string | undefined
    let iface: string | undefined
    const cmd: string[] = []
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a === '-H') host = args[++i]
      else if (a === '-U') user = args[++i]
      else if (a === '-P') pass = args[++i]
      else if (a === '-E') pass = ctx.sh.vars.get('IPMI_PASSWORD')
      else if (a === '-I') iface = args[++i]
      else if (a === '-C' || a === '-L' || a === '-p') i++
      else cmd.push(a)
    }
    if (!cmd.length) {
      ctx.err('No command provided!\n')
      return 1
    }
    if (host) {
      if (iface !== 'lanplus' && iface !== 'lan') {
        ctx.err('Error: Unable to establish IPMI v2 / RMCP+ session\n[simulador] Por la red se usa -I lanplus.\n')
        return 1
      }
      const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : sys.resolveHost(host)
      const target = [sys, ...sys.lab].find((s) => BMC.get(s)?.ip === ip)
      // La placa de gestión no es un equipo del laboratorio: se llega si está en una red propia.
      const sameNet = !!ip && sys.interfaces.some((i) => i.ip && inSubnet(ip, `${i.ip.split('/')[0]}/${i.ip.split('/')[1] ?? '24'}`))
      const r = ip ? reach(sys, ip, 623) : { error: 'timeout' as const }
      if (!target || (!sameNet && 'error' in r && r.error !== 'outside')) {
        ctx.err('Error: Unable to establish IPMI v2 / RMCP+ session\n')
        return 1
      }
      const b = BMC.get(target)!
      if (user !== b.usuario || pass !== b.clave) {
        ctx.err('Error: Unable to establish IPMI v2 / RMCP+ session\n')
        return 1
      }
      return ipmiRun(ctx, b, cmd, true, target)
    }
    const b = BMC.get(sys)
    if (!b) {
      ctx.err('Could not open device at /dev/ipmi0 or /dev/ipmi/0 or /dev/ipmidev/0: No such file or directory\n')
      return 1
    }
    if (ctx.sh.user !== 'root') {
      ctx.err('Could not open device at /dev/ipmi0 or /dev/ipmi/0 or /dev/ipmidev/0: Permission denied\n')
      return 1
    }
    return ipmiRun(ctx, b, cmd, false, sys)
  },
})

// ---------------------------------------------------------------------------------------
// NUT: la UPS
// ---------------------------------------------------------------------------------------

function nutDir(sys: System) {
  return sys.distro === 'rocky' ? '/etc/ups' : '/etc/nut'
}

function readText(sys: System, path: string) {
  return sys.vfs.exists(path) ? sys.vfs.readFile(path, ROOT_CRED) : ''
}

function sections(text: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>()
  let cur: Map<string, string> | undefined
  for (const raw of text.split('\n')) {
    const l = raw.replace(/#.*$/, '').trim()
    if (!l) continue
    const sec = /^\[([^\]]+)\]$/.exec(l)
    if (sec) {
      cur = new Map()
      out.set(sec[1], cur)
      continue
    }
    const kv = /^([\w.]+)\s*=\s*"?([^"]*)"?$/.exec(l)
    if (kv && cur) cur.set(kv[1], kv[2])
    else if (cur) cur.set(l, 'true')
  }
  return out
}

/** Las variables de una UPS como las publica upsd (o el error). */
function upsVars(sys: System, name: string): Map<string, string> | string {
  const conf = sections(readText(sys, `${nutDir(sys)}/ups.conf`)).get(name)
  if (!conf) return 'Unknown UPS'
  const driver = conf.get('driver') ?? ''
  const port = conf.get('port') ?? 'auto'
  const v = new Map<string, string>()
  if (driver === 'dummy-ups') {
    const file = port.startsWith('/') ? port : `${nutDir(sys)}/${port}`
    if (!sys.vfs.exists(file)) return 'Driver not connected'
    for (const raw of readText(sys, file).split('\n')) {
      const m = /^\s*([\w.]+)\s*:\s*(.+?)\s*$/.exec(raw)
      if (m) v.set(m[1], m[2])
    }
    v.set('driver.name', 'dummy-ups')
    v.set('driver.parameter.port', port)
  } else {
    const u = UPS.get(sys)
    if (!u || (driver !== 'usbhid-ups' && driver !== 'nutdrv_qx' && driver !== 'blazer_usb')) return 'Driver not connected'
    v.set('battery.charge', String(u.bateria))
    v.set('battery.charge.low', '10')
    v.set('battery.runtime', String(Math.round(u.autonomia_min * 60)))
    v.set('battery.type', 'PbAc')
    v.set('device.mfr', u.marca)
    v.set('device.model', u.modelo)
    v.set('device.type', 'ups')
    v.set('driver.name', driver)
    v.set('driver.parameter.port', port)
    v.set('input.voltage', u.estado.startsWith('OL') ? '228.0' : '0.0')
    v.set('output.voltage', '228.0')
    v.set('ups.load', String(u.carga))
    v.set('ups.mfr', u.marca)
    v.set('ups.model', u.modelo)
    v.set('ups.realpower.nominal', String(u.potencia_w))
    v.set('ups.status', u.estado)
  }
  return new Map([...v].sort(([a], [b]) => a.localeCompare(b)))
}

function nutMode(sys: System) {
  return /^\s*MODE\s*=\s*"?(\w+)"?/m.exec(readText(sys, `${nutDir(sys)}/nut.conf`))?.[1] ?? 'none'
}

register('upsc', {
  usage: 'upsc ups[@servidor] [variable]',
  path: '/usr/bin',
  run(ctx) {
    const sys = ctx.sys
    const [target, variable] = ctx.args.filter((a) => !a.startsWith('-'))
    if (!target) {
      ctx.err('Error: invalid UPS definition.\nRequired format: upsname[@hostname[:port]]\n')
      return 1
    }
    const [name, host = 'localhost'] = target.split('@')
    let srv: System | undefined = sys
    if (host !== 'localhost' && host !== '127.0.0.1') {
      const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : sys.resolveHost(host)
      const r = ip ? reach(sys, ip, 3493) : undefined
      srv = r && !('error' in r) ? r.target : undefined
      if (!srv) {
        ctx.err('Error: Connection failure: Connection refused\n')
        return 1
      }
    }
    if (!srv.services.get('nut-server')?.active) {
      ctx.err('Error: Connection failure: Connection refused\n')
      return 1
    }
    ctx.err('Init SSL without certificate database\n')
    const v = upsVars(srv, name)
    if (typeof v === 'string') {
      ctx.err(`Error: ${v}\n`)
      return 1
    }
    if (variable) {
      const val = v.get(variable)
      if (val === undefined) {
        ctx.err('Error: Variable not supported by UPS\n')
        return 1
      }
      ctx.out(val + '\n')
      return 0
    }
    for (const [k, val] of v) ctx.out(`${k}: ${val}\n`)
    return 0
  },
})

register('upsdrvctl', {
  usage: 'upsdrvctl start|stop [ups]',
  path: '/usr/sbin',
  run(ctx) {
    const sys = ctx.sys
    const ups = sections(readText(sys, `${nutDir(sys)}/ups.conf`))
    if (!ups.size) {
      ctx.err('Network UPS Tools - UPS driver controller 2.8.1\nNo UPS definitions found in ups.conf\n')
      return 1
    }
    for (const [name, conf] of ups) {
      const v = upsVars(sys, name)
      ctx.err(`Network UPS Tools - UPS driver controller 2.8.1\nNetwork UPS Tools - Generic HID driver 0.52 (2.8.1)\n`)
      if (typeof v === 'string') {
        ctx.err(`${conf.get('driver') === 'usbhid-ups' ? 'No matching HID UPS found' : 'Driver failed to start'}\nDriver failed to start (exit status=1)\n`)
        return 1
      }
    }
    return 0
  },
})

interface MonState {
  last: Record<string, string>
  shutdown: boolean
}
const MON = new WeakMap<System, MonState>()

function upsmonConf(sys: System) {
  const text = readText(sys, `${nutDir(sys)}/upsmon.conf`)
  const mon = [...text.matchAll(/^\s*MONITOR\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(primary|secondary|master|slave)/gm)].map((m) => ({ target: m[1], user: m[3], pass: m[4] }))
  const shutdown = /^\s*SHUTDOWNCMD\s+"?([^"\n]+)"?/m.exec(text)?.[1] ?? '/sbin/shutdown -h +0'
  return { mon, shutdown }
}

function upsmonLog(sys: System, msg: string, prio = 5) {
  sys.journal.push({ time: Date.now(), unit: 'nut-monitor.service', priority: prio, message: msg, ident: 'upsmon', pid: 1402 })
}

/** upsmon mira la UPS antes de cada comando y reacciona a los cambios. */
System.refreshHooks.push((sys) => {
  if (!sys.services.get('nut-monitor')?.active) return
  const st = MON.get(sys) ?? { last: {}, shutdown: false }
  MON.set(sys, st)
  if (st.shutdown) return
  const { mon, shutdown } = upsmonConf(sys)
  for (const m of mon) {
    const [name] = m.target.split('@')
    const users = sections(readText(sys, `${nutDir(sys)}/upsd.users`))
    const u = users.get(m.user)
    if (!sys.services.get('nut-server')?.active) continue
    if (!u || u.get('password') !== m.pass) {
      if (st.last[m.target] !== 'DENIED') upsmonLog(sys, `Login on UPS [${m.target}] failed - got [ACCESS-DENIED]`, 3)
      st.last[m.target] = 'DENIED'
      continue
    }
    const v = upsVars(sys, name)
    if (typeof v === 'string') continue
    const status = v.get('ups.status') ?? ''
    const prev = st.last[m.target]
    if (status === prev) continue
    st.last[m.target] = status
    if (!prev || prev === 'DENIED') {
      if (status.includes('OB')) upsmonLog(sys, `UPS ${m.target} on battery`, 1)
    } else if (status.includes('OB') && !prev.includes('OB')) upsmonLog(sys, `UPS ${m.target} on battery`, 1)
    else if (status.includes('OL') && prev.includes('OB')) upsmonLog(sys, `UPS ${m.target} on line power`, 5)
    if (status.includes('OB') && status.includes('LB')) {
      upsmonLog(sys, `UPS ${m.target} battery is low`, 1)
      upsmonLog(sys, 'Executing automatic power-fail shutdown', 1)
      upsmonLog(sys, `Auto logout and shutdown proceeding`, 1)
      upsmonLog(sys, `[simulador] upsmon ejecutaría: ${shutdown}`, 5)
      st.shutdown = true
    }
  }
})

SERVICE_CHECKS['nut-server'] = (ctx) => {
  const sys = ctx.sys
  const mode = nutMode(sys)
  if (mode === 'none') return `upsd disabled, please adjust the configuration to your needs\nThen set MODE to a suitable value in ${nutDir(sys)}/nut.conf to enable it`
  for (const name of sections(readText(sys, `${nutDir(sys)}/ups.conf`)).keys()) {
    const v = upsVars(sys, name)
    if (typeof v === 'string') return `Can't connect to UPS [${name}] (${v === 'Driver not connected' ? 'dummy-ups-' + name : name}): No such file or directory`
  }
  return undefined
}

SERVICE_CHECKS['nut-monitor'] = (ctx) => {
  const sys = ctx.sys
  if (nutMode(sys) === 'none') return `upsmon disabled, please adjust the configuration to your needs\nThen set MODE to a suitable value in ${nutDir(sys)}/nut.conf to enable it`
  if (!upsmonConf(sys).mon.length) return 'Fatal error: insufficient power configured!\n\nSum of power values: 0\nMinimum value (MINSUPPLIES): 1\n\nEdit your upsmon.conf and change the values.'
  MON.set(sys, { last: {}, shutdown: false })
  return undefined
}

export function verifyHardware(sys: System, check: object): { ok: boolean; label: string } | undefined {
  if ('ups_estado' in check) {
    const c = check as { ups_estado: string; ups: string }
    const v = upsVars(sys, c.ups)
    const ok = sys.services.get('nut-server')?.active === true && typeof v !== 'string' && (v.get('ups.status') ?? '').includes(c.ups_estado)
    return { ok, label: `upsd publica la UPS ${c.ups} con estado ${c.ups_estado}` }
  }
  if ('apagado_ups' in check) {
    const c = check as { apagado_ups: boolean }
    return { ok: !!MON.get(sys)?.shutdown === c.apagado_ups, label: c.apagado_ups ? 'upsmon ordenó el apagado' : 'upsmon no ordenó el apagado' }
  }
  return undefined
}
