import { describe, expect, it } from 'vitest'
import { describeEntry } from './entries'
import type { Account, AccountType, Entry } from './types'

const acct = (id: string, type: AccountType): Account => ({
  id,
  name: id,
  type,
  currency: 'USD',
  is_archived: false,
  balance_minor: 0,
})

const byId = new Map(
  [
    acct('Checking', 'asset'),
    acct('Savings', 'asset'),
    acct('Visa', 'liability'),
    acct('Groceries', 'expense'),
    acct('Salary', 'income'),
    acct('Equity', 'equity'),
  ].map((a) => [a.id, a]),
)

const entry = (lines: [string, number][]): Entry => ({
  id: 'e',
  occurred_on: '2026-11-01',
  description: 'x',
  source: 'manual',
  reverses_id: null,
  import_batch_id: null,
  is_reversed: false,
  created_at: '2026-11-01T00:00:00Z',
  lines: lines.map(([account_id, amount_minor], i) => ({
    id: String(i),
    line_no: i + 1,
    account_id,
    amount_minor,
    currency: 'USD',
    memo: null,
  })),
})

describe('describeEntry', () => {
  it('reads a card purchase as money out', () => {
    const v = describeEntry(entry([['Groceries', 8420], ['Visa', -8420]]), byId)
    expect(v.kind).toBe('out')
    expect(v.amount).toBe(-8420)
    expect(v.categoryLine?.account_id).toBe('Groceries')
  })

  it('reads a paycheck as money in', () => {
    const v = describeEntry(entry([['Checking', 315000], ['Salary', -315000]]), byId)
    expect(v.kind).toBe('in')
    expect(v.amount).toBe(315000)
  })

  it('treats moves between own accounts as transfers, ordered from -> to', () => {
    const v = describeEntry(entry([['Savings', 60000], ['Checking', -60000]]), byId)
    expect(v.kind).toBe('transfer')
    expect(v.gross).toBe(60000)
    expect(v.moneyAccounts.map((a) => a.id)).toEqual(['Checking', 'Savings'])
    expect(v.categoryLine).toBeNull()
  })

  it('treats paying a card from checking as a transfer, not spending', () => {
    const v = describeEntry(entry([['Visa', 50000], ['Checking', -50000]]), byId)
    expect(v.kind).toBe('transfer')
    expect(v.moneyAccounts.map((a) => a.id)).toEqual(['Checking', 'Visa'])
  })

  it('does not offer recategorization for opening balances or splits', () => {
    expect(describeEntry(entry([['Checking', 1000], ['Equity', -1000]]), byId).categoryLine).toBeNull()
    const split = entry([
      ['Groceries', 600],
      ['Salary', 400],
      ['Checking', -1000],
    ])
    expect(describeEntry(split, byId).categoryLine).toBeNull()
  })
})
