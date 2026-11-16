import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Copy, Pencil, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Button, Card, CardHeader, ErrorNote, Field, Input, Modal, PageHeader, Skeleton, useToast } from '../components/ui'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useAccounts } from '../lib/hooks'
import { currentMonth, exponent, formatMoney, monthLabel, parseMoney, shiftMonth } from '../lib/money'
import type { Account } from '../lib/types'
import { BudgetBar, BudgetStatus } from '../components/budget'

export default function Budgets() {
  const { user } = useAuth()
  const currency = user?.base_currency ?? 'USD'
  const qc = useQueryClient()
  const toast = useToast()
  const [month, setMonth] = useState(currentMonth())
  const [editing, setEditing] = useState<{ account: Account; current?: number } | null>(null)
  const { accounts } = useAccounts()

  const budgets = useQuery({ queryKey: ['budgets', month], queryFn: () => api.budgets(month) })
  const spending = useQuery({ queryKey: ['spending', month], queryFn: () => api.spending(month) })
  const prev = useQuery({ queryKey: ['budgets', shiftMonth(month, -1)], queryFn: () => api.budgets(shiftMonth(month, -1)) })

  const budgeted = new Set((budgets.data ?? []).map((b) => b.account_id))
  const spentBy = new Map((spending.data ?? []).map((s) => [s.account_id, s.spent_minor]))
  const unbudgeted = accounts
    .filter((a) => a.type === 'expense' && !a.is_archived && !budgeted.has(a.id))
    .sort((a, b) => (spentBy.get(b.id) ?? 0) - (spentBy.get(a.id) ?? 0))

  const totalBudget = (budgets.data ?? []).reduce((s, b) => s + b.budget_minor, 0)
  const totalSpent = (budgets.data ?? []).reduce((s, b) => s + b.spent_minor, 0)

  const copyPrev = useMutation({
    mutationFn: async () => {
      const toCopy = (prev.data ?? []).filter((b) => !budgeted.has(b.account_id))
      for (const b of toCopy) await api.setBudget(b.account_id, month, b.budget_minor)
      return toCopy.length
    },
    onSuccess: (n) => {
      qc.invalidateQueries({ queryKey: ['budgets'] })
      toast(n ? `Copied ${n} budget${n === 1 ? '' : 's'} from ${monthLabel(shiftMonth(month, -1), 'long')}` : 'Nothing new to copy')
    },
  })

  const remove = useMutation({
    mutationFn: api.deleteBudget,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['budgets'] }),
  })

  const isCurrent = month === currentMonth()

  return (
    <div className="animate-in">
      <PageHeader
        title="Budgets"
        description="Monthly limits per spending category, compared with what actually posted to the ledger."
        actions={
          <div className="flex items-center gap-1 rounded-lg border border-line bg-surface p-0.5 shadow-card">
            <button onClick={() => setMonth(shiftMonth(month, -1))} className="rounded-md p-1.5 text-ink-2 hover:bg-surface-hover" aria-label="Previous month">
              <ChevronLeft className="size-4" />
            </button>
            <span className="min-w-32 text-center text-sm font-medium">{monthLabel(month, 'long')}</span>
            <button
              onClick={() => setMonth(shiftMonth(month, 1))}
              className="rounded-md p-1.5 text-ink-2 hover:bg-surface-hover disabled:opacity-30"
              aria-label="Next month"
              disabled={month >= shiftMonth(currentMonth(), 1)}
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        }
      />

      <Card className="mb-4 p-5">
        {budgets.isPending ? (
          <Skeleton className="h-16" />
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="text-[13px] text-ink-2">{totalSpent > totalBudget ? 'Over by' : 'Left to spend'}</div>
                <div className="mt-1 text-3xl font-semibold tracking-tight">
                  {formatMoney(Math.abs(totalBudget - totalSpent), currency)}
                </div>
              </div>
              <div className="text-right text-sm text-ink-2">
                <span className="tnum font-medium text-ink">{formatMoney(totalSpent, currency)}</span> spent of{' '}
                <span className="tnum">{formatMoney(totalBudget, currency)}</span> budgeted
                {isCurrent && (
                  <div className="mt-0.5 text-xs text-ink-3">{daysLeft()} days left in the month</div>
                )}
              </div>
            </div>
            <div className="mt-4">
              <BudgetBar pct={totalBudget ? totalSpent / totalBudget : 0} tall />
            </div>
          </>
        )}
      </Card>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            title="Budgeted categories"
            action={
              (prev.data?.length ?? 0) > 0 &&
              (prev.data ?? []).some((b) => !budgeted.has(b.account_id)) && (
                <Button size="sm" variant="secondary" icon={<Copy className="size-3.5" />} onClick={() => copyPrev.mutate()} loading={copyPrev.isPending}>
                  Copy last month
                </Button>
              )
            }
          />
          {budgets.isPending ? (
            <div className="space-y-3 p-5">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : budgets.data?.length ? (
            <ul className="divide-y divide-line">
              {budgets.data.map((b) => {
                const pct = b.budget_minor ? b.spent_minor / b.budget_minor : 0
                const account = accounts.find((a) => a.id === b.account_id)
                return (
                  <li key={b.budget_id} className="group px-5 py-4">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{b.account_name}</div>
                        <BudgetStatus pct={pct} />
                      </div>
                      <div className="flex items-center gap-1">
                        <div className="mr-1 text-right text-sm">
                          <div className="tnum font-medium">{formatMoney(b.spent_minor, b.currency)}</div>
                          <div className="tnum text-xs text-ink-3">of {formatMoney(b.budget_minor, b.currency)}</div>
                        </div>
                        {account && (
                          <button
                            onClick={() => setEditing({ account, current: b.budget_minor })}
                            className="rounded-md p-1.5 text-ink-3 hover:bg-surface-hover hover:text-ink"
                            aria-label={`Edit ${b.account_name} budget`}
                          >
                            <Pencil className="size-4" />
                          </button>
                        )}
                        <button
                          onClick={() => remove.mutate(b.budget_id)}
                          className="rounded-md p-1.5 text-ink-3 hover:bg-surface-hover hover:text-critical-ink"
                          aria-label={`Remove ${b.account_name} budget`}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    </div>
                    <BudgetBar pct={pct} />
                    <div className="mt-1.5 text-xs text-ink-3">
                      {b.remaining_minor >= 0
                        ? `${formatMoney(b.remaining_minor, b.currency)} remaining`
                        : `${formatMoney(-b.remaining_minor, b.currency)} over`}
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="px-5 pb-8 pt-2 text-sm text-ink-3">No budgets for {monthLabel(month, 'long')} yet. Pick a category on the right.</p>
          )}
        </Card>

        <Card>
          <CardHeader title="Not budgeted" subtitle="Spending this month without a limit" />
          <ul className="px-2 pb-2">
            {unbudgeted.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 hover:bg-surface-hover">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{a.name}</div>
                  <div className="tnum text-xs text-ink-3">{formatMoney(spentBy.get(a.id) ?? 0, a.currency)} spent</div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setEditing({ account: a })}>
                  Set budget
                </Button>
              </li>
            ))}
            {unbudgeted.length === 0 && <li className="px-3 pb-4 text-sm text-ink-3">Every category has a budget.</li>}
          </ul>
        </Card>
      </div>

      <BudgetModal editing={editing} month={month} onClose={() => setEditing(null)} />
    </div>
  )
}

function daysLeft(): number {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate()
}

function BudgetModal({
  editing,
  month,
  onClose,
}: {
  editing: { account: Account; current?: number } | null
  month: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [amount, setAmount] = useState('')
  const [lastId, setLastId] = useState<string | null>(null)
  const currency = editing?.account.currency ?? 'USD'
  if (editing && editing.account.id !== lastId) {
    setLastId(editing.account.id)
    const exp = exponent(currency)
    setAmount(editing.current ? (editing.current / 10 ** exp).toFixed(exp) : '')
  }

  let minor: number | null = null
  let error: string | null = null
  if (amount.trim()) {
    try {
      minor = parseMoney(amount, currency)
      if (minor <= 0) error = 'Must be greater than zero'
    } catch (e) {
      error = (e as Error).message
    }
  }

  const m = useMutation({
    mutationFn: () => api.setBudget(editing!.account.id, month, minor!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['budgets'] })
      setLastId(null)
      onClose()
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (minor && !error) m.mutate()
  }

  return (
    <Modal
      open={!!editing}
      onClose={() => {
        m.reset()
        setLastId(null)
        onClose()
      }}
      title={`${editing?.account.name} budget`}
      description={monthLabel(month, 'long')}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Monthly limit" error={error}>
          <Input inputMode="decimal" className="tnum" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />
        </Field>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={m.isPending} disabled={!minor || !!error}>
            Save budget
          </Button>
        </div>
      </form>
    </Modal>
  )
}
