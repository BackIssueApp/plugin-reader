// Shared panel-detection cache client. Panel layouts are keyed by a hash of
// each PAGE's image bytes (not the archive — repacking/retagging changes the
// zip but not the pages), so a layout detected or hand-corrected on one
// BackIssue server can be served to every other server holding the same page.
//
// This is strictly opt-in (readerPanelShare) and entirely optional: if the
// cache is unreachable or sharing is off, detection falls back to running
// locally exactly as before. Nothing here blocks the reader.
//
// Contract (served by CloneVine):
//   POST {base}/api/panels/register            -> { key }
//   POST {base}/api/panels/lookup  { hashes }  -> { hits: { <hash>: entry } }
//   POST {base}/api/panels/submit  { key, entries }
//   POST {base}/api/panels/vote    { key, hash, dir }
// where an entry is { panels, engine, source } and a submit/vote entry adds
// { hash, dhash?, page_w?, page_h? }. `source` is 'human' or 'model'.

import crypto from 'node:crypto';

/** SHA-256 of a page's raw image bytes — stable across repack/retag. */
export function pageHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 256-bit difference hash (16×16) of a page, for future fuzzy matching of
 *  re-encoded/resized copies. Sent now, matched later — cheap to compute and
 *  costs nothing to store. Needs a sharp instance (grayscale 17×16). */
export async function pageDhash(sharp, buffer) {
  try {
    const w = 17, h = 16;
    const raw = await sharp(buffer).grayscale().resize(w, h, { fit: 'fill' }).raw().toBuffer();
    const bits = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w - 1; x++) {
        bits.push(raw[y * w + x] > raw[y * w + x + 1] ? 1 : 0);
      }
    }
    let hex = '';
    for (let i = 0; i < bits.length; i += 4) {
      hex += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16);
    }
    return hex;
  } catch { return null; }
}

/** Create a client bound to a base URL + persisted instance key.
 *  `store` supplies getKey()/setKey() so the key survives restarts
 *  (reader_meta). All network methods resolve to a safe fallback on error. */
export function createPanelCache({ base, store, enabled }) {
  const root = String(base || '').replace(/\/+$/, '');
  let keyPromise;

  const on = () => enabled() && !!root;

  async function key() {
    if (!on()) return null;
    return (keyPromise ??= (async () => {
      const saved = store.getMeta?.('panelShareKey');
      if (saved) return saved;
      try {
        const r = await fetch(`${root}/api/panels/register`, { method: 'POST' });
        if (!r.ok) return null;
        const k = (await r.json())?.key;
        if (k) store.setMeta?.('panelShareKey', k);
        return k || null;
      } catch { return null; }
    })());
  }

  return {
    enabled: on,
    /** hashes[] -> Map(hash -> {panels, engine, source}); empty on any failure. */
    async lookup(hashes) {
      const out = new Map();
      if (!on() || !hashes.length) return out;
      try {
        const r = await fetch(`${root}/api/panels/lookup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hashes }),
        });
        if (!r.ok) return out;
        const hits = (await r.json())?.hits || {};
        for (const [h, entry] of Object.entries(hits)) {
          if (entry && Array.isArray(entry.panels)) out.set(h, entry);
        }
      } catch { /* offline → treat as all-miss */ }
      return out;
    },
    /** entries: [{hash, dhash?, engine, source, panels, page_w?, page_h?}] */
    async submit(entries) {
      if (!on() || !entries.length) return;
      const k = await key();
      if (!k) return;
      try {
        await fetch(`${root}/api/panels/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: k, entries }),
        });
      } catch { /* best-effort; a lost submission just isn't shared */ }
    },
    /** dir: +1 confirm, -1 reject. */
    async vote(hash, dir) {
      if (!on()) return;
      const k = await key();
      if (!k) return;
      try {
        await fetch(`${root}/api/panels/vote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: k, hash, dir }),
        });
      } catch { /* best-effort */ }
    },
  };
}
