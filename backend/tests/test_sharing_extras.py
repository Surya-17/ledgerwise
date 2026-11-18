"""Percent / adjustment / itemized splits, notes, editing, repeating bills, group totals."""

import uuid
from datetime import date, timedelta

from fastapi.testclient import TestClient
from hypothesis import given
from hypothesis import strategies as st

from app.services.sharing import itemized_shares, next_occurrence
from tests.test_sharing import _balances, _expense, _setup

# --- Itemized (pure) ------------------------------------------------------------------

ME = None
A, B, C = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
PEOPLE = [ME, A, B, C]


@given(
    items=st.lists(
        st.tuples(
            st.integers(min_value=1, max_value=10**7),
            st.sets(st.sampled_from(range(4)), min_size=1),
        ),
        min_size=1,
        max_size=20,
    ),
    extras=st.integers(min_value=-(10**5), max_value=10**6),
)
def test_itemized_always_adds_up_to_the_cent(items, extras) -> None:
    from app.services.sharing import Item

    item_objs = [Item("x", amt, tuple(PEOPLE[i] for i in sorted(who))) for amt, who in items]
    subtotal = sum(amt for amt, _ in items)
    if extras < 0 and -extras > subtotal:
        return
    shares = itemized_shares(PEOPLE, item_objs, extras)
    assert sum(shares) == subtotal + extras
    assert all(s >= 0 for s in shares)


def test_monthly_bills_keep_their_day_of_month() -> None:
    d = date(2026, 1, 31)
    seq = []
    for _ in range(4):
        d = next_occurrence(d, "monthly", 31)
        seq.append(d)
    assert seq == [date(2026, 2, 28), date(2026, 3, 31), date(2026, 4, 30), date(2026, 5, 31)]
    assert next_occurrence(date(2026, 12, 15), "monthly", 15) == date(2027, 1, 15)
    assert next_occurrence(date(2026, 12, 29), "weekly", 29) == date(2027, 1, 5)


# --- New split methods ----------------------------------------------------------------


def test_percent_split(client: TestClient, auth: dict) -> None:
    ids = _setup(client, auth)
    body = _expense(
        ids,
        total_minor=10000,
        method="percent",
        participants=[
            {"percent_bp": 3333},
            {"account_id": ids["Alex"], "percent_bp": 3333},
            {"account_id": ids["Sam"], "percent_bp": 3334},
        ],
    )
    r = client.post("/api/shared/expenses", headers=auth, json=body)
    assert r.status_code == 201, r.text
    b = _balances(client, auth)
    assert (b["Dining"], b["Alex"], b["Sam"]) == (3333, 3333, 3334)

    body["participants"][2]["percent_bp"] = 3000
    r = client.post("/api/shared/expenses", headers=auth, json=body)
    assert r.status_code == 422 and "96.66%" in r.text


def test_adjustment_split(client: TestClient, auth: dict) -> None:
    ids = _setup(client, auth)
    # Alex had an extra $10 drink; the rest is split evenly.
    body = _expense(
        ids,
        total_minor=10000,
        method="adjust",
        participants=[{}, {"account_id": ids["Alex"], "adjust_minor": 1000}],
    )
    assert client.post("/api/shared/expenses", headers=auth, json=body).status_code == 201
    b = _balances(client, auth)
    assert b["Dining"] == 4500 and b["Alex"] == 5500

    body["participants"][1]["adjust_minor"] = 20000
    r = client.post("/api/shared/expenses", headers=auth, json=body)
    assert r.status_code == 422 and "more than the bill" in r.text


def test_itemized_receipt_with_tax_and_tip(client: TestClient, auth: dict) -> None:
    ids = _setup(client, auth)
    body = _expense(
        ids,
        total_minor=4000,
        method="itemized",
        participants=[{}, {"account_id": ids["Alex"]}],
        items=[
            {"name": "Pizza", "amount_minor": 2000, "account_ids": [None, ids["Alex"]]},
            {"name": "Beer", "amount_minor": 1200, "account_ids": [ids["Alex"]]},
        ],
        extras_minor=800,
        notes="Tip was 20%",
    )
    r = client.post("/api/shared/expenses", headers=auth, json=body)
    assert r.status_code == 201, r.text
    out = r.json()
    # Subtotals 10.00 / 22.00; $8 tax+tip spread 10:22 -> 2.50 / 5.50.
    assert out["my_share_minor"] == 1250
    assert _balances(client, auth)["Alex"] == 2750
    assert out["notes"] == "Tip was 20%"
    assert [i["name"] for i in out["details"]["items"]] == ["Pizza", "Beer"]
    assert out["details"]["extras_minor"] == 800

    body["total_minor"] = 3900  # doesn't match the receipt
    r = client.post("/api/shared/expenses", headers=auth, json=body)
    assert r.status_code == 422 and "Items plus tax and tip" in r.text
    body |= {"total_minor": 3000, "extras_minor": -200}  # a $2 coupon
    assert client.post("/api/shared/expenses", headers=auth, json=body).status_code == 201


