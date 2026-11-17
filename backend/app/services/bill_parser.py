"""Fill the split-bill form from a sentence.

    "Dinner at Joe's $90 with Alex and Sam, I paid with Visa"
    "Alex paid 120 for the cabin, split with Tahoe ski trip except Jordan"
    "Groceries 69: Sravya 23, Priya 23, me 23"

Two extractors produce the same `RawBill` (names, not ids):

* an LLM (Google Gemini's free tier, when `AI_API_KEY` is set), which handles free-form
  phrasing, and
* a deterministic rule-based parser, used when no key is configured or the LLM fails,
  so the feature always works and tests never touch the network.

`resolve()` then maps names onto the user's own friends, groups, categories and
accounts, converts amounts to integer minor units with `Decimal`, and returns a
*draft*. Nothing is posted: the draft fills the form, the user checks it, and the
normal validated endpoint does the accounting. The model never sees ids and never
decides what is valid.
"""

from __future__ import annotations

import difflib
import json
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field, ValidationError

from app.config import settings
from app.money import MoneyError, parse_amount

log = logging.getLogger(__name__)

ME = "me"
_ME_WORDS = {"me", "i", "myself", "you", "my", "mine", "self", "yourself"}

Method = Literal["equal", "exact", "shares"]


# --- What both extractors produce -----------------------------------------------------


class RawPerson(BaseModel):
    name: str
    amount: str | None = None  # their exact share, as written ("23", "23.50")
    shares: int | None = None  # their weight when split by shares


class RawBill(BaseModel):
    description: str | None = None
    total: str | None = None
    date: str | None = None  # YYYY-MM-DD
    payer: str | None = None  # "me" or a friend's name
    paid_from: str | None = None  # card / bank account name
    category: str | None = None
    group: str | None = None
    method: Method | None = None
    participants: list[RawPerson] = Field(default_factory=list)
    exclude: list[str] = Field(default_factory=list)


@dataclass(frozen=True)
class Named:
    id: uuid.UUID
    name: str


@dataclass
class Context:
    """The user's own names, which is all either extractor needs to know."""

    friends: list[Named]
    groups: list[tuple[Named, list[uuid.UUID]]]
    categories: list[Named]
    money: list[Named]
    currency: str
    today: date


# --- The draft returned to the form ---------------------------------------------------


class DraftPerson(BaseModel):
    account_id: uuid.UUID | None  # None = you
    weight: int | None = None
    amount_minor: int | None = None


class BillDraft(BaseModel):
    source: Literal["ai", "rules"]
    description: str | None = None
    total_minor: int | None = None
    occurred_on: date | None = None
    payer_id: uuid.UUID | None = None  # None = you
    paid_from_id: uuid.UUID | None = None
    category_id: uuid.UUID | None = None
    group_id: uuid.UUID | None = None
    method: Method = "equal"
    participants: list[DraftPerson] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


# --- Name matching --------------------------------------------------------------------


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", s.lower()).strip()


def match_name(text: str | None, options: list[Named]) -> Named | None:
    """Exact, then unique prefix / first-word, then close spelling ("Priay" -> Priya)."""
    if not text:
        return None
    t = _norm(text)
    if not t:
        return None
    by_norm = {_norm(o.name): o for o in options}
    if t in by_norm:
        return by_norm[t]
    partial = [
        o
        for o in options
        if _norm(o.name).startswith(t) or t in _norm(o.name).split() or _norm(o.name) in t.split()
    ]
    if len(partial) == 1:
        return partial[0]
    close = difflib.get_close_matches(t, list(by_norm), n=1, cutoff=0.8)
    return by_norm[close[0]] if close else None


def _is_me(name: str | None) -> bool:
    return bool(name) and _norm(name) in _ME_WORDS


# --- Rule-based extractor -------------------------------------------------------------

