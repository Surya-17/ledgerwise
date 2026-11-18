import { describe, expect, it } from 'vitest'
import { csvField, friendEffect, reminderText, sharedCsv } from './sharedText'
import type { SharedBill } from './types'

const bill = (over: Partial<SharedBill>): SharedBill => ({
  id: 'b',
  entry_id: 'e',
  group_id: null,
  kind: 'expense',
  payer_account_id: null,
  total_minor: 9000,
  currency: 'USD',
  method: 'equal',
  shares: [
    { account_id: null, amount_minor: 3000 },
    { account_id: 'alex', amount_minor: 3000 },
    { account_id: 'sam', amount_minor: 3000 },
  ],
  occurred_on: '2026-11-10',
  description: 'Dinner',
  category_id: 'din',
  my_share_minor: 3000,
  is_reversed: false,
  created_at: '',
  ...over,
})

describe('friendEffect', () => {
  it('reads a bill from one friend’s side', () => {
    expect(friendEffect(bill({}), 'alex')).toBe(3000)
    expect(friendEffect(bill({ payer_account_id: 'alex' }), 'alex')).toBe(-3000)
    expect(friendEffect(bill({ payer_account_id: 'alex' }), 'sam')).toBe(0)
    const paidBack = bill({ kind: 'settlement', shares: [{ account_id: 'alex', amount_minor: -2000 }] })
    expect(friendEffect(paidBack, 'alex')).toBe(-2000)
  })
})

describe('reminderText', () => {
  it('lists recent bills that added to the debt, skipping removed ones', () => {
    const text = reminderText(
      'Alex',
      4500,
      'USD',
      [bill({ description: 'Pizza', total_minor: 3000 }), bill({ description: 'Gone', is_reversed: true }), bill({ payer_account_id: 'alex' })],
      'alex',
    )
    expect(text).toContain('you owe me $45.00')
    expect(text).toContain('• Nov 10 Pizza: $30.00')
    expect(text).not.toContain('Gone')
  })
})

describe('csv', () => {
  it('quotes and neutralizes formulas', () => {
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('=1+1')).toBe("'=1+1")
    expect(csvField(-5)).toBe('-5')
  })

  it('exports one row per bill with your share', () => {
    const csv = sharedCsv(
      [bill({ notes: 'Joe’s, table 4' })],
      (id) => (id ? id.toUpperCase() : 'You'),
      () => 'Trip',
      () => 2,
    )
    const [header, row] = csv.trim().split('\r\n')
    expect(header.split(',')).toContain('your_share')
    expect(row).toBe('2026-11-10,Dinner,bill,Trip,You,USD,90.00,30.00,equal,You 30.00; ALEX 30.00; SAM 30.00,"Joe’s, table 4"')
  })
})
