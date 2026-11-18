import { formatMoney } from './money'
import type { SharedBill } from './types'

/** What a bill means for one friend: + they owe you, - you owe them (from your books). */
export function friendEffect(bill: SharedBill, friendId: string): number {
  if (bill.kind === 'settlement') return bill.shares[0]?.account_id === friendId ? bill.shares[0].amount_minor : 0
  if (bill.payer_account_id === null) return bill.shares.find((s) => s.account_id === friendId)?.amount_minor ?? 0
  return bill.payer_account_id === friendId ? -bill.my_share_minor : 0
}

const shortDate = (iso: string) =>
  new Date(`${iso}T00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/**
 * A friendly nudge to paste into a text message. Lists the most recent bills that added
 * to what they owe, newest first. Nothing is sent: the person copies it and sends it.
 */
export function reminderText(friend: string, balance: number, currency: string, bills: SharedBill[], friendId: string, max = 5) {
  const lines = bills
    .filter((b) => !b.is_reversed && b.kind === 'expense' && friendEffect(b, friendId) > 0)
    .slice(0, max)
    .map((b) => `• ${shortDate(b.occurred_on)} ${b.description}: ${formatMoney(friendEffect(b, friendId), currency)}`)
  return [
    `Hi ${friend}! Quick reminder that you owe me ${formatMoney(balance, currency)} in total.`,
    ...(lines.length ? ['', 'Recent bills:', ...lines] : []),
    '',
    'Thanks!',
  ].join('\n')
}

/** RFC 4180 field: quote when it holds a comma, quote or newline; neutralize spreadsheet formulas. */
export function csvField(v: string | number | null | undefined): string {
  let s = v == null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}` // "=HYPERLINK(...)" stays text
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function sharedCsv(
  bills: SharedBill[],
  name: (accountId: string | null) => string,
  groupName: (groupId: string | null) => string,
  decimals: (currency: string) => number,
): string {
  const money = (minor: number, c: string) => (minor / 10 ** decimals(c)).toFixed(decimals(c))
  const header = ['date', 'description', 'type', 'group', 'paid_by', 'currency', 'total', 'your_share', 'split', 'shares', 'notes']
  const rows = bills.map((b) => [
    b.occurred_on,
    b.description,
    b.kind === 'settlement' ? 'payment' : 'bill',
    groupName(b.group_id),
    b.kind === 'settlement'
      ? b.payer_account_id
        ? name(b.payer_account_id)
        : 'You'
      : name(b.payer_account_id),
    b.currency,
    money(b.total_minor, b.currency),
    b.kind === 'expense' ? money(b.my_share_minor, b.currency) : '',
    b.method ?? '',
    b.kind === 'expense' ? b.shares.map((s) => `${name(s.account_id)} ${money(s.amount_minor, b.currency)}`).join('; ') : '',
    b.notes ?? '',
  ])
  return [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n'
}

export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
