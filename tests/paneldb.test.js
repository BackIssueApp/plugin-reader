// Panel-layout database browser: the /api/reader/panels/db contract —
// permission gating, row shape, filters, search, and SQL-side pagination —
// against a store seeded with detections, hand edits, and review marks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openReaderStore } from '../store.js';
import { registerPanelsDbRoute } from '../paneldb.js';

function tmpdir() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-paneldb-'));
  return { p, rm: () => fs.rmSync(p, { recursive: true, force: true }) };
}

const R = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 };

/** Two detected issues (one ML, one classical), a hand edit that overrides a
 *  detected page, a review mark, and an override-only page with no CV row. */
function seededStore(dir) {
  const dbPath = path.join(dir, 'cat.db');
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE cv_series (comicvine_id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE cv_issues (comicvine_id INTEGER PRIMARY KEY, cv_series_id INTEGER, name TEXT, issue_number TEXT);
    INSERT INTO cv_series VALUES (900, 'Saga'), (901, 'Bone');
    INSERT INTO cv_issues VALUES (10, 900, 'Chapter One', '1'), (11, 901, 'Out from Boneville', '1');
  `);
  seed.close();
  const store = openReaderStore(dbPath);
  // Issue 10: ML detection over 3 pages (page 1 detected as page mode)…
  store.savePanels(10, '/lib/saga1.cbz|100|200|ml2:abcd1234', [
    { page: 0, panels: [R, R, R] },
    { page: 1, panels: [] },
    { page: 2, panels: [R, R] },
  ]);
  // …a human override on page 1 (2 panels now) and a review mark on page 0.
  store.savePanelsOverride(10, '/lib/saga1.cbz|100|200', 1, [R, R]);
  store.setReviewed(10, '/lib/saga1.cbz|100|200', 0);
  // Issue 11: classical detection (no engine suffix), one page.
  store.savePanels(11, '/lib/bone1.cbz|100|200', [{ page: 0, panels: [R] }]);
  // Issue 12: override-only forced page mode, and no cv_issues row at all.
  store.savePanelsOverride(12, '/lib/mystery.cbz|100|200', 0, []);
  return store;
}

test('panels db: counts + one row per stored page layout, with CV metadata', () => {
  const { p: dir, rm } = tmpdir();
  try {
    const store = seededStore(dir);
    const r = store.panelsDb({});
    assert.equal(r.total, 5); // 3 detected (Saga) + 1 detected (Bone) + 1 override-only
    assert.deepEqual(r.counts, { all: 5, ml: 3, classical: 1, edited: 2, reviewed: 1, pagemode: 1 });

    const p0 = r.rows.find((x) => x.issue_id === 10 && x.page === 0);
    assert.equal(p0.series, 'Saga');
    assert.equal(p0.title, 'Chapter One');
    assert.equal(p0.issue_number, '1');
    assert.equal(p0.engine, 'ml-box-v2');
    assert.equal(p0.panels, 3);
    assert.equal(p0.edited, false);
    assert.equal(p0.reviewed, true);
    assert.ok(p0.updated_at, 'detected rows carry the detection timestamp');

    // The override wins: page 1 serves the human's 2 panels, flagged edited.
    const p1 = r.rows.find((x) => x.issue_id === 10 && x.page === 1);
    assert.equal(p1.edited, true);
    assert.equal(p1.panels, 2);

    // Engine derived from the file-key suffix: none → classical.
    assert.equal(r.rows.find((x) => x.issue_id === 11).engine, 'classical');

    // No CV metadata → file-basename fallback; forced page mode counts 0.
    const orphan = r.rows.find((x) => x.issue_id === 12);
    assert.equal(orphan.series, null);
    assert.equal(orphan.file, 'mystery.cbz');
    assert.equal(orphan.engine, null, 'override-only rows have no detector engine');
    assert.equal(orphan.panels, 0);
    assert.equal(orphan.edited, true);
    store.close();
  } finally { rm(); }
});

test('panels db: filters narrow rows and total; counts stay global', () => {
  const { p: dir, rm } = tmpdir();
  try {
    const store = seededStore(dir);
    const ml = store.panelsDb({ filter: 'ml' });
    assert.equal(ml.total, 3);
    assert.ok(ml.rows.every((x) => x.engine === 'ml-box-v2' && x.issue_id === 10));
    assert.equal(ml.counts.all, 5, 'chip counts cover the whole set');

    const classical = store.panelsDb({ filter: 'classical' });
    assert.deepEqual(classical.rows.map((x) => x.issue_id), [11]);

    const edited = store.panelsDb({ filter: 'edited' });
    assert.equal(edited.total, 2);
    assert.ok(edited.rows.every((x) => x.edited));

    const reviewed = store.panelsDb({ filter: 'reviewed' });
    assert.equal(reviewed.total, 1);
    assert.equal(reviewed.rows[0].issue_id, 10);
    assert.equal(reviewed.rows[0].page, 0);

    const pagemode = store.panelsDb({ filter: 'pagemode' });
    assert.equal(pagemode.total, 1);
    assert.equal(pagemode.rows[0].issue_id, 12);

    // Unknown filter falls back to all.
    assert.equal(store.panelsDb({ filter: 'bogus' }).total, 5);
    store.close();
  } finally { rm(); }
});

test('panels db: q searches series/issue text and the file path', () => {
  const { p: dir, rm } = tmpdir();
  try {
    const store = seededStore(dir);
    const saga = store.panelsDb({ q: 'saga' });
    assert.equal(saga.total, 3);
    assert.ok(saga.rows.every((x) => x.issue_id === 10));
    assert.equal(saga.counts.edited, 1, 'counts follow the search');

    // Matches the CV issue title too…
    assert.equal(store.panelsDb({ q: 'Boneville' }).total, 1);
    // …and the file path when there is no CV row.
    const orphan = store.panelsDb({ q: 'mystery' });
    assert.equal(orphan.total, 1);
    assert.equal(orphan.rows[0].issue_id, 12);

    assert.equal(store.panelsDb({ q: 'zzz-no-match' }).total, 0);
    store.close();
  } finally { rm(); }
});

test('panels db: SQL pagination — stable pages, clamped limit, empty tail', () => {
  const { p: dir, rm } = tmpdir();
  try {
    const store = seededStore(dir);
    const seen = new Set();
    for (let off = 0; off < 5; off += 2) {
      const page = store.panelsDb({ offset: off, limit: 2 });
      assert.equal(page.total, 5, 'total is the filtered count, not the page size');
      assert.ok(page.rows.length <= 2);
      page.rows.forEach((x) => seen.add(`${x.issue_id}:${x.page}`));
    }
    assert.equal(seen.size, 5, 'walking the offsets covers every row exactly once');
    assert.equal(store.panelsDb({ offset: 50, limit: 2 }).rows.length, 0);
    // Nonsense paging inputs clamp instead of throwing.
    assert.equal(store.panelsDb({ offset: -3, limit: 0 }).rows.length, 5);
    store.close();
  } finally { rm(); }
});

// Route contract: registered as GET /api/reader/panels/db gated on the access
// key index.js passes (reader.panels.edit). Core enforces opts.access before
// a plugin handler ever runs; this harness mirrors that gate.
function mount(store) {
  const routes = [];
  const api = { registerRoute: (m, p, h, o = {}) => routes.push({ method: m, path: p, handler: h, access: o.access }) };
  registerPanelsDbRoute(api, store, 'reader.panels.edit');
  const route = routes[0];
  const call = (query, perms) => new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    if (!perms.includes(route.access)) return resolve({ status: 403, body: { error: 'forbidden' } });
    route.handler({ query }, res);
  });
  return { route, call };
}

test('panels db endpoint: needs reader.panels.edit, parses query params', async () => {
  const { p: dir, rm } = tmpdir();
  try {
    const store = seededStore(dir);
    const { route, call } = mount(store);
    assert.equal(route.method, 'get');
    assert.equal(route.path, '/api/reader/panels/db');
    assert.equal(route.access, 'reader.panels.edit', 'same permission as the rest of Panel Studio');

    const denied = await call({}, []);
    assert.equal(denied.status, 403, 'without the permission the handler is never reached');

    const ok = await call({ filter: 'ml', limit: '2', offset: '0' }, ['reader.panels.edit']);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.total, 3);
    assert.equal(ok.body.rows.length, 2);
    assert.equal(ok.body.counts.all, 5);

    const searched = await call({ q: 'mystery' }, ['reader.panels.edit']);
    assert.equal(searched.body.total, 1);
    assert.equal(searched.body.rows[0].file, 'mystery.cbz');

    // String query params (as Express delivers them) clamp cleanly.
    const clamped = await call({ filter: 'bogus', limit: '99999', offset: '-4' }, ['reader.panels.edit']);
    assert.equal(clamped.status, 200);
    assert.equal(clamped.body.total, 5);
    store.close();
  } finally { rm(); }
});
