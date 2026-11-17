import uuid

from fastapi.testclient import TestClient

from tests.conftest import accounts_by_name, register


def _checking(client: TestClient, auth: dict, opening: int = 100_000) -> dict:
    r = client.post(
        "/api/accounts",
        headers=auth,
        json={"name": "Checking", "type": "asset", "opening_balance_minor": opening},
    )
    assert r.status_code == 201, r.text
    return r.json()


def _spend(checking_id: str, category_id: str, cents: int, description: str = "Coffee") -> dict:
    return {
        "occurred_on": "2026-03-14",
        "description": description,
        "lines": [
            {"account_id": category_id, "amount_minor": cents},
            {"account_id": checking_id, "amount_minor": -cents},
        ],
    }


# --- Auth -----------------------------------------------------------------------------


def test_requires_auth(client: TestClient) -> None:
    assert client.get("/api/accounts").status_code == 401
    bad = {"Authorization": "Bearer not-a-token"}
    assert client.get("/api/accounts", headers=bad).status_code == 401


def test_register_rejects_duplicate_email_case_insensitively(client: TestClient) -> None:
    register(client, email="sam@example.com")
    r = client.post(
        "/api/auth/register", json={"email": "SAM@example.com", "password": "another-password"}
    )
    assert r.status_code == 409


def test_wrong_password_is_rejected(client: TestClient) -> None:
    register(client, email="kim@example.com")
    r = client.post("/api/auth/token", data={"username": "kim@example.com", "password": "nope"})
    assert r.status_code == 401


# --- Posting ----------------------------------------------------------------------------


def test_opening_balance_is_a_real_entry(client: TestClient, auth: dict) -> None:
    _checking(client, auth, opening=250_000)
    accounts = accounts_by_name(client, auth)
    assert accounts["Checking"]["balance_minor"] == 250_000
    assert accounts["Opening Balance Equity"]["balance_minor"] == 250_000
    entries = client.get("/api/entries", headers=auth).json()
    assert [e["description"] for e in entries] == ["Opening balance: Checking"]


def test_post_balanced_entry_updates_balances(client: TestClient, auth: dict) -> None:
    checking = _checking(client, auth)
    dining = accounts_by_name(client, auth)["Dining"]
    r = client.post("/api/entries", headers=auth, json=_spend(checking["id"], dining["id"], 450))
    assert r.status_code == 201, r.text
    assert [ln["line_no"] for ln in r.json()["lines"]] == [1, 2]

    accounts = accounts_by_name(client, auth)
    assert accounts["Checking"]["balance_minor"] == 100_000 - 450
    assert accounts["Dining"]["balance_minor"] == 450


def test_unbalanced_entry_is_rejected(client: TestClient, auth: dict) -> None:
    checking = _checking(client, auth)
    dining = accounts_by_name(client, auth)["Dining"]
    body = _spend(checking["id"], dining["id"], 450)
    body["lines"][1]["amount_minor"] = -449
    r = client.post("/api/entries", headers=auth, json=body)
    assert r.status_code == 422
    assert "does not balance" in r.json()["detail"]


def test_zero_and_single_line_entries_are_rejected(client: TestClient, auth: dict) -> None:
    checking = _checking(client, auth)
    body = {
        "occurred_on": "2026-03-14",
        "description": "x",
        "lines": [{"account_id": checking["id"], "amount_minor": 0}],
    }
    assert client.post("/api/entries", headers=auth, json=body).status_code == 422


def test_cannot_post_to_another_users_account(client: TestClient, auth: dict) -> None:
    mine = _checking(client, auth)
    other = register(client)
    theirs = accounts_by_name(client, other)["Dining"]
    r = client.post("/api/entries", headers=auth, json=_spend(mine["id"], theirs["id"], 100))
    assert r.status_code == 422
    assert "Unknown account" in r.json()["detail"]
    # ...and can't even see it.
    assert client.get(f"/api/entries?account_id={theirs['id']}", headers=auth).json() == []


def test_currency_mismatch_does_not_balance(client: TestClient, auth: dict) -> None:
    checking = _checking(client, auth)
    r = client.post(
        "/api/accounts",
        headers=auth,
        json={"name": "Euro Cash", "type": "asset", "currency": "eur"},
    )
    assert r.status_code == 201
    assert r.json()["currency"] == "EUR"
    body = _spend(checking["id"], r.json()["id"], 100)
    assert client.post("/api/entries", headers=auth, json=body).status_code == 422


# --- Idempotency ------------------------------------------------------------------------


def test_idempotent_retry_returns_same_entry_without_duplicating(
    client: TestClient, auth: dict
) -> None:
    checking = _checking(client, auth)
    dining = accounts_by_name(client, auth)["Dining"]
    body = _spend(checking["id"], dining["id"], 1_299)
    headers = {**auth, "Idempotency-Key": str(uuid.uuid4())}

    first = client.post("/api/entries", headers=headers, json=body)
    second = client.post("/api/entries", headers=headers, json=body)
    assert first.status_code == second.status_code == 201
    assert first.json()["id"] == second.json()["id"]
    assert second.headers["Idempotent-Replayed"] == "true"
    assert accounts_by_name(client, auth)["Dining"]["balance_minor"] == 1_299


def test_idempotency_key_reuse_with_different_body_is_rejected(
    client: TestClient, auth: dict
) -> None:
    checking = _checking(client, auth)
    dining = accounts_by_name(client, auth)["Dining"]
    headers = {**auth, "Idempotency-Key": "fixed-key"}
    client.post("/api/entries", headers=headers, json=_spend(checking["id"], dining["id"], 100))
    r = client.post("/api/entries", headers=headers, json=_spend(checking["id"], dining["id"], 200))
    assert r.status_code == 422
    assert "different request" in r.json()["detail"]


