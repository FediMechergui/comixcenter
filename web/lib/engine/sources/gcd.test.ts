import { describe, expect, it } from "vitest";

import { AuthError, RateLimitError, SourceError } from "../contracts";
import {
  createGcdClient, createGcdPacer, flattenGcdCharacters, gcdIdFromUrl, gcdKeyDateToDate, parseGcdCharacters,
  parseGcdCreditEntries, parseGcdCredits, splitTopLevel,
} from "./gcd";
import type { GcdCharacter, GcdStory } from "./gcd";
import { MemoryCache, USER_AGENT } from "./http";
import { fakeClock, fixture, mockHttp, respond } from "./test-helpers";

const API = "https://www.comics.org/api/";

function setup(route: (url: string) => ReturnType<typeof respond> | undefined) {
  const clock = fakeClock();
  const http = mockHttp(route, clock);
  const cache = new MemoryCache(clock);
  const client = createGcdClient({ http, cache, pacer: createGcdPacer(clock) });
  return { clock, http, cache, client };
}
const ok = (name: string) => respond(200, fixture(`gcd/${name}`));
/** Story `characters` text from a real fixture, by sequence number */
const story = (file: string, seq: number): GcdStory =>
  fixture(`gcd/${file}`).story_set.find((s: GcdStory) => s.sequence_number === seq);
const byName = (list: GcdCharacter[], name: string) => list.find((c) => c.name === name)!;

