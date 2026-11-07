/** bash y sh como comandos: bash script.sh, bash -c '...', bash -n (revisar sintaxis), bash -x. */
import { register } from '../shell'

register(['bash', 'sh'], {
  usage: 'bash [-n] [-x] [-e] [-c COMANDO | SCRIPT] [ARGUMENTOS...]',
  path: '/usr/bin',
  async run(ctx) {
    const args = [...ctx.args]
    let syntaxOnly = false
    const options: { errexit?: boolean; xtrace?: boolean } = {}
    let command: string | undefined
    while (args.length && args[0].startsWith('-') && args[0] !== '-') {
      const o = args.shift()!
      if (o === '-c') {
        command = args.shift() ?? ''
        break
      }
      for (const ch of o.slice(1)) {
        if (ch === 'n') syntaxOnly = true
        else if (ch === 'e') options.errexit = true
        else if (ch === 'x') options.xtrace = true
        else if (ch === 'l' || ch === 'i') continue
        else {
          ctx.err(`${ctx.name}: -${ch}: invalid option\n`)
          return 2
        }
      }
    }
    const io = { stdin: ctx.stdin, out: ctx.out, err: ctx.err, isTTY: ctx.isTTY }
    if (command !== undefined) {
      const [name = ctx.name, ...rest] = args
      return ctx.sh.runSource(command, name, rest, io, { syntaxOnly, options })
    }
    const script = args.shift()
    if (!script) {
      ctx.err(`[simulador] Acá no se abre un shell dentro de otro: ejecutá los comandos directamente, o usá ${ctx.name} script.sh o ${ctx.name} -c 'comando'.\n`)
      return 0
    }
    if (syntaxOnly) {
      const path = ctx.sh.resolve(script)
      try {
        const text = ctx.sys.vfs.readFile(path, ctx.sh.cred)
        return ctx.sh.runSource(text, script, args, io, { syntaxOnly: true })
      } catch (e) {
        ctx.err(`${ctx.name}: ${script}: ${(e as Error).message}\n`)
        return 127
      }
    }
    return ctx.sh.runScriptWith(ctx.sh.resolve(script), script, args, io, options)
  },
})
