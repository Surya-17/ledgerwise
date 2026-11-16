import { useMutation } from '@tanstack/react-query'
import {
  ArrowRight,
  Code2,
  Fingerprint,
  History,
  Moon,
  RefreshCcw,
  Scale,
  ShieldCheck,
  Sparkles,
  Sun,
} from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Logo } from '../components/Logo'
import { Button, ErrorNote, Field, Input, Segmented, Select } from '../components/ui'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useTheme } from '../lib/hooks'

const GUARANTEES = [
  {
    icon: Scale,
    title: 'Every entry balances',
    body: 'Double-entry bookkeeping, checked in the service layer and again by a deferred PostgreSQL constraint trigger at commit.',
  },
  {
    icon: Code2,
    title: 'No floating-point money',
    body: 'Integer minor units plus an ISO 4217 currency. Excess precision is rejected, never silently rounded.',
  },
  {
    icon: RefreshCcw,
    title: 'Retries never double-post',
    body: 'Writes take an Idempotency-Key. The stored response commits in the same transaction as the work.',
  },
  {
    icon: Fingerprint,
    title: 'Safe statement re-imports',
    body: 'Each CSV row gets a SHA-256 fingerprint, so overlapping statements never double-count.',
  },
  {
    icon: History,
    title: 'Immutable history',
    body: 'Database triggers block UPDATE and DELETE on the ledger. Corrections are reversing entries.',
  },
  {
    icon: ShieldCheck,
    title: 'Audited and isolated',
    body: 'An audit row commits with every change. Composite foreign keys enforce tenant isolation in the schema.',
  },
]

export default function Landing() {
  const { signIn } = useAuth()
  const { theme, toggle } = useTheme()
  const demo = useMutation({ mutationFn: api.demo, onSuccess: (r) => signIn(r.access_token) })

  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Logo />
        <div className="flex items-center gap-2">
          <a
            href="/docs"
            className="hidden rounded-lg px-3 py-2 text-sm font-medium text-ink-2 hover:text-ink sm:block"
          >
            API docs
          </a>
          <button onClick={toggle} className="rounded-lg p-2 text-ink-3 hover:bg-surface-hover" aria-label="Toggle theme">
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
      </header>

      <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pt-10 pb-16 sm:px-6 lg:grid-cols-[1.15fr_1fr] lg:pt-16">
        <div className="animate-in">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[13px] text-ink-2 shadow-card">
            <Sparkles className="size-3.5 text-brand" /> Built like a payments ledger
          </div>
          <h1 className="text-4xl leading-[1.08] font-semibold tracking-tight text-balance sm:text-5xl lg:text-[3.4rem]">
            Personal finance you can <span className="text-brand">prove</span> is correct.
          </h1>
          <p className="mt-5 max-w-xl text-lg text-pretty text-ink-2">
            Ledgerwise tracks your accounts, spending and budgets on a real double-entry ledger, with exact money,
            idempotent writes and an append-only audit trail.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={() => demo.mutate()} loading={demo.isPending} className="group">
              Try the live demo
              <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
            </Button>
            <span className="text-sm text-ink-3">No sign-up. You get a private sandbox with 6 months of data.</span>
          </div>
          {demo.error && (
            <div className="mt-4 max-w-md">
              <ErrorNote error={demo.error} />
            </div>
          )}
          <JournalCard />
        </div>

        <AuthCard onToken={signIn} />
      </section>

      <section className="border-t border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight">Correctness guarantees</h2>
          <p className="mt-2 max-w-2xl text-ink-2">
            The same properties payment and banking systems rely on, enforced in code <em>and</em> in the database,
            and verified with property-based tests over randomly generated ledgers.
          </p>
          <div className="mt-10 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
            {GUARANTEES.map(({ icon: Icon, title, body }) => (
              <div key={title}>
                <div className="mb-3 grid size-9 place-items-center rounded-lg bg-brand-soft text-brand">
                  <Icon className="size-[18px]" />
                </div>
                <h3 className="font-semibold">{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-8 text-sm text-ink-3 sm:px-6">
        <span>FastAPI · PostgreSQL · SQLAlchemy · React · TypeScript</span>
        <a href="/docs" className="hover:text-ink">
          OpenAPI reference →
        </a>
      </footer>
    </div>
  )
}

function JournalCard() {
  const rows = [
    ['Expenses:Groceries', '84.20', ''],
    ['Liabilities:Visa Card', '', '84.20'],
  ]
  return (
    <div className="mt-10 hidden max-w-md rounded-xl border border-line bg-surface p-4 shadow-card sm:block">
      <div className="mb-3 flex items-center justify-between text-[13px]">
        <span className="font-medium">Whole Foods Market</span>
        <span className="text-ink-3">Journal entry</span>
      </div>
      <table className="w-full text-[13px]">
        <thead className="text-ink-3">
          <tr>
            <th className="pb-1.5 text-left font-normal">Account</th>
            <th className="pb-1.5 text-right font-normal">Debit</th>
            <th className="pb-1.5 text-right font-normal">Credit</th>
          </tr>
        </thead>
        <tbody className="tnum">
          {rows.map(([a, d, c]) => (
            <tr key={a} className="border-t border-line">
              <td className="py-1.5">{a}</td>
              <td className="py-1.5 text-right">{d && `$${d}`}</td>
              <td className="py-1.5 text-right">{c && `$${c}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex items-center gap-1.5 border-t border-line pt-2 text-[12px] text-good-ink">
        <ShieldCheck className="size-3.5" /> Balanced: Σ debits − Σ credits = 0
      </div>
    </div>
  )
}

function AuthCard({ onToken }: { onToken: (t: string) => void }) {
  const [mode, setMode] = useState<'signin' | 'register'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [currency, setCurrency] = useState('USD')

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === 'register') await api.register(email, password, currency)
      return api.login(email, password)
    },
    onSuccess: (r) => onToken(r.access_token),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    mutation.mutate()
  }

  return (
    <div className="animate-in rounded-2xl border border-line bg-surface p-6 shadow-pop sm:p-8" style={{ animationDelay: '80ms' }}>
      <Segmented
        value={mode}
        onChange={(m) => {
          setMode(m)
          mutation.reset()
        }}
        options={[
          { value: 'signin', label: 'Sign in' },
          { value: 'register', label: 'Create account' },
        ]}
      />
      <h2 className="mt-6 text-xl font-semibold">{mode === 'signin' ? 'Welcome back' : 'Start your ledger'}</h2>
      <p className="mt-1 text-sm text-ink-3">
        {mode === 'signin'
          ? 'Sign in to your Ledgerwise account.'
          : 'Default categories are created for you. Add accounts and import a statement next.'}
      </p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <Field label="Email">
          <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password" hint={mode === 'register' ? 'At least 8 characters.' : undefined}>
          <Input
            type="password"
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            minLength={mode === 'register' ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        {mode === 'register' && (
          <Field label="Base currency">
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'JPY'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
        )}
        <ErrorNote error={mutation.error} />
        <Button type="submit" className="w-full" size="lg" loading={mutation.isPending}>
          {mode === 'signin' ? 'Sign in' : 'Create account'}
        </Button>
      </form>
    </div>
  )
}
