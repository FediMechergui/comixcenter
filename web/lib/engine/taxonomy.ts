/**
 * Curated universe / era taxonomy and the rules that place series into universes
 * (port of backend/comix/taxonomy.py). Source universes (Metron) win; otherwise imprint and
 * title rules decide; otherwise the publisher's main continuity.
 */
import { db, type Id, type Publisher, type Series, type Source, type Universe, type UniverseKind } from "./db";
import { detectPublisher, norm, slugify } from "./parsing";

interface EraSeed { name: string; start: string; end: string | null; description?: string }
interface UniverseSeed {
  slug: string; name: string; publisher: string | null; kind: UniverseKind; designation?: string | null;
  description?: string; aliases?: string[]; eras: EraSeed[];
}

const E = (name: string, start: string, end: string | null, description?: string): EraSeed => ({ name, start, end, description });
const single = (start: string, end: string | null = null, name = "All years") => [E(name, start, end)];

export const PUBLISHERS: [string, string, string[]][] = [
  ["marvel", "Marvel", ["Marvel Comics", "Marvel"]],
  ["dc", "DC", ["DC Comics", "DC"]],
  ["image", "Image", ["Image", "Image Comics"]],
  ["dark-horse", "Dark Horse", ["Dark Horse Comics", "Dark Horse"]],
  ["idw", "IDW", ["IDW Publishing", "IDW"]],
  ["boom", "BOOM!", ["BOOM! Studios", "Boom! Studios", "BOOM!"]],
  ["valiant", "Valiant", ["Valiant", "Valiant Comics", "Valiant Entertainment"]],
  ["dynamite", "Dynamite", ["Dynamite Entertainment", "Dynamite"]],
];

