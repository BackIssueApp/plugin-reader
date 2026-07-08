// Reader offline service worker. Two jobs:
//  1. Serve /api/reader/* from the offline cache when present (cache-first for
//     pages — they're immutable; network-first for manifests so progress and
//     prev/next stay fresh, falling back to cache offline).
//  2. On message {type:'cache-issue'}, download every page of an issue into
//     the cache ("Download for offline"); {type:'uncache-issue'} evicts it.
const CACHE = 'reader-offline-v1';

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const isPage = (url) => /\/api\/reader\/issue\/\d+\/page\/\d+/.test(url);
const isManifest = (url) => /\/api\/reader\/issue\/\d+(\?|$)/.test(url);

self.addEventListener('fetch', (e) => {
  const url = e.request.url;
  if (isPage(url)) {
    // pages are immutable → cache-first; offline with a different quality
    // setting than at download time, any cached variant beats nothing.
    e.respondWith(
      caches.open(CACHE).then((c) =>
        c.match(e.request).then((hit) => hit
          || fetch(e.request).catch(() => c.match(e.request, { ignoreSearch: true }))),
      ),
    );
  } else if (isManifest(url)) {
    // manifests carry live progress → network-first, cache fallback offline
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.open(CACHE).then((c) => c.match(e.request))),
    );
  }
});

self.addEventListener('message', (e) => {
  const { type, issueId, pages, origin, suffix } = e.data || {};
  if (type === 'cache-issue') {
    e.waitUntil((async () => {
      const c = await caches.open(CACHE);
      // `suffix` = the device's page-URL params (data saver / trim) so the
      // cached entries match the exact URLs the reader will request.
      const urls = [`${origin}/api/reader/issue/${issueId}`];
      for (let n = 0; n < pages; n++) urls.push(`${origin}/api/reader/issue/${issueId}/page/${n}${suffix || ''}`);
      let done = 0;
      for (const u of urls) {
        try {
          if (!(await c.match(u))) await c.put(u, await fetch(u));
          done++;
          notify({ type: 'cache-progress', issueId, done, total: urls.length });
        } catch { /* page failed — partial cache still helps */ }
      }
      notify({ type: 'cache-done', issueId });
    })());
  } else if (type === 'uncache-issue') {
    e.waitUntil((async () => {
      const c = await caches.open(CACHE);
      for (const req of await c.keys()) {
        if (req.url.includes(`/api/reader/issue/${issueId}`)) await c.delete(req);
      }
      notify({ type: 'cache-done', issueId, removed: true });
    })());
  }
});

async function notify(msg) {
  for (const client of await self.clients.matchAll()) client.postMessage(msg);
}
