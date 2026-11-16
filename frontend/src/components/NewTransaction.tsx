import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { api, newIdempotencyKey, type LineInput } from '../lib/api'
import { isBalanceAccount, useAccounts } from '../lib/hooks'
import { formatMoney, parseMoney, todayISO } from '../lib/money'
import type { Account } from '../lib/types'
import { Button, ErrorNote, Field, Input, Modal, Segmented, Select, useToast } from './ui'

type Kind = 'expense' | 'income' | 'transfer'

export function NewTransactionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { accounts, byId } = useAccounts()
  const qc = useQueryClient()
  const toast = useToast()

  const [kind, setKind] = useState<Kind>('expense')
  const [date, setDate] = useState(todayISO())
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [accountChoice, setAccount] = useState('')
  const [counterChoice, setCounter] = useState('')
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
  const parsed = useMemo(() => {
    if (!amount.trim()) return { minor: null, error: null }
    try {
      const minor = parseMoney(amount, currency)
      if (minor <= 0) return { minor: null, error: 'Enter a positive amount' }
      return { minor, error: null }
    } catch (e) {
      return { minor: null, error: (e as Error).message }
    }
  }, [amount, currency])

  // Positive = debit, negative = credit. Every entry sums to zero.
  const lines: LineInput[] | null = useMemo(() => {
    const m = parsed.minor
    if (!m || !account || !counter) return null
    if (kind === 'expense') return [
      { account_id: counter, amount_minor: m },
      { account_id: account, amount_minor: -m },
    ]
    if (kind === 'income') return [
      { account_id: account, amount_minor: m },
      { account_id: counter, amount_minor: -m },
    ]
    return [
      { account_id: counter, amount_minor: m },
      { account_id: account, amount_minor: -m },
    ]
  }, [parsed.minor, account, counter, kind])

  const mutation = useMutation({
    mutationFn: () => api.createEntry({ occurred_on: date, description: description.trim(), lines: lines! }, idemKey),
    onSuccess: () => {
      qc.invalidateQueries()
      toast('Transaction posted')
      setDescription('')
      setAmount('')
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
    <Modal
      open={open}
      onClose={close}
      title="New transaction"
      description="Posted as a balanced double-entry journal entry."
    >
      <form onSubmit={submit} className="space-y-4">
        <Segmented<Kind>
          value={kind}
          onChange={setKind}
          options={[
            { value: 'expense', label: 'Expense' },
            { value: 'income', label: 'Income' },
            { value: 'transfer', label: 'Transfer' },
          ]}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount" error={parsed.error}>
            <Input
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="tnum"
              required
            />
          </Field>
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
        </div>
        <Field label="Description">
          <Input
            placeholder={kind === 'expense' ? 'Trader Joe’s' : kind === 'income' ? 'Paycheck' : 'Move to savings'}
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
          <Field label={kind === 'transfer' ? 'To' : 'Category'}>
            <Select value={counter} onChange={(e) => setCounter(e.target.value)}>
              {counterOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

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
