import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Archive, ArchiveRestore, CreditCard, Landmark, Plus, TrendingDown, TrendingUp } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  Button,
  Card,
  CardHeader,
  ErrorNote,
  Field,
  Input,
  Modal,
  Money,
  PageHeader,
  Select,
  Skeleton,
  useToast,
} from '../components/ui'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useAccounts } from '../lib/hooks'
import { formatMoney, parseMoney, todayISO } from '../lib/money'
import type { Account, AccountType } from '../lib/types'

const SECTIONS: { type: AccountType; title: string; subtitle: string; icon: typeof Landmark }[] = [
  { type: 'asset', title: 'Cash & investments', subtitle: 'What you own', icon: Landmark },
  { type: 'liability', title: 'Credit & loans', subtitle: 'What you owe', icon: CreditCard },
  { type: 'income', title: 'Income categories', subtitle: 'All-time totals', icon: TrendingUp },
  { type: 'expense', title: 'Spending categories', subtitle: 'All-time totals', icon: TrendingDown },
]

export default function Accounts() {
  const { user } = useAuth()
  const currency = user?.base_currency ?? 'USD'
  const { accounts, isPending } = useAccounts()
  const [creating, setCreating] = useState(false)
  const [showArchived, setShowArchived] = useState(false)

  const totals = useMemo(() => {
    let assets = 0
    let liabilities = 0
    for (const a of accounts) {
      if (a.currency !== currency) continue
      if (a.type === 'asset') assets += a.balance_minor
      if (a.type === 'liability') liabilities += a.balance_minor
    }
    return { assets, liabilities, net: assets - liabilities }
  }, [accounts, currency])

  const visible = accounts.filter((a) => showArchived || !a.is_archived)
  const archivedCount = accounts.filter((a) => a.is_archived).length

  return (
    <div className="animate-in">
      <PageHeader
        title="Accounts"
        description="Balances are computed from journal lines on every read, so there is no stored number to drift."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            Add account
          </Button>
        }
      />

      <Card className="mb-4 grid grid-cols-3 divide-x divide-line">
        {[
          ['Assets', totals.assets],
          ['Liabilities', totals.liabilities],
          ['Net worth', totals.net],
        ].map(([label, v]) => (
          <div key={label as string} className="p-4 lg:p-5">
            <div className="text-[13px] text-ink-2">{label}</div>
            {isPending ? (
              <Skeleton className="mt-2 h-7 w-2/3" />
            ) : (
              <div className="mt-1 truncate text-lg font-semibold tracking-tight sm:text-2xl">
                {formatMoney(v as number, currency)}
              </div>
            )}
          </div>
        ))}
      </Card>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
        {SECTIONS.map(({ type, title, subtitle, icon: Icon }) => {
          const rows = visible.filter((a) => a.type === type)
          return (
            <Card key={type}>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <Icon className="size-4 text-ink-3" /> {title}
                  </span>
                }
                subtitle={subtitle}
              />
              {isPending ? (
                <div className="space-y-2 px-5 pb-5">
                  <Skeleton className="h-10" />
                  <Skeleton className="h-10" />
                </div>
              ) : rows.length === 0 ? (
                <p className="px-5 pb-6 text-sm text-ink-3">None yet.</p>
              ) : (
                <ul className="px-2 pb-2">
                  {rows.map((a) => (
                    <AccountRow key={a.id} account={a} />
                  ))}
                </ul>
              )}
            </Card>
          )
        })}
      </div>

      {archivedCount > 0 && (
        <div className="mt-4 text-center">
          <Button variant="ghost" size="sm" onClick={() => setShowArchived((s) => !s)}>
            {showArchived ? 'Hide' : 'Show'} {archivedCount} archived
          </Button>
        </div>
      )}

      <CreateAccountModal open={creating} onClose={() => setCreating(false)} currency={currency} />
    </div>
  )
}

function AccountRow({ account: a }: { account: Account }) {
  const qc = useQueryClient()
  const toast = useToast()
  const archive = useMutation({
    mutationFn: () => api.updateAccount(a.id, { is_archived: !a.is_archived }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] })
      toast(a.is_archived ? `${a.name} restored` : `${a.name} archived`)
    },
    onError: (e) => toast((e as Error).message, 'critical'),
  })
  const builtIn = a.type === 'equity' || a.name.startsWith('Uncategorized')
  return (
    <li className={clsx('group flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-surface-hover', a.is_archived && 'opacity-60')}>
      <Link to={`/transactions?account=${a.id}`} className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{a.name}</div>
        <div className="text-xs text-ink-3">
          {a.currency}
          {a.is_archived && ' · archived'}
        </div>
      </Link>
      <Money minor={a.balance_minor} currency={a.currency} className="text-sm font-medium" />
      {!builtIn && (
        <button
          onClick={() => archive.mutate()}
          className="rounded-md p-1.5 text-ink-3 opacity-100 transition hover:bg-surface-2 hover:text-ink sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100"
          aria-label={a.is_archived ? `Restore ${a.name}` : `Archive ${a.name}`}
          title={a.is_archived ? 'Restore' : 'Archive'}
        >
          {a.is_archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
        </button>
      )}
    </li>
  )
}

function CreateAccountModal({ open, onClose, currency }: { open: boolean; onClose: () => void; currency: string }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [name, setName] = useState('')
  const [type, setType] = useState<AccountType>('asset')
  const [opening, setOpening] = useState('')
  const [date, setDate] = useState(todayISO())
  const hasBalance = type === 'asset' || type === 'liability'

  let openingMinor = 0
  let openingError: string | null = null
  if (hasBalance && opening.trim()) {
    try {
      openingMinor = parseMoney(opening, currency)
    } catch (e) {
      openingError = (e as Error).message
    }
  }

  const m = useMutation({
    mutationFn: () =>
      api.createAccount({
        name: name.trim(),
        type,
        ...(hasBalance && openingMinor ? { opening_balance_minor: openingMinor, opening_date: date } : {}),
      }),
    onSuccess: (a) => {
      qc.invalidateQueries()
      toast(`${a.name} created`)
      setName('')
      setOpening('')
      onClose()
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!openingError) m.mutate()
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        m.reset()
        onClose()
      }}
      title="Add account"
      description="Opening balances are posted as a real entry against Opening Balance Equity, so the books balance from day one."
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value as AccountType)}>
            <option value="asset">Bank or cash account</option>
            <option value="liability">Credit card or loan</option>
            <option value="expense">Spending category</option>
            <option value="income">Income category</option>
          </Select>
        </Field>
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={{ asset: 'Chase Checking', liability: 'Amex Gold', expense: 'Subscriptions', income: 'Freelance', equity: '' }[type]}
            maxLength={100}
            required
          />
        </Field>
        {hasBalance && (
          <div className="grid grid-cols-2 gap-3">
            <Field
              label={type === 'liability' ? 'Amount owed' : 'Current balance'}
              error={openingError}
              hint="Optional"
            >
              <Input inputMode="decimal" className="tnum" placeholder="0.00" value={opening} onChange={(e) => setOpening(e.target.value)} />
            </Field>
            <Field label="As of">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
        )}
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={m.isPending} disabled={!name.trim() || !!openingError}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  )
}
