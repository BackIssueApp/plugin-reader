// Comic reader plugin for BackIssue — a full in-browser reader (paged +
// double-spread + webtoon modes, RTL, zoom, bookmarks, progress/resume,
// next-issue chaining) served straight from the library's CBZ/CBR files.
// Not a download source: routes + client UI only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import config from '../../src/config.js';
import { listPages, pageBuffer, pageBufferResized } from './pages.js';
import { detectPanels, orderPanels } from './panels.js';
import { createMlDetector } from './mlpanels.js';
import { createPanelCache, pageHash, pageDhash } from './panelcache.js';
import { ensurePanelModel } from './modeldl.js';
import { registerPanelsDbRoute } from './paneldb.js';
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

  // Hand-editing panel layouts changes what every reader of this server sees
  // for that file — a curation act, so it defaults to the admin tier (grant
  // it to trusted roles from Settings → Users).
  const CAN_EDIT_PANELS = api.registerPermission ? 'reader.panels.edit' : 'admin';
  api.registerPermission?.({
    key: 'reader.panels.edit',
    label: 'Edit panel layouts',
    description: 'Correct guided-view panel boxes; edits apply server-wide for the file',
    tier: 'admin',
  });

  // Issue covers on the volume grid: prefer the file's own first page (default)
  // or ComicVine art. Registered so the value validates + persists; the default
  // is ON, set before core merges saved settings, so a saved 'false' wins.
  api.registerSettings?.({ readerFileCovers: { type: 'bool' } });
  if (config.readerFileCovers === undefined) config.readerFileCovers = true;

  // Optional ML panel detector (see mlpanels.js). The model file is not
  // bundled — drop it at <data dir>/models/panels.onnx or point the
  // readerPanelModel setting at it. Absent model/runtime → classical
  // detector, and readerPanelMl=false forces classical even with a model
  // installed (config is live, so the settings toggle applies immediately).
  api.registerSettings?.({ readerPanelModel: { type: 'string' }, readerPanelMl: { type: 'bool' } });
  if (config.readerPanelMl === undefined) config.readerPanelMl = true;
  const defaultModelPath = path.join(path.dirname(config.dbPath || '.'), 'models', 'panels.onnx');
  const mlPanels = createMlDetector(config.readerPanelModel || defaultModelPath);
  const mlActive = async () => config.readerPanelMl !== false && (await mlPanels.available());
  mlPanels.available().then((ok) => {
    if (ok) console.log('reader: ML panel detection active');
  });

  // Shared panel-detection cache. When on, an issue's page layouts are
  // looked up in the community cache before detecting locally, and new
  // detections + human corrections are shared back — so a page detected or
  // fixed anywhere serves everyone. Only panel rectangles + a page-content
  // hash leave the server; never image data or filenames. Default ON (the
  // default set before core merges saved settings, so a saved 'false' wins);
  // the Settings → Library toggle opts out entirely.
  api.registerSettings?.({ readerPanelShare: { type: 'bool' } });
  if (config.readerPanelShare === undefined) config.readerPanelShare = true;

  const store = openReaderStore(config.dbPath);

  // Fetch the panel model from the CDN when it's missing (or upgrade one we
  // previously downloaded). Non-blocking: the reader serves classical
  // detection until the model lands; the detector re-checks per run, so no
  // restart is needed once it does.
  ensurePanelModel({
    modelPath: defaultModelPath,
    customPath: config.readerPanelModel || null,
    enabled: config.readerPanelMl !== false,
    store,
  }).then((got) => {
    if (got) mlPanels.available().then((ok) => { if (ok) console.log('reader: ML panel detection active (downloaded model)'); });
  });

  const panelCacheBase = String(config.cvBaseUrl || '').replace(/\/+$/, '') || 'https://data.backissue.app';
  const panelCache = createPanelCache({
    base: panelCacheBase,
    store,
    enabled: () => config.readerPanelShare === true,
  });
  // Engine tag stored with shared detections so newer models can supersede
  // older cache entries (mirrors the local |ml* cache-key suffix).
  const engineTag = async () => ((await mlActive()) ? 'ml-box-v2' : 'classical-v1'); // matches the |ml2 cache generation
  // Read history is PER USER: core's auth middleware stamps req.user; the
  // open-mode (no accounts) install reads as user 0.
  const uid = (req) => req.user?.id ?? 0;
  // Read-only view of the core catalog (issue → file, series order).
  const cat = new Database(config.dbPath, { readonly: true });

  // Reading prefs for a series. Manga reads right-to-left by default: with no
  // saved prefs, seed rtl from the core library type — a user's explicit
  // choice (any saved row) always wins, and saving works exactly as before.
  const prefsFor = (userId, seriesId) => {
    const saved = store.seriesPrefs(userId, seriesId);
    if (saved) return saved;
    try {
      const s = cat.prepare('SELECT type FROM series WHERE id = ?').get(seriesId);
      if (s?.type === 'manga') return { mode: null, rtl: 1, fit: null, split: 0, spread_offset: 0 };
    } catch { /* core predates series.type — no seed */ }
    return null;
  };

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
        prefs: issue.series_id ? prefsFor(uid(req), issue.series_id) : null, // saves the client a roundtrip
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

  // GET /api/reader/issue/:id/panels[?rtl=1] — detected panel rects per page,
  // in reading order, for guided (panel-by-panel) viewing. Detection is
  // classical CV (see panels.js), computed ONCE per issue in the background
  // and cached against the file (path|mtime|size — a re-download invalidates).
  // While computing: { pending: true } — clients poll or fall back to page
  // mode. Pages with no confident detection carry an empty panels array, and
  // clients show those as whole pages.
  const panelJobs = new Map(); // issueId → in-flight promise
  const panelProgress = new Map(); // issueId → { done, total } while detecting
  let panelQueue = Promise.resolve(); // one detection job at a time (CPU care)
  const fileKeyOf = (p) => {
    try { const st = fs.statSync(p); return `${p}|${Math.round(st.mtimeMs)}|${st.size}`; }
    catch { return null; }
  };
  async function computePanels(issueId, filePath, fileKey) {
    const names = await listPages(filePath);
    const total = names.length;
    panelProgress.set(issueId, { done: 0, total });
    const share = panelCache.enabled();
    // Human corrections outrank every detector: a recompute (engine upgrade,
    // cache miss) must never spend CPU re-detecting a page someone already
    // fixed by hand. Overrides are keyed to the raw file, not the engine.
    const override = store.panelsOverride(issueId, fileKeyOf(filePath)) || {};

    // Phase 1: hash every page (cheap) and batch-look-up the community cache,
    // so we only spend detection CPU on pages nobody has covered yet.
    const hashes = new Array(total).fill(null);
    let hits = new Map();
    if (share) {
      for (let i = 0; i < total; i++) {
        try { hashes[i] = pageHash((await pageBuffer(filePath, i)).buffer); } catch { /* unreadable */ }
      }
      hits = await panelCache.lookup(hashes.filter(Boolean));
    }

    // Phase 2: fill from the cache where we can, detect the rest.
    const { default: sharp } = share ? await import('sharp') : {};
    const engine = share ? await engineTag() : null;
    const pages = [];
    const submit = [];
    for (let i = 0; i < total; i++) {
      let panels = [];
      const hit = hashes[i] ? hits.get(hashes[i]) : null;
      const ov = override[String(i)];
      if (Array.isArray(ov)) {
        // Page already corrected by hand: the edit is the layout. Re-assert
        // it to the community cache too — edits made while sharing was off
        // (or lost server-side) get back-filled on the next recompute.
        panels = ov;
        if (share && hashes[i]) {
          try {
            const { buffer } = await pageBuffer(filePath, i);
            submit.push({ hash: hashes[i], dhash: await pageDhash(sharp, buffer), source: 'human', engine: 'human', panels: ov });
          } catch { /* sharing is best-effort */ }
        }
      } else if (hit && Array.isArray(hit.panels)) {
        panels = hit.panels;
      } else {
        try {
          const { buffer } = await pageBuffer(filePath, i);
          // ML first (null = ML unavailable, [] = a real page-mode verdict);
          // classical detector when there's no model to run or ML is off.
          const mlRects = (await mlActive()) ? await mlPanels.detect(buffer) : null;
          panels = mlRects ?? (await detectPanels(buffer));
          // Only ML layouts are worth sharing — the classical detector's
          // output is too weak for a communal pool (two classical instances
          // could corroborate a bad layout into being served everywhere).
          // Human edits still upload regardless of detector, elsewhere.
          if (share && hashes[i] && mlRects !== null) {
            submit.push({ hash: hashes[i], dhash: await pageDhash(sharp, buffer), source: 'model', engine, panels });
          }
        } catch { /* unreadable page → page mode */ }
      }
      pages.push({ page: i, panels });
      panelProgress.set(issueId, { done: i + 1, total });
    }
    store.savePanels(issueId, fileKey, pages);
    if (submit.length) panelCache.submit(submit); // best-effort contribution
    return pages;
  }

  // Vote on a page's served community layout (fire-and-forget).
  async function votePage(filePath, pageNo, dir) {
    if (!panelCache.enabled()) return;
    try {
      const { buffer } = await pageBuffer(filePath, pageNo);
      panelCache.vote(pageHash(buffer), dir);
    } catch { /* best-effort */ }
  }

  // Share a hand-corrected page to the community cache as a HUMAN layout (beats
  // any model consensus). Best-effort and fire-and-forget: hashing the page
  // must never block or fail the save that already succeeded.
  async function shareHumanEdit(filePath, pageNo, panels) {
    if (!panelCache.enabled()) return;
    try {
      const { buffer } = await pageBuffer(filePath, pageNo);
      const { default: sharp } = await import('sharp');
      panelCache.submit([{
        hash: pageHash(buffer),
        dhash: await pageDhash(sharp, buffer),
        source: 'human',
        engine: 'human',
        panels,
      }]);
    } catch { /* sharing is best-effort; the local override is already saved */ }
  }
  api.registerRoute('get', '/api/reader/issue/:id/panels', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (blockedRestricted(req, id)) return res.status(404).json({ error: 'no file for this issue' });
      const issue = issueRow(id);
      if (!issue || !issue.file_path) return res.status(404).json({ error: 'no file for this issue' });
      const rawKey = fileKeyOf(issue.file_path);
      if (!rawKey) return res.status(404).json({ error: 'file unreadable' });
      // The engine is part of the cache key: turning the ML model on (or off)
      // recomputes each issue once instead of serving the other engine's rects.
      let fileKey = rawKey;
      if (await mlActive()) fileKey += `|ml2:${await mlPanels.modelId()}`; // postprocess generation + model content id
      const rtl = req.query.rtl === '1';
      // Human corrections are keyed to the raw file (no engine suffix) and
      // replace the detector's layout for their pages. Their array order IS
      // the reading order — never re-sorted, so an editor's RTL fix sticks.
      const override = store.panelsOverride(id, rawKey) || {};
      const reviewedSet = new Set(store.reviewedPages(id, rawKey));
      const cached = store.panels(id, fileKey);
      if (cached) {
        return res.json({
          ready: true,
          rtl,
          pages: cached.map((p) => ({
            ...(override[String(p.page)]
              ? { page: p.page, panels: override[String(p.page)], edited: true }
              : { page: p.page, panels: orderPanels(p.panels || [], rtl) }),
            ...(reviewedSet.has(p.page) ? { reviewed: true } : {}),
          })),
        });
      }
      if (!panelJobs.has(id)) {
        const job = (panelQueue = panelQueue.then(() =>
          computePanels(id, issue.file_path, fileKey).catch((e) => {
            console.warn(`panel detection failed for issue ${id}:`, e?.message || e);
            // Cache an all-page-mode result so a broken file isn't retried forever.
            store.savePanels(id, fileKey, []);
          })
        )).finally(() => { panelJobs.delete(id); panelProgress.delete(id); });
        panelJobs.set(id, job);
      }
      // done/total appear once this issue's job actually starts (jobs run one
      // at a time) — before that, clients just know it's pending.
      res.json({ ready: false, pending: true, ...(panelProgress.get(id) || {}) });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  }, { access: CAN_READ });

  // Capability probe: 200 only for users allowed to edit layouts — the
  // client uses it to decide whether to show the editor button at all.
  api.registerRoute('get', '/api/reader/can-edit-panels', (req, res) => {
    res.json({ ok: true });
  }, { access: CAN_EDIT_PANELS });

  // PUT /api/reader/issue/:id/panels/page/:page  { panels: [{x,y,w,h,poly?}] }
  // Save a hand-edited layout for ONE page ([] = force page mode). Validated
  // hard — this JSON is served to every client that opens the issue.
  api.registerRoute('put', '/api/reader/issue/:id/panels/page/:page', (req, res) => {
    try {
      const id = Number(req.params.id);
      const pageNo = Number(req.params.page);
      if (!Number.isInteger(pageNo) || pageNo < 0) return res.status(400).json({ error: 'bad page' });
      const issue = issueRow(id);
      if (!issue || !issue.file_path) return res.status(404).json({ error: 'no file for this issue' });
      const rawKey = fileKeyOf(issue.file_path);
      if (!rawKey) return res.status(404).json({ error: 'file unreadable' });
      const panels = sanitizePanels(req.body?.panels);
      if (!panels) return res.status(400).json({ error: 'invalid panels payload' });
      store.savePanelsOverride(id, rawKey, pageNo, panels);
      store.setReviewed(id, rawKey, pageNo, true); // editing implies a human looked
      shareHumanEdit(issue.file_path, pageNo, panels); // outrank model consensus everywhere
      res.json({ ok: true, panels });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  }, { access: CAN_EDIT_PANELS });

  // DELETE .../panels/page/:page — revert one page to the detector's layout.
  api.registerRoute('delete', '/api/reader/issue/:id/panels/page/:page', (req, res) => {
    try {
      const id = Number(req.params.id);
      const issue = issueRow(id);
      if (!issue || !issue.file_path) return res.status(404).json({ error: 'no file for this issue' });
      const rawKey = fileKeyOf(issue.file_path);
      if (!rawKey) return res.status(404).json({ error: 'file unreadable' });
      store.clearPanelsOverride(id, rawKey, Number(req.params.page));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  }, { access: CAN_EDIT_PANELS });

  // POST /api/reader/issue/:id/panels/redetect — throw away this issue's
  // cached auto-detection so it recomputes with whatever detector is loaded
  // now (use after swapping the model). ?edits=clear also drops human
  // overrides + review marks for a clean slate; by default they're kept.
  api.registerRoute('post', '/api/reader/issue/:id/panels/redetect', (req, res) => {
    try {
      const id = Number(req.params.id);
      const issue = issueRow(id);
      if (!issue || !issue.file_path) return res.status(404).json({ error: 'no file for this issue' });
      store.clearPanels(id);
      panelJobs.delete(id);
      if (req.query.edits === 'clear') {
        const rawKey = fileKeyOf(issue.file_path);
        if (rawKey) { store.clearPanelsOverride(id, rawKey); store.reviewedPages(id, rawKey).forEach((p) => store.setReviewed(id, rawKey, p, false)); }
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  }, { access: CAN_EDIT_PANELS });

  // PUT/DELETE /api/reader/issue/:id/panels/reviewed/:page — mark a page as
  // human-reviewed ("the layout reads correctly"), or take the mark back.
  for (const [method, on] of [['put', true], ['delete', false]]) {
    api.registerRoute(method, '/api/reader/issue/:id/panels/reviewed/:page', (req, res) => {
      try {
        const id = Number(req.params.id);
        const pageNo = Number(req.params.page);
        if (!Number.isInteger(pageNo) || pageNo < 0) return res.status(400).json({ error: 'bad page' });
        const issue = issueRow(id);
        if (!issue || !issue.file_path) return res.status(404).json({ error: 'no file for this issue' });
        const rawKey = fileKeyOf(issue.file_path);
        if (!rawKey) return res.status(404).json({ error: 'file unreadable' });
        store.setReviewed(id, rawKey, pageNo, on);
        // A human confirming "this layout reads correctly" is the strongest
        // cheap signal the community cache gets — share it as a vote
        // (retracting the review retracts the vote; one vote per instance
        // per page is enforced server-side).
        votePage(issue.file_path, pageNo, on ? 1 : -1);
        res.json({ ok: true });
      } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
    }, { access: CAN_EDIT_PANELS });
  }

  // GET /api/reader/panels/db — Panel Studio's database browser: every stored
  // page layout across the library, filterable + paged. Read-only, same
  // permission as the other layout-editing routes (route lives in paneldb.js).
  registerPanelsDbRoute(api, store, CAN_EDIT_PANELS);

  // Normalized panel payload → clean panels or null. Max 24 panels, rects in
  // [0,1] with sane size, optional 3-8 point poly also in [0,1].
  function sanitizePanels(input) {
    if (!Array.isArray(input) || input.length > 24) return null;
    const out = [];
    for (const p of input) {
      const x = num01(p?.x), y = num01(p?.y), w = num01(p?.w), h = num01(p?.h);
      if (x == null || y == null || w == null || h == null) return null;
      if (w < 0.01 || h < 0.01 || x + w > 1.001 || y + h > 1.001) return null;
      const clean = { x, y, w, h };
      if (p.poly != null) {
        if (!Array.isArray(p.poly) || p.poly.length < 3 || p.poly.length > 8) return null;
        const pts = [];
        for (const pt of p.poly) {
          const px = num01(pt?.[0]), py = num01(pt?.[1]);
          if (px == null || py == null) return null;
          pts.push([px, py]);
        }
        clean.poly = pts;
      }
      out.push(clean);
    }
    return out;
  }
  const num01 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000 : null);

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

  // POST /api/reader/read-bulk { ids: [cvIssueId], read } — bulk mark. The
  // series page's checkboxes select issues; nothing checked = the whole series.
  api.registerRoute('post', '/api/reader/read-bulk', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'ids required' });
    const read = !!(req.body || {}).read;
    for (const id of ids) store.setRead(uid(req), id, read);
    res.json({ done: ids.length });
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
    res.json({ prefs: prefsFor(uid(req), Number(req.params.id)) });
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
