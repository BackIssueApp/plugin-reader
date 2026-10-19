// Page access for comic archives. CBZ (the library standard) streams single
// entries straight out of the zip — no temp files, ~ms per page. CBR pulls
// the cover out on its own and otherwise falls back to a whole-archive extract
// kept in a tiny LRU (RAR has no cheap random access; solid archives must be
// read in order anyway).
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import yauzl from 'yauzl';
import { createExtractorFromData } from 'node-unrar-js';

const IMG_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
export const CONTENT_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif',
};

// Natural sort so page_2 < page_10 (scanners are wildly inconsistent).
export function naturalSort(names) {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...names].sort((a, b) => collator.compare(a, b));
}

const isImage = (name) => IMG_RE.test(name) && !/__MACOSX|\.DS_Store/i.test(name);

// ---- CBZ ---------------------------------------------------------------

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (err, zip) =>
      err ? reject(err) : resolve(zip));
  });
}

/** All image entry names in the zip, naturally sorted. */
function zipPageNames(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const names = [];
      zip.on('entry', (e) => {
        if (!/\/$/.test(e.fileName) && isImage(e.fileName)) names.push(e.fileName);
        zip.readEntry();
      });
      zip.on('end', () => resolve(naturalSort(names)));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

/** Read one entry of the zip into a Buffer. */
function zipEntryBuffer(filePath, entryName) {
  return new Promise((resolve, reject) => {
    openZip(filePath).then((zip) => {
      zip.on('entry', (e) => {
        if (e.fileName !== entryName) return zip.readEntry();
        zip.openReadStream(e, (err, stream) => {
          if (err) { zip.close(); return reject(err); }
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => { zip.close(); resolve(Buffer.concat(chunks)); });
          stream.on('error', (e2) => { zip.close(); reject(e2); });
        });
      });
      zip.on('end', () => { zip.close(); reject(new Error('page entry not found')); });
      zip.on('error', reject);
      zip.readEntry();
    }, reject);
  });
}

// ---- CBR ----------------------------------------------------------------
// node-unrar-js wants the whole archive in memory, and decompresses on core's
// worker threads where the app has them (0.9.3+; on the main thread before
// that). Either way CBR access is fenced: a size ceiling (the same budget the app's
// converter uses), at most two archives in the WASM at once, one extraction per
// file however many requests ask for it (opening an issue fires the page plus
// three preloads), and a yield between entries so a big archive doesn't freeze
// the event loop. The cover is pulled out on its own — the extractor stops
// after that entry — so a CBR series' cover grid never decompresses whole
// archives; reading past the cover extracts the archive once into a tiny LRU.

// A Buffer from fs.readFile of a non-tiny file owns its whole ArrayBuffer, so
// it can be handed over without a copy; only pooled/sliced buffers need one.
const toArrayBuffer = (buf) =>
  (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength)
    ? buf.buffer
    : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
// Wrap an extracted Uint8Array without copying it (it is already a JS-owned
// copy out of the WASM heap).
const asBuffer = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

// ~5% of the host's (or container's) memory, clamped to [400MB, 1GB];
// MAX_RAR_MB overrides — the same rule the app applies to its own RAR work.
function computeMaxRarBytes() {
  const envMb = Number(process.env.MAX_RAR_MB);
  if (Number.isFinite(envMb) && envMb > 0) return Math.round(envMb * 1024 * 1024);
  const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
  const budget = (Number.isFinite(constrained) && constrained > 0) ? constrained : os.totalmem();
  const FLOOR = 400 * 1024 * 1024, CEILING = 1024 * 1024 * 1024;
  return Math.max(FLOOR, Math.min(CEILING, Math.round(budget * 0.05)));
}
export const MAX_RAR_BYTES = computeMaxRarBytes();

