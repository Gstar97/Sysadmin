import { parseArgs } from '../args'
import { register, type CommandContext } from '../shell'
import { basename, FsError, modeString, normalizePath, octal, type Inode } from '../vfs'
import { applyChmod, COLOR, fsErr, humanSize, lines, lsDate, readInputs, sizeOf } from './util'

function colorName(name: string, node: Inode, tty: boolean): string {
  if (!tty) return name
  if (node.type === 'dir') return (node.mode & 0o1002) === 0o1002 ? `${COLOR.sticky}${name}${COLOR.reset}` : `${COLOR.dir}${name}${COLOR.reset}`
  if (node.type === 'symlink') return `${COLOR.link}${name}${COLOR.reset}`
  if (node.mode & 0o111) return `${COLOR.exec}${name}${COLOR.reset}`
  return name
}

register('ls', {
  usage: 'ls [OPTION]... [FILE]...',
  summary: 'List information about the FILEs (the current directory by default).\n  -a, --all  -A  -l  -h  -d  -R  -r  -t  -S  -i  -1  -F',
  run(ctx) {
    const a = parseArgs(ctx.args, {
      flags: { all: ['a', 'all'], almost: ['A', 'almost-all'], long: ['l'], human: ['h', 'human-readable'], dir: ['d', 'directory'], recursive: ['R', 'recursive'], reverse: ['r', 'reverse'], time: ['t'], size: ['S'], inode: ['i', 'inode'], one: ['1'], classify: ['F', 'classify'], color: ['color'] },
    })
    if (a.unknown) {
      ctx.err(`ls: invalid option -- '${a.unknown.replace(/^-+/, '')}'\nTry 'ls --help' for more information.\n`)
      return 2
    }
    const { vfs } = ctx.sys
    const cred = ctx.sh.cred
    const f = a.flags
    const targets = a.rest.length ? a.rest : ['.']
    let code = 0
    const files: { name: string; node: Inode; abs: string }[] = []
    const dirs: { name: string; abs: string }[] = []
    for (const t of targets) {
      const abs = ctx.sh.resolve(t)
      try {
        const own = vfs.stat(abs, cred, false)
        const node = own.type === 'symlink' && f.has('long') ? own : vfs.stat(abs, cred)
        if (node.type === 'dir' && !f.has('dir')) dirs.push({ name: t, abs })
        else files.push({ name: t, node: f.has('long') ? own : node, abs })
      } catch (e) {
        if (e instanceof FsError) {
          ctx.err(`ls: cannot access '${t}': ${e.message}\n`)
          code = 2
        } else throw e
      }
    }

    const sortEntries = (list: { name: string; node: Inode }[]) => {
      list.sort((x, y) => x.name.replace(/^\./, '').localeCompare(y.name.replace(/^\./, ''), 'en', { sensitivity: 'base' }))
      if (f.has('time')) list.sort((x, y) => y.node.mtime - x.node.mtime)
      if (f.has('size')) list.sort((x, y) => sizeOf(y.node) - sizeOf(x.node))
      if (f.has('reverse')) list.reverse()
      return list
    }

    const render = (list: { name: string; node: Inode; abs?: string }[], showTotal: boolean) => {
      if (f.has('long')) {
        if (showTotal) ctx.out(`total ${list.reduce((s, e) => s + Math.ceil(sizeOf(e.node) / 4096) * 4, 0)}\n`)
        const rows = list.map((e) => {
          const size = f.has('human') ? humanSize(sizeOf(e.node)) : String(sizeOf(e.node))
          const target = e.node.type === 'symlink' ? ` -> ${e.node.data}` : ''
          return {
            ino: String(e.node.ino),
            perm: modeString(e.node) + '.',
            links: String(e.node.nlink),
            user: ctx.sys.userName(e.node.uid),
            group: ctx.sys.groupName(e.node.gid),
            size,
            date: lsDate(e.node.mtime),
            name: colorName(e.name, e.node, ctx.isTTY) + target + (f.has('classify') && e.node.type === 'dir' ? '/' : ''),
          }
        })
        const w = (k: keyof (typeof rows)[number]) => Math.max(...rows.map((r) => r[k].length))
        for (const r of rows) {
          ctx.out(
            `${f.has('inode') ? r.ino.padStart(w('ino')) + ' ' : ''}${r.perm} ${r.links.padStart(w('links'))} ${r.user.padEnd(w('user'))} ${r.group.padEnd(w('group'))} ${r.size.padStart(w('size'))} ${r.date} ${r.name}\n`,
          )
        }
      } else {
        const names = list.map((e) => (f.has('inode') ? `${e.node.ino} ` : '') + colorName(e.name, e.node, ctx.isTTY) + (f.has('classify') ? (e.node.type === 'dir' ? '/' : e.node.mode & 0o111 && e.node.type === 'file' ? '*' : '') : ''))
        if (names.length) ctx.out((f.has('one') || !ctx.isTTY ? names.join('\n') : names.join('  ')) + '\n')
      }
    }

    if (files.length) render(sortEntries(files), false)
    const listDir = (d: { name: string; abs: string }, header: boolean) => {
      let names: string[]
      try {
        names = vfs.readdir(d.abs, cred)
      } catch (e) {
        if (e instanceof FsError) {
          ctx.err(`ls: cannot open directory '${d.name}': ${e.message}\n`)
          code = 2
          return
        }
        throw e
      }
      if (header) ctx.out(`${d.name}:\n`)
      let entries = names
        .filter((n) => f.has('all') || f.has('almost') || !n.startsWith('.'))
        .map((n) => {
          const abs = d.abs === '/' ? `/${n}` : `${d.abs}/${n}`
          let node: Inode
          try {
            node = vfs.stat(abs, cred, false)
          } catch {
            node = vfs.get(vfs.get(vfs.resolve(d.abs, cred)).entries!.get(n)!)
          }
          return { name: n, node, abs }
        })
      if (f.has('all')) {
        const self = vfs.stat(d.abs, cred)
        const parent = vfs.stat(normalizePath(`${d.abs}/..`), cred)
        entries = [{ name: '.', node: self, abs: d.abs }, { name: '..', node: parent, abs: d.abs }, ...entries]
      }
      render(sortEntries(entries), true)
      if (f.has('recursive')) {
        for (const e of entries) {
          if (e.node.type === 'dir' && e.name !== '.' && e.name !== '..') {
            ctx.out('\n')
            listDir({ name: d.name === '.' ? `./${e.name}` : `${d.name.replace(/\/$/, '')}/${e.name}`, abs: e.abs }, true)
          }
        }
      }
    }
    dirs.forEach((d, i) => {
      if (i > 0 || files.length) ctx.out('\n')
      listDir(d, targets.length > 1 || f.has('recursive'))
    })
    return code
  },
})

