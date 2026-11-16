import clsx from 'clsx'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'

export function BudgetBar({ pct, tall }: { pct: number; tall?: boolean }) {
  const over = pct > 1
  return (
    <div className={clsx('overflow-hidden rounded-full bg-surface-2', tall ? 'h-2.5' : 'h-1.5')}>
      <div
        className={clsx('h-full rounded-full transition-[width] duration-500', over ? 'bg-critical' : pct > 0.85 ? 'bg-warning' : 'bg-[var(--series-1)]')}
        style={{ width: `${Math.min(100, Math.max(pct * 100, 1.5))}%` }}
      />
    </div>
  )
}

export function BudgetStatus({ pct }: { pct: number }) {
  if (pct > 1)
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-critical-ink">
        <AlertTriangle className="size-3.5" /> Over budget
      </span>
    )
  if (pct > 0.85)
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-ink-2">
        <AlertTriangle className="size-3.5 text-warning" /> Close to limit
      </span>
    )
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-good-ink">
      <CheckCircle2 className="size-3.5" /> On track
    </span>
  )
}
