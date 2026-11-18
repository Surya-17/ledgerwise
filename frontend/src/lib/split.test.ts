import { describe, expect, it } from 'vitest'
import { allocate, formatPercent, itemizedShares, parsePercent, previewSplit } from './split'

describe('allocate', () => {
  it('matches the server on the documented cases', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33])
    expect(allocate(1000, [2, 1, 1])).toEqual([500, 250, 250])
    expect(allocate(14280, [1, 2, 1, 1])).toEqual([2856, 5712, 2856, 2856])
  })

  it('always sums to the total and stays within a cent of fair', () => {
    let seed = 7
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
    for (let i = 0; i < 500; i++) {
      const total = 1 + rand(10_000_000)
      const weights = Array.from({ length: 1 + rand(12) }, () => 1 + rand(10))
      const shares = allocate(total, weights)
      const whole = weights.reduce((s, w) => s + w, 0)
      expect(shares.reduce((s, x) => s + x, 0)).toBe(total)
      shares.forEach((s, j) => expect(Math.abs(s * whole - total * weights[j])).toBeLessThan(whole))
    }
  })
})

describe('previewSplit', () => {
  const people = [
    { id: null, weight: 1, exact: 5000 },
    { id: 'a', weight: 3, exact: 3000 },
  ]
  it('reports what is left to assign in exact mode', () => {
    const p = previewSplit(9000, 'exact', people)
    expect(p.unassigned).toBe(1000)
    expect(p.valid).toBe(false)
    expect(previewSplit(8000, 'exact', people).valid).toBe(true)
  })
  it('uses weights in shares mode', () => {
    expect(previewSplit(8000, 'shares', people).shares).toEqual([2000, 6000])
  })
  it('is invalid without a total', () => {
    expect(previewSplit(null, 'equal', people).valid).toBe(false)
  })
})

describe('new split methods (mirror the server)', () => {
  it('percent: exact cents when it is 100%, and reports what is left', () => {
    const p = (bp: number, id: string | null) => ({ id, weight: 1, exact: null, percentBp: bp })
    const ok = previewSplit(10000, 'percent', [p(3333, null), p(3333, 'a'), p(3334, 'b')])
    expect(ok.valid).toBe(true)
    expect(ok.shares).toEqual([3333, 3333, 3334])
    const short = previewSplit(10000, 'percent', [p(5000, null), p(2500, 'a')])
    expect(short.valid).toBe(false)
    expect(short.percentLeft).toBe(2500)
  })

  it('adjust: the rest is split evenly on top of each adjustment', () => {
    const r = previewSplit(10000, 'adjust', [
      { id: null, weight: 1, exact: null, adjust: 0 },
      { id: 'a', weight: 1, exact: null, adjust: 1000 },
    ])
    expect(r.shares).toEqual([4500, 5500])
    expect(previewSplit(100, 'adjust', [{ id: null, weight: 1, exact: null, adjust: 500 }]).error).toMatch(/more than/)
  })

  it('itemized: matches the server example and always adds up', () => {
    const r = itemizedShares(
      [null, 'a'],
      [
        { name: 'Pizza', amount: 2000, people: [null, 'a'] },
        { name: 'Beer', amount: 1200, people: ['a'] },
      ],
      800,
    )
    expect(r.shares).toEqual([1250, 2750])
    let seed = 3
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
    const ids = [null, 'a', 'b', 'c']
    for (let i = 0; i < 300; i++) {
      const items = Array.from({ length: 1 + rand(6) }, () => ({
        name: 'x',
        amount: 1 + rand(100000),
        people: ids.filter(() => rand(2) === 1).concat(ids[rand(4)]).filter((v, k, a) => a.indexOf(v) === k),
      }))
      const extras = rand(5000)
      const s = itemizedShares(ids, items, extras)
      expect(s.shares.reduce((x, y) => x + y, 0)).toBe(items.reduce((x, it) => x + it.amount, 0) + extras)
    }
  })

  it('parses and formats percentages without floats', () => {
    expect(parsePercent('12.5')).toBe(1250)
    expect(parsePercent('33.33%')).toBe(3333)
    expect(parsePercent('100')).toBe(10000)
    expect(parsePercent('101')).toBeNull()
    expect(parsePercent('1.234')).toBeNull()
    expect(formatPercent(1250)).toBe('12.5%')
    expect(formatPercent(1000)).toBe('10%')
    expect(formatPercent(3333)).toBe('33.33%')
  })
})