register('mkdir', {
  usage: 'mkdir [OPTION]... DIRECTORY...',
  summary: '  -p, --parents   no error if existing, make parent directories as needed\n  -m, --mode=MODE set file mode\n  -v, --verbose',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { parents: ['p', 'parents'], verbose: ['v', 'verbose'] }, values: { mode: ['m', 'mode'] } })
    if (!a.rest.length) {
      ctx.err("mkdir: missing operand\nTry 'mkdir --help' for more information.\n")
      return 1
    }
    let code = 0
    const mode = a.values.has('mode') ? applyChmod(a.values.get('mode')!, 0o777 & ~ctx.sh.umask, true) ?? 0o755 : 0o777 & ~ctx.sh.umask
    for (const d of a.rest) {
      const abs = ctx.sh.resolve(d)
      try {
        if (a.flags.has('parents')) ctx.sys.vfs.mkdirp(abs, ctx.sh.cred, 0o777 & ~ctx.sh.umask)
        else ctx.sys.vfs.mkdir(abs, ctx.sh.cred, mode)
        if (a.values.has('mode')) ctx.sys.vfs.stat(abs, ctx.sh.cred).mode = mode | (ctx.sys.vfs.stat(abs, ctx.sh.cred).mode & 0o2000)
        if (a.flags.has('verbose')) ctx.out(`mkdir: created directory '${d}'\n`)
      } catch (e) {
        code = fsErr(ctx, e, 'cannot create directory', d)
      }
    }
    return code
  },
})

register('rmdir', {
  usage: 'rmdir [OPTION]... DIRECTORY...',
  run(ctx) {
    let code = 0
    for (const d of ctx.args.filter((x) => !x.startsWith('-'))) {
      try {
        ctx.sys.vfs.rmdir(ctx.sh.resolve(d), ctx.sh.cred)
      } catch (e) {
        code = fsErr(ctx, e, 'failed to remove', d)
      }
    }
    return code
  },
})

register('touch', {
  usage: 'touch [OPTION]... FILE...',
  run(ctx) {
    const files = ctx.args.filter((x) => !x.startsWith('-'))
    if (!files.length) {
      ctx.err("touch: missing file operand\nTry 'touch --help' for more information.\n")
      return 1
    }
    let code = 0
    for (const f of files) {
      const abs = ctx.sh.resolve(f)
      try {
        const existed = ctx.sys.vfs.exists(abs, ctx.sh.cred)
        ctx.sys.vfs.touch(abs, ctx.sh.cred)
        if (!existed) ctx.sys.vfs.stat(abs, ctx.sh.cred).mode = 0o666 & ~ctx.sh.umask
      } catch (e) {
        code = fsErr(ctx, e, 'cannot touch', f)
      }
    }
    return code
  },
})

register('cp', {
  usage: 'cp [OPTION]... SOURCE... DEST',
  summary: '  -r, -R, --recursive  -a, --archive  -p  -v  -i',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { recursive: ['r', 'R', 'recursive'], archive: ['a', 'archive'], preserve: ['p'], verbose: ['v', 'verbose'], interactive: ['i'], force: ['f', 'force'] } })
    if (a.rest.length < 2) {
      ctx.err(a.rest.length ? `cp: missing destination file operand after '${a.rest[0]}'\n` : 'cp: missing file operand\n')
      return 1
    }
    const dest = a.rest[a.rest.length - 1]
    const sources = a.rest.slice(0, -1)
    const vfs = ctx.sys.vfs
    const destAbs = ctx.sh.resolve(dest)
    if (sources.length > 1 && !(vfs.exists(destAbs, ctx.sh.cred) && vfs.stat(destAbs, ctx.sh.cred).type === 'dir')) {
      ctx.err(`cp: target '${dest}': Not a directory\n`)
      return 1
    }
    let code = 0
    for (const s of sources) {
      const abs = ctx.sh.resolve(s)
      try {
        const node = vfs.stat(abs, ctx.sh.cred)
        if (node.type === 'dir' && !a.flags.has('recursive') && !a.flags.has('archive')) {
          ctx.err(`cp: -r not specified; omitting directory '${s}'\n`)
          code = 1
          continue
        }
        vfs.copy(abs, destAbs, ctx.sh.cred, { recursive: a.flags.has('recursive') || a.flags.has('archive'), preserve: a.flags.has('archive') || a.flags.has('preserve') })
        if (a.flags.has('verbose')) ctx.out(`'${s}' -> '${dest}'\n`)
      } catch (e) {
        code = fsErr(ctx, e, 'cannot stat', s)
      }
    }
    return code
  },
})

