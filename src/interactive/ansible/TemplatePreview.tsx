import { useMemo, useState } from 'react'
import { parse as parseYaml } from 'yaml'
import { render } from '@/engines/ansible/jinja'
import { cn } from '@/lib/cn'
import { Frame } from '../fundamentos/Frame'

interface Props {
  plantilla: string
  variables: string
  /** Si está, se compara el resultado con este texto (un desafío). */
  esperado?: string
  /** Nombre del archivo que genera la plantilla (solo para mostrar). */
  destino?: string
}

const area = 'min-h-[220px] w-full resize-y rounded-lg border border-line bg-surface p-2 font-mono text-xs leading-5 text-fg focus:outline-2 focus:outline-accent sm:text-[13px]'

/**
 * Vista previa de plantillas de Ansible: variables en YAML a la izquierda, la plantilla Jinja2 en el
 * medio y el archivo que queda a la derecha, en vivo, con los errores como los da Ansible.
 */
export function TemplatePreview({ plantilla, variables, esperado, destino = '/etc/app/app.conf' }: Props) {
  const [tpl, setTpl] = useState(plantilla)
  const [vars, setVars] = useState(variables)
  const result = useMemo(() => {
    let scope: Record<string, unknown>
    try {
      const v = parseYaml(vars, { version: '1.1' }) as unknown
      scope = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
    } catch (e) {
      return { error: `Las variables no son YAML válido: ${(e as Error).message.split('\n')[0]}` }
    }
    try {
      return { text: render(tpl, { ...scope, ansible_managed: 'Ansible managed', inventory_hostname: (scope.inventory_hostname as string) ?? 'web01' }) }
    } catch (e) {
      const m = (e as Error).message
      return { error: /is undefined/.test(m) ? `AnsibleUndefinedVariable: ${m.replace(/^line \d+: /, '')}` : `AnsibleError: template error while templating string: ${m}` }
    }
  }, [tpl, vars])
  const ok = esperado !== undefined && result.text !== undefined && result.text.trimEnd() === esperado.trimEnd()
  return (
    <Frame
      titulo="Vista previa de una plantilla"
      acciones={
        <button
          type="button"
          onClick={() => {
            setTpl(plantilla)
            setVars(variables)
          }}
          className="rounded-md border border-line px-2 py-1 text-xs"
        >
          Volver al original
        </button>
      }
    >
      <div className="grid gap-3 text-sm lg:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-muted">Variables (group_vars, host_vars, facts)</span>
          <textarea value={vars} onChange={(e) => setVars(e.target.value)} className={area} spellCheck={false} autoCapitalize="off" aria-label="Variables en YAML" />
        </label>
        <label className="block">
          <span className="mb-1 block text-muted">Plantilla (templates/*.j2)</span>
          <textarea value={tpl} onChange={(e) => setTpl(e.target.value)} className={area} spellCheck={false} autoCapitalize="off" aria-label="Plantilla Jinja2" />
        </label>
        <div>
          <span className="mb-1 block text-muted">Lo que queda en {destino}</span>
          <pre
            aria-live="polite"
            aria-label="Resultado de la plantilla"
            className={cn('min-h-[220px] overflow-auto whitespace-pre-wrap rounded-lg p-2 font-mono text-xs leading-5 [overflow-wrap:anywhere] sm:text-[13px]', result.error ? 'border border-bad bg-bad-soft text-bad' : 'border border-line')}
            style={result.error ? undefined : { background: 'var(--term-bg)', color: 'var(--term-fg)' }}
          >
            {result.error ?? result.text}
          </pre>
        </div>
      </div>
      {esperado !== undefined && (
        <p className={cn('mt-3 rounded-lg border p-2 text-sm', ok ? 'border-ok bg-ok-soft' : 'border-line bg-surface')}>
          {ok ? '¡El resultado coincide con el archivo pedido!' : 'Desafío: cambiá la plantilla (no las variables) hasta que el resultado sea igual al archivo pedido:'}
          {!ok && <pre className="mt-2 overflow-x-auto rounded-md bg-bg p-2 font-mono text-xs">{esperado}</pre>}
        </p>
      )}
    </Frame>
  )
}
