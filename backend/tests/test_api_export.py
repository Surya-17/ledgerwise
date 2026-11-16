import csv
import io
from collections import defaultdict
from decimal import Decimal

from fastapi.testclient import TestClient

from tests.conftest import accounts_by_name, register


def _post(client: TestClient, auth: dict, desc: str, lines: list[tuple[str, int]], on="2026-03-05"):
    r = client.post(
        "/api/entries",
        headers=auth,
        json={
            "occurred_on": on,
            "description": desc,
            "lines": [{"account_id": a, "amount_minor": m} for a, m in lines],
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def _export(client: TestClient, auth: dict, query: str = "") -> list[dict[str, str]]:
    r = client.get(f"/api/entries/export{query}", headers=auth)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"]
    return list(csv.DictReader(io.StringIO(r.text)))


def test_export_is_a_balanced_journal_with_exact_decimals(client: TestClient, auth: dict) -> None:
    checking = client.post(
        "/api/accounts", headers=auth, json={"name": "Checking", "type": "asset"}
    )
    cid = checking.json()["id"]
    accts = accounts_by_name(client, auth)
    _post(client, auth, "Groceries", [(accts["Groceries"]["id"], 84_20), (cid, -84_20)])
    _post(
        client,
        auth,
        "Split",
        [(accts["Dining"]["id"], 10_01), (accts["Rent"]["id"], 99), (cid, -11_00)],
    )

    rows = _export(client, auth)
    assert len(rows) == 5
    per_entry: dict[str, Decimal] = defaultdict(Decimal)
    for row in rows:
        per_entry[row["entry_id"]] += Decimal(row["debit"] or "0") - Decimal(row["credit"] or "0")
    assert set(per_entry.values()) == {Decimal("0.00")}
    groceries = next(r for r in rows if r["account"] == "Groceries")
    assert groceries["debit"] == "84.20" and groceries["credit"] == ""


def test_export_respects_filters_and_neutralizes_formulas(client: TestClient, auth: dict) -> None:
    cid = client.post("/api/accounts", headers=auth, json={"name": "Checking", "type": "asset"})
    cid = cid.json()["id"]
    food = accounts_by_name(client, auth)["Groceries"]["id"]
    _post(client, auth, '=HYPERLINK("http://evil")', [(food, 1_00), (cid, -1_00)], on="2026-01-10")
    _post(client, auth, "Market", [(food, 2_00), (cid, -2_00)], on="2026-02-10")

    feb = _export(client, auth, "?start=2026-02-01")
    assert {r["description"] for r in feb} == {"Market"}

    jan = _export(client, auth, "?q=hyperlink")
    assert jan and all(r["description"].startswith("'=") for r in jan)


def test_export_only_includes_the_callers_entries(client: TestClient, auth: dict) -> None:
    cid = client.post("/api/accounts", headers=auth, json={"name": "Checking", "type": "asset"})
    food = accounts_by_name(client, auth)["Groceries"]["id"]
    _post(client, auth, "Mine", [(food, 5_00), (cid.json()["id"], -5_00)])

    other = register(client)
    assert _export(client, other) == []
