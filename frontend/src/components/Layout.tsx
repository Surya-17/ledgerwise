import clsx from 'clsx'
import {
  ArrowLeftRight,
  FileUp,
  History,
  LayoutDashboard,
  LogOut,
  Moon,
  PiggyBank,
  Plus,
  Sun,
  Wallet,
} from 'lucide-react'
import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useTheme } from '../lib/hooks'
import { Logo } from './Logo'
import { NewTransactionModal } from './NewTransaction'
import { Button } from './ui'

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/transactions', label: 'Transactions', icon: ArrowLeftRight },
  { to: '/accounts', label: 'Accounts', icon: Wallet },
  { to: '/budgets', label: 'Budgets', icon: PiggyBank },
  { to: '/import', label: 'Import', icon: FileUp },
  { to: '/activity', label: 'Audit log', icon: History },
]

export function Layout() {
  const { user, isDemo, signOut } = useAuth()
  const { theme, toggle } = useTheme()
  const [adding, setAdding] = useState(false)

  return (
    <div className="min-h-dvh lg:pl-60">
      {/* Sidebar (desktop) */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line bg-surface lg:flex">
        <div className="flex h-16 items-center px-5">
          <Logo />
        </div>
        <div className="px-3 pb-3">
          <Button className="w-full" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
            New transaction
          </Button>
        </div>
        <nav className="flex-1 space-y-0.5 px-3" aria-label="Main">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition',
                  isActive ? 'bg-brand-soft text-brand' : 'text-ink-2 hover:bg-surface-hover hover:text-ink',
                )
              }
            >
              <Icon className="size-[18px]" strokeWidth={1.8} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line p-3">
          <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
            <div className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft text-xs font-semibold text-brand uppercase">
              {isDemo ? 'D' : user?.email[0]}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{isDemo ? 'Demo sandbox' : user?.email}</div>
              <div className="text-[11px] text-ink-3">{user?.base_currency ?? '…'}</div>
            </div>
            <button
              onClick={toggle}
              className="rounded-md p-1.5 text-ink-3 hover:bg-surface-hover hover:text-ink"
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>
            <button
              onClick={signOut}
              className="rounded-md p-1.5 text-ink-3 hover:bg-surface-hover hover:text-ink"
              aria-label="Sign out"
            >
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Top bar (mobile) */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-surface/90 px-4 backdrop-blur lg:hidden">
        <Logo />
        <div className="flex items-center gap-1">
          <button onClick={toggle} className="rounded-md p-2 text-ink-3" aria-label="Toggle theme">
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          <button onClick={signOut} className="rounded-md p-2 text-ink-3" aria-label="Sign out">
            <LogOut className="size-4" />
          </button>
        </div>
      </header>

      {isDemo && (
        <div className="border-b border-line bg-brand-soft px-4 py-2 text-center text-[13px] text-ink-2">
          You're in a <strong className="font-semibold text-ink">private demo sandbox</strong> with six months of
          sample data. Everything works, so go ahead and post, import, reverse and recategorize.
        </div>
      )}

      <main className="mx-auto max-w-7xl px-4 pt-6 pb-28 sm:px-6 lg:px-8 lg:pt-8 lg:pb-12">
        <Outlet context={{ openNewTransaction: () => setAdding(true) }} />
      </main>

      {/* Bottom tabs (mobile) */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
        aria-label="Main"
      >
        {NAV.slice(0, 2).map((n) => (
          <TabLink key={n.to} {...n} />
        ))}
        <button
          onClick={() => setAdding(true)}
          className="flex flex-col items-center justify-center"
          aria-label="New transaction"
        >
          <span className="grid size-10 place-items-center rounded-full bg-brand text-brand-ink shadow-pop">
            <Plus className="size-5" />
          </span>
        </button>
        {NAV.slice(2, 4).map((n) => (
          <TabLink key={n.to} {...n} />
        ))}
      </nav>

      <NewTransactionModal open={adding} onClose={() => setAdding(false)} />
    </div>
  )
}

function TabLink({ to, label, icon: Icon, end }: (typeof NAV)[number]) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        clsx('flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium', isActive ? 'text-brand' : 'text-ink-3')
      }
    >
      <Icon className="size-5" strokeWidth={1.8} />
      {label}
    </NavLink>
  )
}
