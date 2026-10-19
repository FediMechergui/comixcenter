"use client";
import { useRef, useState } from "react";
import { Section } from "@/components/ui";
import { isNativeApp } from "@/lib/native";
import type { PersonalBackup } from "@/lib/engine/backup";

export function PersonalBackupControls() {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<PersonalBackup | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  async function exportBackup() {
    setBusy(true); setStatus("Preparing your backup...");
    try {
      const { initEngine } = await import("@/lib/engine"); await initEngine();
      const { exportPersonalBackup } = await import("@/lib/engine/backup");
      const backup = JSON.stringify(await exportPersonalBackup());
      const name = `ComixCenter-backup-${new Date().toISOString().slice(0,10)}.json`;
      if (isNativeApp()) {
        const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([import("@capacitor/filesystem"), import("@capacitor/share")]);
        const file = await Filesystem.writeFile({ path: `backups/${name}`, data: backup, encoding: Encoding.UTF8, directory: Directory.Cache, recursive: true });
        await Share.share({ title: "Save your ComixCenter backup", files: [file.uri] });
        setStatus("Backup prepared. Choose a storage destination in the share sheet to keep it.");
      } else {
        const url = URL.createObjectURL(new Blob([backup], { type: "application/json" }));
        const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        setStatus("Backup downloaded.");
      }
    } catch (e) { setStatus(e instanceof Error ? e.message : "Backup failed"); }
    finally { setBusy(false); }
  }
  return <Section title="Backup and recovery">
    <p className="small muted">Keep your catalog, reading orders, guide checklists and reading progress. Backups exclude passwords, browser cookies and comic files. Reimport the same comic files after reinstalling to recover their progress.</p>
    <div className="row"><button className="btn secondary" disabled={busy} onClick={() => void exportBackup()}>Save personal backup</button><button className="btn ghost" disabled={busy} onClick={() => input.current?.click()}>Choose backup to restore</button></div>
    <input ref={input} className="visually-hidden" type="file" accept=".json,application/json" aria-label="Personal backup file" onChange={async (e) => {
      setPreview(null); const file = e.target.files?.[0]; e.target.value = ""; if (!file) return;
      try { if (file.size > 25 * 1024 * 1024) throw new Error("Choose a backup smaller than 25 MB."); const { validateBackup } = await import("@/lib/engine/backup"); setPreview(validateBackup(JSON.parse(await file.text()))); setStatus(""); }
      catch (error) { setStatus(error instanceof Error ? error.message : "Invalid backup"); }
    }} />
    {preview && <div className="notice warn"><strong>Review this restore</strong><p>{preview.catalog.tables.series?.length || 0} series, {preview.library.length} comic records and {preview.readStatus.length} read issues. Created {new Date(preview.created_at).toLocaleDateString()}.</p><p className="small">This replaces this phone's catalog, reading orders, checklists and progress. Comic files already on the phone and saved accounts are kept. Missing files must be reimported.</p><div className="row"><button className="btn" disabled={busy} onClick={async () => {
      setBusy(true); setStatus("Restoring...");
      try { const { initEngine } = await import("@/lib/engine"); await initEngine(); const { restorePersonalBackup } = await import("@/lib/engine/backup"); const result = await restorePersonalBackup(preview); setPreview(null); setStatus(`Restored. ${result.restoredFiles} saved comics updated; ${result.missingFiles} files can be reimported. Restart the app to refresh every screen.`); }
      catch (e) { setStatus(e instanceof Error ? e.message : "Restore failed"); }
      finally { setBusy(false); }
    }}>Replace catalog and restore</button><button className="btn ghost" disabled={busy} onClick={() => setPreview(null)}>Cancel</button></div></div>}
    {status && <p role="status" className="small">{status}</p>}
  </Section>;
}
