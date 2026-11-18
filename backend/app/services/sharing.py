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

import calendar
import uuid
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Literal

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
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
    SharedRecurring,
    User,
)
from app.services import ledger

FRIEND = "friend"
Method = Literal["equal", "exact", "shares", "percent", "adjust", "itemized"]
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
    percent_bp: int | None = None  # for "percent", in basis points (12.5% = 1250)
    adjust_minor: int | None = None  # for "adjust": extra on top of an equal share


@dataclass(frozen=True)
class Item:
    """One line of an itemized receipt, split equally between `people` (None = you)."""

    name: str
    amount_minor: int
    people: tuple[uuid.UUID | None, ...]


def _allocate_nonneg(total_minor: int, weights: list[int]) -> list[int]:
    """`allocate`, but people with weight 0 get 0 (and a 0 total gives everyone 0)."""
    out = [0] * len(weights)
    live = [i for i, w in enumerate(weights) if w > 0]
    if total_minor == 0 or not live:
        return out
    for i, share in zip(live, allocate(total_minor, [weights[i] for i in live]), strict=True):
        out[i] = share
    return out


def itemized_shares(
    people: list[uuid.UUID | None], items: list[Item], extras_minor: int
) -> list[int]:
    """Each item split equally among its people; tax/tip/fees (or a discount, if negative)
    spread in proportion to each person's subtotal. Exact to the cent, like everything else."""
    if not items:
        raise LedgerError("Add at least one item")
    index = {pid: i for i, pid in enumerate(people)}
    subtotal = [0] * len(people)
    for item in items:
        if item.amount_minor <= 0:
            raise LedgerError(f"'{item.name}' needs a positive price")
        if not item.people:
            raise LedgerError(f"Pick who had '{item.name}'")
        if any(p not in index for p in item.people):
            raise LedgerError(f"Someone on '{item.name}' isn't part of this bill")
        if len(set(item.people)) != len(item.people):
            raise LedgerError(f"Each person can only be on '{item.name}' once")
        on_item = sorted(item.people, key=lambda p: index[p])
        for pid, share in zip(
            on_item, allocate(item.amount_minor, [1] * len(on_item)), strict=True
        ):
            subtotal[index[pid]] += share
    items_total = sum(subtotal)
    if extras_minor < 0 and -extras_minor > items_total:
        raise LedgerError("The discount is bigger than the items")
    spread = _allocate_nonneg(abs(extras_minor), subtotal)
    sign = 1 if extras_minor >= 0 else -1
    return [s + sign * x for s, x in zip(subtotal, spread, strict=True)]


def compute_shares(
    total_minor: int,
    method: Method,
    people: list[Participant],
    items: list[Item] | None = None,
    extras_minor: int = 0,
) -> list[int]:
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
    if method == "percent":
        bps = [p.percent_bp or 0 for p in people]
        if any(b < 0 for b in bps):
            raise LedgerError("Percentages can't be negative")
        if sum(bps) != 10_000:
            raise LedgerError(f"Percentages add up to {sum(bps) / 100:g}%, not 100%")
        return _allocate_nonneg(total_minor, bps)
    if method == "adjust":
        adjustments = [p.adjust_minor or 0 for p in people]
        rest = total_minor - sum(adjustments)
        if rest < 0:
            raise LedgerError("The adjustments add up to more than the bill")
        base = _allocate_nonneg(rest, [1] * len(people))
        shares = [b + a for b, a in zip(base, adjustments, strict=True)]
        if any(x < 0 for x in shares):
            raise LedgerError("An adjustment would make someone's share negative")
        return shares
    if method == "itemized":
        shares = itemized_shares([p.account_id for p in people], items or [], extras_minor)
        if sum(shares) != total_minor:
            raise LedgerError(
                f"Items plus tax and tip come to {sum(shares)}, but the bill is {total_minor}"
                " (minor units)"
            )
        return shares
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
    items: list[Item] | None = None,
    extras_minor: int = 0,
    notes: str | None = None,
    edited_from_id: uuid.UUID | None = None,
    recurring_id: uuid.UUID | None = None,
    occurrence_on: date | None = None,
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

    shares = compute_shares(total_minor, method, participants, items, extras_minor)
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
        notes=notes or None,
        # What the person typed (shares, percentages, items...), so an edit can reopen
        # the bill exactly as entered. The amounts above are what was posted.
        details={
            "participants": [
                {
                    "account_id": str(p.account_id) if p.account_id else None,
                    "weight": p.weight,
                    "amount_minor": p.amount_minor,
                    "percent_bp": p.percent_bp,
                    "adjust_minor": p.adjust_minor,
                }
                for p in participants
            ],
            "items": [
                {
                    "name": it.name,
                    "amount_minor": it.amount_minor,
                    "account_ids": [str(x) if x else None for x in it.people],
                }
                for it in items or []
            ],
            "extras_minor": extras_minor,
        },
        edited_from_id=edited_from_id,
        recurring_id=recurring_id,
        occurrence_on=occurrence_on,
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