register('mv', {
  usage: 'mv [OPTION]... SOURCE... DEST',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { verbose: ['v', 'verbose'], force: ['f', 'force'], interactive: ['i'] } })
    if (a.rest.length < 2) {
      ctx.err(a.rest.length ? `mv: missing destination file operand after '${a.rest[0]}'\n` : 'mv: missing file operand\n')
      return 1
    }
    const dest = a.rest[a.rest.length - 1]
    let code = 0
    for (const s of a.rest.slice(0, -1)) {
      try {
        ctx.sys.vfs.rename(ctx.sh.resolve(s), ctx.sh.resolve(dest), ctx.sh.cred)
        if (a.flags.has('verbose')) ctx.out(`renamed '${s}' -> '${dest}'\n`)
      } catch (e) {
        if (e instanceof FsError && e.code === 'ENOENT') {
          ctx.err(`mv: cannot stat '${s}': No such file or directory\n`)
          code = 1
        } else code = fsErr(ctx, e, `cannot move '${s}' to`, dest)
      }
    }
    return code
  },
})

register('rm', {
  usage: 'rm [OPTION]... [FILE]...',
  summary: '  -f, --force  -r, -R, --recursive  -v, --verbose  -d, --dir',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { force: ['f', 'force'], recursive: ['r', 'R', 'recursive'], verbose: ['v', 'verbose'], dir: ['d', 'dir'], interactive: ['i'] } })
    if (!a.rest.length) {
      if (a.flags.has('force')) return 0
      ctx.err("rm: missing operand\nTry 'rm --help' for more information.\n")
      return 1
    }
    let code = 0
    for (const f of a.rest) {
      const abs = ctx.sh.resolve(f)
      if (abs === '/' ) {
        ctx.err("rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe\n")
        code = 1
        continue
      }
      try {
        const node = ctx.sys.vfs.stat(abs, ctx.sh.cred, false)
        if (node.type === 'dir') {
          if (a.flags.has('recursive')) ctx.sys.vfs.removeTree(abs, ctx.sh.cred)
          else if (a.flags.has('dir')) ctx.sys.vfs.rmdir(abs, ctx.sh.cred)
          else {
            ctx.err(`rm: cannot remove '${f}': Is a directory\n`)
            code = 1
            continue
          }
        } else ctx.sys.vfs.unlink(abs, ctx.sh.cred)
        if (a.flags.has('verbose')) ctx.out(`removed '${f}'\n`)
      } catch (e) {
        if (e instanceof FsError && e.code === 'ENOENT' && a.flags.has('force')) continue
        code = fsErr(ctx, e, 'cannot remove', f)
      }
    }
    return code
  },
})

register('ln', {
  usage: 'ln [OPTION]... TARGET LINK_NAME',
  summary: '  -s, --symbolic  -f, --force  -v',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { symbolic: ['s', 'symbolic'], force: ['f', 'force'], verbose: ['v'] } })
    if (a.rest.length < 1) {
      ctx.err('ln: missing file operand\n')
      return 1
    }
    const target = a.rest[0]
    let linkName = a.rest[1] ?? basename(target)
    const vfs = ctx.sys.vfs
    let abs = ctx.sh.resolve(linkName)
    if (vfs.exists(abs, ctx.sh.cred) && vfs.stat(abs, ctx.sh.cred).type === 'dir') {
      linkName = `${linkName}/${basename(target)}`
      abs = ctx.sh.resolve(linkName)
    }
    try {
      if (a.flags.has('force') && vfs.exists(abs, ctx.sh.cred, false)) vfs.unlink(abs, ctx.sh.cred)
      if (a.flags.has('symbolic')) vfs.symlink(target, abs, ctx.sh.cred)
      else vfs.link(ctx.sh.resolve(target), abs, ctx.sh.cred)
      return 0
    } catch (e) {
      if (e instanceof FsError && e.code === 'EEXIST') {
        ctx.err(`ln: failed to create ${a.flags.has('symbolic') ? 'symbolic' : 'hard'} link '${linkName}': File exists\n`)
        return 1
      }
      if (e instanceof FsError && e.code === 'EPERM') {
        ctx.err(`ln: ${target}: hard link not allowed for directory\n`)
        return 1
      }
      return fsErr(ctx, e, 'failed to access', target)
    }
  },
})

