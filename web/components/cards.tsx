"use client";
import Link from "next/link";
import { useState } from "react";
import * as I from "@/components/icons";
import { formatDate, plural, ProgressBar, TierChip } from "@/components/ui";
import type { ArcSummary, CharacterCard, IssueCard, OrderCard, SeriesCard, TeamCard, Tier } from "@/lib/types";

/** Cover image with a halftone placeholder when there's no art (or it fails to load). */
export function Cover({ src, alt, fallback, children }: { src: string | null | undefined; alt: string; fallback: string; children?: React.ReactNode }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="cover">
      {src && !failed
        ? <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} />
        : <div className="placeholder" aria-hidden>{fallback}</div>}
      {children}
    </div>
  );
}

/** Small list thumbnail; failed or missing art shows the halftone instead of a broken image. */
export function Thumb({ src, round }: { src: string | null | undefined; round?: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`thumb${round ? " round" : ""}`} aria-hidden>
      {src && !failed ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} /> : <span className="thumb-blank" />}
    </span>
  );
}

/** The cover corner box: issue number set like the box on a newsstand cover. */
export function CornerBox({ number, date }: { number: string; date?: string | null }) {
  const short = number.length > 5 ? number.slice(0, 5) : number;
  return (
    <span className="cornerbox" aria-hidden>
      <span className="no">No.</span>
      <span className="num">{short}</span>
      {date && <span className="date">{formatDate(date, "month").toUpperCase()}</span>}
    </span>
  );
}

export function IssueTile({ issue, showSeries = true, tier }: { issue: IssueCard; showSeries?: boolean; tier?: Tier }) {
  const label = `${issue.series_name} #${issue.number}`;
  return (
    <Link href={`/issue?id=${issue.id}`} className="issue-tile card-link" aria-label={`${label}${issue.read ? ", read" : ""}`}>
      <Cover src={issue.image_url} alt="" fallback={issue.series_name}>
        <CornerBox number={issue.number} date={issue.cover_date} />
        {issue.read && <span className="readmark" title="Read"><I.Check /></span>}
        {issue.owned && <span className="owned">In your library</span>}
      </Cover>
      <span className="meta">
        <strong>{showSeries ? issue.series_name : issue.title || `Issue #${issue.number}`}</strong>
        <span className="mono">{showSeries && issue.series_year ? `${issue.series_year} · ` : ""}{formatDate(issue.cover_date) || "Undated"}</span>
        {tier && <span style={{ marginTop: 4 }}><TierChip tier={tier} /></span>}
      </span>
    </Link>
  );
}

export function SeriesRow({ s }: { s: SeriesCard }) {
  const years = s.year_began ? `${s.year_began}${s.year_end && s.year_end !== s.year_began ? `–${s.year_end}` : s.year_end ? "" : "–"}` : "";
  return (
    <Link href={`/series?id=${s.id}`} className="list-row">
      <Thumb src={s.image_url} />
      <span className="body">
        <strong>{s.name}{s.volume && s.volume > 1 ? ` Vol. ${s.volume}` : ""}</strong>
        <span className="mono">{[years, s.series_type, s.publisher].filter(Boolean).join(" · ")}</span>
      </span>
      <span className="mono">{s.issue_count ? plural(s.issue_count, "issue") : ""}</span>
    </Link>
  );
}

export function ArcRow({ a, tier, note }: { a: ArcSummary; tier?: Tier; note?: string | null }) {
  return (
    <Link href={`/arc?id=${a.id}`} className="list-row">
      <Thumb src={a.image_url} />
      <span className="body stack" style={{ gap: 4 }}>
        <strong>{a.name}</strong>
        <span className="mono">{[a.kind === "event" ? "Event" : "Arc", formatDate(a.start_date, "year"), plural(a.issue_count, "issue")].filter(Boolean).join(" · ")}</span>
        {note && <span className="small muted">{note}</span>}
        {a.issue_count > 0 && <ProgressBar read={a.read_count} total={a.issue_count} thin />}
      </span>
      <span>{tier ? <TierChip tier={tier} /> : a.read_count >= a.issue_count && a.issue_count > 0 ? <span className="tier tier-essential">Read</span> : null}</span>
    </Link>
  );
}

export function OrderTile({ o }: { o: OrderCard }) {
  const core = o.progress.paths.core;
  const all = o.progress.paths.complete;
  return (
    <Link href={`/order?id=${o.id}`} className="card card-link stack" style={{ gap: 10 }}>
      <span className="eyebrow">{o.kind === "custom" ? "Reading order" : `${o.kind} order`}{o.source === "generated" ? " · draft" : o.source === "metron" ? " · Metron list" : ""}</span>
      <strong className="h3">{o.name}</strong>
      <span className="mono">{plural(core.issues, "issue")} on the core path · {plural(all.issues, "issue")} complete</span>
      <ProgressBar read={core.read} total={core.issues} />
    </Link>
  );
}

export function CharacterRow({ c }: { c: CharacterCard }) {
  const people = c.identities.filter((n) => n !== c.name);
  return (
    <Link href={`/character?id=${c.id}`} className="list-row">
      <Thumb src={c.image_url} round />
      <span className="body">
        <strong>{c.name}</strong>
        <span className="mono">{people.length ? people.slice(0, 3).join(", ") : "Character"}</span>
      </span>
      <span className="mono">{c.appearances ? plural(c.appearances, "issue") : ""}</span>
    </Link>
  );
}

export function TeamRow({ t }: { t: TeamCard }) {
  return (
    <Link href={`/team?id=${t.id}`} className="list-row">
      <Thumb src={t.image_url} round />
      <span className="body"><strong>{t.name}</strong><span className="mono">{plural(t.members, "known member")}</span></span>
      <span className="mono">{t.appearances ? plural(t.appearances, "issue") : ""}</span>
    </Link>
  );
}

export function Pager({ page, size, total, onPage }: { page: number; size: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return null;
  return (
    <div className="row" style={{ justifyContent: "center", marginTop: 12 }}>
      <button className="btn small secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}><I.ChevronL />Previous</button>
      <span className="mono">Page {page} of {pages}</span>
      <button className="btn small secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next<I.ChevronR /></button>
    </div>
  );
}
