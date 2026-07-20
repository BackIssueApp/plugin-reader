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
    if (conf < CONFIDENCE) continue;
    const cx = dets[i * 4], cy = dets[i * 4 + 1], w = dets[i * 4 + 2], h = dets[i * 4 + 3];
    const x = Math.max(0, Math.min(1, cx - w / 2));
    const y = Math.max(0, Math.min(1, cy - h / 2));
    const box = {
      x: round4(x),
      y: round4(y),
      w: round4(Math.max(0, Math.min(1, cx + w / 2)) - x),
      h: round4(Math.max(0, Math.min(1, cy + h / 2)) - y),
      conf,
    };
    if (box.w * box.h < 0.005) continue; // speck, not a panel
    boxes.push(box);
  }
  // DETR needs no NMS in theory; in practice near-duplicates appear around the
  // threshold. Keep the higher-confidence box of any pair overlapping >70%.
  boxes.sort((a, b) => b.conf - a.conf);
  const kept = [];
  for (const b of boxes) {
    if (!kept.some((k) => iou(k, b) > 0.7)) kept.push(b);
  }
  if (kept.length < 2 || kept.length > MAX_PANELS) return [];
  // Completeness gate: a real layout's panels cover most of the page. When
  // the union of what we detected covers less than half, the model missed
  // panels (art bleeding across gutters defeats it) — and a guided tour that
  // silently skips content is worse than reading the whole page.
  if (unionArea(kept) < 0.45) return [];
  return kept.map(({ x, y, w, h }) => ({ x, y, w, h }));
}

/** Fraction of the page covered by the union of boxes (32×32 grid — exact
 *  enough for a half-page threshold, immune to overlap double-counting). */
function unionArea(boxes) {
  const G = 32;
  const grid = new Uint8Array(G * G);
  for (const b of boxes) {
    const x0 = Math.floor(b.x * G), x1 = Math.min(G, Math.ceil((b.x + b.w) * G));
    const y0 = Math.floor(b.y * G), y1 = Math.min(G, Math.ceil((b.y + b.h) * G));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) grid[y * G + x] = 1;
  }
  let on = 0;
  for (let i = 0; i < grid.length; i++) on += grid[i];
  return on / (G * G);
}

function iou(a, b) {
  const ow = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oh = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ow <= 0 || oh <= 0) return 0;
  const inter = ow * oh;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

const round4 = (n) => Math.round(n * 10000) / 10000;
