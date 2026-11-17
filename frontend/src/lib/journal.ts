import type { LineInput } from './api'

export type EntryKind = 'expense' | 'income' | 'transfer'

export interface Part {
  account_id: string
  amount_minor: number // positive
}

/**
 * Build balanced journal lines for a transaction the way a person describes it.
 *
 * Sign convention: positive = debit, negative = credit.
 *   expense:  debit each category,       credit the paying account by the total
 *   income:   debit the receiving account, credit each income category
 *   transfer: debit the destination,     credit the source (exactly one part)
 *
 * Parts on the same category are merged, so the entry has one line per account.
 * Returns null when there's nothing valid to post yet.
 */
export function buildLines(kind: EntryKind, moneyAccountId: string, parts: Part[]): LineInput[] | null {
  if (!moneyAccountId || parts.length === 0) return null
  if (parts.some((p) => !p.account_id || !Number.isSafeInteger(p.amount_minor) || p.amount_minor <= 0)) return null
  if (kind === 'transfer' && (parts.length !== 1 || parts[0].account_id === moneyAccountId)) return null
  if (parts.some((p) => p.account_id === moneyAccountId)) return null

  const merged = new Map<string, number>()
  for (const p of parts) merged.set(p.account_id, (merged.get(p.account_id) ?? 0) + p.amount_minor)
  const total = [...merged.values()].reduce((a, b) => a + b, 0)

  const counter = [...merged].map(([account_id, m]) => ({
    account_id,
    amount_minor: kind === 'income' ? -m : m,
  }))
  const money = { account_id: moneyAccountId, amount_minor: kind === 'income' ? total : -total }
  return kind === 'income' ? [money, ...counter] : [...counter, money]
}

/** Every entry must sum to zero; used as a last client-side guard and in tests. */
export function isBalanced(lines: LineInput[]): boolean {
  return lines.length >= 2 && lines.reduce((s, l) => s + l.amount_minor, 0) === 0
}
