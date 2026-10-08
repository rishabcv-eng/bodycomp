/* Service worker: makes the app open instantly and work with no signal.
 *
 * The caching is split the same way the loading is, and for the same reason.
 * Precaching everything would mean a 25 MB download on first visit - worse
 * than the problem the lazy loading just fixed - so only the shell is
 * precached, and the segmentation models are kept once they have been fetched
 * for a real reason.
 *
 *   shell    ~1 MB   html, css, js, the .bin models. Precached on install.
 *   heavy    ~24 MB  MediaPipe wasm and tflite. Cached on first real use.
 *
 * index.html is network-first so a deploy is picked up on the next online
 * visit; everything else is cache-first, because those URLs change content
 * only when the cache version changes.
 */

const VERSION = "v3";
const SHELL = `bodycomp-shell-${VERSION}`;
const HEAVY = `bodycomp-heavy-${VERSION}`;
const KEEP = new Set([SHELL, HEAVY]);

const SHELL_URLS = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./js/app.js",
  "./js/once.js",
  "./js/pipeline.js",
  "./js/trees.js",
  "./js/silhouette.js",
  "./js/mask.js",
  "./js/scan.js",
  "./js/overlay.js",
  "./js/plan.js",
  "./js/ui.js",
  "./js/progress.js",
  "./js/rank.js",
  "./js/goals.js",
  "./js/share.js",
  "./js/train.js",
  "./js/workouts.js",
  "./js/exercises.js",
  "./models/manifest.json",
  "./models/percentiles.json",
];

/** The big MediaPipe assets: kept once used, never downloaded speculatively. */
const isHeavy = url => /\/(mp|vendor)\/|\.(wasm|tflite|task)$/.test(url.pathname);

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Individually, not addAll: one 404 would otherwise abort the whole install
    // and leave the app with no offline support at all.
    await Promise.all(SHELL_URLS.map(u => cache.add(u).catch(() => {})));
    // The .bin models are listed in the manifest rather than here, so they
    // cannot drift out of sync with what the app actually loads.
    try {
      const manifest = await (await fetch("./models/manifest.json")).json();
      const files = [
        ...Object.values(manifest.stage1 || {}),
        ...Object.values(manifest.stage2 || {}).flatMap(i => [i.point, i.lo, i.hi]),
      ].filter(Boolean);
      await Promise.all(files.map(f => cache.add(`./models/${f}`).catch(() => {})));
    } catch { /* offline on first load - the runtime handler will fill these in */ }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (!KEEP.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

const putIfOk = async (cacheName, request, response) => {
  // Only cache a real, complete, same-origin answer. Caching an opaque or
  // partial response is how a service worker starts serving broken files.
  if (!response || response.status !== 200 || response.type === "opaque") return response;
  const cache = await caches.open(cacheName);
  cache.put(request, response.clone()).catch(() => {});
  return response;
};

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // fonts etc: leave to the browser

  // Navigations and the page itself: fresh when online, cached when not.
  if (request.mode === "navigate" || url.pathname.endsWith("/index.html")) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        return await putIfOk(SHELL, request, fresh);
      } catch {
        return (await caches.match(request))
            || (await caches.match("./index.html"))
            || Response.error();
      }
    })());
    return;
  }

  // The 25 MB of MediaPipe never changes under a given URL, so it is served
  // from the cache and never revalidated - that is the whole point of keeping it.
  if (isHeavy(url)) {
    event.respondWith((async () => {
      const hit = await caches.match(request);
      if (hit) return hit;
      try {
        return await putIfOk(HEAVY, request, await fetch(request));
      } catch {
        return Response.error();
      }
    })());
    return;
  }

  /* Everything else is stale-while-revalidate: answer from the cache at once,
   * then refresh it in the background for next time.
   *
   * Cache-first was the obvious choice and it was wrong. Scripts and the .bin
   * models keep their filenames across deploys, so a cache-first worker serves
   * last week's code until someone remembers to bump a version constant by
   * hand - which is a deploy bug waiting to happen, and did happen here during
   * testing: a stale exercises.js quietly undid a change I had just made. */
  event.respondWith((async () => {
    const hit = await caches.match(request);
    const network = fetch(request)
      .then(res => putIfOk(SHELL, request, res))
      .catch(() => null);
    return hit || (await network) || Response.error();
  })());
});

// Lets the page drop the 24 MB of models without clearing the whole app.
self.addEventListener("message", event => {
  if (event.data === "drop-heavy") event.waitUntil(caches.delete(HEAVY));
});
