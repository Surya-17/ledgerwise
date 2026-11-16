from datetime import date
from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy import select

from app.deps import DB, CurrentUser
from app.models import AuditEvent
from app.schemas import (
    AuditEventOut,
    CashFlowPointOut,
    CategorySpendOut,
    Currency,
    NetWorthPointOut,
    RecurringOut,
)
from app.services import reports
from app.services.recurring import RecurringSeries, detect_recurring

router = APIRouter(tags=["reports"])

Months = Annotated[int, Query(ge=1, le=60)]


def _window(months: int) -> tuple[date, date]:
    today = date.today()
    return reports.add_months(reports.month_start(today), -(months - 1)), today


@router.get("/reports/cash-flow", response_model=list[CashFlowPointOut])
def cash_flow(
    db: DB, user: CurrentUser, months: Months = 12, currency: Currency | None = None
) -> list[reports.CashFlowPoint]:
    start, end = _window(months)
    return reports.cash_flow(
        db, user, currency=currency or user.base_currency, start=start, end=end
    )


@router.get("/reports/net-worth", response_model=list[NetWorthPointOut])
def net_worth(
    db: DB, user: CurrentUser, months: Months = 12, currency: Currency | None = None
) -> list[reports.NetWorthPoint]:
    start, end = _window(months)
    return reports.net_worth(
        db, user, currency=currency or user.base_currency, start=start, end=end
    )


@router.get("/reports/spending", response_model=list[CategorySpendOut])
def spending(db: DB, user: CurrentUser, month: date | None = None) -> list[reports.CategorySpend]:
    return reports.spending_by_category(db, user, month=month or date.today())


@router.get("/reports/recurring", response_model=list[RecurringOut])
def recurring(db: DB, user: CurrentUser) -> list[RecurringSeries]:
    """Subscriptions, bills and paychecks detected from the last ~13 months of entries."""
    return detect_recurring(db, user)


@router.get("/audit", response_model=list[AuditEventOut])
def audit_log(
    db: DB,
    user: CurrentUser,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[AuditEvent]:
    return list(
        db.scalars(
            select(AuditEvent)
            .where(AuditEvent.user_id == user.id)
            .order_by(AuditEvent.created_at.desc(), AuditEvent.id)
            .limit(limit)
            .offset(offset)
        )
    )
