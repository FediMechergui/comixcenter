import { describe, expect, it } from "vitest";

import { AuthError, NotFoundError, RateLimitError, SourceError } from "../contracts";
import { createComicVineClient, createComicVinePacer, parseCvBirth, testComicVine } from "./comicvine";
import { MemoryCache, USER_AGENT } from "./http";
import { fakeClock, fixture, mockHttp, respond } from "./test-helpers";

const API = "https://comicvine.gamespot.com/api";
const KEY = "cvkey";
const q = "?api_key=cvkey&format=json";

function setup(route: (url: string) => ReturnType<typeof respond> | undefined) {
  const clock = fakeClock();
  const http = mockHttp(route, clock);
  const cache = new MemoryCache(clock);
  const client = createComicVineClient({ http, apiKey: KEY, cache, pacer: createComicVinePacer(clock) });
  return { clock, http, cache, client };
}
const ok = (name: string) => respond(200, fixture(`comicvine/${name}`));

describe("Comic Vine requests", () => {
  it("uses simyan's URL patterns, api_key + format=json, and identifies itself", async () => {
    const routes: Record<string, string> = {
      [`${API}/character/4005-1443/${q}`]: "character_1443.json",
      [`${API}/issue/4000-6686/${q}`]: "issue_6686.json",
      [`${API}/team/4060-3806/${q}`]: "team_3806.json",
      [`${API}/story_arc/4045-55660/${q}`]: "story_arc_55660.json",
      [`${API}/volume/4050-2127/${q}`]: "volume_2127.json",
    };
    const { http, client } = setup((url) => (routes[url] ? ok(routes[url]) : undefined));
    await client.getCharacter(1443);
    await client.getIssue(6686);
    await client.getTeam(3806);
    await client.getStoryArc(55660);
    await client.getVolume(2127);
    expect(http.calls.map((c) => c.url)).toEqual(Object.keys(routes));
    expect(http.calls[0].req.headers).toEqual({ "User-Agent": USER_AGENT, Accept: "application/json" });
  });

  it("paces requests ≥ 1.1s apart", async () => {
    const { http, client } = setup((url) => (url.includes("4005-1443") ? ok("character_1443.json") : ok("team_3806.json")));
    await Promise.all([client.getCharacter(1443), client.getTeam(3806)]);
    expect(http.calls[1].at! - http.calls[0].at!).toBeGreaterThanOrEqual(1100);
  });

  it("caches without the API key in the key", async () => {
    const { http, client, cache } = setup(() => ok("character_1443.json"));
    await client.getCharacter(1443);
    await client.getCharacter(1443);
    expect(http.calls).toHaveLength(1);
    expect(await cache.get(`${API}/character/4005-1443/?format=json`)).toBeDefined();
  });
});

