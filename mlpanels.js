// ML panel detection: an RF-DETR object-detection model (ONNX) trained for
// comic panels. Complements panels.js — the classical detector needs clean
// same-colour gutters, while the model handles black gutters, borderless
// cartoons, and low-contrast layouts. Everything here is optional twice over:
// onnxruntime-node is an optionalDependency, and the model file ships
// separately (it is large) — when either is missing, callers fall back to the
// classical detector and nothing else changes.
//
// Model contract (fixed at training time — see the training pipeline's
// export): input `input` [1,3,384,384] float32, image squash-resized to
// 384×384, scaled to 0-1, ImageNet-normalized. Outputs `dets` [1,300,4]
// (cx,cy,w,h normalized to the page) and `labels` [1,300,C] logits where the
// panel class is column 0 — confidence = sigmoid(logit).

const INPUT_SIZE = 384;
const CONFIDENCE = 0.4;  // eval'd operating point: 0.5 drops real panels, 0.3 over-detects
const MAX_PANELS = 24;   // same "no real layout has more" cap as the classical path
// Below CONFIDENCE a box only ever completes a layout (see assemble()). The
// values were chosen on hand-verified pages: against the plain 0.4 cut they
// turned 33 of 352 pages from wrong or page mode into an exact layout and
// broke 11.
const FILL_CONFIDENCE = 0.1;    // floor for a completing box
const FILL_MIN_AREA = 0.02;     // of the page; smaller low-confidence boxes are noise
const FILL_MAX_CLAIMED = 0.1;   // share of a completing box already covered by accepted panels
const MIN_COVERAGE = 0.45;      // of the page
const MIN_HULL_COVERAGE = 0.85; // of the panels' own bounding box
const GRID = 64;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/** Lazy ML detector bound to a model path. `detect` resolves to null when ML
 *  is unavailable (no runtime, no model file) — callers treat null as "use
 *  the classical detector"; [] is a real "page mode" verdict. */
export function createMlDetector(modelPath) {
  let sessionPromise; // set on first use; RESET when init fails so a model
                      // downloaded after boot is picked up without a restart
  const init = async () => {
    const fs = await import('node:fs');
    if (!modelPath || !fs.existsSync(modelPath)) return null;
    try {
      const ort = await import('onnxruntime-node');
      const session = await ort.InferenceSession.create(modelPath);
      return { ort, session };
    } catch (e) {
      console.warn('reader: onnxruntime unavailable, using classical panel detection:', e?.message || e);
      return null;
    }
  };
  const get = async () => {
    const ctx = await (sessionPromise ??= init());
    if (!ctx) sessionPromise = undefined; // absent model/runtime: retry next call
    return ctx;
  };
  let idPromise;

  return {
    async available() {
      return (await get()) != null;
    },
    /** Short content id of the loaded model (sha256 prefix) — cache keys
     *  embed it so swapping the model file invalidates old layouts. */
    async modelId() {
      if (!(await get())) return null;
      return (idPromise ??= (async () => {
        const { createHash } = await import('node:crypto');
        const fs = await import('node:fs');
        return createHash('sha256').update(fs.readFileSync(modelPath)).digest('hex').slice(0, 8);
      })());
    },
    /** buffer (any sharp-readable image) → ordered-agnostic normalized rects,
     *  [] for page-mode pages, null when ML can't run. */
    async detect(buffer) {
      const ctx = await get();
      if (!ctx) return null;
      const { default: sharp } = await import('sharp');
      const raw = await sharp(buffer)
        .removeAlpha()
        .resize(INPUT_SIZE, INPUT_SIZE, { fit: 'fill', kernel: 'linear' })
        .raw()
        .toBuffer();
      const input = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
      const px = INPUT_SIZE * INPUT_SIZE;
      for (let i = 0; i < px; i++) {
        for (let c = 0; c < 3; c++) {
          input[c * px + i] = (raw[i * 3 + c] / 255 - MEAN[c]) / STD[c];
        }
      }
      const feeds = { input: new ctx.ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]) };
      const out = await ctx.session.run(feeds);
      return postprocess(out.dets.data, out.labels.data, out.labels.dims[2]);
    },
  };
}

/** Pure postprocessing (exported for tests): DETR outputs → normalized rects.
 *  Mirrors the classical detector's semantics: a confident multi-panel layout
 *  or nothing — single boxes and empty results mean "read the whole page". */