/** A small FIFO semaphore: run fn while holding one of `slots`. */
export function makeGate(slots) {
  let active = 0;
  const queue = [];
  const gate = (fn) => new Promise((resolve, reject) => {
    const run = () => {
      active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        active--;
        const next = queue.shift();
        if (next) next();
      });
    };
    if (active < slots) run(); else queue.push(run);
  });
  gate.stats = () => ({ active, queued: queue.length });
  return gate;
}
const withRarSlot = makeGate(2);

// One promise per key while it runs; later callers share it.
function sharedFlight(map, key, fn) {
  const hit = map.get(key);
  if (hit) return hit;
  const p = Promise.resolve().then(fn).finally(() => map.delete(key));
  map.set(key, p);
  return p;
}

const rarCache = new Map();   // path → { mtime, pages: Map(name → Buffer) }
const RAR_CACHE_MAX = 2;
const rarHeads = new Map();   // path → { mtime, names, first } (page list + cover)
const RAR_HEADS_MAX = 64;
const rarFlights = new Map(); // `${what}|${path}|${mtime}` → Promise
let rarExtractions = 0;       // whole-archive extractions started (tests watch this)
export const rarStats = () => ({ extractions: rarExtractions, ...withRarSlot.stats() });

const rarName = (h) => h.name.replace(/\\/g, '/');

// BackIssue 0.9.3+ decodes RAR on worker threads (listRarEntries /
// extractRarEntries in core's archive.js): the main thread stays free and a
// decoder crash can't take the app down. Older cores lack them, so this falls
// back to decoding here. Page order stays ours either way.
let coreRar = import('../../src/archive.js')
  .then((m) => (typeof m.listRarEntries === 'function' && typeof m.extractRarEntries === 'function' ? m : null))
  .catch(() => null);
/** Tests: decode inline (as on an older core) or through core again. Clears the CBR caches. */
export async function useCoreRarForTests(on) {
  const real = await import('../../src/archive.js');
  coreRar = Promise.resolve(on ? real : null);
  rarCache.clear(); rarHeads.clear(); listCache.clear();
}

function checkRarSize(st) {
  if (st.size > MAX_RAR_BYTES) {
    const mb = (b) => Math.round(b / 1024 / 1024);
    throw new Error(`archive too large to open in the reader (${mb(st.size)}MB > ${mb(MAX_RAR_BYTES)}MB — raise it with MAX_RAR_MB)`);
  }
}
async function openRar(filePath, st) {
  checkRarSize(st);
  const buf = await fsp.readFile(filePath);
  return createExtractorFromData({ data: toArrayBuffer(buf) });
}

// node-unrar-js routes its WASM file callbacks through ONE module-global
// extractor (whichever was created last). Steps of two extractions — ours, or
// the app's own converter — can interleave across our yields, so ours is
// pinned back before every step.
const pin = (ex) => { if (ex.unrar) ex.unrar.extractor = ex; };
async function eachExtracted(ex, opts, onFile) {
  pin(ex);
  const it = ex.extract(opts).files;
  for (;;) {
    pin(ex);
    const { value, done } = it.next();
    if (done) return;
    onFile(value);
    await new Promise((r) => setImmediate(r));
  }
}

/** Page names + the cover (first page) — one read, no full decompress. */
function rarHead(filePath, st) {
  const hit = rarHeads.get(filePath);
  if (hit && hit.mtime === st.mtimeMs) return Promise.resolve(hit);
  return sharedFlight(rarFlights, `head|${filePath}|${st.mtimeMs}`, () => withRarSlot(async () => {
    const core = await coreRar;
    if (core) {
      checkRarSize(st);
      const raw = new Map(); // normalized → name as stored in the archive
      for (const n of await core.listRarEntries(filePath)) {
        if (isImage(n)) raw.set(rarName({ name: n }), n);
      }
      const names = naturalSort([...raw.keys()]);
      const first = names.length ? (await core.extractRarEntries(filePath, [raw.get(names[0])])).get(raw.get(names[0])) ?? null : null;
      return rememberHead(filePath, { mtime: st.mtimeMs, names, first });
    }
    const ex = await openRar(filePath, st);
    pin(ex);
    const raw = new Map(); // normalized → name as stored in the archive
    for (const h of ex.getFileList().fileHeaders) {
      if (!h.flags?.directory && isImage(h.name)) raw.set(rarName(h), h.name);
    }
    const names = naturalSort([...raw.keys()]);
    let first = null;
    if (names.length) {
      await eachExtracted(ex, { files: [raw.get(names[0])] }, (f) => {
        if (f.extraction) first = asBuffer(f.extraction);
      });
    }
    return rememberHead(filePath, { mtime: st.mtimeMs, names, first });
  }));
}
function rememberHead(filePath, head) {
  rarHeads.set(filePath, head);
  while (rarHeads.size > RAR_HEADS_MAX) rarHeads.delete(rarHeads.keys().next().value);
  return head;
}

