/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The on-device engine end to end, through the same /api routes the screens call. Mirrors
 * backend/tests/comix_app/test_api.py and test_ingest.py with fake Metron / Comic Vine / GCD.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { saveCredentials, setClients } from "./clients";
import { ComixDB, db, useDatabase } from "./db";
import { enqueue, runPending } from "./jobs";
import { handle } from "./router";
import { setFileStore, createMemoryStore } from "./storage";
import { seedTaxonomy } from "./taxonomy";
import { FakeComicVine, FakeGcd, FakeMetron } from "./testing/fakes";

let metron: FakeMetron, cv: FakeComicVine, gcd: FakeGcd;
const get = (p: string) => handle("GET", p) as Promise<any>;
const post = (p: string, b?: any) => handle("POST", p, b ?? {}) as Promise<any>;
const put = (p: string, b?: any) => handle("PUT", p, b ?? {}) as Promise<any>;
const patch = (p: string, b?: any) => handle("PATCH", p, b ?? {}) as Promise<any>;

beforeEach(async () => {
  useDatabase(new ComixDB(`test-${Math.random()}`));
  await seedTaxonomy();
  setFileStore(createMemoryStore());
  metron = new FakeMetron(); cv = new FakeComicVine(); gcd = new FakeGcd();
  await saveCredentials({ metron_token: "t", comicvine_key: "k" });
  setClients({ metron, comicvine: cv, gcd });
});

async function sync(kind: string, metronId: number, extra: Record<string, unknown> = {}) {
  await post("/api/admin/sync", { kind, metron_id: metronId, ...extra });
  await runPending();
}

async function loaded() {
  for (const sid of [10, 20, 22, 30]) await sync("series", sid);
  await sync("arc", 300);
  await sync("arc", 301);
  await sync("team", 201);
  const failed = (await get("/api/admin/jobs?status=failed")).jobs;
  expect(failed, JSON.stringify(failed.map((j: any) => [j.kind, j.error]))).toHaveLength(0);
}

describe("Metron and Comic Vine sync", () => {
  it("syncs a series, its universe (Metron confirmed) and its span", async () => {
    await sync("series", 10);
    const series = (await get("/api/series?q=amazing")).items[0];
    const detail = await get(`/api/series/${series.id}`);
    expect(detail.issues.map((i: any) => i.number)).toEqual(["1", "2", "300"]);
    expect(detail.first_cover_date).toBe("1963-03-01");
    expect(detail.universes).toEqual([expect.objectContaining({ name: "Earth-616", source: "metron" })]);
    expect((await db().publishers.where("slug").equals("marvel").first())!.metron_id).toBe(1);
  });

  it("links issue detail: credits, characters with roles, mantles, Comic Vine enrichment", async () => {
    await sync("series", 10);
    await sync("character", 101);
    const spider = (await get("/api/characters?q=spider")).items.find((c: any) => c.name === "Spider-Man");
    const detail = await get(`/api/characters/${spider.id}`);
    expect(detail.identities.map((i: any) => i.display_name).sort()).toEqual(["Miles Morales", "Peter Parker"]);
    const peter = detail.identities.find((i: any) => i.display_name === "Peter Parker");
    expect(peter.aliases).toContain("Web-Slinger");
    // The fake's first-appearance Comic Vine issue (6686) is ASM #1, already in the catalog, so it links locally
    expect(peter.first_appearance).toMatchObject({ label: "Amazing Spider-Man #1" });
    expect(peter.events.some((e: any) => e.kind === "first_appearance")).toBe(true);
    expect(peter.events.some((e: any) => e.kind === "death" && e.issue.label === "Amazing Spider-Man #300")).toBe(true);
    const apps = await get(`/api/characters/${spider.id}/appearances?role=main`);
    expect(apps.total).toBe(3);
  });

  it("collected editions relocate reprint stubs when the real series arrives", async () => {
    await post("/api/admin/sync", { kind: "issue", metron_id: 3001 });
    await runPending(1);
    const stub = (await db().issues.where("metron_id").equals(2001).first())!;
    expect((await db().series.get(stub.series_id))!.metron_id ?? null).toBeNull();
    await sync("series", 20);
    const moved = (await db().issues.where("metron_id").equals(2001).first())!;
    expect((await db().series.get(moved.series_id))!.metron_id).toBe(20);
  });

  it("defers rate-limited jobs instead of failing them", async () => {
    const { RateLimitError } = await import("./contracts");
    metron.series = async () => { throw new RateLimitError("daily limit", 120); };
    await enqueue("metron.series", { metron_id: 10 });
    await runPending();
    const job = (await db().jobs.toArray())[0];
    expect(job.status).toBe("queued");
    expect(job.run_after).toBeTruthy();
    expect(job.error).toMatch(/Rate limited/);
  });

  it("fails clearly without credentials", async () => {
    setClients({ metron: null });
    await saveCredentials({});
    await enqueue("metron.publishers", {});
    await runPending();
    expect((await db().jobs.toArray())[0].error).toMatch(/Add your Metron account/);
  });
});