# --- Editing --------------------------------------------------------------------------


def test_editing_a_bill_reverses_and_reposts(client: TestClient, auth: dict) -> None:
    ids = _setup(client, auth)
    old = client.post("/api/shared/expenses", headers=auth, json=_expense(ids)).json()
    new_body = _expense(
        ids, total_minor=12000, description="Dinner (fixed)", notes="Forgot dessert"
    )
    h = auth | {"Idempotency-Key": "edit-1"}
    r = client.put(f"/api/shared/expenses/{old['id']}", headers=h, json=new_body)
    assert r.status_code == 200, r.text
    new = r.json()
    assert new["edited_from_id"] == old["id"]
    assert new["paid_from_id"] == ids["checking"]  # so the edit form can reopen it
    assert [x["account_id"] for x in new["details"]["participants"]] == [
        None,
        ids["Alex"],
        ids["Sam"],
    ]
    again = client.put(f"/api/shared/expenses/{old['id']}", headers=h, json=new_body)
    assert again.headers.get("Idempotent-Replayed") == "true"

    [only] = client.get("/api/shared", headers=auth).json()
    assert only["id"] == new["id"] and only["description"] == "Dinner (fixed)"
    b = _balances(client, auth)
    assert b["Alex"] == 4000 and b["Checking"] == 100_000 - 12000
    # The old version can't be edited twice.
    r = client.put(f"/api/shared/expenses/{old['id']}", headers=auth, json=new_body)
    assert r.status_code == 409


# --- Repeating bills ------------------------------------------------------------------


def test_repeating_bill_posts_due_months_exactly_once(client: TestClient, auth: dict) -> None:
    ids = _setup(client, auth)
    first = date.today() - timedelta(days=75)
    body = _expense(ids, occurred_on=first.isoformat(), description="Internet", repeat="monthly")
    r = client.post("/api/shared/expenses", headers=auth, json=body)
    assert r.status_code == 201, r.text
    assert r.json()["recurring_id"]

    expected = 0
    d = first
    while (d := next_occurrence(d, "monthly", first.day)) <= date.today():
        expected += 1
    assert client.post("/api/shared/recurring/run", headers=auth).json() == {"posted": expected}
    assert client.post("/api/shared/recurring/run", headers=auth).json() == {"posted": 0}
    bills = client.get("/api/shared", headers=auth).json()
    assert len(bills) == 1 + expected
    assert _balances(client, auth)["Alex"] == 3000 * (1 + expected)

    [rec] = client.get("/api/shared/recurring", headers=auth).json()
    assert rec["description"] == "Internet" and rec["next_on"] > date.today().isoformat()
    r = client.post(f"/api/shared/recurring/{rec['id']}/stop", headers=auth)
    assert r.status_code == 200 and r.json()["is_active"] is False
    assert client.get("/api/shared/recurring", headers=auth).json() == []

    # Repeating is only for new bills.
    r = client.put(f"/api/shared/expenses/{bills[0]['id']}", headers=auth, json=body)
    assert r.status_code == 422


def test_repeating_bills_are_private(client: TestClient, auth: dict) -> None:
    from tests.conftest import register

    ids = _setup(client, auth)
    body = _expense(ids, repeat="weekly")
    client.post("/api/shared/expenses", headers=auth, json=body)
    [rec] = client.get("/api/shared/recurring", headers=auth).json()
    other = register(client)
    assert client.get("/api/shared/recurring", headers=other).json() == []
    assert client.post(f"/api/shared/recurring/{rec['id']}/stop", headers=other).status_code == 404


# --- Group totals ---------------------------------------------------------------------


def test_group_summary(client: TestClient, auth: dict) -> None:
    ids = _setup(client, auth)
    g = client.post(
        "/api/groups", headers=auth, json={"name": "Trip", "member_ids": [ids["Alex"], ids["Sam"]]}
    ).json()
    client.post("/api/shared/expenses", headers=auth, json=_expense(ids, group_id=g["id"]))
    alex_paid = _expense(
        ids, group_id=g["id"], payer_id=ids["Alex"], paid_from_id=None, occurred_on="2026-04-02"
    )
    client.post("/api/shared/expenses", headers=auth, json=alex_paid)
    s = client.get(f"/api/groups/{g['id']}/summary", headers=auth).json()
    assert s["total_spent_minor"] == 18000 and s["bill_count"] == 2
    assert s["my_share_minor"] == 6000
    assert s["paid_by"] == {"me": 9000, ids["Alex"]: 9000}
    assert s["my_share_by_category"] == {ids["dining"]: 6000}
    assert s["by_month"] == {"2026-03": 9000, "2026-04": 9000}
