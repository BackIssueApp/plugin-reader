// Panel detection on synthetic pages with KNOWN layouts, through the real
// sharp pipeline — plus the reading-order logic (LTR + RTL) and the
// conservative fallbacks (full-bleed / blank / noisy pages → zero panels).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { detectPanels, orderPanels } from '../panels.js';

// Compose a white page with dark filled rects (x,y,w,h in pixels).
function page(w, h, rects, { bg = '#ffffff', ink = '#222222' } = {}) {
  return sharp({ create: { width: w, height: h, channels: 3, background: bg } })
    .composite(rects.map((r) => ({
      input: { create: { width: r.w, height: r.h, channels: 3, background: ink } },
      left: r.x, top: r.y,
    })))
    .png()
    .toBuffer();
}

// A detected rect (normalized) roughly matches a pixel rect on a W×H page.
function matches(det, px, W, H, tol = 0.03) {
  return Math.abs(det.x - px.x / W) < tol && Math.abs(det.y - px.y / H) < tol
    && Math.abs(det.w - px.w / W) < tol * 2 && Math.abs(det.h - px.h / H) < tol * 2;
}

test('2×2 grid: four panels found, LTR and RTL order correct', async () => {
  const W = 800, H = 1200;
  const tl = { x: 40, y: 40, w: 340, h: 540 };
  const tr = { x: 420, y: 40, w: 340, h: 540 };
  const bl = { x: 40, y: 620, w: 340, h: 540 };
  const br = { x: 420, y: 620, w: 340, h: 540 };
  const panels = await detectPanels(await page(W, H, [tl, tr, bl, br]));
  assert.equal(panels.length, 4);
  for (const px of [tl, tr, bl, br]) {
    assert.ok(panels.some((d) => matches(d, px, W, H)), `panel at ${px.x},${px.y} found`);
  }
  const ltr = orderPanels(panels, false);
  assert.ok(matches(ltr[0], tl, W, H) && matches(ltr[1], tr, W, H)
    && matches(ltr[2], bl, W, H) && matches(ltr[3], br, W, H), 'LTR: tl,tr,bl,br');
  const rtl = orderPanels(panels, true);
  assert.ok(matches(rtl[0], tr, W, H) && matches(rtl[1], tl, W, H)
    && matches(rtl[2], br, W, H) && matches(rtl[3], bl, W, H), 'RTL: tr,tl,br,bl');
});

test('mixed layout: full-width banner over two bottom panels, ordered top-first', async () => {
  const W = 800, H = 1200;
  const top = { x: 40, y: 40, w: 720, h: 500 };
  const bl = { x: 40, y: 600, w: 340, h: 560 };
  const br = { x: 420, y: 600, w: 340, h: 560 };
  const panels = await detectPanels(await page(W, H, [top, bl, br]));
  assert.equal(panels.length, 3);
  const ordered = orderPanels(panels, false);
  assert.ok(matches(ordered[0], top, W, H), 'banner first');
  assert.ok(matches(ordered[1], bl, W, H) && matches(ordered[2], br, W, H));
});

test('fallbacks: full-bleed, blank, and noisy pages return zero panels', async () => {
  // Full-bleed: ink covering ~the whole page → splash → page mode.
  const bleed = await detectPanels(await page(800, 1200, [{ x: 5, y: 5, w: 790, h: 1190 }]));
  assert.equal(bleed.length, 0, 'full-bleed → page mode');

  // Blank page: nothing but background.
  const blank = await detectPanels(await page(800, 1200, []));
  assert.equal(blank.length, 0, 'blank → page mode');

  // Noise: a confetti of tiny specks (all under the area floor).
  const specks = Array.from({ length: 60 }, (_, i) => ({
    x: 20 + (i % 10) * 78, y: 20 + Math.floor(i / 10) * 190, w: 12, h: 12,
  }));
  const noisy = await detectPanels(await page(800, 1200, specks));
  assert.equal(noisy.length, 0, 'specks → page mode');
});

test('dark-gutter pages work too (background estimated, not assumed white)', async () => {
  const W = 800, H = 1200;
  const a = { x: 40, y: 40, w: 720, h: 540 };
  const b = { x: 40, y: 620, w: 720, h: 540 };
  const panels = await detectPanels(await page(W, H, [a, b], { bg: '#101010', ink: '#e8e8e8' }));
  assert.equal(panels.length, 2);
  const ordered = orderPanels(panels, false);
  assert.ok(matches(ordered[0], a, W, H) && matches(ordered[1], b, W, H));
});

test('column-spanning panel orders correctly (XY-cut, not row clustering)', () => {
  // Real layout from Action Comics (2011) #7 p21: a tall left panel beside a
  // stacked right column, bottom row of three. Reading order must finish the
  // tall panel, then take the right stack TOP-first — row clustering got this
  // backwards.
  const tallL = { x: 0.05, y: 0.04, w: 0.33, h: 0.47 };
  const stripR = { x: 0.39, y: 0.04, w: 0.56, h: 0.15 };
  const belowR = { x: 0.39, y: 0.20, w: 0.56, h: 0.31 };
  const b1 = { x: 0.05, y: 0.52, w: 0.29, h: 0.44 };
  const b2 = { x: 0.35, y: 0.52, w: 0.29, h: 0.44 };
  const b3 = { x: 0.65, y: 0.52, w: 0.30, h: 0.44 };
  const shuffled = [belowR, b2, tallL, b3, stripR, b1];
  assert.deepEqual(orderPanels(shuffled, false), [tallL, stripR, belowR, b1, b2, b3]);
  // RTL: right column stack first (top-to-bottom), then the tall left panel.
  assert.deepEqual(orderPanels(shuffled, true), [stripR, belowR, tallL, b3, b2, b1]);
});
