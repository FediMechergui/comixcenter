"use client";
// Things the Android app does differently from a browser.
import { apiUrl } from "@/lib/api";

export function isNativeApp(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/**
 * Exports a library file as PDF. In a browser the server's download is used directly; in the
 * Android app (whose WebView ignores downloads) the PDF is saved on the phone and offered
 * through the share sheet, so it can go to Files, Drive, a reader app, etc.
 */
export async function exportPdf(fileId: number, fileName: string): Promise<"downloaded" | "shared" | "cancelled"> {
  const url = apiUrl(`/api/library/${fileId}/export.pdf`);
  if (!isNativeApp()) {
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return "downloaded";
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`The server couldn't make the PDF (${resp.status})`);
  const data = toBase64(await resp.arrayBuffer());
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([import("@capacitor/filesystem"), import("@capacitor/share")]);
  const safe = fileName.replace(/[^\w .()#-]+/g, "_");
  const written = await Filesystem.writeFile({ path: `exports/${safe}`, data, directory: Directory.Cache, recursive: true });
  try {
    await Share.share({ title: safe, files: [written.uri] });
  } catch (e) {
    // Backing out of the share sheet is a choice, not a failure
    if (/cancel/i.test((e as Error)?.message ?? "")) return "cancelled";
    throw e;
  }
  return "shared";
}
