"use client";
import { useEffect, useState } from "react";
import { PageHead, Section, Segmented, useToast } from "@/components/ui";
import { adminToken, api, dataMode, defaultServer, refresh, serverUrl, setAdminToken, setDataMode, setServerUrl, type DataMode } from "@/lib/api";
import { isNativeApp } from "@/lib/native";
import { applyTheme, THEME_KEY, type Theme } from "@/lib/theme";
import type { Status } from "@/lib/types";

interface Creds { metron_token: string | null; metron_username: string | null; metron_password: string | null; comicvine_key: string | null;
  gcd_username: string | null; gcd_password: string | null; metron: boolean; comicvine: boolean; gcd_account: boolean }

export default function SettingsPage() {
  const toast = useToast();
  const [mode, setMode] = useState<DataMode>("server");
  const [server, setServer] = useState("");
  const [token, setToken] = useState("");
  const [theme, setTheme] = useState<Theme>("system");
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [lan, setLan] = useState<string[]>([]);
  const [native, setNative] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    const isNative = isNativeApp();
    setNative(isNative);
    setMode(dataMode());
    if (isNative) import("@capacitor/app").then(({ App }) => App.getInfo()).then((i) => setAppVersion(`${i.version} (${i.build})`)).catch(() => {});
    else if (dataMode() === "server") api.get<Status>("/api/status").then((s) => setLan(s.lan_urls ?? [])).catch(() => {});
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
        {mode === "device" ? <DataSources /> : (
          <Section title="Server">
            <form className="stack" onSubmit={(e) => { e.preventDefault(); setServerUrl(server === defaultServer() ? null : server); toast("Server address saved"); testServer(); }}>
              <label className="label">ComixCenter server address
                <input className="input" type="url" value={server} onChange={(e) => setServer(e.target.value)} placeholder={defaultServer()} />
              </label>
              <span className="small muted">On a phone, use your computer&rsquo;s network address, e.g. http://192.168.1.20:8000.</span>
              <div className="row">
                <button className="btn">Save and test</button>
                <button type="button" className="btn secondary" onClick={() => { setServerUrl(null); setServer(defaultServer()); toast("Reset to default"); testServer(); }}>Use default</button>
              </div>
              {check && <div className={`notice ${check.ok ? "" : "error"}`} role="status">{check.text}</div>}
            </form>
          </Section>
        )}

        {!native && mode === "server" && (
          <Section title="Connect your phone">
            <p className="small" style={{ margin: 0 }}>
              The Android app works on its own. To have it use this server&rsquo;s catalog instead, start the server with <code>start-server.bat</code>
              and enter one of these addresses in the app (Settings &gt; Where your catalog lives &gt; ComixCenter server).
            </p>
            {lan.length > 0
              ? <ul className="stack" style={{ margin: 0, paddingLeft: 18, gap: 4 }}>{lan.map((u) => <li key={u}><code>{u}</code></li>)}</ul>
              : <p className="small muted" style={{ margin: 0 }}>No network address found. Is this computer connected to Wi-Fi or Ethernet?</p>}
          </Section>
        )}

        {mode === "server" && (
          <Section title="Curation access">
            <form className="stack" onSubmit={(e) => { e.preventDefault(); setAdminToken(token.trim() || null); toast(token.trim() ? "Admin token saved" : "Admin token removed"); }}>
              <label className="label">Admin token
                <input className="input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Only needed if ADMIN_TOKEN is set on the server" />
              </label>
              <div><button className="btn secondary">Save token</button></div>
            </form>
          </Section>
        )}

        {mode === "device" && <Section title="Batcave browser connection"><form className="stack" onSubmit={(e) => { e.preventDefault(); setServerUrl(server); toast("Batcave connection saved"); }}><p className="small muted">Batcave may require a normal browser session. Run ComixCenter on your computer and enter its address here. Your catalog stays on this device; protected reading requests use the computer’s browser.</p><label className="label">Computer address<input className="input" type="url" required value={server} onChange={(e) => setServer(e.target.value)} placeholder="http://192.168.1.20:8000" /></label><div><button className="btn secondary">Save connection</button></div></form></Section>}

        <Section title="Appearance">
          <Segmented label="Theme" value={theme} onChange={(t) => {
            setTheme(t); applyTheme(t);
            try { if (t === "system") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, t); } catch { /* ignore */ }
          }} options={[{ value: "system", label: "Match device" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        </Section>

        {native && (
          <Section title="Where your catalog lives">
            <Segmented label="Catalog location" value={mode} onChange={(m) => {
              setDataMode(m); setMode(m); refresh("/api/");
              toast(m === "device" ? "Using the catalog on this phone" : "Using a ComixCenter server");
            }} options={[{ value: "device", label: "On this phone" }, { value: "server", label: "ComixCenter server" }]} />
            <p className="small muted" style={{ margin: 0 }}>
              On this phone, the app talks to the comic databases directly and keeps everything here, offline included.
              Choose a server only if you run ComixCenter on a computer and want to share its catalog.
            </p>
          </Section>
        )}

        <Section title="About">
          <p className="small muted" style={{ margin: 0 }}>
            Catalog data from the <a href="https://www.comics.org" target="_blank" rel="noopener noreferrer" style={{ color: "var(--cyan-ink)" }}>Grand Comics Database</a> (CC BY-SA 4.0),{" "}
            <a href="https://metron.cloud" target="_blank" rel="noopener noreferrer" style={{ color: "var(--cyan-ink)" }}>Metron</a> and{" "}
            <a href="https://comicvine.gamespot.com" target="_blank" rel="noopener noreferrer" style={{ color: "var(--cyan-ink)" }}>Comic Vine</a>.
            Read imported comics offline, or browse and read supported online sources inside ComixCenter.
          </p>
          {appVersion && <p className="mono" style={{ margin: 0 }}>App version {appVersion}</p>}
        </Section>
      </div>
    </>
  );
}

/** Accounts for the comic databases, stored only on this phone. */
function DataSources() {
  const toast = useToast();
  const [creds, setCreds] = useState<Creds | null>(null);
  const [form, setForm] = useState({ metron_token: "", metron_username: "", metron_password: "", comicvine_key: "", gcd_username: "", gcd_password: "" });
  const [useToken, setUseToken] = useState(false);
  const [tests, setTests] = useState<Record<string, { ok: boolean; detail: string } | "running">>({});
  const load = () => api.get<Creds>("/api/device/credentials").then((c) => {
    setCreds(c);
    setUseToken(!!c.metron_token);
    setForm((f) => ({ ...f, metron_username: c.metron_username ?? "", gcd_username: c.gcd_username ?? "" }));
  });
  useEffect(() => { load().catch(() => {}); }, []);

  const test = async (source: string) => {
    setTests((t) => ({ ...t, [source]: "running" }));
    const r = await api.post<{ ok: boolean; detail: string }>("/api/device/test", { source }).catch((e) => ({ ok: false, detail: (e as Error).message }));
    setTests((t) => ({ ...t, [source]: r }));
  };
  const save = async (patch: Record<string, string | null>, source: string) => {
    await api.put("/api/device/credentials", patch);
    toast("Saved on this phone");
    setForm({ metron_token: "", metron_username: patch.metron_username ?? form.metron_username, metron_password: "", comicvine_key: "",
      gcd_username: patch.gcd_username ?? form.gcd_username, gcd_password: "" });
    await load();
    refresh("/api/status");
    test(source);
  };
  const result = (source: string) => {
    const t = tests[source];
    if (!t) return null;
    if (t === "running") return <span className="small muted">Checking…</span>;
    return <div className={`notice ${t.ok ? "" : "error"}`} role="status" style={{ padding: "8px 12px" }}><span className="small">{t.ok ? "Connected. " : ""}{t.detail}</span></div>;
  };

  return (
    <Section title="Comic databases">
      <form className="card flat stack" onSubmit={(e) => {
        e.preventDefault();
        save({ gcd_username: form.gcd_username || null, ...(form.gcd_password ? { gcd_password: form.gcd_password } : {}),
          ...(form.gcd_username ? {} : { gcd_password: null }) }, "gcd");
      }}>
        <div className="between">
          <strong className="h3">Grand Comics Database</strong>
          <span className="tier tier-recommended">{creds?.gcd_account ? "Signed in" : "Always on"}</span>
        </div>
        <span className="small muted">
          Every publisher worldwide: series, issues, covers, credits, stories and characters. Works without an account,
          but GCD limits anonymous use to a few dozen requests an hour. A free comics.org account gets its own, higher limit.
        </span>
        <label className="label">comics.org username (optional)
          <input className="input" autoComplete="username" value={form.gcd_username} onChange={(e) => setForm({ ...form, gcd_username: e.target.value })} />
        </label>
        <label className="label">Password
          <input className="input" type="password" autoComplete="current-password" value={form.gcd_password} onChange={(e) => setForm({ ...form, gcd_password: e.target.value })}
            placeholder={creds?.gcd_password ? "Saved — type to replace" : ""} />
        </label>
        <div className="row">
          <button className="btn small">Save</button>
          <button type="button" className="btn small secondary" onClick={() => test("gcd")}>Test connection</button>
        </div>
        {result("gcd")}
      </form>

      <form className="card flat stack" onSubmit={(e) => {
        e.preventDefault();
        save(useToken ? { metron_token: form.metron_token || null, metron_username: null, metron_password: null }
          : { metron_token: null, metron_username: form.metron_username || null, ...(form.metron_password ? { metron_password: form.metron_password } : {}) }, "metron");
      }}>
        <div className="between">
          <strong className="h3">Metron</strong>
          <span className={`tier ${creds?.metron ? "tier-recommended" : "tier-skip"}`}>{creds?.metron ? "Connected" : "Not set up"}</span>
        </div>
        <span className="small muted">Story arcs, events, characters, teams, universes and community reading lists. Free account at metron.cloud.</span>
        <Segmented label="Sign-in method" value={useToken ? "token" : "password"} onChange={(v) => setUseToken(v === "token")}
          options={[{ value: "password", label: "Username & password" }, { value: "token", label: "API token" }]} />
        {useToken ? (
          <label className="label">API token
            <input className="input" type="password" autoComplete="off" value={form.metron_token} onChange={(e) => setForm({ ...form, metron_token: e.target.value })}
              placeholder={creds?.metron_token ? `Saved (${creds.metron_token})` : "Paste your Metron API token"} />
          </label>
        ) : (
          <>
            <label className="label">Username
              <input className="input" autoComplete="username" value={form.metron_username} onChange={(e) => setForm({ ...form, metron_username: e.target.value })} />
            </label>
            <label className="label">Password
              <input className="input" type="password" autoComplete="current-password" value={form.metron_password} onChange={(e) => setForm({ ...form, metron_password: e.target.value })}
                placeholder={creds?.metron_password ? "Saved — type to replace" : ""} />
            </label>
          </>
        )}
        <div className="row">
          <button className="btn small">Save</button>
          {creds?.metron && <button type="button" className="btn small secondary" onClick={() => test("metron")}>Test connection</button>}
          {creds?.metron && <button type="button" className="btn ghost small" onClick={() => save({ metron_token: null, metron_username: null, metron_password: null }, "metron")}>Remove</button>}
        </div>
        {result("metron")}
      </form>

      <form className="card flat stack" onSubmit={(e) => { e.preventDefault(); save({ comicvine_key: form.comicvine_key || null }, "comicvine"); }}>
        <div className="between">
          <strong className="h3">Comic Vine</strong>
          <span className={`tier ${creds?.comicvine ? "tier-recommended" : "tier-skip"}`}>{creds?.comicvine ? "Connected" : "Not set up"}</span>
        </div>
        <span className="small muted">First appearances, deaths, real names and team rosters. Free API key at comicvine.gamespot.com/api.</span>
        <label className="label">API key
          <input className="input" type="password" autoComplete="off" value={form.comicvine_key} onChange={(e) => setForm({ ...form, comicvine_key: e.target.value })}
            placeholder={creds?.comicvine_key ? `Saved (${creds.comicvine_key})` : "Paste your Comic Vine API key"} />
        </label>
        <div className="row">
          <button className="btn small">Save</button>
          {creds?.comicvine && <button type="button" className="btn small secondary" onClick={() => test("comicvine")}>Test connection</button>}
          {creds?.comicvine && <button type="button" className="btn ghost small" onClick={() => save({ comicvine_key: null }, "comicvine")}>Remove</button>}
        </div>
        {result("comicvine")}
      </form>
      <p className="small muted" style={{ margin: 0 }}>Your accounts are stored only on this phone and sent only to their own service.</p>
    </Section>
  );
}
