import { afterEach, beforeEach, expect, it } from "vitest";
import { ComixDB, db, useDatabase } from "./db";
import { importComic, recoverInterruptedImport } from "./libraryStore";
import { createMemoryStore, setFileStore } from "./storage";
import { JPEG_RED, makeCbz } from "./library/fixtures";
import { detectFormat } from "./library/formats";
import { exportPersonalBackup, restorePersonalBackup } from "./backup";

beforeEach(() => { useDatabase(new ComixDB(`cancel-${Math.random()}`)); });
afterEach(async () => { await db().delete(); });
it("rolls back stored pages and the library row after cancellation", async () => {
  const memory = createMemoryStore(), written: string[] = [];
  setFileStore({ ...memory, async write(path, bytes) { written.push(path); await memory.write(path, bytes); } });
  const controller = new AbortController();
  const comic = makeCbz({ "1.jpg": JPEG_RED, "2.jpg": JPEG_RED });
  await expect(importComic(comic, "Cancellation.cbz", (done) => { if (done === 1) controller.abort(); }, null, controller.signal)).rejects.toThrow("cancelled");
  expect(written).toHaveLength(1);
  expect(await db().libraryFiles.count()).toBe(0);
  await expect(memory.read(written[0])).rejects.toThrow("No such file");
});
it("rejects overlapping imports while the first one owns the file store", async () => {
  const backup = await exportPersonalBackup();
  const memory = createMemoryStore(); let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const writing = new Promise<void>((resolve) => { entered = resolve; });
  setFileStore({ ...memory, async write(path, bytes) { entered(); await blocked; await memory.write(path,bytes); } });
  const controller = new AbortController(), comic = makeCbz({ "1.jpg": JPEG_RED });
  const first = importComic(comic, "First.cbz", undefined, null, controller.signal);
  const firstResult = expect(first).rejects.toThrow("cancelled");
  await writing;
  await expect(importComic(comic,"Second.cbz")).rejects.toThrow("Another comic");
  await expect(restorePersonalBackup(backup)).rejects.toThrow("Finish the current comic import");
  controller.abort(); release(); await firstResult;
  expect(await db().libraryFiles.count()).toBe(0);
});
it("rejects oversized zip entry declarations before inflating the page", () => {
  const comic = makeCbz({ "1.jpg": JPEG_RED });
  for (let i=0;i<comic.length-28;i++) if (comic[i]===0x50 && comic[i+1]===0x4b && comic[i+2]===1 && comic[i+3]===2) {
    new DataView(comic.buffer).setUint32(i+24, 33*1024*1024, true); break;
  }
  expect(() => detectFormat(comic)).toThrow("safe extraction size");
});
it("removes only the recorded uncommitted import after a process interruption", async () => {
  const memory = createMemoryStore(); setFileStore(memory);
  const sha256 = "a".repeat(64), dir = `library/aa/${sha256}`;
  await memory.write(`${dir}/p00001.jpg`, JPEG_RED);
  await db().settings.put({ key: "import-in-progress", value: { dir, sha256 } });
  await recoverInterruptedImport();
  await expect(memory.read(`${dir}/p00001.jpg`)).rejects.toThrow("No such file");
  expect(await db().settings.get("import-in-progress")).toBeUndefined();
});
it("keeps a committed comic even when its old import marker was not cleared", async () => {
  const memory = createMemoryStore(); setFileStore(memory);
  const sha256 = "b".repeat(64), dir = `library/bb/${sha256}`;
  await memory.write(`${dir}/p00001.jpg`, JPEG_RED);
  await db().libraryFiles.add({ dir, sha256, original_name: "Keep.cbz", format: "cbz", size: 10, page_count: 1, added_at: "", current_page: 0, page_ext: ["jpg"] });
  await db().settings.put({ key: "import-in-progress", value: { dir, sha256 } });
  await recoverInterruptedImport();
  expect(await memory.read(`${dir}/p00001.jpg`)).toEqual(JPEG_RED);
});
