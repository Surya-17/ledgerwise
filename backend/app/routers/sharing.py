"""Friends, groups and split bills (see app/services/sharing.py for the accounting)."""

import uuid
from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Query, Response
from fastapi.responses import JSONResponse
from sqlalchemy import or_, select
from sqlalchemy.orm import selectinload

from app.deps import DB, CurrentUser, IdempotencyKey
from app.errors import LedgerError
from app.models import (
    Account,
    AccountType,
    FriendGroup,
    JournalEntry,
    SharedEntry,
    SharedRecurring,
    User,
)
from app.ratelimit import SlidingWindowLimiter
from app.schemas import (
    AccountOut,
    BillTextIn,
    FriendCreate,
    GroupIn,
    GroupOut,
    GroupSummaryOut,
    RecurringBillOut,
    SettlementCreate,
    SharedExpenseCreate,
    SharedOut,
)
from app.services import bill_parser, ledger, reports, sharing
from app.services.idempotency import run_idempotent

router = APIRouter(tags=["sharing"])


# --- Friends --------------------------------------------------------------------------


@router.get("/friends", response_model=list[AccountOut])
def list_friends(db: DB, user: CurrentUser, include_archived: bool = False) -> list[AccountOut]:
    """Friends with their running balance: + they owe you, - you owe them."""
    rows = reports.account_balances(db, user, include_archived=include_archived)
    return [
        AccountOut.model_validate(a).model_copy(update={"balance_minor": b})
        for a, b in rows
        if a.kind == sharing.FRIEND
    ]


@router.post("/friends", response_model=AccountOut, status_code=201)
def create_friend(body: FriendCreate, db: DB, user: CurrentUser) -> AccountOut:
    friend = sharing.create_friend(db, user, body.name)
    db.commit()
    return AccountOut.model_validate(friend)


# --- Groups ---------------------------------------------------------------------------


def _group_out(db: DB, user: User, group: FriendGroup) -> GroupOut:
    return GroupOut(
        id=group.id,
        name=group.name,
        member_ids=[m.account_id for m in group.members],
        balances={str(k): v for k, v in sharing.group_balances(db, user, group.id).items()},
        total_spent_minor=sharing.group_spend(db, user, group.id),
    )


@router.get("/groups", response_model=list[GroupOut])
def list_groups(db: DB, user: CurrentUser) -> list[GroupOut]:
    groups = db.scalars(
        select(FriendGroup)
        .options(selectinload(FriendGroup.members))
        .where(FriendGroup.user_id == user.id)
        .order_by(FriendGroup.name)
    ).all()
    return [_group_out(db, user, g) for g in groups]


@router.post("/groups", response_model=GroupOut, status_code=201)
def create_group(body: GroupIn, db: DB, user: CurrentUser) -> GroupOut:
    if not body.name:
        raise LedgerError("Give the group a name")
    group = sharing.set_group(db, user, None, name=body.name, member_ids=body.member_ids or [])
    db.commit()
    return _group_out(db, user, group)


@router.patch("/groups/{group_id}", response_model=GroupOut)
def update_group(group_id: uuid.UUID, body: GroupIn, db: DB, user: CurrentUser) -> GroupOut:
    group = sharing.get_group(db, user, group_id)
    sharing.set_group(db, user, group, name=body.name, member_ids=body.member_ids)
    db.commit()
    return _group_out(db, user, group)


@router.delete("/groups/{group_id}", status_code=204)
def delete_group(group_id: uuid.UUID, db: DB, user: CurrentUser) -> Response:
    sharing.delete_group(db, user, sharing.get_group(db, user, group_id))
    db.commit()
    return Response(status_code=204)


# --- Shared bills ---------------------------------------------------------------------


