import csv
import io
import uuid
from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Query, Response
from fastapi.responses import JSONResponse
from sqlalchemy import Select, select
from sqlalchemy.orm import selectinload

from app.deps import DB, CurrentUser, IdempotencyKey
from app.models import Account, JournalEntry, JournalLine
from app.money import format_minor
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


def _filtered(
    user_id: uuid.UUID,
    account_id: uuid.UUID | None,
    start: date | None,
    end: date | None,
    q: str | None,
) -> Select[tuple[JournalEntry]]:
    stmt = (
        select(JournalEntry)
        .options(selectinload(JournalEntry.lines))
        .where(JournalEntry.user_id == user_id)
    )
    if account_id:
        stmt = stmt.where(
            JournalEntry.id.in_(
                select(JournalLine.entry_id).where(
                    JournalLine.user_id == user_id, JournalLine.account_id == account_id
                )
            )
        )
    if start:
        stmt = stmt.where(JournalEntry.occurred_on >= start)
    if end:
        stmt = stmt.where(JournalEntry.occurred_on <= end)
    if q:
        stmt = stmt.where(JournalEntry.description.ilike(f"%{_escape_like(q)}%", escape="\\"))
    return stmt


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
    stmt = _filtered(user.id, account_id, start, end, q)
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


EXPORT_MAX_ENTRIES = 50_000


@router.get("/export", response_class=Response, responses={200: {"content": {"text/csv": {}}}})
def export_entries(
    db: DB,
    user: CurrentUser,
    account_id: uuid.UUID | None = None,
    start: date | None = None,
    end: date | None = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
) -> Response:
    """Journal export: one row per line, debits and credits in separate columns.

    Amounts are written from integer minor units with exact decimal formatting, so the
    file sums to zero per entry exactly as the ledger does. Cells that a spreadsheet
    would treat as formulas are neutralized (CSV injection).
    """
    names = {
        acct_id: name
        for acct_id, name in db.execute(
            select(Account.id, Account.name).where(Account.user_id == user.id)
        )
    }
    entries = db.scalars(
        _filtered(user.id, account_id, start, end, q)
        .order_by(JournalEntry.occurred_on, JournalEntry.created_at, JournalEntry.id)
        .limit(EXPORT_MAX_ENTRIES)
    ).all()

    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(
        ["date", "entry_id", "description", "source", "account", "debit", "credit", "currency"]
    )
    for e in entries:
        for ln in sorted(e.lines, key=lambda x: x.line_no):
            amount = format_minor(abs(ln.amount_minor), ln.currency)
            writer.writerow(
                [
                    e.occurred_on.isoformat(),
                    str(e.id),
                    _safe_cell(e.description),
                    e.source.value,
                    _safe_cell(names.get(ln.account_id, "")),
                    amount if ln.amount_minor > 0 else "",
                    amount if ln.amount_minor < 0 else "",
                    ln.currency,
                ]
            )
    return Response(
        buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="ledgerwise-journal.csv"'},
    )


def _safe_cell(text: str) -> str:
    # A leading =, +, - or @ makes Excel/Sheets evaluate the cell as a formula.
    return f"'{text}" if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


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
