"""The database itself refuses to break the ledger, even if application code is bypassed."""

from datetime import date

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.models import AccountType, EntrySource, JournalEntry, JournalLine
from app.services import ledger, reports
from tests.conftest import IS_POSTGRES, make_user

pytestmark = [
    pytest.mark.postgres,
    pytest.mark.skipif(not IS_POSTGRES, reason="needs TEST_DATABASE_URL pointing at PostgreSQL"),
]


def _user_with_entry(db: Session):
    user = make_user(db)
    accounts = {a.name: a for a, _ in reports.account_balances(db, user)}
    entry = ledger.post_entry(
        db,
        user,
        occurred_on=date(2026, 1, 1),
        description="ok",
        lines=[
            ledger.LineInput(accounts["Dining"].id, 100),
            ledger.LineInput(accounts["Uncategorized Income"].id, -100),
        ],
    )
    db.commit()
    return user, accounts, entry


def test_unbalanced_entry_bypassing_service_fails_at_commit(db: Session) -> None:
    user, accounts, _ = _user_with_entry(db)
    entry = JournalEntry(
        user_id=user.id,
        occurred_on=date(2026, 1, 2),
        description="sneaky",
        source=EntrySource.MANUAL,
    )
    entry.lines = [
        JournalLine(
            user_id=user.id,
            line_no=1,
            account_id=accounts["Dining"].id,
            amount_minor=100,
            currency="USD",
        ),
        JournalLine(
            user_id=user.id,
            line_no=2,
            account_id=accounts["Salary"].id,
            amount_minor=-99,
            currency="USD",
        ),
    ]
    db.add(entry)
    db.flush()  # inserts succeed: the check is deferred...
    with pytest.raises(DBAPIError, match="does not balance"):
        db.commit()  # ...to commit time
    db.rollback()


def test_ledger_rows_cannot_be_updated_or_deleted(db: Session) -> None:
    _, _, entry = _user_with_entry(db)
    for sql in (
        "UPDATE journal_lines SET amount_minor = amount_minor * 2 WHERE entry_id = :id",
        "DELETE FROM journal_lines WHERE entry_id = :id",
        "UPDATE journal_entries SET description = 'edited' WHERE id = :id",
        "DELETE FROM audit_log",
    ):
        with pytest.raises(DBAPIError, match="append-only"):
            db.execute(text(sql), {"id": entry.id})
        db.rollback()


def test_line_cannot_point_at_another_users_account(db: Session) -> None:
    user, _, _ = _user_with_entry(db)
    stranger = make_user(db)
    their_account = ledger.create_account(
        db, stranger, name="Theirs", account_type=AccountType.ASSET, currency="USD"
    )
    db.commit()

    entry = JournalEntry(
        user_id=user.id, occurred_on=date(2026, 1, 3), description="x", source=EntrySource.MANUAL
    )
    entry.lines = [
        JournalLine(
            user_id=user.id, line_no=1, account_id=their_account.id, amount_minor=1, currency="USD"
        ),
        JournalLine(
            user_id=user.id, line_no=2, account_id=their_account.id, amount_minor=-1, currency="USD"
        ),
    ]
    db.add(entry)
    with pytest.raises(DBAPIError, match="foreign key"):
        db.flush()  # composite FK (account_id, user_id, currency) rejects it
    db.rollback()
