// Page hashing (stable content key + perceptual hash) and the cache client's
// safe-fallback behavior when sharing is off or the server is unreachable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { pageHash, pageDhash, createPanelCache } from '../panelcache.js';

test('pageHash is stable and content-addressed', () => {
  const a = Buffer.from('the same page bytes');
  const b = Buffer.from('the same page bytes');
  const c = Buffer.from('different bytes');
  assert.equal(pageHash(a), pageHash(b));
  assert.notEqual(pageHash(a), pageHash(c));
  assert.match(pageHash(a), /^[0-9a-f]{64}$/);
});

test('pageDhash returns a 64-hex-char (256-bit) hash, similar for similar images', async () => {
  const img = (bg) => sharp({ create: { width: 64, height: 64, channels: 3, background: bg } })
    .composite([{ input: { create: { width: 30, height: 64, channels: 3, background: '#000' } }, left: 0, top: 0 }])
    .png().toBuffer();
  const h1 = await pageDhash(sharp, await img('#fff'));
  const h2 = await pageDhash(sharp, await img('#fefefe')); // near-identical
  assert.match(h1, /^[0-9a-f]{64}$/);
  const dist = [...h1].reduce((n, ch, i) => n + (ch !== h2[i] ? 1 : 0), 0);
  assert.ok(dist <= 8, `near-identical images should have small hamming distance, got ${dist}`);
});

test('client is inert when sharing is disabled', async () => {
  const cache = createPanelCache({ base: 'http://example.invalid', store: {}, enabled: () => false });
  assert.equal(cache.enabled(), false);
  assert.equal((await cache.lookup(['abc'])).size, 0);
  await cache.submit([{ hash: 'abc', engine: 'x', source: 'model', panels: [] }]); // no throw
  await cache.vote('abc', 1); // no throw
});

test('lookup returns empty map when the server is unreachable', async () => {
  const cache = createPanelCache({
    base: 'http://127.0.0.1:9', // nothing listening
    store: { getMeta: () => null, setMeta: () => {} },
    enabled: () => true,
  });
  const hits = await cache.lookup(['abc', 'def']);
  assert.equal(hits.size, 0); // offline degrades to all-miss, never throws
});
