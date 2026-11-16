"""Bank statement (CSV) import.

Guarantees:
  * Atomic — if any row fails to parse, nothing is imported and every bad row is reported.
  * Idempotent — each row gets a fingerprint; re-importing the same or an overlapping
    statement skips rows already in the ledger (enforced by a unique constraint).
  * Two genuinely identical rows (two $4.50 coffees on the same day) are kept distinct
    by an occurrence counter in the fingerprint.
"""

from __future__ import annotations

import csv
import hashlib
import io
import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit
from app.errors import LedgerError
from app.models import (
    Account,
    AccountType,
    CategoryRule,
    EntrySource,
    ImportBatch,
    JournalEntry,
    User,
)
from app.money import MoneyError, parse_amount
from app.services import ledger

MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_ROWS = 10_000
MAX_REPORTED_ERRORS = 50


@dataclass(frozen=True)
class CsvColumns:
    date: str = "date"
    description: str = "description"
    amount: str = "amount"


@dataclass(frozen=True)
class ParsedRow:
    line_no: int
    occurred_on: date
    description: str
    amount_minor: int  # positive = money into the account


def normalize_description(text: str) -> str:
    return " ".join(text.lower().split())


def row_fingerprint(account_id: uuid.UUID, row: ParsedRow, occurrence: int) -> str:
    raw = "|".join(
        [
            str(account_id),
            row.occurred_on.isoformat(),
            str(row.amount_minor),
            normalize_description(row.description),
            str(occurrence),
        ]
    )
    return hashlib.sha256(raw.encode()).hexdigest()


def parse_csv(
    content: bytes,
    *,
    currency: str,
    columns: CsvColumns,
    date_format: str,
    invert_amounts: bool,
) -> tuple[list[ParsedRow], int]:
    """Return (rows, skipped_zero_amount_rows). Raises LedgerError listing every bad row."""
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise LedgerError("File must be a UTF-8 encoded CSV") from None

    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise LedgerError("CSV file is empty")
    header = {name.strip().lower(): name for name in reader.fieldnames if name}
    wanted = (columns.date, columns.description, columns.amount)
    if missing := [c for c in wanted if c.strip().lower() not in header]:
        raise LedgerError(
            f"Missing column(s): {', '.join(missing)}",
            found_columns=list(header.values()),
        )
    date_key, desc_key, amount_key = (header[c.strip().lower()] for c in wanted)

    rows: list[ParsedRow] = []
    errors: list[str] = []
    skipped = 0
    for count, raw in enumerate(reader, start=1):
        if count > MAX_ROWS:
            raise LedgerError(f"File has more than {MAX_ROWS} rows")
        line_no = count + 1  # the header is line 1
        date_text = (raw.get(date_key) or "").strip()
        description = " ".join((raw.get(desc_key) or "").split())
        amount_text = (raw.get(amount_key) or "").strip()

        try:
            occurred_on = datetime.strptime(date_text, date_format).date()
        except ValueError:
            errors.append(f"Row {line_no}: invalid date '{date_text}' (expected {date_format})")
            continue
        try:
            amount = parse_amount(amount_text, currency)
        except MoneyError as exc:
            errors.append(f"Row {line_no}: {exc}")
            continue
        if not description:
            errors.append(f"Row {line_no}: description is empty")
            continue
        if amount == 0:
            skipped += 1
            continue
        rows.append(
            ParsedRow(
                line_no, occurred_on, description[:500], -amount if invert_amounts else amount
            )
        )

    if errors:
        raise LedgerError(
            f"{len(errors)} row(s) could not be imported; nothing was saved",
            errors=errors[:MAX_REPORTED_ERRORS],
        )
    return rows, skipped


def _match_rule(rules: list[tuple[CategoryRule, Account]], description: str) -> Account | None:
    text = description.lower()
    for rule, account in rules:
        if rule.pattern.lower() in text:
            return account
    return None


def import_csv(
    db: Session,
    user: User,
    *,
    account_id: uuid.UUID,
    filename: str,
    content: bytes,
    columns: CsvColumns = CsvColumns(),
    date_format: str = "%Y-%m-%d",
    invert_amounts: bool = False,
) -> ImportBatch:
    """Parse, dedupe, categorize and post a statement. Does not commit."""
    account = ledger.get_account(db, user, account_id)
    if account.type not in (AccountType.ASSET, AccountType.LIABILITY):
        raise LedgerError("Statements can only be imported into asset or liability accounts")

    rows, skipped = parse_csv(
        content,
        currency=account.currency,
        columns=columns,
        date_format=date_format,
        invert_amounts=invert_amounts,
    )

    occurrences: Counter[tuple[date, int, str]] = Counter()
    fingerprinted: list[tuple[ParsedRow, str]] = []
    for row in rows:
        key = (row.occurred_on, row.amount_minor, normalize_description(row.description))
        fingerprinted.append((row, row_fingerprint(account.id, row, occurrences[key])))
        occurrences[key] += 1

    existing: set[str] = set()
    all_fps = [fp for _, fp in fingerprinted]
    for i in range(0, len(all_fps), 500):
        existing.update(
            db.scalars(
                select(JournalEntry.import_fingerprint).where(
                    JournalEntry.user_id == user.id,
                    JournalEntry.import_fingerprint.in_(all_fps[i : i + 500]),
                )
            )
        )

    batch = ImportBatch(
        user_id=user.id,
        account_id=account.id,
        filename=filename[:255],
        file_sha256=hashlib.sha256(content).hexdigest(),
        row_count=len(rows) + skipped,
        skipped_count=skipped,
    )
    db.add(batch)
    db.flush()

    rules = [
        (rule, rule_account)
        for rule, rule_account in db.execute(
            select(CategoryRule, Account)
            .join(Account, CategoryRule.account_id == Account.id)
            .where(
                CategoryRule.user_id == user.id,
                Account.currency == account.currency,
                Account.id != account.id,
                Account.is_archived.is_(False),
            )
            .order_by(CategoryRule.priority, CategoryRule.created_at)
        )
    ]
    fallback_income = ledger.get_or_create_account(
        db, user, AccountType.INCOME, ledger.UNCATEGORIZED_INCOME, account.currency
    )
    fallback_expense = ledger.get_or_create_account(
        db, user, AccountType.EXPENSE, ledger.UNCATEGORIZED_EXPENSE, account.currency
    )

    imported = 0
    for row, fp in fingerprinted:
        if fp in existing:
            continue
        category = _match_rule(rules, row.description) or (
            fallback_income if row.amount_minor > 0 else fallback_expense
        )
        ledger.post_entry(
            db,
            user,
            occurred_on=row.occurred_on,
            description=row.description,
            lines=[
                ledger.LineInput(account.id, row.amount_minor),
                ledger.LineInput(category.id, -row.amount_minor),
            ],
            source=EntrySource.IMPORT,
            import_batch_id=batch.id,
            import_fingerprint=fp,
            record_audit=False,  # one audit event per batch, below
        )
        imported += 1

    batch.imported_count = imported
    batch.duplicate_count = len(fingerprinted) - imported
    audit.record(
        db,
        user.id,
        "import.completed",
        "import_batch",
        batch.id,
        {
            "account_id": str(account.id),
            "filename": batch.filename,
            "file_sha256": batch.file_sha256,
            "imported": imported,
            "duplicates": batch.duplicate_count,
            "skipped": skipped,
        },
    )
    db.flush()
    return batch
