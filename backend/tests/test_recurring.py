from datetime import date

from fastapi.testclient import TestClient

from app.services.recurring import _add_months, merchant_key
from tests.conftest import accounts_by_name

TODAY = date.today()


def _post(client: TestClient, auth: dict, on: date, desc: str, debit: str, credit: str, cents: int):
    r = client.post(
        "/api/entries",
        headers=auth,
        json={
            "occurred_on": on.isoformat(),
            "description": desc,
            "lines": [
                {"account_id": debit, "amount_minor": cents},
                {"account_id": credit, "amount_minor": -cents},
            ],
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def _spend(client: TestClient, auth: dict, ids: dict, on: date, desc: str, cents: int):
    return _post(client, auth, on, desc, ids["Shopping"], ids["Checking"], cents)


def _setup(client: TestClient, auth: dict) -> dict[str, str]:
    for name in ("Checking", "Savings"):
        client.post("/api/accounts", headers=auth, json={"name": name, "type": "asset"})
    return {name: a["id"] for name, a in accounts_by_name(client, auth).items()}


def _recurring(client: TestClient, auth: dict) -> dict[str, dict]:
    r = client.get("/api/reports/recurring", headers=auth)
    assert r.status_code == 200, r.text
    return {s["key"]: s for s in r.json()}


def _months_ago(n: int, day: int) -> date:
    return _add_months(TODAY.replace(day=1), -n).replace(day=day)


def test_merchant_key_strips_store_numbers_and_ids() -> None:
    assert merchant_key("WHOLE FOODS MARKET #1042") == "whole foods market"
    assert merchant_key("NETFLIX.COM 866-579-7172") == merchant_key("Netflix.com")
    assert merchant_key("Shell Oil 5543") == "shell oil"
    assert merchant_key("Trader Joe's") == "trader joe's"


def test_add_months_clamps_to_month_end() -> None:
    assert _add_months(date(2026, 1, 31), 1) == date(2026, 2, 28)
    assert _add_months(date(2028, 1, 31), 1) == date(2028, 2, 29)
    assert _add_months(date(2026, 12, 15), 1) == date(2027, 1, 15)


def test_monthly_subscription_is_detected(client: TestClient, auth: dict) -> None:
    ids = _setup(client, auth)
    for n in (3, 2, 1, 0):
        on = _months_ago(n, 1)
        _post(client, auth, on, f"NETFLIX.COM {n}88", ids["Shopping"], ids["Checking"], 15_49)

    s = _recurring(client, auth)["netflix com"]
    assert s["cadence"] == "monthly"
    assert s["direction"] == "out"
    assert s["amount_minor"] == 15_49
    assert s["fixed_amount"] is True
    assert s["monthly_minor"] == 15_49
    assert s["occurrences"] == 4
    assert s["status"] == "active"
    assert s["next_date"] == _add_months(_months_ago(0, 1), 1).isoformat()


def test_semimonthly_payroll_and_weekly_variable_spend(client: TestClient, auth: dict) -> None:
    ids = _setup(client, auth)
    for n in (2, 1, 0):
        for day in (1, 15):
            on = _months_ago(n, day)
            if on <= TODAY:
                _post(client, auth, on, "ACME Payroll", ids["Checking"], ids["Salary"], 3_000_00)
    found = _recurring(client, auth)["acme payroll"]
    assert found["cadence"] == "semimonthly"
    assert found["direction"] == "in"
    assert found["monthly_minor"] == 6_000_00


def test_irregular_and_transfer_activity_is_ignored(client: TestClient, auth: dict) -> None:
    ids = _setup(client, auth)
    for n, day in ((3, 2), (3, 25), (2, 9), (0, 1)):
        _spend(client, auth, ids, _months_ago(n, day), "Best Buy", 99_00)
    for n in (3, 2, 1, 0):  # perfectly regular, but between own accounts
        on = _months_ago(n, 1)
        _post(client, auth, on, "To savings", ids["Savings"], ids["Checking"], 500_00)
    found = _recurring(client, auth)
    assert "best buy" not in found
    assert "to savings" not in found


def test_stopped_subscription_is_lapsed_and_reversals_dont_count(
    client: TestClient, auth: dict
) -> None:
    ids = _setup(client, auth)
    for n in (6, 5, 4, 3):
        _spend(client, auth, ids, _months_ago(n, 3), "Planet Fitness", 24_99)
    assert _recurring(client, auth)["planet fitness"]["status"] == "lapsed"

    # A reversed charge is not an occurrence: three live charges, then one reversed.
    for n in (3, 2, 1):
        _spend(client, auth, ids, _months_ago(n, 5), "Spotify", 11_99)
    e = _spend(client, auth, ids, _months_ago(0, 5), "Spotify", 11_99)
    client.post(f"/api/entries/{e['id']}/reverse", headers=auth)
    assert _recurring(client, auth)["spotify"]["occurrences"] == 3