_AMOUNT = r"(?:[$€£₹¥]\s?)?\d[\d,]*(?:\.\d+)?(?:\s?(?:dollars|bucks|usd|eur|inr|rs\.?))?"
_AMOUNT_RE = re.compile(rf"(?<![\w.]){_AMOUNT}(?![\w])", re.I)
_SHARES_AFTER = re.compile(
    r"^\s*(?:[x\u00d7*]\s*(\d+)|[:=-]?\s*(\d+)\s*(?:shares?|parts?|portions?)\b)", re.I
)
_SHARES_BEFORE = re.compile(r"(\d+)\s*(?:shares?|parts?|portions?)\s*(?:for|to)\s*$", re.I)
_AMOUNT_AFTER = re.compile(
    r"^\s*(?:'s(?:\s+share)?|:|=|-|\u2013|\u2014|owes?|share|had|ordered|got|is|was|pays?)?"
    rf"\s*(?:is\s+)?({_AMOUNT})",
    re.I,
)
_PAYER_AFTER = re.compile(
    r"^\s*(?:paid|covered|picked up|fronted|got the bill|got it|bought|put it on)", re.I
)
_PAYER_BEFORE = re.compile(r"(?:paid by|paid for by|covered by|bought by)\s*$", re.I)
_EXCLUDE_BEFORE = re.compile(
    r"(?:except|excluding|without|minus|but not|not including|not)\s+(?:for\s+)?"
    r"(?:\w+\s*(?:,|and|&)\s*)*$",
    re.I,
)
_ME_OUT = re.compile(
    r"\b(?:not me|without me|excluding me|except me|i(?:'m| am) not in|for them|on their behalf)\b",
    re.I,
)
_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
_MONTHS = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
]  # fmt: skip

# Hints for picking a category when none is named. Only used if the user has a
# category with that name.
_CATEGORY_HINTS: dict[str, tuple[str, ...]] = {
    "Dining": (
        "dinner", "lunch", "breakfast", "brunch", "restaurant", "pizza", "sushi", "cafe",
        "coffee", "drinks", "bar", "takeout", "food", "burger", "tacos", "biryani", "meal",
    ),
    "Groceries": (
        "grocery", "groceries", "costco", "supermarket", "walmart", "trader joe", "whole foods",
    ),
    "Transport": ("uber", "lyft", "taxi", "cab", "gas", "fuel", "parking", "train", "bus"),
    "Travel": ("trip", "hotel", "airbnb", "cabin", "flight", "ski", "lift", "vacation"),
    "Utilities": (
        "internet", "wifi", "wi-fi", "electric", "electricity", "power bill", "water bill",
        "utility",
    ),
    "Rent": ("rent",),
    "Shopping": ("amazon", "shopping", "clothes", "gift"),
    "Entertainment": ("movie", "concert", "tickets", "netflix", "show", "bowling", "game"),
}  # fmt: skip


@dataclass
class _Mention:
    start: int
    end: int
    key: str  # "me", "f:<id>", "g:<id>"
    name: str


