import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Download, HandCoins, MessageSquareText, Pencil, Plus, Receipt, Repeat, StickyNote, Trash2, UserPlus, Users } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { AddFriendModal, Avatar, GroupModal, SettleUpModal, SplitBillModal } from '../components/sharing'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNote, PageHeader, Skeleton, useToast } from '../components/ui'
import { api, newIdempotencyKey } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useAccounts } from '../lib/hooks'
import { exponent, formatMoney, todayISO } from '../lib/money'
import { balanceLabel } from '../lib/split'
import { downloadText, reminderText, sharedCsv } from '../lib/sharedText'
import type { Account, FriendGroup, SharedBill } from '../lib/types'

type Filter = { kind: 'all' } | { kind: 'group'; id: string } | { kind: 'friend'; id: string }

const METHOD: Record<string, string> = {
  equal: 'split equally',
  exact: 'exact amounts',
  shares: 'split by shares',
  percent: 'split by percentage',
  adjust: 'split with adjustments',
  itemized: 'itemized',
}

export default function Shared() {
  const { user } = useAuth()
  const currency = user?.base_currency ?? 'USD'
  const friendsQ = useQuery({ queryKey: ['friends'], queryFn: api.friends })
  const groupsQ = useQuery({ queryKey: ['groups'], queryFn: api.groups })
  const [filter, setFilter] = useState<Filter>({ kind: 'all' })
  const billsQ = useQuery({
    queryKey: ['shared', filter],
    queryFn: () =>
      api.shared(filter.kind === 'group' ? { group_id: filter.id } : filter.kind === 'friend' ? { friend_id: filter.id } : {}),
  })

  const qc = useQueryClient()
  const toast = useToast()
  const { byId } = useAccounts()
  // Repeating bills post themselves when they come due; opening this page catches them up.
  const ranDue = useRef(false)
  useEffect(() => {
    if (ranDue.current) return
    ranDue.current = true
    api
      .runRecurringBills()
      .then((r) => {
        if (r.posted > 0) {
          qc.invalidateQueries()
          toast(`Posted ${r.posted} repeating bill${r.posted > 1 ? 's' : ''} that came due`)
        }
      })
      .catch(() => {})
  }, [qc, toast])

  const [splitting, setSplitting] = useState(false)
  const [editingBill, setEditingBill] = useState<SharedBill | null>(null)
  const [addingFriend, setAddingFriend] = useState(false)
  const [editingGroup, setEditingGroup] = useState<FriendGroup | null | undefined>(undefined)
  const [settling, setSettling] = useState<{ friend: Account; groupId?: string } | null>(null)

  const friends = (friendsQ.data ?? []).filter((f) => !f.is_archived || f.balance_minor !== 0)
  const groups = groupsQ.data ?? []
  const owed = friends.filter((f) => f.currency === currency && f.balance_minor > 0).reduce((s, f) => s + f.balance_minor, 0)
  const owe = friends.filter((f) => f.currency === currency && f.balance_minor < 0).reduce((s, f) => s - f.balance_minor, 0)
  const loading = friendsQ.isPending
  const filterGroup = filter.kind === 'group' ? groups.find((g) => g.id === filter.id) : undefined
  const filterFriend = filter.kind === 'friend' ? friends.find((f) => f.id === filter.id) : undefined

  const remind = async (f: Account) => {
    try {
      const text = reminderText(f.name, f.balance_minor, f.currency, await api.shared({ friend_id: f.id }), f.id)
      if (typeof navigator.share === 'function' && matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ text })
        return
      }
      await navigator.clipboard.writeText(text)
      toast(`Reminder for ${f.name} copied. Paste it into a message.`)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast('Couldn’t copy the reminder', 'critical')
    }
  }
  const exportCsv = () => {
    const label = filterGroup ? filterGroup.name : filterFriend ? filterFriend.name : 'all'
    const csv = sharedCsv(
      billsQ.data ?? [],
      (id) => (id ? (byId.get(id)?.name ?? 'Friend') : 'You'),
      (id) => groups.find((g) => g.id === id)?.name ?? '',
      exponent,
    )
    // The byte-order mark makes Excel read the file as UTF-8 (names, curly quotes).
    downloadText(`ledgerwise-shared-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${todayISO()}.csv`, '\ufeff' + csv)
  }

  return (
    <div className="animate-in">
      <PageHeader
        title="Shared"
        description="Split bills with friends and groups. Your share is booked as spending; the rest becomes money friends owe you, right in the ledger."
        actions={
          <>
            <Button variant="secondary" icon={<UserPlus className="size-4" />} onClick={() => setAddingFriend(true)}>
              Add friend
            </Button>
            <Button variant="secondary" icon={<Users className="size-4" />} onClick={() => setEditingGroup(null)}>
              New group
            </Button>
            <Button icon={<Plus className="size-4" />} onClick={() => setSplitting(true)}>
              Split a bill
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-3 gap-3 lg:gap-4">
        <Tile label="Owed to you" value={formatMoney(owed, currency)} tone="good" loading={loading} />
        <Tile label="You owe" value={formatMoney(owe, currency)} tone={owe ? 'critical' : undefined} loading={loading} />
        <Tile label="Net" value={formatMoney(owed - owe, currency, { signed: true })} loading={loading} />
      </div>

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Friends" subtitle="Running balance across all bills" />
            {loading ? (
              <div className="space-y-2 px-5 pb-5">
                <Skeleton className="h-11" />
                <Skeleton className="h-11" />
              </div>
            ) : friends.length === 0 ? (
              <EmptyState
                icon={<UserPlus className="size-5" />}
                title="No friends yet"
                action={
                  <Button size="sm" onClick={() => setAddingFriend(true)}>
                    Add a friend
                  </Button>
                }
              >
                Add the people you split bills with. They don’t need an account.
              </EmptyState>
            ) : (
              <ul className="px-2 pb-2">
                {friends.map((f) => {
                  const b = balanceLabel(f.balance_minor, f.currency)
                  const active = filter.kind === 'friend' && filter.id === f.id
                  return (
                    <li
                      key={f.id}
                      className={clsx('flex items-center gap-3 rounded-lg px-3 py-2', active ? 'bg-brand-soft' : 'hover:bg-surface-hover')}
                    >
                      <button
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        onClick={() => setFilter(active ? { kind: 'all' } : { kind: 'friend', id: f.id })}
                        aria-pressed={active}
                      >
                        <Avatar name={f.name} />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{f.name}</span>
                          <span
                            className={clsx(
                              'tnum block text-xs',
                              b.tone === 'good' && 'text-good-ink',
                              b.tone === 'critical' && 'text-critical-ink',
                              b.tone === 'muted' && 'text-ink-3',
                            )}
                          >
                            {b.text}
                          </span>
                        </span>
                      </button>
                      {f.balance_minor > 0 && (
                        <button
                          onClick={() => remind(f)}
                          className="rounded-md p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink"
                          aria-label={`Remind ${f.name}`}
                          title="Copy a reminder to send"
                        >
                          <MessageSquareText className="size-4" />
                        </button>
                      )}
                      {f.balance_minor !== 0 && (
                        <Button size="sm" variant="secondary" onClick={() => setSettling({ friend: f })}>
                          Settle up
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Groups" subtitle="Tabs for trips, homes and teams" />
            {groupsQ.isPending ? (
              <div className="px-5 pb-5">
                <Skeleton className="h-16" />
              </div>
            ) : groups.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-ink-3">
                No groups yet.{' '}
                <button className="font-medium text-brand hover:underline" onClick={() => setEditingGroup(null)}>
                  Create one
                </button>{' '}
                to preselect who’s in a bill.
              </p>
            ) : (
              <ul className="space-y-2 px-3 pb-3">
                {groups.map((g) => (
                  <GroupRow
                    key={g.id}
                    group={g}
                    friends={friendsQ.data ?? []}
                    currency={currency}
                    active={filter.kind === 'group' && filter.id === g.id}
                    onSelect={(on) => setFilter(on ? { kind: 'group', id: g.id } : { kind: 'all' })}
                    onEdit={() => setEditingGroup(g)}
                  />
                ))}
              </ul>
            )}
          </Card>

          <RepeatingBills currency={currency} />
        </div>

        <Card>
          <CardHeader
            title={filterGroup ? filterGroup.name : filterFriend ? `With ${filterFriend.name}` : 'All shared activity'}
            subtitle={filter.kind === 'all' ? 'Bills and payments, newest first' : undefined}
            action={
              <div className="flex items-center gap-1">
                {(billsQ.data ?? []).length > 0 && (
                  <Button size="sm" variant="ghost" icon={<Download className="size-4" />} onClick={exportCsv} title="Download as CSV">
                    <span className="hidden sm:inline">Export</span>
                  </Button>
                )}
                {filter.kind !== 'all' && (
                  <Button size="sm" variant="ghost" onClick={() => setFilter({ kind: 'all' })}>
                    Show all
                  </Button>
                )}
              </div>
            }
          />
          {filterGroup && (
            <GroupBalances
              group={filterGroup}
              friends={friendsQ.data ?? []}
              currency={currency}
              onSettle={(friend) => setSettling({ friend, groupId: filterGroup.id })}
            />
          )}
          {filterGroup && <GroupTotals group={filterGroup} currency={currency} />}
          {billsQ.error && (
            <div className="px-5 pb-4">
              <ErrorNote error={billsQ.error} />
            </div>
          )}
          {billsQ.isPending ? (
            <div className="space-y-3 px-5 pb-5">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : (billsQ.data ?? []).length === 0 ? (
            <EmptyState
              icon={<Receipt className="size-5" />}
              title="Nothing shared yet"
              action={
                friends.length > 0 && (
                  <Button size="sm" onClick={() => setSplitting(true)}>
                    Split a bill
                  </Button>
                )
              }
            >
              Split a dinner, a rent payment or a trip, and balances show up here.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {(billsQ.data ?? []).map((b) => (
                <BillRow key={b.id} bill={b} groups={groups} onEdit={() => setEditingBill(b)} />
              ))}
            </ul>
          )}
        </Card>
      </div>

      <SplitBillModal
        open={splitting || editingBill !== null}
        onClose={() => {
          setSplitting(false)
          setEditingBill(null)
        }}
        groups={groups}
        initialGroupId={filter.kind === 'group' ? filter.id : null}
        editing={editingBill}
      />
      <AddFriendModal open={addingFriend} onClose={() => setAddingFriend(false)} />
      <GroupModal open={editingGroup !== undefined} group={editingGroup ?? null} onClose={() => setEditingGroup(undefined)} />
      <SettleUpModal friend={settling?.friend ?? null} groupId={settling?.groupId} onClose={() => setSettling(null)} />
    </div>
  )
}

function Tile({
  label,
  value,
  tone,
  loading,
}: {
  label: string
  value: string
  tone?: 'good' | 'critical'
  loading?: boolean
}) {
  return (
    <Card className="p-3 sm:p-4 lg:p-5">
      <div className="truncate text-xs text-ink-2 sm:text-[13px]">{label}</div>
      {loading ? (
        <Skeleton className="mt-2 h-8 w-3/4" />
      ) : (
        <div
          className={clsx(
            'tnum mt-1.5 truncate text-base font-semibold tracking-tight sm:text-[26px]',
            tone === 'good' && 'text-good-ink',
            tone === 'critical' && 'text-critical-ink',
          )}
        >
          {value}
        </div>
      )}
    </Card>
  )
}

function GroupRow({
  group,
  friends,
  currency,
  active,
  onSelect,
  onEdit,
}: {
  group: FriendGroup
  friends: Account[]
  currency: string
  active: boolean
  onSelect: (on: boolean) => void
  onEdit: () => void
}) {
  const names = new Map(friends.map((f) => [f.id, f.name]))
  const net = Object.values(group.balances).reduce((s, v) => s + v, 0)
  const b = balanceLabel(net, currency)
  return (
    <li
      className={clsx(
        'group flex items-center gap-3 rounded-xl border p-3 transition',
        active ? 'border-brand bg-brand-soft/60' : 'border-line hover:bg-surface-hover',
      )}
    >
      <button className="min-w-0 flex-1 text-left" onClick={() => onSelect(!active)} aria-pressed={active}>
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold">{group.name}</span>
          <Badge>{formatMoney(group.total_spent_minor, currency)} spent</Badge>
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <div className="flex -space-x-1.5">
            {group.member_ids.slice(0, 5).map((id) => (
              <Avatar key={id} name={names.get(id) ?? '?'} className="size-6 text-[11px] ring-2 ring-surface" />
            ))}
          </div>
          <span
            className={clsx(
              'tnum truncate text-xs',
              b.tone === 'good' && 'text-good-ink',
              b.tone === 'critical' && 'text-critical-ink',
              b.tone === 'muted' && 'text-ink-3',
            )}
          >
            {net > 0
              ? `you’re owed ${formatMoney(net, currency)}`
              : net < 0
                ? `you owe ${formatMoney(-net, currency)}`
                : 'all settled'}
          </span>
        </div>
      </button>
      <button
        onClick={onEdit}
        className="rounded-md p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink"
        aria-label={`Edit ${group.name}`}
        title="Edit group"
      >
        <Pencil className="size-4" />
      </button>
    </li>
  )
}

function GroupBalances({
  group,
  friends,
  currency,
  onSettle,
}: {
  group: FriendGroup
  friends: Account[]
  currency: string
  onSettle: (friend: Account) => void
}) {
  const byId = new Map(friends.map((f) => [f.id, f]))
  return (
    <div className="mx-5 mb-4 grid grid-cols-[minmax(0,1fr)] gap-2 rounded-lg bg-surface-2/60 p-3 sm:grid-cols-2">
      {group.member_ids.map((id) => {
        const f = byId.get(id)
        if (!f) return null
        const bal = group.balances[id] ?? 0
        const b = balanceLabel(bal, currency)
        return (
          <div key={id} className="flex items-center gap-2">
            <Avatar name={f.name} className="size-7 text-xs" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{f.name}</div>
              <div
                className={clsx(
                  'tnum text-xs',
                  b.tone === 'good' && 'text-good-ink',
                  b.tone === 'critical' && 'text-critical-ink',
                  b.tone === 'muted' && 'text-ink-3',
                )}
              >
                {b.text} in this group
              </div>
            </div>
            {bal !== 0 && (
              <button
                className="text-xs font-medium text-brand hover:underline"
                onClick={() => onSettle({ ...f, balance_minor: bal })}
              >
                Settle
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

function BillRow({ bill, groups, onEdit }: { bill: SharedBill; groups: FriendGroup[]; onEdit: () => void }) {
  const { byId } = useAccounts()
  const qc = useQueryClient()
  const toast = useToast()
  const [confirming, setConfirming] = useState(false)
  const [open, setOpen] = useState(false)
  const undo = useMutation({
    mutationFn: () => api.reverseEntry(bill.entry_id, 'removed from Shared', newIdempotencyKey()),
    onSuccess: () => {
      qc.invalidateQueries()
      toast('Removed. A reversing entry keeps the history.')
    },
    onError: (e) => toast((e as Error).message, 'critical'),
  })
  const name = (id: string | null) => (id ? (byId.get(id)?.name ?? 'Friend') : 'You')
  const group = groups.find((g) => g.id === bill.group_id)
  const date = new Date(`${bill.occurred_on}T00:00`)
  const c = bill.currency

  let effect: { label: string; amount: number; tone: 'good' | 'critical' | 'muted' }
  let detail: string
  if (bill.kind === 'settlement') {
    const share = bill.shares[0]
    const theyPaid = share.amount_minor < 0
    effect = { label: theyPaid ? 'you received' : 'you paid', amount: bill.total_minor, tone: 'muted' }
    detail = `Payment${group ? ` · ${group.name}` : ''}`
  } else if (bill.payer_account_id === null) {
    const lent = bill.total_minor - bill.my_share_minor
    effect = { label: 'you lent', amount: lent, tone: 'good' }
    detail = `You paid ${formatMoney(bill.total_minor, c)}`
  } else {
    effect = { label: 'you borrowed', amount: bill.my_share_minor, tone: 'critical' }
    detail = `${name(bill.payer_account_id)} paid ${formatMoney(bill.total_minor, c)}`
  }
  if (bill.kind === 'expense') {
    const others = bill.shares.filter((s) => s.account_id !== null).map((s) => name(s.account_id))
    detail += ` · ${METHOD[bill.method ?? 'equal']} with ${others.length ? others.join(', ') : 'you'}`
    if (group) detail += ` · ${group.name}`
  }
  const items = bill.details?.items ?? []
  const extras = bill.details?.extras_minor ?? 0

  return (
    <li className="group">
      <div className="flex items-center gap-3 px-4 py-3 sm:px-5">
        <div className="w-10 shrink-0 text-center">
          <div className="text-[11px] font-medium text-ink-3 uppercase">{date.toLocaleDateString('en-US', { month: 'short' })}</div>
          <div className="text-lg leading-tight font-semibold">{date.getDate()}</div>
        </div>
        <div
          className={clsx(
            'hidden size-9 shrink-0 place-items-center rounded-full sm:grid',
            bill.kind === 'settlement' ? 'bg-good-soft text-good-ink' : 'bg-surface-2 text-ink-2',
          )}
        >
          {bill.kind === 'settlement' ? <HandCoins className="size-4" /> : <Receipt className="size-4" />}
        </div>
        <button
          className="min-w-0 flex-1 text-left"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`${bill.description}, details`}
        >
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <span className="truncate">{bill.description}</span>
            {bill.recurring_id && <Repeat className="size-3.5 shrink-0 text-ink-3" aria-label="Repeats" />}
            {bill.notes && <StickyNote className="size-3.5 shrink-0 text-ink-3" aria-label="Has notes" />}
            {bill.edited_from_id && <span className="shrink-0 text-[11px] font-normal text-ink-3">edited</span>}
          </div>
          <div className="truncate text-xs text-ink-3" title={detail}>
            {detail}
          </div>
        </button>
        <div className="shrink-0 text-right">
          <div className="text-[11px] text-ink-3">{effect.label}</div>
          <div
            className={clsx(
              'tnum text-sm font-semibold',
              effect.tone === 'good' && 'text-good-ink',
              effect.tone === 'critical' && 'text-critical-ink',
            )}
          >
            {formatMoney(effect.amount, c)}
          </div>
        </div>
        {confirming ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="danger" loading={undo.isPending} onClick={() => undo.mutate()}>
              Remove
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
            {bill.kind === 'expense' && (
              <button
                onClick={onEdit}
                className="hidden rounded-md p-1.5 text-ink-3 transition hover:bg-surface-2 hover:text-ink sm:block"
                aria-label={`Edit ${bill.description}`}
                title="Edit"
              >
                <Pencil className="size-4" />
              </button>
            )}
            <button
              onClick={() => setConfirming(true)}
              className="rounded-md p-1.5 text-ink-3 transition hover:bg-surface-2 hover:text-ink"
              aria-label={`Remove ${bill.description}`}
              title="Remove (posts a reversing entry)"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        )}
      </div>
      {open && (
        <div className="mx-4 mb-3 space-y-3 rounded-lg bg-surface-2/60 p-3 text-[13px] sm:mx-5 sm:ml-[4.75rem]">
          {bill.kind === 'expense' && (
            <ul className="space-y-1">
              {bill.shares.map((s) => (
                <li key={s.account_id ?? 'me'} className="flex items-center gap-2">
                  <Avatar name={name(s.account_id)} className="size-5 text-[10px]" />
                  <span className="flex-1">{name(s.account_id)}</span>
                  <span className="tnum font-medium">{formatMoney(s.amount_minor, c)}</span>
                </li>
              ))}
            </ul>
          )}
          {items.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-medium text-ink-2">Receipt</div>
              <ul className="space-y-0.5 text-ink-2">
                {items.map((it, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      {it.name} <span className="text-ink-3">· {it.account_ids.map(name).join(', ')}</span>
                    </span>
                    <span className="tnum">{formatMoney(it.amount_minor, c)}</span>
                  </li>
                ))}
                {extras !== 0 && (
                  <li className="flex gap-2">
                    <span className="flex-1">{extras > 0 ? 'Tax, tip & fees' : 'Discount'}</span>
                    <span className="tnum">{formatMoney(extras, c)}</span>
                  </li>
                )}
              </ul>
            </div>
          )}
          {bill.notes && <p className="whitespace-pre-wrap text-ink-2">{bill.notes}</p>}
          {bill.kind === 'expense' && (
            <Button size="sm" variant="secondary" icon={<Pencil className="size-3.5" />} onClick={onEdit}>
              Edit bill
            </Button>
          )}
        </div>
      )}
    </li>
  )
}

function RepeatingBills({ currency }: { currency: string }) {
  const qc = useQueryClient()
  const toast = useToast()
  const { byId } = useAccounts()
  const q = useQuery({ queryKey: ['recurring-bills'], queryFn: api.recurringBills })
  const [confirming, setConfirming] = useState<string | null>(null)
  const stop = useMutation({
    mutationFn: (id: string) => api.stopRecurringBill(id),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['recurring-bills'] })
      toast(`${r.description} won’t repeat. Bills already posted stay.`)
      setConfirming(null)
    },
  })
  const bills = q.data ?? []
  if (bills.length === 0) return null
  return (
    <Card>
      <CardHeader title="Repeating bills" subtitle="Posted automatically when they come due" />
      <ul className="px-2 pb-2">
        {bills.map((r) => {
          const next = new Date(`${r.next_on}T00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          const payer = r.template.payer_id ? (byId.get(r.template.payer_id)?.name ?? 'A friend') : 'You'
          return (
            <li key={r.id} className="flex items-center gap-3 rounded-lg px-3 py-2">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-ink-2">
                <Repeat className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{r.description}</span>
                <span className="block truncate text-xs text-ink-3">
                  {formatMoney(r.template.total_minor, currency)} {r.cadence === 'weekly' ? 'weekly' : 'monthly'} · {payer} pay
                  {payer === 'You' ? '' : 's'} · next {next}
                </span>
              </span>
              {confirming === r.id ? (
                <span className="flex shrink-0 gap-1">
                  <Button size="sm" variant="danger" loading={stop.isPending} onClick={() => stop.mutate(r.id)}>
                    Stop
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                    Keep
                  </Button>
                </span>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setConfirming(r.id)} aria-label={`Stop repeating ${r.description}`}>
                  Stop
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/** One series per list, so one hue: the brand color, values in ink. */
function BarList({ rows, currency, label }: { rows: { key: string; name: string; value: number }[]; currency: string; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-ink-2">{label}</div>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.key} className="grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)_auto] items-center gap-2 text-xs" title={`${r.name}: ${formatMoney(r.value, currency)}`}>
            <span className="truncate text-ink-2">{r.name}</span>
            <span className="h-2 rounded-r-[4px] bg-brand" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
            <span className="tnum text-ink">{formatMoney(r.value, currency)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function GroupTotals({ group, currency }: { group: FriendGroup; currency: string }) {
  const { byId } = useAccounts()
  const q = useQuery({ queryKey: ['group-summary', group.id], queryFn: () => api.groupSummary(group.id) })
  const s = q.data
  if (!s || s.bill_count === 0) return null
  const who = (k: string) => (k === 'me' ? 'You' : (byId.get(k)?.name ?? 'Friend'))
  const paid = Object.entries(s.paid_by)
    .map(([k, v]) => ({ key: k, name: who(k), value: v }))
    .sort((a, b) => b.value - a.value)
  const cats = Object.entries(s.my_share_by_category)
    .map(([k, v]) => ({ key: k, name: byId.get(k)?.name ?? 'Other', value: v }))
    .sort((a, b) => b.value - a.value)
  return (
    <div className="mx-5 mb-4 space-y-3 rounded-lg border border-line p-3">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Group spent" value={formatMoney(s.total_spent_minor, currency)} />
        <Stat label="Your share" value={formatMoney(s.my_share_minor, currency)} />
        <Stat label="Bills" value={String(s.bill_count)} />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
        <BarList label="Who paid" rows={paid} currency={currency} />
        {cats.length > 0 && <BarList label="Your share by category" rows={cats} currency={currency} />}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[11px] text-ink-3">{label}</div>
      <div className="tnum truncate text-sm font-semibold">{value}</div>
    </div>
  )
}
