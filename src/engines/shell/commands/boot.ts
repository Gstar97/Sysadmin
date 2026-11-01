/**
 * Arranque: GRUB (grub2-mkconfig, update-grub, grubby) e initramfs (dracut, lsinitrd, update-initramfs).
 * Los cambios quedan en los archivos de /boot; /proc/cmdline no cambia hasta reiniciar (y el simulador no reinicia).
 */
import { parseArgs } from '../args'
import { register, type CommandContext } from '../shell'
import { grubCfg, KERNEL_VERSION, MACHINE_ID, rockyBootEntry } from '../system'
import { ROOT_CRED } from '../vfs'

const NOTE_REBOOT = '[simulador] Los parámetros nuevos se usan en el próximo arranque. Hasta reiniciar, /proc/cmdline sigue mostrando los del arranque actual.\n'

/** Lee /etc/default/grub como lo haría la shell: VARIABLE="valor". Devuelve el error de sintaxis si hay uno. */
function readDefaultGrub(ctx: CommandContext): { vars: Record<string, string>; error?: string } {
  const text = ctx.sys.vfs.exists('/etc/default/grub') ? ctx.sys.vfs.readFile('/etc/default/grub', ROOT_CRED) : ''
  const vars: Record<string, string> = {}
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line)
    if (!m) return { vars, error: `/etc/default/grub: line ${i + 1}: ${line.split(/\s+/)[0]}: command not found` }
    let v = m[2]
    const quotes = (v.match(/"/g) ?? []).length
    if (quotes % 2) return { vars, error: `/etc/default/grub: line ${i + 1}: unexpected EOF while looking for matching \`"'` }
    v = v.replace(/^"(.*)"$/, '$1')
    vars[m[1]] = v
  }
  return { vars }
}

function entryPath() {
  return `/boot/loader/entries/${MACHINE_ID}-${KERNEL_VERSION.rocky}.conf`
}

function mkconfig(ctx: CommandContext, rocky: boolean): number {
  const a = parseArgs(ctx.args, { flags: { bls: ['update-bls-cmdline'] }, values: { o: ['o', 'output'] } })
  if (ctx.sh.user !== 'root') {
    ctx.err(`${ctx.name}: You must run this as root\n`)
    return 1
  }
  const { vars, error } = readDefaultGrub(ctx)
  if (error) {
    ctx.err(`${error}\n`)
    return 1
  }
  const extra = [vars.GRUB_CMDLINE_LINUX ?? '', rocky ? '' : (vars.GRUB_CMDLINE_LINUX_DEFAULT ?? '')].filter(Boolean).join(' ')
  const cfg = grubCfg(ctx.sys.distro, extra, vars.GRUB_TIMEOUT ?? '5')
  const out = a.values.get('o')
  if (!rocky) ctx.err("Sourcing file `/etc/default/grub'\n")
  ctx.err('Generating grub configuration file ...\n')
  if (!rocky) ctx.err(`Found linux image: /boot/vmlinuz-${KERNEL_VERSION.ubuntu}\nFound initrd image: /boot/initrd.img-${KERNEL_VERSION.ubuntu}\nWarning: os-prober will not be executed to detect other bootable partitions.\nSystems on them will not be added to the GRUB boot configuration.\nCheck GRUB_DISABLE_OS_PROBER documentation entry.\n`)
  if (ctx.sys.firmware === 'uefi') ctx.err('Adding boot menu entry for UEFI Firmware Settings ...\n')
  ctx.err('done\n')
  if (!out) {
    ctx.out(cfg)
    return 0
  }
  ctx.sys.vfs.writeFile(ctx.sh.resolve(out), cfg, ROOT_CRED)
  if (rocky) {
    // En Rocky (entradas BLS) los parámetros viven en /boot/loader/entries: grub2-mkconfig
    // solo los cambia con --update-bls-cmdline. Lo habitual es usar grubby.
    if (a.flags.has('bls')) {
      ctx.sys.kernelArgs = `root=/dev/mapper/rl-root ro ${extra}`.trim()
      ctx.sys.vfs.writeFile(entryPath(), rockyBootEntry(ctx.sys.kernelArgs), ROOT_CRED)
    } else {
      ctx.err('[simulador] En Rocky los parámetros de cada kernel están en /boot/loader/entries. Sin --update-bls-cmdline, grub2-mkconfig no los cambia: para eso se usa grubby --update-kernel=ALL --args="...".\n')
      return 0
    }
  } else ctx.sys.kernelArgs = `root=/dev/mapper/ubuntu--vg-ubuntu--lv ro ${extra}`.trim()
  ctx.err(NOTE_REBOOT)
  return 0
}