register('cat', {
  usage: 'cat [OPTION]... [FILE]...',
  summary: '  -n, --number  -A, --show-all',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { number: ['n', 'number'], all: ['A', 'show-all'], ends: ['E'] } })
    let code = 0
    const files = a.rest.length ? a.rest : ['-']
    let n = 1
    for (const f of files) {
      let data: string
      if (f === '-') data = ctx.stdin.readAll()
      else {
        try {
          data = ctx.sys.vfs.readFile(ctx.sh.resolve(f), ctx.sh.cred)
        } catch (e) {
          if (e instanceof FsError) {
            ctx.err(`cat: ${f}: ${e.message}\n`)
            code = 1
            continue
          }
          throw e
        }
      }
      if (a.flags.has('all') || a.flags.has('ends')) data = data.replace(/\r/g, '^M').replace(/\t/g, a.flags.has('all') ? '^I' : '\t').replace(/\n/g, '$\n')
      if (a.flags.has('number')) data = lines(data).map((l) => `${String(n++).padStart(6)}\t${l}\n`).join('')
      ctx.out(data)
    }
    return code
  },
})

function headTail(ctx: CommandContext, tail: boolean) {
  const args = ctx.args.map((x) => (/^-\d+$/.test(x) ? `-n${x.slice(1)}` : x))
  const a = parseArgs(args, { flags: { follow: ['f', 'follow'], F: ['F'], quiet: ['q'] }, values: { lines: ['n', 'lines'], bytes: ['c', 'bytes'] } })
  const n = Number((a.values.get('lines') ?? '10').replace(/^\+/, ''))
  const inputs = readInputs(ctx, a.rest)
  if (typeof inputs === 'number') return inputs
  inputs.forEach((inp, i) => {
    if (inputs.length > 1) ctx.out(`${i ? '\n' : ''}==> ${inp.name} <==\n`)
    const ls = lines(inp.data)
    const fromStart = tail && (a.values.get('lines') ?? '').startsWith('+')
    const sel = tail ? (fromStart ? ls.slice(n - 1) : ls.slice(Math.max(0, ls.length - n))) : ls.slice(0, n)
    if (sel.length) ctx.out(sel.join('\n') + '\n')
  })
  if (tail && (a.flags.has('follow') || a.flags.has('F'))) {
    ctx.err('[simulador] tail -f se queda esperando líneas nuevas; aquí termina enseguida. En un servidor real se corta con Ctrl+C.\n')
  }
  return 0
}

register('head', { usage: 'head [OPTION]... [FILE]...', summary: '  -n, --lines=NUM  -c, --bytes=NUM', run: (ctx) => headTail(ctx, false) })
register('tail', { usage: 'tail [OPTION]... [FILE]...', summary: '  -n, --lines=NUM  -f, --follow', run: (ctx) => headTail(ctx, true) })

register(['less', 'more'], {
  usage: 'less [FILE]',
  run(ctx) {
    const inputs = readInputs(ctx, ctx.args.filter((a) => !a.startsWith('-')))
    if (typeof inputs === 'number') return inputs
    for (const i of inputs) ctx.out(i.data)
    if (ctx.isTTY) ctx.err('[simulador] less muestra el archivo completo. En un servidor real se avanza con espacio, se busca con / y se sale con q.\n')
    return 0
  },
})

register('file', {
  usage: 'file FILE...',
  run(ctx) {
    let code = 0
    for (const f of ctx.args.filter((x) => !x.startsWith('-'))) {
      try {
        const node = ctx.sys.vfs.stat(ctx.sh.resolve(f), ctx.sh.cred, false)
        let kind: string
        if (node.type === 'dir') kind = 'directory'
        else if (node.type === 'symlink') kind = `symbolic link to ${node.data}`
        else if (!node.data) kind = 'empty'
        else if (node.data.startsWith('#!/bin/bash') || node.data.startsWith('#!/usr/bin/env bash')) kind = `Bourne-Again shell script, ASCII text executable${node.data.includes('\r\n') ? ', with CRLF line terminators' : ''}`
        else if (node.data.startsWith('#!/usr/bin/python3') || node.data.startsWith('#!/usr/bin/env python3')) kind = 'Python script, ASCII text executable'
        else if (node.data.startsWith('#!/bin/sh')) kind = 'POSIX shell script, ASCII text executable'
        else if (/^\s*<(!DOCTYPE )?html/i.test(node.data)) kind = 'HTML document, ASCII text'
        // eslint-disable-next-line no-control-regex
        else if (/[^\x00-\x7f]/.test(node.data)) kind = `Unicode text, UTF-8 text${node.data.includes('\r\n') ? ', with CRLF line terminators' : ''}`
        else kind = `ASCII text${node.data.includes('\r\n') ? ', with CRLF line terminators' : ''}`
        ctx.out(`${f}: ${kind}\n`)
      } catch (e) {
        if (e instanceof FsError) {
          ctx.out(`${f}: cannot open \`${f}' (${e.message})\n`)
          code = 1
        } else throw e
      }
    }
    return code
  },
})