describe("Comic Vine mapping (simyan attribute names)", () => {
  it("maps a character", async () => {
    const { client } = setup(() => ok("character_1443.json"));
    const c = await client.getCharacter(1443);
    expect(c.real_name).toBe("Peter Benjamin Parker");
    expect(c.aliases).toBe("Spidey\r\nWeb-Head\r\nFriendly Neighborhood Spider-Man"); // raw string, split by the sync
    expect(c.summary).toMatch(/radioactive spider/);
    expect(c.description).toMatch(/<p>/);
    expect(c.image?.original_url).toBe("https://comicvine.gamespot.com/a/uploads/original/11131/111310034/spider-man.jpg");
    expect(c.image?.thumbnail).toContain("scale_avatar");
    expect(c.image?.large_screen_url).toContain("screen_kubrick");
    expect(c.first_issue).toEqual({ api_url: `${API}/issue/4000-6686/`, id: 6686, name: "Spider-Man!", site_url: null, number: "15" });
    expect(c.deaths.map((d) => [d.id, d.name])).toEqual([[107021, "Spider-Man: The Other"]]);
    expect(c.teams.map((t) => t.id)).toEqual([3806, 54477]);
    expect(c.friendly_teams[0].name).toBe("Avengers");
    expect(c.enemies[0].name).toBe("Green Goblin");
    expect(c.issues[0].id).toBe(6686);
    expect(c.volumes[0].id).toBe(2127);
    expect(c.story_arcs[0].id).toBe(55660);
    expect(c.issue_count).toBe(13000);
    expect(c.date_of_birth).toBe("1962-08-10");
    expect(c.date_added).toBe("2008-06-06T11:08:00");
    expect(c.origin?.name).toBe("Human");
    expect(c.publisher?.name).toBe("Marvel");
    expect(c).not.toHaveProperty("issues_died_in");
    expect(c).not.toHaveProperty("deck");
  });

  it("maps an issue, turning CV's blank strings into empty lists", async () => {
    const { client } = setup(() => ok("issue_6686.json"));
    const i = await client.getIssue(6686);
    expect(i.volume?.name).toBe("Amazing Fantasy");
    expect(i.cover_date).toBe("1962-08-31");
    expect(i.number).toBe("15");
    expect(i.name).toBe("Spider-Man!");
    expect(i.first_appearance_characters.map((c) => c.id)).toEqual([1443]);
    expect(i.first_appearance_teams.map((t) => t.name)).toEqual(["Midtown High Bullies"]);
    expect(i.first_appearance_concepts).toEqual([]);
    expect(i.first_appearance_locations).toEqual([]);
    expect(i.deaths.map((d) => d.name)).toEqual(["Uncle Ben"]);
    expect(i.characters).toHaveLength(2);
    expect(i.creators[0]).toMatchObject({ name: "Steve Ditko", roles: "penciler, inker, cover" });
    expect(i.associated_images[0]).toEqual({ url: "https://comicvine.gamespot.com/a/uploads/original/af15-back.jpg",
                                             id: 1001, caption: null, tags: "All Images" });
  });

  it("maps a team (characters → members, disbanded_in_issues → issues_disbanded_in)", async () => {
    const { client } = setup(() => ok("team_3806.json"));
    const t = await client.getTeam(3806);
    expect(t.members.map((m) => m.name)).toEqual(["Spider-Man", "Iron Man"]);
    expect(t.issues_disbanded_in.map((i) => i.name)).toEqual(["Chaos, Part 4: Avengers Finale"]);
    expect(t.first_issue?.number).toBe("1");
    expect(t.issue_count).toBe(4500);
    expect(t.member_count).toBe(2);
    expect(t.summary).toBe("Earth's Mightiest Heroes.");
    expect(t.image?.original_url).toContain("avengers.jpg");
  });

  it("maps a story arc and a volume", async () => {
    const { client } = setup((url) => (url.includes("story_arc") ? ok("story_arc_55660.json") : ok("volume_2127.json")));
    const a = await client.getStoryArc(55660);
    expect(a).toMatchObject({ name: "Venom", issue_count: 1, summary: "Venom debuts.", description: expect.stringContaining("symbiote") });
    expect(a.issues[0].id).toBe(7000);
    const v = await client.getVolume(2127);
    expect(v).toMatchObject({ name: "The Amazing Spider-Man", start_year: 1963, issue_count: 441, aliases: "ASM" });
    expect(v.first_issue?.number).toBe("1");
    expect(v.last_issue?.number).toBe("441");
    expect(v.issues.map((i) => i.number)).toEqual(["1", "300"]);
    expect(v.creators[0]).toMatchObject({ name: "Stan Lee", count: 110 });
    expect(v.characters[0]).toMatchObject({ name: "Spider-Man", count: 441 });
  });

  it("parses CV birth dates", () => {
    expect(parseCvBirth("Aug 10, 1962")).toBe("1962-08-10");
    expect(parseCvBirth("Sep 1, 1940")).toBe("1940-09-01");
    expect(parseCvBirth(null)).toBeNull();
    expect(parseCvBirth("someday")).toBeNull();
  });
});

