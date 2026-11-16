from datetime import date

from fastapi.testclient import TestClient

from app.services.reports import add_months, month_range, month_start
from tests.conftest import accounts_by_name


def _post(client: TestClient, auth: dict, on: date, lines: list[tuple[str, int]]) -> None:
    r = client.post(
        "/api/entries",
        headers=auth,
        json={
            "occurred_on": on.isoformat(),
            "description": "x",
            "lines": [{"account_id": a, "amount_minor": amt} for a, amt in lines],
        },
    )
    assert r.status_code == 201, r.text


def test_month_helpers() -> None:
    assert add_months(date(2026, 1, 31), 1) == date(2026, 2, 1)
    assert add_months(date(2026, 1, 15), -1) == date(2025, 12, 1)
    assert month_range(date(2025, 11, 20), date(2026, 2, 3)) == [
        date(2025, 11, 1),
        date(2025, 12, 1),
        date(2026, 1, 1),
        date(2026, 2, 1),
    ]


def test_cash_flow_net_worth_and_budget(client: TestClient, auth: dict) -> None:
    this_month = month_start(date.today())
    last_month = add_months(this_month, -1)

    checking = client.post(
        "/api/accounts",
        headers=auth,
        json={
            "name": "Checking",
            "type": "asset",
            "opening_balance_minor": 100_000,
            "opening_date": add_months(this_month, -6).isoformat(),
        },
    ).json()["id"]
    card = client.post(
        "/api/accounts", headers=auth, json={"name": "Visa", "type": "liability"}
    ).json()["id"]
    a = accounts_by_name(client, auth)
    salary, groceries = a["Salary"]["id"], a["Groceries"]["id"]

    _post(client, auth, last_month, [(checking, 300_000), (salary, -300_000)])
    _post(client, auth, last_month, [(groceries, 20_000), (card, -20_000)])
    _post(client, auth, this_month, [(groceries, 5_000), (card, -5_000)])

    flow = client.get("/api/reports/cash-flow?months=2", headers=auth).json()
    assert flow == [
        {
            "month": last_month.strftime("%Y-%m"),
            "income_minor": 300_000,
            "expense_minor": 20_000,
            "net_minor": 280_000,
        },
        {
            "month": this_month.strftime("%Y-%m"),
            "income_minor": 0,
            "expense_minor": 5_000,
            "net_minor": -5_000,
        },
    ]

    worth = client.get("/api/reports/net-worth?months=2", headers=auth).json()
    assert [p["net_worth_minor"] for p in worth] == [
        100_000 + 300_000 - 20_000,
        100_000 + 300_000 - 20_000 - 5_000,
    ]

    r = client.put(
        "/api/budgets",
        headers=auth,
        json={"account_id": groceries, "month": this_month.isoformat(), "amount_minor": 40_000},
    )
    assert r.status_code == 200, r.text
    # Upsert: same month again replaces rather than duplicates.
    client.put(
        "/api/budgets",
        headers=auth,
        json={"account_id": groceries, "month": this_month.isoformat(), "amount_minor": 30_000},
    )
    report = client.get("/api/budgets", headers=auth).json()
    assert len(report) == 1
    assert report[0]["budget_minor"] == 30_000
    assert report[0]["spent_minor"] == 5_000
    assert report[0]["remaining_minor"] == 25_000


def test_budget_only_on_expense_accounts(client: TestClient, auth: dict) -> None:
    salary = accounts_by_name(client, auth)["Salary"]["id"]
    r = client.put(
        "/api/budgets",
        headers=auth,
        json={"account_id": salary, "month": "2026-01-01", "amount_minor": 100},
    )
    assert r.status_code == 422
