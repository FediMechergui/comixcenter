import { batcaveCatalog } from "./batcave";
import { fetchGetComicsOpds, GETCOMICS_SCHEME } from "./getcomics";
import { withDeadline } from "./http";
import type { OpdsFeedPage } from "@/lib/types";
import { gatewayUrl, gatewayRequest } from "@/lib/gateway";
import { cachedCatalog, rememberCatalog } from "./catalog-cache";

export type CatalogSource = "auto" | "batcave" | "getcomics";
export async function onlineCatalog(q = "", page = 1, source: CatalogSource = "auto"): Promise<OpdsFeedPage> {
  const key = JSON.stringify([source, q.trim(), page]);
  const saved = cachedCatalog(key);
  if (typeof navigator !== "undefined" && !navigator.onLine && saved) return saved;
  const batcave = () => withDeadline(batcaveCatalog(q, page), 15_000).then((data) => ({ ...data, source: "batcave" as const }));
  const getcomics = () => fetchGetComicsOpds(`${GETCOMICS_SCHEME}latest?${new URLSearchParams({ page: String(page), ...(q ? { q } : {}) })}`)
    .then((data) => ({ ...data, source: "getcomics" as const }));
  const choices: Promise<OpdsFeedPage>[] = [];
  if (gatewayUrl()) choices.push(gatewayRequest<OpdsFeedPage>(`/api/online/catalog?${new URLSearchParams({ q, page: String(page), source })}`));
  if (source !== "getcomics") choices.push(batcave());
  if (source !== "batcave") choices.push(getcomics());
  try { const data = await Promise.any(choices); rememberCatalog(key, data); return data; }
  catch (error) {
    if (saved) return saved;
    const messages = error instanceof AggregateError ? error.errors.map((e: Error) => e.message).join(" ") : "Sources are unavailable.";
    throw new Error(`${messages} Your bundled catalog, guides and saved comics remain available.`);
  }
}
