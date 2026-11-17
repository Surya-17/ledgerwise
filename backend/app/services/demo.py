"""Realistic, deterministic demo activity: six months of pay, bills, card spending and budgets.

Everything goes through the same service layer the API uses, so demo ledgers obey
every invariant (balanced entries, audit trail, import fingerprints).
"""

import random
from collections.abc import Iterator
from datetime import date, timedelta

from sqlalchemy.orm import Session

from app.models import AccountType, Budget, CategoryRule, User
from app.services import imports, ledger, reports, sharing

DINING = [
    "Blue Bottle Coffee",
    "Chipotle",
    "Sweetgreen",
    "Joe's Pizza",
    "Thai Basil",
    "Shake Shack",
]
SHOPPING = ["Amazon", "Target", "Uniqlo", "Best Buy"]


def _dates(start: date, end: date) -> Iterator[date]:
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def populate_demo_data(db: Session, user: User) -> None:
    """Fill a freshly registered user (default accounts already created) with demo activity.

    Does not commit; the caller owns the transaction.
    """
    rng = random.Random(42)
    today = date.today()
    start = reports.add_months(reports.month_start(today), -5)

    def new(name: str, kind: AccountType, opening: int = 0):
        return ledger.create_account(
            db,
            user,
            name=name,
            account_type=kind,
            currency="USD",
            opening_balance_minor=opening,
            opening_date=start - timedelta(days=1),
        )

    checking = new("Checking", AccountType.ASSET, 4_250_00)
    savings = new("High-Yield Savings", AccountType.ASSET, 12_000_00)
    card = new("Visa Card", AccountType.LIABILITY, 480_00)
    new("Subscriptions", AccountType.EXPENSE)
    acct = {a.name: a for a, _ in reports.account_balances(db, user)}

    def post(on: date, description: str, debit, credit, cents: int) -> None:
        ledger.post_entry(
            db,
            user,
            occurred_on=on,
            description=description,
            lines=[ledger.LineInput(debit.id, cents), ledger.LineInput(credit.id, -cents)],
        )

    # Everyday activity, day by day. Rent, utilities and transport stay as
    # manual entries; groceries and dining come in via the CSV import below.
    card_statement = ["Date,Description,Amount"]
    for d in _dates(start, today):
        if d.day in (1, 15):
            post(d, "ACME Corp Payroll", checking, acct["Salary"], 3_150_00)
        if d.day == 1:
            post(d, "Rent - Maple St Apartments", acct["Rent"], checking, 1_850_00)
            post(d, "Transfer to savings", savings, checking, 600_00)
        if d.day == 5:
            post(d, "Con Edison", acct["Utilities"], checking, rng.randint(85_00, 140_00))
        if d.day == 28:
            interest = rng.randint(38_00, 46_00)
            post(d, "Savings interest", savings, acct["Interest"], interest)
        if d.weekday() == 0:
            post(d, "MTA Subway", acct["Transport"], checking, 34_00)
        if d.weekday() == 5:
            card_statement.append(f"{d},WHOLE FOODS MARKET,{rng.randint(55_00, 160_00) / 100:.2f}")
        if rng.random() < 0.35:
            card_statement.append(f"{d},{rng.choice(DINING)},{rng.randint(6_00, 48_00) / 100:.2f}")
        if rng.random() < 0.06:
            card_statement.append(
                f"{d},{rng.choice(SHOPPING)},{rng.randint(15_00, 180_00) / 100:.2f}"
            )
        if d.day == 20:
            post(d, "Visa card payment", card, checking, rng.randint(700_00, 1_100_00))
        # Subscriptions on the card, for recurring detection. The gym membership
        # stops two months ago, so the demo shows a lapsed subscription too.
        if d.day == 8:
            card_statement.append(f"{d},NETFLIX.COM 866-579-7172,15.49")
        if d.day == 12:
            card_statement.append(f"{d},Spotify USA,11.99")
        if d.day == 3 and d < reports.add_months(reports.month_start(today), -1):
            card_statement.append(f"{d},PLANET FITNESS #0421,24.99")

    # Categorization rules, then import the card statement like a user would.
    # Shopping has no rule on purpose: those rows land in Uncategorized Expense,
    # so the demo shows recategorization (reverse + repost) in action.
    subscriptions = [("netflix", "Subscriptions"), ("spotify", "Subscriptions")]
    subscriptions.append(("planet fitness", "Subscriptions"))
    for pattern, name in [
        ("whole foods", "Groceries"),
        *[(n, "Dining") for n in DINING],
        *subscriptions,
    ]:
        db.add(CategoryRule(user_id=user.id, pattern=pattern, account_id=acct[name].id))
    db.flush()
    imports.import_csv(
        db,
        user,
        account_id=card.id,
        filename="visa-statement.csv",
        content="\n".join(card_statement).encode(),
        invert_amounts=True,  # card exports show purchases as positive numbers
    )

    this_month = reports.month_start(today)
    for name, cents in [
        ("Groceries", 550_00),
        ("Dining", 300_00),
        ("Shopping", 200_00),
        ("Transport", 150_00),
        ("Utilities", 140_00),
        ("Rent", 1_850_00),
    ]:
        db.add(
            Budget(user_id=user.id, account_id=acct[name].id, month=this_month, amount_minor=cents)
        )
    db.flush()

    _shared_demo(db, user, today, checking=checking.id, card=card.id, acct=acct)


