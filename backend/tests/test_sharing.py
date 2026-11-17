"""Split bills: exact allocation, ledger effect, groups, settle-up, idempotency."""

from fastapi.testclient import TestClient
from hypothesis import given
from hypothesis import strategies as st

from app.errors import LedgerError
from app.services.sharing import allocate
from tests.conftest import accounts_by_name

# --- allocate (pure) ------------------------------------------------------------------


@given(
    total=st.integers(min_value=1, max_value=10**12),
    weights=st.lists(st.integers(min_value=1, max_value=1000), min_size=1, max_size=50),
)
def test_allocate_is_exact_and_fair(total: int, weights: list[int]) -> None:
    shares = allocate(total, weights)
    assert sum(shares) == total
    whole = sum(weights)
    for share, w in zip(shares, weights, strict=True):
        # Never more than one minor unit away from the exact proportional share.
        assert abs(share * whole - total * w) < whole


def test_allocate_gives_leftover_cents_to_earlier_people() -> None:
    assert allocate(100, [1, 1, 1]) == [34, 33, 33]
    assert allocate(1000, [2, 1, 1]) == [500, 250, 250]


def test_allocate_rejects_bad_input() -> None:
    for total, weights in [(0, [1]), (100, []), (100, [1, 0])]:
        try:
            allocate(total, weights)
        except LedgerError:
            continue
        raise AssertionError(f"accepted {total}, {weights}")


# --- API ------------------------------------------------------------------------------


def _setup(client: TestClient, auth: dict) -> dict:
    r = client.post(
        "/api/accounts",
        headers=auth,
        json={"name": "Checking", "type": "asset", "opening_balance_minor": 100_000},
    )
    assert r.status_code == 201
    ids = {"checking": r.json()["id"], "dining": accounts_by_name(client, auth)["Dining"]["id"]}
    for name in ("Alex", "Sam", "Priya"):
        r = client.post("/api/friends", headers=auth, json={"name": name})
        assert r.status_code == 201, r.text
        assert r.json()["kind"] == "friend"
        ids[name] = r.json()["id"]
    return ids


def _balances(client: TestClient, auth: dict) -> dict[str, int]:
    return {a["name"]: a["balance_minor"] for a in client.get("/api/accounts", headers=auth).json()}


def _expense(ids: dict, **overrides) -> dict:
    body = {
        "occurred_on": "2026-03-14",
        "description": "Dinner",
        "total_minor": 9000,
        "category_id": ids["dining"],
        "paid_from_id": ids["checking"],
        "participants": [{}, {"account_id": ids["Alex"]}, {"account_id": ids["Sam"]}],
    }
    return body | overrides


def test_you_pay_and_split_equally(client: TestClient, auth: dict) -> None:
    ids = _setup(client, auth)
    r = client.post("/api/shared/expenses", headers=auth, json=_expense(ids, total_minor=10000))
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["my_share_minor"] == 3334  # the leftover cent lands on the first person
    assert out["category_id"] == ids["dining"]
    b = _balances(client, auth)
    assert b["Dining"] == 3334
    assert b["Alex"] == 3333 and b["Sam"] == 3333  # they owe you
    assert b["Checking"] == 100_000 - 10000
    entry = client.get(f"/api/entries/{out['entry_id']}", headers=auth).json()
    assert sum(ln["amount_minor"] for ln in entry["lines"]) == 0


def test_friend_pays_only_your_share_hits_your_books(client: TestClient, auth: dict) -> None:
    ids = _setup(client, auth)
    body = _expense(ids, payer_id=ids["Alex"], paid_from_id=None)
    r = client.post("/api/shared/expenses", headers=auth, json=body)
    assert r.status_code == 201, r.text
    b = _balances(client, auth)
    assert b["Dining"] == 3000
    assert b["Alex"] == -3000  # you owe Alex
    assert b["Sam"] == 0  # Sam's debt is to Alex, not you
    assert b["Checking"] == 100_000


def test_exact_and_share_methods(client: TestClient, auth: dict) -> None:
    ids = _setup(client, auth)
    exact = _expense(
        ids,
        method="exact",
        participants=[
            {"amount_minor": 5000},
            {"account_id": ids["Alex"], "amount_minor": 4000},
        ],
    )
    assert client.post("/api/shared/expenses", headers=auth, json=exact).status_code == 201
    shares = _expense(
        ids,
        total_minor=8000,
        method="shares",
        participants=[{"weight": 1}, {"account_id": ids["Sam"], "weight": 3}],
    )
    assert client.post("/api/shared/expenses", headers=auth, json=shares).status_code == 201
    b = _balances(client, auth)
    assert b["Dining"] == 5000 + 2000
    assert b["Alex"] == 4000 and b["Sam"] == 6000

    bad = _expense(ids, method="exact", participants=[{"amount_minor": 1}])
    r = client.post("/api/shared/expenses", headers=auth, json=bad)
    assert r.status_code == 422 and "add up" in r.text


def test_split_for_friends_only_without_your_share(client: TestClient, auth: dict) -> None:
    ids = _setup(client, auth)
    body = _expense(ids, participants=[{"account_id": ids["Alex"]}, {"account_id": ids["Sam"]}])
    assert client.post("/api/shared/expenses", headers=auth, json=body).status_code == 201
    b = _balances(client, auth)
    assert b["Dining"] == 0 and b["Alex"] == 4500 and b["Sam"] == 4500


