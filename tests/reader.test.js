// Reader server logic: page listing/extraction from a real CBZ fixture and
// the progress/bookmark store on a temp DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCbz } from '../../../src/downloader.js';
import { listPages, pageBuffer, pageBufferResized, clampWidth, naturalSort, sniffKind } from '../pages.js';
import { openReaderStore } from '../store.js';
import Database from 'better-sqlite3';

function tmpdir() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-test-'));
  return { p, rm: () => fs.rmSync(p, { recursive: true, force: true }) };
}

test('naturalSort orders scanner-style page names correctly', () => {
  assert.deepEqual(
    naturalSort(['p10.jpg', 'p2.jpg', 'p1.jpg']),
    ['p1.jpg', 'p2.jpg', 'p10.jpg'], // not p1, p10, p2
  );
});

test('listPages + pageBuffer read a real CBZ (sorted, filtered, streamed)', async () => {
  const { p: dir, rm } = tmpdir();
  try {
    const cbz = await buildCbz([
      { name: 'page_10.jpg', buffer: Buffer.from('TEN') },
      { name: 'page_2.png', buffer: Buffer.from('TWO') },
      { name: 'page_1.jpg', buffer: Buffer.from('ONE') },
      { name: 'notes.txt', buffer: Buffer.from('junk') },       // non-image → excluded
      { name: '__MACOSX/._page_1.jpg', buffer: Buffer.from('x') }, // resource fork → excluded
    ]);
    const file = path.join(dir, 'test.cbz');
    fs.writeFileSync(file, cbz);

    assert.equal(await sniffKind(file), 'zip');
    const pages = await listPages(file);
    assert.deepEqual(pages, ['page_1.jpg', 'page_2.png', 'page_10.jpg']);

    const p0 = await pageBuffer(file, 0);
    assert.equal(p0.buffer.toString(), 'ONE');
    assert.equal(p0.contentType, 'image/jpeg');
    const p1 = await pageBuffer(file, 1);
    assert.equal(p1.buffer.toString(), 'TWO');
    assert.equal(p1.contentType, 'image/png');
    await assert.rejects(() => pageBuffer(file, 99), /out of range/);
  } finally { rm(); }
});

