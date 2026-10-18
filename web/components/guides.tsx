"use client";
import Link from "next/link";
import type { ReadingGuide } from "@/lib/guides";
import * as I from "./icons";

export function GuideShelf({ items }: { items: ReadingGuide[] }) {
  return <div className="guide-grid">{items.map((g, i) => <Link href={`/guide?slug=${g.slug}`} key={g.slug} className="guide-card" data-publisher={g.publisher}>
    <span className="guide-index">{String(i + 1).padStart(2, "0")} / {g.publisher}</span>
    <strong>{g.title}</strong><p>{g.tagline}</p>
    <span className="guide-foot">{g.steps.length} stops <span aria-hidden="true"><I.ChevronR /></span></span>
  </Link>)}</div>;
}
