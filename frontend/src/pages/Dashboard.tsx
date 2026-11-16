import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { AlertTriangle, ArrowDownRight, ArrowUpRight, ChevronRight, Plus } from 'lucide-react'
import { BudgetBar } from '../components/budget'
import { useState, type ReactNode } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { CashFlowChart, CategoryBars, NetWorthChart } from '../components/charts'
import { EntryIcon } from '../components/EntryIcon'
import { Button, Card, CardHeader, EmptyState, Money, PageHeader, Segmented, Skeleton } from '../components/ui'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { describeEntry } from '../lib/entries'
import { isBalanceAccount, useAccounts } from '../lib/hooks'
import { currentMonth, formatDate, formatMoney, monthLabel } from '../lib/money'

export default function Dashboard() {
  const { user } = useAuth()
  const currency = user?.base_currency ?? 'USD'
  const month = currentMonth()
  const [range, setRange] = useState<'6' | '12'>('6')
  const { openNewTransaction } = useOutletContext<{ openNewTransaction: () => void }>()

  const accounts = useAccounts()
  const netWorth = useQuery({ queryKey: ['net-worth', range], queryFn: () => api.netWorth(Number(range)) })
  const cashFlow = useQuery({ queryKey: ['cash-flow', 6], queryFn: () => api.cashFlow(6) })
  const spending = useQuery({ queryKey: ['spending', month], queryFn: () => api.spending(month) })
  const budgets = useQuery({ queryKey: ['budgets', month], queryFn: () => api.budgets(month) })
  const recent = useQuery({ queryKey: ['entries', 'recent'], queryFn: () => api.entries({ limit: 6 }) })

  const nw = netWorth.data ?? []
  const nwNow = nw.at(-1)?.net_worth_minor ?? 0
  const nwPrev = nw.at(-2)?.net_worth_minor ?? 0
  const cf = cashFlow.data ?? []
  const thisMonth = cf.at(-1)
  const lastMonth = cf.at(-2)
  const savingsRate =
    lastMonth && lastMonth.income_minor > 0 ? Math.round((lastMonth.net_minor / lastMonth.income_minor) * 100) : null

  const greeting = (() => {
    const h = new Date().getHours()
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  })()

  const hasData = (accounts.data ?? []).some(isBalanceAccount)

  if (accounts.isSuccess && !hasData) {
    return (
      <>
        <PageHeader title={greeting} />
        <Card>
          <EmptyState
            icon={<Plus className="size-5" />}
            title="Add your first account"
            action={
              <Link to="/accounts">
                <Button>Add an account</Button>
              </Link>
            }
          >
            Create a checking account, savings or credit card with its opening balance, then import a statement or
            post transactions.
          </EmptyState>
        </Card>
      </>
    )
  }

  return (
    <div className="animate-in">
      <PageHeader
        title={greeting}
        description={`Here's where your money stands in ${monthLabel(month, 'long')}.`}
        actions={
          <div className="hidden lg:block">
            <Button icon={<Plus className="size-4" />} onClick={openNewTransaction}>
              New transaction
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <Stat
          label="Net worth"
          loading={netWorth.isPending}
          value={formatMoney(nwNow, currency)}
          delta={nw.length > 1 ? nwNow - nwPrev : null}
          deltaLabel="vs last month"
          currency={currency}
        />
        <Stat label="Income this month" loading={cashFlow.isPending} value={formatMoney(thisMonth?.income_minor ?? 0, currency)} />
        <Stat
          label="Spending this month"
          loading={cashFlow.isPending}
          value={formatMoney(thisMonth?.expense_minor ?? 0, currency)}
          sub={lastMonth ? `${formatMoney(lastMonth.expense_minor, currency)} last month` : undefined}
        />
        <Stat
          label="Savings rate"
          loading={cashFlow.isPending}
          value={savingsRate === null ? '—' : `${savingsRate}%`}
          sub={lastMonth ? `${monthLabel(lastMonth.month, 'long')}, last full month` : undefined}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Net worth"
            subtitle="Assets minus liabilities at each month end"
            action={
              <Segmented
                value={range}
                onChange={setRange}
                options={[
                  { value: '6', label: '6M' },
                  { value: '12', label: '12M' },
                ]}
              />
            }
          />
          <div className="px-3 pb-4">
            {netWorth.isPending ? <Skeleton className="mx-2 h-[240px]" /> : <NetWorthChart data={nw} currency={currency} />}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Budgets"
            subtitle={monthLabel(month, 'long')}
            action={<SeeAll to="/budgets" />}
          />
          <div className="px-5 pb-5">
            {budgets.isPending ? (
              <div className="space-y-4 pt-2">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-9" />
                ))}
              </div>
            ) : budgets.data?.length ? (
              <ul className="space-y-4 pt-1">
                {budgets.data.slice(0, 5).map((b) => (
                  <BudgetRow key={b.budget_id} {...b} />
                ))}
              </ul>
            ) : (
              <p className="py-8 text-center text-sm text-ink-3">
                No budgets this month. <Link to="/budgets" className="text-brand hover:underline">Set one</Link>
              </p>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Cash flow" subtitle="Income and spending, last 6 months" />
          <div className="px-3 pb-4">
            {cashFlow.isPending ? <Skeleton className="mx-2 h-[250px]" /> : <CashFlowChart data={cf} currency={currency} />}
          </div>
        </Card>
        <Card>
          <CardHeader title="Where it went" subtitle={`Spending by category, ${monthLabel(month, 'long')}`} />
          <div className="px-5 pb-5">
            {spending.isPending ? (
              <Skeleton className="h-60" />
            ) : spending.data?.some((s) => s.spent_minor > 0) ? (
              <CategoryBars data={spending.data} currency={currency} />
            ) : (
              <p className="py-8 text-center text-sm text-ink-3">No spending yet this month.</p>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Recent transactions" action={<SeeAll to="/transactions" />} />
          <ul className="divide-y divide-line px-2 pb-2">
            {recent.isPending
              ? [0, 1, 2, 3].map((i) => (
                  <li key={i} className="px-3 py-3">
                    <Skeleton className="h-8" />
                  </li>
                ))
              : recent.data?.map((e) => {
                  const v = describeEntry(e, accounts.byId)
                  return (
                    <li key={e.id} className="flex items-center gap-3 rounded-lg px-3 py-2.5">
                      <EntryIcon entry={e} view={v} />
                      <div className="min-w-0 flex-1">
                        <div className={clsx('truncate text-sm font-medium', e.is_reversed && 'text-ink-3 line-through')}>
                          {e.description}
                        </div>
                        <div className="truncate text-xs text-ink-3">
                          {formatDate(e.occurred_on)} · {v.categories.map((c) => c.name).join(', ') || 'Transfer'}
                        </div>
                      </div>
                      <Money
                        minor={v.kind === 'transfer' ? v.gross : v.amount}
                        currency={v.currency}
                        signed={v.kind !== 'transfer'}
                        tone={v.kind !== 'transfer'}
                        className="text-sm font-medium"
                      />
                    </li>
                  )
                })}
          </ul>
        </Card>
        <Card>
          <CardHeader title="Accounts" action={<SeeAll to="/accounts" />} />
          <ul className="px-2 pb-3">
            {(accounts.data ?? [])
              .filter((a) => isBalanceAccount(a) && !a.is_archived)
              .map((a) => (
                <li key={a.id} className="flex items-center justify-between rounded-lg px-3 py-2.5">
                  <div>
                    <div className="text-sm font-medium">{a.name}</div>
                    <div className="text-xs text-ink-3 capitalize">{a.type === 'liability' ? 'Credit / loan' : 'Cash'}</div>
                  </div>
                  <Money
                    minor={a.type === 'liability' ? -a.balance_minor : a.balance_minor}
                    currency={a.currency}
                    className="text-sm font-medium"
                  />
                </li>
              ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}

function SeeAll({ to }: { to: string }) {
  return (
    <Link to={to} className="flex items-center gap-0.5 text-[13px] font-medium text-brand hover:underline">
      View all <ChevronRight className="size-3.5" />
    </Link>
  )
}

function Stat({
  label,
  value,
  sub,
  delta,
  deltaLabel,
  currency = 'USD',
  loading,
}: {
  label: string
  value: ReactNode
  sub?: string
  delta?: number | null
  deltaLabel?: string
  currency?: string
  loading?: boolean
}) {
  return (
    <Card className="p-4 lg:p-5">
      <div className="text-[13px] text-ink-2">{label}</div>
      {loading ? (
        <Skeleton className="mt-2 h-8 w-3/4" />
      ) : (
        <div className="mt-1.5 truncate text-xl font-semibold tracking-tight sm:text-[26px]">{value}</div>
      )}
      {delta != null && !loading ? (
        <div className={clsx('mt-1 flex items-center gap-1 text-xs', delta >= 0 ? 'text-good-ink' : 'text-critical-ink')}>
          {delta >= 0 ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
          <span className="tnum font-medium">{formatMoney(delta, currency, { signed: true })}</span>
          <span className="text-ink-3">{deltaLabel}</span>
        </div>
      ) : (
        sub && <div className="mt-1 truncate text-xs text-ink-3">{sub}</div>
      )}
    </Card>
  )
}

function BudgetRow({ account_name, budget_minor, spent_minor, currency }: {
  account_name: string
  budget_minor: number
  spent_minor: number
  currency: string
}) {
  const pct = budget_minor > 0 ? spent_minor / budget_minor : 0
  const over = spent_minor > budget_minor
  return (
    <li>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[13px]">
        <span className="flex items-center gap-1.5 font-medium">
          {account_name}
          {over && (
            <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-critical-ink">
              <AlertTriangle className="size-3" /> Over
            </span>
          )}
        </span>
        <span className="tnum text-ink-2">
          {formatMoney(spent_minor, currency)} <span className="text-ink-3">/ {formatMoney(budget_minor, currency)}</span>
        </span>
      </div>
      <BudgetBar pct={pct} />
    </li>
  )
}
