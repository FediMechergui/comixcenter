/** Starter curation: well-known "read before" / "leads into" links between major events (port of starter_pack.py). */
import { db, type Arc } from "../db";
import { tokenSortRatio } from "../parsing";
import { arcSummary } from "./orders";

type Ref = [string, number];
const PREREQUISITES: [Ref, Ref, string][] = [
  [["House of M", 2005], ["Avengers Disassembled", 2004], "Scarlet Witch's breakdown sets up House of M."],
  [["Secret Invasion", 2008], ["Civil War", 2006], "The post-Civil War split frames the Skrull invasion."],
  [["Dark Reign", 2009], ["Secret Invasion", 2008], "Norman Osborn's rise comes out of Secret Invasion."],
  [["Siege", 2010], ["Dark Reign", 2009], "Siege ends Dark Reign."],
  [["Time Runs Out", 2015], ["Infinity", 2013], "Hickman's Avengers saga continues."],
  [["Secret Wars", 2015], ["Time Runs Out", 2015], "The incursions end in Secret Wars."],
  [["Messiah War", 2009], ["Messiah Complex", 2007], "Cable and Hope on the run."],
  [["Second Coming", 2010], ["Messiah War", 2009], "Hope returns."],
  [["X of Swords", 2020], ["House of X / Powers of X", 2019], "Krakoa's founding."],
  [["Inferno", 2021], ["House of X / Powers of X", 2019], "Moira's secrets from HoX/PoX."],
  [["Infinite Crisis", 2005], ["Identity Crisis", 2004], "The mind-wipe fallout drives Infinite Crisis."],
  [["Infinite Crisis", 2005], ["Villains United", 2005], "Countdown to Infinite Crisis lead-in."],
  [["Infinite Crisis", 2005], ["The OMAC Project", 2005], "Countdown to Infinite Crisis lead-in."],
  [["Infinite Crisis", 2005], ["Day of Vengeance", 2005], "Countdown to Infinite Crisis lead-in."],
  [["Infinite Crisis", 2005], ["Rann-Thanagar War", 2005], "Countdown to Infinite Crisis lead-in."],
  [["Sinestro Corps War", 2007], ["Green Lantern: Rebirth", 2004], "Hal Jordan's return and Parallax."],
  [["Blackest Night", 2009], ["Sinestro Corps War", 2007], "The emotional spectrum and the Black Lanterns' prophecy."],
  [["Brightest Day", 2010], ["Blackest Night", 2009], "Picks up the resurrected heroes."],
  [["Dark Nights: Death Metal", 2020], ["Dark Nights: Metal", 2017], "Direct sequel."],
];
const LEADS_INTO: [Ref, Ref, string][] = [
  [["The Death of Superman", 1992], ["Funeral for a Friend", 1993], ""],
  [["Funeral for a Friend", 1993], ["Reign of the Supermen", 1993], ""],
  [["Knightfall", 1993], ["Knightquest", 1993], ""],
  [["Knightquest", 1993], ["KnightsEnd", 1994], ""],
  [["Messiah Complex", 2007], ["Messiah War", 2009], ""],
  [["Blackest Night", 2009], ["Brightest Day", 2010], ""],
  [["Civil War", 2006], ["The Initiative", 2007], ""],
];

/** Closest arc by name, breaking ties (1984 vs 2015 Secret Wars) by first-issue year. */
async function findArc(name: string, year: number): Promise<Arc | undefined> {
  let best: Arc | undefined, bestScore = 0;
  for (const arc of await db().arcs.toArray()) {
    let score = tokenSortRatio(name.toLowerCase(), arc.name.toLowerCase());
    if (score < 88) continue;
    const start = (await arcSummary(arc)).start_date;
    if (start) score -= Math.min(Math.abs(parseInt(start.slice(0, 4), 10) - year), 10) * 2;
    if (score > bestScore) { best = arc; bestScore = score; }
  }
  return best;
}

export async function applyStarterPack() {
  const d = db();
  let added = 0;
  const unresolved = [];
  for (const [links, kind] of [[PREREQUISITES, "prerequisite"], [LEADS_INTO, "leads_into"]] as const) {
    for (const [[aName, aYear], [bName, bYear], note] of links) {
      const a = await findArc(aName, aYear), b = await findArc(bName, bYear);
      if (!a || !b) {
        unresolved.push({ kind, from: `${aName} (${aYear})`, to: `${bName} (${bYear})`, missing: [[aName, a], [bName, b]].filter(([, x]) => !x).map(([n]) => n) });
        continue;
      }
      if (a.id === b.id) continue;
      const exists = await d.arcLinks.where("[arc_id+target_arc_id+kind]").equals([a.id!, b.id!, kind]).first();
      if (!exists) { await d.arcLinks.add({ arc_id: a.id!, target_arc_id: b.id!, kind, note: note || null, source: "starter" }); added++; }
    }
  }
  return { added, unresolved };
}

export function starterArcNames() {
  const names = new Map<string, { name: string; year: number }>();
  for (const list of [PREREQUISITES, LEADS_INTO]) for (const [a, b] of list) for (const [n, y] of [a, b]) names.set(`${n}|${y}`, { name: n, year: y });
  return [...names.values()].sort((a, b) => a.name.localeCompare(b.name) || a.year - b.year);
}
