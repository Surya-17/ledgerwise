import uuid
from datetime import date

from fastapi import APIRouter
from sqlalchemy import select

from app import audit
from app.deps import DB, CurrentUser
from app.errors import ConflictError, LedgerError
from app.models import Account
from app.schemas import AccountCreate, AccountOut, AccountUpdate
from app.services import ledger, reports

router = APIRouter(prefix="/accounts", tags=["accounts"])


def _out(account: Account, balance: int) -> AccountOut:
    return AccountOut.model_validate(account).model_copy(update={"balance_minor": balance})


@router.get("", response_model=list[AccountOut])
def list_accounts(
    db: DB, user: CurrentUser, as_of: date | None = None, include_archived: bool = False
) -> list[AccountOut]:
    rows = reports.account_balances(db, user, as_of=as_of, include_archived=include_archived)
    return [_out(account, balance) for account, balance in rows]


@router.post("", response_model=AccountOut, status_code=201)
def create_account(body: AccountCreate, db: DB, user: CurrentUser) -> AccountOut:
    if body.name.startswith(ledger.SYSTEM_ACCOUNT_PREFIXES):
        raise LedgerError("That name is reserved for a system account")
    account = ledger.create_account(
        db,
        user,
        name=body.name,
        account_type=body.type,
        currency=body.currency or user.base_currency,
        opening_balance_minor=body.opening_balance_minor,
        opening_date=body.opening_date,
    )
    db.commit()
    return _out(account, body.opening_balance_minor)


@router.patch("/{account_id}", response_model=AccountOut)
def update_account(
    account_id: uuid.UUID, body: AccountUpdate, db: DB, user: CurrentUser
) -> AccountOut:
    account = ledger.get_account(db, user, account_id)
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    if changes and ledger.is_system_account(account):
        # The importer and opening balances look these up by name; renaming or hiding
        # one would silently fork it into a duplicate on the next import.
        raise LedgerError(f"'{account.name}' is a system account and can't be renamed or archived")
    if "name" in changes and changes["name"].startswith(ledger.SYSTEM_ACCOUNT_PREFIXES):
        raise LedgerError("That name is reserved for a system account")
    if "name" in changes and changes["name"] != account.name:
        taken = db.scalar(
            select(Account.id).where(Account.user_id == user.id, Account.name == changes["name"])
        )
        if taken:
            raise ConflictError("An account with that name already exists")
    before = {k: getattr(account, k) for k in changes}
    for key, value in changes.items():
        setattr(account, key, value)
    audit.record(
        db, user.id, "account.updated", "account", account.id, {"before": before, "after": changes}
    )
    db.commit()
    balance = next(b for a, b in reports.account_balances(db, user) if a.id == account.id)
    return _out(account, balance)