register('stat', {
  usage: 'stat [OPTION]... FILE...',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { L: ['L'] }, values: { format: ['c', 'format'] } })
    let code = 0
    for (const f of a.rest) {
      try {
        const node = ctx.sys.vfs.stat(ctx.sh.resolve(f), ctx.sh.cred, a.flags.has('L'))
        const fmt = a.values.get('format')
        if (fmt) {
          ctx.out(
            fmt
              .replace(/%a/g, (node.mode & 0o7777).toString(8))
              .replace(/%A/g, modeString(node))
              .replace(/%U/g, ctx.sys.userName(node.uid))
              .replace(/%G/g, ctx.sys.groupName(node.gid))
              .replace(/%s/g, String(sizeOf(node)))
              .replace(/%n/g, f)
              .replace(/%i/g, String(node.ino))
              .replace(/%h/g, String(node.nlink)) + '\n',
          )
          continue
        }
        const type = node.type === 'dir' ? 'directory' : node.type === 'symlink' ? 'symbolic link' : sizeOf(node) ? 'regular file' : 'regular empty file'
        const d = new Date(node.mtime).toISOString().replace('T', ' ').replace('Z', '000000 +0000')
        ctx.out(
          `  File: ${f}${node.type === 'symlink' ? ` -> ${node.data}` : ''}\n  Size: ${sizeOf(node)}\t\tBlocks: ${Math.ceil(sizeOf(node) / 512)}\tIO Block: 4096   ${type}\nDevice: 253,0\tInode: ${node.ino}\tLinks: ${node.nlink}\nAccess: (${octal(node.mode)}/${modeString(node)})  Uid: (${String(node.uid).padStart(5)}/${ctx.sys.userName(node.uid).padStart(8)})   Gid: (${String(node.gid).padStart(5)}/${ctx.sys.groupName(node.gid).padStart(8)})\nModify: ${d}\n`,
        )
      } catch (e) {
        code = fsErr(ctx, e, 'cannot stat', f)
      }
    }
    return code
  },
})

