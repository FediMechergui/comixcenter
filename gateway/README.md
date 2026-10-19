# ComixCenter hosted source gateway

Deploy as a **FastAPI** project with Vercel's Root Directory set to `gateway`.
Run `vercel --prod` from the repository root; `.vercelignore` uploads only gateway source.
The Android catalog and imported files stay on the phone. No SQLite database, background
worker, desktop Chrome profile, passwords or comic archives are deployed with this service.

Requests are bounded by upstream timeouts and response-size limits. Catalog responses can
be cached at the CDN. Only named sources, fixed metadata origins and recognized image paths
are accepted; this is not a general URL proxy. Automatic discovery tries Batcave and GetComics
concurrently. A hosted IP may still be blocked by a source; the service reports that failure
instead of claiming verification was bypassed.

Optional Vercel server environment variables: `METRON_API_TOKEN`, or `METRON_USERNAME` and
`METRON_PASSWORD`, and `COMICVINE_API_KEY`. These belong in Vercel's encrypted environment
settings. They are never returned by `/api/status` and never bundled with the Android app.
The metadata proxy is read-only. Configure provider quota monitoring and deployment access
controls before opening a shared credential-backed gateway to a broad audience.

Set the phone build's `NEXT_PUBLIC_GATEWAY_URL` to the deployed HTTPS origin. This URL is public
configuration, not a credential. A saved gateway setting can override it on the phone.

Run tests with `python -m pytest gateway/tests -q` from the repository root.