describe("GCD client", () => {
  it("searches series by name and year with format=json and a polite User-Agent", async () => {
    const { http, client } = setup((url) =>
      url === `${API}series/name/Amazing%20Spider-Man/year/1963/?format=json` ? ok("series_name_asm_1963.json") : undefined);
    const [asm] = await client.seriesByName("Amazing Spider-Man", 1963);
    expect(http.calls[0].req.headers).toEqual({ "User-Agent": USER_AGENT, Accept: "application/json" });
    expect(asm).toMatchObject({ id: 1570, name: "The Amazing Spider-Man", year_began: 1963, year_ended: 1998,
                                publisher_id: 78, country: "us", language: "en" });
    expect(asm.active_issue_ids).toHaveLength(asm.issue_descriptors.length);
    expect(asm.active_issue_ids[0]).toBe(17568);
    expect(asm.active_issue_ids[asm.issue_descriptors.indexOf("300 [Direct]")]).toBe(44451);
    expect(asm.active_issue_ids[asm.issue_descriptors.indexOf("129")]).toBe(27163);
  });

  it("signs in with a comics.org account over HTTP Basic auth, and reports a rejected password", async () => {
    const clock = fakeClock();
    const http = mockHttp((url) => (url.includes("/series/name/Saga/") ? ok("series_name_hox_2019.json") : respond(401, { detail: "Invalid username/password." })), clock);
    const client = createGcdClient({ http, pacer: createGcdPacer(clock), auth: { username: "reader", password: "pässword" } });
    await client.searchSeries("Saga", null);
    expect(http.calls[0].req.headers?.Authorization).toBe(`Basic ${btoa(unescape(encodeURIComponent("reader:pässword")))}`);
    await expect(client.series(1)).rejects.toBeInstanceOf(AuthError);
  });

  it("returns every substring match (and works without a year)", async () => {
    const { http, client } = setup((url) => (url.startsWith(`${API}series/name/House%20of%20X/`) ? ok("series_name_hox_2019.json") : undefined));
    const found = await client.searchSeries("House of X", null);
    expect(http.calls[0].url).toBe(`${API}series/name/House%20of%20X/?format=json`);
    expect(found.map((s) => [s.id, s.name])).toEqual([
      [149031, "House of X"], [165565, "House of X / Powers of X"], [148927, "House of X / Powers of X Free Previews"],
    ]);
  });

  it("follows `next` pages up to maxPages", async () => {
    const page = (n: number, next: string | null) => respond(200, { count: 3, next, previous: null,
      results: [fixture("gcd/series_name_ntt_1980.json").results[0]].map((s) => ({ ...s, api_url: `${API}series/${n}/?format=json` })) });
    const { http, client } = setup((url) => {
      if (url === `${API}series/name/Titans/?format=json`) return page(1, `${API}series/name/Titans/?format=json&page=2`);
      if (url === `${API}series/name/Titans/?format=json&page=2`) return page(2, `${API}series/name/Titans/?format=json&page=3`);
      return page(3, null);
    });
    expect((await client.seriesByName("Titans", undefined, 2)).map((s) => s.id)).toEqual([1, 2]);
    expect(http.calls).toHaveLength(2);
  });

  it("fetches an issue with parsed ids and a cover date", async () => {
    const { http, client } = setup((url) => (url === `${API}issue/44451/?format=json` ? ok("issue_44451.json") : undefined));
    const issue = (await client.issue(44451))!;
    expect(http.calls[0].url).toBe(`${API}issue/44451/?format=json`);
    expect(issue).toMatchObject({ id: 44451, series_id: 1570, variant_of_id: null, number: "300", descriptor: "300 [Direct]",
      key_date: "1988-05-00", cover_date: "1988-05-01", on_sale_date: "1988-01-12", series_name: "The Amazing Spider-Man (1963 series)" });
    expect(issue.story_set).toHaveLength(15);
  });

  it("fetches series and publisher details, null on 404", async () => {
    const series = fixture("gcd/series_name_xmen_1963.json").results[0];
    const { client } = setup((url) => {
      if (url === `${API}series/1576/?format=json`) return respond(200, series);
      if (url === `${API}publisher/78/?format=json`) {
        return respond(200, { api_url: `${API}publisher/78/?format=json`, name: "Marvel", country: "us" });
      }
      if (url === `${API}publishers/`) return undefined;
      return respond(404, { detail: "Not found." });
    });
    expect(await client.series(1576)).toMatchObject({ id: 1576, name: "The X-Men", publisher_id: 78 });
    expect(await client.publisher(78)).toMatchObject({ id: 78, name: "Marvel" });
    expect(await client.issue(1)).toBeNull();
  });

  it("lists publishers one page at a time", async () => {
    const { http, client } = setup(() => respond(200, { count: 2, next: `${API}publisher/?format=json&page=3`, previous: null,
      results: [{ api_url: `${API}publisher/54/?format=json`, name: "DC" }] }));
    const page = await client.publishers(2);
    expect(http.calls[0].url).toBe(`${API}publisher/?page=2&format=json`);
    expect(page).toEqual({ count: 2, next: `${API}publisher/?format=json&page=3`, previous: null,
                           results: [{ api_url: `${API}publisher/54/?format=json`, name: "DC", id: 54 }] });
  });

  it("caches issues (long TTL) so a re-read costs no request", async () => {
    const { http, client, clock } = setup(() => ok("issue_27163.json"));
    await client.issue(27163);
    clock.advance(20 * 86_400_000);
    await client.issue(27163);
    expect(http.calls).toHaveLength(1);
  });

  it("paces requests ≥ 3.5s apart", async () => {
    const { http, client } = setup((url) => (url.includes("issue/724/") ? ok("issue_724.json") : ok("issue_26595.json")));
    await Promise.all([client.issue(724), client.issue(26595)]);
    expect(http.calls[1].at! - http.calls[0].at!).toBeGreaterThanOrEqual(3500);
  });

  it("waits a short 429 (Cloudflare burst) and retries once", async () => {
    let n = 0;
    const { http, client } = setup(() => (++n === 1 ? respond(429, { detail: "Request was throttled. Expected available in 50 seconds." },
                                                             { "retry-after": "50" }) : ok("issue_34709.json")));
    expect((await client.issue(34709))!.id).toBe(34709);
    expect(http.calls[1].at! - http.calls[0].at!).toBe(50_000);
  });

  it("raises RateLimitError for the long throttle (real response) and stops calling GCD", async () => {
    const { http, client } = setup(() => respond(429, fixture("gcd/throttled_429.json"), { "retry-after": "2895" }));
    const err = await client.issue(1).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterSeconds).toBe(2895);
    await expect(client.series(2)).rejects.toBeInstanceOf(RateLimitError);
    expect(http.calls).toHaveLength(1);
  });

  it("rejects non-JSON (Cloudflare challenge) answers", async () => {
    const { client } = setup(() => respond(403, "<!DOCTYPE html><title>Just a moment...</title>"));
    await expect(client.issue(1)).rejects.toBeInstanceOf(SourceError);
  });
});

