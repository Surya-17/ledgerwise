import clsx from 'clsx'
import {
  ArrowDownLeft,
  ArrowLeftRight,
  Bus,
  Coffee,
  Home,
  Landmark,
  Receipt,
  Repeat,
  ShoppingBag,
  ShoppingCart,
  Undo2,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import type { EntryView } from '../lib/entries'
import type { Entry } from '../lib/types'

const BY_CATEGORY: Record<string, LucideIcon> = {
  Groceries: ShoppingCart,
  Dining: Coffee,
  Rent: Home,
  Transport: Bus,
  Utilities: Zap,
  Shopping: ShoppingBag,
  Subscriptions: Repeat,
  'Opening Balance Equity': Landmark,
}

export function EntryIcon({ entry, view }: { entry: Entry; view: EntryView }) {
  let Icon: LucideIcon = Receipt
  if (entry.source === 'reversal') Icon = Undo2
  else if (view.kind === 'transfer') Icon = ArrowLeftRight
  else if (view.kind === 'in') Icon = view.categories[0]?.type === 'equity' ? Landmark : ArrowDownLeft
  else Icon = BY_CATEGORY[view.categories[0]?.name ?? ''] ?? Receipt
  return (
    <div
      className={clsx(
        'grid size-9 shrink-0 place-items-center rounded-full',
        view.kind === 'in' ? 'bg-good-soft text-good-ink' : 'bg-surface-2 text-ink-2',
      )}
    >
      <Icon className="size-4" strokeWidth={1.9} />
    </div>
  )
}
