/**
 * OPDS 1.x feed parsing (port of opds.py parse_feed): navigation entries and publications with
 * their acquisition links. Komga, Kavita, Calibre-Web and Ubooquity all serve OPDS. Fetching is
 * the app's job (native HTTP, since catalog servers rarely allow CORS).
 */
import { children, localName, parseXml } from "./xml";

export const ATOM_NS = "http://www.w3.org/2005/Atom";
const ACQUISITION = "http://opds-spec.org/acquisition";
const IGNORED_ACQUISITIONS = ["/buy", "/borrow", "/subscribe", "/sample"];
export const COMIC_TYPES = [
  "application/vnd.comicbook+zip", "application/x-cbz", "application/zip", "application/x-cbr",
  "application/vnd.comicbook-rar", "application/x-rar-compressed", "application/x-cb7",
  "application/x-7z-compressed", "application/pdf", "application/epub+zip", "application/octet-stream",
] as const;
const IMAGE_RELS = [
  "http://opds-spec.org/image", "http://opds-spec.org/cover", "http://opds-spec.org/image/thumbnail",
  "http://opds-spec.org/thumbnail",
];
const NAVIGATION_RELS = ["subsection", "alternate", "", "http://opds-spec.org/sort/new", "http://opds-spec.org/sort/popular"];

export class OpdsError extends Error {
  constructor(message: string) { super(message); this.name = "OpdsError"; }
}

export interface OpdsAcquisition { href: string; type: string | null; rel: string }

export interface OpdsEntry {
  title: string;
  summary: string | null;
  author: string | null;
  cover: string | null;
  kind: "publication" | "navigation";
  /** Navigation target (a sub-feed); null for plain publications */
  href: string | null;
  acquisitions: OpdsAcquisition[];
}

export interface OpdsFeed {
  title: string;
  entries: OpdsEntry[];
  next: string | null;
  previous: string | null;
  up: string | null;
}

/** urljoin equivalent; a malformed href is returned unchanged rather than failing the whole feed. */
function resolve(base: string, href: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

/** ElementTree findtext: null when the element is missing, "" when it has no text. */
function findText(el: Element, ...path: string[]): string | null {
  let cur: Element | null = el;
  for (const name of path) {
    cur = cur && (children(cur, name).find((c) => c.namespaceURI === ATOM_NS) ?? null);
  }
  return cur ? cur.textContent ?? "" : null;
}

function atomLinks(el: Element): Element[] {
  return children(el, "link").filter((l) => l.namespaceURI === ATOM_NS);
}

export function parseOpdsFeed(xml: string | Uint8Array, baseUrl: string): OpdsFeed {
  const root = parseXml(xml)?.documentElement;
  if (!root) throw new OpdsError("Not an OPDS/Atom feed: not well-formed XML");
  if (localName(root) !== "feed" || root.namespaceURI !== ATOM_NS) throw new OpdsError("Not an OPDS/Atom feed");

  const linkHref = (rel: string): string | null => {
    const link = atomLinks(root).find((l) => l.getAttribute("rel") === rel);
    return link ? resolve(baseUrl, link.getAttribute("href") ?? "") : null;
  };

  const entries: OpdsEntry[] = children(root, "entry")
    .filter((e) => e.namespaceURI === ATOM_NS)
    .map((entry) => {
      const title = (findText(entry, "title") || "Untitled").trim();
      const summary = (findText(entry, "summary") || findText(entry, "content") || "").trim() || null;
      const author = findText(entry, "author", "name");
      const acquisitions: OpdsAcquisition[] = [];
      let navigation: string | null = null;
      let cover: string | null = null;
      for (const link of atomLinks(entry)) {
        const rel = link.getAttribute("rel") || "";
        const href = link.getAttribute("href");
        const rawType = link.getAttribute("type") || "";
        const type = rawType.split(";")[0].trim();
        if (!href) continue;
        const absolute = resolve(baseUrl, href);
        if (rel.startsWith(ACQUISITION) && !IGNORED_ACQUISITIONS.some((s) => rel.endsWith(s))) {
          acquisitions.push({ href: absolute, type: type || null, rel });
        } else if (IMAGE_RELS.includes(rel) && (cover === null || rel.endsWith("image") || rel.endsWith("cover"))) {
          cover = absolute;
        } else if ((type.includes("atom+xml") && NAVIGATION_RELS.includes(rel)) || rawType.includes("profile=opds-catalog")) {
          navigation = navigation ?? absolute;
        }
      }
      return {
        title, summary, author, cover,
        kind: acquisitions.length ? "publication" : "navigation",
        href: navigation, acquisitions,
      };
    });

  return {
    title: (findText(root, "title") ?? "").trim(),
    entries,
    next: linkHref("next"),
    previous: linkHref("previous"),
    up: linkHref("up") ?? linkHref("start"),
  };
}

