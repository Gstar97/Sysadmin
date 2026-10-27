import { useState } from 'react'
import { useParams } from 'react-router'
import { content, getLevel, levelHours } from '@/content'
import { formatDate, formatHours } from '@/lib/cn'
import { useProgress } from '@/progress/store'
import { Button, ButtonLink, Callout, Card, EmptyState, Icon } from '@/ui'
import { BadgeMedal } from './CertificatesPage'
import NotFoundPage from './NotFoundPage'

export default function CertificatePage() {
  const { levelId = '' } = useParams()
  const level = getLevel(levelId)
  const snap = useProgress((s) => s.snap)
  const updateProfile = useProgress((s) => s.updateProfile)
  const [name, setName] = useState(snap.profile.name)
  if (!level) return <NotFoundPage message="Ese nivel no existe." />
  const state = snap.levels[level.id]

  if (!state?.badgeEarnedAt) {
    return (
      <div className="space-y-4">
        <EmptyState title="Este certificado todavía no está disponible">
          Se obtiene al completar todos los módulos del nivel {level.numero} y entregar su proyecto integrador.
        </EmptyState>
        <div className="text-center">
          <ButtonLink to={`/nivel/${level.id}`}>Ver el nivel</ButtonLink>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="no-print space-y-3">
        {!snap.profile.name && (
          <Card>
            <form
              className="flex flex-col gap-2 sm:flex-row sm:items-end"
              onSubmit={(e) => {
                e.preventDefault()
                void updateProfile({ name: name.trim() })
              }}
            >
              <label className="flex-1">
                <span className="mb-1 block text-sm font-medium">Nombre para el certificado</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-lg border border-line bg-bg px-3 py-2 outline-none focus:border-accent"
                />
              </label>
              <Button type="submit" disabled={!name.trim()}>
                Guardar
              </Button>
            </form>
          </Card>
        )}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => window.print()}>
            <Icon name="print" className="h-4 w-4" /> Imprimir o guardar como PDF
          </Button>
          <ButtonLink to="/certificados" variant="secondary">
            Volver
          </ButtonLink>
        </div>
      </div>

      <article
        className="mx-auto aspect-[1.414/1] w-full max-w-4xl rounded-xl border-8 bg-white p-6 text-center text-slate-900 shadow-card print:shadow-none sm:p-12"
        style={{ borderColor: level.insignia.color }}
      >
        <div className="flex h-full flex-col items-center justify-between gap-4">
          <div>
            <div className="text-sm uppercase tracking-[0.3em] text-slate-500">{content.career.nombre}</div>
            <h1 className="mt-2 text-2xl font-extrabold sm:text-4xl">Certificado de nivel completado</h1>
          </div>
          <BadgeMedal color={level.insignia.color} earned number={level.numero} size={88} />
          <div>
            <p className="text-slate-600">Se certifica que</p>
            <p className="my-2 text-2xl font-bold sm:text-3xl">{snap.profile.name || '—'}</p>
            <p className="text-slate-600">
              completó el <strong>Nivel {level.numero}: {level.titulo}</strong>, con todos sus módulos aprobados y el proyecto integrador
              entregado ({formatHours(levelHours(level))} estimadas).
            </p>
          </div>
          <div className="w-full text-xs text-slate-500">
            <div className="flex flex-wrap justify-between gap-2">
              <span>Fecha: {formatDate(state.badgeEarnedAt)}</span>
              <span>Código: {state.certificateCode}</span>
            </div>
            <p className="mt-2">
              Certificado generado localmente por la plataforma a partir del progreso guardado en el navegador. No es verificable
              por terceros.
            </p>
          </div>
        </div>
      </article>

      <Callout tone="info" className="no-print">
        Para guardar el certificado como PDF, usar "Imprimir" y elegir "Guardar como PDF" como destino.
      </Callout>
    </div>
  )
}
