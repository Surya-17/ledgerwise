import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Check, Plus, Sparkles, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api, newIdempotencyKey, type SharedExpenseInput } from '../lib/api'
import { isBalanceAccount, useAccounts } from '../lib/hooks'
import { exponent, formatMoney, parseMoney, todayISO } from '../lib/money'
import { balanceLabel, formatPercent, parsePercent, previewSplit, type PreviewItem } from '../lib/split'
import type { Account, BillDraft, FriendGroup, SharedBill, SplitMethod } from '../lib/types'
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
  editing,
}: {
  open: boolean
  onClose: () => void
  groups: FriendGroup[]
  initialGroupId?: string | null
  /** Edit this bill instead of adding a new one. */
  editing?: SharedBill | null
}) {
  // Remount per opening so every bill starts from a clean form (and a fresh idempotency key).
  return open ? (
    <SplitBillForm
      key={editing?.id ?? 'new'}
      onClose={onClose}
      groups={groups}
      initialGroupId={initialGroupId ?? null}
      editing={editing ?? null}
    />
  ) : null
}

const METHODS: { value: SplitMethod; label: string; title: string }[] = [
  { value: 'equal', label: 'Equal', title: 'Split equally' },
  { value: 'exact', label: 'Exact', title: 'Exact amounts' },
  { value: 'percent', label: '%', title: 'By percentage' },
  { value: 'shares', label: 'Shares', title: 'By shares' },
  { value: 'adjust', label: '+/−', title: 'Equal, with adjustments' },
  { value: 'itemized', label: 'Items', title: 'Itemized receipt' },
]

interface ItemRow {
  key: string
  name: string
  price: string
  /** person keys: ME or a friend id */
  people: string[]
}

let itemSeq = 0
const newItem = (people: string[]): ItemRow => ({ key: `item-${++itemSeq}`, name: '', price: '', people })

function minorToText(minor: number, currency: string) {
  const exp = exponent(currency)
  return (minor / 10 ** exp).toFixed(exp)
}

/** Read an optional amount box: blank = 0, unreadable = null. Allows a leading minus. */
function readAmount(text: string | undefined, currency: string): number | null {
  const t = (text ?? '').trim()
  if (!t) return 0
  const negative = t.startsWith('-') || t.startsWith('−')
  try {
    const v = parseMoney(negative ? t.slice(1) : t.replace(/^\+/, ''), currency)
    return negative ? -v : v
  } catch {
    return null
  }
}

/** The form's starting state: blank, or the bill being edited exactly as it was typed. */
function initialState(editing: SharedBill | null, initialGroupId: string | null, groups: FriendGroup[]) {
  if (!editing) {
    const g = groups.find((x) => x.id === initialGroupId)
    return {
      description: '',
      totalText: '',
      date: todayISO(),
      groupId: initialGroupId,
      payer: ME,
      paidFrom: '',
      category: '',
      method: 'equal' as SplitMethod,
      selected: [ME, ...(g?.member_ids ?? [])],
      weights: {} as Record<string, string>,
      exacts: {} as Record<string, string>,
      percents: {} as Record<string, string>,
      adjusts: {} as Record<string, string>,
      items: [] as ItemRow[],
      extrasText: '',
      notes: '',
    }
  }
  const c = editing.currency
  const key = (id: string | null) => id ?? ME
  const typed = editing.details?.participants
  // Bills saved before inputs were recorded: reopen them as the exact amounts they posted.
  const method: SplitMethod = typed ? (editing.method ?? 'equal') : editing.method === 'equal' ? 'equal' : 'exact'
  const people = typed ?? editing.shares.map((s) => ({ account_id: s.account_id, amount_minor: s.amount_minor }))
  const pick = <T,>(f: (p: (typeof people)[number]) => T | null | undefined, fmt: (v: T) => string) =>
    Object.fromEntries(
      people.flatMap((p) => {
        const v = f(p)
        return v == null ? [] : [[key(p.account_id), fmt(v)]]
      }),
    )
  return {
    description: editing.description,
    totalText: minorToText(editing.total_minor, c),
    date: editing.occurred_on,
    groupId: editing.group_id,
    payer: editing.payer_account_id ?? ME,
    paidFrom: editing.paid_from_id ?? '',
    category: editing.category_id ?? '',
    method,
    selected: people.map((p) => key(p.account_id)),
    weights: pick((p) => ('weight' in p ? p.weight : null), String),
    exacts: pick((p) => p.amount_minor, (v: number) => minorToText(v, c)),
    percents: pick((p) => ('percent_bp' in p ? p.percent_bp : null), (v: number) => formatPercent(v).replace('%', '')),
    adjusts: pick((p) => ('adjust_minor' in p ? p.adjust_minor : null), (v: number) => (v ? minorToText(v, c) : '')),
    items: (editing.details?.items ?? []).map((it) => ({
      ...newItem(it.account_ids.map(key)),
      name: it.name,
      price: minorToText(it.amount_minor, c),
    })),
    extrasText: editing.details?.extras_minor ? minorToText(editing.details.extras_minor, c) : '',
    notes: editing.notes ?? '',
  }
}

