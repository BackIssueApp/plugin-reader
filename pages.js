// Page access for comic archives. CBZ (the library standard) streams single
// entries straight out of the zip — no temp files, ~ms per page. CBR falls
// back to a whole-archive extract kept in a tiny LRU (RAR has no cheap random
// access; solid archives must be read in order anyway).
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
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

// ---- CBR (whole-archive LRU — RAR has no cheap random access) -----------

const rarCache = new Map(); // path → { mtime, pages: Map(name → Buffer) }
const RAR_CACHE_MAX = 2;

async function rarPages(filePath) {
  const mtime = (await fsp.stat(filePath)).mtimeMs;
  const hit = rarCache.get(filePath);
  if (hit && hit.mtime === mtime) return hit.pages;
  const buf = await fsp.readFile(filePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const extractor = await createExtractorFromData({ data: ab });
  const pages = new Map();
  for (const f of extractor.extract({}).files) {
    if (f.extraction && !f.fileHeader.flags?.directory && isImage(f.fileHeader.name)) {
      pages.set(f.fileHeader.name.replace(/\\/g, '/'), Buffer.from(f.extraction));
    }
  }
  rarCache.set(filePath, { mtime, pages });
  while (rarCache.size > RAR_CACHE_MAX) rarCache.delete(rarCache.keys().next().value);
  return pages;
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

const listCache = new Map(); // path → { mtime, names }

/** Naturally-sorted page names of the archive (cached by mtime). */
export async function listPages(filePath) {
  if (!fs.existsSync(filePath)) throw new Error('file missing on disk');
  const mtime = (await fsp.stat(filePath)).mtimeMs;
  const hit = listCache.get(filePath);
  if (hit && hit.mtime === mtime) return hit.names;
  const kind = await sniffKind(filePath);
  let names;
  if (kind === 'zip') names = await zipPageNames(filePath);
  else if (kind === 'rar') names = naturalSort([...(await rarPages(filePath)).keys()]);
  else throw new Error('not a readable comic archive');
  listCache.set(filePath, { mtime, names });
  while (listCache.size > 50) listCache.delete(listCache.keys().next().value);
  return names;
}

/** One page as { buffer, contentType }. */
export async function pageBuffer(filePath, index) {
  const names = await listPages(filePath);
  const name = names[index];
  if (!name) throw new Error('page out of range');
  const kind = await sniffKind(filePath);
  const buffer = kind === 'zip'
    ? await zipEntryBuffer(filePath, name)
    : (await rarPages(filePath)).get(name);
  const ext = path.extname(name).toLowerCase();
  return { buffer, contentType: CONTENT_TYPES[ext] || 'application/octet-stream' };
}

// Processed variants (thumbnails, phone-sized pages, margin-trimmed pages,
// WebP transcodes). sharp does the work; a small LRU keeps hot pages free.
// Width is clamped to sane steps so the cache isn't defeated by arbitrary
// values.
const resizeCache = new Map(); // `${path}:${index}:${w}:${webp}:${trim}` → { mtime, buffer, type }
const RESIZE_CACHE_MAX = 300;
const ALLOWED_WIDTHS = [200, 400, 800, 1200, 1600];

export function clampWidth(w) {
  const n = Number(w) | 0;
  if (!n) return 0;
  return ALLOWED_WIDTHS.find((a) => n <= a) || ALLOWED_WIDTHS[ALLOWED_WIDTHS.length - 1];
}

export async function pageBufferResized(filePath, index, width, { webp = false, trim = false } = {}) {
  const w = clampWidth(width);
  if (!w && !trim) return pageBuffer(filePath, index); // untouched original
  const mtime = (await fsp.stat(filePath)).mtimeMs;
  const key = `${filePath}:${index}:${w}:${webp ? 1 : 0}:${trim ? 1 : 0}`;
  const hit = resizeCache.get(key);
  if (hit && hit.mtime === mtime) return { buffer: hit.buffer, contentType: hit.type };
  const { buffer } = await pageBuffer(filePath, index);
  const { default: sharp } = await import('sharp');
  let img = sharp(buffer);
  if (trim) img = img.trim({ threshold: 25 }); // shave white scan borders
  if (w) img = img.resize({ width: w, withoutEnlargement: true });
  const type = webp ? 'image/webp' : 'image/jpeg';
  const out = webp
    ? await img.webp({ quality: 80 }).toBuffer()
    : await img.jpeg({ quality: 78 }).toBuffer();
  resizeCache.set(key, { mtime, buffer: out, type });
  while (resizeCache.size > RESIZE_CACHE_MAX) resizeCache.delete(resizeCache.keys().next().value);
  return { buffer: out, contentType: type };
}