register('find', {
  usage: 'find [PATH...] [EXPRESSION]',
  summary: '  -name PATTERN  -iname  -type f|d|l  -user NAME  -group NAME  -perm MODE  -size [+-]N[kMG]  -mtime [+-]N  -maxdepth N  -empty  -exec CMD {} \\;',
  async run(ctx) {
    const paths: string[] = []
    let i = 0
    while (i < ctx.args.length && !ctx.args[i].startsWith('-') && ctx.args[i] !== '!' && ctx.args[i] !== '(') paths.push(ctx.args[i++])
    if (!paths.length) paths.push('.')
    type Test = (abs: string, node: import('../vfs').Inode, depth: number) => boolean
    const tests: Test[] = []
    let maxdepth = Infinity
    let mindepth = 0
    let negateNext = false
    let execCmd: string[] | null = null
    const add = (t: Test) => {
      const neg = negateNext
      negateNext = false
      tests.push(neg ? (a, n, d) => !t(a, n, d) : t)
    }
    const toRegex = (p: string, flags = '') =>
      new RegExp('^' + p.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', flags)
    while (i < ctx.args.length) {
      const opt = ctx.args[i++]
      const val = ctx.args[i]
      switch (opt) {
        case '!':
        case '-not':
          negateNext = true
          break
        case '-name':
        case '-iname': {
          const re = toRegex(val, opt === '-iname' ? 'i' : '')
          add((abs) => re.test(abs.slice(abs.lastIndexOf('/') + 1)))
          i++
          break
        }
        case '-path': {
          const re = toRegex(val)
          add((abs) => re.test(abs))
          i++
          break
        }
        case '-type': {
          const t = val
          add((_a, n) => (t === 'f' ? n.type === 'file' : t === 'd' ? n.type === 'dir' : t === 'l' ? n.type === 'symlink' : false))
          i++
          break
        }
        case '-user': {
          const uid = ctx.sys.users.get(val)?.uid ?? Number(val)
          add((_a, n) => n.uid === uid)
          i++
          break
        }
        case '-group': {
          const gid = ctx.sys.groups.get(val)?.gid ?? Number(val)
          add((_a, n) => n.gid === gid)
          i++
          break
        }
        case '-nouser':
          add((_a, n) => !ctx.sys.userByUid(n.uid))
          break
        case '-perm': {
          const mode = val
          if (mode.startsWith('-')) {
            const m = parseInt(mode.slice(1), 8)
            add((_a, n) => (n.mode & m) === m)
          } else if (mode.startsWith('/')) {
            const m = parseInt(mode.slice(1), 8)
            add((_a, n) => (n.mode & m) !== 0)
          } else {
            const m = parseInt(mode, 8)
            add((_a, n) => (n.mode & 0o7777) === m)
          }
          i++
          break
        }
        case '-size': {
          const m = /^([+-]?)(\d+)([ckMG]?)$/.exec(val ?? '')
          if (m) {
            const unit = m[3] === 'c' ? 1 : m[3] === 'k' ? 1024 : m[3] === 'M' ? 1024 ** 2 : m[3] === 'G' ? 1024 ** 3 : 512
            const n = Number(m[2]) * unit
            add((_a, node) => {
              const s = sizeOf(node)
              return m[1] === '+' ? s > n : m[1] === '-' ? s < n : Math.ceil(s / unit) === Number(m[2])
            })
          }
          i++
          break
        }
        case '-mtime':
        case '-mmin': {
          const m = /^([+-]?)(\d+)$/.exec(val ?? '')
          if (m) {
            const unit = opt === '-mtime' ? 86_400_000 : 60_000
            const n = Number(m[2])
            add((_a, node) => {
              const age = Math.floor((Date.now() - node.mtime) / unit)
              return m[1] === '+' ? age > n : m[1] === '-' ? age < n : age === n
            })
          }
          i++
          break
        }
        case '-empty':
          add((_a, n) => (n.type === 'dir' ? n.entries!.size === 0 : n.data.length === 0))
          break
        case '-maxdepth':
          maxdepth = Number(val)
          i++
          break
        case '-mindepth':
          mindepth = Number(val)
          i++
          break
        case '-print':
          break
        case '-exec': {
          const end = ctx.args.indexOf(';', i)
          const end2 = ctx.args.indexOf('+', i)
          const stop = end >= 0 ? end : end2
          execCmd = ctx.args.slice(i, stop < 0 ? undefined : stop)
          i = stop < 0 ? ctx.args.length : stop + 1
          break
        }
        case '-delete':
          execCmd = ['rm', '-rf', '{}']
          break
        default:
          ctx.err(`find: unknown predicate \`${opt}'\n`)
          return 1
      }
    }
    let code = 0
    const found: string[] = []
    for (const p of paths) {
      const start = ctx.sh.resolve(p)
      try {
        ctx.sys.vfs.walk(
          start,
          ctx.sh.cred,
          (abs, node, depth) => {
            if (depth > maxdepth) return false
            if (depth >= mindepth && tests.every((t) => t(abs, node, depth))) {
              const shown = p === '.' ? (abs === start ? '.' : '.' + abs.slice(start === '/' ? 0 : start.length)) : p.replace(/\/$/, '') + abs.slice(start.length)
              found.push(shown || '/')
            }
            return depth < maxdepth
          },
          (abs) => {
            const shown = p === '.' ? '.' + abs.slice(start.length) : p.replace(/\/$/, '') + abs.slice(start.length)
            ctx.err(`find: '${shown}': Permission denied\n`)
            code = 1
          },
        )
      } catch (e) {
        if (e instanceof FsError) {
          ctx.err(`find: '${p}': ${e.message}\n`)
          code = 1
        } else throw e
      }
    }
    if (execCmd) {
      for (const f of found) {
        const argv = execCmd.map((x) => (x === '{}' ? f : x))
        await ctx.sh.invoke(argv, { stdin: ctx.stdin, out: ctx.out, err: ctx.err, isTTY: ctx.isTTY })
      }
    } else if (found.length) ctx.out(found.join('\n') + '\n')
    return code
  },
})

register('du', {
  usage: 'du [OPTION]... [FILE]...',
  summary: '  -s, --summarize  -h, --human-readable  -a  -c  --max-depth=N',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { summarize: ['s', 'summarize'], human: ['h', 'human-readable'], all: ['a', 'all'], total: ['c', 'total'] }, values: { depth: ['d', 'max-depth'] } })
    const targets = a.rest.length ? a.rest : ['.']
    const fmt = (bytes: number) => (a.flags.has('human') ? humanSize(Math.max(4096, Math.ceil(bytes / 4096) * 4096)) : String(Math.max(4, Math.ceil(bytes / 4096) * 4)))
    let code = 0
    let grand = 0
    const maxDepth = a.flags.has('summarize') ? 0 : a.values.has('depth') ? Number(a.values.get('depth')) : Infinity
    for (const t of targets) {
      const abs = ctx.sh.resolve(t)
      const sizes = new Map<string, number>()
      const order: { abs: string; depth: number; dir: boolean }[] = []
      try {
        ctx.sys.vfs.walk(
          abs,
          ctx.sh.cred,
          (p, node, depth) => {
            order.push({ abs: p, depth, dir: node.type === 'dir' })
            sizes.set(p, node.type === 'dir' ? 4096 : sizeOf(node))
          },
          (p) => {
            ctx.err(`du: cannot read directory '${t}${p.slice(abs.length)}': Permission denied\n`)
            code = 1
          },
        )
      } catch (e) {
        code = fsErr(ctx, e, 'cannot access', t)
        continue
      }
      // Acumular de hojas a raíz.
      for (const e of [...order].reverse()) {
        if (e.abs === abs) continue
        const parent = e.abs.slice(0, e.abs.lastIndexOf('/')) || '/'
        sizes.set(parent, (sizes.get(parent) ?? 0) + (sizes.get(e.abs) ?? 0))
      }
      for (const e of order.reverse()) {
        if (e.depth > maxDepth) continue
        if (!e.dir && !a.flags.has('all') && e.abs !== abs) continue
        const shown = t.replace(/\/$/, '') + e.abs.slice(abs.length)
        ctx.out(`${fmt(sizes.get(e.abs) ?? 0)}\t${shown}\n`)
      }
      grand += sizes.get(abs) ?? 0
    }
    if (a.flags.has('total')) ctx.out(`${fmt(grand)}\ttotal\n`)
    return code
  },
})

