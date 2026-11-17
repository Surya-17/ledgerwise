// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account } from '../lib/types'
import { NewTransactionModal } from './NewTransaction'
import { ToastProvider } from './ui'

const acct = (id: string, name: string, type: Account['type']): Account => ({
  id,
  name,
  type,
  currency: 'USD',
  is_archived: false,
  balance_minor: 0,
})

const ACCOUNTS = [
  acct('chk', 'Checking', 'asset'),
  acct('sav', 'Savings', 'asset'),
  acct('groc', 'Groceries', 'expense'),
  acct('home', 'Household', 'expense'),
  acct('pay', 'Salary', 'income'),
]

const createEntry = vi.fn()
vi.mock('../lib/api', () => ({
  api: { accounts: () => Promise.resolve(ACCOUNTS), createEntry: (...a: unknown[]) => createEntry(...a) },
  newIdempotencyKey: () => 'key-1',
}))

function renderModal() {
  const onClose = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <NewTransactionModal open onClose={onClose} />
      </ToastProvider>
    </QueryClientProvider>,
  )
  return { onClose, user: userEvent.setup() }
}

beforeEach(() => {
  createEntry.mockReset()
  createEntry.mockResolvedValue({ id: 'e1' })
})
afterEach(cleanup)

describe('NewTransactionModal', () => {
  it('posts a balanced expense with the idempotency key', async () => {
    const { user, onClose } = renderModal()
    await screen.findByRole('option', { name: 'Groceries' })
    await user.type(screen.getByPlaceholderText('0.00'), '42.50')
    await user.type(screen.getByPlaceholderText('Costco run'), 'Weekly shop')
    await user.click(screen.getByRole('button', { name: 'Post transaction' }))

    await waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1))
    const [body, key] = createEntry.mock.calls[0]
    expect(key).toBe('key-1')
    expect(body.description).toBe('Weekly shop')
    expect(body.lines).toEqual([
      { account_id: 'groc', amount_minor: 4250 },
      { account_id: 'chk', amount_minor: -4250 },
    ])
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('keeps submit disabled until amount and description are valid', async () => {
    const { user } = renderModal()
    await screen.findByRole('option', { name: 'Groceries' })
    const submit = screen.getByRole('button', { name: 'Post transaction' })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    await user.type(screen.getByPlaceholderText('0.00'), '-5')
    await user.type(screen.getByPlaceholderText('Costco run'), 'x')
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Enter a positive amount')).toBeTruthy()
  })

  it('splits one purchase across categories and sums the money-side line', async () => {
    const { user } = renderModal()
    await screen.findByRole('option', { name: 'Groceries' })
    await user.type(screen.getByPlaceholderText('Costco run'), 'Costco run')
    await user.click(screen.getByRole('button', { name: /split across categories/i }))
    await user.type(screen.getByLabelText('Amount 1'), '60')
    await user.type(screen.getByLabelText('Amount 2'), '24.20')
    expect(screen.getAllByText('$84.20').length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: 'Post transaction' }))

    await waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1))
    const lines: { account_id: string; amount_minor: number }[] = createEntry.mock.calls[0][0].lines
    expect(lines.reduce((s, l) => s + l.amount_minor, 0)).toBe(0)
    expect(lines).toContainEqual({ account_id: 'chk', amount_minor: -8420 })
    expect(lines).toContainEqual({ account_id: 'groc', amount_minor: 6000 })
    expect(lines).toContainEqual({ account_id: 'home', amount_minor: 2420 })
  })

  it('removing a split row back to one returns to the simple form, keeping the amount', async () => {
    const { user } = renderModal()
    await screen.findByRole('option', { name: 'Groceries' })
    await user.type(screen.getByPlaceholderText('0.00'), '12')
    await user.click(screen.getByRole('button', { name: /split across categories/i }))
    await user.click(screen.getByLabelText('Remove split 2'))
    expect(screen.queryByLabelText('Amount 1')).toBeNull()
    expect((screen.getByPlaceholderText('0.00') as HTMLInputElement).value).toBe('12')
  })

  it('transfers move money between two balance accounts', async () => {
    const { user } = renderModal()
    await screen.findByRole('option', { name: 'Groceries' })
    await user.click(screen.getByRole('radio', { name: 'Transfer' }))
    expect(screen.queryByRole('button', { name: /split across categories/i })).toBeNull()
    await user.type(screen.getByPlaceholderText('0.00'), '100')
    await user.type(screen.getByPlaceholderText('Move to savings'), 'Save')
    await user.click(screen.getByRole('button', { name: 'Post transaction' }))
    await waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1))
    const lines = createEntry.mock.calls[0][0].lines
    expect(lines).toContainEqual({ account_id: 'sav', amount_minor: 10000 })
    expect(lines).toContainEqual({ account_id: 'chk', amount_minor: -10000 })
  })
})