def _find_date(text: str, today: date) -> tuple[str | None, str]:
    """Return (YYYY-MM-DD or None, text with the date phrase removed)."""
    patterns: list[tuple[re.Pattern[str], Any]] = [
        (re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b"), lambda m: date(*map(int, m.groups()))),
        (re.compile(r"\bday before yesterday\b", re.I), lambda m: today - timedelta(days=2)),
        (re.compile(r"\byesterday\b", re.I), lambda m: today - timedelta(days=1)),
        (re.compile(r"\b(?:today|tonight)\b", re.I), lambda m: today),
        (
            re.compile(rf"\b(?:last|on|this past)\s+({'|'.join(_WEEKDAYS)})\b", re.I),
            lambda m: (
                today - timedelta(days=((today.weekday() - _WEEKDAYS.index(m[1].lower())) % 7) or 7)
            ),
        ),
        (
            re.compile(
                rf"\b(?:on\s+)?({'|'.join(_MONTHS)})[a-z]*\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?\b", re.I
            ),
            lambda m: _month_day(today, _MONTHS.index(m[1].lower()[:3]) + 1, int(m[2])),
        ),
    ]
    for pattern, build in patterns:
        if m := pattern.search(text):
            try:
                d = build(m)
            except ValueError:
                continue
            return d.isoformat(), text[: m.start()] + " " + text[m.end() :]
    return None, text


def _month_day(today: date, month: int, day: int) -> date:
    d = date(today.year, month, day)
    return d if d <= today else date(today.year - 1, month, day)  # "Dec 30" in January


def _scan_names(text: str, ctx: Context) -> list[_Mention]:
    aliases: list[tuple[str, str, str]] = []  # (alias, key, display)
    for g, _ in ctx.groups:
        aliases.append((g.name, f"g:{g.id}", g.name))
    for f in ctx.friends:
        aliases.append((f.name, f"f:{f.id}", f.name))
        first = f.name.split()[0]
        if first != f.name and sum(x.name.split()[0] == first for x in ctx.friends) == 1:
            aliases.append((first, f"f:{f.id}", f.name))
    for w in ("me", "i", "myself", "my share", "mine"):
        aliases.append((w, ME, "me"))
    aliases.sort(key=lambda a: -len(a[0]))  # longest first: "Tahoe ski trip" before "Tahoe"

    taken: list[tuple[int, int]] = []
    found: list[_Mention] = []
    for alias, key, display in aliases:
        for m in re.finditer(rf"(?<![\w']){re.escape(alias)}(?![\w])", text, re.I):
            if any(m.start() < e and s < m.end() for s, e in taken):
                continue
            taken.append((m.start(), m.end()))
            found.append(_Mention(m.start(), m.end(), key, display))
    return sorted(found, key=lambda x: x.start)


def _clean_amount(s: str) -> str:
    return re.sub(r"(?i)\s?(dollars|bucks|usd|eur|inr|rs\.?)$", "", s).strip()


def rule_extract(text: str, ctx: Context) -> RawBill:
    raw = RawBill()
    raw.date, text = _find_date(text, ctx.today)
    ratio: list[int] = []
    if m := re.search(r"(?<![\d.])(\d{1,3}(?:\s*:\s*\d{1,3})+)(?![\d.])", text):
        ratio = [int(x) for x in m[1].split(":")]  # "split 2:1 with Alex" (you first)
        text = text[: m.start()] + " " * len(m[0]) + text[m.end() :]
    mentions = _scan_names(text, ctx)
    lower = text.lower()

    # Card / bank account ("paid with Visa", "on my Amex", "from Checking").
    for acct in sorted(ctx.money, key=lambda a: -len(a.name)):
        words = [acct.name] + [w for w in acct.name.split() if len(w) > 3]
        if any(re.search(rf"(?<!\w){re.escape(w)}(?!\w)", text, re.I) for w in words):
            raw.paid_from = acct.name
            break

    # Who paid.
    for mt in mentions:
        if mt.key.startswith("g:"):
            continue
        if _PAYER_AFTER.match(text[mt.end :]) or _PAYER_BEFORE.search(text[: mt.start]):
            raw.payer = mt.name
            break

    # Who's excluded ("except Jordan", "not me").
    excluded: set[str] = set()
    for mt in mentions:
        if mt.name == raw.payer:
            continue  # "...except Jordan, Alex paid": whoever paid is in it
        if _EXCLUDE_BEFORE.search(text[max(0, mt.start - 40) : mt.start]):
            excluded.add(mt.key)
    if _ME_OUT.search(text):
        excluded.add(ME)

    # Amounts and shares attached to a person ("Alex 20", "Sam's share $15", "Priya x2").
    attached: dict[str, str] = {}
    weights: dict[str, int] = {}
    used_spans: list[tuple[int, int]] = []
    for mt in mentions:
        if mt.key.startswith("g:"):
            continue
        after = text[mt.end : mt.end + 30]
        if (m := _SHARES_AFTER.match(after)) is not None:
            weights[mt.key] = int(m[1] or m[2])
            used_spans.append((mt.end, mt.end + m.end()))
            continue
        if (m := _SHARES_BEFORE.search(text[max(0, mt.start - 20) : mt.start])) is not None:
            weights[mt.key] = int(m[1])
            used_spans.append((mt.start - (len(m[0])), mt.start))
            continue
        if _PAYER_AFTER.match(after):
            continue  # "Alex paid 120": the amount is the total, not Alex's share
        if (m := _AMOUNT_AFTER.match(after)) is not None:
            attached[mt.key] = _clean_amount(m[1])
            used_spans.append((mt.end + m.start(1), mt.end + m.end(1)))

    loose = [
        _clean_amount(m[0])
        for m in _AMOUNT_RE.finditer(text)
        if not any(s <= m.start() < e for s, e in used_spans)
    ]

    def value(s: str) -> Decimal:
        try:
            return Decimal(re.sub(r"[^\d.]", "", s))
        except InvalidOperation:
            return Decimal(0)

    if loose:
        raw.total = max(loose, key=value)
    elif len(attached) == 1 and not weights:
        # "Dinner with Alex 90": a single number is the bill, not Alex's share.
        raw.total = attached.popitem()[1]
    if attached:
        raw.method = "exact"
    elif weights:
        raw.method = "shares"

    # Group and participants.
    group_keys = [mt.key for mt in mentions if mt.key.startswith("g:")]
    groups = {f"g:{g.id}": (g, members) for g, members in ctx.groups}
    keys: list[str] = []
    if group_keys:
        g, members = groups[group_keys[0]]
        raw.group = g.name
        keys += [f"f:{m}" for m in members]
    keys += [mt.key for mt in mentions if mt.key.startswith("f:")]
    if raw.payer and not _is_me(raw.payer):
        payer = match_name(raw.payer, ctx.friends)
        if payer:
            keys.append(f"f:{payer.id}")
    names = {f"f:{f.id}": f.name for f in ctx.friends}
    ordered = [ME] + [k for k in dict.fromkeys(keys) if k != ME]
    for key in ordered:
        if key in excluded:
            continue
        raw.participants.append(
            RawPerson(
                name="me" if key == ME else names[key],
                amount=attached.get(key),
                shares=weights.get(key),
            )
        )
    raw.exclude = ["me" if k == ME else names[k] for k in excluded if k == ME or k in names]
    if ratio and not weights and not attached and len(ratio) == len(raw.participants):
        raw.method = "shares"
        for person, w in zip(raw.participants, ratio, strict=True):
            person.shares = w

    # Category: a category named outright, else a keyword hint.
    for cat in sorted(ctx.categories, key=lambda c: -len(c.name)):
        if re.search(rf"(?<!\w){re.escape(cat.name)}(?!\w)", text, re.I):
            raw.category = cat.name
            break
    if raw.category is None:
        cat_names = {_norm(c.name) for c in ctx.categories}
        for cat_name, hints in _CATEGORY_HINTS.items():
            if _norm(cat_name) in cat_names and any(
                re.search(rf"(?<!\w){re.escape(h)}(?:s|es)?(?!\w)", lower) for h in hints
            ):
                raw.category = cat_name
                break

    raw.description = _description(text, mentions)
    return raw


def _description(text: str, mentions: list[_Mention]) -> str | None:
    # Try the whole note, then each clause ("Paid by Priya, takeout 55, ..." -> "Takeout").
    for part in [text, *re.split(r"[,;:]", text)]:
        if found := _describe(part, mentions):
            return found
    return None


def _describe(text: str, mentions: list[_Mention]) -> str | None:
    t = re.sub(r"\s+", " ", text).strip(" ,.;:-")
    # "Alex paid 120 for the cabin ..." -> "cabin"
    m = re.search(r"\b(?:for|on)\s+(?:the\s+|a\s+|an\s+|our\s+)?([a-z][\w' &]*)", t, re.I)
    head = t
    lead = _norm(t)
    starts_with_person = re.match(r"i\b", lead) or any(
        lead.startswith(_norm(mt.name)) for mt in mentions
    )
    if starts_with_person and m:
        head = m[1]
    # Cut at the first connector / number, keeping "Dinner at Joe's" intact.
    cut = re.split(
        rf"(?i)\s*(?:,|;|:|\bwith\b|\bsplit\b|\bbetween\b|\bamong\b|\bpaid\b|\bby\b|"
        rf"\bwas\b|\bis\b|\bcame to\b|\bcosts?\b|\btotal(?:l?ed)?\b|\busing\b|\bvia\b|"
        rf"\bexcept\b|(?<![\w.]){_AMOUNT}(?!\w))",
        head,
        maxsplit=1,
    )[0]
    cut = re.sub(r"(?i)\b(?:the|a|an|our|of|for|at|on|bill)\s*$", "", cut).strip(" ,.;:-")
    if not cut or re.fullmatch(r"(?i)(?:i|me|we|us)", cut):
        return None
    for mt in mentions:  # a description that is just a name isn't one
        if _norm(cut) == _norm(mt.name):
            return None
    return cut[:1].upper() + cut[1:]


# --- LLM extractor (Gemini free tier) -------------------------------------------------

_SYSTEM = """You turn a short note about a shared bill into JSON for a bill-splitting form.
Use only names from the lists given. Write "me" for the user (I, me, my, myself).
- total: the whole bill as a plain decimal string ("69", "12.50"), no currency symbol.
- payer: who paid the bill. Default "me".
- participants: everyone who shares the cost, including the payer if they shared it and
  "me" unless the note says the user is not part of it. If a group is named and no one is
  excluded, list every member of the group plus "me".
- method: "exact" when amounts per person are given, "shares" for ratios like 2:1 or
  "Alex x2", otherwise "equal". For "exact", put each person's amount; if one person's
  amount is implied ("rest is mine"), compute it. For "shares", put integer shares.
- category and paid_from: pick the closest from the lists, or null.
- date: YYYY-MM-DD if the note mentions one (today is {today}), else null.
- description: a short title like "Dinner at Joe's" or "Groceries", not a sentence.
Never invent people, groups or accounts. Leave a field null if the note doesn't say."""


def _schema() -> dict[str, Any]:
    s = {"type": "STRING", "nullable": True}
    return {
        "type": "OBJECT",
        "properties": {
            "description": s,
            "total": s,
            "date": s,
            "payer": s,
            "paid_from": s,
            "category": s,
            "group": s,
            "method": {"type": "STRING", "enum": ["equal", "exact", "shares"], "nullable": True},
            "participants": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "name": {"type": "STRING"},
                        "amount": s,
                        "shares": {"type": "INTEGER", "nullable": True},
                    },
                    "required": ["name"],
                },
            },
            "exclude": {"type": "ARRAY", "items": {"type": "STRING"}},
        },
        "required": ["participants"],
    }