register('grub2-mkconfig', {
  usage: 'grub2-mkconfig [-o FILE] [--update-bls-cmdline]',
  path: '/usr/sbin',
  run: (ctx) => mkconfig(ctx, true),
})

register('grub-mkconfig', {
  usage: 'grub-mkconfig [-o FILE]',
  path: '/usr/sbin',
  run: (ctx) => mkconfig(ctx, false),
})

register('update-grub', {
  usage: 'update-grub',
  path: '/usr/sbin',
  run(ctx) {
    return mkconfig({ ...ctx, name: 'update-grub', args: ['-o', '/boot/grub/grub.cfg'] }, false)
  },
})

register('grubby', {
  usage: 'grubby [OPTION...]',
  path: '/usr/sbin',
  summary:
    '  --info=ALL|DEFAULT|KERNEL   Muestra las entradas de arranque\n  --default-kernel            Kernel que arranca por defecto\n  --update-kernel=ALL|DEFAULT --args="..." --remove-args="..."   Cambia parámetros del kernel',
  run(ctx) {
    const a = parseArgs(ctx.args, {
      flags: { dk: ['default-kernel'], di: ['default-index'], dt: ['default-title'] },
      values: { info: ['info'], update: ['update-kernel'], args: ['args'], remove: ['remove-args'], setdef: ['set-default'] },
    })
    const k = KERNEL_VERSION.rocky
    const sys = ctx.sys
    const entry = () => ({
      kernel: `/boot/vmlinuz-${k}`,
      args: sys.kernelArgs.replace(/^root=\S+\s*/, ''),
      root: /root=(\S+)/.exec(sys.kernelArgs)?.[1] ?? '/dev/mapper/rl-root',
    })
    if (a.flags.has('dk')) {
      ctx.out(`/boot/vmlinuz-${k}\n`)
      return 0
    }
    if (a.flags.has('di')) {
      ctx.out('0\n')
      return 0
    }
    if (a.flags.has('dt')) {
      ctx.out(`Rocky Linux (${k}) 10.0 (Red Quartz)\n`)
      return 0
    }
    if (a.values.has('info')) {
      if (ctx.sh.user !== 'root') {
        ctx.err('grubby: Permission denied\n')
        return 1
      }
      const which = a.values.get('info')!
      const e = entry()
      const blocks = [
        `index=0\nkernel="${e.kernel}"\nargs="${e.args}"\nroot="${e.root}"\ninitrd="/boot/initramfs-${k}.img"\ntitle="Rocky Linux (${k}) 10.0 (Red Quartz)"\nid="${MACHINE_ID}-${k}"\n`,
        `index=1\nkernel="/boot/vmlinuz-0-rescue-${MACHINE_ID}"\nargs="${e.args}"\nroot="${e.root}"\ninitrd="/boot/initramfs-0-rescue-${MACHINE_ID}.img"\ntitle="Rocky Linux (0-rescue-${MACHINE_ID}) 10.0 (Red Quartz)"\nid="${MACHINE_ID}-0-rescue"\n`,
      ]
      if (which === 'ALL') ctx.out(blocks.join(''))
      else if (which === 'DEFAULT' || which === e.kernel || which === '0') ctx.out(blocks[0])
      else {
        ctx.err(`The param ${which} is incorrect\n`)
        return 1
      }
      return 0
    }
    if (a.values.has('update')) {
      if (ctx.sh.user !== 'root') {
        ctx.err('grubby: Permission denied\n')
        return 1
      }
      const target = a.values.get('update')!
      if (!['ALL', 'DEFAULT', `/boot/vmlinuz-${k}`].includes(target)) {
        ctx.err(`The param ${target} is incorrect\n`)
        return 1
      }
      let parts = sys.kernelArgs.split(/\s+/).filter(Boolean)
      for (const r of (a.values.get('remove') ?? '').split(/\s+/).filter(Boolean)) {
        const key = r.split('=')[0]
        parts = parts.filter((p) => (r.includes('=') ? p !== r : p.split('=')[0] !== key))
      }
      // Un parámetro nuevo reemplaza al que ya tenía la misma clave; los nuevos de una misma
      // orden se agregan todos (console=tty0 console=ttyS0 quedan los dos).
      const adds = (a.values.get('args') ?? '').split(/\s+/).filter(Boolean)
      const keys = new Set(adds.map((x) => x.split('=')[0]))
      parts = parts.filter((p) => !keys.has(p.split('=')[0]))
      parts.push(...adds)
      sys.kernelArgs = parts.join(' ')
      sys.vfs.writeFile(entryPath(), rockyBootEntry(sys.kernelArgs), ROOT_CRED)
      ctx.err(NOTE_REBOOT)
      return 0
    }
    if (a.values.has('setdef')) return 0
    ctx.err('Usage: grubby [OPTION...]\n  --info=ALL|DEFAULT  --default-kernel  --update-kernel=ALL --args="..." --remove-args="..."\n')
    return 1
  },
})

