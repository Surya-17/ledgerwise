import type { Account, Entry, Line } from './types'

export interface EntryView {
  /** Signed effect on the user's money: + inflow, − outflow, 0 for internal transfers. */
  amount: number
  /** Gross size, used for transfers where the net effect is zero. */
  gross: number
  kind: 'in' | 'out' | 'transfer'
  currency: string
  moneyAccounts: Account[]
  categories: Account[]
  /** The single category line, if this is a simple two-line entry (recategorizable). */
  categoryLine: Line | null
}

/**
 * Translate a balanced journal entry into how a person reads a transaction.
 * Debits to assets and credits to liabilities are the same thing in reverse,
 * so the raw ledger sum over money accounts *is* the net cash effect.
 */
export function describeEntry(entry: Entry, byId: Map<string, Account>): EntryView {
  let amount = 0
  let gross = 0
  const money: { acct: Account; amt: number }[] = []
  const cats: Account[] = []
  const catLines: Line[] = []
  for (const line of entry.lines) {
    const acct = byId.get(line.account_id)
    if (!acct) continue
    if (acct.type === 'asset' || acct.type === 'liability') {
      amount += line.amount_minor
      if (line.amount_minor > 0) gross += line.amount_minor
      money.push({ acct, amt: line.amount_minor })
    } else {
      cats.push(acct)
      if (acct.type !== 'equity') catLines.push(line)
    }
  }
  const kind = amount > 0 ? 'in' : amount < 0 ? 'out' : 'transfer'
  return {
    amount,
    gross: gross || Math.abs(amount),
    kind,
    currency: entry.lines[0]?.currency ?? 'USD',
    // Credits first: reads as "from → to" for transfers.
    moneyAccounts: money.sort((a, b) => a.amt - b.amt).map((m) => m.acct),
    categories: cats,
    categoryLine: catLines.length === 1 && entry.lines.length === 2 ? catLines[0] : null,
  }
}
