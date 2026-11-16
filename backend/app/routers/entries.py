import uuid
from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.deps import DB, CurrentUser, IdempotencyKey
from app.models import JournalEntry, JournalLine
from app.schemas import EntryCreate, EntryOut, RecategorizeRequest, ReverseRequest
from app.services import ledger
from app.services.idempotency import run_idempotent

router = APIRouter(prefix="/entries", tags=["entries"])

WRITE_RESPONSES: dict[int | str, dict[str, Any]] = {201: {"model": EntryOut}}


def _dump(entry: JournalEntry, is_reversed: bool = False) -> dict[str, Any]:
    out = EntryOut.model_validate(entry)
    out.is_reversed = is_reversed
    return out.model_dump(mode="json")


def _escape_like(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@router.get("", response_model=list[EntryOut])
def list_entries(
    db: DB,
    user: CurrentUser,
    account_id: uuid.UUID | None = None,
    start: date | None = None,
    end: date | None = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[dict[str, Any]]:
    stmt = (
        select(JournalEntry)
        .options(selectinload(JournalEntry.lines))
        .where(JournalEntry.user_id == user.id)
    )
    if account_id:
        stmt = stmt.where(
            JournalEntry.id.in_(
                select(JournalLine.entry_id).where(
                    JournalLine.user_id == user.id, JournalLine.account_id == account_id
                )
            )
        )
    if start:
        stmt = stmt.where(JournalEntry.occurred_on >= start)
    if end:
        stmt = stmt.where(JournalEntry.occurred_on <= end)
    if q:
        stmt = stmt.where(JournalEntry.description.ilike(f"%{_escape_like(q)}%", escape="\\"))
    stmt = (
        stmt.order_by(
            JournalEntry.occurred_on.desc(), JournalEntry.created_at.desc(), JournalEntry.id
        )
        .limit(limit)
        .offset(offset)
    )

    entries = db.scalars(stmt).all()
    reversed_ids = set(
        db.scalars(
            select(JournalEntry.reverses_id).where(
                JournalEntry.reverses_id.in_([e.id for e in entries])
            )
        )
    )
    return [_dump(e, e.id in reversed_ids) for e in entries]


@router.get("/{entry_id}", response_model=EntryOut)
def get_entry(entry_id: uuid.UUID, db: DB, user: CurrentUser) -> dict[str, Any]:
    entry = ledger.get_entry(db, user, entry_id)
    return _dump(entry, ledger.is_reversed(db, entry.id))


@router.post("", status_code=201, responses=WRITE_RESPONSES)
def create_entry(
    body: EntryCreate, db: DB, user: CurrentUser, idempotency_key: IdempotencyKey = None
) -> JSONResponse:
    """Post a balanced journal entry. Send an `Idempotency-Key` header to make retries safe."""

    def action() -> dict[str, Any]:
        entry = ledger.post_entry(
            db,
            user,
            occurred_on=body.occurred_on,
            description=body.description,
            lines=[ledger.LineInput(ln.account_id, ln.amount_minor, ln.memo) for ln in body.lines],
        )
        return _dump(entry)

    return run_idempotent(
        db, user.id, idempotency_key, {"op": "create_entry", **body.model_dump(mode="json")}, action
    )


@router.post("/{entry_id}/reverse", status_code=201, responses=WRITE_RESPONSES)
def reverse_entry(
    entry_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
    body: ReverseRequest | None = None,
    idempotency_key: IdempotencyKey = None,
) -> JSONResponse:
    body = body or ReverseRequest()

    def action() -> dict[str, Any]:
        reversal = ledger.reverse_entry(
            db, user, entry_id, occurred_on=body.occurred_on, reason=body.reason
        )
        return _dump(reversal)

    payload = {"op": "reverse", "entry_id": str(entry_id), **body.model_dump(mode="json")}
    return run_idempotent(db, user.id, idempotency_key, payload, action)


@router.post("/{entry_id}/recategorize", status_code=201, responses=WRITE_RESPONSES)
def recategorize_entry(
    entry_id: uuid.UUID,
    body: RecategorizeRequest,
    db: DB,
    user: CurrentUser,
    idempotency_key: IdempotencyKey = None,
) -> JSONResponse:
    """Correct an entry's category by reversing it and posting a corrected copy."""

    def action() -> dict[str, Any]:
        corrected = ledger.recategorize_entry(
            db,
            user,
            entry_id,
            from_account_id=body.from_account_id,
            to_account_id=body.to_account_id,
        )
        return _dump(corrected)

    payload = {"op": "recategorize", "entry_id": str(entry_id), **body.model_dump(mode="json")}
    return run_idempotent(db, user.id, idempotency_key, payload, action)
