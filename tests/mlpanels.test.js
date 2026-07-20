// ML panel detection: the pure postprocessing (DETR tensors → normalized
// rects) always runs; the full ONNX path runs only when the runtime and a
// model file are actually present (they're optional by design).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMlDetector, postprocess } from '../mlpanels.js';

// Build DETR-shaped outputs: boxes as {x,y,w,h} normalized + confidence.
// logit column 0 is the panel class; sigmoid(4) ≈ 0.98, sigmoid(-4) ≈ 0.02.
function tensors(boxes) {
  const dets = new Float32Array(boxes.length * 4);
  const logits = new Float32Array(boxes.length * 2);
  boxes.forEach((b, i) => {
    dets[i * 4] = b.x + b.w / 2;
    dets[i * 4 + 1] = b.y + b.h / 2;
    dets[i * 4 + 2] = b.w;
    dets[i * 4 + 3] = b.h;
    logits[i * 2] = Math.log(b.conf / (1 - b.conf));
    logits[i * 2 + 1] = -4;
  });
  return { dets, logits };
}

test('postprocess: confident boxes pass, low-confidence dropped', () => {
  const { dets, logits } = tensors([
    { x: 0.03, y: 0.03, w: 0.45, h: 0.94, conf: 0.9 },
    { x: 0.52, y: 0.03, w: 0.45, h: 0.94, conf: 0.7 },
    { x: 0.4, y: 0.4, w: 0.2, h: 0.2, conf: 0.1 }, // below threshold
  ]);
  const out = postprocess(dets, logits);
  assert.equal(out.length, 2);
  assert.ok(Math.abs(out[0].x - 0.03) < 0.001 && Math.abs(out[0].w - 0.45) < 0.001);
});

test('postprocess: near-duplicate boxes deduped, higher confidence wins', () => {
  const { dets, logits } = tensors([
    { x: 0.03, y: 0.03, w: 0.94, h: 0.45, conf: 0.9 },
    { x: 0.04, y: 0.04, w: 0.94, h: 0.45, conf: 0.5 }, // ~same box again
    { x: 0.03, y: 0.52, w: 0.94, h: 0.45, conf: 0.8 },
  ]);
  const out = postprocess(dets, logits);
  assert.equal(out.length, 2);
});

test('postprocess: single box or nothing means page mode', () => {
  const one = tensors([{ x: 0.1, y: 0.1, w: 0.8, h: 0.8, conf: 0.95 }]);
  assert.deepEqual(postprocess(one.dets, one.logits), []);
  const none = tensors([{ x: 0.1, y: 0.1, w: 0.8, h: 0.8, conf: 0.05 }]);
  assert.deepEqual(postprocess(none.dets, none.logits), []);
});

test('postprocess: incomplete layout (low page coverage) falls back to page mode', () => {
  // Art bleeding across gutters makes the model miss panels — the detected
  // remainder covers too little of the page for an honest tour.
  const { dets, logits } = tensors([
    { x: 0.27, y: 0.44, w: 0.22, h: 0.52, conf: 0.8 },
    { x: 0.50, y: 0.44, w: 0.22, h: 0.52, conf: 0.7 },
    { x: 0.73, y: 0.44, w: 0.22, h: 0.52, conf: 0.9 },
  ]);
  assert.deepEqual(postprocess(dets, logits), []);
});

test('postprocess: overlapping but page-covering layout (insets) is kept', () => {
  const { dets, logits } = tensors([
    { x: 0.03, y: 0.03, w: 0.94, h: 0.94, conf: 0.9 },  // full-page splash
    { x: 0.6, y: 0.65, w: 0.3, h: 0.28, conf: 0.8 },    // inset panel inside it
  ]);
  assert.equal(postprocess(dets, logits).length, 2);
});

test('postprocess: boxes clamped to the page and specks dropped', () => {
  const { dets, logits } = tensors([
    { x: -0.05, y: -0.05, w: 0.55, h: 1.05, conf: 0.9 }, // pokes off-page
    { x: 0.52, y: 0.03, w: 0.45, h: 0.94, conf: 0.8 },
    { x: 0.5, y: 0.1, w: 0.02, h: 0.02, conf: 0.9 },     // speck
  ]);
  const out = postprocess(dets, logits);
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= 1 && r.y + r.h <= 1));
});

test('detector without a model file reports unavailable and null detects', async () => {
  const ml = createMlDetector(path.join(import.meta.dirname ?? '.', 'no-such-model.onnx'));
  assert.equal(await ml.available(), false);
  assert.equal(await ml.detect(Buffer.alloc(10)), null);
});

// Full ONNX inference — only when a real model is installed next to the db.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const modelPath = path.resolve(HERE, '../../../models/panels.onnx');
test('onnx end-to-end on a synthetic page', { skip: !fs.existsSync(modelPath) }, async () => {
  const { default: sharp } = await import('sharp');
  const ml = createMlDetector(modelPath);
  assert.equal(await ml.available(), true);
  // A plain white page: the model must not hallucinate a layout.
  const blank = await sharp({ create: { width: 800, height: 1200, channels: 3, background: '#ffffff' } })
    .png().toBuffer();
  const out = await ml.detect(blank);
  assert.ok(Array.isArray(out));
  assert.ok(out.length === 0 || out.length >= 2); // page mode or a real layout, never 1
});
