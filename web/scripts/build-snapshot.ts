/**
 * Builds the catalog that ships inside the app.
 *
 *   npx vitest run --config scripts/build-snapshot.config.mts
 *
 * It runs the real engine against the real Metron and Comic Vine, using the accounts in
 * web/.env.local, and writes public/catalog-snapshot.json. initEngine() seeds a new install from
 * that file, so this runs once here rather than on every phone.
 *
 * The source clients pace themselves against each API's rate limit, so a full run is slow by
 * design. SNAPSHOT_ARCS caps how many starter arcs to pull (default: all of them).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { expect, it } from "vitest";

import { saveCredentials, setHttp, type Credentials } from "@/lib/engine/clients";
import { ComixDB, useDatabase } from "@/lib/engine/db";
import { runPending } from "@/lib/engine/jobs";
import { handle } from "@/lib/engine/router";
import { exportSnapshot } from "@/lib/engine/snapshot";
import { createFetchHttp } from "@/lib/engine/sources/http";
import { starterArcNames } from "@/lib/engine/services/starterPack";
import { seedTaxonomy } from "@/lib/engine/taxonomy";

/* eslint-disable @typescript-eslint/no-explicit-any */
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "public", "catalog-snapshot.json");

const get = (p: string) => handle("GET", p) as Promise<any>;
const post = (p: string, b?: any) => handle("POST", p, b ?? {}) as Promise<any>;

/** Build-tool credentials stay in this process; only catalog tables are exported. */
function credentialsFromEnvLocal(): Credentials {
  const text = readFileSync(path.join(ROOT, ".env.local"), "utf8");
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return {
    metron_token: env.NEXT_PUBLIC_METRON_TOKEN || null,
    metron_username: env.NEXT_PUBLIC_METRON_USERNAME || null,
    metron_password: env.NEXT_PUBLIC_METRON_PASSWORD || null,
    comicvine_key: env.NEXT_PUBLIC_COMICVINE_KEY || null,
    gcd_username: env.NEXT_PUBLIC_GCD_USERNAME || null,
    gcd_password: env.NEXT_PUBLIC_GCD_PASSWORD || null,
  };
}

const log = (msg: string) => process.stdout.write(`  ${msg}\n`);

it("builds the bundled catalog", { timeout: 6 * 60 * 60_000 }, async () => {
  const creds = credentialsFromEnvLocal();
  expect(creds.metron_token || creds.metron_username, "no Metron account in web/.env.local").toBeTruthy();

  useDatabase(new ComixDB(`snapshot-build-${Date.now()}`));
  setHttp(createFetchHttp());
  await seedTaxonomy();
  await saveCredentials(creds);

  log("publishers…");
  await post("/api/admin/sync", { kind: "publishers" });
  await runPending();

  const limit = Number(process.env.SNAPSHOT_ARCS || 0);
  const arcs = limit > 0 ? starterArcNames().slice(0, limit) : starterArcNames();
  log(`${arcs.length} starter arcs`);

  const missing: string[] = [];
  for (const [i, arc] of arcs.entries()) {
    const hits = await get(`/api/admin/metron/search?kind=arc&q=${encodeURIComponent(arc.name)}`);
    const hit = hits?.[0];
    if (!hit) { missing.push(`${arc.name} (${arc.year})`); continue; }
    log(`[${i + 1}/${arcs.length}] ${arc.name} → metron ${hit.metron_id}`);
    await post("/api/admin/sync", { kind: "arc", metron_id: hit.metron_id });
    await runPending();
  }
  if (missing.length) log(`not on Metron: ${missing.join(", ")}`);

  const failed = (await get("/api/admin/jobs?status=failed")).jobs ?? [];
  if (failed.length) log(`${failed.length} job(s) failed: ${failed.slice(0, 3).map((j: any) => j.error).join(" | ")}`);

  const snapshot = await exportSnapshot();
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(snapshot));

  const size = (JSON.stringify(snapshot).length / 1024 / 1024).toFixed(1);
  log(`wrote ${OUT} (${size} MB)`);
  log(Object.entries(snapshot.counts).map(([k, v]) => `${k}=${v}`).join(" "));

  // A snapshot with no series would ship an empty catalog and hide the failure until install.
  expect(snapshot.counts.series ?? 0).toBeGreaterThan(0);
});
