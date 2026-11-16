"""Importing both sides of a transfer must not double-count it."""

from fastapi.testclient import TestClient

from tests.conftest import accounts_by_name
from tests.test_api_imports import _upload

CHECKING = b"""Date,Description,Amount
2026-03-01,ACME PAYROLL,"2,500.00"
2026-03-02,Online transfer to savings,-500.00
2026-03-09,Online transfer to savings,-200.00
2026-03-09,Online transfer to savings,-200.00
"""

SAVINGS = b"""Date,Description,Amount
2026-03-03,Transfer from checking,500.00
2026-03-10,Transfer from checking,200.00
2026-03-11,Transfer from checking,200.00
2026-03-28,Interest paid,4.10
"""


def _accounts(client: TestClient, auth: dict) -> tuple[str, str]:
    ids = []
    for name in ("Checking", "Savings"):
        r = client.post("/api/accounts", headers=auth, json={"name": name, "type": "asset"})
        ids.append(r.json()["id"])
    return ids[0], ids[1]


def _cash_flow_totals(client: TestClient, auth: dict) -> tuple[int, int]:
    accts = accounts_by_name(client, auth)
    return (
        accts["Uncategorized Income"]["balance_minor"],
        accts["Uncategorized Expense"]["balance_minor"],
    )


def test_both_sides_of_a_transfer_become_one_entry(client: TestClient, auth: dict) -> None:
    checking, savings = _accounts(client, auth)
    assert _upload(client, auth, checking, CHECKING).status_code == 201
    r = _upload(client, auth, savings, SAVINGS)
    assert r.status_code == 201, r.text
    batch = r.json()
    assert batch["imported_count"] == 4
    assert batch["transfer_count"] == 3  # 500 + both 200s; interest is real income

    accts = accounts_by_name(client, auth)
    assert accts["Checking"]["balance_minor"] == 2_500_00 - 900_00
    assert accts["Savings"]["balance_minor"] == 900_00 + 4_10
    # Only payroll and interest remain as income; no phantom transfer spending.
    assert _cash_flow_totals(client, auth) == (2_500_00 + 4_10, 0)

    transfers = [
        e
        for e in client.get("/api/entries?q=transfer from", headers=auth).json()
        if e["source"] == "import"
    ]
    assert len(transfers) == 3
    for e in transfers:
        assert {ln["account_id"] for ln in e["lines"]} == {checking, savings}


def test_reimporting_either_statement_after_a_merge_is_a_no_op(
    client: TestClient, auth: dict
) -> None:
    checking, savings = _accounts(client, auth)
    _upload(client, auth, checking, CHECKING)
    _upload(client, auth, savings, SAVINGS)
    before = accounts_by_name(client, auth)

    for account, content in ((checking, CHECKING), (savings, SAVINGS)):
        r = _upload(client, auth, account, content).json()
        assert r["imported_count"] == 0
        assert r["transfer_count"] == 0

    assert accounts_by_name(client, auth) == before


def test_rows_outside_the_window_are_not_matched(client: TestClient, auth: dict) -> None:
    checking, savings = _accounts(client, auth)
    _upload(client, auth, checking, b"Date,Description,Amount\n2026-03-01,Transfer out,-50.00\n")
    r = _upload(client, auth, savings, b"Date,Description,Amount\n2026-03-09,Transfer in,50.00\n")
    assert r.json()["transfer_count"] == 0
    assert _cash_flow_totals(client, auth) == (50_00, 50_00)


def test_categorized_entries_are_left_alone(client: TestClient, auth: dict) -> None:
    """A matching amount that the user (or a rule) categorized is a real expense, not a transfer."""
    checking, savings = _accounts(client, auth)
    rent = accounts_by_name(client, auth)["Rent"]["id"]
    client.post("/api/rules", headers=auth, json={"pattern": "landlord", "account_id": rent})
    _upload(client, auth, checking, b"Date,Description,Amount\n2026-03-01,Landlord LLC,-500.00\n")
    r = _upload(client, auth, savings, b"Date,Description,Amount\n2026-03-02,Deposit,500.00\n")
    assert r.json()["transfer_count"] == 0
    assert accounts_by_name(client, auth)["Rent"]["balance_minor"] == 500_00


def test_each_earlier_entry_is_claimed_once(client: TestClient, auth: dict) -> None:
    """Two incoming 200s cannot both pair with a single outgoing 200."""
    checking, savings = _accounts(client, auth)
    _upload(client, auth, checking, b"Date,Description,Amount\n2026-03-09,Transfer,-200.00\n")
    r = _upload(
        client,
        auth,
        savings,
        b"Date,Description,Amount\n2026-03-09,Transfer,200.00\n2026-03-10,Transfer,200.00\n",
    )
    assert r.json()["transfer_count"] == 1
    assert accounts_by_name(client, auth)["Savings"]["balance_minor"] == 400_00
    assert _cash_flow_totals(client, auth) == (200_00, 0)
