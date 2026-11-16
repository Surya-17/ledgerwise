import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './api'
import type { Account } from './types'

export function useAccounts() {
  const q = useQuery({ queryKey: ['accounts'], queryFn: api.accounts })
  const byId = useMemo(() => new Map((q.data ?? []).map((a) => [a.id, a])), [q.data])
  return { ...q, accounts: q.data ?? [], byId }
}

/** Real-money accounts (what a person thinks of as "my accounts"). */
export const isBalanceAccount = (a: Account) => a.type === 'asset' || a.type === 'liability'
export const isCategory = (a: Account) => a.type === 'income' || a.type === 'expense'

type Theme = 'light' | 'dark'

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(
    () => (document.documentElement.dataset.theme as Theme | undefined) ?? systemTheme(),
  )
  const setTheme = useCallback((t: Theme) => {
    document.documentElement.dataset.theme = t
    try {
      localStorage.setItem('theme', t)
    } catch {
      /* ignore */
    }
    setThemeState(t)
  }, [])
  return { theme, toggle: () => setTheme(theme === 'dark' ? 'light' : 'dark') }
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const fn = () => setMatches(mq.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [query])
  return matches
}
