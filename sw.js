// App-shell caching, network-first (not cache-first). This app is under
// active development -- cache-first meant a code update could deploy to
// the server but never actually reach an already-installed phone, since
// browsers only detect a new service worker by byte-diffing sw.js itself,
// and a change to app.js alone doesn't touch this file. Confirmed this
// happened for real: a bug fix shipped, but a phone kept running the old
// buggy app.js indefinitely because the cache was never invalidated.
//
// Network-first still gives the offline-shell guarantee that matters (the
// UI itself must load with zero connectivity so there's something to
// queue an entry in) -- it just tries the network first and only falls
// back to cache on failure, instead of the reverse.

const CACHE_NAME = "lifelog-shell-v2";
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
  if (url.origin !== location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
