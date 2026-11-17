"""API contracts. Money is always an integer `*_minor` field plus a currency code."""

import uuid
from datetime import date, datetime
from typing import Annotated, Any, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    EmailStr,
    Field,
    StringConstraints,
    field_validator,
)

from app.models import AccountType, EntrySource
from app.money import CURRENCY_EXPONENTS, MAX_ABS_MINOR


def _check_currency(value: str) -> str:
    if value not in CURRENCY_EXPONENTS:
        raise ValueError(f"Unsupported currency; use one of {', '.join(CURRENCY_EXPONENTS)}")
    return value


Currency = Annotated[
    str,
    BeforeValidator(lambda v: v.upper() if isinstance(v, str) else v),
    AfterValidator(_check_currency),
]
MinorAmount = Annotated[int, Field(ge=-MAX_ABS_MINOR, le=MAX_ABS_MINOR)]
PositiveMinorAmount = Annotated[int, Field(gt=0, le=MAX_ABS_MINOR)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --- Auth -----------------------------------------------------------------------------


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    base_currency: Currency = "USD"

    @field_validator("password")
    @classmethod
    def _bcrypt_limit(cls, value: str) -> str:
        if len(value.encode()) > 72:
            raise ValueError("Password must be at most 72 bytes")
        return value


class UserOut(ORM):
    id: uuid.UUID
    email: str
    base_currency: str


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


# --- Accounts -------------------------------------------------------------------------


class AccountCreate(BaseModel):
    name: Name
    type: AccountType
    currency: Currency | None = None  # defaults to the user's base currency
    opening_balance_minor: MinorAmount = 0
    opening_date: date | None = None


class AccountUpdate(BaseModel):
    name: Name | None = None
    is_archived: bool | None = None


class AccountOut(ORM):
    id: uuid.UUID
    name: str
    type: AccountType
    currency: str
    is_archived: bool
    kind: str | None = None
    balance_minor: int = 0


# --- Entries --------------------------------------------------------------------------


class LineIn(BaseModel):
    account_id: uuid.UUID
    amount_minor: MinorAmount
    memo: Annotated[str, StringConstraints(max_length=500)] | None = None

    @field_validator("amount_minor")
    @classmethod
    def _nonzero(cls, value: int) -> int:
        if value == 0:
            raise ValueError("Line amounts must be non-zero")
        return value


class EntryCreate(BaseModel):
    occurred_on: date
    description: Text
    lines: list[LineIn] = Field(min_length=2, max_length=50)


class LineOut(ORM):
    id: uuid.UUID
    line_no: int
    account_id: uuid.UUID
    amount_minor: int
    currency: str
    memo: str | None


class EntryOut(ORM):
    id: uuid.UUID
    occurred_on: date
    description: str
    source: EntrySource
    reverses_id: uuid.UUID | None
    import_batch_id: uuid.UUID | None
    is_reversed: bool = False
    created_at: datetime
    lines: list[LineOut]


class ReverseRequest(BaseModel):
    occurred_on: date | None = None
    reason: Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)] | None = None


class RecategorizeRequest(BaseModel):
    from_account_id: uuid.UUID
    to_account_id: uuid.UUID


# --- Imports, rules, budgets ----------------------------------------------------------


class ImportOut(ORM):
    id: uuid.UUID
    account_id: uuid.UUID
    filename: str
    row_count: int
    imported_count: int
    duplicate_count: int
    skipped_count: int
    transfer_count: int = 0
    created_at: datetime


class RuleCreate(BaseModel):
    pattern: Name
    account_id: uuid.UUID
    priority: int = Field(default=100, ge=0, le=1000)


class RuleOut(ORM):
    id: uuid.UUID
    pattern: str
    account_id: uuid.UUID
    priority: int


class BudgetUpsert(BaseModel):
    account_id: uuid.UUID
    month: date
    amount_minor: PositiveMinorAmount


class BudgetOut(ORM):
    id: uuid.UUID
    account_id: uuid.UUID
    month: date
    amount_minor: int


# --- Reports & audit ------------------------------------------------------------------


class BudgetLineOut(BaseModel):
    budget_id: str
    account_id: str
    account_name: str
    currency: str
    budget_minor: int
    spent_minor: int
    remaining_minor: int


class CashFlowPointOut(BaseModel):
    month: str
    income_minor: int
    expense_minor: int
    net_minor: int


class NetWorthPointOut(BaseModel):
    month: str
    net_worth_minor: int


class CategorySpendOut(BaseModel):
    account_id: str
    account_name: str
    currency: str
    spent_minor: int


class RecurringOut(BaseModel):
    key: str
    name: str
    direction: str
    category_id: str
    category_name: str
    currency: str
    cadence: str
    period_days: int
    amount_minor: int
    fixed_amount: bool
    occurrences: int
    first_date: date
    last_date: date
    next_date: date
    status: str
    monthly_minor: int


class AuditEventOut(ORM):
    id: uuid.UUID
    action: str
    entity_type: str
    entity_id: str
    details: dict[str, Any]
    created_at: datetime


# --- Shared expenses ------------------------------------------------------------------


class FriendCreate(BaseModel):
    name: Name


class GroupIn(BaseModel):
    name: Name | None = None
    member_ids: list[uuid.UUID] | None = Field(default=None, max_length=50)


class GroupOut(BaseModel):
    id: uuid.UUID
    name: str
    member_ids: list[uuid.UUID]
    # Per friend, from this group's bills only: + they owe you, - you owe them.
    balances: dict[str, int]
    total_spent_minor: int


class ParticipantIn(BaseModel):
    account_id: uuid.UUID | None = None  # omit or null for yourself
    weight: int | None = Field(default=None, ge=1, le=1000)
    amount_minor: int | None = Field(default=None, ge=0, le=MAX_ABS_MINOR)


class SharedExpenseCreate(BaseModel):
    occurred_on: date
    description: Text
    total_minor: PositiveMinorAmount
    category_id: uuid.UUID
    payer_id: uuid.UUID | None = None  # null = you paid
    paid_from_id: uuid.UUID | None = None  # required when you paid
    group_id: uuid.UUID | None = None
    method: Literal["equal", "exact", "shares"] = "equal"
    participants: list[ParticipantIn] = Field(min_length=1, max_length=50)


class BillTextIn(BaseModel):
    text: str = Field(min_length=1, max_length=1000)


class SettlementCreate(BaseModel):
    friend_id: uuid.UUID
    account_id: uuid.UUID
    amount_minor: PositiveMinorAmount
    direction: Literal["they_paid", "you_paid"]
    occurred_on: date
    group_id: uuid.UUID | None = None


class ShareOut(BaseModel):
    account_id: uuid.UUID | None
    amount_minor: int


class SharedOut(BaseModel):
    id: uuid.UUID
    entry_id: uuid.UUID
    group_id: uuid.UUID | None
    kind: str
    payer_account_id: uuid.UUID | None
    total_minor: int
    currency: str
    method: str | None
    shares: list[ShareOut]
    occurred_on: date
    description: str
    category_id: uuid.UUID | None
    my_share_minor: int
    is_reversed: bool
    created_at: datetime
