// Panel-model auto-download. The ONNX detector is too large to bundle with
// the plugin, so it's hosted on the BackIssue static CDN next to the Android
// APK and fetched on boot when missing. Strictly best-effort: any failure
// leaves the reader on the classical detector, and a later boot retries.
//
// Manifest (models/panels-latest.json on the CDN):
//   { "url": "...onnx", "sha256": "...", "bytes": N, "engine": "ml-box-v2" }
//
// Safety rules:
// - a custom readerPanelModel path disables auto-management entirely
// - downloads go to a .part file, verify sha256 + size, then rename — a torn
//   download can never be loaded
// - an existing file WE downloaded (sha recorded in reader_meta) upgrades
//   when the manifest changes; a file the admin placed by hand (no record)
//   is never touched

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MANIFEST_URL = 'https://static.backissue.app/panels-latest.json';
const MAX_BYTES = 400 * 1024 * 1024; // sanity ceiling

export async function ensurePanelModel({ modelPath, customPath, enabled, store, manifestUrl = MANIFEST_URL }) {
  if (!enabled || customPath) return false; // user opted out or manages their own
  try {
    const resp = await fetch(manifestUrl, { headers: { 'User-Agent': 'backissue-reader' } });
    if (!resp.ok) return false;
    const m = await resp.json();
    if (!m?.url || !/^[0-9a-f]{64}$/.test(m?.sha256 || '') || !Number.isFinite(m?.bytes) || m.bytes > MAX_BYTES) return false;

    const have = fs.existsSync(modelPath);
    const managedSha = store.getMeta?.('panelModelSha') || null;
    if (have && !managedSha) return false;          // hand-installed model: leave it alone
    if (have && managedSha === m.sha256) return false; // up to date

    console.log(`reader: ${have ? 'updating' : 'downloading'} panel model (${(m.bytes / 1048576).toFixed(0)}MB)…`);
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    const part = `${modelPath}.part`;
    const dl = await fetch(m.url, { headers: { 'User-Agent': 'backissue-reader' } });
    if (!dl.ok || !dl.body) return false;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(part);
    let received = 0;
    for await (const chunk of dl.body) {
      received += chunk.length;
      if (received > MAX_BYTES) throw new Error('model exceeds size ceiling');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok));
    }
    await new Promise((ok, bad) => out.end((e) => (e ? bad(e) : ok())));
    const gotSha = hash.digest('hex');
    if (received !== m.bytes || gotSha !== m.sha256) {
      fs.rmSync(part, { force: true });
      console.warn(`reader: panel model download failed verification (got ${received}B ${gotSha.slice(0, 8)}…)`);
      return false;
    }
    fs.renameSync(part, modelPath);
    store.setMeta?.('panelModelSha', m.sha256);
    console.log(`reader: panel model ready (${m.engine || 'unversioned'}, sha ${m.sha256.slice(0, 8)})`);
    return true;
  } catch (e) {
    console.warn('reader: panel model download failed:', e?.message || e);
    try { fs.rmSync(`${modelPath}.part`, { force: true }); } catch { /* best-effort */ }
    return false;
  }
}
