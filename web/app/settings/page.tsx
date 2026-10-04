"use client";
import { useEffect, useState } from "react";
import { PageHead, Section, Segmented, useToast } from "@/components/ui";
import { adminToken, api, defaultServer, serverUrl, setAdminToken, setServerUrl } from "@/lib/api";
import { applyTheme, THEME_KEY, type Theme } from "@/lib/theme";
import type { Status } from "@/lib/types";


export default function SettingsPage() {
  const toast = useToast();
  const [server, setServer] = useState("");
  const [token, setToken] = useState("");
  const [theme, setTheme] = useState<Theme>("system");
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    setServer(serverUrl());
    setToken(adminToken() ?? "");
    try { setTheme((localStorage.getItem(THEME_KEY) as Theme) || "system"); } catch { /* ignore */ }
  }, []);

  async function testServer() {
    setCheck(null);
    try {
      const s = await api.get<Status>("/api/status");
      setCheck({ ok: true, text: `Connected to ComixCenter ${s.version}: ${s.counts.series} series, ${s.counts.library_files} comics in the library.` });
    } catch (e) {
      setCheck({ ok: false, text: (e as Error).message });
    }
  }

  return (
    <>
      <PageHead eyebrow="App" title="Settings" />
      <div className="stack-lg" style={{ maxWidth: 640 }}>
        <Section title="Server">
          <form className="stack" onSubmit={(e) => { e.preventDefault(); setServerUrl(server === defaultServer() ? null : server); toast("Server address saved"); testServer(); }}>
            <label className="label">ComixCenter server address
              <input className="input" type="url" value={server} onChange={(e) => setServer(e.target.value)} placeholder={defaultServer()} />
            </label>
            <span className="small muted">Default here: {defaultServer() || "this site"}. On the Android emulator, 10.0.2.2 is your computer. On a phone, use your computer&rsquo;s network address, e.g. http://192.168.1.20:8000.</span>
            <div className="row">
              <button className="btn">Save and test</button>
              <button type="button" className="btn secondary" onClick={() => { setServerUrl(null); setServer(defaultServer()); toast("Reset to default"); testServer(); }}>Use default</button>
            </div>
            {check && <div className={`notice ${check.ok ? "" : "error"}`} role="status">{check.text}</div>}
          </form>
        </Section>

        <Section title="Curation access">
          <form className="stack" onSubmit={(e) => { e.preventDefault(); setAdminToken(token.trim() || null); toast(token.trim() ? "Admin token saved" : "Admin token removed"); }}>
            <label className="label">Admin token
              <input className="input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Only needed if ADMIN_TOKEN is set on the server" />
            </label>
            <div><button className="btn secondary">Save token</button></div>
          </form>
        </Section>

        <Section title="Appearance">
          <Segmented label="Theme" value={theme} onChange={(t) => {
            setTheme(t); applyTheme(t);
            try { if (t === "system") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, t); } catch { /* ignore */ }
          }} options={[{ value: "system", label: "Match device" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        </Section>

        <Section title="About">
          <p className="small muted" style={{ margin: 0 }}>
            Catalog data from <a href="https://metron.cloud" target="_blank" rel="noopener noreferrer" style={{ color: "var(--cyan-ink)" }}>Metron</a> and{" "}
            <a href="https://comicvine.gamespot.com" target="_blank" rel="noopener noreferrer" style={{ color: "var(--cyan-ink)" }}>Comic Vine</a>.
            ComixCenter reads comics you own; for everything else it points you to legal services.
          </p>
        </Section>
      </div>
    </>
  );
}
