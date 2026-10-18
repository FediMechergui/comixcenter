/* eslint-disable @typescript-eslint/no-explicit-any */
/** The catalog that ships with a build: taken from one install, seeded into the next. */
import { beforeEach, describe, expect, it } from "vitest";

import { saveCredentials, setClients } from "./clients";
import { ComixDB, db, useDatabase } from "./db";
import { runPending } from "./jobs";
import { handle } from "./router";
import { createMemoryStore, setFileStore } from "./storage";
import { exportSnapshot, importSnapshot, SnapshotError, SNAPSHOT_TABLES, type Snapshot } from "./snapshot";
import { seedTaxonomy } from "./taxonomy";
import { FakeComicVine, FakeGcd, FakeMetron } from "./testing/fakes";

const get = (p: string) => handle("GET", p) as Promise<any>;
const post = (p: string, b?: any) => handle("POST", p, b ?? {}) as Promise<any>;

async function freshInstall() {
  useDatabase(new ComixDB(`snap-${Math.random()}`));
  await seedTaxonomy();
  setFileStore(createMemoryStore());
  await saveCredentials({ metron_token: "t", comicvine_key: "k" });
  setClients({ metron: new FakeMetron(), comicvine: new FakeComicVine(), gcd: new FakeGcd() });
}

/** A catalog worth shipping: a couple of series, an arc and a team, with their characters. */
async function buildCatalog() {
  for (const kind of [["series", 10], ["series", 20], ["arc", 300], ["team", 201]] as [string, number][]) {
    await post("/api/admin/sync", { kind: kind[0], metron_id: kind[1] });
  }
  await runPending();
}

beforeEach(freshInstall);

describe("catalog snapshot", () => {
  it("rolls back every table if a later table contains invalid data", async () => {
    const snapshot: Snapshot = { version: 1, built_at: "", counts: {}, tables: {
      series: [{ id: 123, name: "Partial import", words: [] }],
      arcs: [{ id: { invalid: true }, name: "Broken key" }],
    } };
    await expect(importSnapshot(snapshot)).rejects.toThrow();
    expect(await db().series.count()).toBe(0);
    expect(await db().arcs.count()).toBe(0);
  });
  it("carries the catalog and leaves the reader's own tables out of it", async () => {
    await buildCatalog();
    const snapshot = await exportSnapshot();

    expect(snapshot.version).toBe(1);
    expect(snapshot.counts.series).toBeGreaterThan(0);
    expect(snapshot.counts.issues).toBeGreaterThan(0);
    // Reading history, imported files and connected servers stay on the phone that has them.
    for (const own of ["readStatus", "libraryFiles", "pagePanels", "opdsFeeds", "jobs", "settings"]) {
      expect(Object.keys(snapshot.tables)).not.toContain(own);
      expect(SNAPSHOT_TABLES as readonly string[]).not.toContain(own);
    }
  });

  it("seeds a fresh install with the same catalog it was taken from", async () => {
    await buildCatalog();
    const before = await get("/api/status");
    const snapshot = await exportSnapshot();

    await freshInstall();
    expect((await get("/api/status")).counts.series).toBe(0);

    await importSnapshot(snapshot);
    const after = await get("/api/status");
    expect(after.counts).toEqual(before.counts);

    // The rows are usable, not just present: a series still resolves through the normal route.
    const series = (await get("/api/series?size=50")).items;
    expect(series.length).toBe(before.counts.series);
    expect((await get(`/api/series/${series[0].id}`)).name).toBe(series[0].name);
  });

  it("refuses to write over a catalog that already has series", async () => {
    await buildCatalog();
    const snapshot = await exportSnapshot();
    await expect(importSnapshot(snapshot)).rejects.toThrow(SnapshotError);
    // Nothing was half-written: the catalog is still exactly what it was.
    expect((await get("/api/status")).counts.series).toBe(snapshot.counts.series);
  });

  it("rejects a snapshot from another version", async () => {
    await expect(importSnapshot({ version: 2, tables: {} } as unknown as Snapshot)).rejects.toThrow(SnapshotError);
  });

  it("round-trips through the admin routes", async () => {
    await buildCatalog();
    const exported = await get("/api/admin/snapshot");
    await freshInstall();
    const { written } = await post("/api/admin/snapshot", exported);
    expect(written.series).toBe(exported.counts.series);
    expect(await db().issues.count()).toBe(exported.counts.issues);
  });
});