describe("browse, search, arcs, orders", () => {
  it("browses publisher → universe → era → series → issue", async () => {
    await loaded();
    const marvel = (await get("/api/publishers")).find((p: any) => p.slug === "marvel");
    const pub = await get(`/api/publishers/${marvel.id}`);
    const e616 = pub.universes.find((u: any) => u.slug === "earth-616");
    const uni = await get(`/api/universes/${e616.id}`);
    const fresh = uni.eras.find((e: any) => e.name === "Fresh Start");
    expect(fresh.series_count).toBeGreaterThanOrEqual(2);
    const silver = uni.eras.find((e: any) => e.name === "Silver Age");
    expect((await get(`/api/series?era_id=${silver.id}`)).items.map((s: any) => s.name)).toEqual(["Amazing Spider-Man"]);
    const hox = (await get(`/api/series?era_id=${fresh.id}`)).items.find((s: any) => s.name === "House of X");
    const series = await get(`/api/series/${hox.id}`);
    expect(series.writers[0].name).toBe("Jonathan Hickman");
    const issue = await get(`/api/issues/${series.issues[0].id}`);
    expect(issue.description).toBe("Welcome to Krakoa.");
    expect(issue.collected_in[0].series_name).toBe("House of X / Powers of X");
    expect(issue.legal_links[0].service).toBe("Marvel Unlimited");
  });

  it("searches with prefixes across kinds", async () => {
    await loaded();
    const hits = (await get("/api/search?q=hous%20x")).results;
    expect(hits[0].title).toContain("House of X");
    expect((await get("/api/search?q=jean&kinds=character")).results[0].title).toBe("Jean Grey");
    expect((await get("/api/issues?q=inferno%201"))[0].series_name).toBe("Inferno");
  });

  it("plans prerequisites and refuses cycles", async () => {
    await loaded();
    const arcs = Object.fromEntries((await get("/api/arcs")).items.map((a: any) => [a.name, a]));
    const hox = arcs["House of X / Powers of X"], inferno = arcs["Inferno"];
    await post(`/api/admin/arcs/${inferno.id}/links`, { target_arc_id: hox.id, kind: "prerequisite", note: "Moira" });
    await expect(post(`/api/admin/arcs/${hox.id}/links`, { target_arc_id: inferno.id, kind: "prerequisite" })).rejects.toMatchObject({ status: 409 });
    const plan = await get(`/api/arcs/${inferno.id}/plan`);
    expect(plan.sequence.map((s: any) => s.name)).toEqual(["House of X / Powers of X"]);
    expect(plan.remaining_issues).toBe(2);
    const hoxDetail = await get(`/api/arcs/${hox.id}`);
    expect(hoxDetail.collected_editions[0].covers).toBe(2);
  });

  it("tiers, paths and shared progress", async () => {
    await loaded();
    const arcs = Object.fromEntries((await get("/api/arcs")).items.map((a: any) => [a.name, a]));
    const order = await post("/api/admin/orders", { name: "Krakoa" });
    const e1 = await post(`/api/admin/orders/${order.id}/entries`, { arc_id: arcs["House of X / Powers of X"].id, tier: "essential" });
    await post(`/api/admin/orders/${order.id}/entries`, { arc_id: arcs["Inferno"].id, tier: "optional" });
    const inferno1 = (await get("/api/issues?q=inferno%201"))[0];
    const e0 = await post(`/api/admin/orders/${order.id}/entries`, { issue_id: inferno1.id, tier: "skip", position: 0 });
    expect(e0.position).toBe(0);
    expect((await get(`/api/orders/${order.id}?path=core`)).entries).toHaveLength(1);
    expect((await get(`/api/orders/${order.id}?path=complete`)).entries).toHaveLength(2);
    await put(`/api/issues/${inferno1.id}/read`, { read: true });
    const complete = await get(`/api/orders/${order.id}?path=complete`);
    expect(complete.entries.find((e: any) => e.arc?.name === "Inferno").done).toBe(true);
    expect(complete.next_entry_id).toBe(e1.id);
    expect((await post(`/api/orders/${order.id}/read-through`, { entry_id: e1.id, path: "core" })).marked).toBe(2);
    expect((await get(`/api/orders/${order.id}`)).progress.paths.core).toEqual({ issues: 2, read: 2 });
  });

  it("generates draft orders and reuses them", async () => {
    await loaded();
    const marvel = (await get("/api/publishers")).find((p: any) => p.slug === "marvel");
    const e616 = (await get(`/api/publishers/${marvel.id}`)).universes.find((u: any) => u.slug === "earth-616");
    const master = await post("/api/admin/orders/generate", { source: "universe", id: e616.id });
    expect((await get(`/api/orders/${master.id}?path=all`)).entries.map((e: any) => e.arc.name)).toEqual(["House of X / Powers of X", "Inferno"]);
    expect((await post("/api/admin/orders/generate", { source: "universe", id: e616.id })).id).toBe(master.id);
  });

  it("teams: roster dates from co-appearances, shared history", async () => {
    await loaded();
    const xmen = (await get("/api/teams")).items.find((t: any) => t.name === "X-Men");
    const team = await get(`/api/teams/${xmen.id}`);
    expect(team.roster.map((r: any) => r.display_name).sort()).toEqual(["Jean Grey", "Scott Summers"]);
    const scott = team.roster.find((r: any) => r.display_name === "Scott Summers");
    expect([scott.from_date, scott.to_date]).toEqual(["2019-09-01", "2021-11-01"]);
    const cyclops = (await get("/api/characters?q=cyclops")).items[0];
    expect((await get(`/api/characters/${cyclops.id}/graph`)).links[0].name).toBe("Jean Grey");
  });

  it("imports a Metron reading list with tiers", async () => {
    await sync("reading_list", 500);
    const order = (await get("/api/orders"))[0];
    const detail = await get(`/api/orders/${order.id}?path=all`);
    expect(detail.entries.map((e: any) => e.tier)).toEqual(["essential", "tie_in"]);
  });
});

