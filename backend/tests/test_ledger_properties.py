"""Property-based tests: invariants that must hold for *any* sequence of postings.

Hypothesis generates hundreds of random ledgers per test and shrinks any
failure to the smallest example that breaks it.
"""

from collections import defaultdict
from datetime import date

import pytest
from hypothesis import HealthCheck, assume, given, settings
from hypothesis import strategies as st
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.errors import LedgerError
from app.models import AccountType, JournalEntry
from app.services import ledger, reports
from tests.conftest import make_user

PROPERTY_SETTINGS = settings(
    max_examples=60,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)

amounts = st.integers(min_value=-(10**9), max_value=10**9).filter(lambda n: n != 0)


@st.composite
def balanced_entry(draw: st.DrawFn, n_accounts: int) -> list[tuple[int, int]]:
    """A list of (account_index, amount) lines that sums to zero."""
    head = draw(st.lists(amounts, min_size=1, max_size=5))
    last = -sum(head)
    assume(last != 0)
    values = [*head, last]
    idx = draw(st.lists(st.integers(0, n_accounts - 1), min_size=len(values), max_size=len(values)))
    return list(zip(idx, values, strict=True))


def _setup(db: Session):
    user = make_user(db)
    created = [
        ledger.create_account(
            db, user, name=f"Asset {i}", account_type=AccountType.ASSET, currency="USD"
        )
        for i in range(2)
    ] + [
        ledger.create_account(
            db, user, name="Card", account_type=AccountType.LIABILITY, currency="USD"
        )
    ]
    defaults = [a for a, _ in reports.account_balances(db, user) if a.currency == "USD"]
    pool = {a.id: a for a in [*created, *defaults]}
    return user, list(pool.values())


@PROPERTY_SETTINGS
@given(data=st.data())
def test_accounting_equation_always_holds(
    session_factory: sessionmaker[Session], data: st.DataObject
) -> None:
    with session_factory() as db:
        user, accounts = _setup(db)
        entries = data.draw(st.lists(balanced_entry(len(accounts)), min_size=1, max_size=15))
        for lines in entries:
            ledger.post_entry(
                db,
                user,
                occurred_on=date(2026, 1, 1),
                description="generated",
                lines=[ledger.LineInput(accounts[i].id, amt) for i, amt in lines],
            )

        by_type: dict[AccountType, int] = defaultdict(int)
        for account, balance in reports.account_balances(db, user):
            by_type[account.type] += balance

        # Assets + Expenses == Liabilities + Equity + Income
        assert by_type[AccountType.ASSET] + by_type[AccountType.EXPENSE] == (
            by_type[AccountType.LIABILITY]
            + by_type[AccountType.EQUITY]
            + by_type[AccountType.INCOME]
        )
        db.rollback()


@PROPERTY_SETTINGS
@given(data=st.data())
def test_unbalanced_entries_are_always_rejected(
    session_factory: sessionmaker[Session], data: st.DataObject
) -> None:
    with session_factory() as db:
        user, accounts = _setup(db)
        lines = data.draw(balanced_entry(len(accounts)))
        nudge = data.draw(amounts)
        account_idx, amount = lines[0]
        assume(amount + nudge != 0)
        lines[0] = (account_idx, amount + nudge)

        before = db.scalar(select(func.count()).select_from(JournalEntry))
        with pytest.raises(LedgerError, match="does not balance"):
            ledger.post_entry(
                db,
                user,
                occurred_on=date(2026, 1, 1),
                description="unbalanced",
                lines=[ledger.LineInput(accounts[i].id, amt) for i, amt in lines],
            )
        assert db.scalar(select(func.count()).select_from(JournalEntry)) == before
        db.rollback()


@PROPERTY_SETTINGS
@given(data=st.data())
def test_reversing_everything_returns_all_balances_to_zero(
    session_factory: sessionmaker[Session], data: st.DataObject
) -> None:
    with session_factory() as db:
        user, accounts = _setup(db)
        entries = data.draw(st.lists(balanced_entry(len(accounts)), min_size=1, max_size=10))
        posted = [
            ledger.post_entry(
                db,
                user,
                occurred_on=date(2026, 2, 1),
                description="generated",
                lines=[ledger.LineInput(accounts[i].id, amt) for i, amt in lines],
            )
            for lines in entries
        ]
        for entry in posted:
            ledger.reverse_entry(db, user, entry.id)

        assert all(balance == 0 for _, balance in reports.account_balances(db, user))
        db.rollback()
