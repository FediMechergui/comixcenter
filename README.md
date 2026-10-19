# ComixCenter

Reading orders, story arcs, characters and teams across comics universes, plus a reader for the
comics you import and supported online sources. Catalog data comes from Metron, Comic Vine and
the Grand Comics Database. Batcave is the primary online discovery and reading source.

The app includes 12 editorial reading guides with 66 reading stops: Marvel and DC mainlines,
both Ultimate continuities, Absolute DC, Batman, Superman, Krakoa, Invincible, Hellboy,
Energon and standalone stories. These guides work before any metadata sync. They are focused
starting paths, not an exhaustive issue-by-issue catalog of every universe.

Discover offers universe shortcuts, reading paths, recent reading sessions and Batcave search.
The online reader has page/scroll modes, chapter selection, keyboard controls, fullscreen,
next-issue navigation and device-local reading position. Character pages include optional
story milestones with spoiler controls.

On Android, **Open source reader in app** displays supported source websites in a separate
in-app browser. Verification and reading stay on the phone, with Close returning to ComixCenter.
A source may still reject embedded browsers. This mode does not send source cookies to Vercel.

## Hosted sources and Batcave connection

Android uses https://comixcenter-gateway.vercel.app for online discovery without a PC.
Automatic discovery selects a responding source, including GetComics. The gateway keeps metadata
credentials on the server. Protected sources may still reject cloud requests; the app shows
a bounded error with retry and source selection. See [gateway setup](gateway/README.md).

For the optional desktop Batcave browser session, run `start-server.bat` on a computer with Chrome or Edge installed. Open the server address
in a browser to use the full web app. Batcave's protected requests run through a dedicated
normal browser profile; metadata and covers are cached. Comics stay inside ComixCenter's
reader. If Batcave asks for a human verification, complete it in the source browser window
and retry. The app does not copy browser cookies into an unrelated HTTP client.

In the Android app, Settings > Batcave browser connection accepts the computer's LAN address
while keeping the catalog on the phone. An explicitly configured computer handles protected Batcave requests through its browser session. The computer must remain running for those
requests. GetComics discovery also works through the hosted gateway.

```
backend/comix/     FastAPI app, SQLite (+ FTS5 search), Metron/Comic Vine sync workers, library + reader API
backend/migrations Alembic migrations
backend/tests/     pytest suite (offline; Metron and Comic Vine are faked)
web/               Next.js app (static export): PWA in the browser, Android app via Capacitor
scripts/           icon generator and old source probes
backend/app/       source providers and Chrome session transport, also used by the feeds API
```

## Run it

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env          # add METRON_API_TOKEN (or username/password) and COMICVINE_API_KEY
python -m comix serve         # http://127.0.0.1:8000  (API docs at /docs)
```

The server migrates the database, seeds the universe/era taxonomy, and runs the sync worker.
Data lives in `%LOCALAPPDATA%\ComixCenter` (override with `COMIX_DATA_DIR`), outside OneDrive on purpose.

Add comics to the catalog from **Curate** in the app (search Metron, then Add), or from the command line:

```bash
python -m comix find-series "House of X" 2019
python -m comix sync arc 1234          # Metron arc id
python -m comix run-jobs               # process the queue without the server
python -m comix scan D:\Comics         # import comics you own, in place
```

## Web app

```bash
cd web
npm install
npm run dev        # http://localhost:3000, talks to the API on :8000
npm run build      # static export in web/out, which the API server also serves at /
```

## Android app

Needs the Android SDK and JDK 21 (Capacitor 8). Then:

```bash
cd web
npm run build && npx cap sync android
cd android && gradlew assembleDebug    # app/build/outputs/apk/debug/app-debug.apk
```

Android defaults to its own IndexedDB catalog and native file storage, seeded from the bundled
catalog snapshot. Browser mode defaults to the FastAPI server catalog. They are separate catalogs.
On the emulator, `http://10.0.2.2:8000` reaches your computer. A phone can use hosted discovery independently; a desktop browser connection is optional.

API accounts belong in Vercel server environment variables, the device's Settings or `backend/.env`. Distributed application builds
no longer embed `NEXT_PUBLIC_*` account credentials. The snapshot builder can still read the
local credential file, but exports catalog tables only. When `ADMIN_TOKEN` is configured,
library uploads, scans, edits, deletion and OPDS changes also require that token.

## Tests

```bash
cd backend && python -m pytest
cd web && npm test
cd web && npm run typecheck
cd web && npm run build
```
