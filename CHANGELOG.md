# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the release bundle BackIssue's plugin catalog installs).

Contributors: please **don't** edit this file in pull requests — entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

### Fixed
- **Review mode + unsaved edits**: pressing Space on a page with pending panel
  edits now saves that page first (which marks it reviewed and shares the
  human layout) instead of casting a "layout is correct" vote for the old
  layout the edit was replacing. A pending revert is likewise applied before
  the confirmation counts.

### Changed
- **Recomputes respect human edits**: when a panel layout is recomputed (engine
  upgrade, model change, cache miss), pages with hand-corrected layouts are no
  longer re-detected — the edit is used directly, and is re-shared to the
  community cache so corrections made before sharing was enabled get
  back-filled.

### Added
- **Panel studio — layout database browser**: a new "Database" button in the
  studio opens a read-only browser over every panel layout stored on the
  server, with summary counts, filter chips (ML / built-in / edited /
  reviewed / page mode), text search, and paging. Clicking a row jumps the
  studio straight to that issue and page — including issues other than the
  one currently open.

## [1.6.0] — 2026-07-20

### Added
- **Shared panel cache** (Settings → Library, on by default): panel
  layouts are looked up from a community cache before detecting — so a page
  detected or hand-corrected on any server gives you instant guided view —
  and your own detections and corrections are contributed back (only
  ML-detected layouts and hand-corrections are shared — the built-in
  detector's output stays local). Only panel
  rectangles and a hash of the page's image bytes are sent; never image data
  or filenames. Hand-corrections outrank model output everywhere; model
  layouts are only shared once two servers independently corroborate them.
  Turn the toggle off to opt out entirely (detection then runs locally only).
  Confirming a page in the studio's review mode also counts as a vote of
  confidence on the shared layout (retracting the review retracts the vote);
  community layouts that collect enough rejections stop being served.
- **Panel studio**: users with the new `reader.panels.edit` permission
  (admin tier by default) get an "Edit panel layout" action on issue rows
  that opens a full-issue editor — a page-thumbnail rail beside an editable
  layout view. Drag corners (slanted panels supported) or whole panels,
  add/delete panels, reorder the reading sequence, force a page to read
  whole, or revert pages to automatic detection; staged edits across any
  number of pages commit with one Save. Corrections are saved per file,
  apply to everyone on the server, beat any detector's output, and survive
  model upgrades.
- **Guided panel view**: read a page panel by panel — the reader detects the
  panel layout server-side (computed once per issue, cached) and the `g` key
  or the new toolbar button steps through panels with an animated camera,
  and a spotlight dims everything outside the current panel. While an issue's
  layout is being detected the reader shows live page-by-page progress.
  Right-to-left series tour panels in manga order. Pages without a confident
  layout stay whole pages.
- **ML panel detection downloads itself**: when the ML toggle is on and no
  model is installed, the reader fetches the current panel model from the
  BackIssue CDN on startup (verified by checksum before it's ever loaded)
  and activates it without a restart. A model you placed by hand is never
  replaced; a custom `readerPanelModel` path disables auto-management.
- **ML panel detection** (optional): drop a panel-detection model at
  `<data dir>/models/panels.onnx` (or set `readerPanelModel` to its path) and
  panel layouts come from a neural detector that handles black gutters,
  borderless cartoon panels, and low-contrast layouts the built-in detector
  can't — in testing it produced guided layouts on 91% of pages vs 34% for
  the classical detector. Without the model (or the optional
  `onnxruntime-node` dependency) the classical detector keeps working
  unchanged, and a Settings → Library toggle switches between the ML and
  built-in detectors at any time. Turning the model on or off recomputes
  each issue's layout once.

## [1.5.1] — 2026-07-16

### Added
- Bulk read status: **Mark read** / **Mark unread** buttons on the series page
  act on the checked issues — or the whole series when nothing is checked
  (needs BackIssue core with the selection bridge).

## [1.5.0] — 2026-07-16

### Added
- Manga series (the core library type) open right-to-left by default — a
  reader-settings change for the series always wins over the default.

## [1.4.1] — 2026-07-09

### Added
- Library setting to choose issue-cover art: the file's first page (default) or
  ComicVine's cover.

## [1.4.0] — 2026-07-08

### Added
- Five more home reading shelves.
- Per-user reading defaults (mode, direction, fit).
- Keep the screen awake while reading.
- "Mark read at N%" threshold setting.

### Fixed
- Webtoon-mode rendering fix.
- Reopening the reader panel no longer flashes the previous issue's cover.

## [1.3.0] — 2026-07-08

First public release (earlier versions predate this repository).

In-browser comic reader: paged, double-page, and webtoon modes; reading progress
with resume; bookmarks; offline reading; per-series reading profiles; per-user
reading stats.