test('progress store: resume, complete-latching, bookmarks, continue list', () => {
  const { p: dir, rm } = tmpdir();
  try {
    const dbPath = path.join(dir, 'cat.db');
    // Minimal core tables the continue-list JOIN needs (CV-keyed since v1.2).
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE cv_series (comicvine_id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE cv_issues (comicvine_id INTEGER PRIMARY KEY, cv_series_id INTEGER, name TEXT, issue_number TEXT);
      CREATE TABLE library_files (path TEXT PRIMARY KEY, cv_issue_id INTEGER, series_id INTEGER, valid INTEGER);
      INSERT INTO cv_series VALUES (900, 'Saga');
      INSERT INTO cv_issues VALUES (10, 900, 'Chapter One', '1');
      INSERT INTO cv_issues VALUES (11, 900, 'Chapter Two', '2');
      INSERT INTO library_files VALUES ('/lib/saga1.cbz', 10, 1, 1);
      INSERT INTO library_files VALUES ('/lib/saga2.cbz', 11, 1, 1);
    `);
    seed.close();

    const store = openReaderStore(dbPath);
    const U = 1; // acting user
    assert.deepEqual(store.progress(U, 10), { page: 0, pages: 0, completed: 0 });

    store.saveProgress(U, 10, { page: 7, pages: 24, completed: false });
    assert.deepEqual(store.progress(U, 10), { page: 7, pages: 24, completed: 0 });

    // completed latches: once finished, a re-read from page 3 keeps completed=1
    store.saveProgress(U, 10, { page: 23, pages: 24, completed: true });
    store.saveProgress(U, 10, { page: 3, pages: 24, completed: false });
    assert.equal(store.progress(U, 10).completed, 1);

    store.setBookmark(U, 11, 5, true);
    store.setBookmark(U, 11, 9, true);
    store.setBookmark(U, 11, 5, false);
    assert.deepEqual(store.bookmarks(U, 11), [9]);

    // continue list: only incomplete + started issues with files
    store.saveProgress(U, 11, { page: 4, pages: 20, completed: false });
    const cont = store.continueList(U);
    assert.equal(cont.length, 1);
    assert.equal(cont[0].issue_id, 11);
    assert.equal(cont[0].series, 'Saga');

    // PER-USER isolation: a different user has none of this history
    assert.deepEqual(store.progress(2, 10), { page: 0, pages: 0, completed: 0 });
    assert.deepEqual(store.bookmarks(2, 11), []);
    assert.equal(store.continueList(2).length, 0);
    store.saveProgress(2, 10, { page: 1, pages: 24, completed: false });
    assert.equal(store.progress(2, 10).page, 1);   // theirs
    assert.equal(store.progress(U, 10).page, 3);   // yours, untouched
    assert.deepEqual(Object.keys(store.allStates(2)), ['10']);
    store.close();
  } finally { rm(); }
});

test('per-user migration: global single-user history moves to the oldest admin', () => {
  const { p: dir, rm } = tmpdir();
  try {
    const dbPath = path.join(dir, 'cat-peruser.db');
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT, disabled INTEGER DEFAULT 0);
      INSERT INTO users VALUES (3, 'later-admin', 'admin', 0), (7, 'a-viewer', 'viewer', 0);
      -- pre-multi-user (GLOBAL) reader tables:
      CREATE TABLE reader_progress (issue_id INTEGER PRIMARY KEY, page INTEGER NOT NULL DEFAULT 0,
        pages INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, updated_at TEXT);
      INSERT INTO reader_progress VALUES (500, 5, 20, 0, '2026-01-01T00:00:00Z');
      CREATE TABLE reader_bookmarks (issue_id INTEGER NOT NULL, page INTEGER NOT NULL, PRIMARY KEY (issue_id, page));
      INSERT INTO reader_bookmarks VALUES (500, 3);
      CREATE TABLE reader_series_prefs (series_id INTEGER PRIMARY KEY, mode TEXT, rtl INTEGER, fit TEXT,
        split INTEGER, spread_offset INTEGER NOT NULL DEFAULT 0);
      INSERT INTO reader_series_prefs VALUES (9, 'webtoon', 1, 'width', 0, 0);
    `);
    seed.close();

    const store = openReaderStore(dbPath);
    // history belongs to the oldest admin (id 3), not the viewer, not user 0
    assert.deepEqual(store.progress(3, 500), { page: 5, pages: 20, completed: 0 });
    assert.deepEqual(store.bookmarks(3, 500), [3]);
    assert.equal(store.seriesPrefs(3, 9).mode, 'webtoon');
    assert.deepEqual(store.progress(7, 500), { page: 0, pages: 0, completed: 0 });
    assert.equal(store.seriesPrefs(0, 9), null);
    store.close();
  } finally { rm(); }
});

test('clampWidth snaps to allowed steps so the resize cache stays effective', () => {
  assert.equal(clampWidth(0), 0);          // no width → original
  assert.equal(clampWidth(150), 200);      // snaps up to a step
  assert.equal(clampWidth(801), 1200);
  assert.equal(clampWidth(99999), 1600);   // capped
});

test('pageBufferResized downscales a real image page via sharp', async () => {
  const { p: dir, rm } = tmpdir();
  try {
    // A real 100x50 PNG so sharp has something to resize.
    const { default: sharp } = await import('sharp');
    const png = await sharp({ create: { width: 100, height: 50, channels: 3, background: { r: 200, g: 10, b: 10 } } }).png().toBuffer();
    const cbz = await buildCbz([{ name: 'p1.png', buffer: png }]);
    const file = path.join(dir, 'wide.cbz');
    fs.writeFileSync(file, cbz);

    const small = await pageBufferResized(file, 0, 200);
    assert.equal(small.contentType, 'image/jpeg');
    const meta = await sharp(small.buffer).metadata();
    assert.equal(meta.width, 100, 'withoutEnlargement: never upscales');

    const orig = await pageBufferResized(file, 0, 0);
    assert.equal(orig.contentType, 'image/png'); // no width → passthrough
  } finally { rm(); }
});

