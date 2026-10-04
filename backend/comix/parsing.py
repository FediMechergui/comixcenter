import re
import html
from typing import Dict, Any, Optional

PUBLISHER_KEYWORDS = {
    "marvel": ["marvel", "avengers", "spider-man", "spiderman", "x-men", "x-force", "daredevil", "thor", "iron man", "hulk", "wolverine", "venom", "fantastic four", "captain america"],
    "dc": ["dc comics", "jla", "jsa", "batman", "superman", "wonder woman", "flash", "green lantern", "justice league", "aquaman", "harley quinn", "nightwing", "shazam", "catwoman", "robin", "titans", "swamp thing"],
    "image": ["image comics", "spawn", "saga", "invincible", "monstress", "walking dead", "radiant black", "witchblade"],
    "dark horse": ["dark horse", "hellboy", "b.p.r.d.", "sin city", "aliens", "predator", "black hammer"],
    "idw": ["idw", "tmnt", "teenage mutant ninja turtles", "transformers", "sonic the hedgehog", "locke & key"],
    "boom": ["boom! studios", "boom studios", "power rangers", "something is killing the children", "brzrkr"],
    "dynamite": ["dynamite", "the boys", "red sonja", "vampirella"],
}

PUBLISHER_DISPLAY_NAMES = {
    "marvel": "Marvel",
    "dc": "DC",
    "image": "Image",
    "dark horse": "Dark Horse",
    "idw": "IDW",
    "boom": "BOOM!",
    "dynamite": "Dynamite",
}

# Phrases that contain a publisher keyword but belong to nobody in particular.
KEYWORD_EXCLUSIONS = ["robin hood"]

# "#1", "#001", "#1.5", "#1.MU", "#1 – 3", "#1-#5"
ISSUE_RE = re.compile(r'#\s*(\d+(?:\.\d+)?(?:\.[A-Za-z]+)?)(?:\s*[-–]\s*#?\s*(\d+(?:\.\d+)?))?')
# "Abominations 1 - 3 (2025)": a bare range right before the year or at the end
BARE_RANGE_RE = re.compile(r'(?<![\d(])\b(\d{1,4})\s*[-–]\s*(\d{1,4})\s*(?=\(|$)')
# "(2026)", "(2024-)", "(2024-2025)", "(2024 - )"
YEAR_RE = re.compile(r'\((\d{4})(?:\s*[-–]\s*(?:\d{4})?)?\s*\)')
VOLUME_RE = re.compile(r'(?:\bVol\.?|\bVolume)\s*(\d+)', re.IGNORECASE)
RELEASE_TAG_RE = re.compile(r'\s*\([^)]*(?:TPB|Omnibus|Digital|Webrip|Empire|Kileko)[^)]*\)', re.IGNORECASE)


def clean_html(raw_html: str) -> str:
    """Strip HTML tags and unescape entities."""
    text = re.sub(r'<[^>]+>', '', raw_html)
    return html.unescape(text).strip()


def normalize_issue_number(issue: Optional[str]) -> Optional[str]:
    """Canonical issue form so "001", "1" and "01" compare equal; ranges become "1-3"."""
    if not issue:
        return None
    parts = re.split(r'\s*[-–]\s*', issue.strip())
    normalized = []
    for part in parts:
        m = re.match(r'0*(\d+)(.*)$', part)
        normalized.append(f"{m.group(1)}{m.group(2)}" if m else part)
    return "-".join(normalized)


def _keyword_in(keyword: str, text: str) -> bool:
    # Whole-word match, so "thor" doesn't hit "Thorgal" and "flash" doesn't hit "Flashpoint"
    return re.search(rf'(?<![a-z0-9]){re.escape(keyword)}(?![a-z0-9])', text) is not None


def detect_publisher(title_lower: str, category_name: Optional[str] = None) -> str:
    if category_name:
        cat_lower = category_name.lower()
        for key in ("marvel", "dc", "image", "dark horse"):
            if _keyword_in(key, cat_lower):
                return PUBLISHER_DISPLAY_NAMES[key]

    text = title_lower
    for phrase in KEYWORD_EXCLUSIONS:
        text = text.replace(phrase, " ")
    for pub, keywords in PUBLISHER_KEYWORDS.items():
        if any(_keyword_in(k, text) for k in keywords):
            return PUBLISHER_DISPLAY_NAMES[pub]
    return "Independent"


def parse_comic_title(raw_title: str, category_name: Optional[str] = None) -> Dict[str, Any]:
    """
    Parses a raw comic title string into structured comic components:
    - clean_title
    - series_name
    - issue_number (normalized: no leading zeros, ranges as "1-3"; None for collections)
    - volume
    - year
    - format (Issue, TPB, Omnibus, Weekly Pack, Annual)
    - publisher (Marvel, DC, etc.)
    """
    title = clean_html(raw_title)
    title_lower = title.lower()

    # 1. Extract Year: e.g. (2026), (2024-), (2024-2025)
    year = None
    year_match = YEAR_RE.search(title)
    if year_match:
        year = int(year_match.group(1))

    # 2. Extract Volume: e.g. Vol. 1, Vol 2, Volume 3
    volume = None
    vol_match = VOLUME_RE.search(title)
    if vol_match:
        volume = vol_match.group(1)

    # 3. Extract Issue Number
    issue_number = None
    issue_match = ISSUE_RE.search(title)
    if issue_match:
        issue_number = issue_match.group(1)
        if issue_match.group(2):
            issue_number = f"{issue_number}-{issue_match.group(2)}"
    else:
        named = re.search(r'\b(?:Issue|Chapter)\s*(\d+)', title, re.IGNORECASE)
        bare = BARE_RANGE_RE.search(title)
        if named:
            issue_number = named.group(1)
        elif bare:
            issue_number = f"{bare.group(1)}-{bare.group(2)}"
    issue_number = normalize_issue_number(issue_number)

    # 4. Detect Format. "Vol." alone only means a collection when there's no issue number.
    fmt = "Issue"
    if "weekly pack" in title_lower or "week pack" in title_lower:
        fmt = "Weekly Pack"
    elif "omnibus" in title_lower:
        fmt = "Omnibus"
    elif "tpb" in title_lower or "trade paperback" in title_lower or (volume and not issue_number):
        fmt = "TPB"
    elif _keyword_in("annual", title_lower):
        fmt = "Annual"

    # 5. Extract Series Name: remove year, release tags, issue number and volume
    clean = re.sub(r'\s*\(\d{4}.*?\)', '', title)
    clean = RELEASE_TAG_RE.sub('', clean)
    clean = ISSUE_RE.sub('', clean)
    if not issue_match:
        clean = BARE_RANGE_RE.sub('', clean)
    clean = VOLUME_RE.sub('', clean)
    clean = re.sub(r'\s{2,}', ' ', clean).strip(" -–:,")

    return {
        "title": title,
        "clean_title": clean or title,
        "series_name": clean or title,
        "issue_number": issue_number,
        "volume": volume,
        "year": year,
        "format": fmt,
        "publisher": detect_publisher(title_lower, category_name),
    }
