// Page access under load: CBR extraction is shared and gated, the cover comes
// out without a whole-archive extract, resized variants render once, and
// "New in library" keeps its order and dedupe on the index walk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { buildCbz } from '../../../src/downloader.js';
import { listPages, pageBuffer, pageBufferResized, rarStats, makeGate, statFile, fileVersionOf } from '../pages.js';
import { openReaderStore } from '../store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_CBR = path.join(HERE, 'fixtures', 'sample.cbr'); // 001.jpg, 002.jpg, ComicInfo.xml

function tmpdir() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-perf-'));
  return { p, rm: () => fs.rmSync(p, { recursive: true, force: true }) };
}
function copyCbr(dir, name) {
  const f = path.join(dir, name);
  fs.copyFileSync(SAMPLE_CBR, f);
  return f;
}

test('CBR: pages list and read; the cover needs no whole-archive extract', async () => {
  const { p: dir, rm } = tmpdir();
  try {
    const file = copyCbr(dir, 'a.cbr');
    const before = rarStats().extractions;
    assert.deepEqual(await listPages(file), ['001.jpg', '002.jpg']);
    const cover = await pageBuffer(file, 0);
    assert.equal(cover.contentType, 'image/jpeg');
    assert.equal(cover.buffer.length, 4);
    assert.equal(rarStats().extractions, before, 'listing + cover use the single-entry path');
    const p1 = await pageBuffer(file, 1);
    assert.equal(p1.buffer.length, 4);
    assert.equal(rarStats().extractions, before + 1, 'reading on extracts the archive once');
    await pageBuffer(file, 1);
    assert.equal(rarStats().extractions, before + 1, 'then serves from the LRU');
    await assert.rejects(() => pageBuffer(file, 5), /out of range/);
  } finally { rm(); }
});

test('CBR: concurrent page requests share one extraction', async () => {
  const { p: dir, rm } = tmpdir();
  try {
    const file = copyCbr(dir, 'b.cbr');
    await listPages(file);
    const before = rarStats().extractions;
    // The page plus preloads, as the reader fires them on open.
    const got = await Promise.all([1, 1, 1, 1].map((i) => pageBuffer(file, i)));
    assert.equal(rarStats().extractions, before + 1);
    assert.ok(got.every((g) => g.buffer === got[0].buffer), 'one buffer, shared');
  } finally { rm(); }
});

test('CBR: archives over the size ceiling are refused before being read', async () => {
  const { p: dir, rm } = tmpdir();
  const prev = process.env.MAX_RAR_MB;
  try {
    process.env.MAX_RAR_MB = '0.0001'; // ~100 bytes; the fixture is 251
    const fresh = await import(`../pages.js?cap=${Date.now()}`);
    const file = copyCbr(dir, 'c.cbr');
    await assert.rejects(() => fresh.listPages(file), /too large/);
  } finally {
    if (prev === undefined) delete process.env.MAX_RAR_MB; else process.env.MAX_RAR_MB = prev;
    rm();
  }
});

test('missing files fail with the reader error, without a separate exists check', async () => {
  await assert.rejects(() => listPages(path.join(os.tmpdir(), 'nope-reader-perf.cbz')), /file missing on disk/);
  await assert.rejects(() => statFile(path.join(os.tmpdir(), 'nope-reader-perf.cbz')), /file missing on disk/);
  assert.equal(fileVersionOf(null), '0');
});

test('makeGate never runs more than its slots at once', async () => {
  const gate = makeGate(2);
  let live = 0, peak = 0;
  const work = () => gate(async () => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    return 'ok';
  });
  const out = await Promise.all(Array.from({ length: 7 }, work));
  assert.equal(peak, 2);
  assert.equal(out.length, 7);
  assert.deepEqual(gate.stats(), { active: 0, queued: 0 });
});

test('concurrent requests for one resized variant render it once', async () => {
  const { p: dir, rm } = tmpdir();
  try {
    const { default: sharp } = await import('sharp');
    const png = await sharp({ create: { width: 600, height: 900, channels: 3, background: { r: 9, g: 90, b: 200 } } }).png().toBuffer();
    const file = path.join(dir, 'grid.cbz');
    fs.writeFileSync(file, await buildCbz([{ name: 'p1.png', buffer: png }]));
    const got = await Promise.all(Array.from({ length: 6 }, () => pageBufferResized(file, 0, 200, { webp: true })));
    assert.ok(got.every((g) => g.buffer === got[0].buffer), 'one render shared by every waiter');
    assert.equal((await sharp(got[0].buffer).metadata()).width, 200);
  } finally { rm(); }
});

test('new in library: newest file per issue, read issues skipped, shelf fills past duplicates', () => {
  const { p: dir, rm } = tmpdir();
  try {
    const dbPath = path.join(dir, 'cat.db');
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE cv_series (comicvine_id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE cv_issues (comicvine_id INTEGER PRIMARY KEY, cv_series_id INTEGER, name TEXT, issue_number TEXT);
      CREATE TABLE library_files (path TEXT PRIMARY KEY, cv_issue_id INTEGER, series_id INTEGER, valid INTEGER, mtime INTEGER);
      INSERT INTO cv_series VALUES (900, 'Saga');
    `);
    const ins = seed.prepare('INSERT INTO library_files VALUES (?, ?, 1, ?, ?)');
    const issue = seed.prepare('INSERT INTO cv_issues VALUES (?, 900, ?, ?)');
    for (let i = 1; i <= 30; i++) issue.run(i, `#${i}`, String(i));
    // Issue 30 has ten copies, all newer than anything else — enough to fill
    // the first over-fetch with one issue.
    for (let k = 0; k < 10; k++) ins.run(`/dup${k}.cbz`, 30, 1, 10_000 + k);
    for (let i = 1; i < 30; i++) ins.run(`/i${i}.cbz`, i, 1, 1000 + i);
    ins.run('/broken.cbz', 29, 0, 99_999);   // invalid → ignored
    ins.run('/orphan.cbz', 777, 1, 99_998);  // no cv_issues row → ignored
    seed.close();

    const store = openReaderStore(dbPath);
    const plan = new Database(dbPath, { readonly: true });
    assert.ok(plan.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_libfiles_newest'").get(), 'index created');
    plan.close();
    store.saveProgress(1, 28, { page: 3, pages: 20 });
    const ids = store.newInLibrary(1, 5).map((r) => r.issue_id);
    assert.deepEqual(ids, [30, 29, 27, 26, 25]);
    const first = store.newInLibrary(1, 1)[0];
    assert.deepEqual({ ...first }, { issue_id: 30, title: '#30', issue_number: '30', series: 'Saga', series_id: 900 });
    store.close();
  } finally { rm(); }
});
