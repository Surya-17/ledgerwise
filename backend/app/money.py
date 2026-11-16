"""Money helpers.

All amounts are stored and computed as integers in the currency's minor unit
(cents for USD, yen for JPY, fils for KWD). Floats never touch money: decimal
strings are parsed with `Decimal` and rejected if they carry more precision than
the currency allows, instead of being silently rounded.
"""

import re
from decimal import Decimal

# ISO 4217 minor-unit exponents for the currencies we support.
CURRENCY_EXPONENTS: dict[str, int] = {
    "USD": 2,
    "EUR": 2,
    "GBP": 2,
    "INR": 2,
    "CAD": 2,
    "AUD": 2,
    "SGD": 2,
    "CHF": 2,
    "JPY": 0,
    "KWD": 3,
}

# Largest absolute amount accepted in a single line (10 trillion major units of a
# 2-decimal currency). Keeps sums comfortably inside a signed 64-bit integer.
MAX_ABS_MINOR = 10**15

_NUMBER = re.compile(r"(\d+(\.\d+)?|\.\d+)")
_SYMBOLS = "$€£₹¥"


class MoneyError(ValueError):
    pass


def exponent(currency: str) -> int:
    try:
        return CURRENCY_EXPONENTS[currency]
    except KeyError:
        raise MoneyError(f"Unsupported currency '{currency}'") from None


def parse_amount(text: str, currency: str) -> int:
    """Parse a bank-statement style amount into minor units.

    Accepts "1234.5", "-12.00", "$1,234.56", "-$5", "(42.10)" (accounting negative).
    Assumes '.' is the decimal separator and ',' groups thousands.
    """
    s = text.strip().replace(",", "").replace(" ", "")
    negative = False
    if s.startswith("(") and s.endswith(")"):
        negative, s = True, s[1:-1]
    if s[:1] in ("+", "-"):
        negative ^= s[0] == "-"
        s = s[1:]
    s = s.lstrip(_SYMBOLS)
    if s[:1] == "-":  # "$-12.00"
        negative, s = not negative, s[1:]
    if not _NUMBER.fullmatch(s):
        raise MoneyError(f"'{text}' is not a valid amount")

    scaled = Decimal(s).scaleb(exponent(currency))
    if scaled != scaled.to_integral_value():
        raise MoneyError(f"'{text}' has more decimal places than {currency} allows")
    minor = int(scaled)
    if minor > MAX_ABS_MINOR:
        raise MoneyError(f"'{text}' is too large")
    return -minor if negative else minor


def format_minor(minor: int, currency: str) -> str:
    """Render minor units as a plain decimal string, e.g. -123456 USD -> '-1234.56'."""
    exp = exponent(currency)
    value = Decimal(minor).scaleb(-exp)
    return f"{value:.{exp}f}"
