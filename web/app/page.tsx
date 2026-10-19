"use client";
import Link from "next/link";
import { GuideShelf } from "@/components/guides";
import { OnlineCatalog } from "@/components/online-catalog";
import { useStringParam, withParams } from "@/components/params";
import { Section } from "@/components/ui";
import * as I from "@/components/icons";
import { qs, useApi } from "@/lib/api";
import { guides } from "@/lib/guides";
import { useReadingHistory } from "@/lib/reading-history";
import type { LibraryFile, Page } from "@/lib/types";

function HomePage() {
  const query = useStringParam("q") || "";
  const number = useStringParam("number");
  const history = useReadingHistory();
  const library = useApi<Page<LibraryFile>>("/api/library?status=reading&sort=read&size=4");
  return <div className="stack-lg discovery-home">
    <header className="discover-hero">
      <div><span className="eyebrow">Your next good story</span><h1>A whole universe.<br /><em>One page at a time.</em></h1><p>Find a way in, follow a character, or pick up exactly where you left off.</p>
        <div className="row"><Link className="btn" href="/guides">Find my starting point<I.ChevronR /></Link><Link className="text-link" href="/library">My library<I.Book /></Link></div>
      </div>
      <Link href="/guide?slug=batman-origins" className="hero-feature"><span className="eyebrow">The starting shelf / 01</span><span className="feature-monogram" aria-hidden="true">B<span>01</span></span><div><span className="small">Character essentials</span><strong>Before the legend. <br />Become the detective.</strong><span className="text-link">Begin with Batman<I.ChevronR /></span></div></Link>
    </header>
    {(history.length > 0 || !!library.data?.items.length) && <Section title="Pick up where you left off" action={<Link href="/library">Your library</Link>}><div className="continue-shelf">
      {history.slice(0, 4).map((s) => <Link key={s.url} className="continue-card" href={`/read-online${qs({ url: s.url, title: s.title, chapter: s.reader === "source" ? null : s.chapter })}`}><I.Book /><div><strong>{s.title}</strong><span className="small muted">{s.chapterTitle}{s.reader !== "source" || s.sourcePage ? ` · Page ${s.page + 1}` : " · Resume session"}</span></div><I.ChevronR /></Link>)}
      {library.data?.items.slice(0, 2).map((f) => <Link className="continue-card" key={f.id} href={`/read?file=${f.id}`}><I.Library /><div><strong>{f.name}</strong><span className="small muted">Saved comic · Page {f.current_page + 1} of {f.page_count}</span></div><I.ChevronR /></Link>)}
    </div></Section>}
    <Section title="Choose your universe" action={<Link href="/browse">Explore all</Link>}><div className="universe-launchers">
      <Link href="/guide?slug=marvel-modern"><span className="universe-number">616</span><strong>Marvel</strong><span>Heroes, events, the mainline<I.ChevronR /></span></Link>
      <Link href="/guide?slug=dc-modern"><span className="universe-number">DC</span><strong>DC Universe</strong><span>Crisis, legacy, new beginnings<I.ChevronR /></span></Link>
      <Link href="/guide?slug=absolute-dc"><span className="universe-number">A</span><strong>Absolute</strong><span>A different kind of origin<I.ChevronR /></span></Link>
      <Link href="/guide?slug=energon"><span className="universe-number">EU</span><strong>Beyond the big two</strong><span>Energon, Invincible, Hellboy<I.ChevronR /></span></Link>
    </div></Section>
    <Section title="Good places to begin" action={<Link href="/guides">All {guides.length} reading guides</Link>}><GuideShelf items={guides.filter((g) => ["batman-origins", "new-ultimate", "xmen-krakoa", "invincible"].includes(g.slug))} /></Section>
    <OnlineCatalog initialQuery={query} number={number} />
    <div className="discovery-footer"><p>Follow the story, not the noise.</p><div className="row"><Link href="/arcs">Arcs & events</Link><Link href="/characters">Characters</Link><Link href="/opds">More sources</Link></div></div>
  </div>;
}
export default withParams(HomePage);