# --- From API JSON (also how recurring templates are stored) --------------------------


def _uuid(v: Any) -> uuid.UUID | None:
    return uuid.UUID(str(v)) if v else None


def expense_kwargs(body: dict[str, Any]) -> dict[str, Any]:
    """Turn a bill as JSON (the API body, minus the date) into post_shared_expense kwargs."""
    return {
        "description": body["description"],
        "total_minor": body["total_minor"],
        "category_id": _uuid(body["category_id"]),
        "payer_id": _uuid(body.get("payer_id")),
        "paid_from_id": _uuid(body.get("paid_from_id")),
        "group_id": _uuid(body.get("group_id")),
        "method": body.get("method") or "equal",
        "participants": [
            Participant(
                _uuid(p.get("account_id")),
                p.get("weight"),
                p.get("amount_minor"),
                p.get("percent_bp"),
                p.get("adjust_minor"),
            )
            for p in body["participants"]
        ],
        "items": [
            Item(it["name"], it["amount_minor"], tuple(_uuid(x) for x in it["account_ids"]))
            for it in body.get("items") or []
        ],
        "extras_minor": body.get("extras_minor") or 0,
        "notes": body.get("notes"),
    }


# --- Editing --------------------------------------------------------------------------


def get_shared(db: Session, user: User, shared_id: uuid.UUID) -> SharedEntry:
    shared = db.get(SharedEntry, shared_id)
    if shared is None or shared.user_id != user.id:
        raise NotFoundError("Bill not found")
    return shared


def edit_shared_expense(
    db: Session, user: User, shared_id: uuid.UUID, *, occurred_on: date, body: dict[str, Any]
) -> SharedEntry:
    """Ledgers are append-only, so an edit reverses the old bill and posts the new one, in
    one transaction. History keeps both, linked by `edited_from_id`."""
    old = get_shared(db, user, shared_id)
    if old.kind != "expense":
        raise LedgerError("Only bills can be edited; remove a payment and record it again")
    if ledger.is_reversed(db, old.entry_id):
        raise ConflictError("This bill was already removed or edited")
    ledger.reverse_entry(db, user, old.entry_id, reason="edited")
    return post_shared_expense(
        db, user, occurred_on=occurred_on, edited_from_id=old.id, **expense_kwargs(body)
    )


# --- Recurring bills ------------------------------------------------------------------

Cadence = Literal["weekly", "monthly"]
MAX_CATCH_UP = 24  # never post more than this many missed occurrences in one go


def next_occurrence(on: date, cadence: str, anchor_day: int) -> date:
    if cadence == "weekly":
        return on + timedelta(days=7)
    year, month = (on.year + 1, 1) if on.month == 12 else (on.year, on.month + 1)
    return date(year, month, min(anchor_day, calendar.monthrange(year, month)[1]))


def start_recurring(
    db: Session, user: User, *, body: dict[str, Any], first_on: date, cadence: Cadence
) -> tuple[SharedRecurring, SharedEntry]:
    """Post the first bill now and remember it for next time."""
    rec = SharedRecurring(
        user_id=user.id,
        description=body["description"],
        template=body,
        cadence=cadence,
        anchor_day=first_on.day,
        next_on=next_occurrence(first_on, cadence, first_on.day),
        is_active=True,
    )
    db.add(rec)
    db.flush()
    first = post_shared_expense(
        db,
        user,
        occurred_on=first_on,
        recurring_id=rec.id,
        occurrence_on=first_on,
        **expense_kwargs(body),
    )
    audit.record(
        db, user.id, "recurring_bill.started", "shared_recurring", rec.id, {"cadence": cadence}
    )
    return rec, first


