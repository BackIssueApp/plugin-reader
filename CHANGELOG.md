# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the release bundle BackIssue's plugin catalog installs).

Contributors: please **don't** edit this file in pull requests — entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

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