export function postprocess(dets, logits, numClasses = 2) {
  const boxes = [];
  const n = dets.length / 4;
  for (let i = 0; i < n; i++) {
    const conf = 1 / (1 + Math.exp(-logits[i * numClasses]));
    if (conf < FILL_CONFIDENCE) continue;
    const cx = dets[i * 4], cy = dets[i * 4 + 1], w = dets[i * 4 + 2], h = dets[i * 4 + 3];
    const x = Math.max(0, Math.min(1, cx - w / 2));
    const y = Math.max(0, Math.min(1, cy - h / 2));
    boxes.push({
      x: round4(x),
      y: round4(y),
      w: round4(Math.max(0, Math.min(1, cx + w / 2)) - x),
      h: round4(Math.max(0, Math.min(1, cy + h / 2)) - y),
      conf,
    });
  }
  return assemble(boxes);
}

/** Scored boxes ({x,y,w,h,conf}, normalized) → the page's layout, or [] for
 *  page mode. Exported so the rule can be evaluated on recorded detections.
 *
 *  Two passes in one walk down the confidence order. A box at CONFIDENCE or
 *  above is a panel on its own evidence. Below it, a box is admitted only as
 *  the missing piece of a layout: the model finds nearly every panel but
 *  scores some of them low, so a low box that claims page area no accepted
 *  panel covers is far more often a real panel than noise, while a low box
 *  on top of accepted panels is a duplicate or a merge of two of them. */
export function assemble(boxes) {
  const cand = boxes
    .filter((b) => b.conf >= FILL_CONFIDENCE && b.w * b.h >= 0.005) // smaller is a speck, not a panel
    .sort((a, b) => b.conf - a.conf);
  const cover = new Uint8Array(GRID * GRID);
  const kept = [];
  for (const b of cand) {
    // DETR needs no NMS in theory; in practice near-duplicates appear. Keep
    // the higher-confidence box of any pair overlapping >70%.
    if (kept.some((k) => iou(k, b) > 0.7)) continue;
    const c = cells(b);
    if (b.conf < CONFIDENCE) {
      if (b.w * b.h < FILL_MIN_AREA) continue;
      if (covered(cover, c) / area(c) > FILL_MAX_CLAIMED) continue;
      // A box that swallows an accepted panel is two panels read as one.
      if (kept.some((k) => shared(c, k.cells) / area(k.cells) > 0.5)) continue;
    }
    for (let y = c.y0; y < c.y1; y++) cover.fill(1, y * GRID + c.x0, y * GRID + c.x1);
    kept.push({ ...b, cells: c });
  }
  if (kept.length < 2 || kept.length > MAX_PANELS) return [];
  // Completeness gates: a guided tour that silently skips content is worse
  // than reading the whole page. The panels must cover close to half the
  // page, and they must leave no panel-sized hole inside their own bounding
  // box — a hole there is a panel the model missed.
  const page = { x0: 0, y0: 0, x1: GRID, y1: GRID };
  if (covered(cover, page) / area(page) < MIN_COVERAGE) return [];
  const x0 = Math.min(...kept.map((k) => k.x)), y0 = Math.min(...kept.map((k) => k.y));
  const x1 = Math.max(...kept.map((k) => k.x + k.w)), y1 = Math.max(...kept.map((k) => k.y + k.h));
  const hull = cells({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  if (covered(cover, hull) / area(hull) < MIN_HULL_COVERAGE) return [];
  return kept.map(({ x, y, w, h }) => ({ x, y, w, h }));
}

// Coverage is counted on a GRID×GRID raster of the page: exact enough for the
// thresholds above and immune to double-counting where panels overlap.
function cells(b) {
  const x0 = Math.min(GRID, Math.round(b.x * GRID)), y0 = Math.min(GRID, Math.round(b.y * GRID));
  return {
    x0,
    y0,
    x1: Math.min(GRID, Math.max(x0 + 1, Math.round((b.x + b.w) * GRID))),
    y1: Math.min(GRID, Math.max(y0 + 1, Math.round((b.y + b.h) * GRID))),
  };
}
const area = (c) => Math.max(1, (c.x1 - c.x0) * (c.y1 - c.y0));
const shared = (a, b) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
function covered(cover, c) {
  let on = 0;
  for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) on += cover[y * GRID + x];
  return on;
}

function iou(a, b) {
  const ow = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oh = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ow <= 0 || oh <= 0) return 0;
  const inter = ow * oh;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

const round4 = (n) => Math.round(n * 10000) / 10000;
