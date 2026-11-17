import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Check } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api, newIdempotencyKey } from '../lib/api'
import { isBalanceAccount, useAccounts } from '../lib/hooks'
import { exponent, formatMoney, parseMoney, todayISO } from '../lib/money'
import { balanceLabel, previewSplit } from '../lib/split'
import type { Account, FriendGroup, SplitMethod } from '../lib/types'
import { Button, ErrorNote, Field, Input, Modal, Segmented, Select, useToast } from './ui'

const ME = 'me'

const AVATAR_TONES = [
  'bg-[#e0ecff] text-[#1d4ed8] dark:bg-[#1e3a8a]/50 dark:text-[#bfdbfe]',
  'bg-[#dcfce7] text-[#15803d] dark:bg-[#14532d]/60 dark:text-[#bbf7d0]',
  'bg-[#fef3c7] text-[#b45309] dark:bg-[#78350f]/50 dark:text-[#fde68a]',
  'bg-[#fce7f3] text-[#be185d] dark:bg-[#831843]/50 dark:text-[#fbcfe8]',
  'bg-[#ede9fe] text-[#6d28d9] dark:bg-[#4c1d95]/50 dark:text-[#ddd6fe]',
]

export function Avatar({ name, className }: { name: string; className?: string }) {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return (
    <span
      aria-hidden
      className={clsx(
        'grid size-8 shrink-0 place-items-center rounded-full text-[13px] font-semibold',
        AVATAR_TONES[h % AVATAR_TONES.length],
        className,
      )}
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}

function useFriends() {
  return useQuery({ queryKey: ['friends'], queryFn: api.friends })
}

function invalidateSharing(qc: ReturnType<typeof useQueryClient>) {
  // Bills touch balances, reports, budgets and the journal: refresh everything.
  qc.invalidateQueries()
}

// --- Split a bill ---------------------------------------------------------------------

export function SplitBillModal({
  open,
  onClose,
  groups,
  initialGroupId,
}: {
  open: boolean
  onClose: () => void
  groups: FriendGroup[]
  initialGroupId?: string | null
}) {
  // Remount per opening so every bill starts from a clean form (and a fresh idempotency key).
  return open ? (
    <SplitBillForm onClose={onClose} groups={groups} initialGroupId={initialGroupId ?? null} />
  ) : null
}

function SplitBillForm({
  onClose,
  groups,
  initialGroupId,
}: {
  onClose: () => void
  groups: FriendGroup[]
  initialGroupId: string | null
}) {
  const qc = useQueryClient()
  const toast = useToast()
  const { accounts, byId } = useAccounts()
  const friends = (useFriends().data ?? []).filter((f) => !f.is_archived)

  const live = accounts.filter((a) => !a.is_archived)
  const money = live.filter(isBalanceAccount)
  const categories = live.filter((a) => a.type === 'expense')

  const [description, setDescription] = useState('')
  const [totalText, setTotalText] = useState('')
  const [date, setDate] = useState(todayISO())
  const [groupId, setGroupId] = useState<string | null>(initialGroupId)
  const [payer, setPayer] = useState<string>(ME)
  const [paidFromChoice, setPaidFrom] = useState('')
  const [categoryChoice, setCategory] = useState('')
  const [method, setMethod] = useState<SplitMethod>('equal')
  const group = groups.find((g) => g.id === groupId) ?? null
  const candidates: Account[] = group
    ? group.member_ids.map((id) => byId.get(id)).filter((a): a is Account => !!a)
    : friends
  const [selected, setSelected] = useState<string[]>(() => [ME, ...(group?.member_ids ?? [])])
  const [weights, setWeights] = useState<Record<string, string>>({})
  const [exacts, setExacts] = useState<Record<string, string>>({})
  const [idemKey] = useState(newIdempotencyKey)

  const paidFrom = money.some((a) => a.id === paidFromChoice) ? paidFromChoice : (money[0]?.id ?? '')
  const category = categories.some((a) => a.id === categoryChoice)
    ? categoryChoice
    : (categories.find((a) => a.name === 'Dining')?.id ?? categories[0]?.id ?? '')
  const currency = byId.get(category)?.currency ?? 'USD'
  const payerValid = payer === ME || candidates.some((c) => c.id === payer)
  const effectivePayer = payerValid ? payer : ME

  const pickGroup = (id: string) => {
    const g = groups.find((x) => x.id === id) ?? null
    setGroupId(g?.id ?? null)
    setSelected([ME, ...(g ? g.member_ids : [])])
  }

  let total: number | null = null
  let totalError: string | null = null
  if (totalText.trim()) {
    try {
      total = parseMoney(totalText, currency)
      if (total <= 0) totalError = 'Enter a positive amount'
    } catch (e) {
      totalError = (e as Error).message
    }
  }

  const order = [ME, ...candidates.map((c) => c.id)].filter((id) => selected.includes(id))
  const people = order.map((id) => {
    let exact: number | null = null
    try {
      // A blank box means $0 for that person; only unreadable text is invalid.
      exact = exacts[id]?.trim() ? parseMoney(exacts[id], currency) : 0
    } catch {
      exact = null
    }
    return { id: id === ME ? null : id, weight: Number(weights[id] ?? '1'), exact }
  })
  const preview = previewSplit(totalError ? null : total, method, people)
  const shareOf = (id: string) => preview.shares[order.indexOf(id)] ?? 0
  const myShare = selected.includes(ME) ? shareOf(ME) : 0
  const friendsIn = order.filter((id) => id !== ME)

  let problem: string | null = null
  if (!preview.valid) problem = null
  else if (effectivePayer === ME && friendsIn.length === 0) problem = 'Pick at least one friend to split with'
  else if (effectivePayer !== ME && myShare === 0)
    problem = 'You need a share in a bill a friend paid; otherwise it doesn’t touch your books'
  const noMoneyAccount = effectivePayer === ME && money.length === 0
  const ready = preview.valid && !problem && !!description.trim() && !!category && (effectivePayer !== ME || !!paidFrom)
  // Say why Save is disabled instead of leaving a mystery grey button.
  const blocker = ready
    ? null
    : noMoneyAccount
      ? null // explained under "Paid from"
      : !description.trim()
        ? 'Add a description'
        : !total || totalError
          ? 'Enter the bill total'
          : method === 'exact' && preview.unassigned !== 0
            ? 'Amounts need to add up to the total'
            : !preview.valid
              ? 'Check the amounts above'
              : null

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  const mutation = useMutation({
    mutationFn: () =>
      api.createSharedExpense(
        {
          occurred_on: date,
          description: description.trim(),
          total_minor: total!,
          category_id: category,
          payer_id: effectivePayer === ME ? null : effectivePayer,
          paid_from_id: effectivePayer === ME ? paidFrom : null,
          group_id: groupId,
          method,
          participants: people.map((p, i) => ({
            account_id: p.id,
            ...(method === 'shares' ? { weight: p.weight } : {}),
            ...(method === 'exact' ? { amount_minor: preview.shares[i] } : {}),
          })),
        },
        idemKey,
      ),
    onSuccess: () => {
      invalidateSharing(qc)
      toast('Bill split')
      onClose()
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (ready) mutation.mutate()
  }

  const name = (id: string) => (id === ME ? 'You' : (byId.get(id)?.name ?? 'Friend'))
  const payerName = effectivePayer === ME ? 'You' : name(effectivePayer)

  return (
    <Modal open onClose={onClose} title="Split a bill" description="Posted to your ledger: your share as spending, the rest as what friends owe." wide>
      {friends.length === 0 ? (
        <p className="text-sm text-ink-2">Add a friend first, then you can split bills with them.</p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <Field label="Description">
              <Input
                placeholder="Dinner at Joe's"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
                required
              />
            </Field>
            <Field label="Total" error={totalError}>
              <Input
                inputMode="decimal"
                placeholder="0.00"
                className="tnum"
                value={totalText}
                onChange={(e) => setTotalText(e.target.value)}
                required
              />
            </Field>
            <Field label="Date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Group">
              <Select value={groupId ?? ''} onChange={(e) => pickGroup(e.target.value)}>
                <option value="">No group</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Paid by">
              <Select value={effectivePayer} onChange={(e) => setPayer(e.target.value)}>
                <option value={ME}>You</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            {effectivePayer === ME && (
              <Field
                label="Paid from"
                error={
                  noMoneyAccount ? (
                    <>
                      No bank account or card yet.{' '}
                      <Link to="/accounts" onClick={onClose} className="font-medium underline">
                        Add one
                      </Link>
                    </>
                  ) : null
                }
              >
                <Select value={paidFrom} onChange={(e) => setPaidFrom(e.target.value)} disabled={noMoneyAccount}>
                  {money.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Category">
              <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                {categories.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[13px] font-medium text-ink-2">Split between</span>
              <Segmented<SplitMethod>
                value={method}
                onChange={setMethod}
                options={[
                  { value: 'equal', label: 'Equally' },
                  { value: 'exact', label: 'Exact amounts' },
                  { value: 'shares', label: 'By shares' },
                ]}
              />
            </div>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {[ME, ...candidates.map((c) => c.id)].map((id) => {
                const on = selected.includes(id)
                return (
                  <li key={id} className="flex min-h-12 items-center gap-3 px-3 py-1.5">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      aria-label={`Include ${name(id)}`}
                      onClick={() => toggle(id)}
                      className={clsx(
                        'grid size-5 shrink-0 place-items-center rounded-md border transition',
                        on ? 'border-brand bg-brand text-brand-ink' : 'border-line-strong',
                      )}
                    >
                      {on && <Check className="size-3.5" />}
                    </button>
                    <Avatar name={name(id)} className="size-7 text-xs" />
                    <span className={clsx('min-w-0 flex-1 truncate text-sm', !on && 'text-ink-3')}>{name(id)}</span>
                    {on && method === 'shares' && (
                      <div className="w-16 shrink-0">
                        <Input
                          type="number"
                          min={1}
                          max={1000}
                          step={1}
                          value={weights[id] ?? '1'}
                          onChange={(e) => setWeights((w) => ({ ...w, [id]: e.target.value }))}
                          className="tnum h-8"
                          aria-label={`Shares for ${name(id)}`}
                        />
                      </div>
                    )}
                    {on && method === 'exact' ? (
                      <div className="w-28 shrink-0">
                        <Input
                          inputMode="decimal"
                          placeholder="0.00"
                          value={exacts[id] ?? ''}
                          onChange={(e) => setExacts((x) => ({ ...x, [id]: e.target.value }))}
                          className="tnum h-8 text-right"
                          aria-label={`Amount for ${name(id)}`}
                        />
                      </div>
                    ) : (
                      on && (
                        <span className="tnum w-24 shrink-0 text-right text-sm font-medium" data-testid={`share-${name(id)}`}>
                          {formatMoney(shareOf(id), currency)}
                        </span>
                      )
                    )}
                  </li>
                )
              })}
            </ul>
            {method === 'exact' && !!total && !totalError && (
              <div
                className={clsx(
                  'mt-2 flex items-center justify-between rounded-lg px-3 py-2 text-[13px]',
                  preview.unassigned === 0 ? 'bg-good-soft text-good-ink' : 'bg-critical-soft text-critical-ink',
                )}
                role="status"
              >
                <span className="tnum">
                  {formatMoney(total - preview.unassigned, currency)} of {formatMoney(total, currency)} assigned
                </span>
                <span className="tnum inline-flex items-center gap-1 font-medium">
                  {preview.unassigned === 0 && <Check className="size-3.5" />}
                  {preview.unassigned >= 0
                    ? `${formatMoney(preview.unassigned, currency)} left`
                    : `${formatMoney(-preview.unassigned, currency)} over`}
                </span>
              </div>
            )}
          </div>

          {preview.valid && !problem && (
            <div className="rounded-lg border border-line bg-surface-2/60 p-3 text-[13px]">
              <div className="mb-1.5 font-medium">
                {payerName} paid {formatMoney(total ?? 0, currency)}
              </div>
              <ul className="space-y-0.5 text-ink-2">
                {effectivePayer === ME ? (
                  <>
                    {friendsIn
                      .filter((id) => shareOf(id) > 0)
                      .map((id) => (
                        <li key={id}>
                          {name(id)} owes you <span className="tnum font-medium text-good-ink">{formatMoney(shareOf(id), currency)}</span>
                        </li>
                      ))}
                    {myShare > 0 && (
                      <li>
                        Your share <span className="tnum font-medium">{formatMoney(myShare, currency)}</span> is booked to{' '}
                        {byId.get(category)?.name}
                      </li>
                    )}
                  </>
                ) : (
                  <li>
                    You owe {payerName}{' '}
                    <span className="tnum font-medium text-critical-ink">{formatMoney(myShare, currency)}</span>, booked to{' '}
                    {byId.get(category)?.name}. Other people’s shares are between them and {payerName}.
                  </li>
                )}
              </ul>
            </div>
          )}
          {problem && <p className="text-sm text-critical-ink">{problem}</p>}

          <ErrorNote error={mutation.error} />
          <div className="flex items-center justify-end gap-2">
            {blocker && <span className="mr-auto text-xs text-ink-3">{blocker}</span>}
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending} disabled={!ready}>
              Save bill
            </Button>
          </div>
        </form>
      )}
    </Modal>
  )
}

// --- Settle up ------------------------------------------------------------------------

export function SettleUpModal({
  friend,
  groupId,
  onClose,
}: {
  friend: Account | null
  groupId?: string | null
  onClose: () => void
}) {
  return friend ? <SettleUpForm friend={friend} groupId={groupId ?? null} onClose={onClose} /> : null
}

function SettleUpForm({ friend, groupId, onClose }: { friend: Account; groupId: string | null; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const { accounts } = useAccounts()
  const money = accounts.filter((a) => !a.is_archived && isBalanceAccount(a) && a.currency === friend.currency)
  const [direction, setDirection] = useState<'they_paid' | 'you_paid'>(friend.balance_minor < 0 ? 'you_paid' : 'they_paid')
  const [amount, setAmount] = useState(
    friend.balance_minor
      ? (Math.abs(friend.balance_minor) / 10 ** exponent(friend.currency)).toFixed(exponent(friend.currency))
      : '',
  )
  const [accountChoice, setAccount] = useState('')
  const [date, setDate] = useState(todayISO())
  const [idemKey] = useState(newIdempotencyKey)
  const account = money.some((a) => a.id === accountChoice) ? accountChoice : (money[0]?.id ?? '')

  let minor: number | null = null
  let error: string | null = null
  if (amount.trim()) {
    try {
      minor = parseMoney(amount, friend.currency)
      if (minor <= 0) error = 'Enter a positive amount'
    } catch (e) {
      error = (e as Error).message
    }
  }

  const m = useMutation({
    mutationFn: () =>
      api.createSettlement(
        { friend_id: friend.id, account_id: account, amount_minor: minor!, direction, occurred_on: date, group_id: groupId },
        idemKey,
      ),
    onSuccess: () => {
      invalidateSharing(qc)
      toast(direction === 'they_paid' ? `Recorded ${friend.name}'s payment` : `Recorded your payment to ${friend.name}`)
      onClose()
    },
  })
  const current = balanceLabel(friend.balance_minor, friend.currency)

  return (
    <Modal open onClose={onClose} title={`Settle up with ${friend.name}`} description={`Right now ${friend.name} ${current.text}.`}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (minor && !error && account) m.mutate()
        }}
      >
        <Segmented
          value={direction}
          onChange={setDirection}
          options={[
            { value: 'they_paid', label: `${friend.name} paid you` },
            { value: 'you_paid', label: `You paid ${friend.name}` },
          ]}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount" error={error}>
            <Input inputMode="decimal" className="tnum" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
        </div>
        <Field label={direction === 'they_paid' ? 'Received into' : 'Paid from'}>
          <Select value={account} onChange={(e) => setAccount(e.target.value)}>
            {money.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={m.isPending} disabled={!minor || !!error || !account}>
            Record payment
          </Button>
        </div>
      </form>
    </Modal>
  )
}

// --- Friends & groups -----------------------------------------------------------------

export function AddFriendModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [name, setName] = useState('')
  const m = useMutation({
    mutationFn: () => api.createFriend(name.trim()),
    onSuccess: (f) => {
      qc.invalidateQueries()
      toast(`${f.name} added`)
      setName('')
      onClose()
    },
  })
  return (
    <Modal
      open={open}
      onClose={() => {
        m.reset()
        onClose()
      }}
      title="Add a friend"
      description="Friends are private to you. They don't need an account."
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) m.mutate()
        }}
      >
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Alex" required />
        </Field>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={m.isPending} disabled={!name.trim()}>
            Add friend
          </Button>
        </div>
      </form>
    </Modal>
  )
}

export function GroupModal({
  group,
  open,
  onClose,
}: {
  group: FriendGroup | null
  open: boolean
  onClose: () => void
}) {
  return open ? <GroupForm group={group} onClose={onClose} /> : null
}

function GroupForm({ group, onClose }: { group: FriendGroup | null; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const friends = (useFriends().data ?? []).filter((f) => !f.is_archived || group?.member_ids.includes(f.id))
  const [name, setName] = useState(group?.name ?? '')
  const [members, setMembers] = useState<string[]>(group?.member_ids ?? [])
  const save = useMutation({
    mutationFn: () =>
      group ? api.updateGroup(group.id, { name: name.trim(), member_ids: members }) : api.createGroup(name.trim(), members),
    onSuccess: (g) => {
      qc.invalidateQueries({ queryKey: ['groups'] })
      toast(group ? `${g.name} updated` : `${g.name} created`)
      onClose()
    },
  })
  const remove = useMutation({
    mutationFn: () => api.deleteGroup(group!.id),
    onSuccess: () => {
      qc.invalidateQueries()
      toast(`${group!.name} deleted; its bills are kept`)
      onClose()
    },
  })
  return (
    <Modal
      open
      onClose={onClose}
      title={group ? 'Edit group' : 'New group'}
      description="Groups preselect who's in a bill and keep a running tab per group."
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) save.mutate()
        }}
      >
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Roommates" required />
        </Field>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium text-ink-2">Members</legend>
          {friends.length === 0 ? (
            <p className="text-sm text-ink-3">Add friends first.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {friends.map((f) => {
                const on = members.includes(f.id)
                return (
                  <button
                    key={f.id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => setMembers((m) => (on ? m.filter((x) => x !== f.id) : [...m, f.id]))}
                    className={clsx(
                      'inline-flex items-center gap-1.5 rounded-full border py-1 pr-3 pl-1 text-sm transition',
                      on ? 'border-brand bg-brand-soft text-ink' : 'border-line-strong text-ink-2 hover:bg-surface-hover',
                    )}
                  >
                    <Avatar name={f.name} className="size-6 text-[11px]" />
                    {f.name}
                    {on && <Check className="size-3.5 text-brand" />}
                  </button>
                )
              })}
            </div>
          )}
        </fieldset>
        <ErrorNote error={save.error ?? remove.error} />
        <div className="flex items-center justify-between gap-2">
          {group ? (
            <Button type="button" variant="ghost" className="text-critical-ink" loading={remove.isPending} onClick={() => remove.mutate()}>
              Delete group
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!name.trim()}>
              {group ? 'Save' : 'Create group'}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

