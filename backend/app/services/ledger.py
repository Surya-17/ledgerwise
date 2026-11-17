"""Double-entry ledger operations.

Every change to money goes through `post_entry`, which validates that the entry
balances per currency before anything is written. History is never edited:
`reverse_entry` and `recategorize_entry` post new, offsetting entries.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date

from sqlalchemy import select, update
from sqlalchemy.orm import Session, selectinload

from app import audit
from app.errors import ConflictError, LedgerError, NotFoundError
from app.models import (
    Account,
    AccountType,
    EntrySource,
    JournalEntry,
    JournalLine,
    SharedEntry,
    User,
)

OPENING_BALANCE_EQUITY = "Opening Balance Equity"
UNCATEGORIZED_INCOME = "Uncategorized Income"
UNCATEGORIZED_EXPENSE = "Uncategorized Expense"

DEFAULT_ACCOUNTS: list[tuple[AccountType, str]] = [
    (AccountType.EQUITY, OPENING_BALANCE_EQUITY),
    (AccountType.INCOME, "Salary"),
    (AccountType.INCOME, "Interest"),
    (AccountType.INCOME, UNCATEGORIZED_INCOME),
    (AccountType.EXPENSE, "Groceries"),
    (AccountType.EXPENSE, "Dining"),
    (AccountType.EXPENSE, "Rent"),
    (AccountType.EXPENSE, "Transport"),
    (AccountType.EXPENSE, "Utilities"),
    (AccountType.EXPENSE, "Shopping"),
    (AccountType.EXPENSE, UNCATEGORIZED_EXPENSE),
]


SYSTEM_ACCOUNT_PREFIXES = (OPENING_BALANCE_EQUITY, UNCATEGORIZED_INCOME, UNCATEGORIZED_EXPENSE)


def is_system_account(account: Account) -> bool:
    """Accounts the importer and opening-balance logic find by name (incl. "(EUR)" variants)."""
    return account.name.startswith(SYSTEM_ACCOUNT_PREFIXES)


@dataclass(frozen=True)
class LineInput:
    account_id: uuid.UUID
    amount_minor: int  # positive = debit, negative = credit
    memo: str | None = None


# --- Accounts -------------------------------------------------------------------------


def create_default_accounts(db: Session, user: User) -> None:
    for account_type, name in DEFAULT_ACCOUNTS:
        db.add(Account(user_id=user.id, name=name, type=account_type, currency=user.base_currency))
    db.flush()


def get_account(db: Session, user: User, account_id: uuid.UUID) -> Account:
    account = db.get(Account, account_id)
    if account is None or account.user_id != user.id:
        raise NotFoundError("Account not found")
    return account


def get_or_create_account(
    db: Session, user: User, account_type: AccountType, name: str, currency: str
) -> Account:
    """Find a built-in account (e.g. Uncategorized Expense) for a currency, or create it."""
    if currency != user.base_currency:
        name = f"{name} ({currency})"
    account = db.scalar(select(Account).where(Account.user_id == user.id, Account.name == name))
    if account is None:
        account = Account(user_id=user.id, name=name, type=account_type, currency=currency)
        db.add(account)
        db.flush()
    elif account.type != account_type or account.currency != currency:
        raise LedgerError(f"Account '{name}' exists but is not a {currency} {account_type} account")
    return account


def create_account(
    db: Session,
    user: User,
    *,
    name: str,
    account_type: AccountType,
    currency: str,
    opening_balance_minor: int = 0,
    opening_date: date | None = None,
) -> Account:
    exists = db.scalar(select(Account.id).where(Account.user_id == user.id, Account.name == name))
    if exists:
        raise ConflictError("An account with that name already exists")
    if opening_balance_minor and account_type not in (AccountType.ASSET, AccountType.LIABILITY):
        raise LedgerError("Only asset and liability accounts can have an opening balance")

    account = Account(user_id=user.id, name=name, type=account_type, currency=currency)
    db.add(account)
    db.flush()
    audit.record(
        db,
        user.id,
        "account.created",
        "account",
        account.id,
        {"name": name, "type": account_type.value, "currency": currency},
    )

    if opening_balance_minor:
        # The opening balance is a real entry against equity, so the books balance
        # from day one instead of having an untracked starting number.
        equity = get_or_create_account(
            db, user, AccountType.EQUITY, OPENING_BALANCE_EQUITY, currency
        )
        signed = opening_balance_minor * account_type.normal_sign
        post_entry(
            db,
            user,
            occurred_on=opening_date or date.today(),
            description=f"Opening balance: {name}",
            lines=[LineInput(account.id, signed), LineInput(equity.id, -signed)],
        )
    return account


# --- Entries --------------------------------------------------------------------------


def post_entry(
    db: Session,
    user: User,
    *,
    occurred_on: date,
    description: str,
    lines: list[LineInput],
    source: EntrySource = EntrySource.MANUAL,
    reverses_id: uuid.UUID | None = None,
    import_batch_id: uuid.UUID | None = None,
    import_fingerprint: str | None = None,
    record_audit: bool = True,
) -> JournalEntry:
    """Validate and write a balanced journal entry. Does not commit."""
    if len(lines) < 2:
        raise LedgerError("An entry needs at least two lines")

    account_ids = {line.account_id for line in lines}
    accounts = {
        a.id: a
        for a in db.scalars(
            select(Account).where(Account.user_id == user.id, Account.id.in_(account_ids))
        )
    }
    if missing := account_ids - accounts.keys():
        # Other users' accounts are reported as missing, never as "forbidden".
        raise LedgerError(f"Unknown account(s): {', '.join(sorted(map(str, missing)))}")

    totals: dict[str, int] = defaultdict(int)
    for line in lines:
        account = accounts[line.account_id]
        if line.amount_minor == 0:
            raise LedgerError("Line amounts must be non-zero")
        if account.is_archived and source != EntrySource.REVERSAL:
            raise LedgerError(f"Account '{account.name}' is archived")
        totals[account.currency] += line.amount_minor

    if unbalanced := {cur: total for cur, total in totals.items() if total != 0}:
        detail = ", ".join(f"{cur} off by {total}" for cur, total in sorted(unbalanced.items()))
        raise LedgerError(f"Entry does not balance: debits must equal credits ({detail})")

    entry = JournalEntry(
        user_id=user.id,
        occurred_on=occurred_on,
        description=description,
        source=source,
        reverses_id=reverses_id,
        import_batch_id=import_batch_id,
        import_fingerprint=import_fingerprint,
    )
    entry.lines = [
        JournalLine(
            user_id=user.id,
            line_no=i,
            account_id=line.account_id,
            amount_minor=line.amount_minor,
            currency=accounts[line.account_id].currency,
            memo=line.memo,
        )
        for i, line in enumerate(lines, start=1)
    ]
    db.add(entry)
    db.flush()

    if record_audit:
        audit.record(
            db,
            user.id,
            f"entry.{source.value}",
            "journal_entry",
            entry.id,
            {
                "description": description,
                "occurred_on": occurred_on.isoformat(),
                "reverses_id": str(reverses_id) if reverses_id else None,
                "lines": [
                    {"account_id": str(ln.account_id), "amount_minor": ln.amount_minor}
                    for ln in entry.lines
                ],
            },
        )
    return entry


def get_entry(db: Session, user: User, entry_id: uuid.UUID) -> JournalEntry:
    entry = db.scalar(
        select(JournalEntry)
        .options(selectinload(JournalEntry.lines))
        .where(JournalEntry.id == entry_id, JournalEntry.user_id == user.id)
    )
    if entry is None:
        raise NotFoundError("Entry not found")
    return entry


def is_reversed(db: Session, entry_id: uuid.UUID) -> bool:
    return (
        db.scalar(select(JournalEntry.id).where(JournalEntry.reverses_id == entry_id)) is not None
    )


def reverse_entry(
    db: Session,
    user: User,
    entry_id: uuid.UUID,
    *,
    occurred_on: date | None = None,
    reason: str | None = None,
) -> JournalEntry:
    """Cancel an entry by posting its mirror image. The original stays in history."""
    entry = get_entry(db, user, entry_id)
    if entry.source == EntrySource.REVERSAL:
        raise LedgerError("A reversal cannot itself be reversed; post a new entry instead")
    if is_reversed(db, entry.id):
        raise ConflictError("Entry has already been reversed")

    description = f"Reversal of: {entry.description}"
    if reason:
        description = f"{description} ({reason})"
    return post_entry(
        db,
        user,
        # Default to the original date so historical reports net out correctly.
        occurred_on=occurred_on or entry.occurred_on,
        description=description[:500],
        lines=[LineInput(ln.account_id, -ln.amount_minor, ln.memo) for ln in entry.lines],
        source=EntrySource.REVERSAL,
        reverses_id=entry.id,
    )


def recategorize_entry(
    db: Session,
    user: User,
    entry_id: uuid.UUID,
    *,
    from_account_id: uuid.UUID,
    to_account_id: uuid.UUID,
) -> JournalEntry:
    """Move an entry's lines from one account to another: reverse it, then repost it corrected."""
    if from_account_id == to_account_id:
        raise LedgerError("Source and destination accounts are the same")
    entry = get_entry(db, user, entry_id)
    if not any(ln.account_id == from_account_id for ln in entry.lines):
        raise LedgerError("Entry has no line on the account being moved from")
    get_account(db, user, to_account_id)

    reverse_entry(db, user, entry.id, reason="recategorized")
    corrected = post_entry(
        db,
        user,
        occurred_on=entry.occurred_on,
        description=entry.description,
        lines=[
            LineInput(
                to_account_id if ln.account_id == from_account_id else ln.account_id,
                ln.amount_minor,
                ln.memo,
            )
            for ln in entry.lines
        ],
    )
    # A split bill keeps its split details (who paid, group) on the corrected entry.
    db.execute(
        update(SharedEntry).where(SharedEntry.entry_id == entry.id).values(entry_id=corrected.id)
    )
    return corrected