def _shared_demo(db: Session, user: User, today: date, *, checking, card, acct) -> None:
    """Friends, two groups and a few split bills, so the Shared page tells a story."""
    travel = ledger.create_account(
        db, user, name="Travel", account_type=AccountType.EXPENSE, currency="USD"
    )
    f = {n: sharing.create_friend(db, user, n).id for n in ("Alex", "Priya", "Sam", "Jordan")}
    roommates = sharing.set_group(
        db, user, None, name="Roommates", member_ids=[f["Alex"], f["Priya"]]
    )
    trip = sharing.set_group(
        db, user, None, name="Tahoe ski trip", member_ids=[f["Alex"], f["Sam"], f["Jordan"]]
    )
    me = sharing.Participant(None)

    def bill(
        days_ago, description, cents, category, *, group=None, payer=None, people, method="equal"
    ):
        sharing.post_shared_expense(
            db,
            user,
            occurred_on=today - timedelta(days=days_ago),
            description=description,
            total_minor=cents,
            category_id=acct[category].id if category in acct else travel.id,
            payer_id=payer,
            paid_from_id=None if payer else card,
            group_id=group.id if group else None,
            method=method,
            participants=people,
        )

    house = [me, sharing.Participant(f["Alex"]), sharing.Participant(f["Priya"])]
    for months_ago in (2, 1, 0):
        days = months_ago * 30 + 3
        bill(days, "Spectrum internet", 89_97, "Utilities", group=roommates, people=house)
    bill(
        26,
        "Costco: paper towels, coffee",
        64_50,
        "Groceries",
        group=roommates,
        payer=f["Priya"],
        people=house,
    )
    bill(9, "Cleaning supplies", 31_20, "Shopping", group=roommates, payer=f["Alex"], people=house)

    crew = [me, *(sharing.Participant(f[n]) for n in ("Alex", "Sam", "Jordan"))]
    bill(40, "Cabin rental, 3 nights", 960_00, "Travel", group=trip, payer=f["Sam"], people=crew)
    bill(39, "Lift tickets", 516_00, "Travel", group=trip, people=crew)
    bill(
        38,
        "Groceries for the cabin",
        142_80,
        "Groceries",
        group=trip,
        payer=f["Alex"],
        method="shares",
        people=[
            sharing.Participant(None, weight=1),
            sharing.Participant(f["Alex"], weight=2),  # Alex brought his partner
            sharing.Participant(f["Sam"], weight=1),
            sharing.Participant(f["Jordan"], weight=1),
        ],
    )
    bill(
        12,
        "Birthday dinner",
        186_40,
        "Dining",
        method="exact",
        people=[
            sharing.Participant(None, amount_minor=96_40),
            sharing.Participant(f["Priya"], amount_minor=90_00),
        ],
    )

    for friend, cents, direction, days_ago, group in [
        ("Alex", 29_99, "they_paid", 55, roommates),
        ("Sam", 240_00, "you_paid", 30, trip),
        ("Jordan", 129_00, "they_paid", 20, trip),
    ]:
        sharing.post_settlement(
            db,
            user,
            friend_id=f[friend],
            account_id=checking,
            amount_minor=cents,
            direction=direction,
            occurred_on=today - timedelta(days=days_ago),
            group_id=group.id,
        )
