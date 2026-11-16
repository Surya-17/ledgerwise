import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ChevronDown, Download, FileText, Search, Tag, Undo2 } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EntryIcon } from '../components/EntryIcon'
import {
  Badge,
  Button,
  Card,
  EmptyState,
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
import { api, newIdempotencyKey } from '../lib/api'
import { describeEntry } from '../lib/entries'
import { isBalanceAccount, useAccounts, useDebounced } from '../lib/hooks'
import { formatDate, formatMoney } from '../lib/money'
import type { Account, Entry } from '../lib/types'

const PAGE = 50

export default function Transactions() {
  const { accounts, byId } = useAccounts()
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState(params.get('q') ?? '')
  const accountId = params.get('account') ?? ''
  const query = useDebounced(q.trim())
  const [open, setOpen] = useState<string | null>(null)
  const [reversing, setReversing] = useState<Entry | null>(null)
  const [recat, setRecat] = useState<Entry | null>(null)

  const list = useInfiniteQuery({
    queryKey: ['entries', 'list', query, accountId],
    queryFn: ({ pageParam }) => api.entries({ q: query, account_id: accountId, limit: PAGE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (last.length === PAGE ? all.length * PAGE : undefined),
  })
  const entries = useMemo(() => list.data?.pages.flat() ?? [], [list.data])
  const toast = useToast()
  const exportCsv = useMutation({
    mutationFn: () => api.exportEntries({ q: query, account_id: accountId }),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `ledgerwise-journal-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
    onError: (e) => toast((e as Error).message, 'critical'),
  })

  const groups = useMemo(() => {
    const out: { date: string; items: Entry[] }[] = []
    for (const e of entries) {
      const last = out.at(-1)
      if (last?.date === e.occurred_on) last.items.push(e)
      else out.push({ date: e.occurred_on, items: [e] })
    }
    return out
  }, [entries])

  const filterAccounts = accounts.filter((a) => a.type !== 'equity')

  return (
    <div className="animate-in">
      <PageHeader
        title="Transactions"
        description="Every entry in your ledger. History is append-only; corrections post reversing entries."
        actions={
          <Button variant="secondary" icon={<Download className="size-4" />} onClick={() => exportCsv.mutate()} loading={exportCsv.isPending}>
            Export CSV
          </Button>
        }
      />
      <Card>
        <div className="flex flex-col gap-2 border-b border-line p-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
            <Input
              placeholder="Search descriptions"
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
              }}
              className="pl-9"
              aria-label="Search transactions"
            />
          </div>
          <Select
            value={accountId}
            onChange={(e) => {
              const next = new URLSearchParams(params)
              if (e.target.value) next.set('account', e.target.value)
              else next.delete('account')
              setParams(next, { replace: true })
            }}
            className="sm:w-56"
            aria-label="Filter by account"
          >
            <option value="">All accounts & categories</option>
            {(['asset', 'liability', 'expense', 'income'] as const).map((t) => (
              <optgroup key={t} label={{ asset: 'Accounts', liability: 'Credit & loans', expense: 'Spending categories', income: 'Income categories' }[t]}>
                {filterAccounts
                  .filter((a) => a.type === t)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </Select>
        </div>

        {list.isPending ? (
          <div className="space-y-3 p-5">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : list.error ? (
          <div className="p-5">
            <ErrorNote error={list.error} />
          </div>
        ) : entries.length === 0 ? (
          <EmptyState icon={<FileText className="size-5" />} title="No transactions found">
            {query || accountId ? 'Try a different search or filter.' : 'Post a transaction or import a statement to get started.'}
          </EmptyState>
        ) : (
          <div>
            {groups.map((g) => (
              <Fragment key={g.date}>
                <div className="sticky top-14 z-10 border-b border-line bg-surface-2/90 px-5 py-1.5 text-xs font-medium text-ink-3 backdrop-blur lg:top-0">
                  {formatDate(g.date)}
                </div>
                <ul className="divide-y divide-line">
                  {g.items.map((e) => (
                    <EntryRow
                      key={e.id}
                      entry={e}
                      byId={byId}
                      expanded={open === e.id}
                      onToggle={() => setOpen(open === e.id ? null : e.id)}
                      onReverse={() => setReversing(e)}
                      onRecategorize={() => setRecat(e)}
                    />
                  ))}
                </ul>
              </Fragment>
            ))}
            {list.hasNextPage && (
              <div className="border-t border-line p-3 text-center">
                <Button variant="ghost" onClick={() => list.fetchNextPage()} loading={list.isFetchingNextPage}>
                  Load more
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>

      <ReverseModal entry={reversing} onClose={() => setReversing(null)} />
      <RecategorizeModal entry={recat} byId={byId} accounts={accounts} onClose={() => setRecat(null)} />
    </div>
  )
}

function EntryRow({
  entry,
  byId,
  expanded,
  onToggle,
  onReverse,
  onRecategorize,
}: {
  entry: Entry
  byId: Map<string, Account>
  expanded: boolean
  onToggle: () => void
  onReverse: () => void
  onRecategorize: () => void
}) {
  const v = describeEntry(entry, byId)
  const canChange = !entry.is_reversed && entry.source !== 'reversal'
  return (
    <li>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-5 py-3 text-left transition hover:bg-surface-hover"
        aria-expanded={expanded}
      >
        <EntryIcon entry={entry} view={v} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={clsx('truncate text-sm font-medium', entry.is_reversed && 'text-ink-3 line-through')}>
              {entry.description}
            </span>
            {entry.source === 'import' && <Badge>Imported</Badge>}
            {entry.source === 'reversal' && <Badge tone="brand">Reversal</Badge>}
            {entry.is_reversed && <Badge tone="critical">Reversed</Badge>}
          </div>
          <div className="mt-0.5 truncate text-xs text-ink-3">
            {v.categories.length ? v.categories.map((c) => c.name).join(', ') : 'Transfer'}
            {' · '}
            {v.moneyAccounts.map((a) => a.name).join(' → ')}
          </div>
        </div>
        <Money
          minor={v.kind === 'transfer' ? v.gross : v.amount}
          currency={v.currency}
          signed={v.kind !== 'transfer'}
          tone={v.kind !== 'transfer'}
          className={clsx('text-sm font-medium', entry.is_reversed && 'text-ink-3 line-through')}
        />
        <ChevronDown className={clsx('size-4 shrink-0 text-ink-3 transition', expanded && 'rotate-180')} />
      </button>

      {expanded && (
        <div className="animate-in border-t border-line bg-surface-2/50 px-5 py-4 sm:pl-[68px]">
          <table className="w-full max-w-lg text-[13px]">
            <thead className="text-ink-3">
              <tr>
                <th className="pb-1.5 text-left font-normal">Account</th>
                <th className="pb-1.5 text-right font-normal">Debit</th>
                <th className="pb-1.5 text-right font-normal">Credit</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {entry.lines.map((l) => (
                <tr key={l.id} className="border-t border-line">
                  <td className="py-1.5">
                    {byId.get(l.account_id)?.name ?? '—'}
                    {l.memo && <span className="ml-2 text-ink-3">{l.memo}</span>}
                  </td>
                  <td className="py-1.5 text-right">{l.amount_minor > 0 ? formatMoney(l.amount_minor, l.currency) : ''}</td>
                  <td className="py-1.5 text-right">{l.amount_minor < 0 ? formatMoney(-l.amount_minor, l.currency) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-3">
            <span>
              Entry <code className="font-mono">{entry.id.slice(0, 8)}</code>
            </span>
            <span>Posted {new Date(entry.created_at).toLocaleString()}</span>
            {entry.reverses_id && (
              <span>
                Reverses <code className="font-mono">{entry.reverses_id.slice(0, 8)}</code>
              </span>
            )}
          </div>
          {canChange && (
            <div className="mt-4 flex flex-wrap gap-2">
              {v.categoryLine && (
                <Button size="sm" variant="secondary" icon={<Tag className="size-3.5" />} onClick={onRecategorize}>
                  Change category
                </Button>
              )}
              <Button size="sm" variant="secondary" icon={<Undo2 className="size-3.5" />} onClick={onReverse}>
                Reverse
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

function ReverseModal({ entry, onClose }: { entry: Entry | null; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [key] = useState(newIdempotencyKey)
  const m = useMutation({
    mutationFn: () => api.reverseEntry(entry!.id, reason.trim() || undefined, `${key}:${entry!.id}`),
    onSuccess: () => {
      qc.invalidateQueries()
      toast('Entry reversed')
      setReason('')
      onClose()
    },
  })
  return (
    <Modal
      open={!!entry}
      onClose={() => {
        m.reset()
        onClose()
      }}
      title="Reverse this entry?"
      description="A new entry with every line negated is posted on the original date. The original stays in history, so every balance is exactly as if it never happened."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          m.mutate()
        }}
        className="space-y-4"
      >
        <div className="rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-sm">
          <span className="font-medium">{entry?.description}</span>
          <span className="text-ink-3"> · {entry && formatDate(entry.occurred_on)}</span>
        </div>
        <Field label="Reason (optional)" hint="Recorded in the audit log.">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Duplicate charge" />
        </Field>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={m.isPending}>
            Reverse entry
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function RecategorizeModal({
  entry,
  byId,
  accounts,
  onClose,
}: {
  entry: Entry | null
  byId: Map<string, Account>
  accounts: Account[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const toast = useToast()
  const [key] = useState(newIdempotencyKey)
  const view = entry ? describeEntry(entry, byId) : null
  const from = view?.categoryLine ? byId.get(view.categoryLine.account_id) : undefined
  const options = accounts.filter(
    (a) => from && a.type === from.type && a.currency === from.currency && a.id !== from.id && !a.is_archived && !isBalanceAccount(a),
  )
  const [to, setTo] = useState('')
  const target = options.some((o) => o.id === to) ? to : (options[0]?.id ?? '')

  const m = useMutation({
    mutationFn: () => api.recategorize(entry!.id, from!.id, target, `${key}:${entry!.id}:${target}`),
    onSuccess: () => {
      qc.invalidateQueries()
      toast(`Moved to ${byId.get(target)?.name}`)
      onClose()
    },
  })
  return (
    <Modal
      open={!!entry}
      onClose={() => {
        m.reset()
        onClose()
      }}
      title="Change category"
      description="Posted as a reversal plus a corrected copy, so reports for the original month update and the audit trail shows exactly what changed."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          m.mutate()
        }}
        className="space-y-4"
      >
        <div className="rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-sm">
          <span className="font-medium">{entry?.description}</span>
          <span className="text-ink-3"> · currently {from?.name}</span>
        </div>
        <Field label="New category">
          <Select value={target} onChange={(e) => setTo(e.target.value)}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={m.isPending} disabled={!target}>
            Recategorize
          </Button>
        </div>
      </form>
    </Modal>
  )
}
