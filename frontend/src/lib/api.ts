import type {
  Account,
  AccountType,
  AuditEvent,
  BillDraft,
  BudgetLine,
  CashFlowPoint,
  CategorySpend,
  Entry,
  FriendGroup,
  GroupSummary,
  ImportBatch,
  NetWorthPoint,
  RecurringBill,
  RecurringSeries,
  Rule,
  BillItem,
  BillParticipantInput,
  SharedBill,
  SplitMethod,
  User,
} from './types'

const BASE = import.meta.env.VITE_API_URL ?? ''
const TOKEN_KEY = 'ledgerwise.token'

export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

export const tokenStore = {
  get(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY)
    } catch {
      return null
    }
  },
  set(token: string | null) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token)
      else localStorage.removeItem(TOKEN_KEY)
    } catch {
      /* private mode: session lasts until reload */
    }
  },
}

let onUnauthorized: () => void = () => {}
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn
}

function messageFrom(body: unknown, status: number): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail) && detail.length) {
      return detail
        .map((d: { msg?: string; loc?: unknown[] }) => {
          const field = Array.isArray(d.loc) ? d.loc.filter((p) => p !== 'body').join('.') : ''
          return field ? `${field}: ${d.msg}` : d.msg
        })
        .join('; ')
    }
  }
  return `Request failed (${status})`
}

interface Options {
  method?: string
  json?: unknown
  form?: FormData | URLSearchParams
  /** Sent as Idempotency-Key so a retried write is applied at most once. */
  idempotencyKey?: string
}

async function request<T>(path: string, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = {}
  const token = tokenStore.get()
  if (token) headers.Authorization = `Bearer ${token}`
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey
  let body: BodyInit | undefined
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.json)
  } else if (opts.form) {
    body = opts.form
  }

  const res = await fetch(`${BASE}/api${path}`, { method: opts.method ?? 'GET', headers, body })
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized()
    throw new ApiError(res.status, messageFrom(data, res.status), data)
  }
  return data as T
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v))
  const str = s.toString()
  return str ? `?${str}` : ''
}

export const newIdempotencyKey = () => crypto.randomUUID()

export interface LineInput {
  account_id: string
  amount_minor: number
  memo?: string
}

