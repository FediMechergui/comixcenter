// ComixCenter service worker: keeps the app shell available offline.
// Comic pages saved for offline live in their own cache (comix-offline-v1), managed by the reader.
const SHELL = "comix-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/manifest.webmanifest"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("comix-shell-") && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/_next/static/")) {
    // Hashed build assets never change: cache first
    event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request).then((resp) => {
      const copy = resp.clone();
      caches.open(SHELL).then((c) => c.put(event.request, copy));
      return resp;
    })));
    return;
  }
  // Pages: network first, falling back to the cached copy (or the home shell) offline
  event.respondWith(fetch(event.request).then((resp) => {
    const copy = resp.clone();
    caches.open(SHELL).then((c) => c.put(event.request, copy));
    return resp;
  }).catch(() => caches.match(event.request).then((hit) => hit || caches.match("/"))));
});
