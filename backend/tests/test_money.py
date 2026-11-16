import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.money import CURRENCY_EXPONENTS, MAX_ABS_MINOR, MoneyError, format_minor, parse_amount


@pytest.mark.parametrize(
    ("text", "currency", "expected"),
    [
        ("12.34", "USD", 1234),
        ("-12.34", "USD", -1234),
        ("$1,234.56", "USD", 123456),
        ("-$5", "USD", -500),
        ("$-5.00", "USD", -500),
        ("(42.10)", "USD", -4210),
        ("+7.5", "USD", 750),
        (".99", "USD", 99),
        ("1500", "JPY", 1500),
        ("1.234", "KWD", 1234),
        ("  3.00  ", "EUR", 300),
    ],
)
def test_parse_amount(text: str, currency: str, expected: int) -> None:
    assert parse_amount(text, currency) == expected


@pytest.mark.parametrize(
    ("text", "currency"),
    [
        ("12.345", "USD"),  # sub-cent precision is rejected, never rounded
        ("1.5", "JPY"),
        ("abc", "USD"),
        ("", "USD"),
        ("1.2.3", "USD"),
        ("1e5", "USD"),  # no scientific notation sneaking in via Decimal
        ("NaN", "USD"),
        ("12.00", "XYZ"),
    ],
)
def test_parse_amount_rejects(text: str, currency: str) -> None:
    with pytest.raises(MoneyError):
        parse_amount(text, currency)


def test_float_trap_is_exact() -> None:
    # 0.1 + 0.2 != 0.3 in floating point; in minor units it is exact.
    assert parse_amount("0.10", "USD") + parse_amount("0.20", "USD") == parse_amount("0.30", "USD")


@given(
    minor=st.integers(min_value=-MAX_ABS_MINOR, max_value=MAX_ABS_MINOR),
    currency=st.sampled_from(sorted(CURRENCY_EXPONENTS)),
)
def test_format_then_parse_round_trips(minor: int, currency: str) -> None:
    assert parse_amount(format_minor(minor, currency), currency) == minor
