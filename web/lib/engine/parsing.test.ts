import { describe, expect, it } from "vitest";
import { normalizeIssueNumber, numberSort, parseComicTitle, splitMantle, tokenSortRatio, words } from "./parsing";

// Same cases as backend/tests/test_title_cleaner.py
const CASES: [string, string, string | null, number | null, string, string][] = [
  ["X-Men (2024-) #1", "X-Men", "1", 2024, "Issue", "Marvel"],
  ["X-Men (2024-2025) #1", "X-Men", "1", 2024, "Issue", "Marvel"],
  ["Saga #001 (2024)", "Saga", "1", 2024, "Issue", "Image"],
  ["Hulk #1.MU (2026)", "Hulk", "1.MU", 2026, "Issue", "Marvel"],
  ["Abominations 1 - 3 (2025)", "Abominations", "1-3", 2025, "Issue", "Independent"],
  ["Absolute Batman #1 – 3 (2025)", "Absolute Batman", "1-3", 2025, "Issue", "DC"],
  ["Batman Vol. 1 (2016)", "Batman", null, 2016, "TPB", "DC"],
  ["Amazing Spider-Man Vol. 6 #1 (2022)", "Amazing Spider-Man", "1", 2022, "Issue", "Marvel"],
  ["Batman Annual #1 (2025)", "Batman Annual", "1", 2025, "Annual", "DC"],
  ["Thorgal #5 (2024)", "Thorgal", "5", 2024, "Issue", "Independent"],
  ["Robin Hood #2", "Robin Hood", "2", null, "Issue", "Independent"],
  ["Flashpoint Beyond #1", "Flashpoint Beyond", "1", null, "Issue", "Independent"],
  ["Swamp Thing #3 (2026)", "Swamp Thing", "3", 2026, "Issue", "DC"],
  ["Hellboy &#8211; The Crooked Man (2008)", "Hellboy – The Crooked Man", null, 2008, "Issue", "Dark Horse"],
  ["Power Rangers #10 (2025) (Digital) (Zone-Empire)", "Power Rangers", "10", 2025, "Issue", "BOOM!"],
];

describe("parseComicTitle", () => {
  it.each(CASES)("%s", (title, series, issue, year, format, publisher) => {
    const r = parseComicTitle(title);
    expect([r.series_name, r.issue_number, r.year, r.format, r.publisher]).toEqual([series, issue, year, format, publisher]);
  });

  it("prefers a category hint", () => {
    expect(parseComicTitle("Some Indie Book #1", "marvel").publisher).toBe("Marvel");
    expect(parseComicTitle("Saga #1", "other").publisher).toBe("Image");
  });
});

describe("helpers", () => {
  it("normalizes issue numbers", () => {
    expect(["001", "0", "000", "01-03", "1.MU"].map(normalizeIssueNumber)).toEqual(["1", "0", "0", "1-3", "1.MU"]);
    expect(normalizeIssueNumber(null)).toBeNull();
  });

  it("sorts issue numbers", () => {
    expect(numberSort("1")).toBeLessThan(numberSort("1.MU"));
    expect(numberSort("1.MU")).toBeLessThan(numberSort("2"));
    expect(numberSort("½")).toBe(0.5);
    expect(numberSort("Annual")).toBe(1e9);
  });

  it("splits mantles", () => {
    expect(splitMantle("Spider-Man (Miles Morales)")).toEqual(["Spider-Man", "Miles Morales"]);
    expect(splitMantle("Thor")).toEqual(["Thor", "Thor"]);
    expect(splitMantle("Thor (Earth-1610)")).toEqual(["Thor (Earth-1610)", "Thor (Earth-1610)"]);
  });

  it("matches RapidFuzz token_sort_ratio", () => {
    expect(tokenSortRatio("Spider-Man Amazing", "Amazing Spider-Man")).toBe(100);
    // RapidFuzz: fuzz.token_sort_ratio("Batman", "Batman Beyond") == 63.157...
    expect(tokenSortRatio("Batman", "Batman Beyond")).toBeCloseTo(63.157, 2);
    expect(words("The Amazing Spider-Man", "#300")).toEqual(["the", "amazing", "spider", "man", "300"]);
  });
});
