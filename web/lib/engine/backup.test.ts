import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComixDB, db, useDatabase } from "./db";
import { exportPersonalBackup, restorePersonalBackup, validateBackup } from "./backup";

beforeEach(async () => {
  useDatabase(new ComixDB(`backup-${Math.random()}`));
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null, getItem: (k: string) => values.get(k) ?? null, setItem: (k: string,v: string) => { values.set(k,v); }, removeItem: (k: string) => { values.delete(k); } });
  await db().series.add({ id: 1, name: "Saga", year_began: 2012, words: ["saga"] });
  await db().issues.add({ id: 1, series_id: 1, number: "1", number_sort: 1, words: ["saga","1"] });
  await db().readStatus.add({ issue_id: 1, read_at: "2026-10-19" });
});
afterEach(async () => { await db().delete(); vi.unstubAllGlobals(); });

describe("personal recovery", () => {
  it("excludes account secrets, connection settings, cookies and file bytes", async () => {
    await db().settings.put({ key: "credentials", value: { metron_token: "secret-account" } });
    localStorage.setItem("comix.adminToken", "secret-admin");
    localStorage.setItem("comix.guide.batman-origins", "[0]");
    const backup = await exportPersonalBackup();
    expect(JSON.stringify(backup)).not.toContain("secret-");
    expect(backup.preferences["comix.guide.batman-origins"]).toBe("[0]");
    expect(backup.catalog.tables.issues).toHaveLength(1);
  });
  it("rejects a backup that attempts to overwrite accounts", async () => {
    const backup = await exportPersonalBackup(); backup.preferences["comix.adminToken"] = "attacker";
    expect(() => validateBackup(backup)).toThrow();
  });
  it("restores catalog, read status, custom orders and checklists while keeping accounts", async () => {
    localStorage.setItem("comix.guide.batman-origins", "[0]");
    await db().readingOrders.add({ name: "My path", slug: "my-path", kind: "custom", source: "curated", created_at: "", updated_at: "", words: [] });
    const backup = await exportPersonalBackup();
    await db().series.clear(); await db().readStatus.clear(); await db().readingOrders.clear();
    await db().settings.put({ key: "credentials", value: { metron_token: "keep-me" } });
    localStorage.setItem("comix.guide.batman-origins", "[]");
    await restorePersonalBackup(backup);
    expect((await db().series.get(1))?.name).toBe("Saga");
    expect(await db().readStatus.count()).toBe(1);
    expect(await db().readingOrders.count()).toBe(1);
    expect(localStorage.getItem("comix.guide.batman-origins")).toBe("[0]");
    expect((await db().settings.get("credentials"))?.value).toEqual({ metron_token: "keep-me" });
  });
  it("rolls back catalog replacement when a later table has invalid keys", async () => {
    const backup = await exportPersonalBackup();
    backup.catalog.tables.series = [{ id: 2, name: "Replacement", words: [] }];
    backup.catalog.tables.arcs = [{ id: { invalid: true }, name: "Invalid" }];
    await expect(restorePersonalBackup(backup)).rejects.toThrow();
    expect((await db().series.get(1))?.name).toBe("Saga");
    expect(await db().series.get(2)).toBeUndefined();
  });
  it("keeps a recovery manifest for files that have not been reimported yet", async () => {
    const backup = await exportPersonalBackup();
    backup.library = [{ name: "Owned.cbz", sha256: "a".repeat(64), current_page: 9, issue_id: 1 }];
    const result = await restorePersonalBackup(backup);
    expect(result.missingFiles).toBe(1);
    expect(await db().libraryFiles.count()).toBe(0);
    expect((await db().settings.get("recovered-library-progress"))?.value).toEqual(backup.library);
    expect((await exportPersonalBackup()).library).toEqual(backup.library);
  });
});
