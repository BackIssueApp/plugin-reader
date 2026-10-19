// CBR pages decode on core's worker threads where the app has them, and the
// inline fallback (older cores) gives exactly the same pages in the same order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPages, pageBuffer, useCoreRarForTests } from '../pages.js';

const SAMPLE_CBR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample.cbr');

async function readAll(file) {
  const names = await listPages(file);
  const cover = (await pageBuffer(file, 0)).buffer; // the cover-only path
  const pages = [];
  for (let i = 0; i < names.length; i++) pages.push((await pageBuffer(file, i)).buffer);
  return { names, cover, pages };
}

test('core worker path and inline fallback agree on names, cover and pages', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-corerar-'));
  try {
    const file = path.join(dir, 'x.cbr');
    fs.copyFileSync(SAMPLE_CBR, file);
    await useCoreRarForTests(true);
    const viaCore = await readAll(file);
    await useCoreRarForTests(false);
    const inline = await readAll(file);
    assert.ok(viaCore.names.length >= 2);
    assert.deepEqual(viaCore.names, inline.names);
    assert.ok(viaCore.cover.equals(inline.cover));
    viaCore.pages.forEach((b, i) => assert.ok(b.equals(inline.pages[i]), `page ${i} matches`));
  } finally {
    await useCoreRarForTests(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