def test_rejects_nonsense_splits(client: TestClient, auth: dict) -> None:
    ids = _setup(client, auth)
    cases = [
        _expense(ids, participants=[{}]),  # nobody to split with
        _expense(ids, payer_id=ids["Alex"], participants=[{"account_id": ids["Sam"]}]),
        _expense(ids, paid_from_id=None),
        _expense(ids, paid_from_id=ids["Alex"]),  # can't "pay from" a friend
        _expense(ids, category_id=ids["checking"]),
        _expense(ids, participants=[{}, {}]),
    ]
    for body in cases:
        r = client.post("/api/shared/expenses", headers=auth, json=body)
        assert r.status_code in (404, 422), (body, r.text)
    assert _balances(client, auth)["Checking"] == 100_000


def test_groups_track_their_own_balances_and_membership(client: TestClient, auth: dict) -> None:
    ids = _setup(client, auth)
    r = client.post(
        "/api/groups", headers=auth, json={"name": "Roommates", "member_ids": [ids["Alex"]]}
    )
    assert r.status_code == 201, r.text
    group = r.json()

    body = _expense(ids, group_id=group["id"])  # Sam isn't a roommate
    assert client.post("/api/shared/expenses", headers=auth, json=body).status_code == 422

    body = _expense(ids, group_id=group["id"], participants=[{}, {"account_id": ids["Alex"]}])
    assert client.post("/api/shared/expenses", headers=auth, json=body).status_code == 201
    # A bill outside the group doesn't show up in it.
    assert client.post("/api/shared/expenses", headers=auth, json=_expense(ids)).status_code == 201

    [g] = client.get("/api/groups", headers=auth).json()
    assert g["balances"] == {ids["Alex"]: 4500}
    assert g["total_spent_minor"] == 9000
    assert len(client.get(f"/api/shared?group_id={g['id']}", headers=auth).json()) == 1

    r = client.patch(
        f"/api/groups/{g['id']}", headers=auth, json={"member_ids": [ids["Alex"], ids["Sam"]]}
    )
    assert r.json()["member_ids"] == [ids["Alex"], ids["Sam"]]
    assert client.delete(f"/api/groups/{g['id']}", headers=auth).status_code == 204
    # Deleting a group never deletes money: the bills and balances remain.
    assert len(client.get("/api/shared", headers=auth).json()) == 2
    assert _balances(client, auth)["Alex"] == 4500 + 3000


def test_settle_up_zeroes_the_balance(client: TestClient, auth: dict) -> None:
    ids = _setup(client, auth)
    client.post("/api/shared/expenses", headers=auth, json=_expense(ids))
    r = client.post(
        "/api/shared/settlements",
        headers=auth,
        json={
            "friend_id": ids["Alex"],
            "account_id": ids["checking"],
            "amount_minor": 3000,
            "direction": "they_paid",
            "occurred_on": "2026-03-15",
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["description"] == "Alex paid you back"
    b = _balances(client, auth)
    assert b["Alex"] == 0
    assert b["Checking"] == 100_000 - 9000 + 3000


def test_reversing_a_split_removes_it_and_restores_balances(client: TestClient, auth: dict) -> None:
    ids = _setup(client, auth)
    out = client.post("/api/shared/expenses", headers=auth, json=_expense(ids)).json()
    r = client.post(f"/api/entries/{out['entry_id']}/reverse", headers=auth)
    assert r.status_code == 201
    assert client.get("/api/shared", headers=auth).json() == []
    assert len(client.get("/api/shared?include_reversed=true", headers=auth).json()) == 1
    b = _balances(client, auth)
    assert b["Alex"] == 0 and b["Dining"] == 0 and b["Checking"] == 100_000


def test_recategorizing_a_split_keeps_its_split_details(client: TestClient, auth: dict) -> None:
    ids = _setup(client, auth)
    groceries = accounts_by_name(client, auth)["Groceries"]["id"]
    out = client.post("/api/shared/expenses", headers=auth, json=_expense(ids)).json()
    r = client.post(
        f"/api/entries/{out['entry_id']}/recategorize",
        headers=auth,
        json={"from_account_id": ids["dining"], "to_account_id": groceries},
    )
    assert r.status_code == 201
    [shared] = client.get("/api/shared", headers=auth).json()
    assert shared["category_id"] == groceries
    assert shared["entry_id"] == r.json()["id"]


def test_shared_expense_is_idempotent(client: TestClient, auth: dict) -> None:
    ids = _setup(client, auth)
    headers = auth | {"Idempotency-Key": "split-1"}
    first = client.post("/api/shared/expenses", headers=headers, json=_expense(ids))
    again = client.post("/api/shared/expenses", headers=headers, json=_expense(ids))
    assert again.headers.get("Idempotent-Replayed") == "true"
    assert first.json() == again.json()
    assert _balances(client, auth)["Alex"] == 3000


def test_friends_are_private_per_user(client: TestClient, auth: dict) -> None:
    from tests.conftest import register

    ids = _setup(client, auth)
    other = register(client)
    assert client.get("/api/friends", headers=other).json() == []
    r = client.post("/api/groups", headers=other, json={"name": "Spy", "member_ids": [ids["Alex"]]})
    assert r.status_code == 404
