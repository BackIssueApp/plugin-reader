// Classical panel detection: find the panel rectangles on a comic page so
// readers can offer guided (panel-by-panel) viewing. No ML — comics separate
// panels with gutters in the page's background colour, so: estimate that
// colour from the borders, mask everything that differs, take the connected
// components, and their bounding boxes are the panels. Deliberately
// conservative: any page the heuristics can't call confidently returns ZERO
// panels, and clients fall back to whole-page mode for that page. Detection is
// geometry-only; reading ORDER is computed separately (and cheaply) so the
// same stored rects serve both LTR and RTL readers.
//
// All rects are normalized (0–1) so they survive any client-side resize.

const LONG_SIDE = 1000;      // detection resolution (long edge)
const DIFF_THRESHOLD = 40;   // |luma - background| that counts as content
const MIN_AREA_FRAC = 0.015; // components smaller than 1.5% of the page are noise
const MAX_PANELS = 24;       // more boxes than any real layout → noisy page
const FULL_PAGE_FRAC = 0.85; // one box covering ≥85% → full-bleed page
const MIN_COVERAGE = 0.20;   // panels covering <20% of the page → failed detection
const PAD_FRAC = 0.01;       // breathing room added around each panel

/** Detect panels in an image buffer (any format sharp reads).
 *  Returns [{x,y,w,h}] normalized, unordered — [] means "use page mode". */
export async function detectPanels(buffer) {
  const { default: sharp } = await import('sharp');
  const img = sharp(buffer).grayscale();
  const meta = await img.metadata();
  if (!meta.width || !meta.height) return [];
  const scale = LONG_SIDE / Math.max(meta.width, meta.height);
  const w = Math.max(8, Math.round(meta.width * Math.min(1, scale)));
  const h = Math.max(8, Math.round(meta.height * Math.min(1, scale)));
  const raw = await sharp(buffer).grayscale().resize(w, h, { fit: 'fill' }).raw().toBuffer();
  return detectPanelsRaw(raw, w, h);
}

/** The pure-pixels core (exported for tests): 1 byte/pixel grayscale. */
export function detectPanelsRaw(raw, w, h) {
  const bg = backgroundLuma(raw, w, h);
  // Content mask: pixels that differ enough from the gutter colour.
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = Math.abs(raw[i] - bg) > DIFF_THRESHOLD ? 1 : 0;

  const boxes = components(mask, w, h)
    .filter((b) => (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) >= MIN_AREA_FRAC * w * h);
  if (!boxes.length || boxes.length > MAX_PANELS) return [];

  // Drop boxes fully inside another (art inside a panel that touched the mask
  // separately — the outer box is the panel).
  let kept = boxes.filter((b, i) =>
    !boxes.some((o, j) => j !== i && o.x0 <= b.x0 && o.y0 <= b.y0 && o.x1 >= b.x1 && o.y1 >= b.y1
      && (o.x1 - o.x0) * (o.y1 - o.y0) > (b.x1 - b.x0) * (b.y1 - b.y0)));

  // Runt filter: real layouts don't mix full panels with confetti — boxes far
  // smaller than the median (title-text fragments, credit thumbnails) are
  // decoration, not panels. Genuine inset panels comfortably clear this bar.
  if (kept.length >= 3) {
    const byArea = kept.map((b) => (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1)).sort((a, b) => a - b);
    const median = byArea[Math.floor(byArea.length / 2)];
    kept = kept.filter((b) => (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) >= 0.12 * median);
  }

  // Overlap gate: panels in a real layout never overlap. Overlapping boxes
  // mean the page is a poster/cover/montage the detector can't segment —
  // better a clean full page than a janky tour of half-panels.
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      const a = kept[i], b = kept[j];
      const ow = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const oh = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (ow > 0 && oh > 0) {
        const inter = ow * oh;
        const smaller = Math.min((a.x1 - a.x0 + 1) * (a.y1 - a.y0 + 1), (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1));
        if (inter > 0.10 * smaller) return [];
      }
    }
  }

  // Confidence gates → page mode.
  const pageArea = w * h;
  const areas = kept.map((b) => (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1));
  const coverage = areas.reduce((a, b) => a + b, 0) / pageArea;
  if (kept.length <= 1 && areas[0] >= FULL_PAGE_FRAC * pageArea) return []; // full-bleed / splash
  if (kept.length === 1) return []; // a single sub-page box isn't a guided tour
  if (coverage < MIN_COVERAGE) return [];

  // Normalize with a little padding, clamped to the page.
  return kept.map((b) => {
    const x = Math.max(0, b.x0 / w - PAD_FRAC);
    const y = Math.max(0, b.y0 / h - PAD_FRAC);
    return {
      x: round4(x),
      y: round4(y),
      w: round4(Math.min(1, (b.x1 + 1) / w + PAD_FRAC) - x),
      h: round4(Math.min(1, (b.y1 + 1) / h + PAD_FRAC) - y),
    };
  });
}

