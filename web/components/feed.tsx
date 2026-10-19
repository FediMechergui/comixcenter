"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Thumb } from "@/components/cards";
import * as I from "@/components/icons";
import { useAction } from "@/components/ui";
import { api, qs, refresh, dataMode } from "@/lib/api";
import { startDownload, useDownloads, isDownloading } from "@/lib/downloads";
import type { OpdsEntry } from "@/lib/types";

/**
 * One publication from a feed, shared by the OPDS browser and the home page.
 *
 * Reading online is the primary action: a GetComics volume runs past 200 MB, and most of the time
 * what you want is to read the book, not to keep it. Downloading stays available where the source
 * offers a real file.
 */
export function FeedEntry({ entry, feedId, onOpen }: {
  entry: OpdsEntry;
  feedId: number;
  onOpen?: (href: string) => void;
}) {
  const router = useRouter();
  const { run, busy } = useAction();
  const downloading = useDownloads().some(isDownloading);
  const file = entry.acquisitions[0];
  const navigation = entry.kind === "navigation" && entry.href && onOpen;
  return (
    <div className="list-row">
      <Thumb src={entry.cover} />
      <span className="body">
        <strong>{entry.title}</strong>
        {entry.author && <span className="mono">{entry.author}</span>}
      </span>
      {navigation ? (
        <button className="btn secondary small" onClick={() => onOpen!(entry.href!)}>Open<I.ChevronR /></button>
      ) : (
        <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
          {/* Posts that only list Datanodes, MEGA, Pixeldrain or TeraBox: those are web pages a
              fetch cannot turn into a file, so say so rather than showing an empty row. */}
          {!entry.reader_url && !file && <span className="small muted">Mirrors only</span>}
          {entry.reader_url && (
            // Read in the app, never handed off to a browser.
            <Link className="btn small" href={`/read-online?url=${encodeURIComponent(entry.reader_url)}&title=${encodeURIComponent(entry.title)}`}>
              <I.Book />Read
            </Link>
          )}
          {file && (
            <button className="btn secondary small" disabled={busy || downloading}
              onClick={() => {
                if (dataMode() === "device") { void run(async () => { startDownload(feedId, file.href, entry.title); return true; }, "Download started. Progress is in Library."); return; }
                void run(
                () => api.post<{ created: boolean; file: { id: number } }>(`/api/opds/${feedId}/import`, { href: file.href, title: entry.title }),
                (r) => (r.created ? `Saved ${entry.title}` : `${entry.title} was already saved`),
              ).then((r) => {
                refresh("/api/library");
                // Saved to the phone, so open it rather than leaving it to be found in the library.
                if (r?.file?.id) router.push(`/read?file=${r.file.id}`);
              }); }}>
              <I.Download />Save
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * Reading a catalogue issue you do not own: the engine looks the series up on the reader's CDN by
 * name and year, and the reader opens at this issue's number. It only appears to have failed when
 * there genuinely is no online copy, which is why the miss is reported rather than swallowed.
 */
export function ReadOnlineButton({ series, year, number, title }: {
  series: string; year?: number | null; number?: string | null; title: string;
}) {
  return (
    <Link className="btn secondary" aria-label={`Find ${title} to read online`} href={`/${qs({ q: `${series}${year ? ` ${year}` : ""}`, number })}#latest`}>
      <I.Book />Read online
    </Link>
  );
}
