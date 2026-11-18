// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, SharedBill } from '../lib/types'
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
const editSharedExpense = vi.fn()
vi.mock('../lib/api', () => ({
  api: {
    accounts: () => Promise.resolve(accounts),
    friends: () => Promise.resolve(FRIENDS),
    createSharedExpense: (...a: unknown[]) => createSharedExpense(...a),
    parseBill: (...a: unknown[]) => parseBill(...a),
    editSharedExpense: (...a: unknown[]) => editSharedExpense(...a),
  },
  newIdempotencyKey: () => 'k',
}))

function renderModal(editing: SharedBill | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <SplitBillModal open onClose={() => {}} groups={[]} editing={editing} />
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
  editSharedExpense.mockReset()
  editSharedExpense.mockResolvedValue({})
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

describe('SplitBillModal other methods', () => {
  it('splits by percentage and only saves at 100%', async () => {
    const user = renderModal()
    await screen.findByLabelText('Include Sravya')
    await screen.findByRole('option', { name: 'Checking' })
    await user.type(screen.getByPlaceholderText("Dinner at Joe's"), 'Concert')
    await user.type(screen.getAllByPlaceholderText('0.00')[0], '200')
    await user.click(screen.getByLabelText('Include Akhil'))
    await user.click(screen.getByRole('radio', { name: 'By percentage' }))
    await user.type(screen.getByLabelText('Percent for You'), '62.5')
    expect(screen.getByRole('status').textContent).toContain('37.5% left')
    expect(screen.getByText('Percentages need to add up to 100%')).toBeTruthy()
    await user.type(screen.getByLabelText('Percent for Akhil'), '37.5')
    expect(screen.getByTestId('share-Akhil').textContent).toBe('$75.00')
    await user.click(screen.getByRole('button', { name: 'Save bill' }))
    await waitFor(() => expect(createSharedExpense).toHaveBeenCalledTimes(1))
    const body = createSharedExpense.mock.calls[0][0]
    expect(body.method).toBe('percent')
    expect(body.participants).toEqual([
      { account_id: null, percent_bp: 6250 },
      { account_id: 'a', percent_bp: 3750 },
    ])
  })

  it('builds an itemized receipt with tax and tip, total from the items', async () => {
    const user = renderModal()
    await screen.findByLabelText('Include Sravya')
    await screen.findByRole('option', { name: 'Checking' })
    await user.type(screen.getByPlaceholderText("Dinner at Joe's"), 'Tacos')
    await user.click(screen.getByLabelText('Include Manasa'))
    await user.click(screen.getByRole('radio', { name: 'Itemized receipt' }))
    await user.type(screen.getByLabelText('Item 1 name'), 'Burrito')
    await user.type(screen.getByLabelText('Item 1 price'), '12')
    await user.click(screen.getByRole('button', { name: 'Add item' }))
    await user.type(screen.getByLabelText('Item 2 price'), '9')
    await user.click(screen.getByLabelText('You had item 2'))
    await user.type(screen.getByLabelText('Tax, tip & fees'), '4.20')
    expect(screen.getByTestId('share-You').textContent).toBe('$7.20')
    expect(screen.getByTestId('share-Manasa').textContent).toBe('$18.00')
    await user.click(screen.getByRole('button', { name: 'Save bill' }))
    await waitFor(() => expect(createSharedExpense).toHaveBeenCalledTimes(1))
    const body = createSharedExpense.mock.calls[0][0]
    expect(body).toMatchObject({ method: 'itemized', total_minor: 2520, extras_minor: 420 })
    expect(body.items).toEqual([
      { name: 'Burrito', amount_minor: 1200, account_ids: [null, 'm'] },
      { name: 'Item 2', amount_minor: 900, account_ids: ['m'] },
    ])
  })

  it('reopens a bill exactly as typed and saves the edit, not a new bill', async () => {
    const bill: SharedBill = {
      id: 'bill1',
      entry_id: 'e1',
      group_id: null,
      kind: 'expense',
      payer_account_id: null,
      total_minor: 9000,
      currency: 'USD',
      method: 'shares',
      shares: [
        { account_id: null, amount_minor: 3000 },
        { account_id: 's', amount_minor: 6000 },
      ],
      occurred_on: '2026-11-01',
      description: 'Groceries',
      category_id: 'din',
      my_share_minor: 3000,
      is_reversed: false,
      created_at: '',
      notes: 'Costco run',
      paid_from_id: 'chk',
      details: { participants: [{ account_id: null, weight: 1 }, { account_id: 's', weight: 2 }] },
    }
    const user = renderModal(bill)
    expect(await screen.findByText('Edit bill')).toBeTruthy()
    await screen.findByRole('option', { name: 'Checking' })
    expect((screen.getByLabelText('Shares for Sravya') as HTMLInputElement).value).toBe('2')
    expect((screen.getByDisplayValue('Costco run') as HTMLInputElement).value).toBe('Costco run')
    expect(screen.queryByText('Repeat')).toBeNull() // repeating is set up when adding, not editing
    const total = screen.getAllByPlaceholderText('0.00')[0]
    await user.clear(total)
    await user.type(total, '120')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(editSharedExpense).toHaveBeenCalledTimes(1))
    expect(createSharedExpense).not.toHaveBeenCalled()
    const [id, body] = editSharedExpense.mock.calls[0]
    expect(id).toBe('bill1')
    expect(body).toMatchObject({ total_minor: 12000, method: 'shares', notes: 'Costco run', occurred_on: '2026-11-01' })
    expect(body.participants).toEqual([
      { account_id: null, weight: 1 },
      { account_id: 's', weight: 2 },
    ])
  })
})
