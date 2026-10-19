import type { OpdsFeedPage } from "@/lib/types";

const KEY = "comix.catalog-cache.v1";
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
interface Record { key: string; saved: number; data: OpdsFeedPage }
function records(): Record[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw || raw.length > 500_000) return [];
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows.filter((r) => r && typeof r.key === "string" && Number.isFinite(r.saved) && r.saved <= Date.now() && Date.now() - r.saved < MAX_AGE && r.data && Array.isArray(r.data.entries) && r.data.entries.length <= 100 && ["batcave", "getcomics"].includes(r.data.source)) : [];
  } catch { return []; }
}
export function cachedCatalog(key: string): OpdsFeedPage | undefined {
  const row = records().find((r) => r.key === key);
  return row ? { ...row.data, cached_at: new Date(row.saved).toISOString() } : undefined;
}
export function rememberCatalog(key: string, data: OpdsFeedPage) {
  if (!data.entries.length || data.entries.length > 100 || !data.source) return;
  const rows = [{ key, saved: Date.now(), data }, ...records().filter((r) => r.key !== key)].slice(0, 12);
  try {
    while (JSON.stringify(rows).length > 500_000) rows.pop();
    localStorage.setItem(KEY, JSON.stringify(rows));
  } catch { /* Browsing still works when storage is unavailable. */ }
}
