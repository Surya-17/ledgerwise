import { formatMoney } from './money'
import type { SplitMethod } from './types'

/**
 * Split `total` in proportion to `weights`, exactly: shares always sum to the total.
 * Largest-remainder method, earlier people win ties. Mirrors the server's `allocate`,
 * so the preview shows the cents the ledger will actually post.
 */
export function allocate(total: number, weights: number[]): number[] {
  if (total <= 0 || weights.length === 0 || weights.some((w) => !(w > 0))) return weights.map(() => 0)
  const whole = weights.reduce((s, w) => s + w, 0)
  const base = weights.map((w) => Math.floor((total * w) / whole))
  const rem = weights.map((w) => (total * w) % whole)
  let leftover = total - base.reduce((s, b) => s + b, 0)
  const order = weights.map((_, i) => i).sort((a, b) => rem[b] - rem[a] || a - b)
  for (const i of order) {
    if (leftover-- <= 0) break
    base[i] += 1
  }
  return base
}

export interface SplitPerson {
  /** null = you */
  id: string | null
  weight: number
  /** exact amount in minor units, or null if not entered / invalid */
  exact: number | null
}

export interface SplitPreview {
  shares: number[]
  /** For exact splits: total minus what's been assigned (0 when it adds up). */
  unassigned: number
  valid: boolean
}

export function previewSplit(total: number | null, method: SplitMethod, people: SplitPerson[]): SplitPreview {
  if (!total || total <= 0 || people.length === 0) return { shares: people.map(() => 0), unassigned: 0, valid: false }
  if (method === 'exact') {
    const shares = people.map((p) => p.exact ?? 0)
    const unassigned = total - shares.reduce((s, x) => s + x, 0)
    return { shares, unassigned, valid: unassigned === 0 && people.every((p) => p.exact !== null && p.exact >= 0) }
  }
  const weights = method === 'equal' ? people.map(() => 1) : people.map((p) => p.weight)
  const valid = weights.every((w) => Number.isInteger(w) && w >= 1 && w <= 1000)
  return { shares: valid ? allocate(total, weights) : people.map(() => 0), unassigned: 0, valid }
}

/** "owes you $5" / "you owe $5" / "settled up", from a friend balance (+ they owe you). */
export function balanceLabel(minor: number, currency: string): { text: string; tone: 'good' | 'critical' | 'muted' } {
  if (minor > 0) return { text: `owes you ${formatMoney(minor, currency)}`, tone: 'good' }
  if (minor < 0) return { text: `you owe ${formatMoney(-minor, currency)}`, tone: 'critical' }
  return { text: 'settled up', tone: 'muted' }
}
