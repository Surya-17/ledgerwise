import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, setUnauthorizedHandler, tokenStore } from './api'
import type { User } from './types'

interface AuthState {
  token: string | null
  user: User | undefined
  isDemo: boolean
  loading: boolean
  signIn: (token: string) => void
  signOut: () => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [token, setToken] = useState(tokenStore.get())

  const signOut = useCallback(() => {
    tokenStore.set(null)
    setToken(null)
    qc.clear()
  }, [qc])

  const signIn = useCallback(
    (t: string) => {
      qc.clear()
      tokenStore.set(t)
      setToken(t)
    },
    [qc],
  )

  useEffect(() => setUnauthorizedHandler(signOut), [signOut])

  const me = useQuery({ queryKey: ['me', token], queryFn: api.me, enabled: !!token, retry: false })

  const value = useMemo<AuthState>(
    () => ({
      token,
      user: me.data,
      isDemo: !!me.data?.email.endsWith('@demo.ledgerwise.app'),
      loading: !!token && me.isPending,
      signIn,
      signOut,
    }),
    [token, me.data, me.isPending, signIn, signOut],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}