describe("GCD helpers", () => {
  it("parses ids from API URLs and key dates", () => {
    expect(gcdIdFromUrl("https://www.comics.org/api/issue/44451/?format=json")).toBe(44451);
    expect(gcdIdFromUrl("https://www.comics.org/api/series/1570/")).toBe(1570);
    expect(gcdIdFromUrl(null)).toBeNull();
    expect(gcdKeyDateToDate("1988-05-00")).toBe("1988-05-01");
    expect(gcdKeyDateToDate("1940-04-00")).toBe("1940-04-01");
    expect(gcdKeyDateToDate("1965-00-00")).toBe("1965-01-01");
    expect(gcdKeyDateToDate("")).toBeNull();
  });

  it("splits only at the top level", () => {
    expect(splitTopLevel("A [B; C [D]]; E (x; y); F")).toEqual(["A [B; C [D]]", "E (x; y)", "F"]);
  });
});

describe("parseGcdCredits (real samples)", () => {
  it("strips notes and drops placeholders", () => {
    expect(parseGcdCredits("Phil Elliott (credited)")).toEqual(["Phil Elliott"]);
    expect(parseGcdCredits("Stan Lee; Steve Ditko")).toEqual(["Stan Lee", "Steve Ditko"]);
    expect(parseGcdCredits("None")).toEqual([]);
    expect(parseGcdCredits("?")).toEqual([]);
    expect(parseGcdCredits("[none]")).toEqual([]);
    expect(parseGcdCredits("?; ? (ad copy)")).toEqual([]);
    expect(parseGcdCredits("typeset")).toEqual([]);
    expect(parseGcdCredits("")).toEqual([]);
    expect(parseGcdCredits(null)).toEqual([]);
  });

  it("handles roles, signatures, uncertainty and duplicates from real issues", () => {
    const avengers300 = fixture("gcd/issue_45864.json");
    expect(parseGcdCredits(avengers300.editing)).toEqual(["Gregory Wright", "Mark Gruenwald", "Tom DeFalco"]);
    expect(parseGcdCredits(story("issue_45864.json", 0).pencils)).toEqual(["John Buscema"]); // "(signed as Buscema [all caps])"
    expect(parseGcdCredits(story("issue_45864.json", 1).pencils)).toEqual(["John Buscema", "Tom Palmer"]);
    expect(parseGcdCredits(story("issue_45864.json", 1).inks)).toEqual(["Tom Palmer", "Tom Morgan"]);
    expect(parseGcdCredits(story("issue_19164.json", 2).script)).toEqual(["Stan Lee", "Jack Kirby"]);
    expect(parseGcdCredits(story("issue_45864.json", 2).pencils)).toEqual(["John Byrne", "Kieron Dwyer"]); // "various" dropped
    expect(parseGcdCredits(story("issue_724.json", 2).inks)).toEqual(["Bob Kane", "Sheldon Moldoff"]);
    expect(parseGcdCredits(story("issue_69630.json", 1).script)).toEqual(["Brian Haberlin", "David Wohl", "Michael Turner"]);
    expect(parseGcdCredits(story("issue_34826.json", 0).pencils)).toEqual(["George Pérez"]); // "(signed as PEREZ [no spaces])"
  });

  it("keeps notes and the uncertainty flag in the structured form", () => {
    expect(parseGcdCreditEntries("Stan Lee ? (credited as The Bullpen Gang) (promo copy); Jack Kirby (sourced) (plot)")).toEqual([
      { name: "Stan Lee", notes: ["credited as The Bullpen Gang", "promo copy"], uncertain: true },
      { name: "Jack Kirby", notes: ["sourced", "plot"], uncertain: false },
    ]);
  });
});