export const UNIVERSES: UniverseSeed[] = [
  { slug: "earth-616", name: "Earth-616", publisher: "marvel", kind: "continuity", designation: "Earth-616",
    description: "Marvel's main continuity.", aliases: ["Earth 616", "Marvel Universe", "Earth-616"], eras: [
      E("Golden Age (Timely & Atlas)", "1939-10-01", "1961-07-31"),
      E("Silver Age", "1961-08-01", "1970-12-31", "From Fantastic Four #1."),
      E("Bronze Age", "1971-01-01", "1985-12-31"),
      E("Modern Age", "1986-01-01", "2004-07-31"),
      E("Disassembled to Siege", "2004-08-01", "2010-05-31", "Avengers Disassembled, House of M, Civil War, Secret Invasion, Dark Reign, Siege."),
      E("Heroic Age", "2010-06-01", "2012-09-30"),
      E("Marvel NOW!", "2012-10-01", "2015-09-30"),
      E("All-New, All-Different", "2015-10-01", "2018-05-31", "Includes Marvel Legacy."),
      E("Fresh Start", "2018-06-01", "2024-06-30", "Includes the Krakoa era of the X-Men."),
      E("From the Ashes and beyond", "2024-07-01", null),
    ] },
  { slug: "earth-1610", name: "Ultimate Universe (Earth-1610)", publisher: "marvel", kind: "alternate", designation: "Earth-1610",
    description: "The original Ultimate Marvel line.", aliases: ["Earth 1610", "Ultimate Marvel", "Earth-1610"], eras: [
      E("Ultimate Marvel", "2000-10-01", "2009-08-31"), E("Ultimatum and Ultimate Comics", "2009-09-01", "2015-12-31")] },
  { slug: "earth-6160", name: "Ultimate Universe (Earth-6160)", publisher: "marvel", kind: "alternate", designation: "Earth-6160",
    description: "The 2023 Ultimate Universe built by the Maker.", aliases: ["Earth 6160", "Earth-6160", "New Ultimate"],
    eras: single("2023-11-01", null, "New Ultimates") },
  { slug: "earth-928", name: "Marvel 2099 (Earth-928)", publisher: "marvel", kind: "alternate", designation: "Earth-928",
    aliases: ["Earth 928", "Earth-928", "Marvel 2099"], eras: [E("Original 2099 line", "1992-11-01", "1998-12-31"), E("2099 revivals", "1999-01-01", null)] },
  { slug: "earth-982", name: "MC2 (Earth-982)", publisher: "marvel", kind: "alternate", designation: "Earth-982",
    description: "Spider-Girl, A-Next and the MC2 line.", aliases: ["Earth 982", "Earth-982", "MC2"], eras: single("1998-10-01") },
  { slug: "marvel-max", name: "MAX", publisher: "marvel", kind: "line", description: "Marvel's mature-readers line.", aliases: ["MAX"], eras: single("2001-09-01") },
  { slug: "what-if", name: "What If", publisher: "marvel", kind: "alternate", description: "One-shot alternate realities.", aliases: ["What If"], eras: single("1977-02-01") },
  { slug: "marvel-knights", name: "Marvel Knights", publisher: "marvel", kind: "line", description: "Marvel Knights line (mostly set in Earth-616).",
    aliases: ["Marvel Knights"], eras: single("1998-11-01") },

  { slug: "dc-prime", name: "DC Prime Continuity", publisher: "dc", kind: "continuity", designation: "Prime Earth",
    description: "DC's main continuity, through each reboot.",
    aliases: ["Prime Earth", "New Earth", "Earth-0", "Earth 0", "Earth-1", "Earth One", "DC Universe"], eras: [
      E("Golden Age", "1938-06-01", "1956-09-30", "From Action Comics #1. Part of Pre-Crisis."),
      E("Silver Age", "1956-10-01", "1970-12-31", "From Showcase #4. Part of Pre-Crisis."),
      E("Bronze Age (Pre-Crisis)", "1971-01-01", "1985-03-31", "Ends with Crisis on Infinite Earths."),
      E("Post-Crisis", "1985-04-01", "2011-09-30"),
      E("New 52", "2011-10-01", "2016-06-30", "After Flashpoint."),
      E("Rebirth", "2016-07-01", "2021-02-28"),
      E("Infinite Frontier", "2021-03-01", "2023-01-31"),
      E("Dawn of DC", "2023-02-01", "2024-09-30"),
      E("All In", "2024-10-01", null),
    ] },
  { slug: "dc-absolute", name: "Absolute Universe", publisher: "dc", kind: "alternate", designation: "Earth-Alpha",
    description: "The All In Absolute line.", aliases: ["Earth-Alpha", "Earth Alpha", "Absolute Universe"], eras: single("2024-10-01", null, "All In") },
  { slug: "dc-elseworlds", name: "Elseworlds", publisher: "dc", kind: "line", description: "Out-of-continuity stories.", aliases: ["Elseworlds"], eras: single("1989-01-01") },
  { slug: "dc-black-label", name: "Black Label", publisher: "dc", kind: "line", description: "DC's prestige mature line.",
    aliases: ["Black Label", "DC Black Label"], eras: single("2018-09-01") },
  { slug: "vertigo", name: "Vertigo", publisher: "dc", kind: "line", description: "DC's mature imprint.", aliases: ["Vertigo"], eras: single("1993-03-01", "2020-01-31") },

  { slug: "spawn-verse", name: "Spawn-verse", publisher: "image", kind: "continuity", description: "Todd McFarlane's shared Spawn universe.",
    aliases: ["Spawn Universe"], eras: single("1992-05-01") },
  { slug: "energon-universe", name: "Energon Universe", publisher: "image", kind: "continuity",
    description: "Skybound's shared Transformers / G.I. Joe universe.", aliases: ["Energon Universe"], eras: single("2023-06-01") },
  { slug: "massive-verse", name: "Massive-Verse", publisher: "image", kind: "continuity", description: "Radiant Black and its shared universe.",
    aliases: ["Massive-Verse", "Massiveverse"], eras: single("2021-01-01") },
  { slug: "invincible-universe", name: "Invincible Universe", publisher: "image", kind: "continuity", aliases: ["Invincible Universe"], eras: single("2003-01-01") },
  { slug: "mignolaverse", name: "Mignolaverse", publisher: "dark-horse", kind: "continuity", description: "Hellboy, B.P.R.D. and related series.",
    aliases: ["Hellboy Universe", "Mignolaverse"], eras: single("1994-03-01") },
  { slug: "valiant-universe", name: "Valiant Universe", publisher: "valiant", kind: "continuity", aliases: ["Valiant Universe"], eras: [
    E("Classic Valiant", "1991-05-01", "1996-12-31"), E("Acclaim", "1997-01-01", "2004-12-31"), E("Valiant Entertainment", "2012-05-01", null)] },

  { slug: "standalone", name: "Standalone", publisher: null, kind: "standalone",
    description: "Self-contained books you can read with no prior knowledge.", eras: single("1900-01-01") },
  { slug: "intercompany", name: "Intercompany", publisher: null, kind: "intercompany",
    description: "Crossovers between publishers, tagged with both universes.", eras: single("1900-01-01") },
];

