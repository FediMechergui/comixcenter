"use client";
import { useState } from "react";
import { GuideShelf } from "@/components/guides";
import { PageHead, Segmented } from "@/components/ui";
import { guides } from "@/lib/guides";

export default function GuidesPage() {
  const [filter, setFilter] = useState("All");
  const [search, setSearch] = useState("");
  const items = guides.filter((g) => (filter === "All" || g.tags.includes(filter) || g.publisher === filter) && `${g.title} ${g.tags.join(" ")}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="stack-lg"><PageHead eyebrow="The starting shelf" title="A way into every world" crumbs={[{ href: "/", label: "Discover" }, { label: "Reading guides" }]}><p className="muted prose">Mainlines, character journeys and complete stories. These guides are bundled with the app, ready before your first sync.</p></PageHead>
    <div className="row"><Segmented label="Guide category" value={filter} onChange={setFilter} options={["All", "Mainline", "Character", "Event", "Marvel", "DC"].map((v) => ({ label: v, value: v }))} /><label className="visually-hidden" htmlFor="guide-search">Search guides</label><input id="guide-search" className="input guide-search" placeholder="Find a character or universe" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
    {items.length ? <GuideShelf items={items} /> : <p className="muted">No guides match those filters.</p>}
  </div>;
}
