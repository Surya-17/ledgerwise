import { describe, expect, it } from 'vitest'
import { buildLines, isBalanced, type EntryKind } from './journal'

describe('buildLines', () => {
  it('expense: debit category, credit the paying account', () => {
    expect(buildLines('expense', 'visa', [{ account_id: 'groceries', amount_minor: 8420 }])).toEqual([
      { account_id: 'groceries', amount_minor: 8420 },
      { account_id: 'visa', amount_minor: -8420 },
    ])
  })

  it('income: debit the account, credit the income category', () => {
    expect(buildLines('income', 'checking', [{ account_id: 'salary', amount_minor: 315000 }])).toEqual([
      { account_id: 'checking', amount_minor: 315000 },
      { account_id: 'salary', amount_minor: -315000 },
    ])
  })

  it('splits one purchase across categories and merges repeats', () => {
    const lines = buildLines('expense', 'visa', [
      { account_id: 'groceries', amount_minor: 6000 },
      { account_id: 'household', amount_minor: 2420 },
      { account_id: 'groceries', amount_minor: 1000 },
    ])!
    expect(lines).toEqual([
      { account_id: 'groceries', amount_minor: 7000 },
      { account_id: 'household', amount_minor: 2420 },
      { account_id: 'visa', amount_minor: -9420 },
    ])
    expect(isBalanced(lines)).toBe(true)
  })

  it('transfer needs exactly one distinct destination', () => {
    expect(buildLines('transfer', 'checking', [{ account_id: 'savings', amount_minor: 500 }])).toEqual([
      { account_id: 'savings', amount_minor: 500 },
      { account_id: 'checking', amount_minor: -500 },
    ])
    expect(buildLines('transfer', 'checking', [{ account_id: 'checking', amount_minor: 500 }])).toBeNull()
    expect(
      buildLines('transfer', 'checking', [
        { account_id: 'a', amount_minor: 1 },
        { account_id: 'b', amount_minor: 1 },
      ]),
    ).toBeNull()
  })

  it('rejects empty, zero, negative and fractional amounts', () => {
    for (const amount_minor of [0, -5, 1.5, Number.NaN]) {
      expect(buildLines('expense', 'visa', [{ account_id: 'x', amount_minor }])).toBeNull()
    }
    expect(buildLines('expense', 'visa', [])).toBeNull()
    expect(buildLines('expense', '', [{ account_id: 'x', amount_minor: 1 }])).toBeNull()
  })

  it('always balances (randomized)', () => {
    let seed = 7
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    const kinds: EntryKind[] = ['expense', 'income']
    for (let i = 0; i < 500; i++) {
      const parts = Array.from({ length: 1 + rand(6) }, () => ({
        account_id: `c${rand(4)}`,
        amount_minor: 1 + rand(10_000_000),
      }))
      const lines = buildLines(kinds[rand(2)], 'money', parts)!
      expect(isBalanced(lines)).toBe(true)
      expect(new Set(lines.map((l) => l.account_id)).size).toBe(lines.length)
    }
  })
})
