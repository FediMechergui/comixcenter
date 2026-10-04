/**
 * The on-device engine: start-up and the single entry point the UI calls in "device" mode.
 */
import { db } from "./db";
import { startWorker, onJobFinished } from "./jobs";
import { configureLibrary } from "./library";
import { handle, HttpError } from "./router";
import { seedTaxonomy } from "./taxonomy";

let ready: Promise<void> | null = null;

/** Seeds the taxonomy once and starts the background sync worker. Safe to call repeatedly. */
export function initEngine(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await db().open();
      await seedTaxonomy();
      configureLibrary();
      startWorker();
    })();
  }
  return ready;
}

export async function engineRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  await initEngine();
  return handle(method, path, body);
}

export { HttpError, onJobFinished };
export { exportPdfBytes } from "./libraryStore";
