/**
 * Search over the phone's catalog: every query word must prefix-match a word of the record
 * (so "spid man" finds Spider-Man). Ranking favours exact words and shorter titles.
 */
import { db, type Id } from "../db";
import { words } from "../parsing";

const KINDS = ["series", "issue", "arc", "character", "team", "creator", "order"] as const;
type Kind = (typeof KINDS)[number];

interface Hit { kind: string; id: Id; title: string; subtitle: string; image_url: string | null; score: number }

/** Ids whose `words` index prefix-matches every token. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function matchIds(table: import("dexie").Table<any, Id>, tokens: string[], cap = 400): Promise<Id[]> {
  let result = null as Set<Id> | null;
  for (const t of tokens) {
    const ids = new Set((await table.where("words").startsWith(t).primaryKeys()) as Id[]);
    result = result === null ? ids : new Set([...result].filter((x) => ids.has(x)));
    if (!result.size) return [];
  }
  return [...(result ?? [])].slice(0, cap);
}

function score(tokens: string[], recordWords: string[], title: string): number {
  let s = 0;
  for (const t of tokens) s += recordWords.includes(t) ? 3 : 1;
  return s + 1 / (1 + title.length / 40);
}

export async function search(q: string, kinds?: string[] | null, limit = 30) {
  const yearText = /\b(?:19|20)\d{2}\b/.exec(q)?.[0];
  const year = yearText ? Number(yearText) : null;
  const tokens = words(yearText ? q.replace(yearText, "") : q).slice(0, 12);
  if (!tokens.length) return { query: q, results: [] };
  const wanted = new Set<Kind>(((kinds?.length ? kinds : KINDS) as Kind[]).filter((k) => (KINDS as readonly string[]).includes(k)));
  const d = db();
  const hits: Hit[] = [];
  const seenCharacters = new Set<Id>();

  if (wanted.has("series")) for (const s of await d.series.bulkGet(await matchIds(d.series, tokens))) {
    if (!s || (year && s.year_began !== year)) continue;
    const pub = s.publisher_id ? await d.publishers.get(s.publisher_id) : undefined;
    hits.push({ kind: "series", id: s.id!, title: s.name, image_url: s.image_url ?? null, score: score(tokens, s.words, s.name) + 0.5,
      subtitle: [s.year_began, pub?.name, s.issue_count ? `${s.issue_count} issues` : null].filter(Boolean).join(" · ") });
  }
  if (wanted.has("issue")) for (const i of await d.issues.bulkGet(await matchIds(d.issues, tokens, 120))) {
    if (!i) continue;
    const s = await d.series.get(i.series_id);
    if (year && s?.year_began !== year && i.cover_date?.slice(0,4) !== String(year)) continue;
    const title = `${s?.name ?? ""} #${i.number}`;
    hits.push({ kind: "issue", id: i.id!, title, image_url: i.image_url ?? null, score: score(tokens, i.words, title),
      subtitle: [s?.year_began ? `${s.year_began} series` : null, i.title, i.cover_date?.slice(0, 4)].filter(Boolean).join(" · ") });
  }
  if (wanted.has("arc")) for (const a of await d.arcs.bulkGet(await matchIds(d.arcs, tokens))) {
    if (a) hits.push({ kind: "arc", id: a.id!, title: a.name, subtitle: a.kind === "event" ? "Event" : "Story arc", image_url: a.image_url ?? null,
      score: score(tokens, a.words, a.name) + 0.4 });
  }
  if (wanted.has("character")) {
    for (const c of await d.characters.bulkGet(await matchIds(d.characters, tokens))) {
      if (!c) continue;
      seenCharacters.add(c.id!);
      const people = (await d.identities.where("character_id").equals(c.id!).toArray()).map((i) => i.display_name).filter((n) => n !== c.name);
      hits.push({ kind: "character", id: c.id!, title: c.name, subtitle: people.slice(0, 3).join(", "), image_url: c.image_url ?? null,
        score: score(tokens, c.words, c.name) + 0.6 });
    }
    for (const i of await d.identities.bulkGet(await matchIds(d.identities, tokens))) {
      if (!i || seenCharacters.has(i.character_id)) continue;
      const c = await d.characters.get(i.character_id);
      if (!c) continue;
      seenCharacters.add(c.id!);
      hits.push({ kind: "character", id: c.id!, title: c.name, image_url: c.image_url ?? i.image_url ?? null, score: score(tokens, i.words, c.name) + 0.3,
        subtitle: [i.display_name, i.real_name].find((n) => n && n !== c.name) ?? "" });
    }
  }
  if (wanted.has("team")) for (const t of await d.teams.bulkGet(await matchIds(d.teams, tokens))) {
    if (t) hits.push({ kind: "team", id: t.id!, title: t.name, subtitle: "Team", image_url: t.image_url ?? null, score: score(tokens, t.words, t.name) + 0.3 });
  }
  if (wanted.has("creator")) for (const c of await d.creators.bulkGet(await matchIds(d.creators, tokens))) {
    if (c) hits.push({ kind: "creator", id: c.id!, title: c.name, subtitle: "Creator", image_url: null, score: score(tokens, c.words, c.name) });
  }
  if (wanted.has("order")) for (const o of await d.readingOrders.bulkGet(await matchIds(d.readingOrders, tokens))) {
    if (o) hits.push({ kind: "order", id: o.id!, title: o.name, subtitle: "Reading order", image_url: null, score: score(tokens, o.words, o.name) + 0.2 });
  }
  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return { query: q, results: hits.slice(0, limit).map((h) => ({ ...h, score: Math.round(h.score * 1000) / 1000 })) };
}
