"""Describe-a-bill: the rule-based parser, name resolution, the AI path and the endpoint."""

import json
import uuid
from datetime import date

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.services import bill_parser as bp

ALEX, SAM, PRIYA, JORDAN, SRAVYA = (uuid.uuid4() for _ in range(5))
TAHOE, HOME = uuid.uuid4(), uuid.uuid4()
DINING, GROCERIES, TRAVEL = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
CHECKING, VISA = uuid.uuid4(), uuid.uuid4()


def ctx() -> bp.Context:
    return bp.Context(
        friends=[
            bp.Named(ALEX, "Alex"),
            bp.Named(SAM, "Sam"),
            bp.Named(PRIYA, "Priya"),
            bp.Named(JORDAN, "Jordan"),
            bp.Named(SRAVYA, "Sravya"),
        ],
        groups=[
            (bp.Named(TAHOE, "Tahoe ski trip"), [ALEX, SAM, JORDAN]),
            (bp.Named(HOME, "Roommates"), [PRIYA, SRAVYA]),
        ],
        categories=[
            bp.Named(DINING, "Dining"),
            bp.Named(GROCERIES, "Groceries"),
            bp.Named(TRAVEL, "Travel"),
        ],
        money=[bp.Named(CHECKING, "Checking"), bp.Named(VISA, "Visa Card")],
        currency="USD",
        today=date(2026, 11, 17),  # a Tuesday
    )


def parse(text: str) -> bp.BillDraft:
    return bp.parse_bill(text, ctx(), use_ai=False)


def people(d: bp.BillDraft) -> list[uuid.UUID | None]:
    return [p.account_id for p in d.participants]


def test_simple_equal_split_you_paid_with_a_card() -> None:
    d = parse("Dinner at Joe's $90 with Alex and Sam, I paid with my Visa")
    assert d.source == "rules"
    assert d.description == "Dinner at Joe's"
    assert d.total_minor == 9000
    assert d.method == "equal"
    assert people(d) == [None, ALEX, SAM]
    assert d.payer_id is None
    assert d.paid_from_id == VISA
    assert d.category_id == DINING
    assert d.notes == []


def test_exact_amounts_per_person() -> None:
    d = parse("Groceries 69: Sravya 23, Priya 23, me 23")
    assert d.description == "Groceries"
    assert d.total_minor == 6900 and d.method == "exact"
    assert {p.account_id: p.amount_minor for p in d.participants} == {
        None: 2300,
        SRAVYA: 2300,
        PRIYA: 2300,
    }
    assert d.category_id == GROCERIES


def test_rest_of_an_exact_split_goes_to_whoever_has_no_amount() -> None:
    d = parse("Birthday dinner $120. Alex $50, Sam's share 30, rest is mine")
    assert d.total_minor == 12000
    assert {p.account_id: p.amount_minor for p in d.participants} == {
        None: 4000,
        ALEX: 5000,
        SAM: 3000,
    }


def test_friend_paid_for_a_group_minus_someone() -> None:
    d = parse("Alex paid 600 for the cabin, split with Tahoe ski trip except Jordan")
    assert d.payer_id == ALEX
    assert d.total_minor == 60000
    assert d.description == "Cabin"
    assert d.group_id == TAHOE
    assert people(d) == [None, ALEX, SAM]
    assert d.category_id == TRAVEL  # from "cabin" (and not "cab")
    d = parse("Cabin 600 on Tahoe ski trip except Jordan, Alex paid")
    assert d.payer_id == ALEX and people(d) == [None, ALEX, SAM]


def test_category_hints_match_whole_words() -> None:
    c = ctx()
    c.categories.append(bp.Named(uuid.uuid4(), "Transport"))
    cab = bp.parse_bill("Cab home 30 with Sam", c, use_ai=False)
    cabin = bp.parse_bill("Cabin 600 with Sam", c, use_ai=False)
    assert cab.category_id == c.categories[-1].id
    assert cabin.category_id == TRAVEL


def test_shares_and_relative_dates() -> None:
    d = parse("Lift tickets $300 yesterday, Sam x2, Alex 1 share, me")
    assert d.method == "shares"
    assert {p.account_id: p.weight for p in d.participants} == {None: 1, SAM: 2, ALEX: 1}
    assert d.occurred_on == date(2026, 11, 16)
    d = parse("Hotel 450 split 2:1 with Alex")  # a ratio lists you first
    assert d.total_minor == 45000
    assert {p.account_id: p.weight for p in d.participants} == {None: 2, ALEX: 1}
    assert parse("Pizza 40 with Alex last friday").occurred_on == date(2026, 11, 13)
    assert parse("Pizza 40 with Alex on 2026-03-14").occurred_on == date(2026, 3, 14)


