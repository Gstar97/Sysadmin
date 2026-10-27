import { useRef, useState } from 'react'
import { useTheme, type ThemePreference } from '@/lib/theme'
import { exportToSnapshot, snapshotToExport } from '@/progress/repository'
import { useProgress } from '@/progress/store'
import { Button, Callout, Card, Icon, PageHeader } from '@/ui'

export default function SettingsPage() {
  const snap = useProgress((s) => s.snap)
  const persistent = useProgress((s) => s.persistent)
  const { updateProfile, importSnapshot, resetAll, resetDiagnostic } = useProgress.getState()
  const { pref, setPref } = useTheme()
  const [name, setName] = useState(snap.profile.name)
  const [limit, setLimit] = useState(snap.profile.dailyCardLimit)
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const exportProgress = () => {
    const data = snapshotToExport(useProgress.getState().snap)
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `progreso-carrera-sysadmin-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    setMessage({ tone: 'ok', text: 'Progreso exportado. Guardar el archivo en un lugar seguro.' })
  }

  const importProgress = async (file: File) => {
    try {
      const snapshot = exportToSnapshot(JSON.parse(await file.text()))
      if (!confirm('Importar reemplaza todo el progreso actual de este navegador. ¿Continuar?')) return
      await importSnapshot(snapshot)
      setName(snapshot.profile.name)
      setLimit(snapshot.profile.dailyCardLimit)
      setMessage({ tone: 'ok', text: 'Progreso importado correctamente.' })
    } catch (e) {
      setMessage({ tone: 'bad', text: e instanceof SyntaxError ? 'El archivo no es un JSON válido.' : (e as Error).message })
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader eyebrow="Ajustes" title="Preferencias y progreso" />

      {message && (
        <Callout tone={message.tone} title={message.tone === 'ok' ? 'Listo' : 'No se pudo completar'}>
          {message.text}
        </Callout>
      )}

      <Card as="section">
        <h2 className="mb-3 font-semibold">Perfil</h2>
        <form
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault()
            void updateProfile({ name: name.trim(), dailyCardLimit: Math.max(5, Math.min(500, limit)) })
            setMessage({ tone: 'ok', text: 'Preferencias guardadas.' })
          }}
        >
          <label>
            <span className="mb-1 block text-sm font-medium">Nombre (aparece en los certificados)</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-line bg-bg px-3 py-2 outline-none focus:border-accent"
            />
          </label>
          <label>
            <span className="mb-1 block text-sm font-medium">Máximo de tarjetas por repaso</span>
            <input
              type="number"
              min={5}
              max={500}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="w-full rounded-lg border border-line bg-bg px-3 py-2 outline-none focus:border-accent"
            />
          </label>
          <div className="sm:col-span-2">
            <Button type="submit">Guardar</Button>
          </div>
        </form>
      </Card>

      <Card as="section">
        <h2 className="mb-3 font-semibold">Tema</h2>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Tema">
          {(['sistema', 'claro', 'oscuro'] as ThemePreference[]).map((t) => (
            <Button key={t} variant={pref === t ? 'primary' : 'secondary'} role="radio" aria-checked={pref === t} onClick={() => setPref(t)}>
              {t === 'sistema' ? 'Igual que el sistema' : t === 'claro' ? 'Claro' : 'Oscuro'}
            </Button>
          ))}
        </div>
      </Card>

      <Card as="section">
        <h2 className="mb-1 font-semibold">Copia de seguridad del progreso</h2>
        <p className="mb-3 text-sm text-muted">
          El progreso vive en este navegador. Exportarlo permite guardarlo, pasarlo a otro equipo o recuperarlo si se borran los datos
          del navegador.{' '}
          {persistent === true
            ? 'El navegador concedió almacenamiento persistente.'
            : persistent === false
              ? 'El navegador no concedió almacenamiento persistente: conviene exportar seguido.'
              : ''}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={exportProgress}>
            <Icon name="download" className="h-4 w-4" /> Exportar progreso
          </Button>
          <Button variant="secondary" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" className="h-4 w-4" /> Importar progreso
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importProgress(f)
            }}
            aria-label="Archivo de progreso"
          />
        </div>
      </Card>

      <Card as="section">
        <h2 className="mb-1 font-semibold">Reiniciar</h2>
        <p className="mb-3 text-sm text-muted">Estas acciones no se pueden deshacer (salvo que haya una exportación previa).</p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={!snap.diagnostic}
            onClick={() => {
              if (confirm('¿Borrar el resultado del diagnóstico para hacerlo de nuevo?')) {
                void resetDiagnostic()
                setMessage({ tone: 'ok', text: 'Diagnóstico reiniciado.' })
              }
            }}
          >
            <Icon name="refresh" className="h-4 w-4" /> Reiniciar diagnóstico
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (confirm('¿Borrar TODO el progreso, notas, tarjetas y certificados de este navegador?')) {
                void resetAll()
                setName('')
                setMessage({ tone: 'ok', text: 'Se borró todo el progreso.' })
              }
            }}
          >
            <Icon name="trash" className="h-4 w-4" /> Borrar todo el progreso
          </Button>
        </div>
      </Card>
    </div>
  )
}