describe("parseGcdCharacters (real samples)", () => {
  it("Amazing Spider-Man #300: persons, roles, cameo/flashback, first appearance, death", () => {
    const list = parseGcdCharacters(story("issue_44451.json", 2).characters);
    expect(list).toHaveLength(18);
    expect(byName(list, "Spider-Man")).toEqual({ name: "Spider-Man", person: "Peter Parker", role: "featured" });
    expect(byName(list, "Venom")).toEqual({ name: "Venom", person: "Eddie Brock", role: "villain", firstAppearance: true });
    expect(byName(list, "Mister Fantastic")).toEqual({ name: "Mister Fantastic", person: "Reed Richards", flashback: true, cameo: true });
    expect(byName(list, "The Thing")).toMatchObject({ person: "Ben Grimm", cameo: true });
    expect(byName(list, "Jack Sr.")).toEqual({ name: "Jack Sr.", firstAppearance: true, death: true }); // "(introduction, dies)"
    expect(byName(list, "Mary Jane Parker")).toEqual({ name: "Mary Jane Parker" });
  });

  it("Avengers #16: nested teams, joins/leaves notes, other-Earth notes", () => {
    const list = parseGcdCharacters(story("issue_19164.json", 2).characters);
    const avengers = byName(list, "The Avengers");
    expect(avengers.isTeam).toBe(true);
    expect(avengers.members!.map((m) => m.name)).toEqual(["Captain America", "Giant-Man", "Hawkeye", "Iron Man", "Quicksilver",
      "Scarlet Witch", "Thor", "Wasp"]);
    expect(byName(avengers.members!, "Hawkeye")).toEqual({ name: "Hawkeye", person: "Clint Barton", role: "featured",
      notes: ["joins team", "also in flashback"] });
    const brotherhood = byName(list, "Brotherhood of Evil Mutants");
    expect(byName(brotherhood.members!, "Toad")).toMatchObject({ person: "Mortimer Toynbee", flashback: true, cameo: true });
    expect(byName(byName(list, "Masters of Evil").members!, "Enchantress")).toMatchObject({ person: "Amora", role: "villain" });
    expect(byName(list, "Kang")).toEqual({ name: "Kang", person: "Nathaniel Richards", role: "guest", notes: ["Other Earth - Earth-6311"] });
    expect(byName(list, "Atlanteans")).toEqual({ name: "Atlanteans", role: "guest", notes: ["unnamed ones"] });
    expect(byName(list, "Edwin Jarvis")).toEqual({ name: "Edwin Jarvis", role: "supporting", notes: ["unnamed"] });
    expect(list.filter((c) => c.isTeam).map((c) => c.name)).toEqual(["The Avengers", "Brotherhood of Evil Mutants",
      "Masters of Evil", "X-Men"]);
  });

  it("X-Men #137: team member deaths and first appearances inside a team", () => {
    const list = parseGcdCharacters(story("issue_34709.json", 2).characters);
    const xmen = byName(list, "X-Men");
    expect(byName(xmen.members!, "Marvel Girl")).toEqual({ name: "Marvel Girl", person: "Jean Grey", death: true, role: "featured" });
    const guard = byName(list, "Imperial Guard");
    expect(guard.members!.filter((m) => m.firstAppearance).map((m) => m.name)).toEqual(["Earthquake", "Hussar", "Manta", "Warstar"]);
    expect(byName(guard.members!, "Warstar").person).toBe("B'nee and C'cil");
    expect(byName(list, "Dark Phoenix")).toMatchObject({ person: "Jean Grey", death: true, role: "villain" });
    expect(flattenGcdCharacters(list).filter((c) => c.death).map((c) => c.name)).toEqual(["Marvel Girl", "Dark Phoenix"]);
  });

  it("Avengers #300: team-only cover, trailing bracket note, empty trailing entry", () => {
    const cover = parseGcdCharacters(story("issue_45864.json", 0).characters);
    expect(cover).toHaveLength(1);
    expect(cover[0].members!.map((m) => m.person ?? m.name)).toEqual(["Steve Rogers", "Gilgamesh", "Susan Storm Richards",
      "Reed Richards", "Sigurd Jarlson"]);
    const park = parseGcdCharacters(story("issue_45864.json", 6).characters);
    expect(park[0]).toMatchObject({ name: "the Avengers", isTeam: true, notes: ["statues"] });
    expect(byName(park[0].members!, "Hawkeye")).toEqual({ name: "Hawkeye" });
  });

  it("Batman #1 (1940): comma-separated notes", () => {
    const origin = parseGcdCharacters(story("issue_724.json", 2).characters);
    expect(byName(origin, "Batman")).toEqual({ name: "Batman", person: "Bruce Wayne", role: "featured", notes: ["origin"] });
    expect(byName(origin, "Thomas Wayne")).toEqual({ name: "Thomas Wayne", flashback: true, death: true });
    expect(byName(origin, "Joe Chill")).toEqual({ name: "Joe Chill", role: "villain", notes: ["un-named"] });
    const joker = parseGcdCharacters(story("issue_724.json", 3).characters);
    expect(byName(joker, "The Joker")).toEqual({ name: "The Joker", role: "villain", firstAppearance: true });
    expect(byName(joker, "Henry Claridge")).toEqual({ name: "Henry Claridge", notes: ["millionaire"], death: true });
    expect(byName(joker, "Otto Drexel").notes).toEqual(["mention only"]);
    const strange = parseGcdCharacters(story("issue_724.json", 5).characters);
    expect(byName(strange, "Monster Men")).toEqual({ name: "Monster Men", role: "villain", firstAppearance: true, death: true });
  });

  it("New Teen Titans #1 and Witchblade #2: joins team, no space before notes, (dead) is not a death", () => {
    const titans = parseGcdCharacters(story("issue_34826.json", 1).characters);
    expect(byName(byName(titans, "Teen Titans").members!, "Raven")).toEqual({ name: "Raven", role: "featured", notes: ["joins team"] });
    expect(byName(titans, "Grant Wilson")).toEqual({ name: "Grant Wilson", firstAppearance: true, notes: ["becomes Ravager next issue"] });
    expect(byName(titans, "Gordanians")).toMatchObject({ isTeam: true, notes: ["aliens"] });
    const wb = parseGcdCharacters(story("issue_69630.json", 1).characters);
    expect(byName(wb, "Kenneth Irons")).toEqual({ name: "Kenneth Irons", role: "villain" });
    expect(byName(wb, "Wai-Hong Tong")).toEqual({ name: "Wai-Hong Tong", role: "villain", death: true });
    expect(byName(wb, "Michale Yee")).toEqual({ name: "Michale Yee", notes: ["dead"] });
  });

  it("House of X #1: skips descriptive sentences pasted into the field", () => {
    const promo = fixture("gcd/issue_1998963.json").story_set.find((s: GcdStory) => s.characters.startsWith("Illustration"));
    expect(parseGcdCharacters(promo.characters)).toEqual([]);
    const main = parseGcdCharacters(story("issue_1998963.json", 3).characters);
    expect(byName(main, "Colossus")).toEqual({ name: "Colossus", person: "Piotr Rasputin", cameo: true, notes: ["Only his Hand"] });
    expect(byName(byName(main, "Fantastic Four").members!, "Thing")).toEqual({ name: "Thing", person: "Ben Grimm", role: "guest" });
  });
});

