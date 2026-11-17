"""Shared bills, Splitwise-style, on top of the double-entry ledger.

Each friend is an asset account (kind="friend"). Its balance is what that person owes
you; a negative balance is what you owe them. Splitting a bill is just a journal entry:

    You paid $90 dinner on your card, split three ways with Alex and Sam:
        Dining            +30   (your share is your real expense)
        Alex (friend)     +30   (Alex now owes you 30)
        Sam (friend)      +30
        Visa Card         -90

    Alex paid $90, split three ways:
        Dining            +30   (only your share touches your books)
        Alex (friend)     -30   (you now owe Alex 30)

    Settling up is a transfer between a bank account and the friend account.

So friend balances, net worth, budgets and reports all stay exact, and the split's
details (who paid, how it was divided, which group) are kept in `SharedEntry`.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit
from app.errors import ConflictError, LedgerError, NotFoundError
from app.models import (
    Account,
    AccountType,
    FriendGroup,
    FriendGroupMember,
    JournalEntry,
    JournalLine,
    SharedEntry,
    User,
)
from app.services import ledger

FRIEND = "friend"
Method = Literal["equal", "exact", "shares"]
MAX_PARTICIPANTS = 50


def allocate(total_minor: int, weights: list[int]) -> list[int]:
    """Split `total_minor` in proportion to `weights`, exactly, with no lost cents.

    Largest-remainder method: everyone gets the floor of their exact share, and the
    leftover minor units go to the largest fractional remainders (earlier participants
    win ties), so the result always sums to the total and is deterministic.
    """
    if total_minor <= 0:
        raise LedgerError("Total must be positive")
    if not weights or any(w <= 0 for w in weights):
        raise LedgerError("Every participant needs a positive share")
    whole = sum(weights)
    base = [total_minor * w // whole for w in weights]
    remainders = [total_minor * w % whole for w in weights]
    leftover = total_minor - sum(base)
    order = sorted(range(len(weights)), key=lambda i: (-remainders[i], i))
    for i in order[:leftover]:
        base[i] += 1
    return base


# --- Friends & groups -----------------------------------------------------------------


def create_friend(db: Session, user: User, name: str) -> Account:
    if name.startswith(ledger.SYSTEM_ACCOUNT_PREFIXES):
        raise LedgerError("That name is reserved for a system account")
    account = ledger.create_account(
        db, user, name=name, account_type=AccountType.ASSET, currency=user.base_currency
    )
    account.kind = FRIEND
    return account


def get_friend(db: Session, user: User, account_id: uuid.UUID) -> Account:
    account = db.get(Account, account_id)
    if account is None or account.user_id != user.id or account.kind != FRIEND:
        raise NotFoundError("Friend not found")
    return account


def get_group(db: Session, user: User, group_id: uuid.UUID) -> FriendGroup:
    group = db.get(FriendGroup, group_id)
    if group is None or group.user_id != user.id:
        raise NotFoundError("Group not found")
    return group


def set_group(
    db: Session,
    user: User,
    group: FriendGroup | None,
    *,
    name: str | None,
    member_ids: list[uuid.UUID] | None,
) -> FriendGroup:
    """Create a group (group=None) or update its name and/or members."""
    if name is not None:
        clash = db.scalar(
            select(FriendGroup.id).where(
                FriendGroup.user_id == user.id,
                FriendGroup.name == name,
                FriendGroup.id != (group.id if group else None),
            )
        )
        if clash:
            raise ConflictError("A group with that name already exists")
    if group is None:
        group = FriendGroup(user_id=user.id, name=name)
        db.add(group)
    elif name is not None:
        group.name = name
    if member_ids is not None:
        if len(set(member_ids)) != len(member_ids):
            raise LedgerError("A friend can only be in a group once")
        for mid in member_ids:
            get_friend(db, user, mid)
        group.members = [
            FriendGroupMember(account_id=mid, position=i) for i, mid in enumerate(member_ids)
        ]
    db.flush()
    audit.record(
        db,
        user.id,
        "group.saved",
        "friend_group",
        group.id,
        {"name": group.name, "members": [str(m.account_id) for m in group.members]},
    )
    return group


def delete_group(db: Session, user: User, group: FriendGroup) -> None:
    """Delete a group. Its bills stay in the ledger (and on friend balances), ungrouped."""
    audit.record(db, user.id, "group.deleted", "friend_group", group.id, {"name": group.name})
    db.query(SharedEntry).filter(SharedEntry.group_id == group.id).update({"group_id": None})
    db.delete(group)
    db.flush()


# --- Posting --------------------------------------------------------------------------


@dataclass(frozen=True)
class Participant:
    account_id: uuid.UUID | None  # None = you
    weight: int | None = None  # for "shares"
    amount_minor: int | None = None  # for "exact"


def compute_shares(total_minor: int, method: Method, people: list[Participant]) -> list[int]:
    if not people:
        raise LedgerError("Pick at least one person to split with")
    if len(people) > MAX_PARTICIPANTS:
        raise LedgerError(f"At most {MAX_PARTICIPANTS} people per bill")
    if len({p.account_id for p in people}) != len(people):
        raise LedgerError("Each person can only appear once in a split")
    if method == "equal":
        return allocate(total_minor, [1] * len(people))
    if method == "shares":
        return allocate(total_minor, [p.weight or 0 for p in people])
    amounts = [p.amount_minor or 0 for p in people]
    if any(a < 0 for a in amounts):
        raise LedgerError("Amounts can't be negative")
    if sum(amounts) != total_minor:
        raise LedgerError(
            f"Exact amounts add up to {sum(amounts)}, but the bill is {total_minor} (minor units)"
        )
    return amounts


def _check_in_group(group: FriendGroup | None, ids: set[uuid.UUID]) -> None:
    if group is None:
        return
    members = {m.account_id for m in group.members}
    if outsiders := ids - members:
        raise LedgerError(f"{len(outsiders)} selected friend(s) aren't in '{group.name}'")


def post_shared_expense(
    db: Session,
    user: User,
    *,
    occurred_on: date,
    description: str,
    total_minor: int,
    category_id: uuid.UUID,
    payer_id: uuid.UUID | None,
    paid_from_id: uuid.UUID | None,
    group_id: uuid.UUID | None,
    method: Method,
    participants: list[Participant],
) -> SharedEntry:
    """Post a split bill as one balanced journal entry plus its SharedEntry record."""
    category = ledger.get_account(db, user, category_id)
    if category.type != AccountType.EXPENSE:
        raise LedgerError("Pick a spending category for the bill")
    currency = category.currency
    group = get_group(db, user, group_id) if group_id else None

    friend_ids = {p.account_id for p in participants if p.account_id is not None}
    for fid in friend_ids | ({payer_id} if payer_id else set()):
        friend = get_friend(db, user, fid)
        if friend.currency != currency:
            raise LedgerError(f"{friend.name} is tracked in {friend.currency}, not {currency}")
    _check_in_group(group, friend_ids | ({payer_id} if payer_id else set()))

    shares = compute_shares(total_minor, method, participants)
    by_person = {p.account_id: s for p, s in zip(participants, shares, strict=True)}
    my_share = by_person.get(None, 0)

    lines: list[ledger.LineInput] = []
    if my_share:
        lines.append(ledger.LineInput(category.id, my_share))
    if payer_id is None:
        if paid_from_id is None:
            raise LedgerError("Choose which account you paid from")
        paid_from = ledger.get_account(db, user, paid_from_id)
        if paid_from.kind == FRIEND or paid_from.type not in (
            AccountType.ASSET,
            AccountType.LIABILITY,
        ):
            raise LedgerError("Pay from a bank account or card")
        if paid_from.currency != currency:
            raise LedgerError(f"{paid_from.name} is in {paid_from.currency}, not {currency}")
        if not friend_ids:
            raise LedgerError("Add at least one friend to split with")
        names = {
            a.id: a.name for a in db.scalars(select(Account).where(Account.id.in_(friend_ids)))
        }
        for p in participants:
            if p.account_id is not None and by_person[p.account_id]:
                share = by_person[p.account_id]
                lines.append(
                    ledger.LineInput(p.account_id, share, f"{names[p.account_id]}'s share")
                )
        lines.append(ledger.LineInput(paid_from.id, -total_minor))
    else:
        if not my_share:
            raise LedgerError(
                "You have no share in this bill, so it doesn't change your books; "
                "only bills you paid for or took part in are tracked"
            )
        lines.append(ledger.LineInput(payer_id, -my_share, "You owe your share"))

    entry = ledger.post_entry(
        db, user, occurred_on=occurred_on, description=description, lines=lines
    )
    shared = SharedEntry(
        user_id=user.id,
        entry_id=entry.id,
        group_id=group.id if group else None,
        kind="expense",
        payer_account_id=payer_id,
        total_minor=total_minor,
        currency=currency,
        method=method,
        shares=[
            {"account_id": str(p.account_id) if p.account_id else None, "amount_minor": s}
            for p, s in zip(participants, shares, strict=True)
        ],
    )
    db.add(shared)
    db.flush()
    return shared


def post_settlement(
    db: Session,
    user: User,
    *,
    friend_id: uuid.UUID,
    account_id: uuid.UUID,
    amount_minor: int,
    direction: Literal["they_paid", "you_paid"],
    occurred_on: date,
    group_id: uuid.UUID | None = None,
) -> SharedEntry:
    """Record money changing hands to settle a balance (a transfer with a friend account)."""
    friend = get_friend(db, user, friend_id)
    account = ledger.get_account(db, user, account_id)
    if account.kind == FRIEND or account.type not in (AccountType.ASSET, AccountType.LIABILITY):
        raise LedgerError("Settle through a bank account or card")
    if account.currency != friend.currency:
        raise LedgerError(f"{account.name} is in {account.currency}, not {friend.currency}")
    group = get_group(db, user, group_id) if group_id else None
    _check_in_group(group, {friend.id})

    sign = 1 if direction == "they_paid" else -1
    description = (
        f"{friend.name} paid you back" if direction == "they_paid" else f"You paid {friend.name}"
    )
    entry = ledger.post_entry(
        db,
        user,
        occurred_on=occurred_on,
        description=description,
        lines=[
            ledger.LineInput(account.id, sign * amount_minor),
            ledger.LineInput(friend.id, -sign * amount_minor, "Settle up"),
        ],
    )
    shared = SharedEntry(
        user_id=user.id,
        entry_id=entry.id,
        group_id=group.id if group else None,
        kind="settlement",
        payer_account_id=friend.id if direction == "they_paid" else None,
        total_minor=amount_minor,
        currency=friend.currency,
        method=None,
        shares=[{"account_id": str(friend.id), "amount_minor": -sign * amount_minor}],
    )
    db.add(shared)
    db.flush()
    return shared


# --- Reading --------------------------------------------------------------------------


def _reversed_ids():
    return select(JournalEntry.reverses_id).where(JournalEntry.reverses_id.is_not(None))


def group_balances(db: Session, user: User, group_id: uuid.UUID) -> dict[uuid.UUID, int]:
    """Per friend: what they owe you (+) or you owe them (-) from this group's bills only."""
    rows = db.execute(
        select(JournalLine.account_id, func.sum(JournalLine.amount_minor))
        .join(SharedEntry, SharedEntry.entry_id == JournalLine.entry_id)
        .join(Account, Account.id == JournalLine.account_id)
        .where(
            SharedEntry.user_id == user.id,
            SharedEntry.group_id == group_id,
            Account.kind == FRIEND,
            JournalLine.entry_id.not_in(_reversed_ids()),
        )
        .group_by(JournalLine.account_id)
    )
    return {acct: int(total) for acct, total in rows}


def group_spend(db: Session, user: User, group_id: uuid.UUID) -> int:
    total = db.scalar(
        select(func.coalesce(func.sum(SharedEntry.total_minor), 0)).where(
            SharedEntry.user_id == user.id,
            SharedEntry.group_id == group_id,
            SharedEntry.kind == "expense",
            SharedEntry.entry_id.not_in(_reversed_ids()),
        )
    )
    return int(total or 0)
