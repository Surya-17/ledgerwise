import uuid

from fastapi import APIRouter, Response
from sqlalchemy import select

from app import audit
from app.deps import DB, CurrentUser
from app.errors import NotFoundError
from app.models import CategoryRule
from app.schemas import RuleCreate, RuleOut
from app.services import ledger

router = APIRouter(prefix="/rules", tags=["rules"])


@router.get("", response_model=list[RuleOut])
def list_rules(db: DB, user: CurrentUser) -> list[CategoryRule]:
    return list(
        db.scalars(
            select(CategoryRule)
            .where(CategoryRule.user_id == user.id)
            .order_by(CategoryRule.priority, CategoryRule.created_at)
        )
    )


@router.post("", response_model=RuleOut, status_code=201)
def create_rule(body: RuleCreate, db: DB, user: CurrentUser) -> CategoryRule:
    ledger.get_account(db, user, body.account_id)
    rule = CategoryRule(
        user_id=user.id, pattern=body.pattern, account_id=body.account_id, priority=body.priority
    )
    db.add(rule)
    db.flush()
    audit.record(
        db, user.id, "rule.created", "category_rule", rule.id, body.model_dump(mode="json")
    )
    db.commit()
    return rule


@router.delete("/{rule_id}", status_code=204)
def delete_rule(rule_id: uuid.UUID, db: DB, user: CurrentUser) -> Response:
    rule = db.get(CategoryRule, rule_id)
    if rule is None or rule.user_id != user.id:
        raise NotFoundError("Rule not found")
    audit.record(
        db,
        user.id,
        "rule.deleted",
        "category_rule",
        rule.id,
        {"pattern": rule.pattern, "account_id": str(rule.account_id)},
    )
    db.delete(rule)
    db.commit()
    return Response(status_code=204)
