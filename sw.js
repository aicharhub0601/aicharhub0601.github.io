/*
 * AICharHub hand-rolled service worker.
 *
 * SCOPE: PWA install + STATIC shell precache ONLY.
 * Non-goals: offline-first dynamic caching, runtime caching of DB pages, push.
 *
 * Strategy:
 *   - install:  precache a small set of STATIC assets (icons, manifests, brand
 *               svgs, offline fallback document). Never precache [locale] DB
 *               pages or /api responses.
 *   - activate: skipWaiting + clients.claim, and delete any cache whose name
 *               does not match the current version (kills the stale-shell footgun).
 *   - fetch:    cache-first ONLY for the precached static shell/assets; every
 *               other request (navigations, /api, dynamic data) goes straight to
 *               the network with NO caching. If a navigation fails offline, fall
 *               back to the precached offline document.
 *
 * To ship a new shell, bump CACHE_VERSION. The activate handler purges the old
 * cache and skipWaiting/clients.claim swap the new worker in on next load.
 */

const CACHE_VERSION = "v2";
const CACHE_NAME = `aicharhub-shell-${CACHE_VERSION}`;

// STATIC assets only. These never change per-request and carry no DB content.
const PRECACHE_URLS = [
  "/offline.html",
  "/manifest.en.webmanifest",
  "/manifest.ko.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/file.svg",
  "/globe.svg",
  "/next.svg",
  "/vercel.svg",
  "/window.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // addAll() is atomic; if any asset 404s the whole install fails. Cache
      // each individually so a missing placeholder icon never blocks install.
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            const res = await fetch(url, { cache: "no-cache" });
            if (res.ok) await cache.put(url, res);
          } catch {
            /* asset not present yet (e.g. placeholder icon) — skip, don't fail */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("aicharhub-shell-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle GET; never touch POST/PUT/DELETE or cross-origin writes.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Same-origin only. Cross-origin (analytics, API host, CDNs) -> let it pass.
  if (url.origin !== self.location.origin) return;

  // Never cache or intercept API or auth traffic — always live network.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_next/data/")) {
    return;
  }

  // Navigations (DB-backed [locale] pages): network-first, NO caching of the
  // dynamic response. Fall back to the precached offline shell when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match("/offline.html")) ?? Response.error();
      }),
    );
    return;
  }

  // Static shell/assets: cache-first against the precache. Anything not in the
  // precache falls through to the network with no caching.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request, { ignoreSearch: false });
      if (cached) return cached;
      return fetch(request);
    })(),
  );
});

// Allow the page to trigger an immediate activation after an update.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