function SplitBillForm({
  onClose,
  groups,
  initialGroupId,
  editing,
}: {
  onClose: () => void
  groups: FriendGroup[]
  initialGroupId: string | null
  editing: SharedBill | null
}) {
  const qc = useQueryClient()
  const toast = useToast()
  const { accounts, byId } = useAccounts()
  const friends = (useFriends().data ?? []).filter((f) => !f.is_archived)

  const live = accounts.filter((a) => !a.is_archived)
  const money = live.filter(isBalanceAccount)
  const categories = live.filter((a) => a.type === 'expense')

  const [init] = useState(() => initialState(editing, initialGroupId, groups))
  const [description, setDescription] = useState(init.description)
  const [totalText, setTotalText] = useState(init.totalText)
  const [date, setDate] = useState(init.date)
  const [groupId, setGroupId] = useState<string | null>(init.groupId)
  const [payer, setPayer] = useState<string>(init.payer)
  const [paidFromChoice, setPaidFrom] = useState(init.paidFrom)
  const [categoryChoice, setCategory] = useState(init.category)
  const [method, setMethod] = useState<SplitMethod>(init.method)
  const group = groups.find((g) => g.id === groupId) ?? null
  const candidates: Account[] = group
    ? group.member_ids.map((id) => byId.get(id)).filter((a): a is Account => !!a)
    : friends
  const [selected, setSelected] = useState<string[]>(init.selected)
  const [weights, setWeights] = useState<Record<string, string>>(init.weights)
  const [exacts, setExacts] = useState<Record<string, string>>(init.exacts)
  const [percents, setPercents] = useState<Record<string, string>>(init.percents)
  const [adjusts, setAdjusts] = useState<Record<string, string>>(init.adjusts)
  const [items, setItems] = useState<ItemRow[]>(init.items)
  const [extrasText, setExtrasText] = useState(init.extrasText)
  const [notes, setNotes] = useState(init.notes)
  const [repeat, setRepeat] = useState<'' | 'weekly' | 'monthly'>('')
  const [idemKey] = useState(newIdempotencyKey)
  const [note, setNote] = useState('')
  const [filled, setFilled] = useState<BillDraft | null>(null)

  const paidFrom = money.some((a) => a.id === paidFromChoice) ? paidFromChoice : (money[0]?.id ?? '')
  const category = categories.some((a) => a.id === categoryChoice)
    ? categoryChoice
    : (categories.find((a) => a.name === 'Dining')?.id ?? categories[0]?.id ?? '')
  const currency = byId.get(category)?.currency ?? editing?.currency ?? 'USD'
  const payerValid = payer === ME || candidates.some((c) => c.id === payer)
  const effectivePayer = payerValid ? payer : ME

  const pickGroup = (id: string) => {
    const g = groups.find((x) => x.id === id) ?? null
    setGroupId(g?.id ?? null)
    setSelected([ME, ...(g ? g.member_ids : [])])
  }

  const order = [ME, ...candidates.map((c) => c.id)].filter((id) => selected.includes(id))
  const itemized = method === 'itemized'
  const extras = readAmount(extrasText, currency)
  const previewItems: PreviewItem[] = items.map((it) => ({
    name: it.name.trim(),
    amount: it.price.trim() ? readAmount(it.price, currency) : null,
    people: it.people.map((p) => (p === ME ? null : p)),
  }))
  const itemsTotal = previewItems.reduce((s, it) => s + (it.amount && it.amount > 0 ? it.amount : 0), 0)

  let total: number | null = null
  let totalError: string | null = null
  if (itemized) {
    total = itemsTotal + (extras ?? 0) > 0 ? itemsTotal + (extras ?? 0) : null
  } else if (totalText.trim()) {
    try {
      total = parseMoney(totalText, currency)
      if (total <= 0) totalError = 'Enter a positive amount'
    } catch (e) {
      totalError = (e as Error).message
    }
  }

  const people = order.map((id) => {
    let exact: number | null = null
    try {
      // A blank box means $0 for that person; only unreadable text is invalid.
      exact = exacts[id]?.trim() ? parseMoney(exacts[id], currency) : 0
    } catch {
      exact = null
    }
    return {
      id: id === ME ? null : id,
      weight: Number(weights[id] ?? '1'),
      exact,
      percentBp: parsePercent(percents[id] ?? ''),
      adjust: readAmount(adjusts[id], currency),
    }
  })
  const preview = previewSplit(totalError ? null : total, method, people, { items: previewItems, extras: extras ?? 0 })
  const shareOf = (id: string) => preview.shares[order.indexOf(id)] ?? 0
  const myShare = selected.includes(ME) ? shareOf(ME) : 0
  const friendsIn = order.filter((id) => id !== ME)

  let problem: string | null = null
  if (!preview.valid) problem = null
  else if (effectivePayer === ME && friendsIn.length === 0) problem = 'Pick at least one friend to split with'
  else if (effectivePayer !== ME && myShare === 0)
    problem = 'You need a share in a bill a friend paid; otherwise it doesn’t touch your books'
  const noMoneyAccount = effectivePayer === ME && money.length === 0
  const ready =
    preview.valid &&
    !problem &&
    !!description.trim() &&
    !!category &&
    (effectivePayer !== ME || !!paidFrom) &&
    (!itemized || extras !== null)
  // Say why Save is disabled instead of leaving a mystery grey button.
  const blocker = ready
    ? null
    : noMoneyAccount
      ? null // explained under "Paid from"
      : !description.trim()
        ? 'Add a description'
        : itemized && extras === null
          ? 'Check the tax and tip'
          : preview.error
            ? preview.error
            : !total || totalError
              ? 'Enter the bill total'
              : method === 'exact' && preview.unassigned !== 0
                ? 'Amounts need to add up to the total'
                : method === 'percent' && preview.percentLeft !== 0
                  ? 'Percentages need to add up to 100%'
                  : !preview.valid
                    ? 'Check the amounts above'
                    : null

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  // "Describe it": the server turns the sentence into a draft; we only fill the form.
  const applyDraft = (d: BillDraft) => {
    const cur = (d.category_id && byId.get(d.category_id)?.currency) || currency
    if (d.description) setDescription(d.description)
    if (d.total_minor) setTotalText(minorToText(d.total_minor, cur))
    if (d.occurred_on) setDate(d.occurred_on)
    if (d.category_id) setCategory(d.category_id)
    if (d.paid_from_id) setPaidFrom(d.paid_from_id)
    setGroupId(d.group_id)
    setPayer(d.payer_id ?? ME)
    setMethod(d.method)
    if (d.participants.length) {
      const key = (id: string | null) => id ?? ME
      setSelected(d.participants.map((p) => key(p.account_id)))
      setWeights(Object.fromEntries(d.participants.map((p) => [key(p.account_id), String(p.weight ?? 1)])))
      setExacts(
        Object.fromEntries(
          d.participants.map((p) => [key(p.account_id), p.amount_minor != null ? minorToText(p.amount_minor, cur) : '']),
        ),
      )
      setPercents(
        Object.fromEntries(
          d.participants.map((p) => [key(p.account_id), p.percent_bp != null ? formatPercent(p.percent_bp).replace('%', '') : '']),
        ),
      )
    }
    setFilled(d)
  }
  const fill = useMutation({ mutationFn: () => api.parseBill(note.trim()), onSuccess: applyDraft })
  const runFill = () => {
    if (note.trim() && !fill.isPending) fill.mutate()
  }

  const body = (): SharedExpenseInput => ({
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
      ...(method === 'percent' ? { percent_bp: p.percentBp } : {}),
      ...(method === 'adjust' ? { adjust_minor: p.adjust } : {}),
    })),
    ...(itemized
      ? {
          items: items.map((it, i) => ({
            name: it.name.trim() || `Item ${i + 1}`,
            amount_minor: previewItems[i].amount ?? 0,
            account_ids: it.people.filter((p) => order.includes(p)).map((p) => (p === ME ? null : p)),
          })),
          extras_minor: extras ?? 0,
        }
      : {}),
    notes: notes.trim() || null,
    ...(!editing && repeat ? { repeat } : {}),
  })

  const mutation = useMutation({
    mutationFn: () => (editing ? api.editSharedExpense(editing.id, body(), idemKey) : api.createSharedExpense(body(), idemKey)),
    onSuccess: () => {
      invalidateSharing(qc)
      toast(editing ? 'Bill updated' : repeat ? `Bill split; it repeats every ${repeat === 'weekly' ? 'week' : 'month'}` : 'Bill split')
      onClose()
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (ready) mutation.mutate()
  }

  const name = (id: string) => (id === ME ? 'You' : (byId.get(id)?.name ?? 'Friend'))
  const payerName = effectivePayer === ME ? 'You' : name(effectivePayer)
  const setItem = (key: string, patch: Partial<ItemRow>) =>
    setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)))
  const chooseMethod = (m: SplitMethod) => {
    setMethod(m)
    if (m === 'itemized' && items.length === 0) setItems([newItem(order)])
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? 'Edit bill' : 'Split a bill'}
      description={
        editing
          ? 'Saving reverses the old bill and posts this one, so the history keeps both.'
          : 'Posted to your ledger: your share as spending, the rest as what friends owe.'
      }
      wide
    >
      {friends.length === 0 ? (
        <p className="text-sm text-ink-2">Add a friend first, then you can split bills with them.</p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {!editing && (
            <div className="rounded-lg border border-line bg-surface-2/60 p-3">
              <label htmlFor="describe-bill" className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-ink-2">
                <Sparkles className="size-3.5 text-brand" aria-hidden /> Describe the bill and we'll fill in the form
              </label>
              <div className="flex gap-2">
                <Input
                  id="describe-bill"
                  placeholder="Dinner $90 with Alex and Sam, I paid with my card"
                  value={note}
                  maxLength={1000}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault() // don't submit the bill
                      runFill()
                    }
                  }}
                />
                <Button type="button" variant="secondary" loading={fill.isPending} disabled={!note.trim()} onClick={runFill}>
                  Fill in
                </Button>
              </div>
              {filled && !fill.isPending && (
                <div className="mt-2 space-y-0.5 text-xs" role="status">
                  <p className="text-ink-3">
                    {filled.source === 'ai' ? 'Filled in by AI.' : 'Filled in from your text.'} Check the details below before
                    saving.
                  </p>
                  {filled.notes.map((n) => (
                    <p key={n} className="text-critical-ink">
                      {n}
                    </p>
                  ))}
                </div>
              )}
              <ErrorNote error={fill.error} />
            </div>
          )}

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
            <Field label="Total" error={totalError} hint={itemized ? 'From the items' : undefined}>
              <Input
                inputMode="decimal"
                placeholder="0.00"
                className="tnum"
                value={itemized ? (total ? minorToText(total, currency) : '') : totalText}
                onChange={(e) => setTotalText(e.target.value)}
                readOnly={itemized}
                required={!itemized}
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
              <span className="text-[13px] font-medium text-ink-2">
                Split between{' '}
                <span className="font-normal text-ink-3">· {METHODS.find((m) => m.value === method)?.title.toLowerCase()}</span>
              </span>
              <Segmented<SplitMethod>
                value={method}
                onChange={chooseMethod}
                options={METHODS.map((m) => ({ value: m.value, label: m.label, title: m.title }))}
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
                    {on && method === 'percent' && (
                      <div className="relative w-20 shrink-0">
                        <Input
                          inputMode="decimal"
                          placeholder="0"
                          value={percents[id] ?? ''}
                          onChange={(e) => setPercents((x) => ({ ...x, [id]: e.target.value }))}
                          className="tnum h-8 pr-6 text-right"
                          aria-label={`Percent for ${name(id)}`}
                        />
                        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-ink-3">%</span>
                      </div>
                    )}
                    {on && method === 'adjust' && (
                      <div className="w-24 shrink-0">
                        <Input
                          inputMode="decimal"
                          placeholder="+0.00"
                          value={adjusts[id] ?? ''}
                          onChange={(e) => setAdjusts((x) => ({ ...x, [id]: e.target.value }))}
                          className="tnum h-8 text-right"
                          aria-label={`Adjustment for ${name(id)}`}
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
                        <span className="tnum w-20 shrink-0 text-right text-sm font-medium sm:w-24" data-testid={`share-${name(id)}`}>
                          {formatMoney(shareOf(id), currency)}
                        </span>
                      )
                    )}
                  </li>
                )
              })}
            </ul>
            {method === 'exact' && !!total && !totalError && (
              <StatusBar
                ok={preview.unassigned === 0}
                left={`${formatMoney(total - preview.unassigned, currency)} of ${formatMoney(total, currency)} assigned`}
                right={
                  preview.unassigned >= 0
                    ? `${formatMoney(preview.unassigned, currency)} left`
                    : `${formatMoney(-preview.unassigned, currency)} over`
                }
              />
            )}
            {method === 'percent' && (
              <StatusBar
                ok={preview.percentLeft === 0}
                left={`${formatPercent(10_000 - preview.percentLeft)} of 100% assigned`}
                right={
                  preview.percentLeft >= 0 ? `${formatPercent(preview.percentLeft)} left` : `${formatPercent(-preview.percentLeft)} over`
                }
              />
            )}
            {method === 'adjust' && (
              <p className="mt-2 text-xs text-ink-3">
                Add what someone had extra (or a minus for less); the rest is split equally.
              </p>
            )}
          </div>

          {itemized && (
            <div className="space-y-2">
              <div className="text-[13px] font-medium text-ink-2">Items</div>
              {items.map((it, i) => (
                <div key={it.key} className="rounded-lg border border-line p-2.5">
                  <div className="flex gap-2">
                    <Input
                      placeholder={`Item ${i + 1}`}
                      value={it.name}
                      maxLength={100}
                      onChange={(e) => setItem(it.key, { name: e.target.value })}
                      aria-label={`Item ${i + 1} name`}
                      className="h-8"
                    />
                    <div className="w-28 shrink-0">
                      <Input
                        inputMode="decimal"
                        placeholder="0.00"
                        value={it.price}
                        onChange={(e) => setItem(it.key, { price: e.target.value })}
                        aria-label={`Item ${i + 1} price`}
                        className="tnum h-8 text-right"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => setItems((xs) => xs.filter((x) => x.key !== it.key))}
                      className="shrink-0 rounded-md p-1.5 text-ink-3 hover:bg-surface-hover hover:text-ink"
                      aria-label={`Remove item ${i + 1}`}
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {order.map((id) => {
                      const onItem = it.people.includes(id)
                      return (
                        <button
                          key={id}
                          type="button"
                          role="checkbox"
                          aria-checked={onItem}
                          aria-label={`${name(id)} had item ${i + 1}`}
                          onClick={() =>
                            setItem(it.key, { people: onItem ? it.people.filter((p) => p !== id) : [...it.people, id] })
                          }
                          className={clsx(
                            'inline-flex items-center gap-1 rounded-full border py-0.5 pr-2.5 pl-0.5 text-xs transition',
                            onItem ? 'border-brand bg-brand-soft text-ink' : 'border-line-strong text-ink-3 hover:bg-surface-hover',
                          )}
                        >
                          <Avatar name={name(id)} className="size-5 text-[10px]" />
                          {name(id)}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
              <div className="flex flex-wrap items-end justify-between gap-3">
                <Button type="button" size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setItems((xs) => [...xs, newItem(order)])}>
                  Add item
                </Button>
                <Field label="Tax, tip & fees" className="w-40" error={extras === null ? 'Not an amount' : null}>
                  <Input
                    inputMode="decimal"
                    placeholder="0.00"
                    value={extrasText}
                    onChange={(e) => setExtrasText(e.target.value)}
                    className="tnum h-8 text-right"
                  />
                </Field>
              </div>
              <p className="text-xs text-ink-3">
                Items {formatMoney(itemsTotal, currency)}
                {extras ? ` ${extras > 0 ? '+' : '−'} ${formatMoney(Math.abs(extras), currency)} ${extras > 0 ? 'tax & tip' : 'discount'}` : ''}
                {' '}= {formatMoney(total ?? 0, currency)}. Tax and tip are shared in proportion to what each person had; a minus
                amount is a discount.
              </p>
            </div>
          )}

          <div className={clsx('grid gap-3', editing ? 'grid-cols-1' : 'grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]')}>
            <Field label="Notes (optional)">
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} placeholder="Who ordered what, a receipt number…" />
            </Field>
            {!editing && (
              <Field label="Repeat">
                <Select value={repeat} onChange={(e) => setRepeat(e.target.value as typeof repeat)}>
                  <option value="">Doesn’t repeat</option>
                  <option value="weekly">Every week</option>
                  <option value="monthly">Every month</option>
                </Select>
              </Field>
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
              {editing ? 'Save changes' : 'Save bill'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  )
}

function StatusBar({ ok, left, right }: { ok: boolean; left: string; right: string }) {
  return (
    <div
      className={clsx(
        'mt-2 flex items-center justify-between rounded-lg px-3 py-2 text-[13px]',
        ok ? 'bg-good-soft text-good-ink' : 'bg-critical-soft text-critical-ink',
      )}
      role="status"
    >
      <span className="tnum">{left}</span>
      <span className="tnum inline-flex items-center gap-1 font-medium">
        {ok && <Check className="size-3.5" />}
        {right}
      </span>
    </div>
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

