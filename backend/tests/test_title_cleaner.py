import pytest
from app.parser.title_cleaner import parse_comic_title, normalize_issue_number


@pytest.mark.parametrize("title, series, issue, year, fmt, publisher", [
    ("X-Men (2024-) #1", "X-Men", "1", 2024, "Issue", "Marvel"),
    ("X-Men (2024-2025) #1", "X-Men", "1", 2024, "Issue", "Marvel"),
    ("Saga #001 (2024)", "Saga", "1", 2024, "Issue", "Image"),
    ("Hulk #1.MU (2026)", "Hulk", "1.MU", 2026, "Issue", "Marvel"),
    ("Abominations 1 - 3 (2025)", "Abominations", "1-3", 2025, "Issue", "Independent"),
    ("Absolute Batman #1 – 3 (2025)", "Absolute Batman", "1-3", 2025, "Issue", "DC"),
    ("Batman Vol. 1 (2016)", "Batman", None, 2016, "TPB", "DC"),
    ("Amazing Spider-Man Vol. 6 #1 (2022)", "Amazing Spider-Man", "1", 2022, "Issue", "Marvel"),
    ("Batman Annual #1 (2025)", "Batman Annual", "1", 2025, "Annual", "DC"),
    ("Thorgal #5 (2024)", "Thorgal", "5", 2024, "Issue", "Independent"),
    ("Robin Hood #2", "Robin Hood", "2", None, "Issue", "Independent"),
    ("Flashpoint Beyond #1", "Flashpoint Beyond", "1", None, "Issue", "Independent"),
    ("Swamp Thing #3 (2026)", "Swamp Thing", "3", 2026, "Issue", "DC"),
    ("Hellboy &#8211; The Crooked Man (2008)", "Hellboy – The Crooked Man", None, 2008, "Issue", "Dark Horse"),
    ("Power Rangers #10 (2025) (Digital) (Zone-Empire)", "Power Rangers", "10", 2025, "Issue", "BOOM!"),
])
def test_parse_comic_title(title, series, issue, year, fmt, publisher):
    r = parse_comic_title(title)
    assert (r["series_name"], r["issue_number"], r["year"], r["format"], r["publisher"]) == \
           (series, issue, year, fmt, publisher)


def test_category_hint_wins_over_keywords():
    assert parse_comic_title("Some Indie Book #1", category_name="marvel")["publisher"] == "Marvel"
    assert parse_comic_title("Saga #1", category_name="other")["publisher"] == "Image"


@pytest.mark.parametrize("raw, expected", [
    ("001", "1"), ("0", "0"), ("000", "0"), ("01-03", "1-3"), ("1.MU", "1.MU"), (None, None),
])
def test_normalize_issue_number(raw, expected):
    assert normalize_issue_number(raw) == expected
