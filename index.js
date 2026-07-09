// Comic reader plugin for BackIssue — a full in-browser reader (paged +
// double-spread + webtoon modes, RTL, zoom, bookmarks, progress/resume,
// next-issue chaining) served straight from the library's CBZ/CBR files.
// Not a download source: routes + client UI only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import config from '../../src/config.js';
import { listPages, pageBufferResized } from './pages.js';
import { roleGrants, CORE_PERMISSIONS } from '../../src/users.js';
import { registeredPermissions } from '../../src/plugins.js';
import { openReaderStore } from './store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export default function register(api) {
  api.registerClientAsset({ js: 'client/reader.js', css: 'client/reader.css' });

  // Expose reading as a grantable permission (cores with granular roles let
  // admins include/exclude it per role). On older cores the API is absent —
  // fall back to the viewer tier, which is what this always was.
  const CAN_READ = api.registerPermission ? 'reader.read' : 'viewer';
  api.registerPermission?.({
    key: 'reader.read',
    label: 'Read comics',
    description: 'Open comics in the browser reader and keep reading history',
    tier: 'viewer',
  });

  // Issue covers on the volume grid: prefer the file's own first page (default)
  // or ComicVine art. Registered so the value validates + persists; the default
  // is ON, set before core merges saved settings, so a saved 'false' wins.
  api.registerSettings?.({ readerFileCovers: { type: 'bool' } });
  if (config.readerFileCovers === undefined) config.readerFileCovers = true;

  const store = openReaderStore(config.dbPath);
  // Read history is PER USER: core's auth middleware stamps req.user; the
  // open-mode (no accounts) install reads as user 0.
  const uid = (req) => req.user?.id ?? 0;
  // Read-only view of the core catalog (issue → file, series order).
  const cat = new Database(config.dbPath, { readonly: true });

  // Mature/restricted enforcement: a role without library.restricted cannot
  // open a restricted series' issues. Same permission engine core uses.
  const permCatalog = new Map([...CORE_PERMISSIONS, ...registeredPermissions()].map((p) => [p.key, p]));
  const canRestricted = (req) => {
    if (!req.user || req.user.id === 0) return true; // open mode
    try { return roleGrants(cat, req.user.role, 'library.restricted', permCatalog); } catch { return false; }
  };
  // Is this issue's series flagged restricted?
  const issueRestricted = (cvId) => {
    try {
      const r = cat.prepare(`SELECT s.restricted FROM cv_issues ci
        JOIN series s ON s.cv_id = ci.cv_series_id WHERE ci.comicvine_id = ? AND s.restricted = 1 LIMIT 1`).get(cvId);
      return !!r;
    } catch { return false; }
  };
  const blockedRestricted = (req, cvId) => !canRestricted(req) && issueRestricted(cvId);

  // The reader keys everything on the ComicVine issue id: scanned-from-disk
  // issues have no local `issues` row (that's a download-queue artifact —
  // db.js maps them `id: null`), but every owned+matched issue has a valid
  // library_files row carrying cv_issue_id. Best file = tagged copies first.
  const issueRow = (cvId) => cat.prepare(`
    SELECT ci.comicvine_id AS id, ci.name AS title, ci.issue_number, ci.cv_series_id,
           (SELECT lf.path FROM library_files lf
             WHERE lf.cv_issue_id = ci.comicvine_id AND lf.valid = 1
             ORDER BY lf.has_metadata DESC, lf.path LIMIT 1) AS file_path,
           (SELECT lf.series_id FROM library_files lf
             WHERE lf.cv_issue_id = ci.comicvine_id AND lf.valid = 1 AND lf.series_id IS NOT NULL
             LIMIT 1) AS series_id,
           cs.name AS series_title
      FROM cv_issues ci LEFT JOIN cv_series cs ON cs.comicvine_id = ci.cv_series_id
     WHERE ci.comicvine_id = ?`).get(cvId);

  // CV metadata for the in-reader info overlay.
  function issueInfo(cvId) {
    const row = cat.prepare(
      'SELECT name, description, credits, cover_date, store_date, site_detail_url FROM cv_issues WHERE comicvine_id = ?',
    ).get(cvId);
    if (!row) return null;
    let credits = [];
    try { credits = JSON.parse(row.credits || '[]'); } catch { /* untagged */ }
    return { name: row.name, description: row.description, credits, cover_date: row.cover_date, store_date: row.store_date, site_detail_url: row.site_detail_url };
  }

  // Natural-ish issue ordering for prev/next: numeric when possible ('½'→0.5),
  // name-compare fallback. Only issues with files count (they're readable).
  const numVal = (n) => {
    const s = String(n ?? '').trim();
    if (s === '½') return 0.5;
    const f = parseFloat(s.replace(',', '.'));
    return Number.isFinite(f) ? f : null;
  };
  function neighbors(issue) {
    const rows = cat.prepare(`
      SELECT ci.comicvine_id AS id, ci.issue_number FROM cv_issues ci
       WHERE ci.cv_series_id = ? AND EXISTS
         (SELECT 1 FROM library_files lf WHERE lf.cv_issue_id = ci.comicvine_id AND lf.valid = 1)
    `).all(issue.cv_series_id);
    rows.sort((a, b) => {
      const av = numVal(a.issue_number), bv = numVal(b.issue_number);
      if (av != null && bv != null) return av - bv;
      return String(a.issue_number).localeCompare(String(b.issue_number), undefined, { numeric: true });
    });
    const idx = rows.findIndex((r) => r.id === issue.id);
    return {
      prev: idx > 0 ? rows[idx - 1].id : null,
      next: idx >= 0 && idx < rows.length - 1 ? rows[idx + 1].id : null,
    };
  }

  // GET /api/reader/issue/:id — everything the reader needs to open.
  api.registerRoute('get', '/api/reader/issue/:id', async (req, res) => {
    try {
      if (blockedRestricted(req, Number(req.params.id))) return res.status(404).json({ error: 'no file for this issue' });
      const issue = issueRow(Number(req.params.id));
      if (!issue || !issue.file_path) return res.status(404).json({ error: 'no file for this issue' });
      const pages = await listPages(issue.file_path);
      const { prev, next } = neighbors(issue);
      res.json({
        issue: { id: issue.id, number: issue.issue_number, title: issue.title },
        series: { id: issue.series_id, title: issue.series_title },
        pages: pages.length,
        prev, next,
        progress: store.progress(uid(req), issue.id),
        bookmarks: store.bookmarks(uid(req), issue.id),
        later: store.isLater(uid(req), issue.id),
        prefs: issue.series_id ? store.seriesPrefs(uid(req), issue.series_id) : null, // saves the client a roundtrip
        info: issueInfo(issue.id),                                                    // credits/description overlay
      });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  }, { access: CAN_READ });

  // GET /api/reader/issue/:id/page/:n[?w=N&trim=1] — the page image. w =
  // server-side downscale (thumbnails w=200, data-saver pages w=1200); trim
  // shaves white scan borders. Processed variants transcode to WebP when the
  // browser advertises it (~half the JPEG bytes), hence Vary: Accept.
  api.registerRoute('get', '/api/reader/issue/:id/page/:n', async (req, res) => {
    try {
      if (blockedRestricted(req, Number(req.params.id))) return res.status(404).end();
      const issue = issueRow(Number(req.params.id));
      if (!issue || !issue.file_path) return res.status(404).end();
      const n = Number(req.params.n) | 0;
      const w = Number(req.query.w) | 0;
      const trim = req.query.trim === '1';
      const webp = (w || trim) && /image\/webp/.test(req.headers.accept || '');
      const etag = `"r${issue.id}-${n}-${w}-${trim ? 1 : 0}-${webp ? 1 : 0}"`;
      res.set('Vary', 'Accept');
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      const { buffer, contentType } = await pageBufferResized(issue.file_path, n, w, { webp, trim });
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'private, max-age=86400');
      res.set('ETag', etag);
      res.send(buffer);
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  }, { access: CAN_READ });

  // POST /api/reader/issue/:id/progress { page, pages, completed }
  // History writes ride the same reader.read permission as reading itself —
  // never the plugin-route POST default (library management).
  api.registerRoute('post', '/api/reader/issue/:id/progress', (req, res) => {
    store.saveProgress(uid(req), Number(req.params.id), req.body || {});
    res.json({ ok: true });
  }, { access: CAN_READ });

  // POST /api/reader/issue/:id/mark { read } — manual read/unread toggle.
  // Bypasses the completed latch (that's the point of a manual override).
  api.registerRoute('post', '/api/reader/issue/:id/mark', (req, res) => {
    store.setRead(uid(req), Number(req.params.id), !!(req.body || {}).read);
    res.json({ ok: true });
  }, { access: CAN_READ });

  // POST /api/reader/issue/:id/bookmark { page, on }
  api.registerRoute('post', '/api/reader/issue/:id/bookmark', (req, res) => {
    const { page, on } = req.body || {};
    store.setBookmark(uid(req), Number(req.params.id), page, !!on);
    res.json({ bookmarks: store.bookmarks(uid(req), Number(req.params.id)) });
  }, { access: CAN_READ });

  // Drop items whose series is restricted when the role can't see it (these
  // panels show titles directly, so filter even though opening is blocked).
  const hideRestricted = (req, items) =>
    canRestricted(req) ? items : items.filter((it) => !issueRestricted(it.issue_id));

  // GET /api/reader/continue — recent unfinished reads.
  api.registerRoute('get', '/api/reader/continue', (req, res) => {
    res.json({ items: hideRestricted(req, store.continueList(uid(req), 10)) });
  }, { access: CAN_READ });

  // GET /api/reader/prefs — client-visible reader preferences. Gated by the
  // reader permission on purpose: a role that can't open files gets ComicVine
  // art on the grid instead of file-cover URLs it couldn't load anyway.
  api.registerRoute('get', '/api/reader/prefs', (req, res) => {
    res.json({ fileCovers: config.readerFileCovers !== false });
  }, { access: CAN_READ });

  // GET /api/reader/next-up — the next unread issue in each series you're into.
  api.registerRoute('get', '/api/reader/next-up', (req, res) => {
    res.json({ items: hideRestricted(req, store.nextUpList(uid(req), 12)) });
  }, { access: CAN_READ });

  // GET /api/reader/new-in-library — recently added, still-unread issues.
  api.registerRoute('get', '/api/reader/new-in-library', (req, res) => {
    res.json({ items: hideRestricted(req, store.newInLibrary(uid(req), 12)) });
  }, { access: CAN_READ });

  // GET /api/reader/recently-finished — issues you just finished.
  api.registerRoute('get', '/api/reader/recently-finished', (req, res) => {
    res.json({ items: hideRestricted(req, store.recentlyFinished(uid(req), 12)) });
  }, { access: CAN_READ });

  // GET /api/reader/start-new — first issue of owned series you've never opened.
  api.registerRoute('get', '/api/reader/start-new', (req, res) => {
    res.json({ items: hideRestricted(req, store.startNewSeries(uid(req), 12)) });
  }, { access: CAN_READ });

  // GET/POST /api/reader/home-prefs — per-user visibility of the home shelves.
  api.registerRoute('get', '/api/reader/home-prefs', (req, res) => {
    res.json(store.homePrefs(uid(req)));
  }, { access: CAN_READ });
  api.registerRoute('post', '/api/reader/home-prefs', (req, res) => {
    res.json(store.setHomePrefs(uid(req), req.body || {}));
  }, { access: CAN_READ });

  // GET /api/reader/bookmarks — every bookmark this user has, library-wide.
  api.registerRoute('get', '/api/reader/bookmarks', (req, res) => {
    res.json({ items: hideRestricted(req, store.allBookmarks(uid(req))) });
  }, { access: CAN_READ });

  // Read-later shelf: list, and toggle for one issue.
  api.registerRoute('get', '/api/reader/later', (req, res) => {
    res.json({ items: hideRestricted(req, store.laterList(uid(req))) });
  }, { access: CAN_READ });
  api.registerRoute('post', '/api/reader/later/:id', (req, res) => {
    res.json({ later: store.setLater(uid(req), Number(req.params.id), !!(req.body || {}).on) });
  }, { access: CAN_READ });

  // GET /api/reader/stats — the signed-in user's reading stats (totals,
  // 30-day activity, streak, most-finished series) for the stats panel.
  api.registerRoute('get', '/api/reader/stats', (req, res) => {
    res.json(store.stats(uid(req)));
  }, { access: CAN_READ });

  // GET /api/reader/state — every issue's read-state (drives ▶/◐/✓ row badges;
  // the whole table is tiny — one row per issue ever opened).
  api.registerRoute('get', '/api/reader/state', (req, res) => {
    res.json({ states: store.allStates(uid(req)) });
  }, { access: CAN_READ });

  // GET/POST /api/reader/series/:id/prefs — per-series reading profile, so a
  // manga series remembers RTL+webtoon while US books stay single/LTR.
  api.registerRoute('get', '/api/reader/series/:id/prefs', (req, res) => {
    res.json({ prefs: store.seriesPrefs(uid(req), Number(req.params.id)) });
  }, { access: CAN_READ });
  api.registerRoute('post', '/api/reader/series/:id/prefs', (req, res) => {
    store.saveSeriesPrefs(uid(req), Number(req.params.id), req.body || {});
    res.json({ ok: true });
  }, { access: CAN_READ });

  // GET /reader-sw.js — the offline service worker. Served from the root path
  // with Service-Worker-Allowed so its scope can cover /api/reader/* (a script
  // under /plugins/... could only control its own subtree).
  api.registerRoute('get', '/reader-sw.js', (req, res) => {
    res.set('Content-Type', 'application/javascript');
    res.set('Service-Worker-Allowed', '/');
    res.set('Cache-Control', 'no-cache');
    res.send(fs.readFileSync(path.join(HERE, 'client', 'sw.js'), 'utf8'));
  });

  // GET /reader-manifest.json + /reader-icon.svg — web-app manifest so the app
  // is installable on a tablet/phone home screen (fullscreen, no browser
  // chrome). The client injects <link rel="manifest"> pointing here.
  api.registerRoute('get', '/reader-manifest.json', (req, res) => {
    res.set('Content-Type', 'application/manifest+json');
    res.set('Cache-Control', 'no-cache');
    res.json({
      name: 'BackIssue', short_name: 'BackIssue',
      description: 'Comic collection manager and reader',
      start_url: '/', display: 'standalone',
      background_color: '#0b0b10', theme_color: '#0b0b10',
      icons: [{ src: '/reader-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
    });
  });
  api.registerRoute('get', '/reader-icon.svg', (req, res) => {
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
<rect width="96" height="96" rx="20" fill="#0b0b10"/>
<path d="M20 24c8-5 16-5 26 0v46c-10-5-18-5-26 0z" fill="#7aa2ff"/>
<path d="M76 24c-8-5-16-5-26 0v46c10-5 18-5 26 0z" fill="#4d6fd6"/>
<rect x="46" y="22" width="4" height="50" rx="2" fill="#0b0b10"/>
</svg>`);
  });
}
