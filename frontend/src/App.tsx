import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Logo } from './components/Logo'
import { ToastProvider } from './components/ui'
import { ApiError } from './lib/api'
import { AuthProvider, useAuth } from './lib/auth'
import Landing from './pages/Landing'

const Dashboard = lazy(() => import('./pages/Dashboard'))
const Transactions = lazy(() => import('./pages/Transactions'))
const Accounts = lazy(() => import('./pages/Accounts'))
const Budgets = lazy(() => import('./pages/Budgets'))
const Import = lazy(() => import('./pages/Import'))
const Recurring = lazy(() => import('./pages/Recurring'))
const Shared = lazy(() => import('./pages/Shared'))
const Activity = lazy(() => import('./pages/Activity'))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
})

function Splash() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <div className="animate-pulse">
        <Logo />
      </div>
    </div>
  )
}

function Routed() {
  const { token, loading } = useAuth()
  if (loading) return <Splash />
  if (!token) {
    return (
      <Routes>
        <Route path="*" element={<Landing />} />
      </Routes>
    )
  }
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="transactions" element={<Transactions />} />
          <Route path="accounts" element={<Accounts />} />
          <Route path="budgets" element={<Budgets />} />
          <Route path="recurring" element={<Recurring />} />
          <Route path="shared" element={<Shared />} />
          <Route path="import" element={<Import />} />
          <Route path="activity" element={<Activity />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <BrowserRouter>
            <Routed />
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  )
}