/** Every page of the archive, extracted once and kept in a tiny LRU. */
function rarPages(filePath, st) {
  const hit = rarCache.get(filePath);
  if (hit && hit.mtime === st.mtimeMs) return Promise.resolve(hit.pages);
  return sharedFlight(rarFlights, `all|${filePath}|${st.mtimeMs}`, () => withRarSlot(async () => {
    rarExtractions++;
    const pages = new Map();
    const core = await coreRar;
    if (core) {
      checkRarSize(st);
      for (const [n, buf] of await core.extractRarEntries(filePath)) {
        if (isImage(n)) pages.set(rarName({ name: n }), buf);
      }
    } else {
      const ex = await openRar(filePath, st);
      await eachExtracted(ex, {}, (f) => {
        if (f.extraction && !f.fileHeader.flags?.directory && isImage(f.fileHeader.name)) {
          pages.set(rarName(f.fileHeader), asBuffer(f.extraction));
        }
      });
    }
    rarCache.delete(filePath);
    rarCache.set(filePath, { mtime: st.mtimeMs, pages });
    while (rarCache.size > RAR_CACHE_MAX) rarCache.delete(rarCache.keys().next().value);
    return pages;
  }));
}

// ---- Public API ----------------------------------------------------------

/** Real container from magic bytes — extensions lie constantly. */
export async function sniffKind(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const { buffer } = await fh.read(Buffer.alloc(4), 0, 4, 0);
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) return 'zip';
    if (buffer.toString('latin1') === 'Rar!') return 'rar';
    return null;
  } finally { await fh.close(); }
}

/** One stat per request, shared by everything below (callers may pass it in). */
export async function statFile(filePath) {
  try { return await fsp.stat(filePath); }
  catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') throw new Error('file missing on disk');
    throw e;
  }
}
/** A short fingerprint of the file's bytes (mtime + size) for URLs and ETags. */
export const fileVersionOf = (st) => (st ? Math.round(st.mtimeMs).toString(36) + '-' + st.size.toString(36) : '0');

const listCache = new Map(); // path → { mtime, kind, names }

async function listing(filePath, st) {
  const hit = listCache.get(filePath);
  if (hit && hit.mtime === st.mtimeMs) return hit;
  const kind = await sniffKind(filePath);
  let names;
  if (kind === 'zip') names = await zipPageNames(filePath);
  else if (kind === 'rar') names = (await rarHead(filePath, st)).names;
  else throw new Error('not a readable comic archive');
  const entry = { mtime: st.mtimeMs, kind, names };
  listCache.set(filePath, entry);
  while (listCache.size > 50) listCache.delete(listCache.keys().next().value);
  return entry;
}

/** Naturally-sorted page names of the archive (cached by mtime). */
export async function listPages(filePath, { stat } = {}) {
  return (await listing(filePath, stat || await statFile(filePath))).names;
}

