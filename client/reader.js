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
    panels: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>',
    'edit-panels': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 15l6-6M13 8l2.5 2.5" stroke-linecap="round"/>',
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
    keepAwake: false,      // hold a screen wake lock while reading (secure contexts)
    readThreshold: 100,    // % of pages read that counts an issue as finished
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
    // Guided (panel-by-panel) view: server-detected rects per page, framed one
    // at a time by driving the same zoom/pan transform the reader already has.
    let guided = false, guidedIdx = 0, guidedArrive = 0, panelMap = null, panelsFetching = false;
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
      panelMap = null; guidedIdx = 0; guidedArrive = 0; panelsFetching = false;
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
      acquireWake();
    }

    // ---- Screen wake lock ----
    // Keep the device screen on while reading, if enabled and the browser
    // supports it (secure contexts only). The lock auto-releases when the tab is
    // hidden, so it's re-acquired on visibilitychange.
    let wakeSentinel = null;
    async function acquireWake() {
      if (!settings.keepAwake || wakeSentinel || !('wakeLock' in navigator)) return;
      try {
        wakeSentinel = await navigator.wakeLock.request('screen');
        wakeSentinel.addEventListener?.('release', () => { wakeSentinel = null; });
      } catch { wakeSentinel = null; /* denied / not visible */ }
    }
    function releaseWake() {
      try { if (wakeSentinel) wakeSentinel.release(); } catch { /* already gone */ }
      wakeSentinel = null;
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && overlay && overlay.classList.contains('is-open') && !overlay.classList.contains('is-panelonly')) acquireWake();
    });

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
      releaseWake();
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
          <button class="reader__btn r-guided"   title="Guided panel view (g)" aria-label="Guided panel view">${icon('panels')}</button>
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
      const toolBtns = ['.r-mode', '.r-rtl', '.r-fit', '.r-guided', '.r-zoom-out', '.r-zoom-in', '.r-rotate', '.r-info', '.r-offline']
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
      els.rtl.onclick = () => { settings.rtl = !settings.rtl; saveSeriesPrefs(); refreshButtons(); panelMap = null; if (guided) fetchPanels(true); render(); };
      overlay.querySelector('.r-guided').onclick = toggleGuided;
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
      if (guided) applyGuided();
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
        // Native lazy-loading is unreliable for images in an inner scroll
        // container and for the initially-visible ones (they'd stay blank until
        // a scroll). Eager-load the pages around where we open; lazy the rest.
        img.loading = Math.abs(n - page) <= 3 ? 'eager' : 'lazy';
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

    // ---------- guided (panel-by-panel) view ----------
    const panelsFor = (n) => (panelMap && panelMap.get(n)) || [];

    function toggleGuided() {
      guided = !guided;
      els.stagewrap.classList.toggle('is-guided', guided);
      overlay.querySelector('.r-guided')?.classList.toggle('is-on', guided);
      if (guided) {
        if (settings.mode !== 'single') setMode('single');
        rotate = 0;
        if (!panelMap) fetchPanels();
        else { guidedIdx = 0; applyGuided(); }
        toast('Guided view — panels one at a time (g to exit)');
      } else {
        els.stage.querySelector('.reader__spot')?.remove();
        els.stage.querySelector('.reader__spotpoly')?.remove();
        zoom = 1; panX = panY = 0;
        els.stage.style.transform = stageTransform();
        els.stagewrap.classList.remove('is-zoomed');
        toast('Guided view off');
      }
    }

    // Panels come from the server's one-time detection; while it runs we poll
    // quietly and read full pages. Pages with no confident layout stay full
    // pages inside guided mode — advancing just turns the page.
    async function fetchPanels(silent) {
      if (!manifest || panelsFetching) return;
      panelsFetching = true;
      try {
        const r = await fetch(`/api/reader/issue/${manifest.issue.id}/panels${settings.rtl ? '?rtl=1' : ''}`);
        const j = r.ok ? await r.json() : null;
        if (j && j.ready) {
          panelMap = new Map(j.pages.map((p) => [p.page, p.panels || []]));
          panelsFetching = false;
          if (guided) {
            guidedIdx = Math.min(guidedIdx, Math.max(0, panelsFor(page).length - 1));
            applyGuided();
            if (!silent && !panelsFor(page).length) toast('No panels detected here — full page');
          }
          return;
        }
        if (j && j.pending) {
          // Progress arrives once the issue's detection job is running
          // (jobs queue one at a time). Keep the toast alive with the page
          // count while in guided view — it's the only wait state there is.
          if (guided && j.total) toast(`Detecting panels… ${j.done ?? 0}/${j.total} pages`);
          else if (!silent) toast('Detecting panels…');
          setTimeout(() => { panelsFetching = false; if (guided) fetchPanels(true); }, j.total ? 1200 : 2500);
          return;
        }
      } catch { /* offline / older server — guided stays full-page */ }
      panelsFetching = false;
    }

    // Advance within the page's panels; false = let normal page nav handle it
    // (stamping the direction so goTo enters the next page at the right end).
    function guidedAdvance(dir) {
      if (!guided || settings.mode !== 'single' || splitActive()) return false;
      const rects = panelsFor(page);
      const ni = guidedIdx + dir;
      if (!rects.length || ni < 0 || ni >= rects.length) { guidedArrive = dir; return false; }
      guidedIdx = ni;
      applyGuided();
      return true;
    }

    // Frame the current panel by driving zoom/panX/panY. Measured with the
    // transform removed and restored in the same task, so nothing paints in
    // between; the CSS transition (is-guided) animates old → new frame.
    function applyGuided() {
      if (!guided || settings.mode !== 'single') return;
      if (!panelMap && !panelsFetching) fetchPanels(true);
      const rects = panelsFor(page);
      const img = els.stage.querySelector('.reader__page');
      if (!img) return;
      if (!rects.length) {
        els.stage.querySelector('.reader__spot')?.remove();
        els.stage.querySelector('.reader__spotpoly')?.remove();
        zoom = 1; panX = panY = 0;
        els.stage.style.transform = stageTransform();
        els.stagewrap.classList.remove('is-zoomed');
        syncHud();
        return;
      }
      if (!img.complete || !img.naturalWidth) { img.addEventListener('load', () => applyGuided(), { once: true }); return; }
      const r = rects[Math.max(0, Math.min(guidedIdx, rects.length - 1))];
      const prevTransform = els.stage.style.transform;
      els.stage.style.transition = 'none';
      els.stage.style.transform = 'none';
      const wrap = els.stagewrap.getBoundingClientRect();
      const ib = img.getBoundingClientRect();
      const sb = els.stage.getBoundingClientRect();
      els.stage.style.transform = prevTransform;
      void els.stage.offsetWidth; // flush: the transition animates FROM the old frame
      els.stage.style.transition = '';
      const pw = Math.max(1, r.w * ib.width), ph = Math.max(1, r.h * ib.height);
      const pcx = ib.left + (r.x + r.w / 2) * ib.width;
      const pcy = ib.top + (r.y + r.h / 2) * ib.height;
      const cx = sb.left + sb.width / 2, cy = sb.top + sb.height / 2; // transform origin
      const s = Math.max(1, Math.min(6, Math.min(wrap.width / pw, wrap.height / ph) * 0.96));
      zoom = s;
      panX = (wrap.left + wrap.width / 2) - cx - (pcx - cx) * s;
      panY = (wrap.top + wrap.height / 2) - cy - (pcy - cy) * s;
      els.stage.style.transform = stageTransform();
      els.stagewrap.classList.toggle('is-zoomed', s > 1.01);
      // Spotlight: dim everything but the framed panel. Overlays live inside
      // the stage in LAYOUT coordinates (ib/sb were measured with the
      // transform stripped), so the stage transform carries them along.
      if (r.poly && r.poly.length >= 3) applyPolySpot(r, ib, sb);
      else applyRectSpot(r, ib, sb);
      syncHud();
    }

    // Rectangular panels: a transparent window whose giant box-shadow dims
    // the rest of the page and the letterboxing.
    function applyRectSpot(r, ib, sb) {
      els.stage.querySelector('.reader__spotpoly')?.remove();
      let spot = els.stage.querySelector('.reader__spot');
      if (!spot) {
        spot = document.createElement('div');
        spot.className = 'reader__spot';
        els.stage.appendChild(spot);
        void spot.offsetWidth; // paint once at the new position before transitioning
      }
      spot.style.left = `${ib.left - sb.left + r.x * ib.width}px`;
      spot.style.top = `${ib.top - sb.top + r.y * ib.height}px`;
      spot.style.width = `${r.w * ib.width}px`;
      spot.style.height = `${r.h * ib.height}px`;
    }

    // Non-rectangular panels (diagonal gutters): an SVG overlay whose
    // even-odd path is "whole stage minus the panel polygon" — the dim
    // follows the actual slanted borders instead of a bounding box.
    function applyPolySpot(r, ib, sb) {
      els.stage.querySelector('.reader__spot')?.remove();
      let svg = els.stage.querySelector('.reader__spotpoly');
      const W = Math.max(1, Math.round(sb.width));
      const H = Math.max(1, Math.round(sb.height));
      if (!svg) {
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'reader__spotpoly');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('fill-rule', 'evenodd');
        svg.appendChild(path);
        els.stage.appendChild(svg);
      }
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.style.width = `${W}px`;
      svg.style.height = `${H}px`;
      const pts = r.poly.map(([px, py]) =>
        `${(ib.left - sb.left + px * ib.width).toFixed(1)} ${(ib.top - sb.top + py * ib.height).toFixed(1)}`);
      // Pad the outer rect generously: at high zoom the stage box is larger
      // than the visible wrap, and the dim must reach every edge.
      svg.querySelector('path').setAttribute('d',
        `M ${-W} ${-H} H ${W * 2} V ${H * 2} H ${-W} Z M ${pts.join(' L ')} Z`);
    }

    // ---------- navigation ----------
    function stepSize() { return settings.mode === 'double' ? spreadFor(page).length : 1; }
    function next() {
      if (guidedAdvance(1)) return;
      if (splitActive() && half === 0) { half = 1; render(); return; }
      const target = page + stepSize();
      if (target >= manifest.pages) return maybeFinish(true);
      half = 0;
      goTo(target);
    }
    function prev() {
      if (guidedAdvance(-1)) return;
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
      // Arriving on a page in guided view: enter at the first panel going
      // forward, the LAST panel coming backward (finish the page in order).
      guidedIdx = guidedArrive === -1 ? Math.max(0, panelsFor(page).length - 1) : 0;
      guidedArrive = 0;
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
        case 'm': settings.rtl = !settings.rtl; saveSeriesPrefs(); refreshButtons(); panelMap = null; if (guided) fetchPanels(true); render(); break;
        case 'g': toggleGuided(); break;
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
      // An issue counts as finished once you've read the configured % of it
      // (default 100 = the last page). page is 0-based, so page+1 = pages read.
      const threshold = Math.min(100, Math.max(1, settings.readThreshold || 100)) / 100;
      const done = manifest.pages > 0 && (page + 1) / manifest.pages >= threshold;
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
      syncProfileOptions(); // keep the Profile-page toggles in step with the shelves
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
    // Reading-shelf toggles live in the core Profile page (#profile-plugin-slot).
    // Built once, then kept in sync with home-prefs on every render — so hiding a
    // shelf with its × updates these checkboxes too.
    function syncProfileOptions() {
      const slot = api.slot('profile-plugin-slot');
      if (!slot) return;
      let card = slot.querySelector('#reader-rails-prefs');
      if (!card) {
        card = document.createElement('section');
        card.className = 'settings-section';
        card.id = 'reader-rails-prefs';
        card.innerHTML = '<p class="modal__subhead">Reading shelves</p>' +
          '<p class="modal__note">Which shelves appear at the top of your library.</p>' +
          '<div class="reader__rails-prefs">' +
          SHELVES.map((s) => `<label class="reader__rails-row"><input type="checkbox" data-pref="${s.pref}"> ${escapeHtml(s.title)}</label>`).join('') +
          '</div>';
        slot.appendChild(card);
        card.querySelectorAll('input[data-pref]').forEach((cb) => {
          cb.onchange = async () => {
            try { homePrefs = await api.post('/api/reader/home-prefs', { [cb.dataset.pref]: cb.checked }); } catch { /* keep UI */ }
            renderHomeRails();
          };
        });
      }
      for (const cb of card.querySelectorAll('input[data-pref]')) {
        cb.checked = homePrefs ? homePrefs[cb.dataset.pref] !== false : true;
      }
      buildDefaultsCard(slot);
    }
    // Device reading defaults (layout, RTL, incognito) — applied when a comic
    // has no saved per-series layout. Built once into the Profile slot; writes
    // to the same localStorage settings the reader itself uses.
    function buildDefaultsCard(slot) {
      if (slot.querySelector('#reader-defaults-prefs')) return;
      const card = document.createElement('section');
      card.className = 'settings-section';
      card.id = 'reader-defaults-prefs';
      card.innerHTML =
        '<p class="modal__subhead">Reading defaults</p>' +
        '<p class="modal__note">Used when you open a comic that has no saved layout of its own.</p>' +
        '<label class="field"><span>Default layout</span><select id="reader-def-mode">' +
          '<option value="single">Single page</option>' +
          '<option value="double">Double page</option>' +
          '<option value="webtoon">Webtoon (long strip)</option>' +
        '</select></label>' +
        '<label class="field"><span>Page fit</span><select id="reader-def-fit">' +
          '<option value="height">Fit height</option>' +
          '<option value="width">Fit width</option>' +
          '<option value="orig">Original size</option>' +
        '</select></label>' +
        '<label class="field"><span>Eye comfort</span><select id="reader-def-filter">' +
          '<option value="none">None</option>' +
          '<option value="invert">Invert (dark)</option>' +
          '<option value="grayscale">Grayscale</option>' +
          '<option value="sepia">Sepia</option>' +
        '</select></label>' +
        '<label class="field"><span>Count as read at</span><select id="reader-def-threshold">' +
          '<option value="100">Last page</option>' +
          '<option value="95">95%</option>' +
          '<option value="90">90%</option>' +
          '<option value="85">85%</option>' +
          '<option value="80">80%</option>' +
        '</select></label>' +
        '<label class="reader__rails-row"><input type="checkbox" id="reader-def-rtl"> Right-to-left (manga)</label>' +
        '<label class="reader__rails-row"><input type="checkbox" id="reader-def-datasaver"> Data saver (load lighter pages)</label>' +
        '<label class="reader__rails-row"><input type="checkbox" id="reader-def-trim"> Trim page margins</label>' +
        (('wakeLock' in navigator) ? '<label class="reader__rails-row"><input type="checkbox" id="reader-def-awake"> Keep the screen awake while reading</label>' : '') +
        '<label class="reader__rails-row"><input type="checkbox" id="reader-def-incognito"> Always read incognito (don’t record progress, history, or stats)</label>';
      slot.appendChild(card);
      const $ = (sel) => card.querySelector(sel);
      const mode = $('#reader-def-mode'), fit = $('#reader-def-fit'), filter = $('#reader-def-filter');
      const rtl = $('#reader-def-rtl'), datasaver = $('#reader-def-datasaver'), trim = $('#reader-def-trim'), incog = $('#reader-def-incognito');
      mode.value = settings.mode; fit.value = settings.fit; filter.value = settings.colorFilter;
      rtl.checked = !!settings.rtl; datasaver.checked = !!settings.dataSaver;
      trim.checked = !!settings.trim; incog.checked = !!settings.incognito;
      mode.onchange = () => { settings.mode = mode.value; saveSettings(); };
      fit.onchange = () => { settings.fit = fit.value; saveSettings(); };
      filter.onchange = () => { settings.colorFilter = filter.value; saveSettings(); };
      rtl.onchange = () => { settings.rtl = rtl.checked; saveSettings(); };
      datasaver.onchange = () => { settings.dataSaver = datasaver.checked; saveSettings(); };
      trim.onchange = () => { settings.trim = trim.checked; saveSettings(); };
      incog.onchange = () => setIncognito(incog.checked); // keeps the header toggle in step
      const threshold = $('#reader-def-threshold');
      threshold.value = String(settings.readThreshold || 100);
      threshold.onchange = () => { settings.readThreshold = Number(threshold.value) || 100; saveSettings(); };
      const awake = $('#reader-def-awake');
      if (awake) {
        awake.checked = !!settings.keepAwake;
        awake.onchange = () => {
          settings.keepAwake = awake.checked; saveSettings();
          if (awake.checked && overlay && overlay.classList.contains('is-open')) acquireWake(); else releaseWake();
        };
      }
    }

    // ---------- panel studio ----------
    // Full-issue panel layout editor, opened from an issue's actions. Every
    // page in one place: a thumbnail rail on the left, the selected page as
    // an editable layout on the right — drag corners (slanted panels are
    // quads), drag panels, add/delete/reorder, revert a page to automatic.
    // Edits stage locally and "Save all" commits them per page; layouts are
    // per-FILE overrides that beat any detector and survive model upgrades.
    // Visibility follows the live session permission (api.can re-evaluates on
    // every render — works in open mode, after late logins, and for '*'
    // grants). The server routes stay the authoritative check.
    const canEditPanels = () => (api.can ? api.can('reader.panels.edit') : false);

    const psR4 = (n) => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;
    const psToQuad = (p) => (p.poly && p.poly.length >= 3)
      ? p.poly.map((pt) => [pt[0], pt[1]])
      : [[p.x, p.y], [p.x + p.w, p.y], [p.x + p.w, p.y + p.h], [p.x, p.y + p.h]];
    function psToPanel(q) {
      const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
      const x = Math.min(...xs), y = Math.min(...ys);
      const out = { x: psR4(x), y: psR4(y), w: psR4(Math.max(...xs) - x), h: psR4(Math.max(...ys) - y) };
      const isRect = q.length === 4
        && Math.abs(q[0][1] - q[1][1]) < 0.004 && Math.abs(q[2][1] - q[3][1]) < 0.004
        && Math.abs(q[0][0] - q[3][0]) < 0.004 && Math.abs(q[1][0] - q[2][0]) < 0.004;
      if (!isRect) out.poly = q.map((p) => [psR4(p[0]), psR4(p[1])]);
      return out;
    }

    async function openPanelStudio(issue, targetPage) {
      const id = issue.cv_issue_id;
      const label = `${issue.series_title || issue.series || ''} #${issue.issue_number || ''}`.trim() || `Issue ${id}`;
      const root = document.createElement('div');
      root.className = 'pstudio';
      root.innerHTML = `
        <div class="pstudio__head">
          <strong>Panel layout — ${label.replace(/[<>&]/g, '')}</strong>
          <span class="pstudio__status"></span>
          <span style="flex:1"></span>
          <button class="pstudio__btn ps-db" title="Browse every panel layout stored in this server's database">Database</button>
          <button class="pstudio__btn ps-redetect" title="Discard cached detection and run the current model again">Re-detect</button>
          <button class="pstudio__btn ps-saveall" disabled>Save all</button>
          <button class="pstudio__btn ps-close">Close</button>
        </div>
        <div class="pstudio__body">
          <div class="pstudio__side">
            <div class="pstudio__chips">
              <button data-f="all" class="is-on">All</button>
              <button data-f="none">No layout</button>
              <button data-f="edited">Edited</button>
              <button data-f="unreviewed">Unreviewed</button>
            </div>
            <div class="pstudio__rail"></div>
          </div>
          <div class="pstudio__main">
            <div class="pstudio__canvas"><div class="pstudio__zoombox"><img class="pstudio__img" draggable="false"><div class="pstudio__edit"></div></div></div>
            <div class="pstudio__tools">
              <button class="pstudio__btn" data-act="add" title="Add a panel (or drag on empty page area to draw one)">Add</button>
              <button class="pstudio__btn" data-act="del" title="Delete selected (Del)">Delete</button>
              <button class="pstudio__btn" data-act="earlier" title="Read earlier">&#9664;</button>
              <button class="pstudio__btn" data-act="later" title="Read later">&#9654;</button>
              <button class="pstudio__btn" data-act="order" title="Tap panels in reading order">Set order</button>
              <button class="pstudio__btn" data-act="snap" title="Snap edges to the drawn borders">Snap</button>
              <button class="pstudio__btn" data-act="magnet" title="Auto-snap newly drawn panels to borders">Auto-snap</button>
              <button class="pstudio__btn" data-act="copy" title="Copy this page's layout">Copy</button>
              <button class="pstudio__btn" data-act="paste" title="Paste the copied layout onto this page">Paste</button>
              <button class="pstudio__btn" data-act="undo" title="Undo (Ctrl+Z)">Undo</button>
              <button class="pstudio__btn" data-act="redo" title="Redo (Ctrl+Shift+Z)">Redo</button>
              <button class="pstudio__btn" data-act="preview" title="Play the guided tour of this layout">Preview</button>
              <button class="pstudio__btn" data-act="review" title="Step through pages — Space confirms each layout">Review</button>
              <button class="pstudio__btn" data-act="pagemode" title="No panels — read as a full page">Whole page</button>
              <button class="pstudio__btn" data-act="auto" title="Discard edits, back to automatic detection">Auto</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(root);
      document.body.style.overflow = 'hidden';

      const $s = (sel) => root.querySelector(sel);
      const status = $s('.pstudio__status');
      const rail = $s('.pstudio__rail');
      const chips = $s('.pstudio__chips');
      const canvasEl = $s('.pstudio__canvas');
      const imgEl = $s('.pstudio__img');
      const editEl = $s('.pstudio__edit');
      const saveBtn = $s('.ps-saveall');
      const toolsEl = $s('.pstudio__tools');
      const toolBtn = (act) => toolsEl.querySelector(`[data-act="${act}"]`);

      let pages = [];               // [{page, panels, edited}]
      let cur = 0;
      const staged = new Map();     // page → [{pts, free}] uncommitted
      const reverted = new Set();   // pages queued for delete-override
      const history = new Map();    // page → {undo: [], redo: []}
      let sel = -1, drag = null, clip = null;
      let railFilter = 'all';
      let orderMode = false, orderSeq = [];
      let previewTimer = null, previewIdx = -1;
      let zoomZ = 1, baseW = 0;
      let grayCache = null;         // snap workspace for the current page
      let lastTap = { t: 0, panel: -1 };
      let polyDraft = null;         // {pts, cursor} — click-placed polygon in progress
      let autoSnap = localStorage.getItem('pstudioAutoSnap') !== '0'; // magnet for new panels
      let reviewMode = false;       // Space = confirm layout + advance
      const reviewedLocal = new Set(); // page numbers confirmed (mirrors server)

      const deep = (items) => items.map((it) => ({ pts: it.pts.map((p) => [...p]), free: it.free }));
      const dirty = () => staged.size + reverted.size > 0;
      const syncSave = () => { saveBtn.disabled = !dirty(); saveBtn.textContent = dirty() ? `Save all (${staged.size + reverted.size})` : 'Save all'; };
      const hist = () => { if (!history.has(cur)) history.set(cur, { undo: [], redo: [] }); return history.get(cur); };

      function quadsFor(n) {
        if (staged.has(n)) return staged.get(n);
        const p = pages.find((x) => x.page === n);
        return (p?.panels || []).map((pp) => ({ pts: psToQuad(pp), free: !!(pp.poly && pp.poly.length >= 3) }));
      }

      // ---- history: every committed change snapshots the page's prior state
      const captureState = () => ({ items: staged.has(cur) ? deep(staged.get(cur)) : null, rev: reverted.has(cur) });
      function applyState(s) {
        if (s.items) staged.set(cur, deep(s.items)); else staged.delete(cur);
        if (s.rev) reverted.add(cur); else reverted.delete(cur);
        sel = -1;
        syncSave(); buildRail(); renderEdit(); syncTools();
      }
      function pushHistory(pre) {
        const h = hist();
        h.undo.push(pre);
        if (h.undo.length > 50) h.undo.shift();
        h.redo.length = 0;
        syncTools();
      }
      function undo() { const h = hist(); if (!h.undo.length) return; h.redo.push(captureState()); applyState(h.undo.pop()); }
      function redo() { const h = hist(); if (!h.redo.length) return; h.undo.push(captureState()); applyState(h.redo.pop()); }

      function mutate(fn, commit = true) {
        const pre = commit ? captureState() : null;
        const items = deep(quadsFor(cur));
        fn(items);
        if (commit) pushHistory(pre);
        staged.set(cur, items);
        reverted.delete(cur);
        syncSave(); buildRail(); renderEdit(); syncTools();
      }

      async function loadPanels() {
        status.textContent = 'Loading layout…';
        for (;;) {
          const r = await fetch(`/api/reader/issue/${id}/panels`);
          if (!r.ok) { status.textContent = 'No file for this issue'; return false; }
          const j = await r.json();
          if (j.ready) { pages = j.pages; setHint(); return true; }
          status.textContent = j.total ? `Detecting panels… ${j.done ?? 0}/${j.total}` : 'Detecting panels…';
          await new Promise((ok) => setTimeout(ok, 1500));
        }
      }
      const setHint = (msg) => {
        if (reviewMode && !msg) return reviewProgress();
        status.textContent = msg || 'Drag corners to resize · double-tap unlocks corners · drag empty space to draw a panel';
      };

      // ---- rail + filter chips
      const isReviewed = (p) => reviewedLocal.has(p.page) || !!p.reviewed;
      function railPages() {
        if (railFilter === 'none') return pages.filter((p) => (staged.has(p.page) ? staged.get(p.page).length : (p.panels || []).length) === 0);
        if (railFilter === 'edited') return pages.filter((p) => p.edited || staged.has(p.page) || reverted.has(p.page));
        if (railFilter === 'unreviewed') return pages.filter((p) => !isReviewed(p));
        return pages;
      }
      function buildRail() {
        const list = railPages();
        rail.innerHTML = list.map((p) => {
          const q = staged.has(p.page) ? staged.get(p.page) : null;
          const count = q ? q.length : (p.panels || []).length;
          const mark = staged.has(p.page) || reverted.has(p.page) ? ' pstudio__thumb--dirty'
            : (p.edited ? ' pstudio__thumb--edited' : '');
          const tick = isReviewed(p) ? '<i class="pstudio__tick">&#10003;</i>' : '';
          return `<button class="pstudio__thumb${p.page === cur ? ' is-cur' : ''}${mark}" data-page="${p.page}">
            <img loading="lazy" src="/api/reader/issue/${id}/page/${p.page}?w=140" alt="">
            <span>${p.page + 1}</span><em>${count ? count + 'p' : 'page'}</em>${tick}</button>`;
        }).join('') || '<div class="pstudio__railempty">No pages match</div>';
        const counts = {
          all: pages.length,
          none: pages.filter((p) => (staged.has(p.page) ? staged.get(p.page).length : (p.panels || []).length) === 0).length,
          edited: pages.filter((p) => p.edited || staged.has(p.page) || reverted.has(p.page)).length,
          unreviewed: pages.filter((p) => !isReviewed(p)).length,
        };
        chips.querySelectorAll('button').forEach((b) => {
          b.classList.toggle('is-on', b.dataset.f === railFilter);
          b.textContent = `${{ all: 'All', none: 'No layout', edited: 'Edited', unreviewed: 'Unreviewed' }[b.dataset.f]} (${counts[b.dataset.f]})`;
        });
      }
      chips.addEventListener('click', (e) => {
        const f = e.target?.dataset?.f;
        if (f) { railFilter = f; buildRail(); }
      });
      rail.addEventListener('click', (e) => {
        const b = e.target.closest('[data-page]');
        if (b) showPage(Number(b.dataset.page));
      });

      function showPage(n) {
        stopPreview();
        exitOrderMode();
        polyDraft = null;
        cur = n; sel = -1; grayCache = null;
        zoomZ = 1;
        imgEl.style.width = ''; imgEl.style.maxWidth = ''; imgEl.style.maxHeight = '';
        imgEl.src = `/api/reader/issue/${id}/page/${n}?w=1600`;
        const fit = () => { baseW = imgEl.clientWidth; renderEdit(); };
        if (imgEl.complete && imgEl.naturalWidth) fit(); else imgEl.onload = fit;
        buildRail(); syncTools();
        rail.querySelector('.is-cur')?.scrollIntoView({ block: 'nearest' });
      }

      // ---- canvas rendering
      function renderEdit() {
        const W = imgEl.clientWidth, H = imgEl.clientHeight;
        if (!W || !H) return;
        editEl.style.left = `${imgEl.offsetLeft}px`;
        editEl.style.top = `${imgEl.offsetTop}px`;
        editEl.style.width = `${W}px`;
        editEl.style.height = `${H}px`;
        const items = quadsFor(cur);
        const parts = items.map((it, i) => {
          const q = it.pts;
          const pts = q.map(([x, y]) => `${(x * W).toFixed(1)},${(y * H).toFixed(1)}`).join(' ');
          const isSel = i === sel && !orderMode && previewIdx < 0;
          const handles = isSel ? q.map(([x, y], v) =>
            `<circle class="ed-h" data-panel="${i}" data-vtx="${v}" cx="${(x * W).toFixed(1)}" cy="${(y * H).toFixed(1)}" r="11"/>`).join('') : '';
          let num = String(i + 1);
          let cls = '';
          if (orderMode) {
            const k = orderSeq.indexOf(i);
            num = k >= 0 ? String(k + 1) : '·';
            cls = k >= 0 ? ' is-ordered' : '';
          }
          return `<g class="${isSel ? 'is-sel' : ''}${cls}"><polygon class="ed-p${it.free ? ' is-free' : ''}" data-panel="${i}" points="${pts}"/>
            <text x="${(q[0][0] * W + 10).toFixed(1)}" y="${(q[0][1] * H + 24).toFixed(1)}">${num}</text>${handles}</g>`;
        });
        // draw-to-add ghost
        if (drag?.kind === 'draw' && drag.draft) {
          const d = drag.draft;
          const x0 = Math.min(d.x0, d.x1) * W, y0 = Math.min(d.y0, d.y1) * H;
          const w = Math.abs(d.x1 - d.x0) * W, h = Math.abs(d.y1 - d.y0) * H;
          parts.push(`<rect class="ed-ghost" x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"/>`);
        }
        // click-placed polygon in progress: placed corners + rubber-band line
        if (polyDraft) {
          const placed = polyDraft.pts.map(([x, y]) => `${(x * W).toFixed(1)},${(y * H).toFixed(1)}`);
          const cursorPt = `${(polyDraft.cursor[0] * W).toFixed(1)},${(polyDraft.cursor[1] * H).toFixed(1)}`;
          parts.push(`<polyline class="ed-ghostline" points="${[...placed, cursorPt].join(' ')}"/>`);
          parts.push(...polyDraft.pts.map(([x, y], k) =>
            `<circle class="ed-draftpt${k === 0 ? ' is-first' : ''}" cx="${(x * W).toFixed(1)}" cy="${(y * H).toFixed(1)}" r="${k === 0 ? 13 : 8}"/>`));
        }
        // preview spotlight: dim everything but the toured panel
        if (previewIdx >= 0 && items[previewIdx]) {
          const q = items[previewIdx].pts;
          const hole = q.map(([x, y]) => `${(x * W).toFixed(1)} ${(y * H).toFixed(1)}`).join(' L ');
          parts.push(`<path class="ed-dim" fill-rule="evenodd" d="M ${-W} ${-H} H ${W * 2} V ${H * 2} H ${-W} Z M ${hole} Z"/>`);
        }
        editEl.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${parts.join('')}</svg>`;
      }

      function syncTools() {
        const hasSel = sel >= 0;
        toolBtn('del').disabled = !hasSel;
        toolBtn('earlier').disabled = !hasSel;
        toolBtn('later').disabled = !hasSel;
        toolBtn('paste').disabled = !clip;
        toolBtn('undo').disabled = !hist().undo.length;
        toolBtn('redo').disabled = !hist().redo.length;
        toolBtn('order').classList.toggle('is-on', orderMode);
        toolBtn('preview').classList.toggle('is-on', previewIdx >= 0);
        toolBtn('magnet').classList.toggle('is-on', autoSnap);
        toolBtn('review').classList.toggle('is-on', reviewMode);
      }

      // ---- pointer interactions: select/move/resize, unlock, draw-to-add
      editEl.addEventListener('pointerdown', (e) => {
        if (previewIdx >= 0) { stopPreview(); return; }
        const t = e.target;
        if (orderMode) {
          if (t.classList?.contains('ed-p')) orderTap(+t.dataset.panel);
          e.preventDefault();
          return;
        }
        // Polygon placement in progress: every click adds a corner; clicking
        // the first point (or reaching 8 corners) closes the shape.
        if (polyDraft) {
          const r = editEl.getBoundingClientRect();
          const x = psR4((e.clientX - r.left) / r.width), y = psR4((e.clientY - r.top) / r.height);
          const [fx, fy] = polyDraft.pts[0];
          const closeEnough = Math.hypot(x - fx, y - fy) < 0.02 && polyDraft.pts.length >= 3;
          if (closeEnough || polyDraft.pts.length >= 8) closePolyDraft();
          else { polyDraft.pts.push([x, y]); polyDraft.cursor = [x, y]; renderEdit(); }
          e.preventDefault();
          return;
        }
        if (t.classList?.contains('ed-h')) {
          drag = { kind: 'vtx', panel: +t.dataset.panel, vtx: +t.dataset.vtx, pre: captureState(), preJson: JSON.stringify(quadsFor(cur)) };
        } else if (t.classList?.contains('ed-p')) {
          const i = +t.dataset.panel;
          const now = performance.now();
          if (lastTap.panel === i && now - lastTap.t < 400) {
            // Double-tap toggles the corner lock: unlock rect → free quad,
            // relock free quad → its bounding rectangle.
            lastTap = { t: 0, panel: -1 };
            sel = i;
            let unlocked = false;
            mutate((items) => {
              const it = items[i];
              if (!it) return;
              if (it.free) {
                const xs = it.pts.map((p) => p[0]), ys = it.pts.map((p) => p[1]);
                const x0 = Math.min(...xs), x1 = Math.max(...xs);
                const y0 = Math.min(...ys), y1 = Math.max(...ys);
                it.pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
                it.free = false;
              } else {
                it.free = true;
                unlocked = true;
              }
            });
            api.toast?.(unlocked ? 'Corners unlocked — drag them independently' : 'Corners locked — panel squared back to a rectangle', 'info');
            e.preventDefault();
            return;
          }
          lastTap = { t: now, panel: i };
          sel = i;
          drag = { kind: 'move', panel: i, lastX: e.clientX, lastY: e.clientY, pre: captureState(), preJson: JSON.stringify(quadsFor(cur)) };
          renderEdit(); syncTools();
        } else {
          // empty page area → draw a new panel
          const r = editEl.getBoundingClientRect();
          const x = psR4((e.clientX - r.left) / r.width), y = psR4((e.clientY - r.top) / r.height);
          drag = { kind: 'draw', draft: { x0: x, y0: y, x1: x, y1: y }, pre: captureState() };
        }
        editEl.setPointerCapture(e.pointerId);
        e.preventDefault();
      });

      editEl.addEventListener('pointermove', (e) => {
        if (polyDraft && !drag) {
          const r = editEl.getBoundingClientRect();
          polyDraft.cursor = [psR4((e.clientX - r.left) / r.width), psR4((e.clientY - r.top) / r.height)];
          renderEdit();
          return;
        }
        if (!drag) return;
        const r = editEl.getBoundingClientRect();
        const mx = psR4((e.clientX - r.left) / r.width);
        const my = psR4((e.clientY - r.top) / r.height);
        if (drag.kind === 'draw') {
          drag.draft.x1 = mx; drag.draft.y1 = my;
          renderEdit();
          e.preventDefault();
          return;
        }
        mutate((items) => {
          const it = items[drag.panel];
          if (!it) return;
          if (drag.kind === 'vtx') {
            if (it.free) {
              it.pts[drag.vtx] = [mx, my];
            } else {
              const [ax, ay] = it.pts[(drag.vtx + 2) % 4];
              const x0 = Math.min(ax, mx), x1 = Math.max(ax, mx);
              const y0 = Math.min(ay, my), y1 = Math.max(ay, my);
              it.pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
            }
          } else {
            const dx = (e.clientX - drag.lastX) / r.width, dy = (e.clientY - drag.lastY) / r.height;
            drag.lastX = e.clientX; drag.lastY = e.clientY;
            it.pts = it.pts.map(([x, y]) => [psR4(x + dx), psR4(y + dy)]);
          }
        }, false);
        e.preventDefault();
      });

      function endDrag() {
        if (!drag) return;
        if (drag.kind === 'draw') {
          const d = drag.draft;
          const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
          drag = null;
          if (w >= 0.02 && h >= 0.02) {
            // A real drag → rectangle panel.
            const x0 = Math.min(d.x0, d.x1), y0 = Math.min(d.y0, d.y1);
            mutate((items) => {
              items.push({ pts: [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]], free: false });
              sel = items.length - 1;
            });
            if (autoSnap) snapPanel(sel, true);
          } else if (w < 0.006 && h < 0.006) {
            // A plain click → start placing a free polygon corner by corner.
            sel = -1;
            polyDraft = { pts: [[d.x0, d.y0]], cursor: [d.x0, d.y0] };
            status.textContent = 'Placing corners — click to add, click the first point to close, Esc cancels';
            renderEdit(); syncTools();
          } else renderEdit();
          return;
        }
        // commit drag to history only if the layout actually changed
        if (drag.preJson !== JSON.stringify(quadsFor(cur))) pushHistory(drag.pre);
        drag = null;
      }
      editEl.addEventListener('pointerup', endDrag);
      editEl.addEventListener('pointercancel', endDrag);

      function closePolyDraft() {
        if (!polyDraft || polyDraft.pts.length < 3) return cancelPolyDraft();
        const pts = polyDraft.pts.map(([x, y]) => [psR4(x), psR4(y)]);
        polyDraft = null;
        mutate((items) => {
          items.push({ pts, free: true });
          sel = items.length - 1;
        });
        if (autoSnap) snapPanel(sel, true);
        setHint();
        api.toast?.('Panel added', 'ok');
      }
      function cancelPolyDraft() {
        polyDraft = null;
        renderEdit(); setHint();
      }

      // ---- snap-to-borders: score candidate lines by "dark ink stroke with
      // gutter just outside" — the line-snap recipe, in canvas ImageData.
      function buildGray() {
        if (grayCache?.page === cur) return grayCache;
        const scale = Math.min(1, 1000 / Math.max(imgEl.naturalWidth, imgEl.naturalHeight));
        const gw = Math.max(8, Math.round(imgEl.naturalWidth * scale));
        const gh = Math.max(8, Math.round(imgEl.naturalHeight * scale));
        const c = document.createElement('canvas');
        c.width = gw; c.height = gh;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(imgEl, 0, 0, gw, gh);
        const d = ctx.getImageData(0, 0, gw, gh).data;
        const g = new Uint8Array(gw * gh);
        for (let i = 0; i < gw * gh; i++) g[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) | 0;
        const band = Math.max(2, Math.round(Math.min(gw, gh) * 0.02));
        const samples = [];
        for (let y = 0; y < gh; y += 2) {
          for (let x = 0; x < gw; x += 2) {
            if (x < band || x >= gw - band || y < band || y >= gh - band) samples.push(g[y * gw + x]);
          }
        }
        samples.sort((a, b) => a - b);
        grayCache = { page: cur, g, gw, gh, bg: samples[Math.floor(samples.length / 2)] ?? 255 };
        return grayCache;
      }

      function lineScore(gc, q1, q2, out) {
        const N = 36;
        let ink = 0, gut = 0, m = 0;
        const offs = Math.max(3, 0.008 * Math.max(gc.gw, gc.gh));
        for (let k = 0; k < N; k++) {
          const t = 0.08 + (0.84 * k) / (N - 1);
          const x = q1[0] + t * (q2[0] - q1[0]), y = q1[1] + t * (q2[1] - q1[1]);
          const xi = x | 0, yi = y | 0;
          if (xi < 0 || yi < 0 || xi >= gc.gw || yi >= gc.gh) continue;
          m++;
          if (gc.g[yi * gc.gw + xi] < 135) ink++;
          const ox = (x + out[0] * offs) | 0, oy = (y + out[1] * offs) | 0;
          if (ox < 0 || oy < 0 || ox >= gc.gw || oy >= gc.gh) gut++; // page edge counts as gutter
          else if (Math.abs(gc.g[oy * gc.gw + ox] - gc.bg) < 35) gut++;
        }
        if (m < N * 0.5) return null;
        return { ink: ink / m, gut: gut / m };
      }

      function snapPanel(i, silent) {
        const items = quadsFor(cur);
        const it = items[i];
        if (!it || !imgEl.naturalWidth) return;
        const gc = buildGray();
        const px = (p) => [p[0] * gc.gw, p[1] * gc.gh];
        const corr = 0.025 * Math.max(gc.gw, gc.gh);
        const step = Math.max(1, corr / 14);
        const cx = it.pts.reduce((s, p) => s + p[0], 0) / it.pts.length;
        const cy = it.pts.reduce((s, p) => s + p[1], 0) / it.pts.length;

        function snapLine(p1, p2, angles) {
          const P1 = px(p1), P2 = px(p2);
          const mid = [(P1[0] + P2[0]) / 2, (P1[1] + P2[1]) / 2];
          const dx = P2[0] - P1[0], dy = P2[1] - P1[1];
          const len = Math.hypot(dx, dy) || 1;
          let n = [-dy / len, dx / len];
          const c = px([cx, cy]);
          if (n[0] * (c[0] - mid[0]) + n[1] * (c[1] - mid[1]) > 0) n = [-n[0], -n[1]];
          let best = null, bestScore = 0;
          for (const a of angles) {
            const ca = Math.cos(a), sa = Math.sin(a);
            const rot = (P) => [mid[0] + (P[0] - mid[0]) * ca - (P[1] - mid[1]) * sa, mid[1] + (P[0] - mid[0]) * sa + (P[1] - mid[1]) * ca];
            const R1 = rot(P1), R2 = rot(P2);
            for (let off = -corr; off <= corr; off += step) {
              const q1 = [R1[0] + n[0] * off, R1[1] + n[1] * off];
              const q2 = [R2[0] + n[0] * off, R2[1] + n[1] * off];
              const s = lineScore(gc, q1, q2, n);
              if (!s || s.ink < 0.45 || s.gut < 0.5) continue;
              const score = s.ink + s.gut - (Math.abs(off) / corr) * 0.2 - Math.abs(a) * 1.5;
              if (score > bestScore) { bestScore = score; best = [q1, q2]; }
            }
          }
          return best; // gray-px line or null
        }

        const lineOf = (q1, q2) => {
          const d = [q2[0] - q1[0], q2[1] - q1[1]];
          const nl = Math.hypot(d[0], d[1]) || 1;
          const n = [-d[1] / nl, d[0] / nl];
          return { n, c: n[0] * q1[0] + n[1] * q1[1] };
        };
        const meet = (l1, l2) => {
          const det = l1.n[0] * l2.n[1] - l1.n[1] * l2.n[0];
          if (Math.abs(det) < 1e-9) return null;
          return [(l1.c * l2.n[1] - l2.c * l1.n[1]) / det, (l1.n[0] * l2.c - l2.n[0] * l1.c) / det];
        };

        const nPts = it.pts.length;
        const angles = it.free ? [-0.06, -0.03, 0, 0.03, 0.06] : [0];
        const lines = [];
        for (let e = 0; e < nPts; e++) {
          const snapped = snapLine(it.pts[e], it.pts[(e + 1) % nPts], angles);
          lines.push(snapped ? lineOf(...snapped) : lineOf(...[px(it.pts[e]), px(it.pts[(e + 1) % nPts])]));
        }
        const newPts = [];
        for (let v = 0; v < nPts; v++) {
          const p = meet(lines[(v - 1 + nPts) % nPts], lines[v]) || px(it.pts[v]);
          newPts.push([psR4(Math.min(Math.max(p[0] / gc.gw, 0), 1)), psR4(Math.min(Math.max(p[1] / gc.gh, 0), 1))]);
        }
        mutate((arr) => {
          if (!arr[i]) return;
          arr[i].pts = arr[i].free ? newPts : (() => {
            const xs = newPts.map((p) => p[0]), ys = newPts.map((p) => p[1]);
            const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
            return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
          })();
        });
        if (!silent) api.toast?.('Snapped to borders', 'ok');
      }

      // ---- tap-to-order
      function exitOrderMode() { if (orderMode) { orderMode = false; orderSeq = []; renderEdit(); syncTools(); setHint(); } }
      function orderTap(i) {
        if (orderSeq.includes(i)) return;
        orderSeq.push(i);
        const total = quadsFor(cur).length;
        renderEdit();
        if (orderSeq.length >= total) {
          const seq = [...orderSeq];
          orderMode = false; orderSeq = [];
          mutate((items) => {
            const copy = seq.map((idx) => items[idx]);
            items.splice(0, items.length, ...copy);
          });
          sel = -1;
          setHint();
          api.toast?.('Reading order updated', 'ok');
        } else status.textContent = `Tap panels in reading order — ${orderSeq.length}/${total}`;
      }

      // ---- review mode: step through pages, Space = "layout is right, next"
      function reviewProgress() {
        const done = pages.filter(isReviewed).length;
        status.textContent = `Review — ${done}/${pages.length} confirmed · Space confirms, arrows skip, Esc exits`;
      }
      function nextUnreviewed(fromPage) {
        const start = pages.findIndex((p) => p.page === fromPage);
        for (let k = 1; k <= pages.length; k++) {
          const p = pages[(start + k) % pages.length];
          if (!isReviewed(p)) return p.page;
        }
        return null;
      }
      function enterReview() {
        reviewMode = true;
        exitOrderMode(); stopPreview();
        const first = !isReviewed(pages.find((p) => p.page === cur) || {}) ? cur : nextUnreviewed(cur);
        if (first == null) { reviewMode = false; api.toast?.('Every page is already reviewed', 'ok'); return; }
        if (first !== cur) showPage(first);
        reviewMode = true; // showPage cleared transient modes, reassert
        reviewProgress(); syncTools();
      }
      function exitReview(done) {
        reviewMode = false;
        setHint(); syncTools();
        if (done) api.toast?.('Issue fully reviewed', 'ok');
      }
      async function confirmCurrent() {
        // Space on a page with pending edits means "MY layout is right" —
        // commit it first (a saved human layout auto-marks reviewed and
        // outranks model consensus; the plain review vote below would
        // endorse the OLD layout, the one being replaced).
        if (staged.has(cur)) {
          try {
            const panels = staged.get(cur).map((it) => psToPanel(it.pts));
            const r = await fetch(`/api/reader/issue/${id}/panels/page/${cur}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ panels }),
            });
            if (!r.ok) throw new Error();
            const p = pages.find((x) => x.page === cur);
            if (p) { p.panels = panels; p.edited = true; p.reviewed = true; }
            staged.delete(cur);
            reviewedLocal.add(cur);
            buildRail(); syncSave(); reviewProgress();
          } catch {
            api.toast?.('Could not save this page — not marked reviewed', 'error');
            return;
          }
          const nxt = nextUnreviewed(cur);
          if (nxt == null) exitReview(true);
          else { showPage(nxt); reviewMode = true; reviewProgress(); }
          return;
        }
        if (reverted.has(cur)) {
          // Pending revert: apply it, then the normal confirm endorses the
          // detector's layout that is now actually live.
          try {
            const r = await fetch(`/api/reader/issue/${id}/panels/page/${cur}`, { method: 'DELETE' });
            if (!r.ok) throw new Error();
            const p = pages.find((x) => x.page === cur);
            if (p) p.edited = false;
            reverted.delete(cur);
            syncSave();
          } catch {
            api.toast?.('Could not revert this page — not marked reviewed', 'error');
            return;
          }
        }
        const p = pages.find((x) => x.page === cur);
        if (p) { reviewedLocal.add(cur); p.reviewed = true; }
        buildRail();
        fetch(`/api/reader/issue/${id}/panels/reviewed/${cur}`, { method: 'PUT' }).catch(() => {});
        const nxt = nextUnreviewed(cur);
        if (nxt == null) exitReview(true);
        else { showPage(nxt); reviewMode = true; reviewProgress(); }
      }

      // ---- preview: play the guided tour of the staged layout
      function stopPreview() {
        if (previewTimer) clearInterval(previewTimer);
        previewTimer = null; previewIdx = -1;
        renderEdit(); syncTools(); setHint();
      }
      function startPreview() {
        const items = quadsFor(cur);
        if (!items.length) { api.toast?.('This page reads as a full page', 'info'); return; }
        exitOrderMode();
        previewIdx = 0;
        status.textContent = 'Previewing reading order — click to stop';
        renderEdit(); syncTools();
        previewTimer = setInterval(() => {
          previewIdx++;
          if (previewIdx >= quadsFor(cur).length) stopPreview();
          else renderEdit();
        }, 900);
      }

      // ---- toolbar
      toolsEl.addEventListener('click', (e) => {
        const act = e.target?.dataset?.act;
        if (!act) return;
        if (act !== 'preview') stopPreview();
        if (act === 'add') mutate((q) => { q.push({ pts: [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]], free: false }); sel = q.length - 1; });
        else if (act === 'del') { if (sel >= 0) mutate((q) => { q.splice(sel, 1); sel = Math.min(sel, q.length - 1); }); }
        else if (act === 'earlier' || act === 'later') {
          const d = act === 'earlier' ? -1 : 1;
          if (sel >= 0) mutate((q) => { const ni = sel + d; if (ni >= 0 && ni < q.length) { [q[sel], q[ni]] = [q[ni], q[sel]]; sel = ni; } });
        } else if (act === 'order') { if (orderMode) exitOrderMode(); else { orderMode = true; orderSeq = []; sel = -1; status.textContent = `Tap panels in reading order — 0/${quadsFor(cur).length}`; renderEdit(); syncTools(); } }
        else if (act === 'snap') { if (sel >= 0) snapPanel(sel); else { quadsFor(cur).forEach((_, i) => snapPanel(i, true)); api.toast?.('Snapped all panels', 'ok'); } }
        else if (act === 'magnet') {
          autoSnap = !autoSnap;
          localStorage.setItem('pstudioAutoSnap', autoSnap ? '1' : '0');
          syncTools();
          api.toast?.(autoSnap ? 'Auto-snap on — new panels magnetize to borders' : 'Auto-snap off — panels stay exactly where you draw them', 'info');
        }
        else if (act === 'copy') { clip = deep(quadsFor(cur)); syncTools(); api.toast?.('Layout copied', 'ok'); }
        else if (act === 'paste') { if (clip) { mutate((q) => { q.splice(0, q.length, ...deep(clip)); }); sel = -1; } }
        else if (act === 'undo') undo();
        else if (act === 'redo') redo();
        else if (act === 'preview') { if (previewIdx >= 0) stopPreview(); else startPreview(); }
        else if (act === 'review') { if (reviewMode) exitReview(false); else enterReview(); }
        else if (act === 'pagemode') { sel = -1; mutate((q) => { q.length = 0; }); }
        else if (act === 'auto') {
          pushHistory(captureState());
          staged.delete(cur);
          reverted.add(cur);
          sel = -1;
          syncSave(); buildRail(); renderEdit(); syncTools();
        }
      });

      // ---- zoom (wheel / trackpad) around the cursor
      canvasEl.addEventListener('wheel', (e) => {
        if (!imgEl.naturalWidth) return;
        e.preventDefault();
        const zOld = zoomZ;
        zoomZ = Math.min(5, Math.max(1, zoomZ * (e.deltaY < 0 ? 1.18 : 1 / 1.18)));
        if (zoomZ === zOld) return;
        if (zoomZ === 1) {
          imgEl.style.width = ''; imgEl.style.maxWidth = ''; imgEl.style.maxHeight = '';
        } else {
          imgEl.style.maxWidth = 'none'; imgEl.style.maxHeight = 'none';
          imgEl.style.width = `${Math.round(baseW * zoomZ)}px`;
        }
        const r = canvasEl.getBoundingClientRect();
        const px = e.clientX - r.left + canvasEl.scrollLeft;
        const py = e.clientY - r.top + canvasEl.scrollTop;
        renderEdit();
        const ratio = zoomZ / zOld;
        canvasEl.scrollLeft = px * ratio - (e.clientX - r.left);
        canvasEl.scrollTop = py * ratio - (e.clientY - r.top);
      }, { passive: false });

      // ---- database browser: every stored page layout on this server ----
      // Read-only view over the layout tables (GET /api/reader/panels/db):
      // filter chips with live counts, text search, and paged rows. Clicking
      // a row jumps to that page — reopening the studio on the right issue
      // when the row belongs to a different one.
      let dbEl = null;
      const DB_FILTERS = [['all', 'All'], ['ml', 'ML'], ['classical', 'Built-in'],
        ['edited', 'Edited'], ['reviewed', 'Reviewed'], ['pagemode', 'Page mode']];
      function closeDb() { if (dbEl) { dbEl.remove(); dbEl = null; } }
      function openDb() {
        if (dbEl) return;
        const state = { filter: 'all', q: '', offset: 0, limit: 50, total: 0, rows: [] };
        dbEl = document.createElement('div');
        dbEl.className = 'pstudio__dbwrap';
        dbEl.innerHTML = `
          <div class="pstudio__db">
            <div class="pstudio__dbhead">
              <strong>Layout database</strong>
              <input class="pstudio__dbsearch" type="search" placeholder="Search series / issue…" aria-label="Search stored layouts">
              <span style="flex:1"></span>
              <button class="pstudio__btn ps-dbclose">Close</button>
            </div>
            <div class="pstudio__dbchips"></div>
            <div class="pstudio__dblist"><div class="pstudio__dbempty">Loading…</div></div>
            <div class="pstudio__dbfoot">
              <button class="pstudio__btn ps-dbprev" disabled>Prev</button>
              <span class="pstudio__dbpage"></span>
              <button class="pstudio__btn ps-dbnext" disabled>Next</button>
            </div>
          </div>`;
        root.appendChild(dbEl);
        const chipsEl = dbEl.querySelector('.pstudio__dbchips');
        const listEl = dbEl.querySelector('.pstudio__dblist');
        const pageEl = dbEl.querySelector('.pstudio__dbpage');
        const prevBtn = dbEl.querySelector('.ps-dbprev');
        const nextBtn = dbEl.querySelector('.ps-dbnext');
        dbEl.querySelector('.ps-dbclose').onclick = closeDb;
        dbEl.addEventListener('pointerdown', (e) => { if (e.target === dbEl) closeDb(); }); // backdrop closes

        const badge = (cls, label) => `<i class="pstudio__dbbadge${cls ? ` pstudio__dbbadge--${cls}` : ''}">${label}</i>`;
        function renderList(j) {
          state.rows = j.rows || [];
          state.total = j.total || 0;
          chipsEl.innerHTML = DB_FILTERS.map(([k, label]) =>
            `<button data-f="${k}"${k === state.filter ? ' class="is-on"' : ''}>${label} (${j.counts?.[k] ?? 0})</button>`).join('');
          listEl.innerHTML = state.rows.map((r, i) => {
            const name = r.series
              ? `${escapeHtml(r.series)}${r.issue_number != null ? ` #${escapeHtml(String(r.issue_number))}` : ''}`
              : escapeHtml(r.file || `Issue ${r.issue_id}`);
            const sub = r.title ? ` <small>· ${escapeHtml(r.title)}</small>` : '';
            return `<button class="pstudio__dbrow" data-row="${i}">
              <span class="pstudio__dbname">${name}${sub} <small>· page ${r.page + 1}</small></span>
              ${r.engine === 'ml-box-v2' ? badge('ml', 'ML') : r.engine === 'classical' ? badge('', 'Built-in') : ''}
              ${r.edited ? badge('edited', 'Edited') : ''}
              ${r.reviewed ? badge('reviewed', 'Reviewed') : ''}
              ${badge('', r.panels ? `${r.panels} panel${r.panels === 1 ? '' : 's'}` : 'page mode')}
              <span class="pstudio__dbdate">${r.updated_at ? escapeHtml(String(r.updated_at).slice(0, 10)) : ''}</span>
            </button>`;
          }).join('') || '<div class="pstudio__dbempty">No stored layouts match</div>';
          const to = state.offset + state.rows.length;
          pageEl.textContent = `${state.total ? state.offset + 1 : 0}–${to} of ${state.total}`;
          prevBtn.disabled = state.offset <= 0;
          nextBtn.disabled = to >= state.total;
        }
        async function loadDb() {
          listEl.innerHTML = '<div class="pstudio__dbempty">Loading…</div>';
          const p = new URLSearchParams({ filter: state.filter, offset: String(state.offset), limit: String(state.limit) });
          if (state.q) p.set('q', state.q);
          try {
            const r = await fetch(`/api/reader/panels/db?${p}`);
            if (!r.ok) throw new Error();
            const j = await r.json();
            if (dbEl) renderList(j);
          } catch { if (dbEl) listEl.innerHTML = '<div class="pstudio__dbempty">Could not load the layout database</div>'; }
        }
        chipsEl.addEventListener('click', (e) => {
          const f = e.target?.dataset?.f;
          if (f && f !== state.filter) { state.filter = f; state.offset = 0; loadDb(); }
        });
        prevBtn.onclick = () => { state.offset = Math.max(0, state.offset - state.limit); loadDb(); };
        nextBtn.onclick = () => { state.offset += state.limit; loadDb(); };
        let qTimer = null;
        dbEl.querySelector('.pstudio__dbsearch').addEventListener('input', (e) => {
          clearTimeout(qTimer);
          qTimer = setTimeout(() => { state.q = e.target.value.trim(); state.offset = 0; loadDb(); }, 250);
        });
        listEl.addEventListener('click', (e) => {
          const b = e.target.closest('[data-row]');
          const r = b && state.rows[Number(b.dataset.row)];
          if (!r) return;
          if (r.issue_id === id) { closeDb(); showPage(r.page); return; }
          // Another issue: reopen the studio there (close() prompts about
          // unsaved edits and aborts the jump if the user keeps editing).
          closeDb();
          if (!close()) return;
          openPanelStudio({ cv_issue_id: r.issue_id, series_title: r.series || r.file, issue_number: r.issue_number }, r.page);
        });
        loadDb();
      }
      $s('.ps-db').onclick = openDb;

      // ---- save / close / keys
      saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        status.textContent = 'Saving…';
        let failed = 0;
        for (const [n, items] of staged) {
          try {
            const panels = items.map((it) => psToPanel(it.pts));
            const r = await fetch(`/api/reader/issue/${id}/panels/page/${n}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ panels }),
            });
            if (!r.ok) throw new Error();
            const p = pages.find((x) => x.page === n);
            if (p) { p.panels = panels; p.edited = true; p.reviewed = true; reviewedLocal.add(n); }
          } catch { failed++; }
        }
        for (const n of reverted) {
          try {
            await fetch(`/api/reader/issue/${id}/panels/page/${n}`, { method: 'DELETE' });
            const p = pages.find((x) => x.page === n);
            if (p) p.edited = false;
          } catch { failed++; }
        }
        if (!failed) { staged.clear(); reverted.clear(); }
        status.textContent = failed ? `${failed} page(s) failed to save` : 'Saved';
        try {
          const r = await fetch(`/api/reader/issue/${id}/panels`);
          const j = await r.json();
          if (j.ready) pages = j.pages;
        } catch { /* rail badges catch up next open */ }
        syncSave(); buildRail(); renderEdit(); syncTools();
        api.toast?.(failed ? 'Some panel edits failed to save' : 'Panel layouts saved', failed ? 'error' : 'ok');
      };

      function close() {
        if (dirty() && !window.confirm('Discard unsaved panel edits?')) return false;
        stopPreview();
        closeDb();
        document.removeEventListener('keydown', onStudioKey, true);
        document.body.style.overflow = '';
        root.remove();
        return true;
      }
      $s('.ps-close').onclick = close;

      $s('.ps-redetect').onclick = async () => {
        const wipe = dirty() || pages.some((p) => p.edited);
        const clearEdits = wipe && window.confirm('Also discard your saved panel edits and reviews for this issue?\n\nOK = wipe everything and re-detect from scratch.\nCancel = re-detect but keep your edits (edits still override the model).');
        if (!window.confirm('Re-detect all pages with the current model? Cached detection will be recomputed on the next load.')) return;
        staged.clear(); reverted.clear();
        status.textContent = 'Re-detecting…';
        try {
          await fetch(`/api/reader/issue/${id}/panels/redetect${clearEdits ? '?edits=clear' : ''}`, { method: 'POST' });
          if (clearEdits) { reviewedLocal.clear(); pages.forEach((p) => { p.edited = false; p.reviewed = false; }); }
          if (await loadPanels()) { buildRail(); showPage(pages[0]?.page ?? 0); }
          api.toast?.('Re-detected with the current model', 'ok');
        } catch { status.textContent = 'Re-detect failed'; }
      };

      function onStudioKey(e) {
        if (dbEl) {
          // Database browser open: Esc closes it; everything else (typing in
          // the search box, arrows) belongs to the browser, not the editor.
          if (e.key === 'Escape') { closeDb(); e.preventDefault(); e.stopPropagation(); }
          return;
        }
        const mod = e.ctrlKey || e.metaKey;
        if (e.key === 'Escape') {
          if (polyDraft) cancelPolyDraft();
          else if (previewIdx >= 0) stopPreview();
          else if (orderMode) exitOrderMode();
          else if (reviewMode) exitReview(false);
          else close();
          e.preventDefault(); e.stopPropagation(); return;
        }
        if (e.key === ' ' && reviewMode && !polyDraft) {
          confirmCurrent();
          e.preventDefault(); e.stopPropagation(); return;
        }
        if (e.key === 'Enter' && polyDraft) {
          closePolyDraft();
          e.preventDefault(); e.stopPropagation(); return;
        }
        if (mod && e.key.toLowerCase() === 'z') { e.shiftKey ? redo() : undo(); e.preventDefault(); e.stopPropagation(); return; }
        if (mod && e.key.toLowerCase() === 'y') { redo(); e.preventDefault(); e.stopPropagation(); return; }
        if ((e.key === 'Delete' || e.key === 'Backspace') && sel >= 0) {
          mutate((q) => { q.splice(sel, 1); sel = Math.min(sel, q.length - 1); });
          e.preventDefault(); e.stopPropagation(); return;
        }
        if (e.key.startsWith('Arrow')) {
          if (sel >= 0) {
            // nudge selected panel (Shift = resize width/height for rects)
            const stepN = 0.005;
            const dx = e.key === 'ArrowLeft' ? -stepN : e.key === 'ArrowRight' ? stepN : 0;
            const dy = e.key === 'ArrowUp' ? -stepN : e.key === 'ArrowDown' ? stepN : 0;
            mutate((items) => {
              const it = items[sel];
              if (!it) return;
              if (e.shiftKey && !it.free) {
                const [[x0, y0]] = it.pts;
                const x1 = Math.max(x0 + 0.02, it.pts[1][0] + dx);
                const y1 = Math.max(y0 + 0.02, it.pts[2][1] + dy);
                it.pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
              } else {
                it.pts = it.pts.map(([x, y]) => [psR4(x + dx), psR4(y + dy)]);
              }
            });
          } else {
            const i = pages.findIndex((p) => p.page === cur);
            if (e.key === 'ArrowRight' && i < pages.length - 1) showPage(pages[i + 1].page);
            if (e.key === 'ArrowLeft' && i > 0) showPage(pages[i - 1].page);
          }
          e.preventDefault(); e.stopPropagation();
        }
      }
      document.addEventListener('keydown', onStudioKey, true);
      window.addEventListener('resize', () => { if (root.isConnected && zoomZ === 1) { baseW = imgEl.clientWidth; renderEdit(); } });

      if (await loadPanels()) {
        buildRail();
        // A database-browser jump lands straight on the clicked page.
        const first = Number.isInteger(targetPage) && pages.some((p) => p.page === targetPage)
          ? targetPage : (pages[0]?.page ?? 0);
        showPage(first);
      }
    }

    // ---------- registration with the app ----------
    // Host icon set as inline SVG (matches the core UI + renders the same on
    // every device). Falls back to a glyph if an older host lacks api.icon.
    const hicon = (name, opts, fb = '') => (api.icon ? (api.icon(name, opts) || fb) : fb);

    // Panel-layout editing from the issue row — only for users the server
    // says may edit (reader.panels.edit permission).
    api.registerIssueAction?.({
      id: 'reader-panel-studio',
      icon: () => hicon('layout', null, '▦'),
      title: () => 'Edit panel layout',
      when: (i) => canEditPanels() && !!i.owned && !i.corrupt && !!i.cv_issue_id,
      run: (i) => openPanelStudio(i),
    });
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
    // Bulk read-state: acts on the CHECKED issues (core exposes the selection
    // via BackIssue.selectedIssues), or the whole series when nothing is checked.
    const bulkMark = async (issues, read) => {
      const sel = (window.BackIssue?.selectedIssues?.() || []);
      const rows = readableRows(issues);
      const ids = sel.length ? sel : rows.map((x) => x.cv_issue_id);
      if (!ids.length) return;
      const r = await fetch('/api/reader/read-bulk', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids, read }),
      }).then((x) => x.json()).catch(() => ({ error: 'unreachable' }));
      if (r.error) return;
      for (const id of ids) {
        const st = readStates[id] || { page: 0, pages: 0, completed: 0 };
        readStates[id] = read ? { ...st, completed: 1, page: st.pages || st.page } : { ...st, completed: 0, page: 0 };
      }
      api.refreshIssueActions?.();
    };
    api.registerSeriesAction?.({
      id: 'reader-mark-read',
      when: (s, issues) => readableRows(issues).length > 0,
      label: () => `${hicon('check', null, '✓')} Mark read`,
      title: 'Mark the checked issues read (nothing checked = the whole series)',
      run: (s, issues) => bulkMark(issues, true),
    });
    api.registerSeriesAction?.({
      id: 'reader-mark-unread',
      when: (s, issues) => issues.some((x) => readStates[x.cv_issue_id]?.completed || readStates[x.cv_issue_id]?.page > 0),
      label: () => `${hicon('rotate-ccw', null, '↺')} Mark unread`,
      title: 'Clear read progress for the checked issues (nothing checked = the whole series)',
      run: (s, issues) => bulkMark(issues, false),
    });
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
    // page beats ComicVine art (and exists even when CV art doesn't) — unless
    // the user prefers ComicVine art (Settings → Library), or lacks the reader
    // permission (the prefs fetch 403s → ComicVine art, whose URLs they CAN load).
    let fileCovers = true; // optimistic default matches the setting's default
    api.registerIssueCover?.((i) =>
      (fileCovers && i.owned && !i.corrupt && i.cv_issue_id) ? `/api/reader/issue/${i.cv_issue_id}/page/0?w=400` : null);
    fetch('/api/reader/prefs').then((r) => (r.ok ? r.json() : { fileCovers: false }))
      .then((p) => { if (p.fileCovers === false) { fileCovers = false; api.refreshIssueActions?.(); } })
      .catch(() => {});

    // Settings → Library: the cover preference checkbox (auto-wired via the
    // set-<key> convention; core loads and saves it with the rest).
    const libSlot = api.slot('settings-plugin-library');
    if (libSlot && !libSlot.querySelector('#set-readerFileCovers')) {
      const wrap = document.createElement('div');
      wrap.innerHTML =
        '<label class="field field--check"><input id="set-readerFileCovers" type="checkbox"><span>Use the file\'s first page as an owned issue\'s cover (off = always ComicVine art)</span></label>' +
        '<p class="modal__note">Applies to the issue grid on a series page. Your file\'s page may differ from ComicVine\'s art when it\'s a variant cover or a different printing.</p>' +
        '<label class="field field--check"><input id="set-readerPanelMl" type="checkbox"><span>Use the ML panel detector for guided view (off = built-in detection)</span></label>' +
        '<p class="modal__note">Only applies when a panel model is installed on the server. Flipping this re-detects each issue\'s panel layout once on next open.</p>' +
        '<label class="field field--check"><input id="set-readerPanelShare" type="checkbox"><span>Share panel layouts with the community cache</span></label>' +
        '<p class="modal__note">When on, panel layouts are looked up from a shared cache before detecting (instant guided view for pages others have covered), and your detections and hand-corrections are contributed back. Only panel rectangles and a page-content hash are sent, never image data or filenames.</p>';
      libSlot.appendChild(wrap);
    }

    api.addMenuAction('Continue reading', openContinuePanel, hicon('play', null, '▶'), { section: 'Reading' });
    api.addMenuAction('Read later', openLaterPanel, hicon('clock', null, '📌'), { section: 'Reading' });
    api.addMenuAction('My bookmarks', openBookmarksPanel, hicon('bookmark', null, '☆'), { section: 'Reading' });
    api.addMenuAction('Reading stats', openStatsPanel, hicon('bar-chart', null, '◔'), { section: 'Reading' });

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
      // Keep the Profile-page toggle in step with the header button (either can flip it).
      const pc = document.getElementById('reader-def-incognito');
      if (pc) pc.checked = !!settings.incognito;
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