const DEFAULT_UNIVERSE: Record<string, string> = { marvel: "earth-616", dc: "dc-prime", valiant: "valiant-universe" };

const STANDALONE_TITLES = new Set([
  "Watchmen", "Saga", "Kingdom Come", "The Dark Knight Returns", "Batman: The Dark Knight Returns", "Maus", "Paper Girls",
  "Y: The Last Man", "Preacher", "V for Vendetta", "Sandman", "The Sandman", "Marvels", "Superman: Red Son",
  "All-Star Superman", "Transmetropolitan",
].map(norm));

const AMALGAM_TITLES = new Set([
  "Amazon", "Assassins", "Bruce Wayne: Agent of S.H.I.E.L.D.", "Bullets & Bracelets", "Doctor Strangefate", "JLX",
  "Legends of the Dark Claw", "Magneto and the Magnetic Men", "Speed Demon", "Spider-Boy", "Super-Soldier", "X-Patrol",
  "Challengers of the Fantastic", "Dark Claw Adventures", "Generation Hex", "Iron Lantern", "JLX Unleashed", "Lobo the Duck",
  "Spider-Boy Team-Up", "Super-Soldier: Man of War", "The Exciting X-Patrol", "Thorion of the New Asgods", "DC Versus Marvel",
  "Marvel Versus DC", "DC/Marvel: All Access", "Unlimited Access",
].map(norm));

const MC2_PREFIXES = ["spider-girl", "a-next", "j2", "fantastic five", "last hero standing", "last planet standing",
  "avengers next", "amazing spider-girl", "spectacular spider-girl", "wild thing"];

