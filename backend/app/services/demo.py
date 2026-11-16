"""Realistic, deterministic demo activity: six months of pay, bills, card spending and budgets.

Everything goes through the same service layer the API uses, so demo ledgers obey
every invariant (balanced entries, audit trail, import fingerprints).
"""

import random
from collections.abc import Iterator
from datetime import date, timedelta

from sqlalchemy.orm import Session

from app.models import AccountType, Budget, CategoryRule, User
from app.services import imports, ledger, reports

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
