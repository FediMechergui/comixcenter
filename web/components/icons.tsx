import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const base = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, viewBox: "0 0 24 24", "aria-hidden": true };

/** Printer's registration mark: the ComixCenter logo */
export function RegMark({ size = 26, ...p }: P & { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden {...p}>
      <circle cx="17" cy="15" r="9" fill="none" stroke="var(--cyan)" strokeWidth="2.4" />
      <circle cx="15" cy="17" r="9" fill="none" stroke="var(--magenta)" strokeWidth="2.4" />
      <circle cx="16" cy="16" r="9" fill="none" stroke="var(--ink)" strokeWidth="2.6" />
      <path d="M16 2v28M2 16h28" stroke="var(--ink)" strokeWidth="2.2" />
      <circle cx="16" cy="16" r="3.2" fill="var(--yellow)" stroke="var(--ink)" strokeWidth="1.6" />
    </svg>
  );
}

export const Home = (p: P) => <svg {...base} {...p}><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /><path d="M10 20v-6h4v6" /></svg>;
export const Browse = (p: P) => <svg {...base} {...p}><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="16" rx="1" /><path d="M17.5 5.5l3.5 14" /></svg>;
export const Path = (p: P) => <svg {...base} {...p}><circle cx="6" cy="5" r="2" /><circle cx="18" cy="12" r="2" /><circle cx="6" cy="19" r="2" /><path d="M8 5h4a4 4 0 014 4v1M16 14v1a4 4 0 01-4 4H8" /></svg>;
export const Library = (p: P) => <svg {...base} {...p}><path d="M4 19V5a1 1 0 011-1h5v16H5a1 1 0 01-1-1z" /><path d="M10 4h4v16h-4" /><path d="M14 6.5l3.8-1 3 13.4-3.8 1" /></svg>;
export const Search = (p: P) => <svg {...base} {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>;
export const Users = (p: P) => <svg {...base} {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0113 0" /><path d="M16 4.5a3.5 3.5 0 010 7M18 14.5a6.5 6.5 0 013.5 5.5" /></svg>;
export const Shield = (p: P) => <svg {...base} {...p}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /></svg>;
export const Spark = (p: P) => <svg {...base} {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6" /></svg>;
export const Gear = (p: P) => <svg {...base} {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z" /></svg>;
export const Wrench = (p: P) => <svg {...base} {...p}><path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" /></svg>;
export const Check = (p: P) => <svg {...base} strokeWidth={3} {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
export const ChevronL = (p: P) => <svg {...base} {...p}><path d="M15 18l-6-6 6-6" /></svg>;
export const ChevronR = (p: P) => <svg {...base} {...p}><path d="M9 18l6-6-6-6" /></svg>;
export const Up = (p: P) => <svg {...base} {...p}><path d="M18 15l-6-6-6 6" /></svg>;
export const Down = (p: P) => <svg {...base} {...p}><path d="M6 9l6 6 6-6" /></svg>;
export const X = (p: P) => <svg {...base} {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>;
export const Plus = (p: P) => <svg {...base} {...p}><path d="M12 5v14M5 12h14" /></svg>;
export const Upload = (p: P) => <svg {...base} {...p}><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" /></svg>;
export const Download = (p: P) => <svg {...base} {...p}><path d="M12 4v12M7 11l5 5 5-5" /><path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" /></svg>;
export const Book = (p: P) => <svg {...base} {...p}><path d="M12 6c-2-1.5-5-2-8-1.5v14c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5v-14c-3-.5-6 0-8 1.5z" /><path d="M12 6v14" /></svg>;
export const Refresh = (p: P) => <svg {...base} {...p}><path d="M20 11a8 8 0 10-2.3 5.7" /><path d="M20 4v7h-7" /></svg>;
export const Link = (p: P) => <svg {...base} {...p}><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" /></svg>;
export const Panels = (p: P) => <svg {...base} {...p}><rect x="3" y="3" width="18" height="18" rx="1" /><path d="M3 11h18M12 3v8M9 11v10" /></svg>;
export const Scroll = (p: P) => <svg {...base} {...p}><rect x="6" y="2" width="12" height="20" rx="1" /><path d="M6 8h12M6 15h12" /></svg>;
export const Single = (p: P) => <svg {...base} {...p}><rect x="6" y="3" width="12" height="18" rx="1" /></svg>;
export const Double = (p: P) => <svg {...base} {...p}><rect x="2" y="4" width="9.5" height="16" rx="1" /><rect x="12.5" y="4" width="9.5" height="16" rx="1" /></svg>;
export const Offline = (p: P) => <svg {...base} {...p}><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 20h14" /></svg>;
