import { verifyIos, type IosSession } from '@/engines/network'
import type { IosCheck } from '@/engines/network/schema'
import type { TermSession } from './sessions'

/** Adapta una sesión IOS existente (por ejemplo, la del armador de topologías) a la terminal. */
export function wrapIos(s: IosSession, consola = s.dev.id): TermSession {
  return {
    kind: 'ios',
    prompt: () => s.prompt(),
    continuation: '',
    run: (line) => s.run(line),
    history: () => s.history,
    takeClear: () => false,
    secret: () => s.secretInput,
    takeEditor: () => undefined,
    saveEditor: () => ({ ok: false }),
    verify: (check) => verifyIos(s, check as IosCheck, consola),
    complete(line) {
      const r = s.complete(line)
      return r ? { line: r } : undefined
    },
    devices: () => [...s.net.devices.values()].filter((d) => d.type === 'router' || d.type === 'switch' || d.type === 'switch_l3').map((d) => ({ id: d.id, name: d.hostname })),
    attach: (id) => s.attach(id),
    currentDevice: () => s.dev.id,
  }
}
