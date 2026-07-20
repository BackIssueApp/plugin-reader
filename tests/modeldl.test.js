// Model auto-download: verification, hand-installed protection, upgrade path.
// Runs a tiny local HTTP server as the "CDN".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ensurePanelModel } from '../modeldl.js';

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'modeldl-')); }
function memStore() { const m = {}; return { getMeta: (k) => m[k] ?? null, setMeta: (k, v) => { m[k] = String(v); }, _m: m }; }

async function cdn(body, { corrupt = false } = {}) {
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const srv = http.createServer((req, res) => {
    if (req.url === '/panels-latest.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ url: `http://127.0.0.1:${srv.address().port}/model.onnx`, sha256: sha, bytes: body.length, engine: 'test-v1' }));
    } else {
      res.end(corrupt ? Buffer.concat([body, Buffer.from('x')]) : body);
    }
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { srv, url: `http://127.0.0.1:${srv.address().port}/panels-latest.json`, sha };
}

test('downloads, verifies, and records the model', async () => {
  const body = Buffer.from('pretend-onnx-bytes'.repeat(100));
  const { srv, url, sha } = await cdn(body);
  const dir = tmpdir();
  const modelPath = path.join(dir, 'panels.onnx');
  const store = memStore();
  const got = await ensurePanelModel({ modelPath, customPath: null, enabled: true, store, manifestUrl: url });
  srv.close();
  assert.equal(got, true);
  assert.deepEqual(fs.readFileSync(modelPath), body);
  assert.equal(store._m.panelModelSha, sha);
  assert.ok(!fs.existsSync(modelPath + '.part'));
});

test('a corrupt download is discarded, nothing installed', async () => {
  const body = Buffer.from('good-bytes'.repeat(50));
  const { srv, url } = await cdn(body, { corrupt: true });
  const dir = tmpdir();
  const modelPath = path.join(dir, 'panels.onnx');
  const got = await ensurePanelModel({ modelPath, customPath: null, enabled: true, store: memStore(), manifestUrl: url });
  srv.close();
  assert.equal(got, false);
  assert.ok(!fs.existsSync(modelPath));
  assert.ok(!fs.existsSync(modelPath + '.part'));
});

test('a hand-installed model is never replaced; a managed one upgrades', async () => {
  const oldBody = Buffer.from('old-model');
  const newBody = Buffer.from('new-model-bytes');
  const { srv, url, sha } = await cdn(newBody);
  const dir = tmpdir();
  const modelPath = path.join(dir, 'panels.onnx');
  fs.writeFileSync(modelPath, oldBody);
  // No managed-sha record → hand-installed → untouched.
  const store = memStore();
  assert.equal(await ensurePanelModel({ modelPath, customPath: null, enabled: true, store, manifestUrl: url }), false);
  assert.deepEqual(fs.readFileSync(modelPath), oldBody);
  // With a stale managed sha → upgraded to the manifest version.
  store.setMeta('panelModelSha', '0'.repeat(64));
  assert.equal(await ensurePanelModel({ modelPath, customPath: null, enabled: true, store, manifestUrl: url }), true);
  assert.deepEqual(fs.readFileSync(modelPath), newBody);
  assert.equal(store._m.panelModelSha, sha);
  srv.close();
});

test('disabled ML or a custom path skips downloading entirely', async () => {
  const dir = tmpdir();
  const modelPath = path.join(dir, 'panels.onnx');
  assert.equal(await ensurePanelModel({ modelPath, customPath: null, enabled: false, store: memStore(), manifestUrl: 'http://127.0.0.1:9/x' }), false);
  assert.equal(await ensurePanelModel({ modelPath, customPath: '/my/model.onnx', enabled: true, store: memStore(), manifestUrl: 'http://127.0.0.1:9/x' }), false);
});