def test_idempotency_keys_are_scoped_per_user(client: TestClient, auth: dict) -> None:
    other = register(client)
    for headers in (auth, other):
        checking = _checking(client, headers)
        dining = accounts_by_name(client, headers)["Dining"]
        r = client.post(
            "/api/entries",
            headers={**headers, "Idempotency-Key": "same-key"},
            json=_spend(checking["id"], dining["id"], 100),
        )
        assert r.status_code == 201
        assert "Idempotent-Replayed" not in r.headers


# --- Reversal & recategorization --------------------------------------------------------


def test_reversal_nets_to_zero_and_keeps_history(client: TestClient, auth: dict) -> None:
    checking = _checking(client, auth)
    dining = accounts_by_name(client, auth)["Dining"]
    entry = client.post(
        "/api/entries", headers=auth, json=_spend(checking["id"], dining["id"], 5_000)
    ).json()

    r = client.post(f"/api/entries/{entry['id']}/reverse", headers=auth, json={"reason": "typo"})
    assert r.status_code == 201, r.text
    reversal = r.json()
    assert reversal["source"] == "reversal"
    assert reversal["reverses_id"] == entry["id"]
    assert reversal["occurred_on"] == entry["occurred_on"]

    assert accounts_by_name(client, auth)["Dining"]["balance_minor"] == 0
    original = client.get(f"/api/entries/{entry['id']}", headers=auth).json()
    assert original["is_reversed"] is True
    assert original["lines"] == entry["lines"]  # history untouched


def test_cannot_reverse_twice_or_reverse_a_reversal(client: TestClient, auth: dict) -> None:
    checking = _checking(client, auth)
    dining = accounts_by_name(client, auth)["Dining"]
    entry = client.post(
        "/api/entries", headers=auth, json=_spend(checking["id"], dining["id"], 100)
    ).json()
    reversal = client.post(f"/api/entries/{entry['id']}/reverse", headers=auth).json()

    assert client.post(f"/api/entries/{entry['id']}/reverse", headers=auth).status_code == 409
    assert client.post(f"/api/entries/{reversal['id']}/reverse", headers=auth).status_code == 422


def test_recategorize_moves_amount_between_categories(client: TestClient, auth: dict) -> None:
    checking = _checking(client, auth)
    accounts = accounts_by_name(client, auth)
    dining, groceries = accounts["Dining"], accounts["Groceries"]
    entry = client.post(
        "/api/entries", headers=auth, json=_spend(checking["id"], dining["id"], 8_000, "Market")
    ).json()

    r = client.post(
        f"/api/entries/{entry['id']}/recategorize",
        headers=auth,
        json={"from_account_id": dining["id"], "to_account_id": groceries["id"]},
    )
    assert r.status_code == 201, r.text
    accounts = accounts_by_name(client, auth)
    assert accounts["Dining"]["balance_minor"] == 0
    assert accounts["Groceries"]["balance_minor"] == 8_000
    assert accounts["Checking"]["balance_minor"] == 100_000 - 8_000


def test_audit_log_records_changes(client: TestClient, auth: dict) -> None:
    checking = _checking(client, auth)
    dining = accounts_by_name(client, auth)["Dining"]
    entry = client.post(
        "/api/entries", headers=auth, json=_spend(checking["id"], dining["id"], 100)
    ).json()
    client.post(f"/api/entries/{entry['id']}/reverse", headers=auth)

    actions = [e["action"] for e in client.get("/api/audit", headers=auth).json()]
    for expected in ("user.registered", "account.created", "entry.manual", "entry.reversal"):
        assert expected in actions


def test_list_entries_filters(client: TestClient, auth: dict) -> None:
    checking = _checking(client, auth)
    dining = accounts_by_name(client, auth)["Dining"]
    for desc in ("Blue Bottle 100%", "Corner Deli"):
        client.post(
            "/api/entries", headers=auth, json=_spend(checking["id"], dining["id"], 1, desc)
        )

    found = client.get("/api/entries", headers=auth, params={"q": "100%"}).json()
    assert [e["description"] for e in found] == ["Blue Bottle 100%"]
    assert len(client.get(f"/api/entries?account_id={dining['id']}", headers=auth).json()) == 2


def test_system_accounts_cannot_be_renamed_archived_or_impersonated(
    client: TestClient, auth: dict
) -> None:
    accounts = {a["name"]: a for a in client.get("/api/accounts", headers=auth).json()}
    for name in ("Uncategorized Expense", "Opening Balance Equity"):
        acct_id = accounts[name]["id"]
        r = client.patch(f"/api/accounts/{acct_id}", headers=auth, json={"name": "Misc"})
        assert r.status_code == 422, r.text
        r = client.patch(f"/api/accounts/{acct_id}", headers=auth, json={"is_archived": True})
        assert r.status_code == 422
    groceries = accounts["Groceries"]["id"]
    r = client.patch(
        f"/api/accounts/{groceries}", headers=auth, json={"name": "Uncategorized Expense (old)"}
    )
    assert r.status_code == 422
    r = client.post(
        "/api/accounts", headers=auth, json={"name": "Uncategorized Income 2", "type": "income"}
    )
    assert r.status_code == 422
    # Ordinary accounts can still be renamed.
    r = client.patch(f"/api/accounts/{groceries}", headers=auth, json={"name": "Food"})
    assert r.status_code == 200 and r.json()["name"] == "Food"