def test_single_number_next_to_a_name_is_the_total() -> None:
    d = parse("pizza with alex 40")
    assert d.total_minor == 4000 and d.method == "equal"
    assert people(d) == [None, ALEX]
    assert d.description == "Pizza"


def test_not_me_and_unknown_names_and_missing_total() -> None:
    d = parse("Concert tickets for Alex and Sam, not me, 80")
    assert people(d) == [ALEX, SAM]
    d = parse("Lunch with Ravi")
    assert "Couldn't find the total" in d.notes
    assert people(d) == [None]


def test_mixing_a_group_with_an_outsider_drops_the_group() -> None:
    d = parse("Brunch 60 with Roommates and Alex")
    assert d.group_id is None
    assert set(people(d)) == {None, PRIYA, SRAVYA, ALEX}
    assert any("aren't in Roommates" in n for n in d.notes)


# --- Resolution of model output -------------------------------------------------------


def test_resolve_matches_misspellings_and_ignores_invented_people() -> None:
    raw = bp.RawBill(
        description="Sushi",
        total="75.5",
        payer="Priay",
        category="dining out",
        participants=[
            bp.RawPerson(name="me"),
            bp.RawPerson(name="priya"),
            bp.RawPerson(name="Zed"),
        ],
    )
    d = bp.resolve(raw, ctx(), "ai")
    assert d.payer_id == PRIYA
    assert d.total_minor == 7550
    assert people(d) == [None, PRIYA]
    assert d.category_id == DINING
    assert any("Zed" in n for n in d.notes)


def test_resolve_never_trusts_float_noise_or_negative_amounts() -> None:
    raw = bp.RawBill(
        total="30",
        method="exact",
        participants=[
            bp.RawPerson(name="me", amount="10.004"),
            bp.RawPerson(name="Alex", amount="-5"),
        ],
    )
    d = bp.resolve(raw, ctx(), "ai")
    assert [p.amount_minor for p in d.participants] == [1000, 2000]  # -5 dropped, rest assigned


# --- AI path --------------------------------------------------------------------------


def _fake_gemini(payload: dict, status: int = 200):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["x-goog-api-key"] == "test-key"
        sent = json.loads(request.content)
        assert "Alex" in sent["contents"][0]["parts"][0]["text"]  # it gets the user's names
        body = {"candidates": [{"content": {"parts": [{"text": json.dumps(payload)}]}}]}
        return httpx.Response(status, json=body)

    return handler


@pytest.fixture
def ai_key(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "ai_api_key", "test-key")

    def install(handler) -> None:
        client = httpx.Client(transport=httpx.MockTransport(handler))
        monkeypatch.setattr(bp.httpx, "post", client.post)

    return install


def test_ai_answer_is_resolved_like_any_other(ai_key) -> None:
    ai_key(
        _fake_gemini(
            {
                "description": "Dinner",
                "total": "90",
                "payer": "Sam",
                "method": "equal",
                "participants": [{"name": "me"}, {"name": "Sam"}, {"name": "Alex"}],
            }
        )
    )
    d = bp.parse_bill("sam got dinner for the three of us, 90 bucks", ctx())
    assert d.source == "ai"
    assert d.payer_id == SAM and d.total_minor == 9000
    assert people(d) == [None, SAM, ALEX]


def test_ai_failure_falls_back_to_rules(ai_key) -> None:
    ai_key(lambda request: httpx.Response(429, json={"error": "quota"}))
    d = bp.parse_bill("Dinner 90 with Alex", ctx())
    assert d.source == "rules"
    assert d.total_minor == 9000
    assert "built-in parser" in d.notes[0]


# --- Endpoint -------------------------------------------------------------------------


def test_parse_endpoint_uses_your_own_names(client: TestClient, auth: dict) -> None:
    r = client.post(
        "/api/accounts",
        headers=auth,
        json={"name": "Checking", "type": "asset", "opening_balance_minor": 0},
    )
    checking = r.json()["id"]
    alex = client.post("/api/friends", headers=auth, json={"name": "Alex"}).json()["id"]
    r = client.post(
        "/api/shared/parse", headers=auth, json={"text": "Tacos $45 with Alex from checking"}
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["total_minor"] == 4500
    assert d["paid_from_id"] == checking
    assert [p["account_id"] for p in d["participants"]] == [None, alex]
    assert d["category_id"] is not None  # "Tacos" -> Dining
    # Nothing was posted.
    assert client.get("/api/shared", headers=auth).json() == []
    assert client.post("/api/shared/parse", headers=auth, json={"text": ""}).status_code == 422
