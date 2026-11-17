import { describe, expect, it } from 'vitest'
import { allocate, previewSplit } from './split'

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
