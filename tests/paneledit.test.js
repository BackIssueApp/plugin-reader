// Hand-edited panel overrides: sparse per-page storage, file-key binding
// (a re-downloaded file discards stale corrections), per-page revert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openReaderStore } from '../store.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-paneledit-'));
  const store = openReaderStore(path.join(dir, 'test.db'));
  return { store, dir };
}

test('override save/read/clear round-trip', () => {
  const { store } = tmpStore();
  const key = 'C:/x.cbz|123|456';
  const panels = [{ x: 0.1, y: 0.1, w: 0.35, h: 0.4 }, { x: 0.55, y: 0.1, w: 0.35, h: 0.4, poly: [[0.55, 0.1], [0.9, 0.12], [0.88, 0.5], [0.55, 0.5]] }];
  store.savePanelsOverride(42, key, 3, panels);
  store.savePanelsOverride(42, key, 7, []); // forced page mode is a valid edit
  const o = store.panelsOverride(42, key);
  assert.deepEqual(o['3'], panels);
  assert.deepEqual(o['7'], []);
  // Per-page revert keeps the other page's edit…
  store.clearPanelsOverride(42, key, 3);
  assert.equal(store.panelsOverride(42, key)['3'], undefined);
  assert.deepEqual(store.panelsOverride(42, key)['7'], []);
  // …and clearing the last page drops the row entirely.
  store.clearPanelsOverride(42, key, 7);
  assert.equal(store.panelsOverride(42, key), null);
});

test('override is bound to the file key', () => {
  const { store } = tmpStore();
  store.savePanelsOverride(9, 'file|1|1', 0, [{ x: 0, y: 0, w: 0.5, h: 0.5 }]);
  assert.ok(store.panelsOverride(9, 'file|1|1'));
  assert.equal(store.panelsOverride(9, 'file|2|2'), null); // re-downloaded file → stale edit ignored
  // Saving under the new key replaces the old row's key.
  store.savePanelsOverride(9, 'file|2|2', 1, []);
  assert.equal(store.panelsOverride(9, 'file|1|1'), null);
  assert.deepEqual(store.panelsOverride(9, 'file|2|2')['1'], []);
});

test('reviewed pages round-trip and bind to the file key', () => {
  const { store } = tmpStore();
  const key = 'f|1|1';
  store.setReviewed(5, key, 3);
  store.setReviewed(5, key, 0);
  assert.deepEqual(store.reviewedPages(5, key), [0, 3]);
  store.setReviewed(5, key, 3, false);
  assert.deepEqual(store.reviewedPages(5, key), [0]);
  assert.deepEqual(store.reviewedPages(5, 'f|2|2'), []); // new file → reviews reset
});