class AIUnavailable(Exception):
    pass


def ai_enabled() -> bool:
    return bool(settings.ai_api_key)


def ai_extract(text: str, ctx: Context) -> RawBill:
    """Ask Gemini for a RawBill. Raises AIUnavailable on any failure."""
    lists = {
        "friends": [f.name for f in ctx.friends],
        "groups": {g.name: [n.name for n in ctx.friends if n.id in m] for g, m in ctx.groups},
        "categories": [c.name for c in ctx.categories],
        "accounts_you_pay_from": [a.name for a in ctx.money],
        "currency": ctx.currency,
    }
    body = {
        "systemInstruction": {"parts": [{"text": _SYSTEM.format(today=ctx.today.isoformat())}]},
        "contents": [
            {
                "role": "user",
                "parts": [{"text": f"Lists:\n{json.dumps(lists)}\n\nNote:\n{text}"}],
            }
        ],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
            "responseSchema": _schema(),
        },
    }
    url = f"{settings.ai_base_url.rstrip('/')}/models/{settings.ai_model}:generateContent"
    try:
        r = httpx.post(
            url,
            json=body,
            headers={"x-goog-api-key": settings.ai_api_key or ""},
            timeout=settings.ai_timeout_seconds,
        )
        r.raise_for_status()
        out = r.json()
        part = out["candidates"][0]["content"]["parts"][0]["text"]
        return RawBill.model_validate(json.loads(part))
    except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError, ValidationError) as e:
        status = getattr(getattr(e, "response", None), "status_code", None)
        log.warning("AI bill parse failed (%s, status=%s)", type(e).__name__, status)
        raise AIUnavailable from e


