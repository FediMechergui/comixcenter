/**
 * A catalog that ships with the app, so a new install opens on a populated library instead of an
 * empty one and spends no API quota filling it.
 *
 * Only catalog tables travel. What has been read, imported or connected belongs to the phone and
 * is never written by a snapshot, and a snapshot is never applied over a catalog that already has
 * series in it.
 */
import { db } from "./db";

/** Everything the catalog is made of; the user's own tables are deliberately absent. */
export const SNAPSHOT_TABLES = [
  "publishers", "imprints", "universes", "eras", "series", "seriesUniverses", "issues", "issueUniverses",
  "creators", "credits", "collected", "arcs", "arcIssues", "arcLinks", "characters", "identities",
  "appearances", "characterEvents", "teams", "teamAppearances", "teamAffiliations", "memberships",
  "teamLinks", "readingOrders", "entries", "entryPrereqs",
] as const;

export type SnapshotTable = (typeof SNAPSHOT_TABLES)[number];

export interface Snapshot {
  version: 1;
  built_at: string;
  /** Row counts, so a snapshot can be checked without parsing every table. */
  counts: Record<string, number>;
  tables: Partial<Record<SnapshotTable, unknown[]>>;
}

/** Where a bundled snapshot is served from; absent in builds that ship without one. */
export const SNAPSHOT_URL = "/catalog-snapshot.json";

/* eslint-disable @typescript-eslint/no-explicit-any */
const table = (name: SnapshotTable) => (db() as any)[name];

export async function exportSnapshot(): Promise<Snapshot> {
  const tables: Partial<Record<SnapshotTable, unknown[]>> = {};
  const counts: Record<string, number> = {};
  for (const name of SNAPSHOT_TABLES) {
    const rows = await table(name).toArray();
    if (!rows.length) continue;
    tables[name] = rows;
    counts[name] = rows.length;
  }
  return { version: 1, built_at: new Date().toISOString(), counts, tables };
}

export class SnapshotError extends Error {}

/**
 * Writes the snapshot's rows with the ids they were built with: the taxonomy is seeded from the
 * same list in the same order on every install, so those ids line up and the rest hangs off them.
 */
export async function importSnapshot(snapshot: Snapshot): Promise<Record<string, number>> {
  if (snapshot?.version !== 1) throw new SnapshotError("That snapshot was made by a different version of the app");
  if (!snapshot.tables || typeof snapshot.tables !== "object") throw new SnapshotError("That snapshot has no catalog tables");
  return db().transaction("rw", SNAPSHOT_TABLES.map((name) => table(name)), async () => {
  const existing = await db().series.count();
  if (existing > 0) throw new SnapshotError(`The catalog already holds ${existing} series; a snapshot only seeds an empty one`);

  const written: Record<string, number> = {};
  for (const name of SNAPSHOT_TABLES) {
    const rows = snapshot.tables[name];
    if (!Array.isArray(rows) || !rows.length) continue;
    await table(name).bulkPut(rows);
    written[name] = rows.length;
  }
  return written;
  });
}

/**
 * Loads the snapshot built into this copy of the app, once, on an empty catalog. A build that
 * ships without one simply finds nothing, which is why a failure here is never fatal: the app
 * still opens, just empty.
 */
export async function loadBundledSnapshot(): Promise<Record<string, number> | null> {
  if (typeof fetch !== "function") return null;
  if ((await db().series.count()) > 0) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    let snapshot: Snapshot;
    try {
      const resp = await fetch(SNAPSHOT_URL, { cache: "no-store", signal: controller.signal });
      if (!resp.ok) return null;
      snapshot = await resp.json() as Snapshot;
    } finally { clearTimeout(timer); }
    return await importSnapshot(snapshot);
  } catch {
    return null;
  }
}
