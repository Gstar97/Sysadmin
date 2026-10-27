import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface Props {
  /** Ids de los elementos en el orden actual. */
  order: number[]
  render: (id: number) => ReactNode
  onChange: (order: number[]) => void
  disabled?: boolean
  itemClassName?: (id: number, index: number) => string | undefined
}

/** Lista que se reordena arrastrando (mouse o toque) o con los botones subir/bajar (teclado). */
export function SortableList({ order, render, onChange, disabled, itemClassName }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    const from = order.indexOf(Number(e.active.id))
    const to = order.indexOf(Number(e.over.id))
    onChange(arrayMove(order, from, to))
  }

  const move = (index: number, delta: number) => {
    const to = index + delta
    if (to < 0 || to >= order.length) return
    onChange(arrayMove(order, index, to))
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={order.map(String)} strategy={verticalListSortingStrategy}>
        <ol className="space-y-2">
          {order.map((id, index) => (
            <SortableItem
              key={id}
              id={id}
              index={index}
              total={order.length}
              disabled={disabled}
              className={itemClassName?.(id, index)}
              onMove={(d) => move(index, d)}
            >
              {render(id)}
            </SortableItem>
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  )
}

function SortableItem({
  id,
  index,
  total,
  disabled,
  className,
  onMove,
  children,
}: {
  id: number
  index: number
  total: number
  disabled?: boolean
  className?: string
  onMove: (delta: number) => void
  children: ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: String(id), disabled })
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'flex items-center gap-2 rounded-lg border border-line bg-surface px-2 py-2 shadow-card',
        isDragging && 'z-10 ring-2 ring-accent',
        className,
      )}
    >
      <span
        {...attributes}
        {...listeners}
        aria-label={`Arrastrar elemento ${index + 1}`}
        className={cn(
          'flex h-9 w-7 shrink-0 touch-none select-none items-center justify-center rounded text-muted',
          disabled ? 'cursor-default' : 'cursor-grab hover:bg-surface-2',
        )}
      >
        ⋮⋮
      </span>
      <span className="w-6 shrink-0 text-center text-sm font-semibold text-muted">{index + 1}</span>
      <div className="min-w-0 flex-1">{children}</div>
      {!disabled && (
        <span className="flex shrink-0 flex-col">
          <button
            type="button"
            className="rounded px-2 text-muted hover:bg-surface-2 disabled:opacity-30"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            aria-label="Subir"
          >
            ▲
          </button>
          <button
            type="button"
            className="rounded px-2 text-muted hover:bg-surface-2 disabled:opacity-30"
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            aria-label="Bajar"
          >
            ▼
          </button>
        </span>
      )}
    </li>
  )
}