def _shared_out(
    shared: SharedEntry, entry: JournalEntry, types: dict[uuid.UUID, AccountType], reversed_: bool
) -> dict[str, Any]:
    category = next(
        (ln.account_id for ln in entry.lines if types.get(ln.account_id) == AccountType.EXPENSE),
        None,
    )
    my_share = next((s["amount_minor"] for s in shared.shares if s["account_id"] is None), 0)
    paid_from = None
    if shared.kind == "expense" and shared.payer_account_id is None:
        paid_from = next(
            (
                ln.account_id
                for ln in entry.lines
                if ln.amount_minor == -shared.total_minor
                and types.get(ln.account_id) in (AccountType.ASSET, AccountType.LIABILITY)
            ),
            None,
        )
    return SharedOut(
        id=shared.id,
        entry_id=entry.id,
        group_id=shared.group_id,
        kind=shared.kind,
        payer_account_id=shared.payer_account_id,
        total_minor=shared.total_minor,
        currency=shared.currency,
        method=shared.method,
        shares=shared.shares,
        occurred_on=entry.occurred_on,
        description=entry.description,
        category_id=category,
        my_share_minor=my_share,
        is_reversed=reversed_,
        created_at=shared.created_at,
        notes=shared.notes,
        details=shared.details,
        paid_from_id=paid_from,
        edited_from_id=shared.edited_from_id,
        recurring_id=shared.recurring_id,
    ).model_dump(mode="json")


def _types(db: DB, user: User) -> dict[uuid.UUID, AccountType]:
    return {
        i: t
        for i, t in db.execute(select(Account.id, Account.type).where(Account.user_id == user.id))
    }


@router.get("/shared", response_model=list[SharedOut])
def list_shared(
    db: DB,
    user: CurrentUser,
    group_id: uuid.UUID | None = None,
    friend_id: uuid.UUID | None = None,
    include_reversed: bool = False,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
) -> list[dict[str, Any]]:
    stmt = (
        select(SharedEntry, JournalEntry)
        .join(JournalEntry, JournalEntry.id == SharedEntry.entry_id)
        .options(selectinload(JournalEntry.lines))
        .where(SharedEntry.user_id == user.id)
    )
    if group_id:
        stmt = stmt.where(SharedEntry.group_id == group_id)
    if friend_id:
        stmt = stmt.where(
            or_(
                SharedEntry.payer_account_id == friend_id,
                JournalEntry.lines.any(account_id=friend_id),
            )
        )
    rows = db.execute(
        stmt.order_by(JournalEntry.occurred_on.desc(), SharedEntry.created_at.desc()).limit(limit)
    ).all()
    reversed_ids = set(
        db.scalars(
            select(JournalEntry.reverses_id).where(
                JournalEntry.reverses_id.in_([e.id for _, e in rows])
            )
        )
    )
    types = _types(db, user)
    return [
        _shared_out(s, e, types, e.id in reversed_ids)
        for s, e in rows
        if include_reversed or e.id not in reversed_ids
    ]


@router.post("/shared/expenses", status_code=201, responses={201: {"model": SharedOut}})
def create_shared_expense(
    body: SharedExpenseCreate, db: DB, user: CurrentUser, idempotency_key: IdempotencyKey = None
) -> JSONResponse:
    """Split a bill. Send an `Idempotency-Key` header to make retries safe."""

    def action() -> dict[str, Any]:
        if body.repeat:
            _, shared = sharing.start_recurring(
                db, user, body=body.template(), first_on=body.occurred_on, cadence=body.repeat
            )
        else:
            shared = sharing.post_shared_expense(
                db, user, occurred_on=body.occurred_on, **sharing.expense_kwargs(body.template())
            )
        entry = db.get(JournalEntry, shared.entry_id)
        return _shared_out(shared, entry, _types(db, user), False)

    payload = {"op": "shared_expense", **body.model_dump(mode="json")}
    return run_idempotent(db, user.id, idempotency_key, payload, action)


@router.put("/shared/expenses/{shared_id}", responses={200: {"model": SharedOut}})
def edit_shared_expense(
    shared_id: uuid.UUID,
    body: SharedExpenseCreate,
    db: DB,
    user: CurrentUser,
    idempotency_key: IdempotencyKey = None,
) -> JSONResponse:
    """Change a bill. The old one is reversed and the new one posted, atomically."""
    if body.repeat:
        raise LedgerError("Set up repeating when you add a bill, not when you edit one")

    def action() -> dict[str, Any]:
        shared = sharing.edit_shared_expense(
            db, user, shared_id, occurred_on=body.occurred_on, body=body.template()
        )
        entry = db.get(JournalEntry, shared.entry_id)
        return _shared_out(shared, entry, _types(db, user), False)

    payload = {"op": "shared_edit", "id": str(shared_id), **body.model_dump(mode="json")}
    return run_idempotent(db, user.id, idempotency_key, payload, action, status_code=200)


