// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account } from '../lib/types'
import { SplitBillModal } from './sharing'
import { ToastProvider } from './ui'

const acct = (id: string, name: string, type: Account['type'], kind: string | null = null): Account => ({
  id,
  name,
  type,
  kind,
  currency: 'USD',
  is_archived: false,
  balance_minor: 0,
})
const FRIENDS = [acct('a', 'Akhil', 'asset', 'friend'), acct('m', 'Manasa', 'asset', 'friend'), acct('s', 'Sravya', 'asset', 'friend')]
let accounts: Account[] = []

const createSharedExpense = vi.fn()
const parseBill = vi.fn()
vi.mock('../lib/api', () => ({
  api: {
    accounts: () => Promise.resolve(accounts),
    friends: () => Promise.resolve(FRIENDS),
    createSharedExpense: (...a: unknown[]) => createSharedExpense(...a),
    parseBill: (...a: unknown[]) => parseBill(...a),
  },
  newIdempotencyKey: () => 'k',
}))

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <SplitBillModal open onClose={() => {}} groups={[]} />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
  return userEvent.setup()
}

beforeEach(() => {
  accounts = [acct('chk', 'Checking', 'asset'), acct('din', 'Dining', 'expense'), ...FRIENDS]
  createSharedExpense.mockReset()
  createSharedExpense.mockResolvedValue({})
})
afterEach(cleanup)

describe('SplitBillModal exact amounts', () => {
  it('shows what is left to assign, treats blanks as $0, and saves once it adds up', async () => {
    const user = renderModal()
    await screen.findByLabelText('Include Sravya')
    await screen.findByRole('option', { name: 'Checking' })
    await user.type(screen.getByPlaceholderText("Dinner at Joe's"), 'Dinner')
    await user.type(screen.getAllByPlaceholderText('0.00')[0], '69')
    for (const n of ['Akhil', 'Manasa', 'Sravya']) await user.click(screen.getByLabelText(`Include ${n}`))
    await user.click(screen.getByRole('radio', { name: 'Exact amounts' }))
    await user.type(screen.getByLabelText('Amount for You'), '23')
    await user.type(screen.getByLabelText('Amount for Akhil'), '23')
    expect(screen.getByRole('status').textContent).toContain('$23.00 left')
    expect(screen.getByText('Amounts need to add up to the total')).toBeTruthy()
    await user.type(screen.getByLabelText('Amount for Manasa'), '23')
    expect(screen.getByRole('status').textContent).toContain('$69.00 of $69.00 assigned')
    expect(screen.getByRole('status').textContent).toContain('$0.00 left')

    await user.click(screen.getByRole('button', { name: 'Save bill' }))
    await waitFor(() => expect(createSharedExpense).toHaveBeenCalledTimes(1))
    const body = createSharedExpense.mock.calls[0][0]
    expect(body.method).toBe('exact')
    expect(body.participants.map((p: { amount_minor: number }) => p.amount_minor)).toEqual([2300, 2300, 2300, 0])
  })

  it('explains a missing bank account instead of a silent disabled button', async () => {
    accounts = [acct('din', 'Dining', 'expense'), ...FRIENDS]
    renderModal()
    await screen.findByLabelText('Include Sravya')
    expect(await screen.findByText(/No bank account or card yet/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Add one' }).getAttribute('href')).toBe('/accounts')
  })
})

describe('SplitBillModal describe-the-bill', () => {
  it('fills the form from the draft and saves exactly what it shows', async () => {
    parseBill.mockResolvedValue({
      source: 'ai',
      description: 'Groceries',
      total_minor: 6900,
      occurred_on: '2026-11-10',
      payer_id: null,
      paid_from_id: 'chk',
      category_id: 'din',
      group_id: null,
      method: 'exact',
      participants: [
        { account_id: null, weight: null, amount_minor: 2300 },
        { account_id: 's', weight: null, amount_minor: 2300 },
        { account_id: 'm', weight: null, amount_minor: 2300 },
      ],
      notes: ['Not found in your friends or groups: Ravi'],
    })
    const user = renderModal()
    await screen.findByLabelText('Include Sravya')
    await screen.findByRole('option', { name: 'Checking' })
    await user.type(screen.getByLabelText(/Describe the bill/), 'groceries 69, me sravya manasa 23 each, and Ravi{Enter}')
    expect(parseBill).toHaveBeenCalledWith('groceries 69, me sravya manasa 23 each, and Ravi')
    expect(await screen.findByText(/Filled in by AI/)).toBeTruthy()
    expect(screen.getByText('Not found in your friends or groups: Ravi')).toBeTruthy()
    expect((screen.getByPlaceholderText("Dinner at Joe's") as HTMLInputElement).value).toBe('Groceries')
    expect((screen.getByLabelText('Amount for Sravya') as HTMLInputElement).value).toBe('23.00')
    expect(screen.getByLabelText('Include Akhil').getAttribute('aria-checked')).toBe('false')
    expect(createSharedExpense).not.toHaveBeenCalled() // Enter in the describe box never saves

    await user.click(screen.getByRole('button', { name: 'Save bill' }))
    await waitFor(() => expect(createSharedExpense).toHaveBeenCalledTimes(1))
    const body = createSharedExpense.mock.calls[0][0]
    expect(body).toMatchObject({ description: 'Groceries', total_minor: 6900, occurred_on: '2026-11-10', method: 'exact' })
    expect(body.participants).toEqual([
      { account_id: null, amount_minor: 2300 },
      { account_id: 'm', amount_minor: 2300 },
      { account_id: 's', amount_minor: 2300 },
    ])
  })
})