describe("parseGcdCharacters (older label conventions)", () => {
  it("applies group labels until the next one", () => {
    const list = parseGcdCharacters("Spider-Man [Peter Parker]; Mary Jane Watson; Villains: Venom [Eddie Brock]; Carnage");
    expect(list).toEqual([
      { name: "Spider-Man", person: "Peter Parker" },
      { name: "Mary Jane Watson" },
      { name: "Venom", person: "Eddie Brock", group: "villains", role: "villain" },
      { name: "Carnage", group: "villains", role: "villain" },
    ]);
  });

  it("understands Featuring / Guest stars / Cameo / Introducing", () => {
    const list = parseGcdCharacters("Featuring: Batman [Bruce Wayne]; Robin; Guest stars: Superman [Clark Kent]; " +
                                    "Cameo: Lois Lane; Introducing: Bat-Mite; Introducing Ace the Bat-Hound");
    expect(list.map((c) => [c.name, c.group, c.role, !!c.cameo, !!c.firstAppearance])).toEqual([
      ["Batman", "featuring", "featured", false, false],
      ["Robin", "featuring", "featured", false, false],
      ["Superman", "guest stars", "guest", false, false],
      ["Lois Lane", "cameo", undefined, true, false],
      ["Bat-Mite", "introducing", undefined, false, true],
      ["Ace the Bat-Hound", "introducing", undefined, false, true],
    ]);
  });

  it("parses teams with nested persons and first-appearance / death markers", () => {
    expect(parseGcdCharacters("Avengers [Captain America [Steve Rogers]; Thor]; Ultron (first appearance); Swordsman (death)")).toEqual([
      { name: "Avengers", isTeam: true, members: [{ name: "Captain America", person: "Steve Rogers" }, { name: "Thor" }] },
      { name: "Ultron", firstAppearance: true },
      { name: "Swordsman", death: true },
    ]);
  });

  it("tolerates unbalanced brackets and uncertain identifications", () => {
    expect(parseGcdCharacters("Hawkeye ?; Mockingbird [Bobbi Morse")).toEqual([
      { name: "Hawkeye", uncertain: true },
      { name: "Mockingbird", notes: ["Bobbi Morse"] },
    ]);
  });
});
