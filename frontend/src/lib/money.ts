// Money never touches floating point on the way *in*: user input is parsed as a
// string into integer minor units, exactly like backend/app/money.py.
// Floats are used only for display formatting, after the exact value is known.

const EXPONENTS: Record<string, number> = { USD: 2, EUR: 2, GBP: 2, INR: 2, CAD: 2, AUD: 2, SGD: 2, CHF: 2, JPY: 0, KWD: 3 }

export function exponent(currency: string): number {
  return EXPONENTS[currency] ?? 2
}

const formatters = new Map<string, Intl.NumberFormat>()
function formatter(currency: string, compact: boolean): Intl.NumberFormat {
  const key = `${currency}:${compact}`
  let f = formatters.get(key)
  if (!f) {
    f = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      ...(compact
        ? { notation: 'compact', maximumFractionDigits: 1 }
        : { minimumFractionDigits: exponent(currency), maximumFractionDigits: exponent(currency) }),
    })
    formatters.set(key, f)
  }
  return f
}

export function formatMoney(
  minor: number,
  currency = 'USD',
  opts: { compact?: boolean; signed?: boolean } = {},
): string {
  const value = minor / 10 ** exponent(currency)
  const text = formatter(currency, !!opts.compact).format(Math.abs(value))
  if (minor < 0) return `−${text}`
  if (opts.signed && minor > 0) return `+${text}`
  return text
}

/** Parse "1,234.56" into 123456. Rejects excess precision instead of rounding. */
export function parseMoney(input: string, currency = 'USD'): number {
  const text = input.trim().replace(/[,\s$€£₹¥]/g, '')
  const match = /^(-)?(\d+)(?:\.(\d*))?$/.exec(text)
  if (!match) throw new Error('Enter an amount like 42.50')
  const [, neg, whole, frac = ''] = match
  const exp = exponent(currency)
  if (frac.length > exp) {
    throw new Error(exp === 0 ? `${currency} has no decimal places` : `At most ${exp} decimal places`)
  }
  const minor = BigInt(whole) * 10n ** BigInt(exp) + BigInt(frac.padEnd(exp, '0') || '0')
  if (minor > 10n ** 15n) throw new Error('Amount is too large')
  const n = Number(minor)
  return neg ? -n : n
}

export function monthLabel(month: string, style: 'short' | 'long' = 'short'): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', {
    month: style,
    ...(style === 'long' ? { year: 'numeric' } : {}),
  })
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function currentMonth(): string {
  return todayISO().slice(0, 7)
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const idx = y * 12 + (m - 1) + delta
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`
}
