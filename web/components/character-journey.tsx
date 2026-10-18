"use client";
import Link from "next/link";
import { useState } from "react";
import { formatDate, Section } from "./ui";
import type { CharacterDetail } from "@/lib/types";

const labels: Record<string, string> = { first_appearance: "First appearance", death: "Death", resurrection: "Return", costume: "A new identity" };

export function CharacterJourney({ character }: { character: CharacterDetail }) {
  const [spoilers, setSpoilers] = useState(false);
  const events = character.identities.flatMap((identity) => identity.events.map((event) => ({ ...event, identity: identity.display_name })))
    .sort((a, b) => (a.issue?.cover_date || "9999").localeCompare(b.issue?.cover_date || "9999") || a.id - b.id);
  if (!events.length) return null;
  const visible = spoilers ? events : events.filter((e) => e.kind === "first_appearance");
  return <Section title="Key moments in the character’s life" action={<button className="btn ghost small" aria-pressed={spoilers} onClick={() => setSpoilers((s) => !s)}>{spoilers ? "Hide story spoilers" : "Reveal story milestones"}</button>}>
    {!spoilers && <p className="small muted">Origins are shown first. Reveal milestones to see later identity changes, deaths and returns.</p>}
    <ol className="character-moments">{visible.map((e) => <li key={`${e.identity}-${e.id}`}><span className="moment-date">{e.issue?.cover_date ? formatDate(e.issue.cover_date, "year") : "Issue reference"}</span><div><span className="eyebrow">{e.identity}</span><strong>{labels[e.kind] || e.kind}</strong>{e.issue?.id ? <Link className="text-link" href={`/issue?id=${e.issue.id}`}>{e.issue.label}</Link> : <span>{e.issue?.label}</span>}{e.note && <p className="small muted">{e.note}</p>}</div></li>)}</ol>
    {!visible.length && <p className="small muted">Later milestones are available. Reveal story milestones when you’re ready.</p>}
  </Section>;
}
