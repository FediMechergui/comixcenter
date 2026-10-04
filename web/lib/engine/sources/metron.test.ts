import { describe, expect, it } from "vitest";

import { AuthError, NotFoundError, RateLimitError, SourceError } from "../contracts";
import { MemoryCache, USER_AGENT } from "./http";
import { createMetronClient, createMetronPacer, metronAuthHeader, testMetron } from "./metron";
import { fakeClock, fixture, mockHttp, respond } from "./test-helpers";

const API = "https://metron.cloud/api/";

function setup(routes: Record<string, unknown>, opts: { auth?: { token: string } | { username: string; password: string } } = {}) {
  const clock = fakeClock();
  const http = mockHttp((url) => (url in routes ? (routes[url] as ReturnType<typeof respond>) : undefined), clock);
  const cache = new MemoryCache(clock);
  const client = createMetronClient({ http, auth: opts.auth ?? { token: "tok123" }, cache, pacer: createMetronPacer(clock) });
  return { clock, http, cache, client };
}

const ok = (name: string, headers?: Record<string, string>) => respond(200, fixture(`metron/${name}`), headers);

describe("Metron auth", () => {
  it("sends a Bearer token or HTTP Basic credentials like mokkari", async () => {
    expect(metronAuthHeader({ token: "abc" })).toBe("Bearer abc");
    expect(metronAuthHeader({ username: "user", password: "pass" })).toBe("Basic dXNlcjpwYXNz");

    const { http, client } = setup({ [`${API}publisher/1/`]: ok("publisher_1.json") }, { auth: { username: "user", password: "pass" } });
    await client.publisher(1);
    expect(http.calls[0].req.headers).toEqual({
      "User-Agent": USER_AGENT, Accept: "application/json", Authorization: "Basic dXNlcjpwYXNz",
    });
  });

  it("maps 401 to AuthError", async () => {
    const { client } = setup({ [`${API}issue/1/`]: respond(401, fixture("metron/auth_failed.json")) });
    const err = await client.issue(1).catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toContain("Invalid username/password.");
  });

  it("testMetron validates with one uncached request", async () => {
    const empty = respond(200, { count: 0, next: null, previous: null, results: [] });
    const good = mockHttp((url) => (url === `${API}publisher/?name=comixcenter-credential-check` ? empty : undefined));
    expect(await testMetron({ http: good, auth: { token: "t" }, pacer: createMetronPacer(fakeClock()) }))
      .toEqual({ ok: true, message: "Metron credentials accepted" });
    const bad = mockHttp(() => respond(401, fixture("metron/auth_failed.json")));
    expect((await testMetron({ http: bad, auth: { token: "t" }, pacer: createMetronPacer(fakeClock()) })).ok).toBe(false);
  });
});

