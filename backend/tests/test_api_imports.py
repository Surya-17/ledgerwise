from fastapi.testclient import TestClient

from tests.conftest import accounts_by_name

STATEMENT = b"""Date,Description,Amount
2026-03-01,ACME PAYROLL,"2,500.00"
2026-03-02,WHOLE FOODS #123,-84.20
2026-03-03,Blue Bottle Coffee,-4.50
2026-03-03,Blue Bottle Coffee,-4.50
2026-03-04,Pending hold,0.00
"""

OVERLAPPING = b"""Date,Description,Amount
2026-03-03,Blue Bottle Coffee,-4.50
2026-03-03,Blue Bottle Coffee,-4.50
2026-03-03,Blue Bottle Coffee,-4.50
2026-03-05,Metro Card,-33.00
"""


def _setup(client: TestClient, auth: dict) -> dict:
    r = client.post("/api/accounts", headers=auth, json={"name": "Checking", "type": "asset"})
    return r.json()


def _upload(client: TestClient, auth: dict, account_id: str, content: bytes, **form):
    return client.post(
        "/api/imports",
        headers=auth,
        data={"account_id": account_id, **form},
        files={"file": ("statement.csv", content, "text/csv")},
    )


def test_import_posts_rows_and_reimport_is_idempotent(client: TestClient, auth: dict) -> None:
    checking = _setup(client, auth)
    first = _upload(client, auth, checking["id"], STATEMENT)
    assert first.status_code == 201, first.text
    assert first.json() | {"id": None, "created_at": None, "account_id": None} == {
        "id": None,
        "created_at": None,
        "account_id": None,
        "filename": "statement.csv",
        "row_count": 5,
        "imported_count": 4,  # both identical coffees kept
        "duplicate_count": 0,
        "skipped_count": 1,  # the $0.00 hold
        "transfer_count": 0,
    }

    again = _upload(client, auth, checking["id"], STATEMENT).json()
    assert again["imported_count"] == 0
    assert again["duplicate_count"] == 4

    expected = 250_000 - 8_420 - 450 - 450
    assert accounts_by_name(client, auth)["Checking"]["balance_minor"] == expected


def test_overlapping_statement_only_adds_new_rows(client: TestClient, auth: dict) -> None:
    checking = _setup(client, auth)
    _upload(client, auth, checking["id"], STATEMENT)
    result = _upload(client, auth, checking["id"], OVERLAPPING).json()
    # Two coffees already existed; the third identical one and the metro card are new.
    assert result["duplicate_count"] == 2
    assert result["imported_count"] == 2


def test_rules_categorize_and_fallbacks_catch_the_rest(client: TestClient, auth: dict) -> None:
    checking = _setup(client, auth)
    accounts = accounts_by_name(client, auth)
    for pattern, name in (("whole foods", "Groceries"), ("payroll", "Salary")):
        r = client.post(
            "/api/rules",
            headers=auth,
            json={"pattern": pattern, "account_id": accounts[name]["id"]},
        )
        assert r.status_code == 201

    _upload(client, auth, checking["id"], STATEMENT)
    accounts = accounts_by_name(client, auth)
    assert accounts["Groceries"]["balance_minor"] == 8_420
    assert accounts["Salary"]["balance_minor"] == 250_000
    assert accounts["Uncategorized Expense"]["balance_minor"] == 900


def test_bad_rows_reject_the_whole_file(client: TestClient, auth: dict) -> None:
    checking = _setup(client, auth)
    bad = (
        b"date,description,amount\n2026-03-01,ok,-1.00\n03/02/2026,bad date,-2.00\n2026-03-03,,-1\n"
    )
    r = _upload(client, auth, checking["id"], bad)
    assert r.status_code == 422
    body = r.json()
    assert "nothing was saved" in body["detail"]
    assert len(body["errors"]) == 2
    assert body["errors"][0].startswith("Row 3:")
    assert client.get("/api/entries", headers=auth).json() == []


def test_custom_columns_date_format_and_card_sign(client: TestClient, auth: dict) -> None:
    card = client.post(
        "/api/accounts", headers=auth, json={"name": "Visa", "type": "liability"}
    ).json()
    # Card exports often show purchases as positive numbers.
    content = b"Posted,Payee,Charge\n03/09/2026,Shell Gas,45.00\n"
    r = _upload(
        client,
        auth,
        card["id"],
        content,
        date_column="Posted",
        description_column="Payee",
        amount_column="Charge",
        date_format="%m/%d/%Y",
        invert_amounts="true",
    )
    assert r.status_code == 201, r.text
    accounts = accounts_by_name(client, auth)
    assert accounts["Visa"]["balance_minor"] == 4_500  # owed
    assert accounts["Uncategorized Expense"]["balance_minor"] == 4_500


def test_missing_columns_are_reported(client: TestClient, auth: dict) -> None:
    checking = _setup(client, auth)
    r = _upload(client, auth, checking["id"], b"when,what\n2026-01-01,x\n")
    assert r.status_code == 422
    assert r.json()["found_columns"] == ["when", "what"]


def test_cannot_import_into_expense_account(client: TestClient, auth: dict) -> None:
    dining = accounts_by_name(client, auth)["Dining"]
    assert _upload(client, auth, dining["id"], STATEMENT).status_code == 422