# --- Resolution: names -> ids, text -> minor units ------------------------------------


def _minor(value: str | None, currency: str) -> int | None:
    if value is None or not str(value).strip():
        return None
    s = _clean_amount(str(value)).replace(" ", "")
    try:
        minor = parse_amount(s, currency)
    except MoneyError:
        try:  # "23.456" from a model: round half-up to the currency's precision
            q = Decimal(re.sub(r"[^\d.\-]", "", s))
            minor = parse_amount(str(q.quantize(Decimal("0.01"))), currency)
        except (MoneyError, InvalidOperation):
            return None
    return minor if minor > 0 else (0 if minor == 0 else None)


def resolve(raw: RawBill, ctx: Context, source: Literal["ai", "rules"]) -> BillDraft:
    draft = BillDraft(source=source)
    notes = draft.notes
    unknown: list[str] = []

    draft.description = (raw.description or "").strip()[:500] or None
    draft.total_minor = _minor(raw.total, ctx.currency)
    if raw.date:
        try:
            d = date.fromisoformat(raw.date)
            if d <= ctx.today + timedelta(days=1):
                draft.occurred_on = d
        except ValueError:
            pass

    cat = match_name(raw.category, ctx.categories)
    draft.category_id = cat.id if cat else None
    acct = match_name(raw.paid_from, ctx.money)
    draft.paid_from_id = acct.id if acct else None

    group = None
    if raw.group:
        group = next((g for g in ctx.groups if g[0].name == raw.group), None) or next(
            (g for g in ctx.groups if match_name(raw.group, [g[0]])), None
        )
        if group is None:
            unknown.append(raw.group)

    if raw.payer and not _is_me(raw.payer):
        payer = match_name(raw.payer, ctx.friends)
        if payer:
            draft.payer_id = payer.id
        else:
            unknown.append(raw.payer)

    excluded = {_norm(x) for x in raw.exclude}
    seen: set[uuid.UUID | None] = set()
    people: list[tuple[uuid.UUID | None, RawPerson]] = []
    source_people = raw.participants or [RawPerson(name="me")]
    if not raw.participants and group:
        source_people += [RawPerson(name=f.name) for f in ctx.friends if f.id in set(group[1])]
    for p in source_people:
        if _is_me(p.name):
            pid: uuid.UUID | None = None
            if "me" in excluded:
                continue
        else:
            f = match_name(p.name, ctx.friends)
            if f is None:
                unknown.append(p.name)
                continue
            if _norm(f.name) in excluded:
                continue
            pid = f.id
        if pid in seen:
            continue
        seen.add(pid)
        people.append((pid, p))

    amounts = [_minor(p.amount, ctx.currency) for _, p in people]
    weights = [p.shares if p.shares and 0 < p.shares <= 1000 else None for _, p in people]
    method: Method = raw.method or "equal"
    if any(a is not None for a in amounts) and method != "shares":
        method = "exact"
    elif any(w is not None for w in weights) and method != "exact":
        method = "shares"
    if method == "exact" and not any(a is not None for a in amounts):
        method = "equal"

    if method == "exact":
        known = sum(a for a in amounts if a is not None)
        missing = [i for i, a in enumerate(amounts) if a is None]
        if draft.total_minor is None and not missing:
            draft.total_minor = known
        elif draft.total_minor is not None and len(missing) == 1:
            rest = draft.total_minor - known
            if rest >= 0:
                amounts[missing[0]] = rest  # "Alex 20, Sam 15, rest is mine"

    draft.method = method
    draft.participants = [
        DraftPerson(
            account_id=pid,
            weight=(weights[i] or 1) if method == "shares" else None,
            amount_minor=(amounts[i] or 0) if method == "exact" else None,
        )
        for i, (pid, _) in enumerate(people)
    ]

    if group:
        members = set(group[1])
        outsiders = [pid for pid, _ in people if pid is not None and pid not in members]
        if draft.payer_id and draft.payer_id not in members:
            outsiders.append(draft.payer_id)
        if outsiders:
            notes.append(f"Some people aren't in {group[0].name}, so this isn't filed under it")
        else:
            draft.group_id = group[0].id

    if unknown:
        names = ", ".join(dict.fromkeys(unknown))
        notes.append(f"Not found in your friends or groups: {names}")
    if draft.total_minor is None:
        notes.append("Couldn't find the total")
    return draft


def parse_bill(text: str, ctx: Context, *, use_ai: bool = True) -> BillDraft:
    text = text.strip()
    if use_ai and ai_enabled():
        try:
            return resolve(ai_extract(text, ctx), ctx, "ai")
        except AIUnavailable:
            draft = resolve(rule_extract(text, ctx), ctx, "rules")
            draft.notes.insert(0, "The AI service didn't answer, so this used the built-in parser")
            return draft
    return resolve(rule_extract(text, ctx), ctx, "rules")