describe("Comic Vine search", () => {
  it("pages /search/ until number_of_total_results", async () => {
    const { http, client } = setup((url) => {
      if (url === `${API}/search/${q}&query=spider-man&resources=volume&page=1`) return ok("search_volumes_page1.json");
      if (url === `${API}/search/${q}&query=spider-man&resources=volume&page=2`) return ok("search_volumes_page2.json");
      return undefined;
    });
    const rows = await client.searchVolumes("spider-man");
    expect(http.calls).toHaveLength(2);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toMatchObject({ id: 3000, name: "Spider-Man Volume 1", start_year: 1990, issue_count: 10 });
    expect(rows[10].start_year).toBeNull();
  });

  it("stops at maxResults", async () => {
    const { http, client } = setup(() => ok("search_volumes_page1.json"));
    expect(await client.searchVolumes("spider-man", 3)).toHaveLength(3);
    expect(http.calls).toHaveLength(1);
  });

  it("uses the right resource names for characters, arcs and teams", async () => {
    const empty = respond(200, { status_code: 1, error: "OK", number_of_total_results: 0, results: [] });
    const { http, client } = setup(() => empty);
    await client.searchCharacters("x");
    await client.searchStoryArcs("x");
    await client.searchTeams("x");
    expect(http.calls.map((c) => c.req.params?.resources)).toEqual(["character", "story_arc", "team"]);
  });
});

describe("Comic Vine errors", () => {
  it("maps JSON status codes and HTTP statuses", async () => {
    const cases: [ReturnType<typeof respond>, unknown][] = [
      [respond(401, fixture("comicvine/error_invalid_key.json")), AuthError],
      [respond(200, fixture("comicvine/error_invalid_key.json")), AuthError],
      [respond(404, fixture("comicvine/error_not_found.json")), NotFoundError],
      [respond(200, fixture("comicvine/error_not_found.json")), NotFoundError],
      [respond(200, fixture("comicvine/error_rate_limit.json")), RateLimitError],
      [respond(420, fixture("comicvine/error_rate_limit.json")), RateLimitError],
      [respond(429, "Too Many Requests"), RateLimitError],
      [respond(200, { status_code: 102, error: "Error in URL Format", results: [] }), SourceError],
      [respond(502, "<html>bad gateway</html>"), SourceError],
      [respond(200, "<html>not json</html>"), SourceError],
    ];
    for (const [res, type] of cases) {
      const { client } = setup(() => res);
      const err = await client.getIssue(1).catch((e) => e);
      expect(err, JSON.stringify(res)).toBeInstanceOf(type as never);
    }
  });

  it("does not freeze other resources after a refusal, but retries a short Retry-After", async () => {
    let n = 0;
    const { http, client } = setup((url) => {
      if (url.includes("/issue/")) return respond(420, fixture("comicvine/error_rate_limit.json"));
      return ++n === 1 ? respond(429, {}, { "retry-after": "10" }) : ok("team_3806.json");
    });
    const err = await client.getIssue(1).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterSeconds).toBe(3600);
    expect((await client.getTeam(3806)).name).toBe("Avengers");
    const teamCalls = http.calls.filter((c) => c.url.includes("/team/"));
    expect(teamCalls).toHaveLength(2);
    expect(teamCalls[1].at! - teamCalls[0].at!).toBe(10_000);
  });

  it("testComicVine reports the key status", async () => {
    const good = mockHttp(() => ok("search_volumes_page1.json"));
    expect((await testComicVine({ http: good, apiKey: KEY, pacer: createComicVinePacer(fakeClock()) })).ok).toBe(true);
    expect(good.calls).toHaveLength(1);
    const bad = mockHttp(() => respond(401, fixture("comicvine/error_invalid_key.json")));
    expect(await testComicVine({ http: bad, apiKey: "nope", pacer: createComicVinePacer(fakeClock()) }))
      .toEqual({ ok: false, message: "Comic Vine rejected the API key" });
  });
});
