"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useStringParam, withParams } from "@/components/params";
import { Empty, PageHead, Segmented } from "@/components/ui";
import * as I from "@/components/icons";
import { guides } from "@/lib/guides";
import { qs, useApi } from "@/lib/api";
import type { UniverseCard } from "@/lib/types";

function GuidePage() {
  const slug = useStringParam("slug");
  const guide = guides.find((g) => g.slug === slug);
  return guide ? <Guide key={guide.slug} slug={guide.slug} /> : <Empty title="Choose a reading guide" action={<Link className="btn" href="/guides">Explore guides</Link>}>This guide could not be found.</Empty>;
}
function Guide({ slug }: { slug: string }) {
  const guide = guides.find((g) => g.slug === slug)!;
  const [completed, setCompleted] = useState<number[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [path, setPath] = useState("complete");
  const universes = useApi<UniverseCard[]>("/api/universes");
  const universe = universes.data?.find((u) => u.slug === guide.universe);
  const key = `comix.guide.${slug}`;
  useEffect(() => { try { const saved = JSON.parse(localStorage.getItem(key) || "[]"); if (Array.isArray(saved)) setCompleted(saved.filter((n) => Number.isInteger(n) && n >= 0 && n < guide.steps.length)); } catch { /* first visit */ } setLoaded(true); }, [key, guide.steps.length]);
  const toggle = (i: number) => { const next = completed.includes(i) ? completed.filter((n) => n !== i) : [...completed, i]; setCompleted(next); try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* session only */ } };
  const steps = guide.steps.map((step, index) => ({ ...step, index })).filter((s) => path === "complete" || s.tier === "essential");
  const next = steps.find((s) => !completed.includes(s.index));
  return <div className="stack-lg"><PageHead eyebrow={`${guide.publisher} / Reading guide`} title={guide.title} crumbs={[{ href: "/guides", label: "Reading guides" }, { label: guide.title }]}><p className="guide-tagline">{guide.tagline}</p><p className="muted prose">{guide.description}</p><div className="row">{universe && <Link className="btn secondary small" href={`/universe?id=${universe.id}`}>Explore {universe.name}<I.ChevronR /></Link>}<span className="mono">{guide.steps.length} reading stops · {completed.length} completed</span></div></PageHead>
    <div className="guide-progress"><span style={{ width: `${completed.length / guide.steps.length * 100}%` }} /></div>
    <Segmented label="Reading path" value={path} onChange={setPath} options={[{ value: "essential", label: "Essentials" }, { value: "complete", label: "Full guide" }]} />
    {loaded && <div className="notice"><strong>{next ? `Up next: ${next.title} ${next.issues}` : "You have completed this reading path"}</strong><p className="small muted">{path === "essential" ? "Essentials follow the core story. Optional stops stay available in the full guide." : "Follow every stop, or choose Essentials for the core story."}</p>{next && <a className="btn secondary small" href={`#guide-step-${next.index}`}>Continue this path<I.ChevronR /></a>}</div>}
    <ol className="reading-timeline">{steps.map((s) => <li id={`guide-step-${s.index}`} key={s.index} className={completed.includes(s.index) ? "is-complete" : ""}>
      <label className="step-check"><input type="checkbox" checked={completed.includes(s.index)} disabled={!loaded} onChange={() => toggle(s.index)} aria-label={`Mark ${s.title} ${s.issues} complete`} /><span>{completed.includes(s.index) ? <I.Check /> : String(s.index + 1).padStart(2, "0")}</span></label>
      <div className="step-body"><div className="row"><span className="eyebrow">{s.year} · {s.tier === "essential" ? "Essential" : "Explore further"}</span>{s.milestone && <span className="milestone">{s.milestone}</span>}</div><h2 className="h2">{s.title}</h2><span className="mono">{s.issues}</span><p>{s.note}</p>
        <div className="row"><Link className="btn small" href={`/${qs({ q: `${s.title} ${s.year}`, number: /#(\d+)/.exec(s.issues)?.[1] })}#latest`}><I.Book />Find & read</Link><Link className="text-link small" href={`/search${qs({ q: s.title })}`}>In my catalog<I.ChevronR /></Link></div>
      </div>
    </li>)}</ol>
    <p className="small muted">Your checklist is saved on this device. A completed stop tracks this guide; individual issue progress is tracked separately in your library.</p>
    {guide.sources?.length && <div className="small muted">Further reading: {guide.sources.map((s) => <a className="text-link" key={s.url} href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a>)}</div>}
  </div>;
}
export default withParams(GuidePage);