const TITLE_RULES: [RegExp, string, string | null][] = [
  [/^(king |gunslinger |the )?spawn\b|^curse of the spawn|^sam and twitch|^the scorched|^spawn[:']/, "spawn-verse", "image"],
  [/^(transformers|void rivals|g\.?i\.? joe|destro|duke|cobra commander|energon universe)\b/, "energon-universe", "image"],
  [/^(radiant (black|red|pink)|rogue sun|inferno girl red|the dead lucky|supermassive|massive-verse)/, "massive-verse", "image"],
  [/^(invincible|guarding the globe|invincible universe|brit|capes)\b/, "invincible-universe", "image"],
  [/^(hellboy|b\.?p\.?r\.?d|abe sapien|lobster johnson|witchfinder|sir edward grey|frankenstein underground)/, "mignolaverse", "dark-horse"],
  [/^what if\b/, "what-if", "marvel"],
  [/\b2099\b/, "earth-928", "marvel"],
  [/\belseworlds\b/, "dc-elseworlds", "dc"],
  [/\bmax\b$/, "marvel-max", "marvel"],
];

const IMPRINT_RULES: Record<string, string[]> = {
  "black label": ["dc-black-label"], "dc black label": ["dc-black-label"], vertigo: ["vertigo"], elseworlds: ["dc-elseworlds"],
  max: ["marvel-max"], "marvel max": ["marvel-max"], "marvel knights": ["marvel-knights", "earth-616"],
};

/** Insert publishers, universes and eras that don't exist yet. Safe to run on every start. */
export async function seedTaxonomy(): Promise<{ publishers: number; universes: number; eras: number }> {
  const d = db();
  const created = { publishers: 0, universes: 0, eras: 0 };
  await d.transaction("rw", d.publishers, d.universes, d.eras, async () => {
    for (const [i, [slug, name]] of PUBLISHERS.entries()) {
      if (!(await d.publishers.where("slug").equals(slug).first())) {
        await d.publishers.add({ slug, name, sort_order: i });
        created.publishers++;
      }
    }
    for (const [i, seed] of UNIVERSES.entries()) {
      let uni = await d.universes.where("slug").equals(seed.slug).first();
      if (!uni) {
        const pub = seed.publisher ? await d.publishers.where("slug").equals(seed.publisher).first() : undefined;
        const id = await d.universes.add({
          slug: seed.slug, name: seed.name, kind: seed.kind, designation: seed.designation ?? null,
          description: seed.description || null, sort_order: i, publisher_id: pub?.id ?? null,
        });
        uni = await d.universes.get(id);
        created.universes++;
      }
      const existing = new Set((await d.eras.where("universe_id").equals(uni!.id!).toArray()).map((e) => e.slug));
      for (const era of seed.eras) {
        if (!existing.has(slugify(era.name))) {
          await d.eras.add({ universe_id: uni!.id!, name: era.name, slug: slugify(era.name), start_date: era.start,
            end_date: era.end, description: era.description || null });
          created.eras++;
        }
      }
    }
  });
  return created;
}

/** Seeded publisher matching a source's publisher name (Metron, Comic Vine, GCD). */
export async function publisherForName(name: string | null | undefined): Promise<Publisher | undefined> {
  if (!name) return undefined;
  const key = norm(name);
  for (const [slug, display, aliases] of PUBLISHERS) {
    if ([...aliases, display].some((a) => norm(a) === key)) return db().publishers.where("slug").equals(slug).first();
  }
  return undefined;
}

/** Map a Metron universe onto a seeded one (designation/name aliases), creating it if unknown. */
export async function universeForMetron(metronId: number, name: string, designation: string | null | undefined,
                                        publisher: Publisher | undefined): Promise<Universe> {
  const d = db();
  const known = await d.universes.where("metron_id").equals(metronId).first();
  if (known) return known;
  const keys = new Set([norm(name), norm(designation)].filter(Boolean));
  for (const seed of UNIVERSES) {
    const names = [...(seed.aliases ?? []), seed.name, seed.designation ?? ""].map(norm).filter(Boolean);
    if (names.some((n) => keys.has(n))) {
      const uni = await d.universes.where("slug").equals(seed.slug).first();
      if (uni && uni.metron_id == null) {
        await d.universes.update(uni.id!, { metron_id: metronId });
        return { ...uni, metron_id: metronId };
      }
    }
  }
  const slug = slugify(`${publisher?.slug ?? "x"}-${name}`);
  const existing = await d.universes.where("slug").equals(slug).first();
  if (existing) {
    await d.universes.update(existing.id!, { metron_id: metronId });
    return { ...existing, metron_id: metronId };
  }
  const id = await d.universes.add({ slug, name, designation: designation ?? null, kind: "alternate",
    publisher_id: publisher?.id ?? null, metron_id: metronId, sort_order: 500 });
  await d.eras.add({ universe_id: id, name: "All years", slug: "all-years", start_date: "1900-01-01" });
  return (await d.universes.get(id))!;
}

/** Universe slugs for a series from imprint and title rules, falling back to the publisher default. */
export function ruleUniverseSlugs(seriesName: string, publisherSlug: string | null | undefined,
                                  imprintName: string | null | undefined, yearBegan: number | null | undefined): string[] {
  const name = (seriesName ?? "").trim();
  const lower = name.toLowerCase();
  const slugs: string[] = [];
  const year = yearBegan ?? 0;
  if (imprintName) slugs.push(...(IMPRINT_RULES[imprintName.trim().toLowerCase()] ?? []));
  const key = norm(name);
  if (STANDALONE_TITLES.has(key) || STANDALONE_TITLES.has(norm(lower.replace(/^the\s+/, "")))) slugs.push("standalone");
  if (publisherSlug === "dc" && lower.startsWith("absolute ") && year >= 2024) slugs.push("dc-absolute");
  if (publisherSlug === "marvel" && lower.startsWith("ultimate")) {
    if (year >= 2023) slugs.push("earth-6160");
    else if (year >= 2000 && year <= 2015) slugs.push("earth-1610");
  }
  if (publisherSlug === "marvel" && MC2_PREFIXES.some((p) => lower.startsWith(p)) && year >= 1998) slugs.push("earth-982");
  for (const [pattern, slug, pub] of TITLE_RULES) if ((pub === null || pub === publisherSlug) && pattern.test(lower)) slugs.push(slug);

  // Intercompany: Amalgam titles, or "A/B" where the halves belong to different publishers
  if (AMALGAM_TITLES.has(key) && year >= 1996 && year <= 1997) slugs.push("intercompany", "earth-616", "dc-prime");
  else if (name.includes("/")) {
    const idx = name.indexOf("/");
    const pubs = new Set([name.slice(0, idx), name.slice(idx + 1)].map((s) => detectPublisher(s.trim().toLowerCase())));
    pubs.delete("Independent");
    if (pubs.size === 2) {
      slugs.push("intercompany");
      for (const p of pubs) { const def = DEFAULT_UNIVERSE[slugify(p)]; if (def) slugs.push(def); }
    }
  }
  if (!slugs.length && publisherSlug && DEFAULT_UNIVERSE[publisherSlug]) slugs.push(DEFAULT_UNIVERSE[publisherSlug]);
  return [...new Set(slugs)];
}

/**
 * Set a series' universes: Metron's issue-level universes when it has any, otherwise the
 * imprint/title rules. Curated assignments are never touched.
 */
export async function assignSeriesUniverses(seriesId: Id): Promise<Universe[]> {
  const d = db();
  const series = (await d.series.get(seriesId)) as Series;
  const existing = new Map((await d.seriesUniverses.where("series_id").equals(seriesId).toArray()).map((su) => [su.universe_id, su]));
  const issueIds = await d.issues.where("series_id").equals(seriesId).primaryKeys();
  const metronIds = new Set<Id>();
  if (issueIds.length) {
    for (const iu of await d.issueUniverses.where("issue_id").anyOf(issueIds).toArray()) metronIds.add(iu.universe_id);
  }
  let wanted: Set<Id>;
  let source: Source;
  if (metronIds.size) {
    wanted = metronIds; source = "metron";
  } else {
    const pub = series.publisher_id ? await d.publishers.get(series.publisher_id) : undefined;
    const imprint = series.imprint_id ? await d.imprints.get(series.imprint_id) : undefined;
    const slugs = ruleUniverseSlugs(series.name, pub?.slug, imprint?.name, series.year_began);
    wanted = new Set(slugs.length ? (await d.universes.where("slug").anyOf(slugs).toArray()).map((u) => u.id!) : []);
    source = "rule";
  }
  for (const [uid, su] of existing) {
    if (su.source === "curated") continue;
    if (!wanted.has(uid)) await d.seriesUniverses.delete([seriesId, uid]);
    else if (su.source !== source) await d.seriesUniverses.put({ ...su, source });
  }
  for (const uid of wanted) if (!existing.has(uid)) await d.seriesUniverses.put({ series_id: seriesId, universe_id: uid, source });
  const ids = (await d.seriesUniverses.where("series_id").equals(seriesId).toArray()).map((su) => su.universe_id);
  return (await d.universes.bulkGet(ids)).filter(Boolean) as Universe[];
}
