// Bump this on any deploy that changes the files below. A new sw.js is what
// tells open copies of the app that an update is ready. CI checks the bump.
const CACHE_NAME = "duit-bijak-v25";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./accounts.js",
  "./pdf-import.js",
  "./gemini-parse.js",
  "./categorise.js",
  "./statements.js",
  "./rules.js",
  "./backup.js",
  "./icons/icon-192-v3.png",
  "./icons/icon-512-v3.png",
  "./icons/icon-maskable-512-v3.png",
  "./icons/apple-touch-icon-v3.png",
  "./icons/favicon-v3.svg",
];

// pdf.js is ~1.8MB and only needed for PDF import, so it isn't precached.
// It's cached the first time it's used, in a cache named for its version,
// so app deploys (which wipe CACHE_NAME) don't make it download again.
const PDFJS_CACHE = "duit-bijak-pdfjs-4.10.38";
const PDFJS_PATH = "/vendor/pdfjs-4.10.38/";

// cache: "reload" skips the browser's HTTP cache. GitHub Pages sends
// max-age=600, so without it a new worker could cache the old files.
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL.map(u => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(n => n !== CACHE_NAME && n !== PDFJS_CACHE).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Network-first for same-origin GETs, so a deploy lands on the next load.
// Falls back to the cached shell when offline. Cross-origin (fonts) is untouched.
self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // Versioned path, so the cached copy never goes stale: cache first.
  if (url.pathname.includes(PDFJS_PATH)) {
    event.respondWith(
      caches.open(PDFJS_CACHE).then(cache => cache.match(req).then(hit => hit || fetch(req).then(response => {
        if (response.ok) cache.put(req, response.clone());
        return response;
      })))
    );
    return;
  }

  event.respondWith(
    fetch(req, { cache: "no-cache" })
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        }
        return response;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("./index.html")))
  );
});
