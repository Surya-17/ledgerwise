"""Read-side reports computed straight from journal lines (no cached balances to drift)."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date

from sqlalchemy import extract, func, select
from sqlalchemy.orm import Session

from app.models import Account, AccountType, Budget, JournalEntry, JournalLine, User


def month_start(d: date) -> date:
    return d.replace(day=1)


def add_months(d: date, months: int) -> date:
    index = d.year * 12 + (d.month - 1) + months
    return date(index // 12, index % 12 + 1, 1)


def month_range(start: date, end: date) -> list[date]:
    months, current = [], month_start(start)
    while current <= end:
        months.append(current)
        current = add_months(current, 1)
    return months


def account_balances(
    db: Session, user: User, *, as_of: date | None = None, include_archived: bool = True
) -> list[tuple[Account, int]]:
    """Every account with its balance in natural sign (what a person expects to see)."""
    totals = (
        select(JournalLine.account_id, func.sum(JournalLine.amount_minor).label("total"))
        .join(JournalEntry, JournalLine.entry_id == JournalEntry.id)
        .where(JournalLine.user_id == user.id)
        .group_by(JournalLine.account_id)
    )
    if as_of is not None:
        totals = totals.where(JournalEntry.occurred_on <= as_of)
    sub = totals.subquery()

    stmt = (
        select(Account, func.coalesce(sub.c.total, 0))
        .outerjoin(sub, sub.c.account_id == Account.id)
        .where(Account.user_id == user.id)
        .order_by(Account.type, Account.name)
    )
    if not include_archived:
        stmt = stmt.where(Account.is_archived.is_(False))
    # int(): PostgreSQL returns SUM(bigint) as NUMERIC.
    return [(acct, int(raw) * acct.type.normal_sign) for acct, raw in db.execute(stmt)]


def _monthly_raw_totals(
    db: Session,
    user: User,
    currency: str,
    types: list[AccountType],
    start: date,
    end: date,
) -> dict[date, dict[AccountType, int]]:
    year = extract("year", JournalEntry.occurred_on)
    month = extract("month", JournalEntry.occurred_on)
    stmt = (
        select(year, month, Account.type, func.sum(JournalLine.amount_minor))
        .join(JournalEntry, JournalLine.entry_id == JournalEntry.id)
        .join(Account, JournalLine.account_id == Account.id)
        .where(
            JournalLine.user_id == user.id,
            JournalLine.currency == currency,
            Account.type.in_(types),
            JournalEntry.occurred_on >= start,
            JournalEntry.occurred_on <= end,
        )
        .group_by(year, month, Account.type)
    )
    out: dict[date, dict[AccountType, int]] = defaultdict(lambda: defaultdict(int))
    for y, m, account_type, total in db.execute(stmt):
        out[date(int(y), int(m), 1)][account_type] += int(total)
    return out


@dataclass
class CashFlowPoint:
    month: str
    income_minor: int
    expense_minor: int
    net_minor: int


def cash_flow(
    db: Session, user: User, *, currency: str, start: date, end: date
) -> list[CashFlowPoint]:
    raw = _monthly_raw_totals(
        db, user, currency, [AccountType.INCOME, AccountType.EXPENSE], start, end
    )
    points = []
    for m in month_range(start, end):
        income = -raw[m][AccountType.INCOME]  # income is credit-normal
        expense = raw[m][AccountType.EXPENSE]
        points.append(CashFlowPoint(m.strftime("%Y-%m"), income, expense, income - expense))
    return points


@dataclass
class NetWorthPoint:
    month: str
    net_worth_minor: int  # assets minus liabilities at month end


def net_worth(
    db: Session, user: User, *, currency: str, start: date, end: date
) -> list[NetWorthPoint]:
    balance_types = [AccountType.ASSET, AccountType.LIABILITY]
    opening = db.scalar(
        select(func.coalesce(func.sum(JournalLine.amount_minor), 0))
        .join(JournalEntry, JournalLine.entry_id == JournalEntry.id)
        .join(Account, JournalLine.account_id == Account.id)
        .where(
            JournalLine.user_id == user.id,
            JournalLine.currency == currency,
            Account.type.in_(balance_types),
            JournalEntry.occurred_on < start,
        )
    )
    running = int(opening or 0)
    raw = _monthly_raw_totals(db, user, currency, balance_types, start, end)
    points = []
    for m in month_range(start, end):
        # Raw sums already net liabilities (credits) against assets (debits).
        running += sum(raw[m].values())
        points.append(NetWorthPoint(m.strftime("%Y-%m"), running))
    return points


@dataclass
class BudgetLine:
    budget_id: str
    account_id: str
    account_name: str
    currency: str
    budget_minor: int
    spent_minor: int
    remaining_minor: int


def budget_report(db: Session, user: User, *, month: date) -> list[BudgetLine]:
    month = month_start(month)
    next_month = add_months(month, 1)
    budgets = db.execute(
        select(Budget, Account)
        .join(Account, Budget.account_id == Account.id)
        .where(Budget.user_id == user.id, Budget.month == month)
        .order_by(Account.name)
    ).all()
    if not budgets:
        return []

    spent = {
        account_id: total
        for account_id, total in db.execute(
            select(JournalLine.account_id, func.sum(JournalLine.amount_minor))
            .join(JournalEntry, JournalLine.entry_id == JournalEntry.id)
            .where(
                JournalLine.user_id == user.id,
                JournalLine.account_id.in_([b.account_id for b, _ in budgets]),
                JournalEntry.occurred_on >= month,
                JournalEntry.occurred_on < next_month,
            )
            .group_by(JournalLine.account_id)
        )
    }
    lines = []
    for budget, account in budgets:
        used = int(spent.get(account.id, 0))
        lines.append(
            BudgetLine(
                budget_id=str(budget.id),
                account_id=str(account.id),
                account_name=account.name,
                currency=account.currency,
                budget_minor=budget.amount_minor,
                spent_minor=used,
                remaining_minor=budget.amount_minor - used,
            )
        )
    return lines


@dataclass
class CategorySpend:
    account_id: str
    account_name: str
    currency: str
    spent_minor: int


def spending_by_category(db: Session, user: User, *, month: date) -> list[CategorySpend]:
    """Net expense per category for one month (refunds and reversals net out)."""
    month = month_start(month)
    rows = db.execute(
        select(Account, func.sum(JournalLine.amount_minor))
        .join(JournalLine, JournalLine.account_id == Account.id)
        .join(JournalEntry, JournalLine.entry_id == JournalEntry.id)
        .where(
            JournalLine.user_id == user.id,
            Account.type == AccountType.EXPENSE,
            JournalEntry.occurred_on >= month,
            JournalEntry.occurred_on < add_months(month, 1),
        )
        .group_by(Account.id)
    ).all()
    out = [
        CategorySpend(str(a.id), a.name, a.currency, int(total))
        for a, total in rows
        if int(total) != 0
    ]
    return sorted(out, key=lambda c: c.spent_minor, reverse=True)