test('series prefs: manga profile persists per series', () => {
  const { p: dir, rm } = tmpdir();
  try {
    const dbPath = path.join(dir, 'cat2.db');
    const seed = new Database(dbPath);
    seed.exec('CREATE TABLE series (id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE issues (id INTEGER PRIMARY KEY, series_id INTEGER, title TEXT, issue_number TEXT, file_path TEXT);');
    seed.close();
    const store = openReaderStore(dbPath);
    assert.equal(store.seriesPrefs(1, 5), null);
    store.saveSeriesPrefs(1, 5, { mode: 'webtoon', rtl: true, fit: 'width', split: false });
    assert.deepEqual(store.seriesPrefs(1, 5), { mode: 'webtoon', rtl: 1, fit: 'width', split: 0, spread_offset: 0 });
    store.saveSeriesPrefs(1, 5, { mode: 'single', rtl: false, fit: 'height', split: true, spread_offset: true });
    assert.deepEqual(store.seriesPrefs(1, 5), { mode: 'single', rtl: 0, fit: 'height', split: 1, spread_offset: 1 });
    assert.equal(store.seriesPrefs(2, 5), null); // another user keeps their own profile
    assert.deepEqual(store.allStates(1), {});
    store.close();
  } finally { rm(); }
});

test('v1.2 rekey migration: local issue ids remap to CV ids once', () => {
  const { p: dir, rm } = tmpdir();
  try {
    const dbPath = path.join(dir, 'cat-rekey.db');
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE issues (id INTEGER PRIMARY KEY, url TEXT, file_path TEXT);
      CREATE TABLE library_files (path TEXT PRIMARY KEY, cv_issue_id INTEGER, valid INTEGER);
      CREATE TABLE cv_issues (comicvine_id INTEGER PRIMARY KEY, cv_series_id INTEGER, name TEXT, issue_number TEXT);
      CREATE TABLE cv_series (comicvine_id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO issues VALUES (5, 'legacy:whatever', '/lib/a.cbz');   -- maps via file → library_files
      INSERT INTO issues VALUES (6, 'cvissue:777', NULL);                -- maps via cvissue: url
      INSERT INTO library_files VALUES ('/lib/a.cbz', 555, 1);
      -- old-style progress keyed by LOCAL issue ids 5 and 6:
      CREATE TABLE reader_progress (issue_id INTEGER PRIMARY KEY, page INTEGER NOT NULL DEFAULT 0,
        pages INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, updated_at TEXT);
      INSERT INTO reader_progress VALUES (5, 3, 20, 0, '2026-01-01T00:00:00Z');
      INSERT INTO reader_progress VALUES (6, 9, 22, 1, '2026-01-01T00:00:00Z');
      CREATE TABLE reader_bookmarks (issue_id INTEGER NOT NULL, page INTEGER NOT NULL, PRIMARY KEY (issue_id, page));
      INSERT INTO reader_bookmarks VALUES (5, 4);
    `);
    seed.close();

    const store = openReaderStore(dbPath);
    // (no users table in this fixture → history lands on the open-mode user 0)
    assert.deepEqual(store.progress(0, 555), { page: 3, pages: 20, completed: 0 });
    assert.deepEqual(store.progress(0, 777), { page: 9, pages: 22, completed: 1 });
    assert.deepEqual(store.bookmarks(0, 555), [4]);
    assert.deepEqual(store.progress(0, 5), { page: 0, pages: 0, completed: 0 }); // old keys gone
    store.close();

    // Runs exactly once: a NEW cv-keyed row that happens to collide with a
    // local issue id must not be touched on the next boot.
    const store2 = openReaderStore(dbPath);
    store2.saveProgress(0, 6, { page: 2, pages: 30, completed: false }); // 6 is now a legit CV id elsewhere
    store2.close();
    const store3 = openReaderStore(dbPath);
    assert.deepEqual(store3.progress(0, 6), { page: 2, pages: 30, completed: 0 });
    store3.close();
  } finally { rm(); }
});

test('setRead: manual mark bypasses the completed latch both ways', () => {
  const { p: dir, rm } = tmpdir();
  try {
    const dbPath = path.join(dir, 'cat3.db');
    const seed = new Database(dbPath);
    seed.exec('CREATE TABLE series (id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE issues (id INTEGER PRIMARY KEY, series_id INTEGER, title TEXT, issue_number TEXT, file_path TEXT);');
    seed.close();
    const store = openReaderStore(dbPath);

    // Mark read with no prior progress row → completed, page reset.
    store.setRead(1, 42, true);
    assert.deepEqual(store.progress(1, 42), { page: 0, pages: 0, completed: 1 });

    // Mark unread on a finished issue → latch is bypassed, resume point cleared.
    store.saveProgress(1, 43, { page: 23, pages: 24, completed: true });
    store.setRead(1, 43, false);
    assert.deepEqual(store.progress(1, 43), { page: 0, pages: 24, completed: 0 });
    store.close();
  } finally { rm(); }
});

test('pageBufferResized: webp transcode + margin trim variants', async () => {
  const { p: dir, rm } = tmpdir();
  try {
    const { default: sharp } = await import('sharp');
    // Black 40x40 content centered in a white 100x100 page → trim shaves borders.
    const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([{ input: await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer(), top: 30, left: 30 }])
      .png().toBuffer();
    const cbz = await buildCbz([{ name: 'p1.png', buffer: png }]);
    const file = path.join(dir, 'bordered.cbz');
    fs.writeFileSync(file, cbz);

    const webp = await pageBufferResized(file, 0, 800, { webp: true });
    assert.equal(webp.contentType, 'image/webp');

    const trimmed = await pageBufferResized(file, 0, 0, { trim: true });
    const meta = await sharp(trimmed.buffer).metadata();
    assert.ok(meta.width < 100 && meta.height < 100, `borders shaved (got ${meta.width}x${meta.height})`);
  } finally { rm(); }
});

test('reading stats: page deltas and completions aggregate per user per day', () => {
  const { p: dir, rm } = tmpdir();
  try {
    const store = openReaderStore(path.join(dir, 'cat.db'));
    // forward progress counts pages; re-opening at an earlier page does not
    store.saveProgress(1, 900, { page: 10, pages: 20, completed: 0 });   // +10
    store.saveProgress(1, 900, { page: 4, pages: 20, completed: 0 });    // backwards: +0
    store.saveProgress(1, 900, { page: 20, pages: 20, completed: 1 });   // +16, finish
    store.saveProgress(1, 901, { page: 5, pages: 30, completed: 0 });    // +5
    store.saveProgress(2, 900, { page: 3, pages: 20, completed: 0 });    // other user: +3
    // finishing the same issue twice only counts once (latch already set)
    store.saveProgress(1, 900, { page: 20, pages: 20, completed: 1 });

    const s1 = store.stats(1);
    assert.equal(s1.totals.pages, 31);
    assert.equal(s1.totals.completed, 1);
    assert.equal(s1.month.pages, 31);
    assert.equal(s1.streak, 1, 'read today → 1-day streak');
    assert.equal(s1.last30.at(-1).pages, 31);

    const s2 = store.stats(2);
    assert.equal(s2.totals.pages, 3, 'stats are per-user');
    assert.equal(s2.totals.completed, 0);
    store.close();
  } finally { rm(); }
});

test('read-later shelf + global bookmarks: per-user, with issue metadata', () => {
  const { p: dir, rm } = tmpdir();
  try {
    const dbPath = path.join(dir, 'cat.db');
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE cv_series (comicvine_id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE cv_issues (comicvine_id INTEGER PRIMARY KEY, cv_series_id INTEGER, name TEXT, issue_number TEXT);
      CREATE TABLE library_files (path TEXT PRIMARY KEY, cv_issue_id INTEGER, series_id INTEGER, valid INTEGER);
      INSERT INTO cv_series VALUES (900, 'Saga');
      INSERT INTO cv_issues VALUES (10, 900, 'Chapter One', '1'), (11, 900, 'Chapter Two', '2');
      INSERT INTO library_files VALUES ('/lib/saga1.cbz', 10, 1, 1), ('/lib/saga2.cbz', 11, 1, 1);
    `);
    seed.close();
    const store = openReaderStore(dbPath);

    // read-later toggles + per-user isolation
    assert.equal(store.isLater(1, 10), false);
    assert.equal(store.setLater(1, 10, true), true);
    assert.equal(store.isLater(1, 10), true);
    assert.equal(store.isLater(2, 10), false, 'another user unaffected');
    assert.equal(store.laterList(1).length, 1);
    assert.equal(store.laterList(1)[0].series, 'Saga');
    assert.equal(store.laterList(2).length, 0);
    store.setLater(1, 10, false);
    assert.equal(store.laterList(1).length, 0);

    // global bookmarks with metadata, per-user
    store.setBookmark(1, 10, 3, true);
    store.setBookmark(1, 11, 0, true);
    const bms = store.allBookmarks(1);
    assert.equal(bms.length, 2);
    assert.ok(bms.every((b) => b.series === 'Saga'));
    assert.equal(store.allBookmarks(2).length, 0, 'bookmarks are per-user');
    store.close();
  } finally { rm(); }
});