export const api = {
  // auth
  login: (email: string, password: string) =>
    request<{ access_token: string }>('/auth/token', {
      method: 'POST',
      form: new URLSearchParams({ username: email, password }),
    }),
  register: (email: string, password: string, base_currency: string) =>
    request<User>('/auth/register', { method: 'POST', json: { email, password, base_currency } }),
  demo: () => request<{ access_token: string }>('/auth/demo', { method: 'POST' }),
  me: () => request<User>('/auth/me'),

  // accounts
  accounts: () => request<Account[]>('/accounts'),
  createAccount: (body: {
    name: string
    type: AccountType
    opening_balance_minor?: number
    opening_date?: string
  }) => request<Account>('/accounts', { method: 'POST', json: body }),
  updateAccount: (id: string, body: { name?: string; is_archived?: boolean }) =>
    request<Account>(`/accounts/${id}`, { method: 'PATCH', json: body }),

  // entries
  entries: (p: { account_id?: string; q?: string; start?: string; end?: string; limit?: number; offset?: number }) =>
    request<Entry[]>(`/entries${qs(p)}`),
  createEntry: (
    body: { occurred_on: string; description: string; lines: LineInput[] },
    idempotencyKey: string,
  ) => request<Entry>('/entries', { method: 'POST', json: body, idempotencyKey }),
  reverseEntry: (id: string, reason: string | undefined, idempotencyKey: string) =>
    request<Entry>(`/entries/${id}/reverse`, { method: 'POST', json: { reason }, idempotencyKey }),
  recategorize: (id: string, from_account_id: string, to_account_id: string, idempotencyKey: string) =>
    request<Entry>(`/entries/${id}/recategorize`, {
      method: 'POST',
      json: { from_account_id, to_account_id },
      idempotencyKey,
    }),

  /** Journal CSV for the current filters; fetched with auth, saved as a file by the caller. */
  exportEntries: async (p: { account_id?: string; q?: string }): Promise<Blob> => {
    const token = tokenStore.get()
    const res = await fetch(`${BASE}/api/entries/export${qs(p)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) throw new ApiError(res.status, `Export failed (${res.status})`, null)
    return res.blob()
  },

  // imports & rules
  imports: () => request<ImportBatch[]>('/imports'),
  uploadStatement: (form: FormData) => request<ImportBatch>('/imports', { method: 'POST', form }),
  rules: () => request<Rule[]>('/rules'),
  createRule: (body: { pattern: string; account_id: string; priority?: number }) =>
    request<Rule>('/rules', { method: 'POST', json: body }),
  deleteRule: (id: string) => request<void>(`/rules/${id}`, { method: 'DELETE' }),

  // budgets & reports
  budgets: (month: string) => request<BudgetLine[]>(`/budgets${qs({ month: `${month}-01` })}`),
  setBudget: (account_id: string, month: string, amount_minor: number) =>
    request('/budgets', { method: 'PUT', json: { account_id, month: `${month}-01`, amount_minor } }),
  deleteBudget: (id: string) => request<void>(`/budgets/${id}`, { method: 'DELETE' }),
  cashFlow: (months = 6) => request<CashFlowPoint[]>(`/reports/cash-flow${qs({ months })}`),
  netWorth: (months = 6) => request<NetWorthPoint[]>(`/reports/net-worth${qs({ months })}`),
  spending: (month: string) => request<CategorySpend[]>(`/reports/spending${qs({ month: `${month}-01` })}`),
  recurring: () => request<RecurringSeries[]>('/reports/recurring'),
  audit: (limit = 100, offset = 0) => request<AuditEvent[]>(`/audit${qs({ limit, offset })}`),

  // sharing
  friends: () => request<Account[]>('/friends'),
  createFriend: (name: string) => request<Account>('/friends', { method: 'POST', json: { name } }),
  groups: () => request<FriendGroup[]>('/groups'),
  createGroup: (name: string, member_ids: string[]) =>
    request<FriendGroup>('/groups', { method: 'POST', json: { name, member_ids } }),
  updateGroup: (id: string, body: { name?: string; member_ids?: string[] }) =>
    request<FriendGroup>(`/groups/${id}`, { method: 'PATCH', json: body }),
  deleteGroup: (id: string) => request<void>(`/groups/${id}`, { method: 'DELETE' }),
  shared: (p: { group_id?: string; friend_id?: string } = {}) => request<SharedBill[]>(`/shared${qs(p)}`),
  createSharedExpense: (body: SharedExpenseInput, idempotencyKey: string) =>
    request<SharedBill>('/shared/expenses', { method: 'POST', json: body, idempotencyKey }),
  editSharedExpense: (id: string, body: SharedExpenseInput, idempotencyKey: string) =>
    request<SharedBill>(`/shared/expenses/${id}`, { method: 'PUT', json: body, idempotencyKey }),
  recurringBills: () => request<RecurringBill[]>('/shared/recurring'),
  runRecurringBills: () => request<{ posted: number }>('/shared/recurring/run', { method: 'POST' }),
  stopRecurringBill: (id: string) => request<RecurringBill>(`/shared/recurring/${id}/stop`, { method: 'POST' }),
  groupSummary: (id: string) => request<GroupSummary>(`/groups/${id}/summary`),
  parseBill: (text: string) => request<BillDraft>('/shared/parse', { method: 'POST', json: { text } }),
  createSettlement: (
    body: {
      friend_id: string
      account_id: string
      amount_minor: number
      direction: 'they_paid' | 'you_paid'
      occurred_on: string
      group_id?: string | null
    },
    idempotencyKey: string,
  ) => request<SharedBill>('/shared/settlements', { method: 'POST', json: body, idempotencyKey }),
}

export interface SharedExpenseInput {
  occurred_on: string
  description: string
  total_minor: number
  category_id: string
  payer_id: string | null
  paid_from_id: string | null
  group_id: string | null
  method: SplitMethod
  participants: BillParticipantInput[]
  items?: BillItem[]
  extras_minor?: number
  notes?: string | null
  repeat?: 'weekly' | 'monthly' | null
}
