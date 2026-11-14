/* WheelGrade — static frontend for Cloudflare.
   API is same-origin under /app (Worker). All API calls use a base derived
   from the page's own path, so the app works served at /app/ or at root.
   Auth: session cookie set by the server after OAuth. Anonymous browsers get
   a per-browser account id stored in localStorage and sent as X-Account-Id.
   The server is the source of truth for scope/ownership — this client never
   contains an owner id and never hardcodes any positions.
   Visual design follows the original Muse app (wheel-app v13) exactly,
   per DESIGN_SPEC_ORIGINAL.md — except the strike, which is shown large
   and high-contrast in the Analyzer result (and bold wherever it appears),
   because the small dim strike was unreadable. */
(function () {
  'use strict';

  /* ---------- service worker (PWA: installable, offline shell) ----------
     Registers /app/sw.js (scope /app/) after load so it never blocks
     the first paint. API/auth calls bypass the cache by design (sw.js);
     a failed registration is swallowed — the app works fine without it. */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(function () {});
    });
  }

  /* ---------- helpers ---------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $all(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(v) {
    if (v == null || v === '' || isNaN(Number(v))) return '—';
    return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function money0(v) {
    if (v == null || isNaN(Number(v))) return '$0';
    return '$' + Math.round(Number(v)).toLocaleString('en-US');
  }
  function signedMoney(v) {
    if (v == null || isNaN(Number(v))) return '—';
    var n = Number(v);
    return (n < 0 ? '−' : '+') + money(Math.abs(n));
  }
  function signedMoney0(v) {
    if (v == null || isNaN(Number(v))) return '$0';
    var n = Number(v);
    return (n < 0 ? '−' : '+') + money0(Math.abs(n));
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function parseISODate(s) {
    if (!s || typeof s !== 'string') return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtDate(s) { // "2026-11-27" -> "Nov 27"
    var d = parseISODate(s);
    if (!d) return s ? String(s).slice(0, 10) : '—';
    return MONTHS[d.getMonth()] + ' ' + d.getDate();
  }
  function fmtMonth(s) { // "2026-11" -> "November 2026"
    if (!s || typeof s !== 'string') return '';
    var m = /^(\d{4})-(\d{2})/.exec(s);
    if (!m) return s;
    return MONTHS_LONG[Number(m[2]) - 1] + ' ' + m[1];
  }
  function fmtAsOf(s) { // tolerant: ISO/timestamp -> "Nov 13, 4:32 PM ET", else raw
    if (!s) return null;
    var d = new Date(s);
    if (!isNaN(d.getTime())) {
      try {
        return new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit'
        }).format(d);
      } catch (e) { return s; }
    }
    return String(s);
  }
  function todayISO() { return new Date().toISOString().slice(0, 10); }
  function plusDaysISO(days) {
    var d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function nextFridayISO() {
    // First Friday strictly after today (options expire on Fridays;
    // a Friday today means next Friday, 7 days out — never same-day).
    var d = new Date();
    var add = ((5 - d.getDay()) + 7) % 7 || 7;
    d.setDate(d.getDate() + add);
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }
  function show(el) { if (el) el.classList.remove('hidden'); }
  function hide(el) { if (el) el.classList.add('hidden'); }

  /* ---------- base / account ---------- */
  // Directory the page was served from, e.g. "/app/" -> api base "/app/api".
  function appDir() {
    var p = window.location.pathname || '/';
    if (!p.endsWith('/')) p = p.slice(0, p.lastIndexOf('/') + 1);
    return p;
  }
  function apiUrl(path) { return appDir() + 'api/' + path.replace(/^\//, ''); }
  function authUrl(provider) { return appDir() + 'auth/' + provider; }

  // Per-browser anonymous account id: localStorage key holds "acct-<uuid>".
  function accountId() {
    try {
      var id = window.localStorage.getItem('wg-account-id');
      if (!id) {
        var uuid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
          : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
              var r = Math.random() * 16 | 0;
              return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
            });
        id = 'acct-' + uuid;
        window.localStorage.setItem('wg-account-id', id);
      }
      return id;
    } catch (e) { return 'acct-anonymous'; }
  }

  async function api(path, opts) {
    opts = opts || {};
    var headers = { 'X-Account-Id': accountId() };
    if (opts.body) headers['Content-Type'] = 'application/json';
    var res = await fetch(apiUrl(path), {
      method: opts.method || 'GET',
      headers: headers,
      credentials: 'same-origin',
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
    if (!res.ok) {
      var msg = (data && (data.error || data.message)) || ('Request failed (' + res.status + ')');
      var err = new Error(msg);
      err.status = res.status;
      err.code = (data && data.error) || null;
      throw err;
    }
    return data;
  }

  /* ---------- state ---------- */
  var state = { board: null, elite: null, history: null, scope: null, lastAnalysis: null, view: 'main', analyzerAllowed: false };

  /* ---------- scope / Analyzer free tries ----------
     Jon's ruling, revised: the Analyzer is the money maker, so it isn't
     free — but everyone gets 3 free grades first, then the payment
     window. The form is always visible at first. Unpaid callers (anon
     or signed-in) see a small counter under the grade button; paid
     users and the owner (allowed = (signedIn && paid) || isOwner, from
     GET /app/api/scope) never see the counter or the paywall.
     GET /app/api/scope also returns freeGradesLeft: 0–3 for unpaid
     callers, null for paid/owner (unlimited). The grade response may
     carry freeGradesLeft too — either source is authoritative when
     present. Until the backend ships the field, a local count in
     localStorage (this browser's successful grades) fills the gap so
     the counter still works; the backend value always wins when it
     arrives, and a 402 from analyze is the final backstop.
     When freeGradesLeft hits 0 the form is removed from the DOM
     entirely — never rendered-then-hidden — and the PurchaseCard +
     a short note take its place. The Board stays free. */
  var FREE_GRADES_TOTAL = 3;
  var scopePromise = null;
  function fetchScope() {
    if (!scopePromise) scopePromise = api('scope').catch(function () { return null; });
    return scopePromise;
  }
  function refreshScope() {
    scopePromise = api('scope').catch(function () { return null; });
    return scopePromise;
  }
  function isAnalyzerAllowed(scope) {
    return !!scope && ((scope.signedIn && scope.paid) || scope.isOwner);
  }
  function freeGradesLeftFromScope(scope) {
    if (scope && typeof scope.freeGradesLeft === 'number') return scope.freeGradesLeft;
    return null;
  }
  function localFreeGradesUsed() {
    try { return Number(window.localStorage.getItem('wg-free-grades-used')) || 0; } catch (e) { return 0; }
  }
  function freeGradesLeftLocal() {
    return Math.max(0, FREE_GRADES_TOTAL - localFreeGradesUsed());
  }
  function syncLocalFreeGrades(left) {
    try { window.localStorage.setItem('wg-free-grades-used', String(Math.max(0, FREE_GRADES_TOTAL - left))); } catch (e) {}
  }
  function recordFreeGradeUsed() {
    try { window.localStorage.setItem('wg-free-grades-used', String(localFreeGradesUsed() + 1)); } catch (e) {}
  }
  function hideFreeGradesNote() { hide($('#free-grades-note')); }
  // Apply a free-grades count: refresh the counter, or paywall at 0.
  // Paid/owner callers never see the counter or the paywall.
  function applyFreeGradesLeft(n, opts) {
    if (state.analyzerAllowed) { hideFreeGradesNote(); return; }
    if (typeof n !== 'number') n = freeGradesLeftLocal();
    if (n <= 0) { showAnalyzerPaywall(opts && opts.keepResult); return; }
    syncLocalFreeGrades(n);
    var note = $('#free-grades-note');
    if (note) {
      note.textContent = n === 1 ? '1 free grade left' : n + ' free grades left';
      show(note);
    }
  }
  function showAnalyzerPaywall(keepResult) {
    // Remove the gated UI from the DOM entirely (not CSS-hidden).
    var formCard = $('#analyzer-form-card');
    if (formCard) formCard.remove();
    var intro = $('#analyzer-intro');
    if (intro) intro.remove();
    if (!keepResult) {
      var result = $('#analyze-result');
      if (result) result.remove();
    }
    // Short plain message in place of the form, under the PurchaseCard.
    if ($('#analyzer-paywall-note')) return;
    var buyCard = $('#buy-card');
    if (!buyCard) return;
    var note = document.createElement('p');
    note.id = 'analyzer-paywall-note';
    note.className = 'paywall-note';
    note.textContent = (state.scope && state.scope.signedIn)
      ? 'You\u2019ve used your 3 free grades. Grading more trades requires the $9.99 one-time purchase. Buy WheelGrade below to keep grading.'
      : 'You\u2019ve used your 3 free grades. Grading more trades requires the $9.99 one-time purchase. Buy WheelGrade below, then sign in to keep grading.';
    buyCard.insertAdjacentElement('afterend', note);
  }
  // Header login-status indicator (top-right): Paid / Free / Sign in.
  // Driven by the same scope the paywall uses, so it updates
  // whenever scope refreshes — including right after a post-payment
  // claim logs the buyer in as paid, with no reload.
  function renderLoginStatus(scope) {
    var el = $('#login-status');
    if (!el) return;
    if (scope && scope.signedIn && (scope.paid || scope.isOwner)) {
      el.innerHTML = '<span class="ls-pill ls-paid"><span class="ls-check" aria-hidden="true">✓</span>Paid</span>';
      return;
    }
    if (scope && scope.signedIn) {
      el.innerHTML = '<span class="ls-pill ls-free"><span class="ls-user" aria-hidden="true"><svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-4 0-7 2-7 4.5V20h14v-1.5C19 16 16 14 12 14Z"/></svg></span>Free</span>';
      return;
    }
    el.innerHTML = '<button class="btn btn-outline btn-sm" id="login-status-signin" type="button">Sign in</button>';
    var btn = $('#login-status-signin');
    if (btn) btn.addEventListener('click', function () {
      showView('main');
      showTab('analyzer');
      var card = $('#buy-card');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }
  function applyAnalyzerGate(scope) {
    state.scope = scope;
    state.analyzerAllowed = isAnalyzerAllowed(scope);
    noteBuildId(scope);
    renderLoginStatus(scope);
    // Paid/owner callers never see a buy card — the app is theirs.
    if (state.analyzerAllowed) {
      hideFreeGradesNote();
      $all('.buy-card').forEach(hide);
      return;
    }
    applyFreeGradesLeft(freeGradesLeftFromScope(scope), { keepResult: false });
  }
  // New-version notice: the Worker stamps every deploy with a BUILD_ID
  // (served in /app/api/scope). Remember the build this tab loaded with;
  // when a later scope fetch reports a different one, a newer version is
  // live — show the reload banner instead of silently running stale code.
  var loadedBuildId = null;
  function noteBuildId(scope) {
    if (!scope || !scope.buildId) return;
    if (loadedBuildId == null) { loadedBuildId = scope.buildId; return; }
    if (scope.buildId !== loadedBuildId) show($('#update-banner'));
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    refreshScope().then(function (s) { if (s) noteBuildId(s); });
  });
  var updateReloadBtn = $('#update-reload-btn');
  if (updateReloadBtn) updateReloadBtn.addEventListener('click', function () { window.location.reload(); });
  /* ---------- theme toggle (light default, dark on demand) ----------
     A proper two-way switch: flips light <-> dark as often as tapped,
     and the choice is saved in localStorage ('wheelgrade-theme') on
     EVERY tap, so the last choice is what loads next time (same key
     on the landing page and the app — one origin, one preference).
     The button always shows the CURRENT theme (sun in light, moon in
     dark) and the label names the mode tapping switches to. The stored
     theme is applied before first paint by the inline <head> script. */
  var THEME_KEY = 'wheelgrade-theme';
  function themeIsDark() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }
  function renderThemeToggle() {
    var btn = $('#theme-toggle');
    if (!btn) return;
    var dark = themeIsDark();
    var icon = $('.theme-icon', btn);
    var label = $('.theme-label', btn);
    if (icon) icon.textContent = dark ? '☾' : '☀';
    if (label) label.textContent = dark ? 'Light' : 'Dark';
    btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  }
  function setTheme(dark) {
    if (dark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (e) { /* private mode */ }
    renderThemeToggle();
  }
  (function initThemeToggle() {
    var btn = $('#theme-toggle');
    if (!btn) return;
    btn.addEventListener('click', function () { setTheme(!themeIsDark()); });
    renderThemeToggle();
  })();
  // Fetch scope on load to show the counter (or the paywall at 0 left).
  // The form itself is always usable until then — the backend enforces.
  fetchScope().then(applyAnalyzerGate);

  /* ---------- tab deep-linking (URL hash) ----------
     #analyzer / #board / #portfolio open a main tab; #elite opens the
     Elite 32 view. #analyzer is the default for no hash or unknown hash.
     Tab clicks push a history entry (back button steps through tabs);
     hashchange (back/forward) re-routes without touching history.
     pushState/replaceState never scroll — no jump to an anchor. */
  var VALID_TABS = ['analyzer', 'board', 'portfolio'];
  var currentTab = 'analyzer';
  function setHash(hash, push) {
    var url = '#' + hash;
    if (window.location.hash === url) return;
    try {
      if (push) { window.history.pushState(null, '', url); }
      else { window.history.replaceState(null, '', url); }
    } catch (e) { /* restricted contexts: the URL just stays as-is */ }
  }
  function routeFromHash() {
    var h = (window.location.hash || '').replace(/^#/, '').toLowerCase();
    if (h === 'elite') { showView('elite'); return; }
    if (VALID_TABS.indexOf(h) !== -1) { showView('main'); showTab(h); return; }
    showView('main');
    showTab('analyzer');
  }
  window.addEventListener('hashchange', routeFromHash);

  /* ---------- views (main / ticker lifetime / Elite 32) ---------- */
  function showView(name) {
    state.view = name;
    $('#view-main').classList.toggle('hidden', name !== 'main');
    $('#view-ticker').classList.toggle('hidden', name !== 'ticker');
    $('#view-elite').classList.toggle('hidden', name !== 'elite');
    window.scrollTo({ top: 0 });
  }
  $('#ticker-back').addEventListener('click', function () { showView('main'); });
  $('#elite-back').addEventListener('click', function () { showView('main'); setHash(currentTab, true); });
  $('#elite-btn').addEventListener('click', function () { showView('elite'); setHash('elite', true); });

  /* ---------- tabs: Analyzer · Board · Portfolio ---------- */
  function showTab(name) {
    if (VALID_TABS.indexOf(name) === -1) name = 'analyzer';
    currentTab = name;
    $all('.tab-btn').forEach(function (b) {
      b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false');
    });
    $all('.screen').forEach(function (s) { s.classList.toggle('active', s.id === 'screen-' + name); });
    window.scrollTo({ top: 0 });
  }
  $all('.tab-btn').forEach(function (b) {
    b.addEventListener('click', function () { showTab(b.dataset.tab); setHash(b.dataset.tab, true); });
  });
  // App nav row (same six links as the landing page): section links switch
  // tabs/views in place (works even when already on that hash, e.g. from
  // the ticker view), Pricing/Support are plain external links.
  $all('.app-nav [data-nav]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      var name = a.dataset.nav;
      if (name === 'elite') { showView('elite'); setHash('elite', true); }
      else { showView('main'); showTab(name); setHash(name, true); }
    });
  });
  // Deep-link on load: open the tab/view the URL hash names, as early as
  // possible (this script runs synchronously at the end of <body>).
  routeFromHash();

  /* ---------- Elite 32 data (roster only — no positions, no prices) ---------- */
  var ELITE = [
    // AI engines
    { t: 'NVDA', bloc: 'TECH', sub: 'AI engines', reason: 'AI compute leader; the engine the wheel was built around.' },
    { t: 'AMD', bloc: 'TECH', sub: 'AI engines', reason: 'Second AI compute source; wheeled during the run, not permanent.' },
    { t: 'AVGO', bloc: 'TECH', sub: 'AI engines', reason: 'Custom AI silicon + software; premium engine.' },
    { t: 'ANET', bloc: 'TECH', sub: 'AI engines', reason: 'AI networking fabric for hyperscale data centres.' },
    { t: 'LRCX', bloc: 'TECH', sub: 'AI engines', reason: 'Etch equipment — picks-and-shovels for chip supply.' },
    { t: 'TSM', bloc: 'TECH', sub: 'AI engines', reason: 'Foundry for nearly all leading-edge chips.' },
    { t: 'SMH', bloc: 'TECH', sub: 'AI engines', reason: 'Semiconductor basket; diversifies single-chip risk.' },
    { t: 'XLK', bloc: 'TECH', sub: 'AI engines', reason: 'Broad tech basket; diversifies single-name risk.' },
    { t: 'PANW', bloc: 'TECH', sub: 'AI engines', reason: 'First-choice cybersecurity seat; platform consolidation.' },
    { t: 'ORCL', bloc: 'TECH', sub: 'AI engines', reason: 'Database + cloud infrastructure; watch the OCI growth tripwire.' },
    // Mega platforms
    { t: 'AAPL', bloc: 'TECH', sub: 'Mega platforms', reason: 'Installed-base cash machine; services compounding.' },
    { t: 'MSFT', bloc: 'TECH', sub: 'Mega platforms', reason: 'Cloud + productivity; tier placement still under review.' },
    { t: 'GOOGL', bloc: 'TECH', sub: 'Mega platforms', reason: 'Search + cloud; most AI-exposed — watch for revenue leak.' },
    { t: 'META', bloc: 'TECH', sub: 'Mega platforms', reason: 'Ads + AI at scale; drawdowns are buying opportunities, not breaks.' },
    { t: 'AMZN', bloc: 'TECH', sub: 'Mega platforms', reason: 'Cloud + retail; premium-first lot.' },
    // Steady anchors
    { t: 'ABBV', bloc: 'ANCHOR', sub: 'Steady anchors', reason: 'Immunology cash flow; hold-first permanent.' },
    { t: 'WMT', bloc: 'ANCHOR', sub: 'Steady anchors', reason: 'Defensive retail; hold-first permanent.' },
    { t: 'PM', bloc: 'ANCHOR', sub: 'Steady anchors', reason: 'Smoke-free transition with pricing power.' },
    { t: 'ADP', bloc: 'ANCHOR', sub: 'Steady anchors', reason: 'Payroll backbone; watch Employer Services retention.' },
    { t: 'TXN', bloc: 'ANCHOR', sub: 'Steady anchors', reason: 'Analog chips; hold-first permanent.' },
    { t: 'CSCO', bloc: 'ANCHOR', sub: 'Steady anchors', reason: 'Networking; the anchor with the best rent, and the AI infrastructure leg just beat.' },
    { t: 'HD', bloc: 'ANCHOR', sub: 'Steady anchors', reason: 'Home-improvement leader; housing-cycle anchor.' },
    { t: 'V', bloc: 'ANCHOR', sub: 'Steady anchors', reason: 'Payments network; watch agent-platform routing tripwire.' },
    { t: 'CME', bloc: 'ANCHOR', sub: 'Steady anchors', reason: 'Derivatives exchange; volatility is its tailwind.' },
    { t: 'JPM', bloc: 'ANCHOR', sub: 'Steady anchors', reason: 'Largest US bank; fortress balance sheet.' },
    { t: 'PGR', bloc: 'ANCHOR', sub: 'Steady anchors', reason: 'Disciplined auto insurer; underwriting-first.' },
    // Real-asset diversifiers
    { t: 'XLE', bloc: 'DIVERSE', sub: 'Real-asset diversifiers', reason: 'Energy basket; real-asset ballast when tech wrecks.' },
    { t: 'PLD', bloc: 'DIVERSE', sub: 'Real-asset diversifiers', reason: 'Logistics warehouses; real-asset income.' },
    { t: 'AMT', bloc: 'DIVERSE', sub: 'Real-asset diversifiers', reason: 'Cell towers; leverage asterisk — watch the debt.' },
    { t: 'GE', bloc: 'DIVERSE', sub: 'Real-asset diversifiers', reason: 'Aerospace + energy turnaround; industrial diversifier.' },
    { t: 'RTX', bloc: 'DIVERSE', sub: 'Real-asset diversifiers', reason: 'Defense + aerospace; real-asset diversifier.' },
    { t: 'ETN', bloc: 'DIVERSE', sub: 'Real-asset diversifiers', reason: 'Power management for electrification + data centres.' }
  ];
  var ELITE_SET = {};
  ELITE.forEach(function (e) { ELITE_SET[e.t] = e; });

  function renderEliteGroups() {
    var groups = [
      { sub: 'AI engines', blurb: 'The names that build and run the AI buildout.' },
      { sub: 'Mega platforms', blurb: 'The platforms the internet runs on.' },
      { sub: 'Steady anchors', blurb: 'Cash machines that stay writable when tech wrecks.' },
      { sub: 'Real-asset diversifiers', blurb: 'Hard assets that move on different drivers than tech.' }
    ];
    $('#elite-groups').innerHTML = groups.map(function (g) {
      var list = ELITE.filter(function (e) { return e.sub === g.sub; });
      return '<div class="elite-group"><h3 class="font-display">' + esc(g.sub) +
        '<span class="count">' + list.length + ' names</span></h3>' +
        '<p class="blurb">' + esc(g.blurb) + '</p>' +
        '<ul class="list-shell">' + list.map(function (e) {
          return '<li><b class="font-display">' + esc(e.t) + '</b> <span class="why"> — ' + esc(e.reason) + '</span></li>';
        }).join('') + '</ul></div>';
    }).join('');
  }
  renderEliteGroups();

  /* ---------- walkthrough (3 steps, once, replayable from About) ---------- */
  var WALK = [
    { label: 'Welcome', title: 'Grade the trade before you make it',
      body: '<p>WheelGrade grades cash-secured puts and covered calls A–F before you trade — then tracks every dollar of premium you collect. One fixed set of rules, applied the same way every time.</p>' },
    { label: 'The Analyzer', title: 'Type a ticker, get a grade',
      body: '<p>Pick a strategy and an expiration, take the ~30Δ strike suggestion or choose your own, and the Analyzer checks it: Elite quality first, rent of at least ~1%/month, the earnings print gate, the basis you\u2019d own at, and a spread tight enough to fill.</p>' },
    { label: 'Portfolio & Board', title: 'Your premium, and the Elite 32',
      body: '<p>Made the trade in your own brokerage? Add it to Portfolio — WheelGrade tracks its rent, profit captured, and days left, plus your premium this month and lifetime per ticker. The Board shows all 32 Elite names at a glance: price, discount off the 1-year high, and both-sides rent.</p>' }
  ];
  var walkIdx = 0;
  function renderWalk() {
    var step = WALK[walkIdx];
    $('#walk-step-label').textContent = step.label + ' · ' + (walkIdx + 1) + ' of 3';
    $('#walk-title').textContent = step.title;
    $('#walk-body').innerHTML = step.body;
    $all('#walk-dots span').forEach(function (d, i) { d.classList.toggle('on', i === walkIdx); });
    $('#walk-back').disabled = walkIdx === 0;
    $('#walk-next').textContent = walkIdx === WALK.length - 1 ? 'Start grading trades' : 'Next';
  }
  function openWalk() { walkIdx = 0; renderWalk(); $('#walkthrough-modal').classList.add('open'); }
  function finishWalk() {
    try { window.localStorage.setItem('wg-walkthrough-seen', '1'); } catch (e) {}
    $('#walkthrough-modal').classList.remove('open');
  }
  $('#replay-walkthrough').addEventListener('click', openWalk);
  $('#walk-next').addEventListener('click', function () {
    if (walkIdx < WALK.length - 1) { walkIdx++; renderWalk(); } else finishWalk();
  });
  $('#walk-back').addEventListener('click', function () { if (walkIdx > 0) { walkIdx--; renderWalk(); } });
  $('#walk-skip').addEventListener('click', finishWalk);
  try {
    if (!window.localStorage.getItem('wg-walkthrough-seen')) openWalk();
  } catch (e) {}

  /* ---------- auth links (subpath-aware) + copy lines + payment banner ---------- */
  $all('[data-auth-provider]').forEach(function (a) {
    a.setAttribute('href', authUrl(a.dataset.authProvider));
  });
  $all('.copy-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      var value = b.dataset.copy || '';
      function done() {
        b.textContent = 'Copied';
        setTimeout(function () { b.textContent = 'Copy'; }, 1500);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(done, function () { fallbackCopy(value); done(); });
      } else { fallbackCopy(value); done(); }
    });
  });
  function fallbackCopy(value) {
    try {
      var ta = document.createElement('textarea');
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) {}
  }
  // Post-payment: Stripe returns to /app?payment=success&session_id=...
  // Claim the payment server-side — the server verifies the
  // webhook-recorded payment by session id and sets a session
  // cookie, so the buyer lands already logged in as paid. Retry
  // briefly: the webhook can lag the redirect by a few seconds.
  // On failure, fall back to the sign-in prompt (the OAuth claim
  // path still works for this email). The session id is cleaned out
  // of the URL after a successful claim so it can't be shared or
  // bookmarked.
  (function () {
    var q = new URLSearchParams(window.location.search);
    if (q.get('payment') !== 'success') return;
    var banners = $('#analyzer-banners');
    var sessionId = q.get('session_id');
    function signInPrompt() {
      banners.innerHTML = '<p class="banner">Payment complete — welcome to WheelGrade. Sign in with Apple or Google below to create your account. Your portfolio starts empty: $0, no positions, no history.</p>';
      show(banners);
      show($('#payment-banner-in-card'));
    }
    if (!sessionId) { signInPrompt(); return; }
    var attempts = 0;
    function tryClaim() {
      attempts++;
      fetch(apiUrl('claim-session?session_id=' + encodeURIComponent(sessionId)), { credentials: 'same-origin' })
        .then(function (res) {
          return res.json().then(function (data) { return { status: res.status, data: data }; });
        })
        .then(function (r) {
          if (r.data && r.data.ok && r.data.paid) {
            var u = new URL(window.location.href);
            u.searchParams.delete('session_id');
            u.searchParams.delete('payment');
            try { window.history.replaceState(null, '', u.pathname + u.search + u.hash); } catch (e) {}
            banners.innerHTML = '<p class="banner">Payment complete — welcome to WheelGrade. You are signed in and your portfolio starts empty: $0, no positions, no history.</p>';
            show(banners);
            refreshScope().then(function (s) { if (s) applyAnalyzerGate(s); });
            return;
          }
          if (r.data && r.data.pending && attempts < 6) { setTimeout(tryClaim, 2000); return; }
          signInPrompt();
        })
        .catch(function () {
          if (attempts < 6) { setTimeout(tryClaim, 2000); return; }
          signInPrompt();
        });
    }
    banners.innerHTML = '<p class="banner">Payment complete — setting up your account…</p>';
    show(banners);
    tryClaim();
  })();

  /* ---------- About panel ---------- */
  $('#about-toggle').addEventListener('click', function () {
    var panel = $('#about-panel');
    var open = panel.classList.toggle('hidden') === false;
    $('#about-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  /* ---------- Analyzer ---------- */
  var analyzerKind = 'put';
  var analyzerStrikeMode = 'suggested';
  // Default expiry is the next Friday (options expire on Fridays).
  // Only set it when the field is empty — never overwrite a date
  // the user already picked. The user can still choose any date.
  if (!$('#expiry').value) $('#expiry').value = nextFridayISO();
  // The form is always visible and usable at first — everyone gets
  // 3 free grades; the backend enforces the limit (402 at 0 left).

  function setPillPressed(attr, value) {
    var key = attr === 'data-kind' ? 'kind' : 'strikeMode';
    $all('[' + attr + ']').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset[key] === value ? 'true' : 'false');
    });
  }
  function syncAnalyzerForm() {
    setPillPressed('data-kind', analyzerKind);
    setPillPressed('data-strike-mode', analyzerStrikeMode);
    $('#own-strike-wrap').classList.toggle('hidden', analyzerStrikeMode !== 'own');
    var isCall = analyzerKind === 'call';
    $('#call-fields').classList.toggle('hidden', !isCall);
    updateSharesNote();
  }
  function updateSharesNote() {
    var note = $('#shares-note');
    if (analyzerKind !== 'call') { hide(note); return; }
    var shares = Number($('#shares-owned').value);
    if (shares >= 100) {
      note.textContent = shares + ' shares cover ' + Math.floor(shares / 100) + ' contract(s).';
      show(note);
    } else hide(note);
  }
  // Covered-call AVE in the Analyzer fills itself in from the share
  // lots, same as the Portfolio form: the lots are the record of what
  // the shares cost. A manually typed cost is respected until the
  // ticker changes (the old cost belongs to the old ticker).
  var analyzerAveManuallyEdited = false;
  function autofillAnalyzerAve() {
    if (analyzerKind !== 'call') return;
    var ticker = ($('#ticker').value || '').trim().toUpperCase();
    var aveEl = $('#avgCost');
    if (!ticker || !aveEl) return;
    var lots = (state.board && state.board.lots) || [];
    var shares = 0;
    var cost = 0;
    for (var i = 0; i < lots.length; i++) {
      var lot = lots[i];
      if (String(lot.ticker || '').toUpperCase() === ticker && lot.avgCost != null && lot.shares > 0) {
        shares += lot.shares;
        cost += lot.avgCost * lot.shares;
      }
    }
    if (shares > 0 && !analyzerAveManuallyEdited) {
      aveEl.value = (cost / shares).toFixed(2);
    }
  }
  $all('[data-kind]').forEach(function (b) {
    b.addEventListener('click', function () { analyzerKind = b.dataset.kind; syncAnalyzerForm(); autofillAnalyzerAve(); });
  });
  $all('[data-strike-mode]').forEach(function (b) {
    b.addEventListener('click', function () { analyzerStrikeMode = b.dataset.strikeMode; syncAnalyzerForm(); });
  });
  $('#shares-owned').addEventListener('input', updateSharesNote);
  $('#contracts').addEventListener('input', updateSharesNote);
  syncAnalyzerForm();

  /* ---------- Analyzer spot price ---------- */
  // Live current price under the ticker input, as a reference while
  // picking a strike. Read-only: a spot lookup is not a grade and
  // never touches the free-grades counter or the paywall.
  var spotSeq = 0;
  var spotTimer = null;
  function fmtSpotAsOf(asOf) {
    if (!asOf) return '';
    var d = new Date(asOf);
    if (!isNaN(d.getTime())) {
      var h = d.getHours();
      var m = String(d.getMinutes()).padStart(2, '0');
      var ap = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return h + ':' + m + ' ' + ap;
    }
    return String(asOf);
  }
  function renderTickerSpot(ticker, data) {
    var el = $('#ticker-spot');
    if (!el) return;
    if (!data || !data.ok || data.spot == null) {
      el.textContent = ticker + ' — price unavailable';
      show(el);
      return;
    }
    var html = esc(ticker) + ' — <strong>' + esc(money(data.spot)) + '</strong>';
    if (typeof data.changePercent === 'number') {
      var chg = Number(data.changePercent);
      html += ' <span class="' + (chg >= 0 ? 'good' : 'bad') + '">(' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '% today)</span>';
    }
    var asOf = fmtSpotAsOf(data.asOf);
    if (asOf) html += ' · as of ' + esc(asOf);
    el.innerHTML = html;
    show(el);
  }
  async function fetchTickerSpot() {
    var input = $('#ticker');
    if (!input) return;
    var ticker = input.value.trim().toUpperCase();
    var el = $('#ticker-spot');
    if (!ticker) { if (el) hide(el); return; }
    var mySeq = ++spotSeq;
    if (el) { el.textContent = ticker + ' — loading…'; show(el); }
    try {
      var data = await api('quote?ticker=' + encodeURIComponent(ticker));
      if (mySeq !== spotSeq) return; // a newer lookup supersedes this one
      renderTickerSpot(ticker, data);
    } catch (e) {
      if (mySeq !== spotSeq) return;
      if (el) { el.textContent = ticker + ' — price unavailable'; show(el); }
    }
  }
  function scheduleTickerSpot() {
    if (spotTimer) clearTimeout(spotTimer);
    spotTimer = setTimeout(fetchTickerSpot, 400);
  }
  var tickerInput = $('#ticker');
  if (tickerInput) {
    tickerInput.addEventListener('input', function () { scheduleTickerSpot(); analyzerAveManuallyEdited = false; autofillAnalyzerAve(); });
    tickerInput.addEventListener('change', fetchTickerSpot);
  }
  var analyzerAveInput = $('#avgCost');
  if (analyzerAveInput) {
    analyzerAveInput.addEventListener('input', function () { analyzerAveManuallyEdited = true; });
  }
  // If a ticker is already present (e.g. restored by the browser), fetch it.
  fetchTickerSpot();

  function statTile(label, valueHtml, cls) {
    return '<div class="stat"><div class="stat-label">' + esc(label) + '</div>' +
      '<div class="stat-value tnum' + (cls ? ' ' + cls : '') + '">' + valueHtml + '</div></div>';
  }

  $('#analyze-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var errBox = $('#analyze-error');
    hide(errBox);
    hide($('#analyze-result'));
    var ticker = $('#ticker').value.trim().toUpperCase();
    var expiry = $('#expiry').value;
    if (!ticker) { errBox.textContent = 'Enter a ticker.'; show(errBox); return; }
    if (!expiry || expiry <= todayISO()) { errBox.textContent = 'Pick an expiry in the future.'; show(errBox); return; }
    if (analyzerStrikeMode === 'own' && !$('#strike').value) {
      errBox.textContent = 'Enter a strike, or switch to the ~30Δ suggestion.'; show(errBox); return;
    }
    show($('#analyze-loading'));
    $('#analyze-submit').disabled = true;
    var body = { ticker: ticker, kind: analyzerKind, expiry: expiry };
    if (analyzerStrikeMode === 'own' && $('#strike').value) body.strike = Number($('#strike').value);
    var contracts = Number($('#contracts').value);
    if (contracts) body.contracts = contracts;
    if (analyzerKind === 'call' && $('#avgCost').value) body.avgCost = Number($('#avgCost').value);
    try {
      var res = await api('analyze', { method: 'POST', body: body });
      state.lastAnalysis = res;
      renderAnalysis(res, body);
      // A real grade consumes one free try (paid/owner are unlimited).
      // Prefer the count the grade itself returns; otherwise refresh
      // scope for the fresh count. The paywall keeps the grade just
      // rendered — it only removes the form.
      if (res && res.ok && !state.analyzerAllowed) {
        if (typeof res.freeGradesLeft === 'number') {
          applyFreeGradesLeft(res.freeGradesLeft, { keepResult: true });
        } else {
          recordFreeGradeUsed();
          refreshScope().then(function (s) {
            state.scope = s;
            state.analyzerAllowed = isAnalyzerAllowed(s);
            applyFreeGradesLeft(freeGradesLeftFromScope(s), { keepResult: true });
          });
        }
      }
    } catch (err) {
      // Backend paywall: 402 payment_required — swap the form for the
      // PurchaseCard + note instead of showing a grade or a raw error.
      if (err && (err.status === 402 || err.code === 'payment_required')) {
        showAnalyzerPaywall();
      } else {
        errBox.textContent = 'The chain didn\u2019t come back — try again in a moment.';
        show(errBox);
      }
    } finally {
      hide($('#analyze-loading'));
      var submitBtn = $('#analyze-submit');
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  function renderAnalysis(res, req) {
    // Short disclaimer under every result, graded or not.
    var DISCLAIMER = 'This grade is for education only and is not financial advice. Do your own research before trading.';
    // Defensive: a payment_required payload must never render a grade.
    if (res && res.error === 'payment_required') { showAnalyzerPaywall(); return; }
    var box = $('#analyze-result');
    if (!box) return;
    if (!res.ok) {
      // Non-OK result: warn box with the server message, plus the
      // disclaimer — it shows under every result, graded or not.
      box.className = 'warn-box';
      box.innerHTML = '<p>' + esc(res.message || 'That trade couldn\u2019t be graded.') + '</p>' +
        '<p class="disclaimer">' + DISCLAIMER + '</p>';
      show(box);
      return;
    }
    box.className = 'card result-card';
    var grade = String(res.grade || '?').toUpperCase().charAt(0);
    var verdict = res.verdict || '';
    var kindLabel = req.kind === 'call' ? 'Covered call' : 'Cash-secured put';
    var kindShort = req.kind === 'call' ? 'call' : 'put';
    var strike = res.strike;
    var expiryShown = res.expiry || req.expiry;
    var rent = res.rentPctMo;
    var delta = res.delta != null ? Math.abs(Number(res.delta)) : null;
    var pop = res.pop != null ? Math.round(Number(res.pop) * 100) : null;

    // Quality note: Elite needs none; a non-Elite name shows its
    // quality tier (strong = no discount, decent/unknown = caps at B,
    // weak = caps at C). Falls back to the old capped-at-C line when
    // the tier is absent (stale response).
    var qualityNoteHtml = '';
    if (!res.elite) {
      var qt = res.qualityTier || 'weak';
      if (qt === 'strong') {
        qualityNoteHtml = '<p class="quality-note">Not on the Elite list, but the fundamentals check out — no quality discount.</p>';
      } else if (qt === 'decent') {
        qualityNoteHtml = '<p class="quality-note">Not on the Elite list — fundamentals decent. Grade caps at B.</p>';
      } else if (qt === 'unknown') {
        qualityNoteHtml = '<p class="quality-note">Not on the Elite list — fundamentals not verified. Grade caps at B.</p>';
      } else {
        qualityNoteHtml = '<p class="not-elite">Not vetted — quality first. Grade caps at C.</p>';
      }
    }
    var html = '<div class="grade-head"><div class="grade-badge grade-' + esc(grade) + '">' + esc(grade) + '</div>' +
      '<div style="flex:1;min-width:0"><p class="verdict">' + esc(verdict) + '</p>' +
      // Strike prominence: large, bold, full-contrast — the one deliberate
      // deviation from the original, where the strike lived only in the
      // small dim summary line below (kept here too).
      (strike != null
        ? '<p class="strike-big tnum">Strike ' + money(strike) + ' <span class="strike-kind">· ' + esc(kindLabel) + '</span></p>'
        : '') +
      '<p class="summary-line tnum">' + esc(res.ticker) +
      (strike != null ? ' ' + money(strike) + ' ' + kindShort : '') +
      ' · exp ' + esc(fmtDate(expiryShown)) + ' · ' + esc(String(res.dte)) + 'd' +
      (res.spot != null ? ' · spot ' + money(res.spot) : '') + '</p>' +
      qualityNoteHtml +
      '</div></div>';
    if (res.expiryAdjusted) {
      html += '<p class="expiry-note">That exact expiry isn\u2019t listed — this grades the ' + esc(fmtDate(expiryShown)) + ' expiry instead.</p>';
    }
    // Metric tiles: label 12px dim, value 16px semibold, no bg/border.
    html += '<div class="stat-grid">' +
      statTile('Rent', rent == null ? '—' : Number(rent).toFixed(2) + '%/mo', rent == null ? '' : (Number(rent) >= 1 ? 'good' : 'bad')) +
      statTile('Delta', delta == null ? '—' : delta.toFixed(2)) +
      statTile('Chance of profit', pop == null ? '—' : '~' + pop + '%') +
      statTile('Premium (mid)', money(res.premium)) +
      statTile('Max profit', res.maxProfit == null ? '—' : money0(res.maxProfit), 'good') +
      statTile('Breakeven', money(res.breakeven));
    if (req.kind === 'put') {
      html += statTile('Basis if assigned', money(res.basisIfAssigned));
    } else {
      html += statTile('Exit if called', money(res.exitIfCalled)) +
        statTile('Gain if called', res.gainIfCalled == null ? '—' : signedMoney(res.gainIfCalled),
          res.gainIfCalled == null ? '' : (Number(res.gainIfCalled) >= 0 ? 'good' : 'bad'));
    }
    html += '</div>';
    // Checks list, in server order, with PASS/WARN/FAIL/CHECK pills.
    var checks = Array.isArray(res.checks) ? res.checks : [];
    if (checks.length) {
      var pillText = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', unknown: 'CHECK' };
      var pillClass = { pass: 'status-pass', warn: 'status-warn', fail: 'status-fail', unknown: 'status-check' };
      html += '<div class="checks">' + checks.map(function (c) {
        var st = pillText[c.status] ? c.status : 'unknown';
        return '<div class="check-row"><span class="status-pill ' + pillClass[st] + '">' + pillText[st] + '</span>' +
          '<p class="check-text"><strong>' + esc(c.label) + '</strong>. ' + esc(c.detail) + '</p></div>';
      }).join('') + '</div>';
    }
    var fixes = Array.isArray(res.fixes) ? res.fixes : [];
    if (fixes.length) {
      html += '<div class="fix-box"><h3>What to change</h3><ul>' +
        fixes.map(function (f) { return '<li>' + esc(String(f)) + '</li>'; }).join('') + '</ul></div>';
    }
    if (res.altStrike) {
      html += '<button class="alt-strike-btn tnum" id="alt-strike-btn" type="button">Grade the ~30Δ strike instead: ' +
        money(res.altStrike.strike) +
        (res.altStrike.rentPctMo != null ? ' · ' + Number(res.altStrike.rentPctMo).toFixed(2) + '%/mo' : '') + '</button>';
    }
    var footParts = [];
    if (res.bid != null && res.ask != null) footParts.push('Bid ' + money(res.bid) + ' · Ask ' + money(res.ask));
    if (res.iv != null) footParts.push('IV ' + Math.round(Number(res.iv) * 100) + '%');
    if (res.earningsDate) footParts.push('Earnings ' + fmtDate(res.earningsDate));
    var asOf = fmtAsOf(res.asOf);
    if (asOf) footParts.push('Chain ' + asOf + ' ET (delayed)');
    html += '<p class="chain-note tnum">' + esc(footParts.join(' · ')) + '</p>';
    html += '<div id="add-to-portfolio-wrap" style="margin-top:16px">' +
      '<button class="btn btn-green btn-block" id="add-to-portfolio-btn" type="button">I made this trade — add to my portfolio</button>' +
      '<p class="add-hint">Logs the premium at the graded mid. If your fill was different, edit the premium on the position card in Portfolio.</p></div>';
    html += '<p class="disclaimer">' + DISCLAIMER + '</p>';
    box.innerHTML = html;
    show(box);
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    var altBtn = $('#alt-strike-btn');
    if (altBtn) {
      altBtn.addEventListener('click', function () {
        analyzerStrikeMode = 'own';
        $('#strike').value = String(res.altStrike.strike);
        syncAnalyzerForm();
        $('#analyze-form').dispatchEvent(new Event('submit', { cancelable: true }));
      });
    }
    $('#add-to-portfolio-btn').addEventListener('click', addAnalysisToPortfolio);
  }

  async function addAnalysisToPortfolio() {
    var res = state.lastAnalysis || {};
    var account = ($('#account').value || '').trim() || 'taxable';
    var req = {
      ticker: ($('#ticker').value || '').trim().toUpperCase(),
      kind: analyzerKind,
      expiry: $('#expiry').value,
      strike: res.strike != null ? res.strike : (Number($('#strike').value) || undefined),
      premiumPerShare: res.premium != null ? res.premium : undefined,
      contracts: Number($('#contracts').value) || 1,
      openedOn: todayISO(),
      account: account
    };
    if (analyzerKind === 'call' && $('#avgCost').value) req.basisPerShare = Number($('#avgCost').value);
    var btn = $('#add-to-portfolio-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    try {
      await api('positions', { method: 'POST', body: req });
      var wrap = $('#add-to-portfolio-wrap');
      if (wrap) {
        wrap.innerHTML = '<p class="added-note">Added to your portfolio.</p>' +
          '<p style="margin-top:8px"><button class="btn btn-outline btn-block" id="see-in-portfolio-btn" type="button">See it in Portfolio</button></p>';
        $('#see-in-portfolio-btn').addEventListener('click', function () {
          showTab('portfolio');
          setHash('portfolio', false);
          state.board = null;
          loadPortfolio();
        });
      }
    } catch (err) {
      var box = $('#analyze-error');
      box.textContent = 'Could not add to portfolio: ' + err.message;
      show(box);
      if (btn) { btn.disabled = false; btn.textContent = 'I made this trade — add to my portfolio'; }
    }
  }

  /* ---------- Portfolio ---------- */
  function kindLabel(p) {
    if (p.kind === 'spread') return p.watchBaselineClose != null ? 'Legacy put · exit watch' : 'Index put spread';
    return p.kind === 'call' ? 'Covered call' : 'Cash-secured put';
  }
  function kindShort(p) {
    if (p.kind === 'spread') return 'put spread';
    return p.kind === 'call' ? 'call' : 'put';
  }
  function statusLabel(s) {
    return { closed: 'Closed', expired: 'Expired worthless', assigned: 'Assigned shares', called_away: 'Called away' }[s] || s;
  }
  function levelWord(level) { return level === 'act' ? 'ACT' : level === 'watch' ? 'WATCH' : 'HOLD'; }

  function renderPortfolio(data) {
    state.board = data;
    // The lots just arrived — if the user already typed a covered-call
    // ticker in the Analyzer, fill its cost now.
    autofillAnalyzerAve();
    var positions = data.positions || [];
    var summary = data.summary || {};
    var monthPrem = summary.premiumCollectedMonth;
    var allPrem = summary.premiumAllTime;
    if ((monthPrem == null || allPrem == null) && state.history) {
      monthPrem = monthPrem != null ? monthPrem : state.history.premiumThisMonth;
      allPrem = allPrem != null ? allPrem : state.history.premiumAllTime;
    }
    $('#premium-month-label').textContent = 'Premium collected · ' + (summary.monthLabel || '');
    $('#premium-month').textContent = money0(monthPrem);
    var split = [];
    if (summary.premiumTaxableMonth) split.push('Taxable ' + money0(summary.premiumTaxableMonth));
    if (summary.premiumRothMonth) split.push('Roth ' + money0(summary.premiumRothMonth));
    $('#premium-split').textContent = split.join(' · ');
    $('#premium-alltime').textContent = money0(allPrem);
    $('#portfolio-tab-premium').textContent = allPrem != null ? ' · ' + money0(allPrem) : '';
    var realizedEl = $('#realized-month');
    realizedEl.textContent = signedMoney0(summary.realizedMonth || 0);
    realizedEl.classList.toggle('neg', Number(summary.realizedMonth) < 0);
    $('#open-count').textContent = String(summary.openCount != null ? summary.openCount : positions.length);
    $('#put-collateral').textContent = money0(summary.collateralAtRisk);
    var quotesAsOf = fmtAsOf(summary.quotesAsOf);
    $('#quotes-line').textContent = quotesAsOf
      ? 'Prices as of ' + quotesAsOf + ' ET' + (summary.marketStatus ? ' · ' + summary.marketStatus : '') + ' · Option marks are delayed quotes'
      : 'Enter a position and prices will appear here.';

    // Needs attention
    var attention = data.attention || [];
    $('#attention-section').classList.toggle('hidden', !attention.length);
    // Needs attention — two columns grouped by status on wide screens:
    // red "Act now" (ITM / assignment likely) beside yellow "Watch"
    // (close candidates / print gate). Stacks to one column on phones.
    function attentionItemHtml(p) {
      var days = p.dte < 0 ? 'Past expiry' : p.dte + 'd left';
      return '<div class="attention-item' + (p.level === 'watch' ? ' watch' : '') + '">' +
        '<button class="att-main" type="button" data-ticker="' + esc(p.ticker) + '">' +
        '<span><span class="att-title">' + esc(p.ticker) + ' <span class="strike-strong tnum">' + money(p.strike) + ' ' + kindShort(p) + '</span></span>' +
        '<span class="att-flag">' + esc((p.flags && p.flags[0]) || '') + '</span></span>' +
        '<span class="att-right"><span class="att-days tnum">' + esc(days) + '</span> <span class="att-chev">›</span></span></button>' +
        '<button class="btn btn-outline btn-sm att-edit-btn" type="button" data-id="' + esc(String(p.id)) + '">Edit</button></div>';
    }
    var actItems = attention.filter(function (p) { return p.level !== 'watch'; });
    var watchItems = attention.filter(function (p) { return p.level === 'watch'; });
    $('#attention-list').innerHTML =
      (actItems.length ? '<div class="attention-group"><h3 class="attention-group-title act">Act now</h3>' + actItems.map(attentionItemHtml).join('') + '</div>' : '') +
      (watchItems.length ? '<div class="attention-group"><h3 class="attention-group-title watch">Watch</h3>' + watchItems.map(attentionItemHtml).join('') + '</div>' : '');
    $all('#attention-list .att-main').forEach(function (b) {
      b.addEventListener('click', function () { openTickerView(b.dataset.ticker); });
    });
    $all('#attention-list .att-edit-btn').forEach(function (b) {
      b.addEventListener('click', function () { openEdit(b.dataset.id); });
    });

    // Open positions
    hide($('#positions-loading'));
    var empty = positions.length === 0;
    $('#positions-empty').classList.toggle('hidden', !empty);
    var grid = $('#positions-grid');
    if (empty) { grid.innerHTML = ''; }
    else {
      grid.innerHTML = positions.map(function (p) { return positionCardHtml(p); }).join('');
      wirePositionCards(grid, positions);
    }

    // Share lots
    var lots = data.lots || [];
    $('#lots-section').classList.toggle('hidden', !lots.length);
    $('#lots-grid').innerHTML = lots.map(function (lot) {
      var unrl = lot.unrealizedPnl;
      var calls = lot.calls || [];
      return '<article class="card">' +
        '<div class="pos-head"><div><h3 class="pos-ticker">' + esc(lot.ticker) +
        '<span class="pos-strike tnum">' + esc(String(lot.shares)) + ' shares</span></h3>' +
        '<span class="pos-sub">' + esc(lot.account || '') + ' · your cost (AVE) ' + money(lot.avgCost) + '</span></div>' +
        '<div style="text-align:right"><div class="stat-label">Unrealized</div>' +
        '<div class="stat-value tnum ' + (unrl == null ? '' : (unrl >= 0 ? 'good' : 'bad')) + '" style="font-size:18px;font-weight:700">' + (unrl == null ? '—' : signedMoney0(unrl)) + '</div></div></div>' +
        '<div class="stat-grid">' +
        statTile('Spot', money(lot.spot)) +
        statTile('Value', lot.marketValue == null ? '—' : money0(lot.marketValue)) +
        statTile('Cost', money0(lot.avgCost * lot.shares)) +
        '</div>' +
        (calls.length
          ? '<div class="pos-flags">' + calls.map(function (c) {
              return '<p class="pos-flag tnum">Call sold: ' + money(c.strike) + ' · exp ' + esc(fmtDate(c.expiry)) + ' · ×' + esc(String(c.contracts)) +
                (c.premiumPerShare != null ? ' · ' + money(c.premiumPerShare) + '/sh' : '') + '</p>';
            }).join('') + '</div>'
          : '<p class="pos-flag watch" style="margin-top:12px">No call open on this lot</p>') +
        (lot.callPremiumTotal != null
          ? '<p class="pos-meta tnum">Combined call premium: ' + money0(lot.callPremiumTotal * lot.shares) + ' total</p>' : '') +
        (lot.note ? '<p class="pos-note">' + esc(lot.note) + '</p>' : '') +
        '</article>';
    }).join('');

    // Lifetime by ticker
    var tickers = data.tickers || [];
    $('#lifetime-list').innerHTML = tickers.map(function (t) {
      var sub = t.openCount + ' open · ' + t.tradeCount + ' trade(s)' +
        (t.assignments ? ' · ' + t.assignments + ' assigned' : '') +
        (t.callAways ? ' · ' + t.callAways + ' called away' : '');
      return '<li><button class="list-row" type="button" data-ticker="' + esc(t.ticker) + '">' +
        '<span><span class="row-title">' + esc(t.ticker) + '</span>' +
        (t.hasLot ? '<span class="row-sub" style="margin-left:8px">lot held</span>' : '') +
        '<span class="row-sub tnum" style="display:block">' + esc(sub) + '</span></span>' +
        '<span class="row-value tnum">' + money0(t.lifetimePremium) + '<small>lifetime premium ›</small></span></button></li>';
    }).join('');
    $all('#lifetime-list .list-row').forEach(function (b) {
      b.addEventListener('click', function () { openTickerView(b.dataset.ticker); });
    });

    // Recent activity
    var activity = data.activity || [];
    $('#activity-section').classList.toggle('hidden', !activity.length);
    $('#activity-list').innerHTML = activity.map(function (a) {
      return '<li class="activity-row"><span class="act-date tnum">' + esc(fmtDate(a.date)) + '</span>' +
        '<span class="act-text">' + esc(a.text) + '</span></li>';
    }).join('');

    renderHistory();
  }

  function positionCardHtml(p) {
    var id = p.id;
    var isSpread = p.kind === 'spread';
    var strikeText = isSpread && p.longStrike != null
      ? money(p.strike) + '/' + money(p.longStrike) + ' put spread'
      : money(p.strike) + ' ' + kindShort(p);
    var sub = kindLabel(p) + ' · ' + p.contracts + ' contract(s)' +
      (p.account ? ' · ' + esc(p.account) : '') +
      (p.openedOn ? ' · opened ' + esc(fmtDate(p.openedOn)) : ' · sale date not recorded');
    var flags = (p.flags || []).map(function (f) {
      return '<p class="pos-flag ' + esc(p.level) + '">' + esc(f) + '</p>';
    }).join('');
    var dteText = p.dte < 0 ? 'Expired' : p.dte + 'd · ' + fmtDate(p.expiry);
    var stats = statTile('Spot', money(p.spot)) +
      statTile(isSpread ? 'Cost to close (net)' : 'Cost to close', p.mark == null ? '—' : money0(p.mark * 100 * p.contracts)) +
      statTile('Open P&L', p.pnlOpen == null ? '—' : signedMoney(p.pnlOpen), p.pnlOpen == null ? '' : (p.pnlOpen >= 0 ? 'good' : 'bad')) +
      statTile('Profit captured', p.pctProfit == null ? '—' : Math.round(p.pctProfit * 100) + '%') +
      statTile('Days left', esc(dteText)) +
      statTile(p.openedOn ? 'Rent' : 'Rent to expiry', p.rentPctMo == null ? '—' : Number(p.rentPctMo).toFixed(2) + '%/mo');
    if (p.kind === 'put') stats += statTile('Basis if assigned', money(p.basisIfAssigned));
    if (isSpread) stats += statTile('Max loss', p.maxLoss == null ? '—' : money0(p.maxLoss), 'bad');
    if (p.kind === 'call') {
      stats += statTile('Exit if called', money(p.exitIfCalled)) +
        statTile('Gain if called', p.gainIfCalled == null ? '—' : signedMoney(p.gainIfCalled),
          p.gainIfCalled == null ? '' : (p.gainIfCalled >= 0 ? 'good' : 'bad'));
    }
    stats += statTile(isSpread ? 'Credit in' : 'Premium in', p.premiumTotal == null ? '—' : money0(p.premiumTotal));

    var watchBox = '';
    if (p.watchBaselineClose != null) {
      var pctBase = (p.closeCostTotal != null && p.watchBaselineClose > 0)
        ? Math.round(p.closeCostTotal / p.watchBaselineClose * 100) : null;
      watchBox = '<div class="watch-box">' +
        statTile('Close cost now', p.closeCostTotal == null ? '—' : money0(p.closeCostTotal)) +
        statTile('Watch baseline', money0(p.watchBaselineClose)) +
        statTile('Great close ≤', p.watchGreatClose == null ? '—' : money0(p.watchGreatClose), 'good') +
        '<p class="watch-note tnum">' + (pctBase == null ? '' : 'Now at ' + pctBase + '% of baseline — flag fires at 60%, great close at 40%.') + '</p></div>';
    }
    var creditBox = '';
    // Offered whenever the credit is missing — puts, calls and spreads
    // alike — so a position whose premium was never entered can be fixed.
    if (p.premiumPerShare == null) {
      creditBox = '<div class="credit-box"><p>Original credit isn\u2019t in the records, so P&amp;L is blank. Enter it from your broker and the card fills in.</p>' +
        '<p style="margin-top:8px"><button class="btn btn-green btn-sm enter-credit-btn" type="button" data-id="' + esc(String(id)) + '">Enter the original credit</button></p>' +
        '<div class="credit-form hidden" style="margin-top:8px"><div class="grid2"><div><label>Original credit / share ($)</label>' +
        '<input class="tnum credit-value" type="number" step="0.01" min="0" inputmode="decimal" placeholder="e.g. 2.35"></div></div>' +
        '<p style="margin-top:8px"><button class="btn btn-green btn-sm credit-save-btn" type="button" data-id="' + esc(String(id)) + '">Save credit</button></p></div></div>';
    }
    var metaParts = [];
    if (p.delta != null) metaParts.push('Δ ' + Math.abs(Number(p.delta)).toFixed(2));
    if (p.iv != null) metaParts.push('IV ' + Math.round(Number(p.iv) * 100) + '%');
    if (p.premiumPerShare != null) metaParts.push('Premium ' + money(p.premiumPerShare) + '/sh');
    if (p.earningsDate) metaParts.push('Earnings ' + fmtDate(p.earningsDate));
    var quoteAsOf = fmtAsOf(p.quoteAsOf);
    if (quoteAsOf) metaParts.push('Quote ' + quoteAsOf + ' ET');

    return '<article class="card pos-card" data-id="' + esc(String(id)) + '" data-ticker="' + esc(p.ticker) + '">' +
      '<div class="pos-head"><div><h3 class="pos-ticker">' + esc(p.ticker) +
      '<span class="pos-strike tnum">' + strikeText + '</span></h3>' +
      '<span class="pos-sub">' + sub + '</span>' +
      '<span class="pos-lifetime-link">' + esc(p.ticker) + ' lifetime view ›</span></div>' +
      '<div class="pos-head-right"><span class="level-pill level-' + esc(p.level) + '">' + levelWord(p.level) + '</span>' +
      '<button class="btn btn-outline btn-sm edit-btn" type="button" data-id="' + esc(String(id)) + '">Edit</button></div></div>' +
      (flags ? '<div class="pos-flags">' + flags + '</div>' : '') +
      '<div class="stat-grid">' + stats + '</div>' +
      watchBox + creditBox +
      (p.note ? '<p class="pos-note">' + esc(p.note) + '</p>' : '') +
      (metaParts.length ? '<p class="pos-meta tnum">' + esc(metaParts.join(' · ')) + '</p>' : '') +
      '<div class="pos-actions">' +
      '<button class="btn btn-green btn-sm close-btn" type="button" data-id="' + esc(String(id)) + '">Close position</button>' +
      '<button class="btn btn-outline btn-sm btn-delete delete-btn" type="button" data-id="' + esc(String(id)) + '">Delete</button>' +
      '</div>' +
      '<div class="close-form hidden" data-close-form="' + esc(String(id)) + '">' +
      '<h3>Close this position</h3>' +
      '<div class="grid2"><div><label>Outcome</label><select class="close-outcome">' +
      '<option value="closed">Bought back</option><option value="expired">Expired worthless</option>' +
      (p.kind === 'put' ? '<option value="assigned">Assigned shares</option>' : '') +
      (p.kind === 'call' ? '<option value="called_away">Called away</option>' : '') +
      '</select></div><div><label>Close date</label><input class="tnum close-date" type="date" value="' + esc(todayISO()) + '"></div></div>' +
      '<div><label>Close premium / share ($)</label><input class="tnum close-premium" type="number" step="0.01" min="0" inputmode="decimal" placeholder="0.00 if expired worthless"></div>' +
      '<div class="form-actions"><button class="btn btn-green btn-sm close-save-btn" type="button" data-id="' + esc(String(id)) + '">Save close</button>' +
      '<button class="btn btn-outline btn-sm close-cancel-btn" type="button">Cancel</button></div>' +
      '<p class="error hidden close-error" role="alert"></p>' +
      '</div></article>';
  }

  function wirePositionCards(grid, positions) {
    var byId = {};
    positions.forEach(function (p) { byId[String(p.id)] = p; });
    $all('.pos-card', grid).forEach(function (card) {
      card.addEventListener('click', function () { openTickerView(card.dataset.ticker); });
    });
    $all('.pos-actions .btn, .enter-credit-btn, .credit-save-btn, .close-save-btn, .close-cancel-btn', grid).forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); });
    });
    $all('.close-btn', grid).forEach(function (b) {
      b.addEventListener('click', function () {
        var form = grid.querySelector('[data-close-form="' + b.dataset.id + '"]');
        if (form) form.classList.toggle('hidden');
      });
    });
    $all('.close-cancel-btn', grid).forEach(function (b) {
      b.addEventListener('click', function () {
        var form = b.closest('.close-form');
        if (form) form.classList.add('hidden');
      });
    });
    $all('.close-save-btn', grid).forEach(function (b) {
      b.addEventListener('click', function () { submitClose(b); });
    });
    $all('.edit-btn', grid).forEach(function (b) {
      b.addEventListener('click', function () { openEdit(b.dataset.id); });
    });
    $all('.delete-btn', grid).forEach(function (b) {
      b.addEventListener('click', function () {
        if (!b.dataset.armed) {
          b.dataset.armed = '1';
          b.textContent = 'Tap again to delete';
          b.classList.add('confirm');
          setTimeout(function () {
            delete b.dataset.armed;
            b.textContent = 'Delete';
            b.classList.remove('confirm');
          }, 4000);
          return;
        }
        deletePosition(b.dataset.id);
      });
    });
    $all('.enter-credit-btn', grid).forEach(function (b) {
      b.addEventListener('click', function () {
        var form = b.closest('.credit-box').querySelector('.credit-form');
        if (form) form.classList.remove('hidden');
      });
    });
    $all('.credit-save-btn', grid).forEach(function (b) {
      b.addEventListener('click', function () { submitCredit(b, byId); });
    });
  }

  async function submitClose(btn) {
    var id = btn.dataset.id;
    var form = btn.closest('.close-form');
    var errBox = form.querySelector('.close-error');
    hide(errBox);
    var body = {
      outcome: form.querySelector('.close-outcome').value,
      closePremiumPerShare: form.querySelector('.close-premium').value ? Number(form.querySelector('.close-premium').value) : 0,
      closedOn: form.querySelector('.close-date').value || todayISO()
    };
    btn.disabled = true;
    try {
      await api('positions/' + encodeURIComponent(id) + '/close', { method: 'POST', body: body });
      state.board = null;
      loadPortfolio();
    } catch (err) {
      errBox.textContent = err.message;
      show(errBox);
      btn.disabled = false;
    }
  }

  function fullPositionBody(p, premiumPerShare) {
    return {
      ticker: p.ticker,
      kind: p.kind,
      account: p.account || 'taxable',
      strike: p.strike,
      longStrike: p.kind === 'spread' ? (p.longStrike != null ? p.longStrike : null) : null,
      expiry: p.expiry,
      contracts: p.contracts || 1,
      premiumPerShare: premiumPerShare,
      openedOn: p.openedOn || todayISO(),
      basisPerShare: p.kind === 'call' && p.basisPerShare != null ? p.basisPerShare : null
    };
  }

  async function submitCredit(btn, byId) {
    var id = btn.dataset.id;
    var box = btn.closest('.credit-box');
    var value = Number(box.querySelector('.credit-value').value);
    if (!(value >= 0)) return;
    var p = byId[String(id)];
    if (!p) return;
    btn.disabled = true;
    try {
      await api('positions/' + encodeURIComponent(id), { method: 'PATCH', body: fullPositionBody(p, value) });
      state.board = null;
      loadPortfolio();
    } catch (err) {
      var box2 = $('#portfolio-error');
      box2.textContent = 'Could not save the credit: ' + err.message;
      show(box2);
      btn.disabled = false;
    }
  }

  async function deletePosition(id) {
    try {
      await api('positions/' + encodeURIComponent(id), { method: 'DELETE' });
      state.board = null;
      loadPortfolio();
    } catch (err) {
      var box = $('#portfolio-error');
      box.textContent = 'Could not delete: ' + err.message;
      show(box);
    }
  }

  async function loadPortfolio() {
    hide($('#portfolio-error'));
    show($('#positions-loading'));
    try {
      var scopeP = fetchScope();
      var histP = api('history').catch(function () { return null; });
      var board = await api('board');
      state.scope = await scopeP;
      state.history = await histP;
      renderPortfolio(board);
    } catch (err) {
      hide($('#positions-loading'));
      var box = $('#portfolio-error');
      box.textContent = 'Could not load your portfolio: ' + err.message;
      show(box);
    }
  }

  /* ---------- History ---------- */
  function renderHistory() {
    var h = state.history;
    var body = $('#history-body');
    if (!h) return;
    var months = h.months || [];
    $('#history-months').innerHTML = months.map(function (m) {
      return '<span class="month-pill tnum">' + esc(fmtMonth(m.month)) + ' · in ' + money0(m.collected) +
        ' · realized ' + signedMoney0(m.realized) + '</span>';
    }).join('');
    var closed = h.closed || [];
    $('#history-closed').innerHTML = closed.map(function (c) {
      var strikeText = c.kind === 'spread' ? money(c.strike) + ' put spread' : money(c.strike) + ' ' + (c.kind === 'call' ? 'call' : 'put');
      return '<li class="list-row"><span><span class="row-title">' + esc(c.ticker) + ' <span class="strike-strong tnum">' + strikeText + '</span></span>' +
        '<span class="row-sub" style="margin-left:8px">×' + esc(String(c.contracts)) + (c.account ? ' · ' + esc(c.account) : '') + '</span>' +
        '<span class="row-sub" style="display:block;text-transform:capitalize">' + esc(statusLabel(c.status)) + ' · ' + esc(fmtDate(c.closedOn)) + '</span></span>' +
        '<span class="row-value tnum ' + (Number(c.realized) >= 0 ? 'good' : 'bad') + '">' + signedMoney0(c.realized) + '</span></li>';
    }).join('');
  }
  $('#history-toggle').addEventListener('click', function () {
    var body = $('#history-body');
    var open = body.classList.toggle('hidden') === false;
    $('#history-toggle').textContent = open ? 'History ▾' : 'History ▸';
    $('#history-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  /* ---------- Add / edit trade (inline TradeForm) ---------- */
  var tradeKind = 'put';
  // Auto-fill the covered-call AVE from the share lots: the lots are the
  // record of what the shares cost, so the user never types it in. A
  // manually typed AVE is respected until the ticker changes (the old
  // cost belongs to the old ticker).
  var aveManuallyEdited = false;
  function autofillAve() {
    if (tradeKind !== 'call') return;
    var ticker = ($('#tf-ticker').value || '').trim().toUpperCase();
    var aveEl = $('#tf-ave');
    if (!ticker || !aveEl) return;
    var lots = (state.board && state.board.lots) || [];
    var shares = 0;
    var cost = 0;
    for (var i = 0; i < lots.length; i++) {
      var lot = lots[i];
      if (String(lot.ticker || '').toUpperCase() === ticker && lot.avgCost != null && lot.shares > 0) {
        shares += lot.shares;
        cost += lot.avgCost * lot.shares;
      }
    }
    if (shares > 0 && !aveManuallyEdited) {
      aveEl.value = (cost / shares).toFixed(2);
    }
  }
  function syncTradeForm() {
    $all('[data-trade-kind]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.tradeKind === tradeKind ? 'true' : 'false');
    });
    $('#tf-ave-wrap').classList.toggle('hidden', tradeKind !== 'call');
    $('#tf-long-strike-wrap').classList.toggle('hidden', tradeKind !== 'spread');
    updateTradePremiumTotal();
  }
  function updateTradePremiumTotal() {
    var prem = Number($('#tf-premium').value);
    var contracts = Number($('#tf-contracts').value) || 1;
    var el = $('#tf-premium-total');
    if (prem > 0) {
      el.innerHTML = 'Premium collected: <strong style="color:var(--text)">' + money0(prem * 100 * contracts) + '</strong>';
      show(el);
    } else hide(el);
  }
  $all('[data-trade-kind]').forEach(function (b) {
    b.addEventListener('click', function () { tradeKind = b.dataset.tradeKind; syncTradeForm(); autofillAve(); });
  });
  $('#tf-premium').addEventListener('input', updateTradePremiumTotal);
  $('#tf-contracts').addEventListener('input', updateTradePremiumTotal);
  $('#tf-ticker').addEventListener('input', function () { aveManuallyEdited = false; autofillAve(); });
  $('#tf-ave').addEventListener('input', function () { aveManuallyEdited = true; });

  function openTradeForm() {
    show($('#trade-form-wrap'));
    // The form sits at the top of the Portfolio section, above the
    // position cards — when Edit is tapped on a card further down the
    // page, scroll the form into view so it doesn't open off-screen
    // and look like nothing happened.
    var wrap = $('#trade-form-wrap');
    if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function closeTradeForm() {
    hide($('#trade-form-wrap'));
    hide($('#trade-error'));
    show($('#add-trade-btn'));
  }
  function openAdd() {
    $('#trade-form-title').textContent = 'Add a trade';
    $('#trade-submit').textContent = 'Add position';
    $('#tf-id').value = '';
    hide($('#trade-close-btn'));
    $('#trade-form').reset();
    tradeKind = 'put';
    aveManuallyEdited = false;
    $('#tf-contracts').value = '1';
    $('#tf-opened').value = todayISO();
    hide($('#trade-error'));
    hide($('#add-trade-btn'));
    openTradeForm();
    syncTradeForm();
  }
  function openEdit(id) {
    var all = (state.board && state.board.positions) || [];
    var p = null;
    for (var i = 0; i < all.length; i++) {
      if (String(all[i].id) === String(id)) { p = all[i]; break; }
    }
    $('#trade-form-title').textContent = 'Edit position';
    $('#trade-submit').textContent = 'Save changes';
    $('#tf-id').value = id;
    show($('#trade-close-btn'));
    aveManuallyEdited = false;
    if (p) {
      tradeKind = p.kind === 'call' ? 'call' : p.kind === 'spread' ? 'spread' : 'put';
      $('#tf-ticker').value = p.ticker || '';
      $('#tf-strike').value = p.strike != null ? p.strike : '';
      $('#tf-long-strike').value = p.longStrike != null ? p.longStrike : '';
      $('#tf-expiry').value = String(p.expiry || '').slice(0, 10);
      $('#tf-contracts').value = p.contracts || 1;
      $('#tf-premium').value = p.premiumPerShare != null ? p.premiumPerShare : '';
      $('#tf-opened').value = String(p.openedOn || todayISO()).slice(0, 10);
      $('#tf-ave').value = p.basisPerShare != null ? p.basisPerShare : '';
      $('#tf-account').value = p.account || '';
    }
    hide($('#trade-error'));
    hide($('#add-trade-btn'));
    openTradeForm();
    syncTradeForm();
    // A call with no recorded basis gets the lot cost filled in.
    if (tradeKind === 'call' && !$('#tf-ave').value) autofillAve();
  }
  $('#add-trade-btn').addEventListener('click', openAdd);
  $('#empty-add-btn').addEventListener('click', openAdd);
  $('#trade-cancel').addEventListener('click', closeTradeForm);
  // "Close" inside the edit form: drop the edit and open this position's
  // close form on its card, scrolled into view, so the close can be
  // recorded without going back to find the card.
  $('#trade-close-btn').addEventListener('click', function () {
    var id = $('#tf-id').value;
    closeTradeForm();
    var grid = $('#positions-grid');
    var form = grid ? grid.querySelector('[data-close-form="' + id + '"]') : null;
    if (form) {
      form.classList.remove('hidden');
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
  $('#empty-grade-btn').addEventListener('click', function () { showTab('analyzer'); setHash('analyzer', false); var t = $('#ticker'); if (t) t.focus(); });

  $('#trade-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var errBox = $('#trade-error');
    hide(errBox);
    var id = $('#tf-id').value;
    var ticker = $('#tf-ticker').value.trim().toUpperCase();
    if (!ticker) { errBox.textContent = 'Enter a ticker.'; show(errBox); return; }
    if (!$('#tf-strike').value || Number($('#tf-strike').value) <= 0) { errBox.textContent = 'Enter a strike.'; show(errBox); return; }
    if (tradeKind === 'spread' && (!$('#tf-long-strike').value || Number($('#tf-long-strike').value) <= 0)) { errBox.textContent = 'Enter the long strike (lower leg).'; show(errBox); return; }
    if (tradeKind === 'spread' && Number($('#tf-long-strike').value) >= Number($('#tf-strike').value)) { errBox.textContent = 'Long strike must be below the short strike.'; show(errBox); return; }
    if (!$('#tf-expiry').value) { errBox.textContent = 'Pick an expiry.'; show(errBox); return; }
    var body = {
      ticker: ticker,
      kind: tradeKind,
      account: ($('#tf-account').value || '').trim() || 'taxable',
      strike: Number($('#tf-strike').value),
      longStrike: tradeKind === 'spread' && $('#tf-long-strike').value ? Number($('#tf-long-strike').value) : null,
      expiry: $('#tf-expiry').value,
      contracts: Number($('#tf-contracts').value) || 1,
      premiumPerShare: $('#tf-premium').value ? Number($('#tf-premium').value) : null,
      openedOn: $('#tf-opened').value || todayISO(),
      basisPerShare: tradeKind === 'call' && $('#tf-ave').value ? Number($('#tf-ave').value) : null
    };
    $('#trade-submit').disabled = true;
    try {
      if (id) await api('positions/' + encodeURIComponent(id), { method: 'PATCH', body: body });
      else await api('positions', { method: 'POST', body: body });
      closeTradeForm();
      state.board = null;
      loadPortfolio();
    } catch (err) {
      errBox.textContent = err.message;
      show(errBox);
    } finally {
      $('#trade-submit').disabled = false;
    }
  });

  /* ---------- Ticker lifetime view ---------- */
  async function openTickerView(ticker) {
    showView('ticker');
    $('#ticker-body').innerHTML = '<p class="loading-line">Loading ' + esc(ticker) + '…</p>';
    try {
      var d = await api('ticker/' + encodeURIComponent(ticker));
      renderTicker(d);
    } catch (err) {
      $('#ticker-body').innerHTML = '<p class="error" style="margin-top:16px">Couldn\u2019t load ' + esc(ticker) + '. Try again in a moment.</p>';
    }
  }
  function renderTicker(d) {
    var s = d.stats || {};
    var ticker = d.ticker || '';
    var html = '<h2>' + esc(ticker) + '</h2>' +
      '<p class="hero-label">Lifetime premium collected</p>' +
      '<p class="hero-number tnum">' + money0(s.lifetimePremium) + '</p>' +
      (s.includesCombinedCallPremium
        ? '<p class="hero-foot">Includes the calls\u2019 combined premium recorded at the lot level (per-leg split not recorded).</p>' : '') +
      '<div class="stat-grid">' +
      statTile('Realized P&L', s.realizedPnl == null ? '—' : signedMoney0(s.realizedPnl),
        s.realizedPnl == null ? '' : (s.realizedPnl >= 0 ? 'good' : 'bad')) +
      statTile('Open now', String(s.openCount != null ? s.openCount : 0)) +
      statTile('Trades', String(s.tradeCount != null ? s.tradeCount : 0)) +
      statTile('Assignments', String(s.assignments != null ? s.assignments : 0)) +
      statTile('Called away', String(s.callAways != null ? s.callAways : 0)) +
      '</div>' +
      '<p class="detail-note">Realized P&amp;L on called-away shares includes the share gain or loss against your cost.</p>';
    if (d.lot) {
      var lot = d.lot;
      html += '<div class="card" style="margin-top:16px"><p style="font-size:16px;font-weight:600">' +
        esc(String(lot.shares)) + ' shares · ' + esc(lot.account || '') + '</p>' +
        '<div class="stat-grid" style="margin-top:8px">' +
        statTile('Your cost (AVE)', money(lot.avgCost)) +
        statTile('Spot', money(lot.spot)) +
        statTile('Unrealized', lot.unrealizedPnl == null ? '—' : signedMoney0(lot.unrealizedPnl),
          lot.unrealizedPnl == null ? '' : (lot.unrealizedPnl >= 0 ? 'good' : 'bad')) +
        '</div>' +
        (lot.note ? '<p class="pos-note">' + esc(lot.note) + '</p>' : '') + '</div>';
    }
    html += '<h3>Every trade</h3>';
    var trades = d.trades || [];
    if (!trades.length) {
      html += '<p class="muted" style="margin-top:12px">No trades recorded for this ticker yet.</p>';
    } else {
      html += '<ul class="list-shell">' + trades.map(function (tr) {
        var strikeText = tr.longStrike != null
          ? money(tr.strike) + '/' + money(tr.longStrike) + ' ' + (tr.kind === 'spread' ? 'put spread' : tr.kind)
          : money(tr.strike) + ' ' + (tr.kind === 'call' ? 'call' : 'put');
        var sub = statusLabel(tr.status) +
          (tr.openedOn ? ' · sold ' + fmtDate(tr.openedOn) : '') +
          (tr.closedOn ? ' · closed ' + fmtDate(tr.closedOn) : '');
        return '<li class="trade-line"><div class="trade-top"><div>' +
          '<span class="row-title tnum"><span class="strike-strong">' + strikeText + '</span></span>' +
          '<span class="row-sub" style="margin-left:8px">×' + esc(String(tr.contracts)) + ' · exp ' + esc(fmtDate(tr.expiry)) +
          (tr.account ? ' · ' + esc(tr.account) : '') + '</span>' +
          '<span class="row-sub" style="display:block;text-transform:capitalize">' + esc(sub) + '</span>' +
          (tr.note ? '<p class="trade-note">' + esc(tr.note) + '</p>' : '') +
          '</div><div style="text-align:right"><div class="row-value tnum">' + money0(tr.premiumTotal) + '</div>' +
          '<div class="row-sub tnum">' + (tr.premiumPerShare != null ? money(tr.premiumPerShare) + '/sh in' : 'premium not recorded') + '</div>' +
          (tr.realized != null ? '<div class="row-value tnum ' + (tr.realized >= 0 ? 'good' : 'bad') + '" style="font-size:14px;font-weight:600">' + signedMoney0(tr.realized) + ' realized</div>' : '') +
          (tr.status === 'open' ? '<button class="btn btn-outline btn-sm trade-edit-btn" type="button" data-id="' + esc(String(tr.id)) + '" style="margin-top:8px">Edit</button>' : '') +
          '</div></div></li>';
      }).join('') + '</ul>';
    }
    $('#ticker-body').innerHTML = html;
    // Edit on an open trade: jump back to the Portfolio tab and open the
    // edit form for that position (the form lives in the Portfolio view).
    $all('#ticker-body .trade-edit-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        showView('main');
        showTab('portfolio');
        openEdit(b.dataset.id);
      });
    });
  }

  /* ---------- Board ---------- */
  function renderBoard(data) {
    state.elite = data;
    var rows = data.rows || [];
    var counts = data.counts || { TECH: 0, ANCHOR: 0, DIVERSE: 0 };
    var sellPuts = data.sellPutsByBloc || { TECH: 0, ANCHOR: 0, DIVERSE: 0 };
    var bal = $('#board-balance');
    show(bal);
    $('#balance-line1').textContent = 'Balance: ' + counts.TECH + ' TECH · ' + counts.ANCHOR + ' ANCHOR · ' + counts.DIVERSE + ' DIVERSE';
    $('#balance-line2').textContent = 'Ready to sell puts now: ' + sellPuts.TECH + ' TECH · ' + sellPuts.ANCHOR + ' ANCHOR · ' + sellPuts.DIVERSE + ' DIVERSE';
    var qAsOf = fmtAsOf(data.quotesAsOf);
    $('#balance-quotes').textContent = qAsOf
      ? 'Prices as of ' + qAsOf + ' ET · Option marks are delayed quotes'
      : 'Option marks are delayed quotes';
    var blocs = [
      { key: 'TECH', name: 'AI engines + mega platforms' },
      { key: 'ANCHOR', name: 'Steady anchors' },
      { key: 'DIVERSE', name: 'Real-asset diversifiers' }
    ];
    $('#board-sections').innerHTML = blocs.map(function (bloc) {
      var list = rows.filter(function (r) { return (r.bloc || '').toUpperCase() === bloc.key; })
        .sort(function (a, b) {
          var da = a.discountPct == null ? -1 : a.discountPct;
          var db = b.discountPct == null ? -1 : b.discountPct;
          return db - da;
        });
      return '<section class="bloc-section"><h2 class="bloc-head"><span class="bloc-pill ' + bloc.key.toLowerCase() + '">' + bloc.key + '</span>' +
        esc(bloc.name) + '<span class="count">' + list.length + ' names · deepest discount first</span></h2>' +
        '<ul class="board-list">' + list.map(function (r) { return boardRowHtml(r); }).join('') + '</ul></section>';
    }).join('');
    $all('#board-sections .board-row').forEach(function (b) {
      b.addEventListener('click', function () { openTickerView(b.dataset.ticker); });
    });
  }
  function boardRowHtml(r) {
    var t = r.ticker || '?';
    var bloc = (r.bloc || '').toUpperCase();
    var price = r.spot;
    var chg = r.changePercent;
    var disc = r.discountPct;
    var csp = r.cspAction || '–';
    var cc = r.ccAction || '–';
    var cspClass = { 'SELL PUTS': 'action-sellputs', 'HOLD': 'action-hold', 'WATCH': 'action-watch', 'AVOID': 'action-avoid' }[csp] || 'action-hold';
    var ccClass = { 'SELL CALLS': 'action-sellcalls', 'LOW PREMIUM': 'action-lowprem', 'HOLD': 'action-hold' }[cc];
    var rentDetail = '';
    if (r.cspRentPctMo != null || r.ccRentPctMo != null) {
      rentDetail = '<p class="rent-detail tnum">Rent is both sides at ~30Δ' +
        (r.rentExpiry ? ', exp ' + esc(fmtDate(r.rentExpiry)) : '') + ': puts ' +
        (r.cspRentPctMo != null ? Number(r.cspRentPctMo).toFixed(2) + '%' : '—') +
        ' + calls ' + (r.ccRentPctMo != null ? Number(r.ccRentPctMo).toFixed(2) + '%' : '—') + '</p>';
    }
    return '<li><button class="board-row" type="button" data-ticker="' + esc(t) + '">' +
      '<div class="board-top"><div><span class="board-ticker">' + esc(t) + '</span> ' +
      '<span class="bloc-pill ' + bloc.toLowerCase() + '">' + esc(bloc) + '</span>' +
      (r.earningsFlag && r.earningsDate ? ' <span class="earn-pill">EARNINGS ' + esc(fmtDate(r.earningsDate)) + '</span>' : '') +
      '</div><div><div class="board-price tnum">' + (price == null ? '—' : money(price)) + '</div>' +
      '<div class="board-change tnum ' + (chg == null ? 'none' : (chg >= 0 ? 'up' : 'down')) + '">' +
      (chg == null ? 'no quote yet' : (chg >= 0 ? '+' : '') + Number(chg).toFixed(2) + '% today') + '</div></div></div>' +
      '<div class="stat-grid four tnum">' +
      statTile('1-yr high', money(r.week52High)) +
      statTile('Discount', disc == null ? '—' : Number(disc).toFixed(1) + '%') +
      statTile('Rent /mo', r.rentPctMo == null ? '—' : Number(r.rentPctMo).toFixed(2) + '%') +
      statTile('Your cost', r.avgCost == null ? '—' : money(r.avgCost)) +
      '</div>' + rentDetail +
      '<div class="board-actions"><span class="act-label">Puts</span>' +
      '<span class="action-pill ' + cspClass + '">' + esc(csp) + '</span>' +
      '<span class="act-label">Calls</span>' +
      (cc === '–' ? '<span class="action-none">– (no shares held)</span>' : '<span class="action-pill ' + (ccClass || 'action-hold') + '">' + esc(cc) + '</span>') +
      '<span class="board-chevron">›</span></div></button></li>';
  }
  async function loadBoard() {
    hide($('#board-error'));
    show($('#board-loading'));
    try {
      var data = await api('elite-board');
      hide($('#board-loading'));
      renderBoard(data);
    } catch (err) {
      hide($('#board-loading'));
      var box = $('#board-error');
      box.textContent = 'The board didn\u2019t load — try Refresh in a moment.';
      show(box);
    }
  }
  $('#board-refresh-btn').addEventListener('click', loadBoard);

  /* ---------- Refresh (live quotes on open + button) ---------- */
  async function refreshAll() {
    try { await api('refresh', { method: 'POST', body: {} }); } catch (e) { /* refresh is best-effort */ }
    state.board = null; state.elite = null;
    loadPortfolio();
    loadBoard();
  }
  $('#portfolio-refresh-btn').addEventListener('click', refreshAll);

  // Live quotes on open: load portfolio + board immediately.
  loadPortfolio();
  loadBoard();
})();











