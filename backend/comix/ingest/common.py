"""Small helpers shared by the Metron and Comic Vine sync code."""
import re
from datetime import datetime, timezone
from typing import Any, Optional, Tuple

_NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")
_FRACTIONS = {"½": 0.5, "¼": 0.25, "¾": 0.75}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def number_sort(number: Optional[str]) -> float:
    """Sortable value for issue numbers: "1" < "1.MU" < "2", "½" = 0.5, non-numeric last."""
    if not number:
        return 1e9
    text = number.strip()
    for frac, value in _FRACTIONS.items():
        if text.startswith(frac):
            return value
    m = _NUMBER_RE.search(text)
    if not m:
        return 1e9
    value = float(m.group(0))
    # Suffixes like "1.MU" or "1AU" sort just after the plain number
    return value + (0.001 if text[m.end():].strip() else 0.0)


_MANTLE_RE = re.compile(r"^(?P<mantle>.+?)\s*\((?P<person>[^()]+)\)\s*$")


def split_mantle(name: str) -> Tuple[str, str]:
    """
    "Spider-Man (Miles Morales)" → ("Spider-Man", "Miles Morales").
    Names without a person in parentheses are their own mantle: "Thor" → ("Thor", "Thor").
    Parentheses holding an earth/universe tag are kept on the mantle: "Thor (Earth-1610)".
    """
    m = _MANTLE_RE.match(name.strip())
    if m and not re.search(r"\b(earth|universe|\d{3,})", m.group("person"), re.IGNORECASE):
        return m.group("mantle").strip(), m.group("person").strip()
    return name.strip(), name.strip()


def url_or_none(value: Any) -> Optional[str]:
    return str(value) if value else None


def strip_html(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    import html
    cleaned = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", text, flags=re.S | re.I)
    cleaned = re.sub(r"<br\s*/?>|</p>|</h\d>|</li>", "\n", cleaned, flags=re.I)
    cleaned = html.unescape(re.sub(r"<[^>]+>", "", cleaned))
    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    cleaned = re.sub(r"\n\s*\n+", "\n\n", cleaned).strip()
    return cleaned or None
