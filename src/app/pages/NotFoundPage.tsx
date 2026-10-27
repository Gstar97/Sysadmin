import { ButtonLink, EmptyState } from '@/ui'

export default function NotFoundPage({ message }: { message?: string }) {
  return (
    <div className="space-y-4">
      <EmptyState title="No se encontró esta página">{message ?? 'Puede que el enlace esté mal escrito o que el contenido se haya movido.'}</EmptyState>
      <div className="flex justify-center gap-2">
        <ButtonLink to="/">Ir al inicio</ButtonLink>
        <ButtonLink to="/mapa" variant="secondary">
          Ver el mapa
        </ButtonLink>
      </div>
    </div>
  )
}
