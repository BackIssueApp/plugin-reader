// Panel-detection evaluation harness: sample real issues from the library,
// run the detector, and write an HTML contact sheet — each page rendered with
// its detected panels drawn and numbered in reading order — plus summary
// stats. Visual truth beats guessed metrics: open the report and look.
//
//   node scripts/panels-eval.js [issues=8] [pagesPerIssue=4] [out.html]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { listPages, pageBuffer } from '../pages.js';
import { detectPanels, orderPanels } from '../panels.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const N_ISSUES = Number(process.argv[2]) || 8;
const N_PAGES = Number(process.argv[3]) || 4;
const OUT = process.argv[4] || path.join(HERE, 'panels-eval.html');
const DB = path.resolve(HERE, '../../../catalog.db');

const db = new Database(DB, { readonly: true });
const rows = db.prepare(`
  SELECT lf.path, COALESCE(cs.name, s.title) series, ci.issue_number
    FROM library_files lf
    JOIN cv_issues ci ON ci.comicvine_id = lf.cv_issue_id
    LEFT JOIN cv_series cs ON cs.comicvine_id = ci.cv_series_id
    LEFT JOIN series s ON s.id = lf.series_id
   WHERE lf.valid = 1 AND (lf.path LIKE '%.cbz' OR lf.path LIKE '%.cbr')
   ORDER BY RANDOM() LIMIT ?`).all(N_ISSUES * 3);

const issues = rows.filter((r) => { try { return fs.existsSync(r.path); } catch { return false; } }).slice(0, N_ISSUES);

let cells = '';
const stats = { pages: 0, withPanels: 0, panels: 0, perIssue: [] };

for (const issue of issues) {
  const label = `${issue.series || '?'} #${issue.issue_number || '?'}`;
  let names;
  try { names = await listPages(issue.path); } catch (e) { console.warn(`skip ${label}: ${e.message}`); continue; }
  // Skip the cover (page 0) — interiors are what guided view is for.
  const picks = [];
  for (let i = 1; i < names.length && picks.length < N_PAGES; i += Math.max(1, Math.floor((names.length - 1) / N_PAGES))) picks.push(i);
  let issuePanels = 0, issuePages = 0;
  for (const p of picks) {
    let buf;
    try { buf = (await pageBuffer(issue.path, p)).buffer; } catch { continue; }
    const t0 = Date.now();
    const panels = await detectPanels(buf);
    const ms = Date.now() - t0;
    const ordered = orderPanels(panels, false);
    stats.pages++; issuePages++;
    if (panels.length) { stats.withPanels++; stats.panels += panels.length; issuePanels += panels.length; }
    const thumb = await sharp(buf).resize({ width: 340 }).jpeg({ quality: 70 }).toBuffer();
    const boxes = ordered.map((r, i) =>
      `<div class="box" style="left:${(r.x * 100).toFixed(2)}%;top:${(r.y * 100).toFixed(2)}%;width:${(r.w * 100).toFixed(2)}%;height:${(r.h * 100).toFixed(2)}%"><i>${i + 1}</i></div>`).join('');
    cells += `<figure><div class="wrap"><img src="data:image/jpeg;base64,${thumb.toString('base64')}">${boxes}</div>
      <figcaption>${esc(label)} · p${p + 1} · ${panels.length ? panels.length + ' panels' : 'page mode'} · ${ms}ms</figcaption></figure>\n`;
  }
  stats.perIssue.push({ label, pages: issuePages, panels: issuePanels });
}

const pct = stats.pages ? Math.round((stats.withPanels / stats.pages) * 100) : 0;
const avg = stats.withPanels ? (stats.panels / stats.withPanels).toFixed(1) : '0';
const html = `<!doctype html><meta charset="utf-8"><title>Panel detection eval</title>
<style>
  body{background:#15131c;color:#ece8f1;font:14px system-ui;margin:20px}
  h1{font-size:18px} .sum{color:#9a93ab;margin-bottom:16px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px}
  figure{margin:0} .wrap{position:relative;display:inline-block;line-height:0}
  .wrap img{max-width:100%;border-radius:6px}
  .box{position:absolute;border:2px solid #ff2d6f;border-radius:3px;background:rgba(255,45,111,.08)}
  .box i{position:absolute;top:-2px;left:-2px;background:#ff2d6f;color:#fff;font:700 11px system-ui;font-style:normal;padding:1px 5px;border-radius:3px 0 4px 0}
  figcaption{font-size:11.5px;color:#9a93ab;padding:6px 2px;line-height:1.4}
</style>
<h1>Panel detection — ${issues.length} issues, ${stats.pages} pages</h1>
<div class="sum">${pct}% of pages got a guided-view layout (avg ${avg} panels on those); the rest fall back to page mode.</div>
<div class="grid">${cells}</div>`;
fs.writeFileSync(OUT, html);
console.log(`pages: ${stats.pages} | with panels: ${stats.withPanels} (${pct}%) | avg panels: ${avg}`);
for (const i of stats.perIssue) console.log(`  ${i.label}: ${i.panels} panels over ${i.pages} pages`);
console.log('report:', OUT);

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
