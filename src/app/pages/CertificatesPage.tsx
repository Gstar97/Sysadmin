import { Link } from 'react-router'
import { content } from '@/content'
import { formatDate, percent } from '@/lib/cn'
import { levelFraction } from '@/progress/rules'
import { useProgress } from '@/progress/store'
import { ButtonLink, Card, PageHeader, ProgressBar } from '@/ui'

export function BadgeMedal({ color, earned, number, size = 64 }: { color: string; earned: boolean; number: number; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={earned ? `Insignia del nivel ${number}` : `Insignia del nivel ${number} pendiente`}>
      <path d="M22 40 16 62l16-8 16 8-6-22" fill={earned ? color : 'var(--surface-2)'} opacity={earned ? 0.75 : 1} />
      <circle cx="32" cy="26" r="22" fill={earned ? color : 'var(--surface-2)'} stroke={earned ? 'white' : 'var(--line)'} strokeWidth="3" />
      <circle cx="32" cy="26" r="15" fill="none" stroke={earned ? 'white' : 'var(--line)'} strokeWidth="1.5" strokeDasharray="3 3" />
      <text x="32" y="27" textAnchor="middle" dominantBaseline="central" fontSize="18" fontWeight="800" fill={earned ? 'white' : 'var(--muted)'}>
        {number}
      </text>
    </svg>
  )
}

export default function CertificatesPage() {
  const snap = useProgress((s) => s.snap)
  return (
    <div>
      <PageHeader eyebrow="Logros" title="Insignias y certificados">
        Al completar todos los módulos de un nivel y entregar su proyecto integrador se obtiene la insignia y un certificado
        imprimible.
      </PageHeader>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {content.levels.map((level) => {
          const state = snap.levels[level.id]
          const earned = !!state?.badgeEarnedAt
          const f = levelFraction(level, snap)
          return (
            <Card key={level.id} className="flex flex-col items-center text-center">
              <BadgeMedal color={level.insignia.color} earned={earned} number={level.numero} />
              <Link to={`/nivel/${level.id}`} className="mt-2 font-semibold text-fg">
                Nivel {level.numero}: {level.titulo}
              </Link>
              {earned ? (
                <>
                  <p className="mt-1 text-sm text-muted">Obtenida el {formatDate(state.badgeEarnedAt!)}</p>
                  <ButtonLink to={`/certificado/${level.id}`} variant="secondary" className="mt-3">
                    Ver certificado
                  </ButtonLink>
                </>
              ) : (
                <div className="mt-3 w-full">
                  <ProgressBar value={f} label={`Avance del nivel ${level.titulo}`} />
                  <p className="mt-1 text-sm text-muted">{percent(f)} del nivel</p>
                </div>
              )}
            </Card>
          )
        })}
      </div>
    </div>
  )
}
