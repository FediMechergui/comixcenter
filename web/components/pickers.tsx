"use client";
import { useEffect, useId, useState } from "react";
import { api, qs } from "@/lib/api";
import type { ArcSummary, CharacterCard, IssueCard, Page, TeamCard } from "@/lib/types";

interface Option { id: number; label: string; sub?: string }

const SOURCES: Record<string, (q: string) => Promise<Option[]>> = {
  arc: async (q) => (await api.get<Page<ArcSummary>>(`/api/arcs${qs({ q, size: 12 })}`)).items
    .map((a) => ({ id: a.id, label: a.name, sub: `${a.kind === "event" ? "Event" : "Arc"} · ${a.issue_count} issues` })),
  issue: async (q) => (await api.get<IssueCard[]>(`/api/issues${qs({ q, limit: 12 })}`))
    .map((i) => ({ id: i.id, label: `${i.series_name} #${i.number}`, sub: [i.series_year, i.title].filter(Boolean).join(" · ") })),
  character: async (q) => (await api.get<Page<CharacterCard>>(`/api/characters${qs({ q, size: 12 })}`)).items
    .map((c) => ({ id: c.id, label: c.name, sub: c.identities.join(", ") })),
  team: async (q) => (await api.get<Page<TeamCard>>(`/api/teams${qs({ q, size: 12 })}`)).items
    .map((t) => ({ id: t.id, label: t.name, sub: `${t.members} members` })),
};

/** Type-ahead picker over the local catalog (arcs, issues, characters, teams). */
export function Picker({ kind, label, onPick, placeholder }: { kind: keyof typeof SOURCES; label: string; placeholder?: string; onPick: (o: Option) => void }) {
  const [q, setQ] = useState("");
  const [options, setOptions] = useState<Option[]>([]);
  const [open, setOpen] = useState(false);
  const id = useId();
  useEffect(() => {
    if (q.trim().length < 2) { setOptions([]); return; }
    let live = true;
    const t = setTimeout(() => {
      SOURCES[kind](q.trim()).then((o) => { if (live) { setOptions(o); setOpen(true); } }).catch(() => live && setOptions([]));
    }, 220);
    return () => { live = false; clearTimeout(t); };
  }, [q, kind]);
  return (
    <div style={{ position: "relative", minWidth: 220, flex: 1 }}>
      <label className="visually-hidden" htmlFor={id}>{label}</label>
      <input id={id} className="input" value={q} placeholder={placeholder ?? label} autoComplete="off"
        role="combobox" aria-expanded={open && options.length > 0} aria-controls={`${id}-list`}
        onChange={(e) => setQ(e.target.value)} onFocus={() => options.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && options.length > 0 && (
        <ul id={`${id}-list`} role="listbox" className="card" style={{ position: "absolute", zIndex: 20, left: 0, right: 0, top: "calc(100% + 4px)", margin: 0, padding: 4, listStyle: "none", maxHeight: 280, overflowY: "auto" }}>
          {options.map((o) => (
            <li key={o.id} role="option" aria-selected={false}>
              <button type="button" className="list-row" style={{ gridTemplateColumns: "1fr", width: "100%", textAlign: "left", background: "none", border: 0, cursor: "pointer", padding: "8px 10px" }}
                onMouseDown={(e) => e.preventDefault()} onClick={() => { onPick(o); setQ(""); setOptions([]); setOpen(false); }}>
                <span className="body"><strong>{o.label}</strong>{o.sub && <span className="mono">{o.sub}</span>}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
