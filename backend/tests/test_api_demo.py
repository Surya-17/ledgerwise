from datetime import date

from fastapi.testclient import TestClient

from app.routers import auth as auth_router
from tests.conftest import accounts_by_name


def _demo(client: TestClient, ip: str = "203.0.113.7") -> dict:
    r = client.post("/api/auth/demo", headers={"X-Forwarded-For": ip})
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def test_demo_sandbox_is_seeded_and_balanced(client: TestClient) -> None:
    headers = _demo(client)
    me = client.get("/api/auth/me", headers=headers).json()
    assert me["email"].endswith("@demo.ledgerwise.app")

    accounts = accounts_by_name(client, headers)
    assert {"Checking", "High-Yield Savings", "Visa Card"} <= accounts.keys()

    # Double-entry invariant over the whole seeded ledger.
    raw_total = 0
    for a in accounts.values():
        sign = 1 if a["type"] in ("asset", "expense") else -1
        raw_total += a["balance_minor"] * sign
    assert raw_total == 0

    assert client.get("/api/budgets", headers=headers).json()
    assert len(client.get("/api/imports", headers=headers).json()) == 1


def test_each_demo_visitor_gets_a_private_ledger(client: TestClient) -> None:
    first, second = _demo(client, "198.51.100.1"), _demo(client, "198.51.100.2")
    entry = client.get("/api/entries?limit=1", headers=first).json()[0]
    assert client.get(f"/api/entries/{entry['id']}", headers=second).status_code == 404


def test_demo_creation_is_rate_limited_per_ip(client: TestClient) -> None:
    for _ in range(auth_router.DEMO_LIMIT_PER_HOUR):
        _demo(client, "192.0.2.50")
    r = client.post("/api/auth/demo", headers={"X-Forwarded-For": "192.0.2.50"})
    assert r.status_code == 429
    _demo(client, "192.0.2.51")  # other addresses are unaffected


def test_spending_by_category_matches_budget_actuals(client: TestClient) -> None:
    headers = _demo(client)
    month = date.today().replace(day=1).isoformat()
    spending = client.get(f"/api/reports/spending?month={month}", headers=headers).json()
    assert spending, "demo data should have spending this month"
    amounts = [c["spent_minor"] for c in spending]
    assert amounts == sorted(amounts, reverse=True)

    by_id = {c["account_id"]: c["spent_minor"] for c in spending}
    for line in client.get(f"/api/budgets?month={month}", headers=headers).json():
        assert by_id.get(line["account_id"], 0) == line["spent_minor"]


def test_rate_limit_ignores_spoofed_forwarded_hops(client: TestClient) -> None:
    for i in range(auth_router.DEMO_LIMIT_PER_HOUR):
        _demo(client, f"10.0.0.{i}, 192.0.2.99")
    r = client.post("/api/auth/demo", headers={"X-Forwarded-For": "10.9.9.9, 192.0.2.99"})
    assert r.status_code == 429