register('tree', {
  usage: 'tree [-a] [-L level] [directory]',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { all: ['a'], dirs: ['d'] }, values: { level: ['L'] } })
    const root = a.rest[0] ?? '.'
    const max = a.values.has('level') ? Number(a.values.get('level')) : Infinity
    let dirs = 0
    let files = 0
    const walk = (abs: string, prefix: string, depth: number) => {
      if (depth >= max) return
      let names: string[]
      try {
        names = ctx.sys.vfs.readdir(abs, ctx.sh.cred).filter((n) => a.flags.has('all') || !n.startsWith('.'))
      } catch {
        return
      }
      names.forEach((n, i) => {
        const p = abs === '/' ? `/${n}` : `${abs}/${n}`
        const node = ctx.sys.vfs.stat(p, ctx.sh.cred, false)
        if (a.flags.has('dirs') && node.type !== 'dir') return
        const last = i === names.length - 1
        ctx.out(`${prefix}${last ? '└── ' : '├── '}${colorName(n, node, ctx.isTTY)}${node.type === 'symlink' ? ` -> ${node.data}` : ''}\n`)
        if (node.type === 'dir') {
          dirs++
          walk(p, prefix + (last ? '    ' : '│   '), depth + 1)
        } else files++
      })
    }
    ctx.out(`${root}\n`)
    walk(ctx.sh.resolve(root), '', 0)
    ctx.out(`\n${dirs} director${dirs === 1 ? 'y' : 'ies'}${a.flags.has('dirs') ? '' : `, ${files} file${files === 1 ? '' : 's'}`}\n`)
    return 0
  },
})

register('chmod', {
  usage: 'chmod [OPTION]... MODE[,MODE]... FILE...',
  summary: '  -R, --recursive  -v, --verbose  -c, --changes',
  run(ctx) {
    const a = parseArgs(
      ctx.args.map((x) => (/^-[rwxXst]+$/.test(x) ? `\u0000${x}` : x)),
      { flags: { recursive: ['R', 'recursive'], verbose: ['v', 'verbose'], changes: ['c', 'changes'] } },
    )
    // eslint-disable-next-line no-control-regex
    const rest = a.rest.map((x) => x.replace(/^\u0000/, ''))
    if (rest.length < 2) {
      ctx.err(rest.length ? `chmod: missing operand after '${rest[0]}'\n` : 'chmod: missing operand\n')
      return 1
    }
    const [spec, ...files] = rest
    let code = 0
    const vfs = ctx.sys.vfs
    const apply = (abs: string, shown: string) => {
      const node = vfs.stat(abs, ctx.sh.cred)
      const mode = applyChmod(spec, node.mode, node.type === 'dir', ctx.sh.umask)
      if (mode === null) {
        ctx.err(`chmod: invalid mode: '${spec}'\n`)
        code = 1
        return false
      }
      const before = node.mode & 0o7777
      vfs.chmod(abs, mode, ctx.sh.cred)
      if (a.flags.has('verbose') || (a.flags.has('changes') && before !== mode)) {
        ctx.out(`mode of '${shown}' changed from ${octal(before)} (${modeString({ type: 'file', mode: before }).slice(1)}) to ${octal(mode)} (${modeString({ type: 'file', mode }).slice(1)})\n`)
      }
      return true
    }
    for (const f of files) {
      const abs = ctx.sh.resolve(f)
      try {
        if (!apply(abs, f)) return 1
        if (a.flags.has('recursive') && vfs.stat(abs, ctx.sh.cred).type === 'dir') {
          vfs.walk(abs, ctx.sh.cred, (p) => {
            if (p !== abs) apply(p, f + p.slice(abs.length))
          })
        }
      } catch (e) {
        if (e instanceof FsError && e.code === 'EPERM') {
          ctx.err(`chmod: changing permissions of '${f}': Operation not permitted\n`)
          code = 1
        } else code = fsErr(ctx, e, 'cannot access', f)
      }
    }
    return code
  },
})

function chownLike(ctx: CommandContext, groupOnly: boolean) {
  const a = parseArgs(ctx.args, { flags: { recursive: ['R', 'recursive'], verbose: ['v', 'verbose'], h: ['h'] } })
  if (a.rest.length < 2) {
    ctx.err(a.rest.length ? `${ctx.name}: missing operand after '${a.rest[0]}'\n` : `${ctx.name}: missing operand\n`)
    return 1
  }
  const [spec, ...files] = a.rest
  let uid: number | undefined
  let gid: number | undefined
  if (groupOnly) {
    const g = ctx.sys.groups.get(spec)
    if (!g) {
      ctx.err(`chgrp: invalid group: '${spec}'\n`)
      return 1
    }
    gid = g.gid
  } else {
    const [u, g] = spec.split(/[:.]/)
    if (u) {
      const user = ctx.sys.users.get(u)
      if (!user) {
        ctx.err(`chown: invalid user: '${spec}'\n`)
        return 1
      }
      uid = user.uid
    }
    if (g !== undefined) {
      if (g === '') gid = uid !== undefined ? ctx.sys.userByUid(uid)!.gid : undefined
      else {
        const group = ctx.sys.groups.get(g)
        if (!group) {
          ctx.err(`chown: invalid group: '${spec}'\n`)
          return 1
        }
        gid = group.gid
      }
    }
  }
  let code = 0
  for (const f of files) {
    const abs = ctx.sh.resolve(f)
    try {
      ctx.sys.vfs.chown(abs, uid, gid, ctx.sh.cred)
      if (a.flags.has('recursive') && ctx.sys.vfs.stat(abs, ctx.sh.cred).type === 'dir') {
        ctx.sys.vfs.walk(abs, ctx.sh.cred, (p) => {
          if (p !== abs) ctx.sys.vfs.chown(p, uid, gid, ctx.sh.cred, false)
        })
      }
      if (a.flags.has('verbose')) ctx.out(`changed ownership of '${f}' to ${spec}\n`)
    } catch (e) {
      if (e instanceof FsError && e.code === 'EPERM') {
        ctx.err(`${ctx.name}: changing ${groupOnly || uid === undefined ? 'group' : 'ownership'} of '${f}': Operation not permitted\n`)
        code = 1
      } else code = fsErr(ctx, e, 'cannot access', f)
    }
  }
  return code
}