/** One page as { buffer, contentType }. */
export async function pageBuffer(filePath, index, { stat } = {}) {
  const st = stat || await statFile(filePath);
  const { kind, names } = await listing(filePath, st);
  const name = names[index];
  if (!name) { const e = new Error('page out of range'); e.code = 'ENOPAGE'; throw e; }
  let buffer;
  if (kind === 'zip') buffer = await zipEntryBuffer(filePath, name);
  else {
    const all = rarCache.get(filePath);
    if (all && all.mtime === st.mtimeMs) buffer = all.pages.get(name);
    else if (index === 0) buffer = (await rarHead(filePath, st)).first;
    else buffer = (await rarPages(filePath, st)).get(name);
  }
  const ext = path.extname(name).toLowerCase();
  return { buffer, contentType: CONTENT_TYPES[ext] || 'application/octet-stream' };
}

// Processed variants (thumbnails, phone-sized pages, margin-trimmed pages,
// WebP transcodes). sharp does the work; a small LRU keeps hot pages free.
// Width is clamped to sane steps so the cache isn't defeated by arbitrary
// values.
const resizeCache = new Map(); // `${path}:${index}:${w}:${webp}:${trim}` → { mtime, buffer, type }
const RESIZE_CACHE_BYTES = 50 * 1024 * 1024; // bounded by bytes: a 1600px page weighs ~50 covers
let resizeBytes = 0;
const ALLOWED_WIDTHS = [200, 400, 800, 1200, 1600];

function rememberResized(key, entry) {
  const old = resizeCache.get(key);
  if (old) { resizeBytes -= old.buffer.length; resizeCache.delete(key); }
  resizeCache.set(key, entry);
  resizeBytes += entry.buffer.length;
  while (resizeBytes > RESIZE_CACHE_BYTES && resizeCache.size > 1) {
    const [k, v] = resizeCache.entries().next().value;
    resizeCache.delete(k);
    resizeBytes -= v.buffer.length;
  }
}

// sharp runs on the libuv pool, which file reads share, so a cover grid's
// dozens of cold decodes queue here instead of all decoding at once (and
// starving the stats/reads behind them). One pool thread is left for I/O.
const POOL = Number(process.env.UV_THREADPOOL_SIZE) || 4;
const CPUS = (os.availableParallelism?.() || os.cpus().length || 1);
const withSharpSlot = makeGate(Math.max(1, Math.min(CPUS, POOL - 1)));
const resizeFlights = new Map(); // `${key}|${mtime}` → Promise
export const resizeStats = () => ({ cachedBytes: resizeBytes, cached: resizeCache.size, ...withSharpSlot.stats() });

let sharpMod = null;
async function loadSharp() {
  if (!sharpMod) {
    sharpMod = (await import('sharp')).default;
    // Every input is decoded once and its output cached by us; libvips' own
    // operation cache would only hold decoded pixels nobody asks for again.
    try { sharpMod.cache(false); } catch { /* older sharp */ }
  }
  return sharpMod;
}

