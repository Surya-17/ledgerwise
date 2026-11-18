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

/** `allocate`, but zero weights get 0 (server: `_allocate_nonneg`). */
export function allocateNonneg(total: number, weights: number[]): number[] {
  const live = weights.map((w, i) => [w, i] as const).filter(([w]) => w > 0)
  const out = weights.map(() => 0)
  if (total <= 0 || live.length === 0) return out
  allocate(
    total,
    live.map(([w]) => w),
  ).forEach((share, k) => (out[live[k][1]] = share))
  return out
}

export interface SplitPerson {
  /** null = you */
  id: string | null
  weight: number
  /** exact amount in minor units, or null if not entered / invalid */
  exact: number | null
  /** percentage in basis points (12.5% = 1250), or null if invalid */
  percentBp?: number | null
  /** adjustment in minor units (can be negative), or null if invalid */
  adjust?: number | null
}

export interface PreviewItem {
  name: string
  /** minor units, or null if not entered / invalid */
  amount: number | null
  /** null = you */
  people: (string | null)[]
}

export interface SplitPreview {
  shares: number[]
  /** For exact splits: total minus what's been assigned (0 when it adds up). */
  unassigned: number
  /** For percentage splits: basis points left to assign (0 when it's 100%). */
  percentLeft: number
  valid: boolean
  /** Why it isn't valid, when there's something specific to say. */
  error?: string
}

const none = (people: unknown[], error?: string): SplitPreview => ({
  shares: people.map(() => 0),
  unassigned: 0,
  percentLeft: 0,
  valid: false,
  error,
})

/** Itemized receipt: each item split equally among its people, extras (tax/tip, or a
 * negative discount) spread by subtotal. Mirrors the server's `itemized_shares`. */
export function itemizedShares(
  people: (string | null)[],
  items: PreviewItem[],
  extras: number,
): { shares: number[]; subtotal: number; valid: boolean; error?: string } {
  const index = new Map(people.map((p, i) => [p, i]))
  const sub = people.map(() => 0)
  let error: string | undefined
  for (const item of items) {
    const on = item.people.filter((p) => index.has(p)).sort((a, b) => index.get(a)! - index.get(b)!)
    if (item.amount === null || item.amount <= 0) error ??= `Enter a price for ${item.name || 'each item'}`
    else if (on.length === 0) error ??= `Pick who had ${item.name || 'each item'}`
    else allocate(item.amount, on.map(() => 1)).forEach((s, k) => (sub[index.get(on[k])!] += s))
  }
  if (items.length === 0) error ??= 'Add an item'
  const subtotal = sub.reduce((s, x) => s + x, 0)
  if (extras < 0 && -extras > subtotal) error ??= 'The discount is bigger than the items'
  const spread = allocateNonneg(Math.abs(extras), sub)
  const sign = extras >= 0 ? 1 : -1
  const shares = sub.map((s, i) => s + sign * spread[i])
  return { shares, subtotal, valid: !error, error }
}

export function previewSplit(
  total: number | null,
  method: SplitMethod,
  people: SplitPerson[],
  itemized?: { items: PreviewItem[]; extras: number },
): SplitPreview {
  if (people.length === 0) return none(people)
  if (method === 'itemized') {
    const r = itemizedShares(
      people.map((p) => p.id),
      itemized?.items ?? [],
      itemized?.extras ?? 0,
    )
    return { shares: r.shares, unassigned: 0, percentLeft: 0, valid: r.valid && (total ?? 0) > 0, error: r.error }
  }
  if (!total || total <= 0) return none(people)
  if (method === 'exact') {
    const shares = people.map((p) => p.exact ?? 0)
    const unassigned = total - shares.reduce((s, x) => s + x, 0)
    return {
      shares,
      unassigned,
      percentLeft: 0,
      valid: unassigned === 0 && people.every((p) => p.exact !== null && p.exact >= 0),
    }
  }
  if (method === 'percent') {
    const bps = people.map((p) => p.percentBp ?? 0)
    const percentLeft = 10_000 - bps.reduce((s, b) => s + b, 0)
    const ok = people.every((p) => p.percentBp != null && p.percentBp >= 0)
    const valid = ok && percentLeft === 0
    // While it doesn't add up yet, show each person's straight proportion of the total.
    const shares = valid ? allocateNonneg(total, bps) : bps.map((b) => Math.floor((total * Math.max(b, 0)) / 10_000))
    return { shares, unassigned: 0, percentLeft, valid }
  }
  if (method === 'adjust') {
    if (people.some((p) => p.adjust == null)) return none(people, 'Check the adjustments')
    const adj = people.map((p) => p.adjust ?? 0)
    const rest = total - adj.reduce((s, a) => s + a, 0)
    if (rest < 0) return none(people, 'The adjustments add up to more than the bill')
    const shares = allocateNonneg(
      rest,
      people.map(() => 1),
    ).map((b, i) => b + adj[i])
    if (shares.some((s) => s < 0)) return none(people, 'An adjustment makes someone’s share negative')
    return { shares, unassigned: 0, percentLeft: 0, valid: true }
  }
  const weights = method === 'equal' ? people.map(() => 1) : people.map((p) => p.weight)
  const valid = weights.every((w) => Number.isInteger(w) && w >= 1 && w <= 1000)
  return { shares: valid ? allocate(total, weights) : people.map(() => 0), unassigned: 0, percentLeft: 0, valid }
}

/** "12.5" -> 1250 basis points; null if it isn't a percentage with at most 2 decimals. */
export function parsePercent(text: string): number | null {
  const t = text.trim().replace(/%$/, '').trim()
  if (!t) return 0
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null
  const [whole, frac = ''] = t.split('.')
  const bp = Number(whole) * 100 + Number(frac.padEnd(2, '0'))
  return bp <= 10_000 ? bp : null
}

export function formatPercent(bp: number): string {
  return `${bp % 100 === 0 ? bp / 100 : (bp / 100).toFixed(2).replace(/0$/, '')}%`
}

/** "owes you $5" / "you owe $5" / "settled up", from a friend balance (+ they owe you). */
export function balanceLabel(minor: number, currency: string): { text: string; tone: 'good' | 'critical' | 'muted' } {
  if (minor > 0) return { text: `owes you ${formatMoney(minor, currency)}`, tone: 'good' }
  if (minor < 0) return { text: `you owe ${formatMoney(-minor, currency)}`, tone: 'critical' }
  return { text: 'settled up', tone: 'muted' }
}
