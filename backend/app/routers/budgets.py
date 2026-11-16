import uuid
from datetime import date

from fastapi import APIRouter, Response
from sqlalchemy import select

from app import audit
from app.deps import DB, CurrentUser
from app.errors import LedgerError, NotFoundError
from app.models import AccountType, Budget, utcnow
from app.schemas import BudgetLineOut, BudgetOut, BudgetUpsert
from app.services import ledger, reports

router = APIRouter(prefix="/budgets", tags=["budgets"])


@router.get("", response_model=list[BudgetLineOut])
def budget_vs_actual(
    db: DB, user: CurrentUser, month: date | None = None
) -> list[reports.BudgetLine]:
    return reports.budget_report(db, user, month=month or date.today())


@router.put("", response_model=BudgetOut)
def upsert_budget(body: BudgetUpsert, db: DB, user: CurrentUser) -> Budget:
    """Create or replace the budget for one expense category in one month."""
    account = ledger.get_account(db, user, body.account_id)
    if account.type != AccountType.EXPENSE:
        raise LedgerError("Budgets can only be set on expense accounts")
    month = reports.month_start(body.month)
    budget = db.scalar(
        select(Budget).where(
            Budget.user_id == user.id, Budget.account_id == account.id, Budget.month == month
        )
    )
    previous = budget.amount_minor if budget else None
    if budget is None:
        budget = Budget(
            user_id=user.id, account_id=account.id, month=month, amount_minor=body.amount_minor
        )
        db.add(budget)
    else:
        budget.amount_minor = body.amount_minor
        budget.updated_at = utcnow()
    db.flush()
    audit.record(
        db,
        user.id,
        "budget.set",
        "budget",
        budget.id,
        {
            "account_id": str(account.id),
            "month": month.isoformat(),
            "before_minor": previous,
            "after_minor": body.amount_minor,
        },
    )
    db.commit()
    return budget


@router.delete("/{budget_id}", status_code=204)
def delete_budget(budget_id: uuid.UUID, db: DB, user: CurrentUser) -> Response:
    budget = db.get(Budget, budget_id)
    if budget is None or budget.user_id != user.id:
        raise NotFoundError("Budget not found")
    audit.record(
        db,
        user.id,
        "budget.deleted",
        "budget",
        budget.id,
        {"month": budget.month.isoformat(), "amount_minor": budget.amount_minor},
    )
    db.delete(budget)
    db.commit()
    return Response(status_code=204)
