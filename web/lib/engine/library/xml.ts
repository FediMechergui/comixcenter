/**
 * Namespace-agnostic XML helpers over DOMParser, mirroring the ElementTree "{*}tag" lookups the
 * Python code uses. Elements are matched by local name so prefixed and default namespaces both work.
 */

/** Bytes to text honouring a BOM or the XML declaration's encoding (UTF-8 otherwise). */
export function decodeXml(data: Uint8Array | string): string {
  if (typeof data === "string") return data;
  let label = "utf-8";
  if (data[0] === 0xff && data[1] === 0xfe) label = "utf-16le";
  else if (data[0] === 0xfe && data[1] === 0xff) label = "utf-16be";
  else if (!(data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf)) {
    const head = String.fromCharCode(...data.subarray(0, 200));
    const m = /^\s*<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head);
    if (m) label = m[1];
  }
  try {
    return new TextDecoder(label).decode(data);
  } catch {
    return new TextDecoder("utf-8").decode(data);
  }
}

/** Parsed document, or null when the text is not well-formed XML (DOMParser reports errors in-band). */
export function parseXml(data: Uint8Array | string, type: DOMParserSupportedType = "application/xml"): Document | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(decodeXml(data), type);
  } catch {
    return null;
  }
  if (!doc.documentElement || doc.getElementsByTagName("parsererror").length) return null;
  return doc;
}

export function localName(el: Element): string {
  return el.localName || el.tagName.split(":").pop() || "";
}

/** Direct child elements with this local name (ElementTree's find / iterfind "{*}name"). */
export function children(el: Element, name: string): Element[] {
  return Array.from(el.children).filter((c) => localName(c) === name);
}

export function child(el: Element, name: string): Element | null {
  return children(el, name)[0] ?? null;
}

/** The element and all its descendants in document order (ElementTree's iter()). */
export function descendants(el: Element): Element[] {
  return [el, ...Array.from(el.getElementsByTagName("*"))];
}

/** Trimmed text of the first child with this name; undefined when missing or blank. */
export function childText(el: Element, name: string): string | undefined {
  const value = child(el, name)?.textContent?.trim();
  return value || undefined;
}
