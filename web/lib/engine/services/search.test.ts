import { afterEach, beforeEach, expect, it } from "vitest";
import { ComixDB, db, useDatabase } from "../db";
import { search } from "./search";

beforeEach(async () => {
  useDatabase(new ComixDB(`search-editions-${Math.random()}`));
  for (const [id, year] of [[1,2016],[2,2024]]) {
    await db().series.add({ id, name: "Batman", year_began: year, words: ["batman"] });
    await db().issues.add({ id, series_id: id, number: "1", number_sort: 1, words: ["batman","1"] });
  }
});
afterEach(async () => { await db().delete(); });
it("uses an edition year as a filter even when it is not in the title index", async () => {
  const result = await search("Batman (2024)");
  expect(result.results.filter((r) => r.kind === "series").map((r) => r.id)).toEqual([2]);
});
it("keeps issue numbers while distinguishing series editions", async () => {
  const result = await search("Batman 2024 #1", ["issue"]);
  expect(result.results.map((r) => r.id)).toEqual([2]);
  expect(result.results[0].subtitle).toContain("2024 series");
});