register('chown', { usage: 'chown [OPTION]... [OWNER][:[GROUP]] FILE...', run: (ctx) => chownLike(ctx, false) })
register('chgrp', { usage: 'chgrp [OPTION]... GROUP FILE...', run: (ctx) => chownLike(ctx, true) })

register(['basename'], {
  usage: 'basename NAME [SUFFIX]',
  run(ctx) {
    if (!ctx.args[0]) {
      ctx.err('basename: missing operand\n')
      return 1
    }
    let b = ctx.args[0].replace(/\/+$/, '')
    b = b.slice(b.lastIndexOf('/') + 1) || '/'
    if (ctx.args[1] && b.endsWith(ctx.args[1]) && b !== ctx.args[1]) b = b.slice(0, -ctx.args[1].length)
    ctx.out(b + '\n')
    return 0
  },
})

register('dirname', {
  usage: 'dirname NAME...',
  run(ctx) {
    for (const p of ctx.args) {
      const t = p.replace(/\/+$/, '')
      const i = t.lastIndexOf('/')
      ctx.out((i < 0 ? '.' : i === 0 ? '/' : t.slice(0, i)) + '\n')
    }
    return 0
  },
})

register(['realpath', 'readlink'], {
  usage: 'realpath FILE...',
  run(ctx) {
    let code = 0
    for (const p of ctx.args.filter((x) => !x.startsWith('-'))) {
      const abs = ctx.sh.resolve(p)
      try {
        if (ctx.name === 'readlink' && !ctx.args.includes('-f')) {
          const node = ctx.sys.vfs.stat(abs, ctx.sh.cred, false)
          if (node.type !== 'symlink') {
            code = 1
            continue
          }
          ctx.out(node.data + '\n')
          continue
        }
        // Seguir enlaces para obtener la ruta real.
        let current = abs
        for (let i = 0; i < 20; i++) {
          const node = ctx.sys.vfs.stat(current, ctx.sh.cred, false)
          if (node.type !== 'symlink') break
          current = normalizePath(node.data, current.slice(0, current.lastIndexOf('/')) || '/')
        }
        ctx.out(current + '\n')
      } catch (e) {
        code = fsErr(ctx, e, '', p)
      }
    }
    return code
  },
})

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

register('sha256sum', {
  usage: 'sha256sum [FILE]...',
  async run(ctx) {
    const check = ctx.args.includes('-c') || ctx.args.includes('--check')
    const inputs = readInputs(ctx, ctx.args.filter((a) => !a.startsWith('-')))
    if (typeof inputs === 'number') return inputs
    if (check) {
      let failed = 0
      for (const inp of inputs) {
        for (const line of lines(inp.data)) {
          const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line)
          if (!m) continue
          try {
            const data = ctx.sys.vfs.readFile(ctx.sh.resolve(m[2]), ctx.sh.cred)
            const ok = (await sha256(data)) === m[1]
            if (!ok) failed++
            ctx.out(`${m[2]}: ${ok ? 'OK' : 'FAILED'}\n`)
          } catch {
            ctx.out(`${m[2]}: FAILED open or read\n`)
            failed++
          }
        }
      }
      if (failed) ctx.err(`sha256sum: WARNING: ${failed} computed checksum${failed > 1 ? 's' : ''} did NOT match\n`)
      return failed ? 1 : 0
    }
    for (const inp of inputs) ctx.out(`${await sha256(inp.data)}  ${inp.name}\n`)
    return 0
  },
})

register(['nano', 'vim', 'vi'], {
  usage: 'nano [FILE]',
  run(ctx) {
    const file = ctx.args.find((a) => !a.startsWith('-') && !a.startsWith('+'))
    if (!file) {
      ctx.err(`[simulador] Indicar el archivo a editar, por ejemplo: ${ctx.name} notas.txt\n`)
      return 1
    }
    const abs = ctx.sh.resolve(file)
    const vfs = ctx.sys.vfs
    let content = ''
    let error: string | undefined
    try {
      if (vfs.exists(abs, ctx.sh.cred)) content = vfs.readFile(abs, ctx.sh.cred)
    } catch (e) {
      if (e instanceof FsError) error = e.code === 'EISDIR' ? `"${file}" is a directory` : `Error reading ${file}: ${e.message}`
      else throw e
    }
    ctx.sh.pendingEditor = { path: abs, content, error, editor: ctx.name }
    return 0
  },
})

register('tee', {
  usage: 'tee [OPTION]... [FILE]...',
  run(ctx) {
    const append = ctx.args.includes('-a') || ctx.args.includes('--append')
    const data = ctx.stdin.readAll()
    let code = 0
    for (const f of ctx.args.filter((x) => !x.startsWith('-'))) {
      try {
        ctx.sys.vfs.writeFile(ctx.sh.resolve(f), data, ctx.sh.cred, { append, mode: 0o666 & ~ctx.sh.umask })
      } catch (e) {
        code = fsErr(ctx, e, '', f)
      }
    }
    ctx.out(data)
    return code
  },
})