/** Reading order via recursive XY-cut: slice the page top→bottom wherever a
 *  horizontal gutter crosses every panel, slice each band left→right (or
 *  right→left for RTL manga) at vertical gutters, and recurse. Unlike naive
 *  row clustering this gets column-spanning panels right: a tall left panel
 *  beside a stack of short right panels reads tall panel first, then the
 *  stack top-to-bottom. Clusters that no gutter separates (overlapping art)
 *  fall back to centre order. */
export function orderPanels(panels, rtl = false) {
  const out = [];
  xyCut([...panels], rtl, out);
  return out;
}

const GAP_EPS = 0.01; // detector padding makes neighbours kiss — still a gutter

function xyCut(items, rtl, out) {
  if (items.length <= 1) {
    out.push(...items);
    return;
  }
  const bands = splitByGaps(items, 'y', 'h');
  if (bands.length > 1) {
    for (const band of bands) xyCut(band, rtl, out);
    return;
  }
  const cols = splitByGaps(items, 'x', 'w');
  if (cols.length > 1) {
    if (rtl) cols.reverse();
    for (const col of cols) xyCut(col, rtl, out);
    return;
  }
  // No separating gutter either way — ambiguous cluster. Order by centres:
  // clearly-side-by-side pairs read across, everything else top-to-bottom.
  items.sort((a, b) => {
    const vOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (vOverlap > 0.5 * Math.min(a.h, b.h)) {
      const dx = (a.x + a.w / 2) - (b.x + b.w / 2);
      return rtl ? -dx : dx;
    }
    return (a.y + a.h / 2) - (b.y + b.h / 2);
  });
  out.push(...items);
}

/** Group items into maximal runs along one axis, split where a gap (or an
 *  overlap smaller than GAP_EPS) separates consecutive extents. */
function splitByGaps(items, posKey, sizeKey) {
  const sorted = [...items].sort((a, b) => a[posKey] - b[posKey]);
  const groups = [];
  let cur = [];
  let end = -Infinity;
  for (const it of sorted) {
    if (cur.length && it[posKey] >= end - GAP_EPS) {
      groups.push(cur);
      cur = [];
    }
    cur.push(it);
    end = Math.max(end, it[posKey] + it[sizeKey]);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/** Gutter colour estimate: median luma of a border band (2% of each edge).
 *  The gutters extend to the page edge on most layouts; a median shrugs off
 *  art that bleeds over one edge. */
function backgroundLuma(raw, w, h) {
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  const samples = [];
  for (let y = 0; y < h; y++) {
    const edgeRow = y < band || y >= h - band;
    if (edgeRow) {
      for (let x = 0; x < w; x += 3) samples.push(raw[y * w + x]);
    } else {
      for (let x = 0; x < band; x++) samples.push(raw[y * w + x]);
      for (let x = w - band; x < w; x++) samples.push(raw[y * w + x]);
    }
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? 255;
}

/** 4-connected components over the mask (iterative flood fill). */
function components(mask, w, h) {
  const visited = new Uint8Array(w * h);
  const boxes = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || visited[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w, y = (i / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      // 4-neighbours
      if (x > 0 && mask[i - 1] && !visited[i - 1]) { visited[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !visited[i + 1]) { visited[i + 1] = 1; stack[sp++] = i + 1; }
      if (y > 0 && mask[i - w] && !visited[i - w]) { visited[i - w] = 1; stack[sp++] = i - w; }
      if (y < h - 1 && mask[i + w] && !visited[i + w]) { visited[i + w] = 1; stack[sp++] = i + w; }
    }
    boxes.push({ x0, y0, x1, y1 });
  }
  return boxes;
}

const round4 = (n) => Math.round(n * 10000) / 10000;
