import { describe, expect, it } from 'vitest'
import { formatMoney, parseMoney, shiftDays, shiftMonth } from './money'

describe('parseMoney', () => {
  it('parses into integer minor units without floating point', () => {
    expect(parseMoney('42.50')).toBe(4250)
    expect(parseMoney('0.1')).toBe(10)
    expect(parseMoney('1,234.56')).toBe(123456)
    expect(parseMoney('$7')).toBe(700)
    expect(parseMoney('-3.05')).toBe(-305)
    // 0.1 + 0.2 style traps: string parsing is exact.
    expect(parseMoney('0.29')).toBe(29)
  })

  it('rejects excess precision instead of rounding', () => {
    expect(() => parseMoney('12.345')).toThrow(/2 decimal places/)
    expect(() => parseMoney('5.5', 'JPY')).toThrow(/no decimal places/)
    expect(parseMoney('1.234', 'KWD')).toBe(1234)
  })

  it('rejects junk', () => {
    for (const bad of ['', 'abc', '1e5', '1.2.3', 'NaN', '--1']) {
      expect(() => parseMoney(bad), bad).toThrow()
    }
  })

  it('round-trips with formatMoney', () => {
    for (const minor of [0, 1, 99, 100, 123456, 987654321]) {
      expect(parseMoney(formatMoney(minor, 'USD'))).toBe(minor)
    }
  })
})

describe('formatMoney', () => {
  it('uses a true minus sign and optional plus', () => {
    expect(formatMoney(-4250)).toBe('−$42.50')
    expect(formatMoney(4250, 'USD', { signed: true })).toBe('+$42.50')
    expect(formatMoney(500, 'JPY')).toBe('¥500')
  })
})

describe('shiftMonth', () => {
  it('crosses year boundaries', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-05', -17)).toBe('2024-12')
  })
})

describe('shiftDays', () => {
  it('crosses month and leap-year boundaries in UTC', () => {
    expect(shiftDays('2026-11-25', 14)).toBe('2026-12-09')
    expect(shiftDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(shiftDays('2026-01-01', -1)).toBe('2025-12-31')
  })
})