test('next-up: earliest unread issue in a series you have finished one of', () => {
  const { p: dir, rm } = tmpdir();
  try {
    const dbPath = path.join(dir, 'cat-nextup.db');
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE cv_series (comicvine_id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE cv_issues (comicvine_id INTEGER PRIMARY KEY, cv_series_id INTEGER, name TEXT, issue_number TEXT);
      CREATE TABLE library_files (path TEXT PRIMARY KEY, cv_issue_id INTEGER, series_id INTEGER, valid INTEGER);
      INSERT INTO cv_series VALUES (900, 'Saga'), (901, 'Bone');
      INSERT INTO cv_issues VALUES
        (10, 900, 'One', '1'), (11, 900, 'Two', '2'), (12, 900, 'Three', '3'),
        (20, 901, 'B1', '1'), (21, 901, 'B2', '2');
      INSERT INTO library_files VALUES
        ('/s1.cbz', 10, 1, 1), ('/s2.cbz', 11, 1, 1), ('/s3.cbz', 12, 1, 1),
        ('/b1.cbz', 20, 2, 1), ('/b2.cbz', 21, 2, 1);
    `);
    seed.close();
    const store = openReaderStore(dbPath);
    const U = 1;

    // No completed issues yet → nothing "up next".
    assert.equal(store.nextUpList(U).length, 0);

    // Finish Saga #1 → next up is Saga #2 (earliest unread with a file).
    store.saveProgress(U, 10, { page: 20, pages: 20, completed: true });
    let up = store.nextUpList(U);
    assert.equal(up.length, 1);
    assert.equal(up[0].issue_id, 11);
    assert.equal(up[0].series, 'Saga');

    // Start reading #2 → it's now a "continue", so next-up advances to #3.
    store.saveProgress(U, 11, { page: 3, pages: 20, completed: false });
    assert.equal(store.nextUpList(U)[0].issue_id, 12);

    // Finish a Bone issue too → both series surface (order by recency; assert set).
    store.saveProgress(U, 20, { page: 22, pages: 22, completed: true });
    up = store.nextUpList(U);
    assert.deepEqual(up.map((x) => x.issue_id).sort((a, b) => a - b), [12, 21]);

    // Continue vs Next up never overlap: #11 is in continue, not next-up.
    assert.ok(!store.nextUpList(U).some((x) => x.issue_id === 11));
    assert.equal(store.continueList(U).some((x) => x.issue_id === 11), true);

    // Per-user isolation: user 2 has finished nothing.
    assert.equal(store.nextUpList(2).length, 0);
    store.close();
  } finally { rm(); }
});

test('home rail prefs: default on, toggle persists, per-user', () => {
  const { p: dir, rm } = tmpdir();
  try {
    const store = openReaderStore(path.join(dir, 'cat-homeprefs.db'));
    assert.deepEqual(store.homePrefs(1), { showContinue: true, showNext: true }); // default
    assert.deepEqual(store.setHomePrefs(1, { showContinue: false, showNext: true }), { showContinue: false, showNext: true });
    assert.deepEqual(store.homePrefs(1), { showContinue: false, showNext: true });
    assert.deepEqual(store.homePrefs(2), { showContinue: true, showNext: true }, 'per-user default');
    store.setHomePrefs(1, { showContinue: true, showNext: false });
    assert.deepEqual(store.homePrefs(1), { showContinue: true, showNext: false });
    store.close();
  } finally { rm(); }
});
