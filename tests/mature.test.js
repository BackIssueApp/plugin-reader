// Mature series stay off the reading shelves for roles without the permission
// and for accounts that switched mature content off for themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('Continue reading hides mature issues by role and by the account switch', async () => {
  process.env.PLUGINS_DIR = 'nonexistent-' + Date.now(); // keep other plugins out
  process.env.METADATA_BASE_OVERRIDE = 'http://127.0.0.1:9/api';
  const { openDb } = await import('../../../src/db.js');
  const { initUserTables } = await import('../../../src/users.js');
  const { pluginApi, registeredRoutes } = await import('../../../src/plugins.js');
  const config = (await import('../../../src/config.js')).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-mature-'));
  config.dbPath = path.join(dir, 'cat.db');
  const db = openDb(config.dbPath);
  initUserTables(db); // built-in roles, as the server does at boot
  for (const [sid, iid, title, restricted] of [[10, 100, 'Plain', 0], [20, 200, 'Mature', 1]]) {
    db.prepare('INSERT INTO cv_series (comicvine_id, name) VALUES (?, ?)').run(sid, title);
    db.prepare('INSERT INTO cv_issues (comicvine_id, cv_series_id, name, issue_number) VALUES (?, ?, ?, 1)').run(iid, sid, title);
    db.prepare('INSERT INTO series (title, url, cv_id, restricted) VALUES (?, ?, ?, ?)').run(title, 'u:' + title, sid, restricted);
    db.prepare('INSERT INTO library_files (path, cv_issue_id, valid) VALUES (?, ?, 1)').run(path.join(dir, title + '.cbz'), iid);
  }
  (await import('../index.js')).default(pluginApi);
  for (const uid of [1, 2, 3]) for (const iid of [100, 200]) {
    db.prepare("INSERT INTO reader_progress (user_id, issue_id, page, pages, completed, updated_at) VALUES (?, ?, 3, 20, 0, '2026-10-18T00:00:00Z')").run(uid, iid);
  }
  const handler = registeredRoutes().find((r) => r.method === 'get' && r.path === '/api/reader/continue').handler;
  const titles = (user) => new Promise((resolve) => handler({ user, query: {} }, { json: (b) => resolve(b.items.map((i) => i.title).sort()), status() { return this; } }));

  assert.deepEqual(await titles({ id: 1, role: 'admin', hide_mature: 0 }), ['Mature', 'Plain']);
  assert.deepEqual(await titles({ id: 2, role: 'admin', hide_mature: 1 }), ['Plain'], 'the account switch hides them');
  assert.deepEqual(await titles({ id: 3, role: 'viewer', hide_mature: 0 }), ['Plain'], 'so does a role without the permission');
});