@router.post("/shared/settlements", status_code=201, responses={201: {"model": SharedOut}})
def create_settlement(
    body: SettlementCreate, db: DB, user: CurrentUser, idempotency_key: IdempotencyKey = None
) -> JSONResponse:
    """Record a friend paying you back, or you paying them."""

    def action() -> dict[str, Any]:
        shared = sharing.post_settlement(
            db,
            user,
            friend_id=body.friend_id,
            account_id=body.account_id,
            amount_minor=body.amount_minor,
            direction=body.direction,
            occurred_on=body.occurred_on,
            group_id=body.group_id,
        )
        entry = db.get(JournalEntry, shared.entry_id)
        return _shared_out(shared, entry, _types(db, user), False)

    payload = {"op": "settlement", **body.model_dump(mode="json")}
    return run_idempotent(db, user.id, idempotency_key, payload, action)


# --- Describe a bill ------------------------------------------------------------------

# The AI provider's free tier has a small quota; keep one user from using it all.
parse_limiter = SlidingWindowLimiter(30, 600, "Too many bill descriptions; try again shortly")


def _parse_context(db: DB, user: User) -> bill_parser.Context:
    accounts = db.scalars(
        select(Account).where(Account.user_id == user.id, Account.is_archived.is_(False))
    ).all()
    friends = [a for a in accounts if a.kind == sharing.FRIEND]
    groups = db.scalars(
        select(FriendGroup)
        .options(selectinload(FriendGroup.members))
        .where(FriendGroup.user_id == user.id)
    ).all()
    return bill_parser.Context(
        friends=[bill_parser.Named(a.id, a.name) for a in friends],
        groups=[
            (bill_parser.Named(g.id, g.name), [m.account_id for m in g.members]) for g in groups
        ],
        categories=[
            bill_parser.Named(a.id, a.name) for a in accounts if a.type == AccountType.EXPENSE
        ],
        money=[
            bill_parser.Named(a.id, a.name)
            for a in accounts
            if a.kind != sharing.FRIEND
            and a.type in (AccountType.ASSET, AccountType.LIABILITY)
            and not ledger.is_system_account(a)
        ],
        currency=user.base_currency,
        today=date.today(),
    )


@router.post("/shared/parse", response_model=bill_parser.BillDraft)
def parse_bill(body: BillTextIn, db: DB, user: CurrentUser) -> bill_parser.BillDraft:
    """Turn "Dinner $90 with Alex and Sam, I paid" into a draft for the split form.

    Nothing is saved: the client fills the form with the draft for the user to check.
    """
    if bill_parser.ai_enabled():
        parse_limiter.check_and_hit(str(user.id))
    return bill_parser.parse_bill(body.text, _parse_context(db, user))


# --- Repeating bills ------------------------------------------------------------------


@router.get("/shared/recurring", response_model=list[RecurringBillOut])
def list_recurring(db: DB, user: CurrentUser) -> list[SharedRecurring]:
    return list(
        db.scalars(
            select(SharedRecurring)
            .where(SharedRecurring.user_id == user.id, SharedRecurring.is_active.is_(True))
            .order_by(SharedRecurring.next_on)
        )
    )


@router.post("/shared/recurring/run")
def run_recurring(db: DB, user: CurrentUser) -> dict[str, int]:
    """Post every repeating bill that has come due. Safe to call any number of times."""
    posted = sharing.post_due_bills(db, user, date.today())
    db.commit()
    return {"posted": len(posted)}


@router.post("/shared/recurring/{recurring_id}/stop", response_model=RecurringBillOut)
def stop_recurring(recurring_id: uuid.UUID, db: DB, user: CurrentUser) -> SharedRecurring:
    """Stop repeating. Bills already posted stay."""
    rec = sharing.stop_recurring(db, user, recurring_id)
    db.commit()
    return rec


@router.get("/groups/{group_id}/summary", response_model=GroupSummaryOut)
def group_summary(group_id: uuid.UUID, db: DB, user: CurrentUser) -> dict[str, Any]:
    sharing.get_group(db, user, group_id)
    return sharing.group_summary(db, user, group_id)
