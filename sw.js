// Minimal service worker: caches the app shell so the UI itself loads
// offline (essential -- without this, no connectivity means no app to even
// queue an entry in). Never caches API calls to Supabase; those always hit
// the network, and the app's own IndexedDB queue (in app.js) is what
// handles "no connectivity" for actual data, not this cache.

const CACHE_NAME = "lifelog-shell-v1";
const SHELL_FILES = ["./", "./index.html", "./app.js", "./manifest.json", "./icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Only handle same-origin shell files; everything else (Supabase API
  // calls, external resources) goes straight to the network untouched.
  if (url.origin !== location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return res;
      }).catch(() => cached);
    })
  );
});
