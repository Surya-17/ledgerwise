"""Detect recurring income and charges (subscriptions, bills, paychecks) from ledger history.

Approach, deliberately simple and explainable:

1. Take every live entry (not reversed, not itself a reversal) that touches exactly one
   income or expense category, so transfers between your own accounts are excluded.
2. Group by a normalized merchant key ("NETFLIX.COM 8845" and "Netflix.com" collide) and
   by direction (money in vs. out).
3. A group is recurring when it has at least MIN_OCCURRENCES and the gaps between
   consecutive dates fit one cadence: at least 75% of gaps within that cadence's
   tolerance of the median gap.
4. The amount is the median charge. It's "fixed" when every charge is within 5% of the
   median, otherwise "variable" (utilities, groceries).
5. Status: "active" if the next expected date has not passed by more than half a period,
   otherwise "lapsed" (likely cancelled), which is useful for spotting dead subscriptions.

Money stays in integer minor units throughout; the only division is the monthly-cost
estimate, done with integer rounding.
"""

from __future__ import annotations

import re
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from fractions import Fraction
from itertools import pairwise

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models import Account, AccountType, EntrySource, JournalEntry, User

MIN_OCCURRENCES = 3
LOOKBACK_DAYS = 400


@dataclass(frozen=True)
class Cadence:
    name: str
    typical_days: int
    tolerance_days: int
    per_month: Fraction  # occurrences per month, for the monthly estimate
    months: int = 0  # calendar step for the next date; 0 = step by the median gap


# Checked in order; biweekly (every 14 days) before semimonthly (1st and 15th).
CADENCES: list[Cadence] = [
    Cadence("weekly", 7, 1, Fraction(52, 12)),
    Cadence("biweekly", 14, 1, Fraction(26, 12)),
    Cadence("semimonthly", 15, 3, Fraction(2)),
    Cadence("monthly", 30, 4, Fraction(1), months=1),
    Cadence("quarterly", 91, 8, Fraction(1, 3), months=3),
    Cadence("yearly", 365, 12, Fraction(1, 12), months=12),
]

_NOISE = re.compile(r"[#*]\S*|\b\d[\d\-/.]*\b|[^\w\s&']")


def merchant_key(description: str) -> str:
    """'WHOLE FOODS MARKET #1042' -> 'whole foods market'; 'Shell Oil 5543' -> 'shell oil'."""
    text = _NOISE.sub(" ", description.lower())
    return " ".join(text.split())


@dataclass
class RecurringSeries:
    key: str
    name: str  # most recent description, as the bank printed it
    direction: str  # "in" | "out"
    category_id: str
    category_name: str
    currency: str
    cadence: str
    period_days: int
    amount_minor: int  # median, always positive
    fixed_amount: bool
    occurrences: int
    first_date: date
    last_date: date
    next_date: date
    status: str  # "active" | "lapsed"
    monthly_minor: int  # estimated cost (or income) per month


def _classify(gaps: list[int]) -> Cadence | None:
    median_gap = statistics.median(gaps)
    for cadence in CADENCES:
        if abs(median_gap - cadence.typical_days) > cadence.tolerance_days:
            continue
        fitting = sum(1 for g in gaps if abs(g - cadence.typical_days) <= cadence.tolerance_days)
        if fitting / len(gaps) >= 0.75:
            return cadence
    return None


def _monthly(amount_minor: int, cadence: Cadence) -> int:
    """Exact rational arithmetic, rounded half up once at the end."""
    return int(amount_minor * cadence.per_month + Fraction(1, 2))


def _add_months(d: date, months: int) -> date:
    """Same day of month, clamped (Jan 31 + 1 month = Feb 28/29)."""
    index = d.year * 12 + (d.month - 1) + months
    year, month = divmod(index, 12)
    month += 1
    next_first = date(year + (month == 12), month % 12 + 1, 1)
    return date(year, month, min(d.day, (next_first - timedelta(days=1)).day))


def detect_recurring(
    db: Session, user: User, *, today: date | None = None
) -> list[RecurringSeries]:
    today = today or date.today()
    categories = {
        a.id: a
        for a in db.scalars(
            select(Account).where(
                Account.user_id == user.id,
                Account.type.in_([AccountType.INCOME, AccountType.EXPENSE]),
            )
        )
    }
    reversed_ids = select(JournalEntry.reverses_id).where(
        JournalEntry.user_id == user.id, JournalEntry.reverses_id.is_not(None)
    )
    entries = db.scalars(
        select(JournalEntry)
        .options(selectinload(JournalEntry.lines))
        .where(
            JournalEntry.user_id == user.id,
            JournalEntry.source != EntrySource.REVERSAL,
            JournalEntry.id.not_in(reversed_ids),
            JournalEntry.occurred_on >= today - timedelta(days=LOOKBACK_DAYS),
            JournalEntry.occurred_on <= today,
        )
        .order_by(JournalEntry.occurred_on)
    ).all()

    groups: dict[tuple[str, str, str], list[tuple[JournalEntry, Account, int]]] = defaultdict(list)
    for entry in entries:
        cat_lines = [ln for ln in entry.lines if ln.account_id in categories]
        if len(cat_lines) != 1:
            continue  # transfers (none) or splits (several)
        line = cat_lines[0]
        account = categories[line.account_id]
        # Expense lines are debits (+), income lines are credits (-).
        direction = "out" if account.type == AccountType.EXPENSE else "in"
        amount = abs(line.amount_minor)
        key = merchant_key(entry.description)
        if key:
            groups[(key, direction, line.currency)].append((entry, account, amount))

    out: list[RecurringSeries] = []
    for (key, direction, currency), items in groups.items():
        # Several charges on one day (two coffees) count once for cadence purposes.
        by_day: dict[date, int] = {}
        for entry, _, amount in items:
            by_day[entry.occurred_on] = by_day.get(entry.occurred_on, 0) + amount
        days = sorted(by_day)
        if len(days) < MIN_OCCURRENCES:
            continue
        gaps = [(b - a).days for a, b in pairwise(days)]
        cadence = _classify(gaps)
        if cadence is None:
            continue
        period = round(statistics.median(gaps))

        amounts = [by_day[d] for d in days]
        median_amount = int(statistics.median_low(amounts))
        fixed = all(abs(a - median_amount) * 20 <= median_amount for a in amounts)

        last = days[-1]
        if cadence.months:
            next_date = _add_months(last, cadence.months)
        elif cadence.name == "semimonthly":
            # Paid on two fixed days a month: the next one is a month after the one before last.
            next_date = _add_months(days[-2], 1)
        else:
            next_date = last + timedelta(days=period)
        lapsed = today > next_date + timedelta(days=max(3, period // 2))
        category = Counter(acct.id for _, acct, _ in items).most_common(1)[0][0]
        latest_entry = max(items, key=lambda t: (t[0].occurred_on, t[0].created_at))[0]

        out.append(
            RecurringSeries(
                key=key,
                name=latest_entry.description,
                direction=direction,
                category_id=str(category),
                category_name=categories[category].name,
                currency=currency,
                cadence=cadence.name,
                period_days=period,
                amount_minor=median_amount,
                fixed_amount=fixed,
                occurrences=len(days),
                first_date=days[0],
                last_date=last,
                next_date=next_date,
                status="lapsed" if lapsed else "active",
                monthly_minor=_monthly(median_amount, cadence),
            )
        )
    out.sort(key=lambda s: (s.status != "active", s.direction != "out", -s.monthly_minor))
    return out
