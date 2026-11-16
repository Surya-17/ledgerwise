import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { CalendarClock, CheckCircle2, CircleSlash, Repeat } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Badge, Card, CardHeader, EmptyState, ErrorNote, Money, PageHeader, Skeleton } from '../components/ui'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { formatDate, formatMoney, todayISO } from '../lib/money'
import type { RecurringSeries } from '../lib/types'

const CADENCE: Record<RecurringSeries['cadence'], string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  semimonthly: 'Twice a month',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
}

function daysUntil(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  const [ty, tm, td] = todayISO().split('-').map(Number)
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86_400_000)
}

function whenLabel(iso: string): string {
  const n = daysUntil(iso)
  if (n < 0) return `${-n}d overdue`
  if (n === 0) return 'Today'
  if (n === 1) return 'Tomorrow'
  return `in ${n} days`
}

export default function Recurring() {
  const { user } = useAuth()
  const currency = user?.base_currency ?? 'USD'
  const q = useQuery({ queryKey: ['recurring'], queryFn: api.recurring })
  const all = (q.data ?? []).filter((s) => s.currency === currency)
  const active = all.filter((s) => s.status === 'active')
  const lapsed = all.filter((s) => s.status === 'lapsed')
  const out = active.filter((s) => s.direction === 'out')
  const monthlyOut = out.reduce((t, s) => t + s.monthly_minor, 0)
  const monthlyIn = active.filter((s) => s.direction === 'in').reduce((t, s) => t + s.monthly_minor, 0)
  const upcoming = active
    .filter((s) => daysUntil(s.next_date) <= 30)
    .sort((a, b) => a.next_date.localeCompare(b.next_date))

  return (
    <div className="animate-in">
      <PageHeader
        title="Recurring"
        description="Bills, subscriptions and paychecks, detected automatically from the regularity of your ledger history."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <Tile label="Recurring spend / month" loading={q.isPending} value={formatMoney(monthlyOut, currency)} />
        <Tile label="Recurring income / month" loading={q.isPending} value={formatMoney(monthlyIn, currency)} />
        <Tile
          label="Left after recurring"
          loading={q.isPending}
          value={formatMoney(monthlyIn - monthlyOut, currency)}
          sub="Income minus recurring spend"
        />
        <Tile
          label="Lapsed"
          loading={q.isPending}
          value={String(lapsed.length)}
          sub={lapsed.length ? 'Stopped charging. Cancelled?' : 'Nothing has stopped'}
        />
      </div>

      {q.error && (
        <div className="mt-4">
          <ErrorNote error={q.error} />
        </div>
      )}

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <Card>
          <CardHeader title="Next 30 days" subtitle="Expected from each series’ cadence" />
          {q.isPending ? (
            <div className="space-y-3 px-5 pb-5">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : upcoming.length === 0 ? (
            <p className="px-5 pb-6 text-sm text-ink-3">Nothing expected in the next 30 days.</p>
          ) : (
            <ol className="px-5 pb-4">
              {upcoming.map((s) => (
                <li key={s.key + s.direction} className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0">
                  <div className="w-12 shrink-0 text-center">
                    <div className="text-[11px] font-medium text-ink-3 uppercase">
                      {new Date(`${s.next_date}T00:00`).toLocaleDateString('en-US', { month: 'short' })}
                    </div>
                    <div className="text-lg leading-tight font-semibold">{Number(s.next_date.slice(8))}</div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{s.name}</div>
                    <div className="text-xs text-ink-3">{whenLabel(s.next_date)}</div>
                  </div>
                  <Money
                    minor={s.direction === 'in' ? s.amount_minor : -s.amount_minor}
                    currency={s.currency}
                    signed
                    tone
                    className="text-sm font-medium"
                  />
                </li>
              ))}
            </ol>
          )}
        </Card>

        <Card>
          <CardHeader title="All recurring series" subtitle="Amount is the median charge; ≈ marks amounts that vary" />
          {q.isPending ? (
            <div className="space-y-3 px-5 pb-5">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : all.length === 0 ? (
            <EmptyState icon={<Repeat className="size-5" />} title="Nothing recurring yet">
              Series appear once a merchant shows up at least three times on a regular schedule. Import a few months of
              statements to get started.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {all.map((s) => (
                <SeriesRow key={s.key + s.direction} s={s} />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}

function SeriesRow({ s }: { s: RecurringSeries }) {
  const lapsed = s.status === 'lapsed'
  return (
    <li className={clsx('flex items-center gap-3 px-5 py-3', lapsed && 'opacity-70')}>
      <div
        className={clsx(
          'grid size-9 shrink-0 place-items-center rounded-full',
          s.direction === 'in' ? 'bg-good-soft text-good-ink' : 'bg-surface-2 text-ink-2',
        )}
      >
        {s.direction === 'in' ? <CalendarClock className="size-4" /> : <Repeat className="size-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <Link
            to={`/transactions?q=${encodeURIComponent(s.key.split(' ')[0])}`}
            className="truncate text-sm font-medium hover:underline"
          >
            {s.name}
          </Link>
          <Badge>{CADENCE[s.cadence]}</Badge>
          {lapsed ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-critical-ink">
              <CircleSlash className="size-3" /> Lapsed
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-good-ink">
              <CheckCircle2 className="size-3" /> Active
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-ink-3">
          {s.category_name} · {s.occurrences}× since {formatDate(s.first_date)} ·{' '}
          {lapsed ? `last seen ${formatDate(s.last_date)}` : `next ${formatDate(s.next_date)}`}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="tnum text-sm font-medium">
          {!s.fixed_amount && <span className="text-ink-3">≈</span>}
          {formatMoney(s.amount_minor, s.currency)}
        </div>
        <div className="tnum text-xs text-ink-3">{formatMoney(s.monthly_minor, s.currency)}/mo</div>
      </div>
    </li>
  )
}

function Tile({ label, value, sub, loading }: { label: string; value: string; sub?: string; loading?: boolean }) {
  return (
    <Card className="p-4 lg:p-5">
      <div className="text-[13px] text-ink-2">{label}</div>
      {loading ? (
        <Skeleton className="mt-2 h-8 w-3/4" />
      ) : (
        <div className="mt-1.5 truncate text-xl font-semibold tracking-tight sm:text-[26px]">{value}</div>
      )}
      {sub && <div className="mt-1 truncate text-xs text-ink-3">{sub}</div>}
    </Card>
  )
}
