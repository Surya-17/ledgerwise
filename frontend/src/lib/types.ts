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
  /** "friend": what one person owes you (+) or you owe them (−). */
  kind?: string | null
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

export interface FriendGroup {
  id: string
  name: string
  member_ids: string[]
  /** Per friend account id, from this group's bills only: + they owe you, − you owe them. */
  balances: Record<string, number>
  total_spent_minor: number
}

export type SplitMethod = 'equal' | 'exact' | 'shares' | 'percent' | 'adjust' | 'itemized'

export interface BillParticipantInput {
  account_id: string | null
  weight?: number | null
  amount_minor?: number | null
  /** basis points: 12.5% = 1250 */
  percent_bp?: number | null
  adjust_minor?: number | null
}

export interface BillItem {
  name: string
  amount_minor: number
  /** null = you */
  account_ids: (string | null)[]
}

export interface RecurringBill {
  id: string
  description: string
  cadence: 'weekly' | 'monthly'
  next_on: string
  is_active: boolean
  template: { total_minor: number; group_id: string | null; payer_id: string | null; participants: BillParticipantInput[] }
}

export interface GroupSummary {
  total_spent_minor: number
  my_share_minor: number
  bill_count: number
  /** "me" or a friend's account id */
  paid_by: Record<string, number>
  my_share_by_category: Record<string, number>
  by_month: Record<string, number>
}

/** A split-bill form filled from a sentence. Nothing is saved until the user submits. */
export interface BillDraft {
  source: 'ai' | 'rules'
  description: string | null
  total_minor: number | null
  occurred_on: string | null
  payer_id: string | null
  paid_from_id: string | null
  category_id: string | null
  group_id: string | null
  method: SplitMethod
  participants: { account_id: string | null; weight: number | null; amount_minor: number | null; percent_bp?: number | null }[]
  notes: string[]
}

export interface SharedBill {
  id: string
  entry_id: string
  group_id: string | null
  kind: 'expense' | 'settlement'
  /** null = you paid. */
  payer_account_id: string | null
  total_minor: number
  currency: string
  method: SplitMethod | null
  /** account_id null = you. */
  shares: { account_id: string | null; amount_minor: number }[]
  occurred_on: string
  description: string
  category_id: string | null
  my_share_minor: number
  is_reversed: boolean
  created_at: string
  notes?: string | null
  /** What was typed: per-person inputs, and items for itemized bills. */
  details?: { participants?: BillParticipantInput[]; items?: BillItem[]; extras_minor?: number } | null
  paid_from_id?: string | null
  edited_from_id?: string | null
  recurring_id?: string | null
}
