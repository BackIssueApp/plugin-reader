// Reader state: reading progress + bookmarks, in plugin-owned tables inside
// catalog.db (so DB backups cover them). Own connection; core never touches
// these tables.
import Database from 'better-sqlite3';

/** The account that owns pre-multi-user data: the oldest active admin (the
 *  person who ran the single-user install), else the open-mode local user 0. */
function ownerUserId(db) {
  try {
    const r = db.prepare("SELECT id FROM users WHERE role='admin' AND disabled=0 ORDER BY id LIMIT 1").get();
    return r ? r.id : 0;
  } catch {
    return 0; // no users table (core predates the user system)
  }
}

export function openReaderStore(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS reader_progress (
      user_id    INTEGER NOT NULL DEFAULT 0,
      issue_id   INTEGER NOT NULL,
      page       INTEGER NOT NULL DEFAULT 0,
      pages      INTEGER NOT NULL DEFAULT 0,
      completed  INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT,
      PRIMARY KEY (user_id, issue_id)
    );
    CREATE TABLE IF NOT EXISTS reader_bookmarks (
      user_id  INTEGER NOT NULL DEFAULT 0,
      issue_id INTEGER NOT NULL,
      page     INTEGER NOT NULL,
      PRIMARY KEY (user_id, issue_id, page)
    );
    CREATE TABLE IF NOT EXISTS reader_series_prefs (
      user_id   INTEGER NOT NULL DEFAULT 0,
      series_id INTEGER NOT NULL,
      mode  TEXT, rtl INTEGER, fit TEXT, split INTEGER,
      spread_offset INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, series_id)
    );
    CREATE TABLE IF NOT EXISTS reader_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS reader_stats_daily (
      user_id   INTEGER NOT NULL,
      day       TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
      pages     INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    );
    -- Personal "read later" shelf: issues a user saved to read, unordered.
    CREATE TABLE IF NOT EXISTS reader_later (
      user_id  INTEGER NOT NULL,
      issue_id INTEGER NOT NULL,
      added_at TEXT,
      PRIMARY KEY (user_id, issue_id)
    );
    -- Per-user visibility of each home-page reading shelf. The everyday shelves
    -- default on; the rest are opt-in so the home doesn't crowd on first load.
    CREATE TABLE IF NOT EXISTS reader_home_prefs (
      user_id        INTEGER PRIMARY KEY,
      show_continue  INTEGER NOT NULL DEFAULT 1,
      show_next      INTEGER NOT NULL DEFAULT 1,
      show_new       INTEGER NOT NULL DEFAULT 1,
      show_later     INTEGER NOT NULL DEFAULT 0,
      show_finished  INTEGER NOT NULL DEFAULT 0,
      show_startnew  INTEGER NOT NULL DEFAULT 0,
      show_bookmarks INTEGER NOT NULL DEFAULT 0
    );
  `);
  // Backfill shelf columns on DBs created before the extra shelves existed.
  for (const [col, def] of Object.entries({ show_new: 1, show_later: 0, show_finished: 0, show_startnew: 0, show_bookmarks: 0 })) {
    if (!db.prepare("SELECT 1 FROM pragma_table_info('reader_home_prefs') WHERE name = ?").get(col)) {
      db.exec(`ALTER TABLE reader_home_prefs ADD COLUMN ${col} INTEGER NOT NULL DEFAULT ${def}`);
    }
  }

  // ---- migration: global (single-user) tables → per-user ----
  // Old tables lack user_id; rebuild each with the owner's id. The owner is
  // the oldest admin — the human who did all that reading.
  const needsUserCol = (t) => !db.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name='user_id'`).get();
  if (needsUserCol('reader_progress') || needsUserCol('reader_bookmarks') || needsUserCol('reader_series_prefs')) {
    const owner = ownerUserId(db);
    const rebuild = db.transaction(() => {
      if (needsUserCol('reader_progress')) {
        db.exec(`CREATE TABLE rp2 (user_id INTEGER NOT NULL DEFAULT 0, issue_id INTEGER NOT NULL,
                   page INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0,
                   completed INTEGER NOT NULL DEFAULT 0, updated_at TEXT, PRIMARY KEY (user_id, issue_id))`);
        db.prepare('INSERT INTO rp2 SELECT ?, issue_id, page, pages, completed, updated_at FROM reader_progress').run(owner);
        db.exec('DROP TABLE reader_progress; ALTER TABLE rp2 RENAME TO reader_progress');
      }
      if (needsUserCol('reader_bookmarks')) {
        db.exec(`CREATE TABLE rb2 (user_id INTEGER NOT NULL DEFAULT 0, issue_id INTEGER NOT NULL,
                   page INTEGER NOT NULL, PRIMARY KEY (user_id, issue_id, page))`);
        db.prepare('INSERT INTO rb2 SELECT ?, issue_id, page FROM reader_bookmarks').run(owner);
        db.exec('DROP TABLE reader_bookmarks; ALTER TABLE rb2 RENAME TO reader_bookmarks');
      }
      if (needsUserCol('reader_series_prefs')) {
        db.exec(`CREATE TABLE rs2 (user_id INTEGER NOT NULL DEFAULT 0, series_id INTEGER NOT NULL,
                   mode TEXT, rtl INTEGER, fit TEXT, split INTEGER,
                   spread_offset INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, series_id))`);
        db.prepare('INSERT INTO rs2 SELECT ?, series_id, mode, rtl, fit, split, spread_offset FROM reader_series_prefs').run(owner);
        db.exec('DROP TABLE reader_series_prefs; ALTER TABLE rs2 RENAME TO reader_series_prefs');
      }
    });
    try { rebuild(); } catch (e) { console.warn('reader per-user migration failed:', e?.message || e); }
  }
  // Open-mode history (user 0) claims to the first admin once accounts exist —
  // the local reader and the first admin are the same human.
  const claimant = ownerUserId(db);
  if (claimant !== 0) {
    const claim = db.transaction(() => {
      for (const t of ['reader_progress', 'reader_bookmarks', 'reader_series_prefs']) {
        const cols = db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all()
          .map((r) => r.name).filter((c) => c !== 'user_id');
        db.exec(`INSERT OR IGNORE INTO ${t} (user_id, ${cols.join(',')})
                 SELECT ${claimant}, ${cols.join(',')} FROM ${t} WHERE user_id = 0`);
        db.exec(`DELETE FROM ${t} WHERE user_id = 0`);
      }
    });
    try { claim(); } catch (e) { console.warn('reader open-mode claim failed:', e?.message || e); }
  }

  // One-time rekey: v1 keyed progress/bookmarks by the local `issues` row id,
  // which only exists for queued downloads — scanned issues have none. v1.2
  // keys by ComicVine issue id instead. Remap old rows where a mapping exists
  // (via the row's file → library_files, or a 'cvissue:' url); drop the rest.
  const hasCore = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if (!db.prepare("SELECT 1 FROM reader_meta WHERE key='cv_rekey_done'").get()
      && hasCore('issues') && hasCore('library_files')) {
    const remap = db.transaction(() => {
      for (const table of ['reader_progress', 'reader_bookmarks']) {
        const rows = db.prepare(`SELECT DISTINCT issue_id FROM ${table}`).all();
        for (const { issue_id } of rows) {
          const cv = db.prepare(`
            SELECT COALESCE(
              (SELECT lf.cv_issue_id FROM issues i JOIN library_files lf ON lf.path = i.file_path
                WHERE i.id = ? AND lf.cv_issue_id IS NOT NULL),
              (SELECT CAST(substr(i.url, 9) AS INTEGER) FROM issues i
                WHERE i.id = ? AND i.url LIKE 'cvissue:%')
            ) AS cv`).get(issue_id, issue_id)?.cv;
          if (cv && cv !== issue_id) {
            try { db.prepare(`UPDATE ${table} SET issue_id = ? WHERE issue_id = ?`).run(cv, issue_id); }
            catch { db.prepare(`DELETE FROM ${table} WHERE issue_id = ?`).run(issue_id); } // target key already present
          }
        }
      }
      db.prepare("INSERT INTO reader_meta (key, value) VALUES ('cv_rekey_done', '1')").run();
    });
    try { remap(); } catch { /* re-attempt next boot */ }
  }

  return {
    progress(userId, issueId) {
      return db.prepare('SELECT page, pages, completed FROM reader_progress WHERE user_id = ? AND issue_id = ?').get(userId, issueId)
        || { page: 0, pages: 0, completed: 0 };
    },
    saveProgress(userId, issueId, { page, pages, completed }) {
      // Stats ride along: forward page movement counts as pages read that day,
      // and a fresh completion (the latch flipping 0→1) counts an issue.
      const old = db.prepare('SELECT page, completed FROM reader_progress WHERE user_id = ? AND issue_id = ?')
        .get(userId, issueId) || { page: 0, completed: 0 };
      const pagesRead = Math.max(0, (page | 0) - old.page);
      const finished = completed && !old.completed ? 1 : 0;
      if (pagesRead || finished) {
        db.prepare(`
          INSERT INTO reader_stats_daily (user_id, day, pages, completed)
          VALUES (?, date('now'), ?, ?)
          ON CONFLICT(user_id, day) DO UPDATE SET
            pages = pages + excluded.pages, completed = completed + excluded.completed
        `).run(userId, pagesRead, finished);
      }
      db.prepare(`
        INSERT INTO reader_progress (user_id, issue_id, page, pages, completed, updated_at)
        VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        ON CONFLICT(user_id, issue_id) DO UPDATE SET
          page = excluded.page, pages = excluded.pages,
          completed = MAX(reader_progress.completed, excluded.completed),
          updated_at = excluded.updated_at
      `).run(userId, issueId, page | 0, pages | 0, completed ? 1 : 0);
    },
    bookmarks(userId, issueId) {
      return db.prepare('SELECT page FROM reader_bookmarks WHERE user_id = ? AND issue_id = ? ORDER BY page').all(userId, issueId).map((r) => r.page);
    },
    setBookmark(userId, issueId, page, on) {
      if (on) db.prepare('INSERT OR IGNORE INTO reader_bookmarks (user_id, issue_id, page) VALUES (?, ?, ?)').run(userId, issueId, page | 0);
      else db.prepare('DELETE FROM reader_bookmarks WHERE user_id = ? AND issue_id = ? AND page = ?').run(userId, issueId, page | 0);
    },
    /** Most-recently-read incomplete issues (the "continue reading" list).
     *  Keyed by CV issue id; only issues that still have a readable file. */
    continueList(userId, limit = 10) {
      return db.prepare(`
        SELECT p.issue_id, p.page, p.pages, ci.name AS title, ci.issue_number, cs.name AS series
          FROM reader_progress p
          JOIN cv_issues ci ON ci.comicvine_id = p.issue_id
          LEFT JOIN cv_series cs ON cs.comicvine_id = ci.cv_series_id
         WHERE p.user_id = ? AND p.completed = 0 AND p.page > 0 AND EXISTS
           (SELECT 1 FROM library_files lf WHERE lf.cv_issue_id = p.issue_id AND lf.valid = 1)
         ORDER BY p.updated_at DESC LIMIT ?
      `).all(userId, limit);
    },
    /** "Next up": for each series the user has finished at least one issue in,
     *  the earliest readable issue they haven't started (no progress, or a
     *  page-0/incomplete row) — i.e. the next thing to read in a series they're
     *  into. Ordered by their most recent activity in that series (just-finished
     *  series first). Never overlaps continueList (that's mid-issue reads). */
    nextUpList(userId, limit = 12) {
      return db.prepare(`
        WITH read_series AS (
          SELECT ci.cv_series_id AS sid, MAX(p.updated_at) AS last_active
            FROM reader_progress p
            JOIN cv_issues ci ON ci.comicvine_id = p.issue_id
           WHERE p.user_id = ? AND p.completed = 1 AND ci.cv_series_id IS NOT NULL
           GROUP BY ci.cv_series_id
        ),
        ranked AS (
          SELECT rs.last_active, ci.comicvine_id AS issue_id, ci.name AS title,
                 ci.issue_number, ci.cv_series_id AS series_id, cs.name AS series,
                 ROW_NUMBER() OVER (
                   PARTITION BY ci.cv_series_id
                   ORDER BY CAST(NULLIF(ci.issue_number,'') AS REAL), ci.issue_number
                 ) AS rn
            FROM read_series rs
            JOIN cv_issues ci ON ci.cv_series_id = rs.sid
            LEFT JOIN cv_series cs ON cs.comicvine_id = ci.cv_series_id
           WHERE EXISTS (SELECT 1 FROM library_files lf WHERE lf.cv_issue_id = ci.comicvine_id AND lf.valid = 1)
             AND NOT EXISTS (SELECT 1 FROM reader_progress p2
                              WHERE p2.user_id = ? AND p2.issue_id = ci.comicvine_id
                                AND (p2.completed = 1 OR p2.page > 0))
        )
        SELECT issue_id, title, issue_number, series_id, series
          FROM ranked WHERE rn = 1
         ORDER BY last_active DESC LIMIT ?
      `).all(userId, userId, limit);
    },

    /** Recently-added issues the user hasn't touched yet — "new, ready to read".
     *  Ordered by the file's mtime (when the copy landed on disk). */
    newInLibrary(userId, limit = 12) {
      return db.prepare(`
        SELECT lf.cv_issue_id AS issue_id, ci.name AS title, ci.issue_number,
               cs.name AS series, ci.cv_series_id AS series_id
          FROM library_files lf
          JOIN cv_issues ci ON ci.comicvine_id = lf.cv_issue_id
          LEFT JOIN cv_series cs ON cs.comicvine_id = ci.cv_series_id
         WHERE lf.valid = 1 AND lf.cv_issue_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM reader_progress p
                            WHERE p.user_id = ? AND p.issue_id = lf.cv_issue_id
                              AND (p.completed = 1 OR p.page > 0))
         GROUP BY lf.cv_issue_id
         ORDER BY MAX(lf.mtime) DESC LIMIT ?
      `).all(userId, limit);
    },

    /** Issues the user finished, most recent first — for a re-read or a look back. */
    recentlyFinished(userId, limit = 12) {
      return db.prepare(`
        SELECT p.issue_id, ci.name AS title, ci.issue_number, cs.name AS series, ci.cv_series_id AS series_id
          FROM reader_progress p
          JOIN cv_issues ci ON ci.comicvine_id = p.issue_id
          LEFT JOIN cv_series cs ON cs.comicvine_id = ci.cv_series_id
         WHERE p.user_id = ? AND p.completed = 1 AND EXISTS
           (SELECT 1 FROM library_files lf WHERE lf.cv_issue_id = p.issue_id AND lf.valid = 1)
         ORDER BY p.updated_at DESC LIMIT ?
      `).all(userId, limit);
    },

    /** The first issue of each owned series the user has never opened — a nudge
     *  toward the unread stuff sitting in their library. */
    startNewSeries(userId, limit = 12) {
      return db.prepare(`
        WITH owned AS (
          SELECT DISTINCT ci.cv_series_id AS sid
            FROM library_files lf JOIN cv_issues ci ON ci.comicvine_id = lf.cv_issue_id
           WHERE lf.valid = 1 AND ci.cv_series_id IS NOT NULL
        ),
        touched AS (
          SELECT DISTINCT ci.cv_series_id AS sid
            FROM reader_progress p JOIN cv_issues ci ON ci.comicvine_id = p.issue_id
           WHERE p.user_id = ? AND ci.cv_series_id IS NOT NULL
        ),
        ranked AS (
          SELECT ci.comicvine_id AS issue_id, ci.name AS title, ci.issue_number,
                 cs.name AS series, ci.cv_series_id AS series_id,
                 ROW_NUMBER() OVER (PARTITION BY ci.cv_series_id
                   ORDER BY CAST(NULLIF(ci.issue_number,'') AS REAL), ci.issue_number) AS rn
            FROM owned o
            JOIN cv_issues ci ON ci.cv_series_id = o.sid
            LEFT JOIN cv_series cs ON cs.comicvine_id = ci.cv_series_id
           WHERE o.sid NOT IN (SELECT sid FROM touched)
             AND EXISTS (SELECT 1 FROM library_files lf WHERE lf.cv_issue_id = ci.comicvine_id AND lf.valid = 1)
        )
        SELECT issue_id, title, issue_number, series, series_id FROM ranked WHERE rn = 1
         ORDER BY series LIMIT ?
      `).all(userId, limit);
    },

    /** Per-user visibility of each home reading shelf. Everyday shelves default
     *  on, the rest opt-in. setHomePrefs takes a partial and merges. */
    homePrefs(userId) {
      const r = db.prepare('SELECT * FROM reader_home_prefs WHERE user_id = ?').get(userId);
      const on = (col, def) => (r ? !!r[col] : def);
      return {
        showContinue: on('show_continue', true), showNext: on('show_next', true),
        showNew: on('show_new', true), showLater: on('show_later', false),
        showFinished: on('show_finished', false), showStartNew: on('show_startnew', false),
        showBookmarks: on('show_bookmarks', false),
      };
    },
    setHomePrefs(userId, partial) {
      const m = { ...this.homePrefs(userId), ...(partial || {}) };
      db.prepare(`
        INSERT INTO reader_home_prefs
          (user_id, show_continue, show_next, show_new, show_later, show_finished, show_startnew, show_bookmarks)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          show_continue = excluded.show_continue, show_next = excluded.show_next,
          show_new = excluded.show_new, show_later = excluded.show_later,
          show_finished = excluded.show_finished, show_startnew = excluded.show_startnew,
          show_bookmarks = excluded.show_bookmarks
      `).run(userId, m.showContinue ? 1 : 0, m.showNext ? 1 : 0, m.showNew ? 1 : 0,
        m.showLater ? 1 : 0, m.showFinished ? 1 : 0, m.showStartNew ? 1 : 0, m.showBookmarks ? 1 : 0);
      return this.homePrefs(userId);
    },

    /** One user's read-state for every issue they've touched (row badges). */
    allStates(userId) {
      const rows = db.prepare('SELECT issue_id, page, pages, completed FROM reader_progress WHERE user_id = ?').all(userId);
      return Object.fromEntries(rows.map((r) => [r.issue_id, { page: r.page, pages: r.pages, completed: r.completed }]));
    },
    /** Explicitly set read/unread (bypasses the completed latch — this is the
     *  manual override). Marking unread also resets the resume point. */
    setRead(userId, issueId, read) {
      db.prepare(`
        INSERT INTO reader_progress (user_id, issue_id, page, pages, completed, updated_at)
        VALUES (?, ?, 0, COALESCE((SELECT pages FROM reader_progress WHERE user_id = ? AND issue_id = ?), 0), ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        ON CONFLICT(user_id, issue_id) DO UPDATE SET
          completed = excluded.completed, page = 0, updated_at = excluded.updated_at
      `).run(userId, issueId, userId, issueId, read ? 1 : 0);
    },
    /** Every bookmark this user has, across all issues, with issue/series
     *  metadata so a library-wide "my bookmarks" list can link straight in.
     *  Only bookmarks on issues that still have a readable file. */
    allBookmarks(userId) {
      try {
        return db.prepare(`
          SELECT b.issue_id, b.page, ci.name AS title, ci.issue_number,
                 cs.name AS series, ci.cv_series_id AS series_id
            FROM reader_bookmarks b
            JOIN cv_issues ci ON ci.comicvine_id = b.issue_id
            LEFT JOIN cv_series cs ON cs.comicvine_id = ci.cv_series_id
           WHERE b.user_id = ? AND EXISTS
             (SELECT 1 FROM library_files lf WHERE lf.cv_issue_id = b.issue_id AND lf.valid = 1)
           ORDER BY cs.name, CAST(ci.issue_number AS REAL), b.page
        `).all(userId);
      } catch { return []; }
    },

    /** Read-later shelf. */
    isLater(userId, issueId) {
      return !!db.prepare('SELECT 1 FROM reader_later WHERE user_id = ? AND issue_id = ?').get(userId, issueId);
    },
    setLater(userId, issueId, on) {
      if (on) db.prepare("INSERT OR IGNORE INTO reader_later (user_id, issue_id, added_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(userId, issueId);
      else db.prepare('DELETE FROM reader_later WHERE user_id = ? AND issue_id = ?').run(userId, issueId);
      return this.isLater(userId, issueId);
    },
    laterList(userId) {
      try {
        return db.prepare(`
          SELECT l.issue_id, l.added_at, ci.name AS title, ci.issue_number,
                 cs.name AS series, ci.cv_series_id AS series_id
            FROM reader_later l
            JOIN cv_issues ci ON ci.comicvine_id = l.issue_id
            LEFT JOIN cv_series cs ON cs.comicvine_id = ci.cv_series_id
           WHERE l.user_id = ? AND EXISTS
             (SELECT 1 FROM library_files lf WHERE lf.cv_issue_id = l.issue_id AND lf.valid = 1)
           ORDER BY l.added_at DESC
        `).all(userId);
      } catch { return []; }
    },

    /** Reading stats: lifetime + this-month totals, a 30-day sparkline, the
     *  current daily streak, and most-finished series. All from the daily
     *  aggregate — no per-page event log to grow unbounded. */
    stats(userId) {
      const totals = db.prepare(
        'SELECT COALESCE(SUM(pages),0) pages, COALESCE(SUM(completed),0) completed FROM reader_stats_daily WHERE user_id = ?',
      ).get(userId);
      const month = db.prepare(`
        SELECT COALESCE(SUM(pages),0) pages, COALESCE(SUM(completed),0) completed
          FROM reader_stats_daily WHERE user_id = ? AND day >= date('now','start of month')`).get(userId);
      const last30 = db.prepare(`
        SELECT day, pages, completed FROM reader_stats_daily
         WHERE user_id = ? AND day >= date('now','-29 days') ORDER BY day`).all(userId);
      // Streak: consecutive days with any reading, counting back from today
      // (a gap today doesn't break it — you haven't read *yet*).
      const days = new Set(db.prepare(
        "SELECT day FROM reader_stats_daily WHERE user_id = ? AND pages > 0 AND day >= date('now','-400 days')",
      ).all(userId).map((r) => r.day));
      let streak = 0;
      const d = new Date();
      if (!days.has(d.toISOString().slice(0, 10))) d.setUTCDate(d.getUTCDate() - 1);
      while (days.has(d.toISOString().slice(0, 10))) { streak++; d.setUTCDate(d.getUTCDate() - 1); }
      let topSeries = [];
      try {
        topSeries = db.prepare(`
          SELECT cs.name AS series, COUNT(*) AS finished
            FROM reader_progress p
            JOIN cv_issues ci ON ci.comicvine_id = p.issue_id
            JOIN cv_series cs ON cs.comicvine_id = ci.cv_series_id
           WHERE p.user_id = ? AND p.completed = 1
           GROUP BY cs.comicvine_id ORDER BY finished DESC, cs.name LIMIT 5`).all(userId);
      } catch { /* core CV tables absent — stats still work without the ranking */ }
      return { totals, month, last30, streak, topSeries };
    },
    /** Per-user, per-series reading profile — your manga stays RTL, theirs doesn't. */
    seriesPrefs(userId, seriesId) {
      return db.prepare('SELECT mode, rtl, fit, split, spread_offset FROM reader_series_prefs WHERE user_id = ? AND series_id = ?').get(userId, seriesId) || null;
    },
    saveSeriesPrefs(userId, seriesId, { mode, rtl, fit, split, spread_offset }) {
      db.prepare(`
        INSERT INTO reader_series_prefs (user_id, series_id, mode, rtl, fit, split, spread_offset) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, series_id) DO UPDATE SET
          mode = excluded.mode, rtl = excluded.rtl, fit = excluded.fit,
          split = excluded.split, spread_offset = excluded.spread_offset
      `).run(userId, seriesId, mode ?? null, rtl ? 1 : 0, fit ?? null, split ? 1 : 0, spread_offset ? 1 : 0);
    },
    close() { db.close(); },
  };
}