describe("Grand Comics Database (keyless, every publisher)", () => {
  it("finds online and adds a series, then fills issue details in the background", async () => {
    const found = await get("/api/online/search?q=saga");
    expect(found.gcd[0]).toMatchObject({ gcd_id: 66221, name: "Saga", issue_count: 3, in_catalog: false });
    const added = await post("/api/online/add", { source: "gcd", kind: "series", id: 66221 });
    expect(added.local.kind).toBe("series");
    const series = await get(`/api/series/${added.local.id}`);
    expect(series.issues.map((i: any) => i.number)).toEqual(["1", "2"]);          // variant skipped
    expect(series.details_pending).toBe(0);           // GCD details are fetched when an issue is opened
    expect(series.publisher).toBe("Image");
    await get(`/api/issues/${series.issues[0].id}`);   // opening queues the detail fetch
    expect((await get(`/api/series/${series.id}`)).details_pending).toBe(1);
    await runPending();
    const issue = await get(`/api/issues/${series.issues[0].id}`);
    expect(issue.image_url).toContain("files1.comics.org");
    expect(issue.cover_date).toBe("2012-03-01");
    expect(issue.description).toContain("warring worlds");
    expect(issue.credits.find((c: any) => c.role === "Writer").creators[0].name).toBe("Brian K. Vaughan");
    expect(issue.characters.map((c: any) => c.name)).toEqual(expect.arrayContaining(["Alana", "Marko", "Hazel"]));
    expect(issue.events.some((e: any) => e.kind === "first_appearance" && e.name === "Hazel")).toBe(true);
    expect((await get(`/api/series/${series.id}`)).details_pending).toBe(0);
    expect((await get("/api/online/search?q=saga")).gcd[0].in_catalog).toBe(true);
  });

  it("covers publishers beyond Marvel and DC", async () => {
    const added = await post("/api/online/add", { source: "gcd", kind: "series", id: 7777 });
    await get(`/api/issues/${(await get(`/api/series/${added.local.id}`)).issues[0].id}`);
    await runPending();
    const pubs = await get("/api/publishers");
    expect(pubs.map((p: any) => p.name)).toContain("Glénat");
    const series = await get(`/api/series/${added.local.id}`);
    const issue = await get(`/api/issues/${series.issues[0].id}`);
    expect(issue.title).toBe("Astérix le Gaulois");
    expect(issue.credits.map((c: any) => c.role)).toEqual(expect.arrayContaining(["Writer", "Penciller"]));
    expect((await get("/api/search?q=asterix")).results[0].title).toBe("Astérix");
  });

  it("opening an issue without details queues them", async () => {
    const added = await post("/api/online/add", { source: "gcd", kind: "series", id: 66221 });
    await db().jobs.clear();
    const series = await get(`/api/series/${added.local.id}`);
    await get(`/api/issues/${series.issues[1].id}`);
    expect((await db().jobs.toArray()).map((j) => j.kind)).toEqual(["gcd.issue"]);
  });
});

describe("device credentials", () => {
  it("masks saved keys and reports status", async () => {
    await put("/api/device/credentials", { metron_token: "abcdefgh1234", comicvine_key: "zzzzzz9999" });
    const c = await get("/api/device/credentials");
    expect(c.metron_token).toMatch(/1234$/);
    expect(c.metron_token).not.toContain("abcd");
    expect((await get("/api/status")).sources).toEqual({ metron: true, comicvine: true, gcd: true });
    await put("/api/device/credentials", { metron_token: null });
    expect((await get("/api/status")).sources.metron).toBe(false);
  });
});

describe("routing", () => {
  it("returns 404s like the server", async () => {
    await expect(get("/api/series/999")).rejects.toMatchObject({ status: 404 });
    await expect(get("/api/nothing-here")).rejects.toMatchObject({ status: 404 });
    await expect(patch("/api/library/5", {})).rejects.toMatchObject({ status: 404 });
  });
});