register('dracut', {
  usage: 'dracut [OPTION...] [<image> [<kernel version>]]',
  path: '/usr/bin',
  run(ctx) {
    if (ctx.sh.user !== 'root') {
      ctx.err('dracut: Cannot write to /boot: Permission denied\n')
      return 1
    }
    const force = ctx.args.some((x) => x === '-f' || x === '--force' || x === '--regenerate-all')
    const img = `/boot/initramfs-${KERNEL_VERSION.rocky}.img`
    if (!force && ctx.sys.vfs.exists(img)) {
      ctx.err(`dracut[F]: Will not override existing initramfs (${img}) without --force\n`)
      return 1
    }
    if (ctx.args.some((x) => x === '-v' || x === '--verbose')) {
      ctx.err(`dracut[I]: Executing: /usr/bin/dracut -f -v\ndracut[I]: *** Including module: systemd ***\ndracut[I]: *** Including module: lvm ***\ndracut[I]: *** Including module: xfs ***\ndracut[I]: *** Creating image file '${img}' ***\ndracut[I]: *** Creating initramfs image file '${img}' done ***\n`)
    }
    ctx.sys.vfs.writeFile(img, '', ROOT_CRED)
    return 0
  },
})

register('lsinitrd', {
  usage: 'lsinitrd [IMAGE]',
  path: '/usr/bin',
  run(ctx) {
    if (ctx.sh.user !== 'root') {
      ctx.err(`lsinitrd: /boot/initramfs-${KERNEL_VERSION.rocky}.img: Permission denied\n`)
      return 1
    }
    ctx.out(
      `Image: /boot/initramfs-${KERNEL_VERSION.rocky}.img: 38M\n========================================================================\nEarly CPIO image\n========================================================================\nVersion: dracut-105-4.el10\n\nArguments:  --kver '${KERNEL_VERSION.rocky}' -f\n\ndracut modules:\nbash\nsystemd\nsystemd-initrd\nkernel-modules\nlvm\nxfs\nresume\nrootfs-block\nterminfo\nudev-rules\nshutdown\n========================================================================\ndrwxr-xr-x  12 root root 0 Nov  1 00:00 .\nlrwxrwxrwx   1 root root 7 Nov  1 00:00 bin -> usr/bin\ndrwxr-xr-x   2 root root 0 Nov  1 00:00 dev\ndrwxr-xr-x  11 root root 0 Nov  1 00:00 etc\n-rw-r--r--   1 root root 0 Nov  1 00:00 etc/fstab.empty\nlrwxrwxrwx   1 root root 23 Nov  1 00:00 init -> usr/lib/systemd/systemd\n========================================================================\n`,
    )
    return 0
  },
})

register('update-initramfs', {
  usage: 'update-initramfs {-c|-d|-u} [-k version] [-v]',
  path: '/usr/sbin',
  run(ctx) {
    if (ctx.sh.user !== 'root') {
      ctx.err('update-initramfs: Cannot write to /boot: Permission denied\n')
      return 1
    }
    if (!ctx.args.some((x) => ['-u', '-c', '-d'].includes(x))) {
      ctx.err('Usage: update-initramfs {-c|-d|-u} [-k version] [-v] [-b directory]\n')
      return 2
    }
    ctx.out(`update-initramfs: Generating /boot/initrd.img-${KERNEL_VERSION.ubuntu}\n`)
    ctx.sys.vfs.writeFile(`/boot/initrd.img-${KERNEL_VERSION.ubuntu}`, '', ROOT_CRED)
    return 0
  },
})
