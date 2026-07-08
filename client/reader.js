// BackIssue comic reader — full-screen overlay injected via the plugin bridge.
// Modes: paged (single / double-spread w/ offset / wide-page split), webtoon.
// RTL manga mode, fit + zoom/pinch/pan, keyboard / configurable tap zones /
// swipe, slider with bookmark markers + thumbnail strip, decode-ahead
// preloading + next-issue prewarming, progress/resume (offline-queued) with
// read-state row badges + series Continue banner + manual read/unread,
// bookmarks, per-series reading profiles, issue-info overlay, end-of-issue
// card, data saver / margin trim, first-run hints, installable PWA, offline
// downloads via service worker.
(function () {
  'use strict';

  // ---------- icons ----------
  // Inline SVG, monochrome, drawn in currentColor. Symbol/emoji glyphs (✕ ⛶ ▦
  // ◐ ☆ 📌 …) render inconsistently across platforms — on iOS/iPadOS many turn
  // into colour emoji or shift baseline — so every button icon is an SVG that
  // looks identical everywhere. Feather/Lucide-style 24px stroke paths.
  const ICON_PATHS = {
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    'zoom-in': '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35M11 8v6M8 11h6"/>',
    'zoom-out': '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35M8 11h6"/>',
    rotate: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    'rotate-ccw': '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    bookmark: '<path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2.3"/><circle cx="15" cy="12" r="2.3"/><circle cx="8" cy="18" r="2.3"/>',
    maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    'page-single': '<rect x="7" y="4" width="10" height="16" rx="1"/>',
    'page-double': '<rect x="3" y="4" width="8" height="16" rx="1"/><rect x="13" y="4" width="8" height="16" rx="1"/>',
    webtoon: '<path d="M7 4h10M7 9h10M7 15h10M7 20h10"/>',
    'arrow-left': '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    'arrow-right': '<path d="M5 12h14M12 5l7 7-7 7"/>',
    'fit-height': '<path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4"/>',
    'fit-width': '<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    'external-link': '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  };
  const icon = (name, { fill = false } = {}) =>
    `<svg class="reader__ico" viewBox="0 0 24 24" width="24" height="24" fill="${fill ? 'currentColor' : 'none'}"`
    + ` stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name] || ''}</svg>`;

  // ---------- persisted DEVICE settings (look & feel) ----------
  // mode/rtl/fit/split/spreadOffset also live per-series on the server; the
  // rest (bg, brightness, tap zones, data saver, trim) is device-only.
  const SETTINGS_KEY = 'readerSettings';
  const defaults = {
    mode: 'single', rtl: false, fit: 'height', split: false, spreadOffset: false,
    bg: 'black', brightness: 100, thumbs: false,
    tapBoth: false, dataSaver: false, trim: false,
    colorFilter: 'none',   // none | invert | grayscale | sepia — eye-comfort / e-ink
    incognito: false,      // when on, reading is NOT recorded (no progress/history)
    autoScrollSpeed: 60,   // webtoon auto-scroll, pixels/second
  };
  let settings = { ...defaults };
  try { settings = { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { /* defaults */ }
  const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

  // Installable PWA: point the page at the plugin-served web-app manifest.
  if (!document.querySelector('link[rel="manifest"]')) {
    const l = document.createElement('link');
    l.rel = 'manifest'; l.href = '/reader-manifest.json';
    document.head.appendChild(l);
  }

  window.BackIssue.registerClient((api) => {
    // ---------- state ----------
    let overlay = null, els = {};
    let manifest = null;
    let page = 0, half = 0;      // half: 0/1 sub-page when splitting a wide page
    let zoom = 1, panX = 0, panY = 0, rotate = 0; // rotate: 0/90/180/270, per-session
    let chromeTimer = null, progressTimer = null;
    let wide = {};
    let bookmarks = new Set();
    let later = false;           // current issue on the read-later shelf
    let webtoonObserver = null;
    let autoScroll = false, autoScrollRAF = null, autoScrollLast = 0;
    let readStates = {};         // issueId → { page, pages, completed } (row badges)
    let laterSet = new Set();     // cv_issue_ids on the read-later shelf (row action)
    let prewarmed = null;        // { id, manifest } for the next issue
    let sw = null;               // service worker registration
    let offlineIssues = new Set();
    let lastFocus = null;

    // Page-URL params: explicit width (thumbnails), or the device's data-saver
    // width; margin trimming. WebP happens server-side via Accept negotiation.
    function pageParams(w) {
      const q = [];
      const eff = w || (settings.dataSaver ? 1200 : 0);
      if (eff) q.push(`w=${eff}`);
      if (settings.trim) q.push('trim=1');
      return q.length ? `?${q.join('&')}` : '';
    }
    const pageUrl = (n, w) => `/api/reader/issue/${manifest.issue.id}/page/${n}${pageParams(w)}`;

    // ---------- offline-safe progress queue ----------
    // Progress POSTs made while offline (reading a downloaded issue) land here
    // and replay when the connection returns — your place is never lost.
    const QUEUE_KEY = 'readerProgressQueue';
    function enqueueProgress(url, body) {
      try {
        const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]').filter((e) => e.url !== url);
        q.push({ url, body });
        localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-50)));
      } catch { /* storage full — progress is best-effort */ }
    }
    async function flushProgressQueue() {
      let q = [];
      try { q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { /* corrupt */ }
      if (!q.length) return;
      const rest = [];
      for (const e of q) {
        try { await api.post(e.url, e.body); } catch { rest.push(e); }
      }
      localStorage.setItem(QUEUE_KEY, JSON.stringify(rest));
      if (rest.length < q.length) loadReadStates();
    }
    window.addEventListener('online', flushProgressQueue);

    // ---------- read-state badges (▶ / ◐ / ✓ on issue rows) ----------
    async function loadReadStates() {
      try { readStates = (await api.get('/api/reader/state')).states || {}; } catch { /* keep old */ }
      try { laterSet = new Set(((await api.get('/api/reader/later')).items || []).map((i) => i.issue_id)); } catch { /* keep old */ }
      api.refreshIssueActions?.();
    }
    // Everything keys on the CV issue id: a row's local `id` is a download-
    // queue artifact and is null for issues scanned from disk.
    const stateOf = (issue) => readStates[issue.cv_issue_id];

    // ---------- open / close ----------
    async function openReader(issueId, startPage = null) {
      let m = prewarmed && prewarmed.id === issueId ? prewarmed.manifest : null;
      prewarmed = null;
      if (!m) {
        try { m = await api.get(`/api/reader/issue/${issueId}`); } catch (e) { m = { error: String(e) }; }
      }
      if (!m || m.error) return toast(m && m.error ? m.error : 'Could not open this issue');
      manifest = m;
      later = !!m.later;
      bookmarks = new Set(m.bookmarks || []);
      wide = {}; zoom = 1; panX = panY = 0; half = 0; rotate = 0;
      if (!overlay) build();
      // Per-series reading profile (carried on the manifest) overrides the
      // device defaults.
      const p = m.prefs;
      if (p) {
        if (p.mode) settings.mode = p.mode;
        settings.rtl = !!p.rtl;
        if (p.fit) settings.fit = p.fit;
        settings.split = !!p.split;
        settings.spreadOffset = !!p.spread_offset;
      }
      lastFocus = document.activeElement;
      overlay.classList.remove('is-panelonly');
      overlay.classList.add('is-open');
      document.body.classList.add('reader-open');
      armHistory(); // browser Back closes the reader instead of navigating behind it
      overlay.focus();
      applyLook();
      page = startPage != null ? Math.max(0, Math.min(startPage, m.pages - 1))
        : (m.progress && !m.progress.completed && m.progress.page > 0 && m.progress.page < m.pages)
          ? m.progress.page : 0;
      els.thumbs.innerHTML = '';
      els.panel.hidden = true;   // a panel (e.g. Reading rails) may still be open
      els.next.hidden = true;
      els.end.hidden = true;
      els.info.hidden = true;
      setMode(settings.mode, true);
      syncOfflineButton();
      showChrome();
      flushProgressQueue();
      maybeShowHints();
    }

    // ---- Browser-history integration ----
    // The reader is an overlay, not a route: without this, Back navigates the
    // app BEHIND the open reader. Opening pushes one same-URL history entry;
    // popping it (Back) closes the reader; closing via ✕/Esc consumes the
    // entry with history.back() so the stack stays balanced. Same-URL states
    // mean the app router sees no path change either way.
    // Panels (continue/later/bookmarks/stats) opened OUTSIDE a book use a
    // dim panel-only overlay — never the full black reader shell (which used
    // to open behind them and stay as a black screen after close).
    function showPanelOverlay() {
      if (manifest) { els.panel.hidden = false; return; } // mid-read: plain panel
      overlay.classList.add('is-panelonly');
      overlay.classList.add('is-open');
      document.body.classList.add('reader-open');
      els.panel.hidden = false;
      armHistory(); // Back closes the panel too
    }

    let histArmed = false;
    function armHistory() {
      if (histArmed) return;
      try { history.pushState({ biReader: true }, ''); histArmed = true; } catch { /* sandboxed */ }
    }
    window.addEventListener('popstate', () => {
      if (!histArmed) return;
      histArmed = false; // the entry is already popped — just close the UI
      if (overlay && overlay.classList.contains('is-open')) closeReader();
    });

    function closeReader() {
      if (!overlay) return;
      stopAutoScroll();
      pushProgress(true);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      overlay.classList.remove('is-open');
      overlay.classList.remove('is-panelonly');
      document.body.classList.remove('reader-open');
      if (webtoonObserver) { webtoonObserver.disconnect(); webtoonObserver = null; }
      els.stage.innerHTML = ''; els.webtoon.innerHTML = ''; els.thumbs.innerHTML = '';
      manifest = null;
      loadReadStates(); // refresh ▶/◐/✓ badges with what was just read
      renderHomeRails(); // and the home shelves — progress just changed
      if (lastFocus && lastFocus.focus) lastFocus.focus();
      if (histArmed) { histArmed = false; try { history.back(); } catch { /* fine */ } }
    }

    // Persist the current reading profile for THIS series (called on any
    // mode/rtl/fit/split change while reading).
    function saveSeriesPrefs() {
      saveSettings();
      if (!manifest || !manifest.series.id) return;
      api.post(`/api/reader/series/${manifest.series.id}/prefs`, {
        mode: settings.mode, rtl: settings.rtl, fit: settings.fit,
        split: settings.split, spread_offset: settings.spreadOffset,
      }).catch(() => {});
    }

    // ---------- overlay DOM ----------
    function build() {
      overlay = document.createElement('div');
      overlay.className = 'reader';
      overlay.tabIndex = -1;
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', 'Comic reader');
      overlay.innerHTML = `
        <div class="reader__top">
          <button class="reader__btn reader__close" title="Close (Esc)" aria-label="Close reader">${icon('close')}</button>
          <div class="reader__title"></div>
          <div class="reader__count"></div>
          <span class="reader__spacer"></span>
          <button class="reader__btn r-mode"     title="Reading mode (d/w)" aria-label="Reading mode"></button>
          <button class="reader__btn r-rtl"      title="Reading direction (m)" aria-label="Reading direction"></button>
          <button class="reader__btn r-fit"      title="Fit (h/v/o)" aria-label="Fit mode"></button>
          <button class="reader__btn r-zoom-out" title="Zoom out (-)" aria-label="Zoom out">${icon('zoom-out')}</button>
          <button class="reader__btn r-zoom-in"  title="Zoom in (+)" aria-label="Zoom in">${icon('zoom-in')}</button>
          <button class="reader__btn r-rotate"   title="Rotate page (r)" aria-label="Rotate page">${icon('rotate')}</button>
          <button class="reader__btn r-bookmark" title="Bookmark page (b)" aria-label="Bookmark page">${icon('bookmark')}</button>
          <button class="reader__btn r-later"    title="Read later" aria-label="Read later">${icon('clock')}</button>
          <button class="reader__btn r-info"     title="Issue info (i)" aria-label="Issue info">${icon('info')}</button>
          <button class="reader__btn r-offline"  title="Download for offline" aria-label="Download for offline">${icon('download')}</button>
          <button class="reader__btn r-settings" title="Display settings" aria-label="Display settings">${icon('settings')}</button>
          <button class="reader__btn r-full"     title="Fullscreen (f)" aria-label="Fullscreen">${icon('maximize')}</button>
        </div>
        <div class="reader__settings" hidden>
          <div class="reader__quick"></div>
          <label>Brightness <input type="range" class="r-brightness" min="30" max="130" step="5" aria-label="Brightness"></label>
          <div class="reader__bgs" role="group" aria-label="Background">
            <button data-bg="black" class="reader__bgbtn" title="Black" aria-label="Black background"></button>
            <button data-bg="gray"  class="reader__bgbtn" title="Gray" aria-label="Gray background"></button>
            <button data-bg="white" class="reader__bgbtn" title="White" aria-label="White background"></button>
          </div>
          <div class="reader__filters" role="group" aria-label="Colour filter">
            <button data-filter="none" class="reader__filterbtn">Normal</button>
            <button data-filter="invert" class="reader__filterbtn" title="Invert — easy on the eyes at night / on e-ink">Invert</button>
            <button data-filter="grayscale" class="reader__filterbtn">Gray</button>
            <button data-filter="sepia" class="reader__filterbtn">Sepia</button>
          </div>
          <label class="reader__check" title="Read without recording progress, history, or stats"><input type="checkbox" class="r-incognito"> Incognito (don't record)</label>
          <label title="Hands-free scroll speed in webtoon mode — press s to start/stop">Auto-scroll speed <input type="range" class="r-autospeed" min="15" max="200" step="5" aria-label="Auto-scroll speed"></label>
          <label class="reader__check"><input type="checkbox" class="r-split"> Split wide pages</label>
          <label class="reader__check" title="Fix books whose two-page spreads pair off by one (inside-cover page)"><input type="checkbox" class="r-offset"> Offset spreads (o)</label>
          <label class="reader__check" title="Serve downscaled pages — much less bandwidth on phone/tablet"><input type="checkbox" class="r-datasaver"> Data saver</label>
          <label class="reader__check" title="Shave white scan borders so pages fill more of the screen"><input type="checkbox" class="r-trim"> Trim margins</label>
          <label class="reader__check" title="Tap either edge to go forward (back via keys/swipe)"><input type="checkbox" class="r-tapboth"> Both edges = forward</label>
          <button class="reader__btn r-hints" title="Show gesture & shortcut help (?)">? Shortcuts & gestures</button>
          <div class="reader__bmhead">Bookmarks</div>
          <div class="reader__bmlist"></div>
        </div>
        <div class="reader__body">
          <div class="reader__zone reader__zone--left" aria-hidden="true"></div>
          <div class="reader__stagewrap"><div class="reader__stage"></div></div>
          <div class="reader__webtoon" hidden></div>
          <div class="reader__zone reader__zone--right" aria-hidden="true"></div>
        </div>
        <div class="reader__next" hidden><button class="reader__nextbtn"></button></div>
        <div class="reader__end" hidden></div>
        <div class="reader__infocard" hidden></div>
        <div class="reader__hints" hidden></div>
        <div class="reader__bottom">
          <button class="reader__btn r-thumbs" title="Thumbnails (t)" aria-label="Thumbnails">${icon('grid')}</button>
          <div class="reader__sliderwrap">
            <div class="reader__marks"></div>
            <input type="range" class="reader__slider" min="0" value="0" aria-label="Page">
          </div>
          <div class="reader__pageno"></div>
        </div>
        <div class="reader__thumbs" hidden></div>
        <div class="reader__panel" hidden>
          <div class="reader__panelhead"><span class="reader__paneltitle">Continue reading</span> <button class="reader__btn reader__panelclose" aria-label="Close list">${icon('close')}</button></div>
          <div class="reader__panellist"></div>
        </div>
        <div class="reader__toast" hidden></div>`;
      document.body.appendChild(overlay);
      els = {
        title: overlay.querySelector('.reader__title'),
        count: overlay.querySelector('.reader__count'),
        stagewrap: overlay.querySelector('.reader__stagewrap'),
        stage: overlay.querySelector('.reader__stage'),
        webtoon: overlay.querySelector('.reader__webtoon'),
        slider: overlay.querySelector('.reader__slider'),
        marks: overlay.querySelector('.reader__marks'),
        pageno: overlay.querySelector('.reader__pageno'),
        thumbs: overlay.querySelector('.reader__thumbs'),
        next: overlay.querySelector('.reader__next'),
        nextbtn: overlay.querySelector('.reader__nextbtn'),
        settings: overlay.querySelector('.reader__settings'),
        bmlist: overlay.querySelector('.reader__bmlist'),
        toast: overlay.querySelector('.reader__toast'),
        panel: overlay.querySelector('.reader__panel'),
        panellist: overlay.querySelector('.reader__panellist'),
        mode: overlay.querySelector('.r-mode'),
        rtl: overlay.querySelector('.r-rtl'),
        fit: overlay.querySelector('.r-fit'),
        bookmark: overlay.querySelector('.r-bookmark'),
        offline: overlay.querySelector('.r-offline'),
        split: overlay.querySelector('.r-split'),
        offset: overlay.querySelector('.r-offset'),
        datasaver: overlay.querySelector('.r-datasaver'),
        trim: overlay.querySelector('.r-trim'),
        tapboth: overlay.querySelector('.r-tapboth'),
        incognito: overlay.querySelector('.r-incognito'),
        end: overlay.querySelector('.reader__end'),
        info: overlay.querySelector('.reader__infocard'),
        hints: overlay.querySelector('.reader__hints'),
        quick: overlay.querySelector('.reader__quick'),
        top: overlay.querySelector('.reader__top'),
      };

      // Phones can't fit ten buttons in the top bar. On small screens the
      // secondary tools live in a quick-actions row inside the settings
      // popover; the bar keeps close/title/bookmark/settings/fullscreen. The
      // real elements move (same handlers, no duplicate state).
      const toolBtns = ['.r-mode', '.r-rtl', '.r-fit', '.r-zoom-out', '.r-zoom-in', '.r-rotate', '.r-info', '.r-offline']
        .map((sel) => overlay.querySelector(sel));
      const mq = matchMedia('(max-width: 640px)');
      const placeTools = () => {
        for (const b of toolBtns) {
          if (mq.matches) els.quick.appendChild(b);
          else els.top.insertBefore(b, els.bookmark);
        }
      };
      mq.addEventListener('change', placeTools);
      placeTools();

      overlay.querySelector('.reader__close').onclick = closeReader;
      // Panel-only mode: clicking the dim backdrop closes it.
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay && overlay.classList.contains('is-panelonly')) closeReader();
      });
      els.mode.onclick = () => { setMode(settings.mode === 'single' ? 'double' : settings.mode === 'double' ? 'webtoon' : 'single'); saveSeriesPrefs(); };
      els.rtl.onclick = () => { settings.rtl = !settings.rtl; saveSeriesPrefs(); refreshButtons(); render(); };
      els.fit.onclick = () => { settings.fit = settings.fit === 'height' ? 'width' : settings.fit === 'width' ? 'orig' : 'height'; zoom = 1; panX = panY = 0; saveSeriesPrefs(); refreshButtons(); render(); };
      overlay.querySelector('.r-zoom-in').onclick = () => setZoom(zoom * 1.25);
      overlay.querySelector('.r-zoom-out').onclick = () => setZoom(zoom / 1.25);
      els.bookmark.onclick = toggleBookmark;
      overlay.querySelector('.r-later').onclick = toggleLater;
      els.info.onclick = (e) => { if (e.target === els.info) els.info.hidden = true; };
      overlay.querySelector('.r-info').onclick = toggleInfo;
      els.offline.onclick = toggleOffline;
      overlay.querySelector('.r-settings').onclick = () => { els.settings.hidden = !els.settings.hidden; if (!els.settings.hidden) renderBookmarkList(); };
      overlay.querySelector('.r-full').onclick = toggleFullscreen;

      const bright = overlay.querySelector('.r-brightness');
      bright.value = settings.brightness;
      bright.oninput = () => { settings.brightness = Number(bright.value); saveSettings(); applyLook(); };
      for (const b of overlay.querySelectorAll('.reader__bgbtn')) {
        b.onclick = () => { settings.bg = b.dataset.bg; saveSettings(); applyLook(); };
      }
      overlay.querySelector('.r-rotate').onclick = rotatePage;
      const syncFilterBtns = () => { for (const b of overlay.querySelectorAll('.reader__filterbtn')) b.classList.toggle('is-on', b.dataset.filter === settings.colorFilter); };
      for (const b of overlay.querySelectorAll('.reader__filterbtn')) {
        b.onclick = () => { settings.colorFilter = b.dataset.filter; saveSettings(); applyLook(); syncFilterBtns(); };
      }
      syncFilterBtns();
      els.incognito.checked = settings.incognito;
      els.incognito.onchange = () => setIncognito(els.incognito.checked);
      const autospeed = overlay.querySelector('.r-autospeed');
      autospeed.value = settings.autoScrollSpeed;
      autospeed.oninput = () => { settings.autoScrollSpeed = Number(autospeed.value); saveSettings(); };
      els.split.onchange = () => { settings.split = els.split.checked; half = 0; saveSeriesPrefs(); render(); };
      els.offset.onchange = () => { settings.spreadOffset = els.offset.checked; saveSeriesPrefs(); render(); };
      // Data saver / trim change every page URL — rebuild whatever's showing.
      const requality = () => {
        saveSettings();
        els.thumbs.innerHTML = '';
        if (settings.mode === 'webtoon') { buildWebtoon(); scrollWebtoonTo(page); } else render();
        syncThumbs();
      };
      els.datasaver.onchange = () => { settings.dataSaver = els.datasaver.checked; requality(); };
      els.trim.onchange = () => { settings.trim = els.trim.checked; requality(); };
      els.tapboth.onchange = () => { settings.tapBoth = els.tapboth.checked; saveSettings(); };
      overlay.querySelector('.r-hints').onclick = () => { els.settings.hidden = true; showHints(); };

      els.slider.oninput = () => goTo(Number(els.slider.value));
      overlay.querySelector('.r-thumbs').onclick = () => { settings.thumbs = !settings.thumbs; saveSettings(); syncThumbs(); };
      els.nextbtn.onclick = () => { if (manifest.next) openReader(manifest.next); };
      overlay.querySelector('.reader__panelclose').onclick = () => { if (manifest) els.panel.hidden = true; else closeReader(); };

      // Tap zones: normally left=back/right=forward (RTL-flipped); with
      // "both edges = forward" every edge advances (back via keys/swipe).
      const edgeTap = (side) => {
        if (settings.tapBoth) return next();
        const fwd = side === 'right' ? !settings.rtl : settings.rtl;
        fwd ? next() : prev();
      };
      overlay.querySelector('.reader__zone--left').onclick = () => edgeTap('left');
      overlay.querySelector('.reader__zone--right').onclick = () => edgeTap('right');
      els.stagewrap.addEventListener('click', (e) => {
        if (zoom > 1 || settings.mode === 'webtoon') return;
        const x = e.clientX / window.innerWidth;
        if (x < 0.33) edgeTap('left');
        else if (x > 0.67) edgeTap('right');
        else toggleChrome();
      });
      els.webtoon.addEventListener('click', () => toggleChrome());

      document.addEventListener('keydown', onKey);

      els.stagewrap.addEventListener('wheel', (e) => {
        if (settings.mode === 'webtoon' || zoom > 1) return;
        if (els.stagewrap.scrollHeight > els.stagewrap.clientHeight + 4) return;
        e.preventDefault();
        if (e.deltaY > 0) next(); else prev();
      }, { passive: false });

      installPointerGestures();
      installServiceWorker();
    }

    // ---------- look / chrome / toast ----------
    const FILTER_CSS = { none: '', invert: 'invert(1) hue-rotate(180deg)', grayscale: 'grayscale(1)', sepia: 'sepia(0.6)' };
    function applyLook() {
      overlay.dataset.bg = settings.bg;
      overlay.style.setProperty('--reader-brightness', settings.brightness / 100);
      // Combined image filter: brightness + optional color filter (invert for
      // night/e-ink, grayscale, sepia). One CSS var drives stage + webtoon.
      overlay.style.setProperty('--reader-filter',
        `brightness(${settings.brightness / 100})${FILTER_CSS[settings.colorFilter] ? ' ' + FILTER_CSS[settings.colorFilter] : ''}`);
      overlay.classList.toggle('is-incognito', !!settings.incognito);
      refreshLaterBtn();
      els.split.checked = settings.split;
      els.offset.checked = settings.spreadOffset;
      els.datasaver.checked = settings.dataSaver;
      els.trim.checked = settings.trim;
      els.tapboth.checked = settings.tapBoth;
      refreshButtons();
    }
    function refreshButtons() {
      els.mode.innerHTML = icon(settings.mode === 'single' ? 'page-single' : settings.mode === 'double' ? 'page-double' : 'webtoon');
      // Direction stays plain text — "LTR"/"RTL" are ASCII letters that render
      // identically everywhere (the old ← → arrows were the problem).
      els.rtl.innerHTML = `<span class="reader__ico-txt">${settings.rtl ? 'RTL' : 'LTR'}</span>`;
      els.fit.innerHTML = settings.fit === 'height' ? icon('fit-height')
        : settings.fit === 'width' ? icon('fit-width')
        : '<span class="reader__ico-txt">1:1</span>';
      const marked = bookmarks.has(page);
      els.bookmark.innerHTML = icon('bookmark', { fill: marked });
      els.bookmark.classList.toggle('is-on', marked);
      for (const b of overlay.querySelectorAll('.reader__bgbtn')) b.classList.toggle('is-on', b.dataset.bg === settings.bg);
    }
    // Chrome only appears deliberately: a center tap toggles it (and it stays
    // until toggled back), plus a brief auto-hiding peek when an issue opens.
    // No pointermove reveal — that made the bars cover the art on every mouse
    // twitch.
    function toggleChrome() {
      clearTimeout(chromeTimer); // a pending auto-hide must not fight the toggle
      overlay.classList.toggle('chrome-hidden');
    }
    function showChrome() {
      overlay.classList.remove('chrome-hidden');
      clearTimeout(chromeTimer);
      chromeTimer = setTimeout(() => { if (settings.mode !== 'webtoon') overlay.classList.add('chrome-hidden'); }, 2800);
    }
    function toast(msg) {
      if (!overlay) { console.warn('[reader]', msg); return; }
      els.toast.textContent = msg;
      els.toast.hidden = false;
      clearTimeout(toast._t);
      toast._t = setTimeout(() => { els.toast.hidden = true; }, 2600);
    }
    function toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else overlay.requestFullscreen().catch(() => {});
    }

    // ---------- modes & rendering ----------
    function setMode(mode, initial = false) {
      if (mode !== 'webtoon') stopAutoScroll(); // auto-scroll is webtoon-only
      settings.mode = mode;
      const webtoon = mode === 'webtoon';
      els.stagewrap.style.display = webtoon ? 'none' : '';
      els.webtoon.hidden = !webtoon;
      if (webtoonObserver) { webtoonObserver.disconnect(); webtoonObserver = null; }
      if (webtoon) buildWebtoon();
      refreshButtons();
      if (!webtoon) render();
      if (initial && webtoon) scrollWebtoonTo(page);
      syncHud();
      syncThumbs();
    }

    function spreadFor(p) {
      if (settings.mode !== 'double') return [p];
      // Offset spreads: some books carry an inside-cover page, pairing every
      // spread off by one — showing pages 0 AND 1 alone realigns the grid.
      if (p < 1 + (settings.spreadOffset ? 1 : 0)) return [p];
      if (wide[p]) return [p];
      const partner = p + 1;
      if (partner >= manifest.pages || wide[partner]) return [p];
      return [p, partner];
    }
    const splitActive = () => settings.split && settings.mode === 'single' && wide[page];

    function render() {
      if (!manifest || settings.mode === 'webtoon') return;
      const spread = spreadFor(page);
      const shown = settings.rtl ? [...spread].reverse() : spread;
      els.stage.innerHTML = '';
      els.stage.dataset.fit = settings.fit;
      for (const n of shown) {
        const holder = splitActive() && n === page ? buildSplitHalf(n) : buildPageImg(n);
        els.stage.appendChild(holder);
      }
      els.stage.style.transform = stageTransform();
      preload(spread[spread.length - 1]);
      syncHud();
      maybeFinish();
    }

    function buildPageImg(n) {
      const img = new Image();
      img.className = 'reader__page';
      img.src = pageUrl(n);
      img.draggable = false;
      img.alt = `Page ${n + 1}`;
      img.onload = () => {
        const isWide = img.naturalWidth > img.naturalHeight;
        if (isWide && !wide[n]) { wide[n] = true; if (settings.mode === 'double' || settings.split) render(); }
      };
      img.onerror = () => failPage(img, n);
      return img;
    }

    // Wide-page split: a viewport clipped to one half of the double-width image
    // (RTL comics read the RIGHT half first).
    function buildSplitHalf(n) {
      const wrap = document.createElement('div');
      wrap.className = 'reader__halfwrap';
      const img = buildPageImg(n);
      img.classList.add('reader__page--split');
      const showRightFirst = settings.rtl;
      const showRight = (half === 0) === showRightFirst;
      img.classList.add(showRight ? 'is-right' : 'is-left');
      wrap.appendChild(img);
      return wrap;
    }

    function failPage(img, n) {
      const err = document.createElement('div');
      err.className = 'reader__pageerr';
      err.innerHTML = `<div>Page ${n + 1} failed to load</div>`;
      const btn = document.createElement('button');
      btn.className = 'reader__btn';
      btn.textContent = 'Retry';
      btn.onclick = () => { const u = pageUrl(n); img.src = u + (u.includes('?') ? '&' : '?') + `r=${Date.now()}`; err.replaceWith(img); };
      err.appendChild(btn);
      img.replaceWith(err);
    }

    function preload(from) {
      for (let n = from + 1; n <= Math.min(from + 3, manifest.pages - 1); n++) {
        const i = new Image();
        i.src = pageUrl(n);
        i.decode?.().catch(() => {}); // decode ahead so page turns never jank
      }
    }

    // ---------- webtoon (with far-page unloading to cap memory) ----------
    function buildWebtoon() {
      els.webtoon.innerHTML = '';
      const frag = document.createDocumentFragment();
      for (let n = 0; n < manifest.pages; n++) {
        const img = new Image();
        img.className = 'reader__wpage';
        img.loading = 'lazy';
        img.dataset.page = n;
        img.src = pageUrl(n);
        img.draggable = false;
        img.alt = `Page ${n + 1}`;
        img.onload = () => { img.dataset.ratio = (img.naturalHeight / img.naturalWidth).toFixed(4); };
        img.onerror = () => failPage(img, n);
        frag.appendChild(img);
      }
      els.webtoon.appendChild(frag);
      webtoonObserver = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            page = Number(e.target.dataset.page);
            syncHud(); queueProgress(); maybeFinish();
          }
        }
        unloadFarPages();
      }, { root: els.webtoon, threshold: 0.5 });
      for (const img of els.webtoon.children) webtoonObserver.observe(img);
    }
    // ---------- webtoon auto-scroll ----------
    // Hands-free continuous scroll at settings.autoScrollSpeed px/s. Only
    // meaningful in webtoon mode; stops at the bottom, on mode change, or close.
    function toggleAutoScroll() {
      if (settings.mode !== 'webtoon') { toast('Auto-scroll works in webtoon mode (w)'); return; }
      autoScroll ? stopAutoScroll() : startAutoScroll();
    }
    function startAutoScroll() {
      autoScroll = true; autoScrollLast = 0;
      overlay.classList.add('is-autoscroll');
      toast(`Auto-scroll ${settings.autoScrollSpeed}px/s — s to stop`);
      const step = (t) => {
        if (!autoScroll) return;
        if (autoScrollLast) {
          els.webtoon.scrollTop += settings.autoScrollSpeed * (t - autoScrollLast) / 1000;
          if (els.webtoon.scrollTop + els.webtoon.clientHeight >= els.webtoon.scrollHeight - 1) return stopAutoScroll();
        }
        autoScrollLast = t;
        autoScrollRAF = requestAnimationFrame(step);
      };
      autoScrollRAF = requestAnimationFrame(step);
    }
    function stopAutoScroll() {
      autoScroll = false;
      if (autoScrollRAF) cancelAnimationFrame(autoScrollRAF);
      autoScrollRAF = null;
      overlay?.classList.remove('is-autoscroll');
    }

    // Long webtoons would keep hundreds of decoded images alive — drop the src
    // of pages far from the viewport, holding their height so scroll is stable.
    function unloadFarPages() {
      for (const img of els.webtoon.children) {
        const n = Number(img.dataset.page);
        const near = Math.abs(n - page) <= 10;
        if (!near && img.src && img.dataset.ratio) {
          img.style.height = `${img.clientWidth * Number(img.dataset.ratio)}px`;
          img.removeAttribute('src');
        } else if (near && !img.src) {
          img.src = pageUrl(n);
          img.style.height = '';
        }
      }
    }
    function scrollWebtoonTo(n) {
      const img = els.webtoon.querySelector(`[data-page="${n}"]`);
      if (img) { if (!img.src) { img.src = pageUrl(n); img.style.height = ''; } img.scrollIntoView(); }
    }

    // ---------- navigation ----------
    function stepSize() { return settings.mode === 'double' ? spreadFor(page).length : 1; }
    function next() {
      if (splitActive() && half === 0) { half = 1; render(); return; }
      const target = page + stepSize();
      if (target >= manifest.pages) return maybeFinish(true);
      half = 0;
      goTo(target);
    }
    function prev() {
      if (splitActive() && half === 1) { half = 0; render(); return; }
      if (page === 0) return;
      let target = page - 1;
      if (settings.mode === 'double' && target > 0 && !wide[target - 1] && !wide[target] && spreadFor(target - 1).includes(target)) target -= 1;
      half = settings.split && wide[target] ? 1 : 0; // arrive at a wide page's tail half
      goTo(Math.max(0, target));
    }
    function goTo(n) {
      page = Math.max(0, Math.min(n, manifest.pages - 1));
      zoom = 1; panX = panY = 0;
      if (settings.mode === 'webtoon') scrollWebtoonTo(page);
      else render();
      queueProgress();
      syncHud();
    }

    function onKey(e) {
      if (!overlay || !overlay.classList.contains('is-open')) return;
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      // Focus trap: keep Tab inside the dialog.
      if (e.key === 'Tab') {
        const focusables = overlay.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])');
        const list = [...focusables].filter((f) => f.offsetParent !== null);
        if (list.length) {
          const idx = list.indexOf(document.activeElement);
          let ni = idx + (e.shiftKey ? -1 : 1);
          if (ni < 0) ni = list.length - 1;
          if (ni >= list.length) ni = 0;
          list[ni].focus();
          e.preventDefault();
        }
        return;
      }
      const fwd = () => (settings.rtl ? prev() : next());
      const back = () => (settings.rtl ? next() : prev());
      switch (e.key) {
        case 'ArrowRight': case 'PageDown': fwd(); break;
        case 'ArrowLeft': case 'PageUp': back(); break;
        case ' ': e.shiftKey ? prev() : next(); e.preventDefault(); break;
        case 'Home': goTo(0); break;
        case 'End': goTo(manifest.pages - 1); break;
        case 'f': toggleFullscreen(); break;
        case 'd': setMode(settings.mode === 'double' ? 'single' : 'double'); saveSeriesPrefs(); break;
        case 'w': setMode(settings.mode === 'webtoon' ? 'single' : 'webtoon'); saveSeriesPrefs(); break;
        case 'm': settings.rtl = !settings.rtl; saveSeriesPrefs(); refreshButtons(); render(); break;
        case 'b': toggleBookmark(); break;
        case 'r': rotatePage(); break;
        case 's': toggleAutoScroll(); break;
        case 't': settings.thumbs = !settings.thumbs; saveSettings(); syncThumbs(); break;
        case 'i': toggleInfo(); break;
        case 'o': settings.spreadOffset = !settings.spreadOffset; els.offset.checked = settings.spreadOffset; saveSeriesPrefs(); render(); toast(settings.spreadOffset ? 'Spreads shifted by one' : 'Spread offset off'); break;
        case '?': showHints(); break;
        case '+': case '=': setZoom(zoom * 1.25); break;
        case '-': setZoom(zoom / 1.25); break;
        case 'Escape':
          if (!els.hints.hidden) els.hints.hidden = true;
          else if (!els.info.hidden) els.info.hidden = true;
          else if (!els.end.hidden) els.end.hidden = true;
          else if (!els.panel.hidden) els.panel.hidden = true;
          else closeReader();
          break;
        default: return;
      }
      e.preventDefault();
    }

    // ---------- zoom / pan / gestures ----------
    // Combined page transform: pan + zoom + session rotation.
    function stageTransform() {
      return `translate(${panX}px, ${panY}px) scale(${zoom}) rotate(${rotate}deg)`;
    }
    function rotatePage() {
      rotate = (rotate + 90) % 360;
      els.stage.style.transform = stageTransform();
      toast(rotate ? `Rotated ${rotate}°` : 'Rotation reset');
    }
    function setZoom(z) {
      zoom = Math.max(1, Math.min(6, z));
      if (zoom === 1) { panX = panY = 0; }
      els.stage.style.transform = stageTransform();
      els.stagewrap.classList.toggle('is-zoomed', zoom > 1);
    }
    function installPointerGestures() {
      const active = new Map();
      let pinchStart = null, panStart = null, swipeStart = null;
      const wrap = els.stagewrap;
      wrap.addEventListener('pointerdown', (e) => {
        active.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (active.size === 2) {
          const [a, b] = [...active.values()];
          pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom };
          swipeStart = null;
        } else if (active.size === 1) {
          swipeStart = { x: e.clientX, y: e.clientY, t: Date.now() };
          if (zoom > 1) panStart = { x: e.clientX - panX, y: e.clientY - panY };
        }
      });
      wrap.addEventListener('pointermove', (e) => {
        if (!active.has(e.pointerId)) return;
        active.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (active.size === 2 && pinchStart) {
          const [a, b] = [...active.values()];
          setZoom(pinchStart.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / pinchStart.d));
        } else if (active.size === 1 && zoom > 1 && panStart) {
          panX = e.clientX - panStart.x;
          panY = e.clientY - panStart.y;
          els.stage.style.transform = stageTransform();
        }
      });
      const up = (e) => {
        const start = swipeStart;
        active.delete(e.pointerId);
        if (active.size < 2) pinchStart = null;
        if (active.size === 0) panStart = null;
        if (start && zoom === 1 && settings.mode !== 'webtoon' && active.size === 0) {
          const dx = e.clientX - start.x, dy = e.clientY - start.y, dt = Date.now() - start.t;
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 600) {
            if (dx < 0) (settings.rtl ? prev() : next());
            else (settings.rtl ? next() : prev());
          }
        }
        swipeStart = null;
      };
      wrap.addEventListener('pointerup', up);
      wrap.addEventListener('pointercancel', up);
      wrap.addEventListener('dblclick', (e) => { e.preventDefault(); setZoom(zoom > 1 ? 1 : 2.2); });
    }

    // ---------- HUD / slider marks / thumbs ----------
    function syncHud() {
      if (!manifest) return;
      els.title.textContent = `${manifest.series.title} — #${manifest.issue.number ?? '?'}${manifest.issue.title ? ' · ' + manifest.issue.title : ''}`;
      els.count.textContent = `${page + 1} / ${manifest.pages}`;
      els.slider.max = manifest.pages - 1;
      els.slider.value = page;
      els.pageno.textContent = `${page + 1}/${manifest.pages}`;
      renderSliderMarks();
      refreshButtons();
    }
    function renderSliderMarks() {
      els.marks.innerHTML = '';
      const max = Math.max(1, manifest.pages - 1);
      for (const b of bookmarks) {
        const m = document.createElement('div');
        m.className = 'reader__mark';
        m.style.left = `${(b / max) * 100}%`;
        m.title = `Bookmark — page ${b + 1}`;
        els.marks.appendChild(m);
      }
    }
    function syncThumbs() {
      els.thumbs.hidden = !settings.thumbs || settings.mode === 'webtoon';
      if (els.thumbs.hidden) return;
      if (!els.thumbs.childElementCount) {
        const frag = document.createDocumentFragment();
        for (let n = 0; n < manifest.pages; n++) {
          const img = new Image();
          img.className = 'reader__thumb';
          img.loading = 'lazy';
          img.src = pageUrl(n, 200); // downscaled server-side — pennies, not megabytes
          img.dataset.page = n;
          img.alt = `Page ${n + 1}`;
          img.onclick = () => goTo(n);
          frag.appendChild(img);
        }
        els.thumbs.appendChild(frag);
      }
      for (const t of els.thumbs.children) t.classList.toggle('is-current', Number(t.dataset.page) === page);
      const cur = els.thumbs.querySelector('.is-current');
      if (cur) cur.scrollIntoView({ inline: 'center', block: 'nearest' });
    }

    // ---------- bookmarks ----------
    async function toggleBookmark() {
      const on = !bookmarks.has(page);
      if (on) bookmarks.add(page); else bookmarks.delete(page);
      refreshButtons();
      renderSliderMarks();
      try { await api.post(`/api/reader/issue/${manifest.issue.id}/bookmark`, { page, on }); } catch { /* keep local */ }
    }
    function refreshLaterBtn() {
      const b = overlay.querySelector('.r-later');
      if (b) { b.classList.toggle('is-on', later); b.title = later ? 'Remove from Read later' : 'Read later'; }
    }
    async function toggleLater() {
      later = !later;
      refreshLaterBtn();
      toast(later ? 'Added to Read later' : 'Removed from Read later');
      try {
        const r = await api.post(`/api/reader/issue/${manifest.issue.id}/later`, { on: later });
        later = !!r.later; refreshLaterBtn();
        readStates && api.refreshIssueActions?.();
      } catch { /* keep local */ }
    }
    function renderBookmarkList() {
      els.bmlist.innerHTML = '';
      if (!bookmarks.size) { els.bmlist.textContent = 'None yet — press b on a page.'; return; }
      for (const b of [...bookmarks].sort((x, y) => x - y)) {
        const item = document.createElement('button');
        item.className = 'reader__bmitem';
        item.innerHTML = `<img src="${pageUrl(b, 200)}" alt=""><span>p. ${b + 1}</span>`;
        item.onclick = () => { goTo(b); els.settings.hidden = true; };
        els.bmlist.appendChild(item);
      }
    }

    // ---------- progress / next issue / prewarm ----------
    function queueProgress() {
      clearTimeout(progressTimer);
      progressTimer = setTimeout(() => pushProgress(), 900);
    }
    function pushProgress(sync = false) {
      if (!manifest) return;
      if (settings.incognito) return; // private reading — record nothing
      clearTimeout(progressTimer);
      const done = page >= manifest.pages - 1;
      readStates[manifest.issue.id] = { page, pages: manifest.pages, completed: done || readStates[manifest.issue.id]?.completed ? 1 : 0 };
      const body = { page, pages: manifest.pages, completed: done };
      const url = `/api/reader/issue/${manifest.issue.id}/progress`;
      if (!navigator.onLine) return enqueueProgress(url, body); // offline read — replay later
      if (sync && navigator.sendBeacon) {
        if (!navigator.sendBeacon(url, new Blob([JSON.stringify(body)], { type: 'application/json' }))) enqueueProgress(url, body);
      } else api.post(url, body).catch(() => enqueueProgress(url, body));
    }
    async function maybeFinish(fromNav = false) {
      const atEnd = page + stepSize() >= manifest.pages;
      if (!atEnd) { els.next.hidden = true; els.end.hidden = true; return; }
      pushProgress();
      if (fromNav) return showEndCard(); // advancing past the last page
      if (manifest.next) {
        els.nextbtn.innerHTML = `Next issue ${icon('arrow-right')}`;
        els.next.hidden = false;
        prewarm();
      }
    }
    // Prewarm: fetch the next manifest + its first pages so the hop is instant.
    async function prewarm() {
      if (!manifest.next || (prewarmed && prewarmed.id === manifest.next)) return;
      try {
        const nm = await api.get(`/api/reader/issue/${manifest.next}`);
        if (nm && !nm.error) {
          prewarmed = { id: manifest.next, manifest: nm };
          for (let n = 0; n < Math.min(3, nm.pages); n++) {
            const i = new Image();
            i.src = `/api/reader/issue/${nm.issue.id}/page/${n}${pageParams(0)}`;
            i.decode?.().catch(() => {});
          }
        }
      } catch { /* prewarm is best-effort */ }
    }

    // ---------- end-of-issue card ----------
    function showEndCard() {
      const m = manifest;
      const finished = `You finished ${escapeHtml(m.series.title)} #${escapeHtml(String(m.issue.number ?? '?'))}`;
      let body;
      if (m.next) {
        body = `
          <img src="/api/reader/issue/${m.next}/page/0?w=400" alt="" loading="lazy">
          <div class="reader__endinfo">
            <small>${finished}</small>
            <b>Up next</b>
            <div class="reader__endbtns">
              <button class="reader__nextbtn e-next">Next issue ${icon('arrow-right')}</button>
              <button class="reader__btn e-reread">${icon('rotate-ccw')} Re-read</button>
              <button class="reader__btn e-back">Back to series</button>
            </div>
          </div>`;
        prewarm();
      } else {
        body = `
          <div class="reader__endinfo">
            <small>${finished}</small>
            <b>End of series</b>
            <div class="reader__endbtns">
              <button class="reader__btn e-reread">${icon('rotate-ccw')} Re-read</button>
              <button class="reader__btn e-back">Back to series</button>
            </div>
          </div>`;
      }
      els.end.innerHTML = body;
      els.next.hidden = true;
      els.end.hidden = false;
      const q = (sel) => els.end.querySelector(sel);
      if (q('.e-next')) q('.e-next').onclick = () => { els.end.hidden = true; openReader(m.next); };
      q('.e-reread').onclick = () => { els.end.hidden = true; goTo(0); };
      q('.e-back').onclick = () => { els.end.hidden = true; closeReader(); };
      (q('.e-next') || q('.e-reread')).focus();
    }

    // ---------- issue info overlay ----------
    function toggleInfo() {
      if (!els.info.hidden) { els.info.hidden = true; return; }
      const inf = manifest.info;
      const credits = (inf?.credits || [])
        .map((c) => `<div class="reader__credit"><span>${escapeHtml(c.role || '')}</span><b>${escapeHtml(c.name || '')}</b></div>`)
        .join('');
      // CV descriptions are sanitized HTML paragraphs — strip tags to be safe.
      const desc = String(inf?.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      // CV's site_detail_url must clear the scheme allowlist (blocks a poisoned
      // javascript:/data: link from executing on click).
      const safeCvUrl = api.safeUrl ? api.safeUrl(inf?.site_detail_url) : '';
      els.info.innerHTML = `
        <div class="reader__infobox" role="document">
          <div class="reader__panelhead">${escapeHtml(manifest.series.title)} #${escapeHtml(String(manifest.issue.number ?? '?'))}
            <button class="reader__btn i-close" aria-label="Close info">${icon('close')}</button></div>
          <div class="reader__infobody">
            ${inf?.name ? `<h3>${escapeHtml(inf.name)}</h3>` : ''}
            ${inf?.cover_date || inf?.store_date ? `<div class="reader__infodates">${inf.store_date ? `In stores ${escapeHtml(inf.store_date)}` : ''}${inf.store_date && inf.cover_date ? ' · ' : ''}${inf.cover_date ? `Cover date ${escapeHtml(inf.cover_date)}` : ''}</div>` : ''}
            ${desc ? `<p>${escapeHtml(desc)}</p>` : ''}
            ${credits ? `<div class="reader__bmhead">Credits</div><div class="reader__credits">${credits}</div>` : ''}
            ${!inf ? '<p class="reader__panelempty">No ComicVine metadata for this issue yet — use “Tag files” on the series.</p>' : ''}
            ${safeCvUrl ? `<a class="reader__extlink" href="${escapeHtml(safeCvUrl)}" target="_blank" rel="noreferrer">View on ComicVine ${icon('external-link')}</a>` : ''}
          </div>
        </div>`;
      els.info.querySelector('.i-close').onclick = () => { els.info.hidden = true; };
      els.info.hidden = false;
    }

    // ---------- first-run gesture hints ----------
    function maybeShowHints() {
      if (localStorage.getItem('readerHintsSeen')) return;
      localStorage.setItem('readerHintsSeen', '1');
      showHints();
    }
    function showHints() {
      els.hints.innerHTML = `
        <div class="reader__hintbox">
          <div class="reader__hintzones" aria-hidden="true">
            <div>${icon('chevron-left')}<small>${settings.tapBoth ? 'forward' : 'back'}</small></div>
            <div>${icon('menu')}<small>menu</small></div>
            <div>${icon('chevron-right')}<small>forward</small></div>
          </div>
          <div class="reader__hintkeys">
            <div><b>← →  space</b> turn pages · <b>swipe</b> works too</div>
            <div><b>d</b> double-page · <b>w</b> webtoon · <b>m</b> reading direction</div>
            <div><b>o</b> offset spreads · <b>b</b> bookmark · <b>r</b> rotate · <b>i</b> issue info · <b>t</b> thumbnails</div>
            <div><b>s</b> auto-scroll (webtoon) · <b>f</b> fullscreen · <b>+ −</b> zoom (pinch & double-tap too) · <b>?</b> this help</div>
          </div>
          <button class="reader__nextbtn h-close">Got it</button>
        </div>`;
      els.hints.querySelector('.h-close').onclick = () => { els.hints.hidden = true; };
      els.hints.onclick = (e) => { if (e.target === els.hints) els.hints.hidden = true; };
      els.hints.hidden = false;
    }

    // ---------- offline (service worker) ----------
    function installServiceWorker() {
      if (!('serviceWorker' in navigator)) { els.offline.style.display = 'none'; return; }
      navigator.serviceWorker.register('/reader-sw.js', { scope: '/' })
        .then((reg) => { sw = reg; })
        .catch(() => { els.offline.style.display = 'none'; });
      navigator.serviceWorker.addEventListener('message', (e) => {
        const d = e.data || {};
        if (d.type === 'cache-progress' && manifest && d.issueId === manifest.issue.id) {
          els.offline.innerHTML = `<span class="reader__ico-txt">${Math.round((d.done / d.total) * 100)}%</span>`;
        } else if (d.type === 'cache-done') {
          if (d.removed) offlineIssues.delete(d.issueId); else offlineIssues.add(d.issueId);
          syncOfflineButton();
          toast(d.removed ? 'Offline copy removed' : 'Available offline ✓');
        }
      });
      // Which issues are already cached? Ask the Cache API directly.
      caches.open('reader-offline-v1').then(async (c) => {
        for (const req of await c.keys()) {
          const m = req.url.match(/\/api\/reader\/issue\/(\d+)\/page\/0(\?|$)/);
          if (m) offlineIssues.add(Number(m[1]));
        }
        syncOfflineButton();
      }).catch(() => {});
    }
    function syncOfflineButton() {
      if (!manifest) return;
      const cached = offlineIssues.has(manifest.issue.id);
      els.offline.classList.remove('is-loading');
      els.offline.innerHTML = cached ? icon('check') : icon('download');
      els.offline.classList.toggle('is-on', cached);
      els.offline.title = cached ? 'Remove offline copy' : 'Download for offline';
    }
    function toggleOffline() {
      const ctrl = navigator.serviceWorker?.controller;
      if (!ctrl) return toast('Offline support initializing — try again in a moment');
      const cached = offlineIssues.has(manifest.issue.id);
      ctrl.postMessage({
        type: cached ? 'uncache-issue' : 'cache-issue',
        issueId: manifest.issue.id,
        pages: manifest.pages,
        origin: location.origin,
        suffix: pageParams(0), // cache the exact variant this device reads
      });
      if (!cached) { els.offline.innerHTML = icon('download'); els.offline.classList.add('is-loading'); }
    }

    // ---------- continue-reading panel ----------
    async function openContinuePanel() {
      if (!overlay) build();
      overlay.querySelector('.reader__paneltitle').textContent = 'Continue reading';
      let r;
      try { r = await api.get('/api/reader/continue'); } catch { r = { items: [] } }
      const items = (r && r.items) || [];
      els.panellist.innerHTML = '';
      if (!items.length) {
        els.panellist.innerHTML = '<div class="reader__panelempty">Nothing in progress — open any owned issue with its ▶ button.</div>';
      }
      for (const it of items) {
        const pct = it.pages ? Math.round((it.page / it.pages) * 100) : 0;
        const el = document.createElement('button');
        el.className = 'reader__contitem';
        el.innerHTML = `
          <img src="/api/reader/issue/${it.issue_id}/page/0?w=200" alt="" loading="lazy">
          <span class="reader__continfo">
            <b>${escapeHtml(it.series)} #${escapeHtml(String(it.issue_number ?? '?'))}</b>
            <small>${escapeHtml(it.title || '')}</small>
            <span class="reader__contbar"><span style="width:${pct}%"></span></span>
            <small>page ${it.page + 1} of ${it.pages} · ${pct}%</small>
          </span>`;
        el.onclick = () => { els.panel.hidden = true; openReader(it.issue_id); };
        els.panellist.appendChild(el);
      }
      showPanelOverlay();
    }
    const escapeHtml = (s) => api.escapeHtml ? api.escapeHtml(s) : String(s);

    // ---------- read-later & bookmarks panels ----------
    // Both reuse the Continue-panel chrome: a title + a list of items that open
    // the issue (bookmarks open at their saved page).
    function openListPanel(title, items, onClick, emptyHtml, thumbPage = () => 0) {
      if (!overlay) build();
      overlay.querySelector('.reader__paneltitle').textContent = title;
      els.panellist.innerHTML = items.length ? '' : `<div class="reader__panelempty">${emptyHtml}</div>`;
      for (const it of items) {
        const el = document.createElement('button');
        el.className = 'reader__contitem';
        el.innerHTML = `
          <img src="/api/reader/issue/${it.issue_id}/page/${thumbPage(it)}?w=200" alt="" loading="lazy">
          <span class="reader__continfo">
            <b>${escapeHtml(it.series || '?')} #${escapeHtml(String(it.issue_number ?? '?'))}</b>
            <small>${escapeHtml(it.title || '')}</small>
            ${it.page != null ? `<small>bookmarked p. ${it.page + 1}</small>` : ''}
          </span>`;
        el.onclick = () => { els.panel.hidden = true; onClick(it); };
        els.panellist.appendChild(el);
      }
      showPanelOverlay();
    }
    async function openLaterPanel() {
      let r; try { r = await api.get('/api/reader/later'); } catch { r = { items: [] } }
      openListPanel('Read later', (r && r.items) || [],
        (it) => openReader(it.issue_id),
        'Nothing saved — use the Read later button in the reader (or the “Read later” row action) to add issues.');
    }
    async function openBookmarksPanel() {
      let r; try { r = await api.get('/api/reader/bookmarks'); } catch { r = { items: [] } }
      openListPanel('My bookmarks', (r && r.items) || [],
        (it) => openReader(it.issue_id, it.page),
        'No bookmarks yet — press b on a page while reading.',
        (it) => it.page || 0);
    }

    // ---------- reading-stats panel ----------
    // Same panel chrome as Continue reading, different content: lifetime and
    // this-month totals, a 30-day bar strip, the streak, top series.
    async function openStatsPanel() {
      if (!overlay) build();
      overlay.querySelector('.reader__paneltitle').textContent = 'Reading stats';
      let st = null;
      try { st = await api.get('/api/reader/stats'); } catch { /* render empty state */ }
      els.panellist.innerHTML = '';
      if (!st || !st.totals || (!st.totals.pages && !st.totals.completed)) {
        els.panellist.innerHTML = '<div class="reader__panelempty">No reading yet — stats build up as you read.</div>';
      } else {
        // 30-day strip: one bar per day, scaled to the busiest day.
        const byDay = new Map((st.last30 || []).map((d) => [d.day, d]));
        const days = [];
        for (let i = 29; i >= 0; i--) {
          const dt = new Date(); dt.setUTCDate(dt.getUTCDate() - i);
          const key = dt.toISOString().slice(0, 10);
          days.push({ key, pages: byDay.get(key)?.pages || 0 });
        }
        const max = Math.max(1, ...days.map((d) => d.pages));
        const bars = days.map((d) =>
          `<span class="reader__statbar" title="${d.key}: ${d.pages} page${d.pages === 1 ? '' : 's'}"><span style="height:${Math.round((d.pages / max) * 100)}%"></span></span>`).join('');
        const top = (st.topSeries || []).map((t) =>
          `<div class="reader__stattop"><span>${escapeHtml(t.series || '?')}</span><b>${t.finished}</b></div>`).join('');
        els.panellist.innerHTML = `
          <div class="reader__stats">
            <div class="reader__statgrid">
              <div class="reader__stat"><b>${st.totals.pages.toLocaleString()}</b><small>pages read</small></div>
              <div class="reader__stat"><b>${st.totals.completed.toLocaleString()}</b><small>issues finished</small></div>
              <div class="reader__stat"><b>${st.month.pages.toLocaleString()}</b><small>pages this month</small></div>
              <div class="reader__stat"><b>${st.streak}</b><small>day streak${st.streak ? ' 🔥' : ''}</small></div>
            </div>
            <div class="reader__stath">Last 30 days</div>
            <div class="reader__statbars">${bars}</div>
            ${top ? `<div class="reader__stath">Most finished</div>${top}` : ''}
          </div>`;
      }
      showPanelOverlay();
    }

    // ---------- home reading shelves ----------
    // Data-driven: each shelf is { key, pref, title, url, def, bar?, page?, dedupe? }.
    // Rendered into the core library's #home-plugin-rail slot; each is per-user
    // dismissible, and "Reading rails…" lists them all. `def` is the fallback
    // when prefs can't be fetched; the server holds the real defaults.
    const SHELVES = [
      { key: 'continue',  pref: 'showContinue',  title: 'Continue reading',    url: '/api/reader/continue',          def: true, bar: true },
      { key: 'next',      pref: 'showNext',       title: 'Next up',             url: '/api/reader/next-up',           def: true },
      { key: 'new',       pref: 'showNew',        title: 'New in your library', url: '/api/reader/new-in-library',    def: true },
      { key: 'later',     pref: 'showLater',      title: 'Read later',          url: '/api/reader/later',             def: false },
      { key: 'finished',  pref: 'showFinished',   title: 'Recently finished',   url: '/api/reader/recently-finished', def: false },
      { key: 'startnew',  pref: 'showStartNew',   title: 'Start a new series',  url: '/api/reader/start-new',         def: false },
      { key: 'bookmarks', pref: 'showBookmarks',  title: 'Bookmarks',           url: '/api/reader/bookmarks',         def: false, page: (it) => it.page || 0, dedupe: true },
    ];
    let homePrefs = null;
    const shelfOn = (s) => (homePrefs && s.pref in homePrefs) ? homePrefs[s.pref] !== false : s.def;
    async function renderHomeRails() {
      const railSlot = api.slot('home-plugin-rail'); // lazy — the library may mount after us
      if (!railSlot) return;
      try { homePrefs = await api.get('/api/reader/home-prefs'); } catch { /* keep last/defaults */ }
      const shown = SHELVES.filter(shelfOn);
      const results = await Promise.all(shown.map((s) =>
        api.get(s.url).then((r) => ({ s, items: (r && r.items) || [] })).catch(() => ({ s, items: [] }))));
      const desired = [];
      for (const { s, items } of results) {
        const list = s.dedupe ? dedupeByIssue(items) : items;
        if (list.length) desired.push(buildRail(s, list));
      }
      // Reconcile against the current DOM: reuse a shelf's existing node when its
      // content is unchanged, so its cover images don't reload and flash. Only a
      // shelf that actually changed is swapped; if nothing changed, don't touch
      // the DOM at all (closing a book you didn't advance → no flash).
      const existing = new Map([...railSlot.children].map((el) => [el.dataset.shelf, el]));
      const finalNodes = desired.map((next) => {
        const old = existing.get(next.dataset.shelf);
        return old && old.innerHTML === next.innerHTML ? old : next;
      });
      const unchanged = finalNodes.length === railSlot.children.length
        && finalNodes.every((n, i) => n === railSlot.children[i]);
      if (!unchanged) railSlot.replaceChildren(...finalNodes);
    }
    function dedupeByIssue(items) {
      const seen = new Set(); const out = [];
      for (const it of items) if (!seen.has(it.issue_id)) { seen.add(it.issue_id); out.push(it); }
      return out;
    }
    function buildRail(shelf, items) {
      const sec = document.createElement('section');
      sec.className = 'reader-rail';
      sec.dataset.shelf = shelf.key; // for render reconciliation (avoids image flash)
      const head = document.createElement('div');
      head.className = 'reader-rail__head';
      const h = document.createElement('span');
      h.className = 'reader-rail__title'; h.textContent = shelf.title;
      const hide = document.createElement('button');
      hide.className = 'reader-rail__hide';
      hide.title = 'Hide this shelf — turn it back on from “Reading rails…”';
      hide.setAttribute('aria-label', 'Hide ' + shelf.title);
      hide.innerHTML = hicon('close', { size: 16 }, '×');
      hide.onclick = () => hideShelf(shelf);
      head.append(h, hide);
      const track = document.createElement('div');
      track.className = 'reader-rail__track';
      for (const it of items) track.appendChild(railCard(shelf, it));
      sec.append(head, track);
      return sec;
    }
    function railCard(shelf, it) {
      const pct = shelf.bar && it.pages ? Math.round((it.page / it.pages) * 100) : 0;
      const el = document.createElement('button');
      el.className = 'reader-rail__card';
      el.title = `${it.series || ''} #${it.issue_number ?? '?'}`;
      el.innerHTML = `
        <span class="reader-rail__cover"><img src="/api/reader/issue/${it.issue_id}/page/0?w=200" alt="" loading="lazy"></span>
        <span class="reader-rail__label"><b>${escapeHtml(it.series || '?')}</b> #${escapeHtml(String(it.issue_number ?? '?'))}</span>
        ${shelf.bar
          ? `<span class="reader-rail__bar"><span style="width:${pct}%"></span></span>`
          : `<small class="reader-rail__sub">${escapeHtml(it.title || shelf.title)}</small>`}`;
      const page = shelf.page ? shelf.page(it) : null;
      el.onclick = () => openReader(it.issue_id, page);
      return el;
    }
    async function hideShelf(shelf) {
      try { homePrefs = await api.post('/api/reader/home-prefs', { [shelf.pref]: false }); } catch { /* retry next render */ }
      renderHomeRails();
    }
    // "Reading rails…" — toggle any shelf on or off.
    async function openRailsPanel() {
      if (!overlay) build();
      overlay.querySelector('.reader__paneltitle').textContent = 'Reading rails';
      let prefs = {};
      try { prefs = await api.get('/api/reader/home-prefs'); } catch { /* defaults */ }
      els.panellist.innerHTML =
        '<div class="reader__rails-prefs"><p class="reader__rails-note">Shelves shown at the top of your library.</p>' +
        SHELVES.map((s) =>
          `<label class="reader__rails-row"><input type="checkbox" data-pref="${s.pref}"${prefs[s.pref] !== false ? ' checked' : ''}> ${escapeHtml(s.title)}</label>`).join('') +
        '</div>';
      els.panellist.querySelectorAll('input[data-pref]').forEach((cb) => {
        cb.onchange = async () => {
          try { homePrefs = await api.post('/api/reader/home-prefs', { [cb.dataset.pref]: cb.checked }); } catch { /* keep UI state */ }
          renderHomeRails();
        };
      });
      showPanelOverlay();
    }

    // ---------- registration with the app ----------
    // Host icon set as inline SVG (matches the core UI + renders the same on
    // every device). Falls back to a glyph if an older host lacks api.icon.
    const hicon = (name, opts, fb = '') => (api.icon ? (api.icon(name, opts) || fb) : fb);
    api.registerIssueAction?.({
      id: 'reader',
      icon: (i) => {
        const st = stateOf(i);
        if (st?.completed) return hicon('check', null, '✓');
        if (st && st.page > 0) return hicon('circle-half', null, '◐');
        return hicon('play', null, '▶');
      },
      title: (i) => {
        const st = stateOf(i);
        if (st?.completed) return 'Read again (finished)';
        if (st && st.page > 0) return `Resume — page ${st.page + 1} of ${st.pages}`;
        return 'Read';
      },
      when: (i) => !!i.owned && !i.corrupt && !!i.cv_issue_id,
      run: (i) => openReader(i.cv_issue_id),
    });

    // Manual read/unread toggle — backfill series you read years ago without
    // opening every issue.
    api.registerIssueAction?.({
      id: 'reader-mark',
      icon: (i) => (stateOf(i)?.completed ? hicon('square', null, '☐') : hicon('check-square', null, '☑')),
      title: (i) => (stateOf(i)?.completed ? 'Mark as unread' : 'Mark as read'),
      when: (i) => !!i.owned && !i.corrupt && !!i.cv_issue_id,
      run: async (i) => {
        const read = !stateOf(i)?.completed;
        try {
          await api.post(`/api/reader/issue/${i.cv_issue_id}/mark`, { read });
          readStates[i.cv_issue_id] = { ...(readStates[i.cv_issue_id] || { pages: 0 }), page: 0, completed: read ? 1 : 0 };
          api.refreshIssueActions?.();
          renderHomeRails(); // read/unread shifts Continue/Next up
        } catch { /* row keeps its old badge */ }
      },
    });

    // Read-later toggle on issue rows — save an owned issue for later without
    // opening it.
    api.registerIssueAction?.({
      id: 'reader-later',
      icon: (i) => (laterSet.has(i.cv_issue_id) ? hicon('bookmark', { fill: true }, '📌') : hicon('bookmark', null, '📍')),
      title: (i) => (laterSet.has(i.cv_issue_id) ? 'Remove from Read later' : 'Read later'),
      when: (i) => !!i.owned && !i.corrupt && !!i.cv_issue_id,
      run: async (i) => {
        const on = !laterSet.has(i.cv_issue_id);
        if (on) laterSet.add(i.cv_issue_id); else laterSet.delete(i.cv_issue_id);
        api.refreshIssueActions?.();
        try { await api.post(`/api/reader/issue/${i.cv_issue_id}/later`, { on }); }
        catch { /* row keeps its optimistic state */ }
      },
    });

    // Series-header banner: "▶ Continue #13 (12/24 read)" → opens the first
    // in-progress issue, else the first unread one.
    const readableRows = (issues) => (issues || []).filter((x) => x.owned && !x.corrupt && x.cv_issue_id);
    function pickNext(issues) {
      const readable = readableRows(issues);
      return readable.find((x) => { const st = readStates[x.cv_issue_id]; return st && !st.completed && st.page > 0; })
        || readable.find((x) => !readStates[x.cv_issue_id]?.completed)
        || null;
    }
    api.registerSeriesAction?.({
      id: 'reader-continue',
      when: (s, issues) => readableRows(issues).length > 0,
      label: (s, issues) => {
        const readable = readableRows(issues);
        const read = readable.filter((x) => readStates[x.cv_issue_id]?.completed).length;
        const t = pickNext(issues);
        const esc = api.escapeHtml || ((x) => x);
        return t
          ? `${hicon('play', null, '▶')} Continue #${esc(t.number ?? '?')} (${read}/${readable.length} read)`
          : `${hicon('rotate-ccw', null, '↺')} Re-read (all ${readable.length} read)`;
      },
      title: 'Pick up where you left off',
      run: (s, issues) => {
        const t = pickNext(issues) || readableRows(issues)[0];
        if (t) openReader(t.cv_issue_id);
      },
    });

    // Real covers for owned issues on the volume grid: the file's own first
    // page beats ComicVine art (and exists even when CV art doesn't).
    api.registerIssueCover?.((i) =>
      (i.owned && !i.corrupt && i.cv_issue_id) ? `/api/reader/issue/${i.cv_issue_id}/page/0?w=400` : null);

    api.addMenuAction('Continue reading', openContinuePanel, hicon('play', null, '▶'), { section: 'Reading' });
    api.addMenuAction('Read later', openLaterPanel, hicon('clock', null, '📌'), { section: 'Reading' });
    api.addMenuAction('My bookmarks', openBookmarksPanel, hicon('bookmark', null, '☆'), { section: 'Reading' });
    api.addMenuAction('Reading stats', openStatsPanel, hicon('bar-chart', null, '◔'), { section: 'Reading' });
    api.addMenuAction('Reading rails…', openRailsPanel, hicon('layout', null, '▤'), { section: 'Reading' });

    // ---------- header incognito toggle ----------
    // One tap in the app header (next to notifications/help) flips private
    // reading: no progress, history, or stats recorded while it's on.
    let incogBtn = null;
    function setIncognito(on) {
      settings.incognito = !!on;
      saveSettings();
      syncIncognitoUI();
      if (overlay) { const c = overlay.querySelector('.r-incognito'); if (c) c.checked = settings.incognito; applyLook(); }
      const msg = settings.incognito
        ? 'Incognito reading ON — progress, history, and stats are not recorded.'
        : 'Incognito reading off — recording resumed.';
      if (overlay && overlay.classList.contains('is-open') && manifest) toast(msg);
      else if (api.toast) api.toast(msg, settings.incognito ? 'info' : 'ok');
    }
    function syncIncognitoUI() {
      if (!incogBtn) return;
      incogBtn.classList.toggle('is-on', !!settings.incognito);
      incogBtn.title = settings.incognito
        ? 'Incognito reading is ON — progress, history, and stats are not being recorded. Click to turn off.'
        : 'Incognito reading — click to read without recording progress, history, or stats.';
      incogBtn.setAttribute('aria-pressed', settings.incognito ? 'true' : 'false');
    }
    const headerSlot = api.slot('header-plugin-slot');
    if (headerSlot) {
      incogBtn = document.createElement('button');
      incogBtn.id = 'incognito-btn';
      incogBtn.className = 'topbar__help reader-incog';
      incogBtn.setAttribute('aria-label', 'Toggle incognito reading');
      incogBtn.innerHTML = (api.icon && api.icon('eye-off', { size: 15 })) || '🕶';
      incogBtn.onclick = () => setIncognito(!settings.incognito);
      headerSlot.appendChild(incogBtn); // append — the slot is shared between plugins
      syncIncognitoUI();
    }
    loadReadStates();
    flushProgressQueue();
    renderHomeRails();
  });
})();