describe("Metron details (mokkari attribute names)", () => {
  it("maps an issue: title→collection_title, name→story_titles, page→page_count", async () => {
    const { http, client } = setup({ [`${API}issue/1003/`]: ok("issue_1003.json") });
    const issue = (await client.issue(1003))!;
    expect(http.calls[0].url).toBe(`${API}issue/1003/`);
    expect(issue.collection_title).toBe("");
    expect(issue.story_titles).toEqual(["Venom"]);
    expect(issue.page_count).toBe(52);
    expect(issue.price).toBe(1.5);
    expect(issue.cover_date).toBe("1988-05-01");
    expect(issue.store_date).toBe("1988-01-12");
    expect(issue.series).toMatchObject({ id: 10, name: "Amazing Spider-Man", volume: 1, year_began: 1963,
                                         series_type: { id: 1, name: "Ongoing Series" } });
    expect(issue.publisher).toEqual({ id: 1, name: "Marvel" });
    expect(issue.imprint).toBeNull();
    expect(issue.credits[1]).toEqual({ id: 901, creator: "Todd McFarlane",
      role: [{ id: 2, name: "Penciller" }, { id: 3, name: "Inker" }, { id: 7, name: "Cover" }] });
    expect(issue.characters.map((c) => c.name)).toEqual(["Spider-Man", "Mary Jane Watson", "Venom (Eddie Brock)"]);
    expect(issue.teams[0]).toMatchObject({ id: 200, name: "Avengers" });
    expect(issue.universes[0]).toMatchObject({ id: 1, name: "Earth 616" });
    expect(issue.arcs[0]).toMatchObject({ id: 300, name: "Venom" });
    expect(issue.reprints).toEqual([{ id: 5001, issue: "Amazing Spider-Man (1963) #299" }]);
    expect(issue.variants[0]).toMatchObject({ name: "Newsstand", price: 1.5, upc: "071486020026" });
    expect(issue).toMatchObject({ cv_id: 7000, gcd_id: 44451, isbn: "", upc: "", desc: "Eddie Brock becomes Venom." });
    expect(issue).not.toHaveProperty("title");
    expect(issue).not.toHaveProperty("page");
  });

  it("maps series, publisher, universe, arc, character, team and reading list", async () => {
    const { client } = setup({
      [`${API}series/10/`]: ok("series_10.json"), [`${API}publisher/1/`]: ok("publisher_1.json"),
      [`${API}universe/1/`]: ok("universe_1.json"), [`${API}arc/300/`]: ok("arc_300.json"),
      [`${API}character/100/`]: ok("character_100.json"), [`${API}team/200/`]: ok("team_200.json"),
      [`${API}reading_list/500/`]: ok("reading_list_500.json"),
    });
    const series = (await client.series(10))!;
    expect(series).toMatchObject({ name: "Amazing Spider-Man", sort_name: "Amazing Spider-Man", volume: 1, year_began: 1963,
      year_end: 1998, status: "Completed", issue_count: 441, cv_id: 2127, gcd_id: 1570, imprint: null,
      series_type: { id: 1, name: "Ongoing Series" }, publisher: { id: 1, name: "Marvel" }, desc: "Peter Parker's flagship title." });
    expect(series.associated).toEqual([{ id: 2295, name: "Amazing Spider-Man Annual (1964)" }]);

    expect(await client.publisher(1)).toMatchObject({ desc: expect.stringContaining("Marvel"), founded: 1939, country: "US",
      image: "https://static.metron.cloud/media/publisher/2018/11/11/marvel.jpg", cv_id: 31, gcd_id: 78 });
    expect(await client.universe(1)).toMatchObject({ name: "Earth 616", designation: "Earth-616", publisher: { id: 1, name: "Marvel" } });
    expect(await client.arc(300)).toMatchObject({ name: "Venom", image: null, cv_id: 55660 });
    expect(await client.character(100)).toMatchObject({ alias: ["Spidey", "Web-Head"], cv_id: 1443,
      teams: [{ id: 200, name: "Avengers" }] });
    expect(await client.team(200)).toMatchObject({ name: "Avengers", cv_id: 3806, desc: "Earth's Mightiest Heroes." });
    const rl = (await client.readingList(500))!;
    expect(rl).toMatchObject({ name: "Krakoa Essentials", attribution_source: "CBRO", attribution_url: null,
      desc: "Start of the Krakoa era.", next: { id: 501, name: "Krakoa: Reign of X" }, user: { id: 7, username: "metron" } });
  });

  it("returns null for a 404 detail, throws NotFoundError for a 404 list", async () => {
    const notFound = respond(404, fixture("metron/not_found.json"));
    const { client } = setup({ [`${API}issue/9/`]: notFound, [`${API}series/9/issue_list/`]: notFound });
    expect(await client.issue(9)).toBeNull();
    await expect(client.seriesIssuesList(9)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("raises SourceError for other failures and DRF `detail` bodies", async () => {
    const { client } = setup({ [`${API}issue/2/`]: respond(500, "<html>"), [`${API}issue/3/`]: respond(200, { detail: "Odd." }) });
    await expect(client.issue(2)).rejects.toBeInstanceOf(SourceError);
    await expect(client.issue(3)).rejects.toThrow("Odd.");
  });
});

describe("Metron lists", () => {
  it("follows `next` and maps issue rows (issue → issue_name)", async () => {
    const { http, client } = setup({
      [`${API}series/10/issue_list/`]: ok("series_10_issue_list_page1.json"),
      [`${API}series/10/issue_list/?page=2`]: ok("series_10_issue_list_page2.json"),
    });
    const issues = await client.seriesIssuesList(10);
    expect(http.calls.map((c) => c.url)).toEqual([`${API}series/10/issue_list/`, `${API}series/10/issue_list/?page=2`]);
    expect(issues.map((i) => i.id)).toEqual([1001, 1002, 1003]);
    expect(issues[2]).toEqual({
      id: 1003, number: "300", cover_date: "1988-05-01", store_date: null, foc_date: null,
      image: "https://static.metron.cloud/media/issue/2018/11/11/asm-300.jpg", cover_hash: "c3c3e3c3c3c38f0f",
      modified: "2024-03-18T14:02:11.552839-04:00", issue_name: "Amazing Spider-Man (1963) #300",
      series: { id: 10, name: "Amazing Spider-Man", volume: 1, year_began: 1963 },
    });
  });

  it("passes filter params and maps series rows (series → display_name)", async () => {
    const { http, client } = setup({ [`${API}series/?name=spider&year_began=1963`]: ok("series_list.json") });
    const rows = await client.seriesList({ name: "spider", year_began: 1963 });
    expect(http.calls[0].req.params).toEqual({ name: "spider", year_began: 1963 });
    expect(rows[0]).toMatchObject({ id: 10, display_name: "Amazing Spider-Man (1963)", year_began: 1963, issue_count: 441,
      publisher: { id: 1, name: "Marvel" }, series_type: { id: 1, name: "Ongoing Series" } });
  });

  it("maps resource lists, reading-list rows and items", async () => {
    const { client } = setup({
      [`${API}publisher/`]: ok("publisher_list.json"), [`${API}character/?name=spider`]: ok("character_list.json"),
      [`${API}arc/300/issue_list/`]: ok("arc_300_issue_list.json"), [`${API}reading_list/`]: ok("reading_list_list.json"),
      [`${API}reading_list/500/items/`]: ok("reading_list_500_items.json"),
    });
    expect(await client.publishersList()).toEqual([
      { id: 1, name: "Marvel", modified: "2024-03-18T14:02:11.552839-04:00" },
      { id: 2, name: "DC Comics", modified: "2024-03-18T14:02:11.552839-04:00" },
    ]);
    expect((await client.charactersList({ name: "spider" }))[0].name).toBe("Spider-Man");
    expect((await client.arcIssuesList(300))[0].issue_name).toBe("Amazing Spider-Man (1963) #300");
    expect((await client.readingListsList())[0]).toMatchObject({ name: "Krakoa Essentials", attribution_source: null });
    const items = await client.readingListItems(500);
    expect(items.map((i) => [i.order, i.issue_type, i.issue.id, i.issue.cv_id])).toEqual([
      [1, "Core Issue", 2001, 717110], [2, "Tie-In", 2002, null],
    ]);
    expect(items[0].issue.series).toEqual({ id: 20, name: "House of X", volume: 1, year_began: 2019 });
  });

  it("caches each page by URL", async () => {
    const { http, client, cache } = setup({ [`${API}publisher/`]: ok("publisher_list.json") });
    await client.publishersList();
    await client.publishersList();
    expect(http.calls).toHaveLength(1);
    expect(await cache.get(`${API}publisher/`)).toBeDefined();
  });
});

describe("Metron rate limiting", () => {
  it("spaces requests at least 3s apart", async () => {
    const { http, client } = setup({ [`${API}publisher/1/`]: ok("publisher_1.json"), [`${API}team/200/`]: ok("team_200.json") });
    await Promise.all([client.publisher(1), client.team(200)]);
    expect(http.calls[1].at! - http.calls[0].at!).toBeGreaterThanOrEqual(3000);
  });

  it("waits a short 429 Retry-After and retries once", async () => {
    let n = 0;
    const clock = fakeClock();
    const http = mockHttp(() => (++n === 1 ? respond(429, fixture("metron/throttled.json"), { "retry-after": "30" })
                                           : ok("team_200.json")), clock);
    const client = createMetronClient({ http, auth: { token: "t" }, pacer: createMetronPacer(clock) });
    expect((await client.team(200))!.name).toBe("Avengers");
    expect(http.calls[1].at! - http.calls[0].at!).toBe(30_000);
  });

  it("refuses the daily limit and stops calling Metron", async () => {
    const clock = fakeClock();
    const reset = Math.floor(clock.now() / 1000) + 6 * 3600;
    const http = mockHttp(() => respond(429, { detail: "Request was throttled." }, {
      "retry-after": String(6 * 3600), "x-ratelimit-sustained-limit": "5000", "x-ratelimit-sustained-remaining": "0",
      "x-ratelimit-sustained-reset": String(reset),
    }), clock);
    const client = createMetronClient({ http, auth: { token: "t" }, pacer: createMetronPacer(clock) });
    const err = await client.issue(1).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.message).toMatch(/5,000 requests per day/);
    expect(err.retryAfterSeconds).toBe(6 * 3600);
    await expect(client.issue(2)).rejects.toBeInstanceOf(RateLimitError);
    expect(http.calls).toHaveLength(1);
    expect(client.rateLimitStatus.sustained).toEqual({ limit: 5000, remaining: 0, reset: reset * 1000 });
  });

  it("pre-empts when a success reports the daily window exhausted, and waits for an empty burst window", async () => {
    const clock = fakeClock();
    const nowS = Math.floor(clock.now() / 1000);
    let n = 0;
    const http = mockHttp(() => {
      n++;
      if (n === 1) return ok("team_200.json", { "x-ratelimit-burst-limit": "20", "x-ratelimit-burst-remaining": "0",
                                                 "x-ratelimit-burst-reset": String(nowS + 40) });
      return ok("team_200.json", { "x-ratelimit-sustained-limit": "5000", "x-ratelimit-sustained-remaining": "0",
                                   "x-ratelimit-sustained-reset": String(nowS + 7200) });
    }, clock);
    const client = createMetronClient({ http, auth: { token: "t" }, pacer: createMetronPacer(clock) });
    await client.team(200);
    await client.team(201);
    expect(http.calls[1].at! - http.calls[0].at!).toBe(40_000); // burst window empty: wait for its reset
    await expect(client.team(202)).rejects.toThrow(/per day/);
    expect(http.calls).toHaveLength(2);
  });
});