def post_due_bills(db: Session, user: User, today: date) -> list[SharedEntry]:
    """Post every occurrence that has come due. Safe to call repeatedly or concurrently:
    (recurring_id, occurrence_on) is unique, so a race loses at the constraint."""
    posted: list[SharedEntry] = []
    due = db.scalars(
        select(SharedRecurring)
        .where(
            SharedRecurring.user_id == user.id,
            SharedRecurring.is_active.is_(True),
            SharedRecurring.next_on <= today,
        )
        .with_for_update(skip_locked=True)
    ).all()
    for rec in due:
        count = 0
        while rec.next_on <= today and count < MAX_CATCH_UP:
            on = rec.next_on
            try:
                with db.begin_nested():
                    posted.append(
                        post_shared_expense(
                            db,
                            user,
                            occurred_on=on,
                            recurring_id=rec.id,
                            occurrence_on=on,
                            **expense_kwargs(rec.template),
                        )
                    )
            except IntegrityError:
                pass  # another request posted this one first
            except (LedgerError, NotFoundError) as e:
                # A friend or account was archived or removed since: stop rather than guess.
                rec.is_active = False
                audit.record(
                    db,
                    user.id,
                    "recurring_bill.stopped",
                    "shared_recurring",
                    rec.id,
                    {"reason": str(e)[:200]},
                )
                break
            rec.next_on = next_occurrence(on, rec.cadence, rec.anchor_day)
            count += 1
    db.flush()
    return posted


def stop_recurring(db: Session, user: User, recurring_id: uuid.UUID) -> SharedRecurring:
    rec = db.get(SharedRecurring, recurring_id)
    if rec is None or rec.user_id != user.id:
        raise NotFoundError("Repeating bill not found")
    rec.is_active = False
    audit.record(db, user.id, "recurring_bill.stopped", "shared_recurring", rec.id, {})
    db.flush()
    return rec


# --- Group totals ---------------------------------------------------------------------


def group_summary(db: Session, user: User, group_id: uuid.UUID) -> dict[str, Any]:
    """What the group spent, who paid for it, and what your share went on."""
    rows = db.execute(
        select(SharedEntry, JournalEntry)
        .join(JournalEntry, JournalEntry.id == SharedEntry.entry_id)
        .where(
            SharedEntry.user_id == user.id,
            SharedEntry.group_id == group_id,
            SharedEntry.kind == "expense",
            SharedEntry.entry_id.not_in(_reversed_ids()),
        )
    ).all()
    expense_ids = set(
        db.scalars(
            select(Account.id).where(
                Account.user_id == user.id, Account.type == AccountType.EXPENSE
            )
        )
    )
    lines = db.execute(
        select(JournalLine.entry_id, JournalLine.account_id).where(
            JournalLine.entry_id.in_([e.id for _, e in rows])
        )
    ).all()
    category_of = {eid: acct for eid, acct in lines if acct in expense_ids}

    paid_by: dict[str, int] = {}
    by_category: dict[str, int] = {}
    by_month: dict[str, int] = {}
    my_total = 0
    for shared, entry in rows:
        payer = str(shared.payer_account_id) if shared.payer_account_id else "me"
        paid_by[payer] = paid_by.get(payer, 0) + shared.total_minor
        mine = next((x["amount_minor"] for x in shared.shares if x["account_id"] is None), 0)
        my_total += mine
        if mine and entry.id in category_of:
            key = str(category_of[entry.id])
            by_category[key] = by_category.get(key, 0) + mine
        month = entry.occurred_on.strftime("%Y-%m")
        by_month[month] = by_month.get(month, 0) + shared.total_minor
    return {
        "total_spent_minor": sum(paid_by.values()),
        "my_share_minor": my_total,
        "bill_count": len(rows),
        "paid_by": paid_by,
        "my_share_by_category": by_category,
        "by_month": dict(sorted(by_month.items())),
    }
