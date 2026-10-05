import { describe, expect, it } from "vitest";

import { cvText } from "./comicvine";
import { gcdDate, searchGcd, type GcdApi } from "./gcd";

const series = (id: number, name: string, issues: number) => ({ id, name, year_began: 2000, active_issue_ids: Array.from({ length: issues }, (_, i) => i) });

describe("searchGcd", () => {
  it("puts the exact title first, then prefixes, then longer runs", async () => {
    const api = {
      searchSeries: async () => [series(1, "Star Wars Saga", 3), series(2, "Sagas of the Swamp", 1), series(3, "Saga", 66), series(4, "The Saga", 2), series(5, "Saga of the Swamp Thing", 40)],
    } as unknown as GcdApi;
    expect((await searchGcd(api, "saga")).map((s) => s.gcd_id)).toEqual([3, 4, 5, 2, 1]);
  });

  it("ignores accents and leading articles", async () => {
    const api = { searchSeries: async () => [series(1, "Astérix et Cléopâtre", 1), series(2, "Les Astérix", 1), series(3, "Astérix", 40)] } as unknown as GcdApi;
    expect((await searchGcd(api, "Asterix")).map((s) => s.gcd_id)).toEqual([3, 2, 1]);
  });
});

describe("gcdDate", () => {
  it("fills unknown months and days", () => {
    expect(gcdDate("1987-00-00")).toBe("1987-01-01");
    expect(gcdDate("2012-03-14")).toBe("2012-03-14");
    expect(gcdDate("")).toBeNull();
  });
});

describe("cvText", () => {
  it("drops Comic Vine's cover-credit table", () => {
    const html = "<p>New parents Marko and Alana risk everything.</p><h4>List of covers and their creators:</h4><table><tr><td>Reg</td><td>Fiona Staples</td></tr></table>";
    expect(cvText(html)).toBe("New parents Marko and Alana risk everything.");
  });
});