// On-disk copy of every processed variant, so a restart (or the memory LRU
// rolling over) does not send the next Home screen back to the archives:
// 30-odd shelf covers read cold off network storage and resized took ~2.5 s,
// warm they take ~30 ms. Keyed by a hash of path/index/width/format AND the
// file's mtime, so a re-downloaded file simply produces a new name. Bounded
// by entry count; the oldest files go when the cap is passed.
let diskCacheDir = null;
let diskWrites = 0;
const DISK_CACHE_MAX = 20_000;   // ~20 KB per shelf cover → a few hundred MB at most
const DISK_CACHE_KEEP = 16_000;
export function setPageCacheDir(dir) {
  diskCacheDir = dir || null;
  if (diskCacheDir) { try { fs.mkdirSync(diskCacheDir, { recursive: true }); } catch { diskCacheDir = null; } }
}
export function pageCacheDir() { return diskCacheDir; }
function diskPathFor(key, mtime, webp) {
  if (!diskCacheDir) return null;
  const h = crypto.createHash('sha1').update(`${key}|${Math.round(mtime)}`).digest('hex');
  return path.join(diskCacheDir, `${h}.${webp ? 'webp' : 'jpg'}`);
}
async function diskRead(file) {
  if (!file) return null;
  try { return await fsp.readFile(file); } catch { return null; }
}
async function diskWrite(file, buffer) {
  if (!file) return;
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, file);
    if (++diskWrites % 200 === 0) await pruneDiskCache();
  } catch { /* a cache miss next time, nothing worse */ }
}
async function pruneDiskCache() {
  if (!diskCacheDir) return;
  try {
    const names = (await fsp.readdir(diskCacheDir)).filter((n) => /\.(webp|jpg)$/.test(n));
    if (names.length <= DISK_CACHE_MAX) return;
    // In batches: 20k stats at once would occupy the whole libuv pool.
    const stats = [];
    for (let i = 0; i < names.length; i += 32) {
      const batch = await Promise.all(names.slice(i, i + 32).map((n) =>
        fsp.stat(path.join(diskCacheDir, n)).then((s) => ({ n, t: s.mtimeMs }), () => null)));
      for (const s of batch) if (s) stats.push(s);
    }
    stats.sort((a, b) => a.t - b.t);
    for (const s of stats.slice(0, stats.length - DISK_CACHE_KEEP)) await fsp.unlink(path.join(diskCacheDir, s.n)).catch(() => {});
  } catch { /* ignore */ }
}
/** True when a processed variant is already on disk (used by the cover warm job to skip work). */
export async function pageVariantCached(filePath, index, width, { webp = false, trim = false } = {}) {
  const w = clampWidth(width);
  if (!diskCacheDir || (!w && !trim)) return false;
  try {
    const mtime = (await fsp.stat(filePath)).mtimeMs;
    const file = diskPathFor(`${filePath}:${index}:${w}:${webp ? 1 : 0}:${trim ? 1 : 0}`, mtime, webp);
    await fsp.access(file);
    return true;
  } catch { return false; }
}

export function clampWidth(w) {
  const n = Number(w) | 0;
  if (!n) return 0;
  return ALLOWED_WIDTHS.find((a) => n <= a) || ALLOWED_WIDTHS[ALLOWED_WIDTHS.length - 1];
}

export async function pageBufferResized(filePath, index, width, { webp = false, trim = false, stat } = {}) {
  const w = clampWidth(width);
  const st = stat || await statFile(filePath);
  if (!w && !trim) return pageBuffer(filePath, index, { stat: st }); // untouched original
  const mtime = st.mtimeMs;
  const key = `${filePath}:${index}:${w}:${webp ? 1 : 0}:${trim ? 1 : 0}`;
  const hit = resizeCache.get(key);
  if (hit && hit.mtime === mtime) {
    rememberResized(key, hit); // refresh its LRU position
    return { buffer: hit.buffer, contentType: hit.type };
  }
  // Concurrent requests for the same variant (grid + preload) share one render.
  return sharedFlight(resizeFlights, `${key}|${mtime}`, async () => {
    const type = webp ? 'image/webp' : 'image/jpeg';
    const diskFile = diskPathFor(key, mtime, webp);
    const onDisk = await diskRead(diskFile);
    if (onDisk) {
      rememberResized(key, { mtime, buffer: onDisk, type });
      return { buffer: onDisk, contentType: type };
    }
    const out = await withSharpSlot(async () => {
      const { buffer } = await pageBuffer(filePath, index, { stat: st });
      const sharp = await loadSharp();
      let img = sharp(buffer);
      if (trim) img = img.trim({ threshold: 25 }); // shave white scan borders
      if (w) img = img.resize({ width: w, withoutEnlargement: true });
      return webp
        ? img.webp({ quality: 80 }).toBuffer()
        : img.jpeg({ quality: 78 }).toBuffer();
    });
    rememberResized(key, { mtime, buffer: out, type });
    diskWrite(diskFile, out); // fire-and-forget; the response never waits on the disk
    return { buffer: out, contentType: type };
  });
}
