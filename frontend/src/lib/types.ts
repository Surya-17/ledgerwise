// Mirrors backend/app/schemas.py. Money is always integer minor units + currency.

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense'

export interface User {
  id: string
  email: string
  base_currency: string
}

export interface Account {
  id: string
  name: string
  type: AccountType
  currency: string
  is_archived: boolean
  balance_minor: number
}

export interface Line {
  id: string
  line_no: number
  account_id: string
  amount_minor: number
  currency: string
  memo: string | null
}

export interface Entry {
  id: string
  occurred_on: string
  description: string
  source: 'manual' | 'import' | 'reversal'
  reverses_id: string | null
  import_batch_id: string | null
  is_reversed: boolean
  created_at: string
  lines: Line[]
}

export interface ImportBatch {
  id: string
  account_id: string
  filename: string
  row_count: number
  imported_count: number
  duplicate_count: number
  skipped_count: number
  transfer_count: number
  created_at: string
}

export interface Rule {
  id: string
  pattern: string
  account_id: string
  priority: number
}

export interface BudgetLine {
  budget_id: string
  account_id: string
  account_name: string
  currency: string
  budget_minor: number
  spent_minor: number
  remaining_minor: number
}

export interface CashFlowPoint {
  month: string
  income_minor: number
  expense_minor: number
  net_minor: number
}

export interface NetWorthPoint {
  month: string
  net_worth_minor: number
}

export interface CategorySpend {
  account_id: string
  account_name: string
  currency: string
  spent_minor: number
}

export interface AuditEvent {
  id: string
  action: string
  entity_type: string
  entity_id: string
  details: Record<string, unknown>
  created_at: string
}

export interface RecurringSeries {
  key: string
  name: string
  direction: 'in' | 'out'
  category_id: string
  category_name: string
  currency: string
  cadence: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'quarterly' | 'yearly'
  period_days: number
  amount_minor: number
  fixed_amount: boolean
  occurrences: number
  first_date: string
  last_date: string
  next_date: string
  status: 'active' | 'lapsed'
  monthly_minor: number
}
