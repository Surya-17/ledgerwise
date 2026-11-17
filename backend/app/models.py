"""Database schema.

The core is a double-entry ledger:

    JournalEntry  — one financial event ("Paid rent", "Bought groceries")
    JournalLine   — signed amounts against accounts. Positive = debit, negative = credit.
                    For every entry, the lines in each currency must sum to exactly zero.

Ledger rows are append-only. Mistakes are fixed by posting a reversing entry,
never by editing history. In PostgreSQL this is enforced by triggers (see the
`ledger_guards` migration); the service layer enforces it everywhere.
"""

from __future__ import annotations

import enum
import uuid
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


def _enum(cls: type[enum.Enum], name: str) -> Enum:
    return Enum(
        cls,
        name=name,
        native_enum=False,
        length=16,
        create_constraint=True,
        values_callable=lambda e: [m.value for m in e],
    )


class AccountType(enum.StrEnum):
    ASSET = "asset"
    LIABILITY = "liability"
    EQUITY = "equity"
    INCOME = "income"
    EXPENSE = "expense"

    @property
    def normal_sign(self) -> int:
        """+1 for debit-normal accounts, -1 for credit-normal ones.

        Multiply a raw ledger sum by this to get the balance a human expects
        (e.g. a credit card you owe $50 on shows +50, not -50).
        """
        return 1 if self in (AccountType.ASSET, AccountType.EXPENSE) else -1


class EntrySource(enum.StrEnum):
    MANUAL = "manual"
    IMPORT = "import"
    REVERSAL = "reversal"


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    base_currency: Mapped[str] = mapped_column(String(3))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Account(Base):
    __tablename__ = "accounts"
    __table_args__ = (
        UniqueConstraint("user_id", "name"),
        # Target of the composite foreign key from journal_lines. It lets the
        # database guarantee that a line's account belongs to the same user and
        # uses the same currency as the line itself.
        UniqueConstraint("id", "user_id", "currency"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    type: Mapped[AccountType] = mapped_column(_enum(AccountType, "account_type"))
    currency: Mapped[str] = mapped_column(String(3))
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False)
    # "friend": an asset account holding what one person owes you (negative: what you owe
    # them). Shared bills post against it like any other account.
    kind: Mapped[str | None] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ImportBatch(Base):
    __tablename__ = "import_batches"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("accounts.id"))
    filename: Mapped[str] = mapped_column(String(255))
    file_sha256: Mapped[str] = mapped_column(String(64))
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    imported_count: Mapped[int] = mapped_column(Integer, default=0)
    duplicate_count: Mapped[int] = mapped_column(Integer, default=0)
    skipped_count: Mapped[int] = mapped_column(Integer, default=0)
    # Rows that matched the other side of a transfer already imported from another account.
    transfer_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class JournalEntry(Base):
    __tablename__ = "journal_entries"
    __table_args__ = (
        UniqueConstraint("id", "user_id"),
        # Re-importing an overlapping bank statement can never double-count a row.
        UniqueConstraint("user_id", "import_fingerprint"),
        Index("ix_journal_entries_user_id_occurred_on", "user_id", "occurred_on"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    occurred_on: Mapped[date] = mapped_column(Date)
    description: Mapped[str] = mapped_column(String(500))
    source: Mapped[EntrySource] = mapped_column(_enum(EntrySource, "entry_source"))
    # Unique: an entry can be reversed at most once, even under concurrent requests.
    reverses_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("journal_entries.id"), unique=True
    )
    import_batch_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("import_batches.id"))
    import_fingerprint: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    lines: Mapped[list[JournalLine]] = relationship(
        back_populates="entry", order_by="JournalLine.line_no"
    )


class JournalLine(Base):
    __tablename__ = "journal_lines"
    __table_args__ = (
        CheckConstraint("amount_minor <> 0", name="amount_nonzero"),
        UniqueConstraint("entry_id", "line_no"),
        ForeignKeyConstraint(
            ["entry_id", "user_id"], ["journal_entries.id", "journal_entries.user_id"]
        ),
        ForeignKeyConstraint(
            ["account_id", "user_id", "currency"],
            ["accounts.id", "accounts.user_id", "accounts.currency"],
        ),
        Index("ix_journal_lines_account_id", "account_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    entry_id: Mapped[uuid.UUID] = mapped_column()
    user_id: Mapped[uuid.UUID] = mapped_column()
    line_no: Mapped[int] = mapped_column(Integer)
    account_id: Mapped[uuid.UUID] = mapped_column()
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(String(3))
    memo: Mapped[str | None] = mapped_column(String(500))

    entry: Mapped[JournalEntry] = relationship(back_populates="lines")


class CategoryRule(Base):
    """Auto-categorize imported rows: description contains `pattern` -> `account_id`."""

    __tablename__ = "category_rules"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    pattern: Mapped[str] = mapped_column(String(100))
    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("accounts.id"))
    priority: Mapped[int] = mapped_column(Integer, default=100)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Budget(Base):
    __tablename__ = "budgets"
    __table_args__ = (
        UniqueConstraint("user_id", "account_id", "month"),
        CheckConstraint("amount_minor > 0", name="amount_positive"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("accounts.id"))
    month: Mapped[date] = mapped_column(Date)  # always the first day of the month
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class IdempotencyRecord(Base):
    """Stored response for a write request, keyed by the client's Idempotency-Key header."""

    __tablename__ = "idempotency_keys"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    key: Mapped[str] = mapped_column(String(255), primary_key=True)
    request_hash: Mapped[str] = mapped_column(String(64))
    status_code: Mapped[int] = mapped_column(Integer)
    response_body: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuditEvent(Base):
    __tablename__ = "audit_log"
    __table_args__ = (Index("ix_audit_log_user_id_created_at", "user_id", "created_at"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(64))
    entity_type: Mapped[str] = mapped_column(String(32))
    entity_id: Mapped[str] = mapped_column(String(64))
    details: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class FriendGroup(Base):
    """A named set of friends you split bills with ("Roommates", "Ski trip")."""

    __tablename__ = "friend_groups"
    __table_args__ = (UniqueConstraint("user_id", "name"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    members: Mapped[list[FriendGroupMember]] = relationship(
        cascade="all, delete-orphan", order_by="FriendGroupMember.position"
    )


class FriendGroupMember(Base):
    __tablename__ = "friend_group_members"

    group_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("friend_groups.id", ondelete="CASCADE"), primary_key=True
    )
    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("accounts.id"), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, default=0)


class SharedEntry(Base):
    """Split details for a journal entry: who paid, who shared, how it was divided.

    The money effect lives entirely in the journal entry's lines; this row is the
    human-readable record of the split (and links it to a group).
    """

    __tablename__ = "shared_entries"
    __table_args__ = (Index("ix_shared_entries_user_id_group_id", "user_id", "group_id"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    entry_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("journal_entries.id"), unique=True)
    group_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("friend_groups.id", ondelete="SET NULL")
    )
    kind: Mapped[str] = mapped_column(String(16))  # "expense" | "settlement"
    # None means you paid; otherwise the friend account of whoever paid.
    payer_account_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("accounts.id"))
    total_minor: Mapped[int] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(String(3))
    method: Mapped[str | None] = mapped_column(String(16))  # equal | exact | shares
    # [{"account_id": uuid | null (you), "amount_minor": int}] for every participant.
    shares: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
