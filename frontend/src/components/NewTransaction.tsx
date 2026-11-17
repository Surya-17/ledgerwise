import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, ShieldCheck, Split, X } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { api, newIdempotencyKey } from '../lib/api'
import { isBalanceAccount, useAccounts } from '../lib/hooks'
import { buildLines, type EntryKind, type Part } from '../lib/journal'
import { formatMoney, parseMoney, todayISO } from '../lib/money'
import type { Account } from '../lib/types'
import { Button, ErrorNote, Field, Input, Modal, Segmented, Select, useToast } from './ui'

interface SplitRow {
  key: number
  account: string
  amount: string
}

function parsePositive(text: string, currency: string): { minor: number | null; error: string | null } {
  if (!text.trim()) return { minor: null, error: null }
  try {
    const minor = parseMoney(text, currency)
    return minor > 0 ? { minor, error: null } : { minor: null, error: 'Enter a positive amount' }
  } catch (e) {
    return { minor: null, error: (e as Error).message }
  }
}

let rowKey = 0

export function NewTransactionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { accounts, byId } = useAccounts()
  const qc = useQueryClient()
  const toast = useToast()

  const [kind, setKind] = useState<EntryKind>('expense')
  const [date, setDate] = useState(todayISO())
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [accountChoice, setAccount] = useState('')
  const [counterChoice, setCounter] = useState('')
  const [splits, setSplits] = useState<SplitRow[] | null>(null)
  // One key per logical submission: a double-click or network retry replays, never re-posts.
  const [idemKey, setIdemKey] = useState(newIdempotencyKey)

  const live = accounts.filter((a) => !a.is_archived)
  const money = live.filter(isBalanceAccount)
  // Derived, not synced in effects: fall back to the first valid option.
  const account = money.some((a) => a.id === accountChoice) ? accountChoice : (money[0]?.id ?? '')
  const counterOptions: Account[] =
    kind === 'expense'
      ? live.filter((a) => a.type === 'expense')
      : kind === 'income'
        ? live.filter((a) => a.type === 'income')
        : money.filter((a) => a.id !== account)
  const counter = counterOptions.some((a) => a.id === counterChoice) ? counterChoice : (counterOptions[0]?.id ?? '')
  const currency = byId.get(account)?.currency ?? 'USD'
  const splitting = splits !== null && kind !== 'transfer'

  const single = useMemo(() => parsePositive(amount, currency), [amount, currency])
  const splitParsed = useMemo(
    () => (splits ?? []).map((r) => ({ ...r, ...parsePositive(r.amount, currency) })),
    [splits, currency],
  )

  const parts: Part[] = splitting
    ? splitParsed.filter((r) => r.minor && r.account).map((r) => ({ account_id: r.account, amount_minor: r.minor! }))
    : single.minor && counter
      ? [{ account_id: counter, amount_minor: single.minor }]
      : []
  const splitIncomplete = splitting && splitParsed.some((r) => !r.minor)
  const lines = splitIncomplete ? null : buildLines(kind, account, parts)
  const total = parts.reduce((s, p) => s + p.amount_minor, 0)

  const startSplit = () => {
    const first = { key: ++rowKey, account: counter, amount }
    const second = { key: ++rowKey, account: counterOptions.find((a) => a.id !== counter)?.id ?? counter, amount: '' }
    setSplits([first, second])
  }
  const updateRow = (key: number, patch: Partial<SplitRow>) =>
    setSplits((rows) => rows && rows.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const removeRow = (key: number) => {
    const next = (splits ?? []).filter((r) => r.key !== key)
    if (next.length <= 1) {
      // Back to a simple one-category transaction, keeping what was typed.
      if (next[0]) {
        setCounter(next[0].account)
        setAmount(next[0].amount)
      }
      setSplits(null)
    } else {
      setSplits(next)
    }
  }

  const mutation = useMutation({
    mutationFn: () => api.createEntry({ occurred_on: date, description: description.trim(), lines: lines! }, idemKey),
    onSuccess: () => {
      qc.invalidateQueries()
      toast('Transaction posted')
      setDescription('')
      setAmount('')
      setSplits(null)
      setIdemKey(newIdempotencyKey())
      onClose()
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (lines && description.trim()) mutation.mutate()
  }

  const close = () => {
    mutation.reset()
    onClose()
  }

  return (
    <Modal open={open} onClose={close} title="New transaction" description="Posted as a balanced double-entry journal entry.">
      <form onSubmit={submit} className="space-y-4">
        <Segmented<EntryKind>
          value={kind}
          onChange={(k) => {
            setKind(k)
            if (k === 'transfer') setSplits(null)
          }}
          options={[
            { value: 'expense', label: 'Expense' },
            { value: 'income', label: 'Income' },
            { value: 'transfer', label: 'Transfer' },
          ]}
        />
        <div className="grid grid-cols-2 gap-3">
          {splitting ? (
            <Field label="Total">
              <div className="tnum flex h-9 items-center rounded-lg bg-surface-2 px-3 text-sm font-medium">
                {formatMoney(total, currency)}
              </div>
            </Field>
          ) : (
            <Field label="Amount" error={single.error}>
              <Input
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="tnum"
                required
              />
            </Field>
          )}
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
        </div>
        <Field label="Description">
          <Input
            placeholder={kind === 'expense' ? 'Costco run' : kind === 'income' ? 'Paycheck' : 'Move to savings'}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            required
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={kind === 'income' ? 'Deposit to' : kind === 'transfer' ? 'From' : 'Paid from'}>
            <Select value={account} onChange={(e) => setAccount(e.target.value)}>
              {money.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          {!splitting && (
            <Field label={kind === 'transfer' ? 'To' : 'Category'}>
              <Select value={counter} onChange={(e) => setCounter(e.target.value)}>
                {counterOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>

        {kind !== 'transfer' &&
          (splitting ? (
            <fieldset className="space-y-2">
              <legend className="mb-1.5 text-[13px] font-medium text-ink-2">Split across categories</legend>
              {splitParsed.map((r, i) => (
                <div key={r.key}>
                  <div className="grid grid-cols-[minmax(0,1fr)_7rem_auto] gap-2">
                    <Select
                      value={r.account}
                      onChange={(e) => updateRow(r.key, { account: e.target.value })}
                      aria-label={`Category ${i + 1}`}
                    >
                      {counterOptions.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </Select>
                    <Input
                      inputMode="decimal"
                      placeholder="0.00"
                      value={r.amount}
                      onChange={(e) => updateRow(r.key, { amount: e.target.value })}
                      className="tnum"
                      aria-label={`Amount ${i + 1}`}
                    />
                    <button
                      type="button"
                      onClick={() => removeRow(r.key)}
                      className="rounded-md px-2 text-ink-3 hover:bg-surface-hover hover:text-ink"
                      aria-label={`Remove split ${i + 1}`}
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                  {r.error && <div className="mt-1 text-xs text-critical-ink">{r.error}</div>}
                </div>
              ))}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                icon={<Plus className="size-3.5" />}
                onClick={() => setSplits((rows) => [...(rows ?? []), { key: ++rowKey, account: counter, amount: '' }])}
                disabled={(splits?.length ?? 0) >= 10}
              >
                Add category
              </Button>
            </fieldset>
          ) : (
            <button
              type="button"
              onClick={startSplit}
              className="inline-flex items-center gap-1.5 text-[13px] font-medium text-brand hover:underline"
            >
              <Split className="size-3.5" /> Split across categories
            </button>
          ))}

        {lines && (
          <div className="rounded-lg border border-line bg-surface-2/60 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-ink-3 uppercase">
              <ShieldCheck className="size-3.5" /> Journal preview
            </div>
            <table className="w-full text-[13px]">
              <thead className="text-ink-3">
                <tr>
                  <th className="pb-1 text-left font-normal">Account</th>
                  <th className="pb-1 text-right font-normal">Debit</th>
                  <th className="pb-1 text-right font-normal">Credit</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {lines.map((l) => (
                  <tr key={l.account_id}>
                    <td className="py-0.5">{byId.get(l.account_id)?.name}</td>
                    <td className="py-0.5 text-right">{l.amount_minor > 0 ? formatMoney(l.amount_minor, currency) : ''}</td>
                    <td className="py-0.5 text-right">{l.amount_minor < 0 ? formatMoney(-l.amount_minor, currency) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 border-t border-line pt-2 text-[12px] text-ink-3">
              Debits = credits, so the entry balances to zero.
            </div>
          </div>
        )}

        <ErrorNote error={mutation.error} />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" loading={mutation.isPending} disabled={!lines || !description.trim()}>
            Post transaction
          </Button>
        </div>
      </form>
    </Modal>
  )
}
