import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { HandCoins, Pencil, Plus, Receipt, Trash2, UserPlus, Users } from 'lucide-react'
import { useState } from 'react'
import { AddFriendModal, Avatar, GroupModal, SettleUpModal, SplitBillModal } from '../components/sharing'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNote, PageHeader, Skeleton, useToast } from '../components/ui'
import { api, newIdempotencyKey } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useAccounts } from '../lib/hooks'
import { formatMoney } from '../lib/money'
import { balanceLabel } from '../lib/split'
import type { Account, FriendGroup, SharedBill } from '../lib/types'

type Filter = { kind: 'all' } | { kind: 'group'; id: string } | { kind: 'friend'; id: string }

const METHOD: Record<string, string> = { equal: 'split equally', exact: 'exact amounts', shares: 'split by shares' }

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

  const [splitting, setSplitting] = useState(false)
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
        </div>

        <Card>
          <CardHeader
            title={filterGroup ? filterGroup.name : filterFriend ? `With ${filterFriend.name}` : 'All shared activity'}
            subtitle={filter.kind === 'all' ? 'Bills and payments, newest first' : undefined}
            action={
              filter.kind !== 'all' ? (
                <Button size="sm" variant="ghost" onClick={() => setFilter({ kind: 'all' })}>
                  Show all
                </Button>
              ) : undefined
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
                <BillRow key={b.id} bill={b} groups={groups} />
              ))}
            </ul>
          )}
        </Card>
      </div>

      <SplitBillModal
        open={splitting}
        onClose={() => setSplitting(false)}
        groups={groups}
        initialGroupId={filter.kind === 'group' ? filter.id : null}
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

function BillRow({ bill, groups }: { bill: SharedBill; groups: FriendGroup[] }) {
  const { byId } = useAccounts()
  const qc = useQueryClient()
  const toast = useToast()
  const [confirming, setConfirming] = useState(false)
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

  return (
    <li className="group flex items-center gap-3 px-4 py-3 sm:px-5">
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
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{bill.description}</div>
        <div className="truncate text-xs text-ink-3" title={detail}>
          {detail}
        </div>
      </div>
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
        <button
          onClick={() => setConfirming(true)}
          className="shrink-0 rounded-md p-1.5 text-ink-3 transition hover:bg-surface-2 hover:text-ink focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
          aria-label={`Remove ${bill.description}`}
          title="Remove (posts a reversing entry)"
        >
          <Trash2 className="size-4" />
        </button>
      )}
    </li>
  )
}
