# ComixCenter

Reading orders, story arcs, characters and teams across comics universes, plus a reader for the
comics you own. Catalog data comes from [Metron](https://metron.cloud) and
[Comic Vine](https://comicvine.gamespot.com/api/); comics you don't own link to legal services.

```
backend/comix/     FastAPI app, SQLite (+ FTS5 search), Metron/Comic Vine sync workers, library + reader API
backend/migrations Alembic migrations
backend/tests/     pytest suite (offline; Metron and Comic Vine are faked)
web/               Next.js app (static export): PWA in the browser, Android app via Capacitor
scripts/           icon generator and old source probes
backend/app/       legacy scraper code from the first prototype (not used by the app)
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

The app talks to your ComixCenter server. On the emulator the default address `http://10.0.2.2:8000`
reaches your computer; on a phone, set your computer's network address in Settings and start the
server with `python -m comix serve --host 0.0.0.0`.

## Tests

```bash
cd backend && python -m pytest
```
