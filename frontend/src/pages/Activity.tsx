import { useInfiniteQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  FilePlus2,
  FileUp,
  History,
  Lock,
  PiggyBank,
  Receipt,
  Tag,
  Undo2,
  UserPlus,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge, Button, Card, EmptyState, ErrorNote, PageHeader, Segmented, Skeleton } from '../components/ui'
import { api } from '../lib/api'
import { useAccounts } from '../lib/hooks'
import { formatMoney } from '../lib/money'
import type { Account, AuditEvent } from '../lib/types'

const PAGE = 100

const META: Record<string, { icon: LucideIcon; label: string }> = {
  'user.registered': { icon: UserPlus, label: 'Account registered' },
  'account.created': { icon: Wallet, label: 'Account created' },
  'account.updated': { icon: Wallet, label: 'Account updated' },
  'entry.manual': { icon: Receipt, label: 'Entry posted' },
  'entry.import': { icon: FilePlus2, label: 'Entry imported' },
  'entry.reversal': { icon: Undo2, label: 'Entry reversed' },
  'import.completed': { icon: FileUp, label: 'Statement imported' },
  'budget.set': { icon: PiggyBank, label: 'Budget set' },
  'budget.deleted': { icon: PiggyBank, label: 'Budget removed' },
  'rule.created': { icon: Tag, label: 'Rule created' },
  'rule.deleted': { icon: Tag, label: 'Rule deleted' },
}

function summary(e: AuditEvent, byId: Map<string, Account>): string | null {
  const d = e.details as Record<string, unknown>
  const name = (id: unknown) => (typeof id === 'string' ? byId.get(id)?.name : undefined)
  switch (e.action) {
    case 'account.created':
      return `${d.name} (${d.type}, ${d.currency})`
    case 'entry.manual':
    case 'entry.import':
    case 'entry.reversal':
      return typeof d.description === 'string' ? d.description : null
    case 'import.completed':
      return `${d.filename}: ${d.imported} new, ${d.duplicates ?? 0} duplicates`
    case 'budget.set':
      return `${name(d.account_id) ?? 'Category'}: ${formatMoney(Number(d.after_minor), 'USD')}${
        d.before_minor != null ? ` (was ${formatMoney(Number(d.before_minor), 'USD')})` : ''
      }`
    case 'rule.created':
      return `"${d.pattern}" → ${name(d.account_id) ?? 'category'}`
    case 'rule.deleted':
      return `"${d.pattern}"`
    case 'account.updated':
      return JSON.stringify(d.after)
    default:
      return null
  }
}

export default function Activity() {
  const { byId } = useAccounts()
  const [filter, setFilter] = useState<'all' | 'changes'>('changes')
  const [open, setOpen] = useState<string | null>(null)

  const q = useInfiniteQuery({
    queryKey: ['audit'],
    queryFn: ({ pageParam }) => api.audit(PAGE, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (last.length === PAGE ? all.length * PAGE : undefined),
  })
  const events = useMemo(() => {
    const all = q.data?.pages.flat() ?? []
    return filter === 'all' ? all : all.filter((e) => e.action !== 'entry.import')
  }, [q.data, filter])

  return (
    <div className="animate-in">
      <PageHeader
        title="Audit log"
        description={
          <span className="inline-flex items-center gap-1.5">
            <Lock className="size-3.5" /> Append-only. Each event is written in the same transaction as the change it records.
          </span>
        }
        actions={
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'changes', label: 'Key events' },
              { value: 'all', label: 'Everything' },
            ]}
          />
        }
      />
      <Card>
        {q.isPending ? (
          <div className="space-y-3 p-5">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : q.error ? (
          <div className="p-5">
            <ErrorNote error={q.error} />
          </div>
        ) : events.length === 0 ? (
          <EmptyState icon={<History className="size-5" />} title="No events yet" />
        ) : (
          <ol className="relative px-5 py-4">
            <div className="absolute top-6 bottom-6 left-[37px] w-px bg-line" aria-hidden />
            {events.map((e) => {
              const meta = META[e.action] ?? { icon: History, label: e.action }
              const Icon = meta.icon
              const text = summary(e, byId)
              return (
                <li key={e.id} className="relative flex gap-3 py-2">
                  <div className="relative z-10 grid size-9 shrink-0 place-items-center rounded-full border border-line bg-surface text-ink-2">
                    <Icon className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1 pt-1">
                    <button
                      onClick={() => setOpen(open === e.id ? null : e.id)}
                      className="flex w-full flex-wrap items-baseline gap-x-2 text-left"
                      aria-expanded={open === e.id}
                    >
                      <span className="text-sm font-medium">{meta.label}</span>
                      <Badge className="font-mono">{e.action}</Badge>
                      <span className="ml-auto text-xs text-ink-3">{new Date(e.created_at).toLocaleString()}</span>
                    </button>
                    {text && <div className="mt-0.5 truncate text-[13px] text-ink-2">{text}</div>}
                    {open === e.id && (
                      <pre
                        className={clsx(
                          'animate-in mt-2 overflow-x-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs text-ink-2',
                        )}
                      >
                        {JSON.stringify({ entity: `${e.entity_type}/${e.entity_id}`, ...e.details }, null, 2)}
                      </pre>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
        {q.hasNextPage && (
          <div className="border-t border-line p-3 text-center">
            <Button variant="ghost" onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>
              Load older events
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}
