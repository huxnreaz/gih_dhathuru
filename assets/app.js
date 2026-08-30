/* GIH - Outlets Cover Report
 *
 * Web version of the "GIH Report" workbook.
 *   Sheet1 / table "Comments"  ->  the Guest In House list (state.data)
 *   the eight outlet sheets    ->  cover sheets where staff type Room No + Table #
 *                                  and the guest details are looked up (XLOOKUP)
 *
 * The package summary reproduces the workbook's SUMIF block and the derived
 * DINNER PKG / GIH FOOD / GIH BEV / AI / PAI / SAI / FB / HB / BB / ENT / TOTAL
 * lines cell-for-cell. Which outlets exist, which package buckets are counted
 * and what each derived line sums all come from the Control Panel - see
 * assets/config.js.
 */
(function () {
  'use strict';

  var STORE_KEY = 'gih-web:v1';

  // Everything below used to be a constant here. It now comes from the Control
  // Panel via GihConfig, so outlets, package buckets and the covers breakdown
  // can be changed without a code edit.
  function conf() { return window.GihConfig.get(); }

  function outletNames() { return window.GihConfig.outletNames(); }

  function packages() { return conf().packages; }

  // Covers-breakdown lines with bucket names resolved to package indexes.
  function may(right) { return window.GihApi.may(right); }

  // Outlets that pull their rooms from other sheets rather than being typed
  // into. In the workbook that is a TOCOL/VSTACK; here it is a compiled view.
  function rollupSources(name) {
    var spec = null;
    conf().outlets.forEach(function (o) { if (o.name === name) spec = o; });
    if (!spec || !spec.rollupFrom || !spec.rollupFrom.length) return null;
    var live = outletNames();
    return spec.rollupFrom.filter(function (s) { return live.indexOf(s) !== -1; });
  }

  function derivedLines() {
    var buckets = packages();
    return window.GihConfig.breakdown().map(function (d) {
      return {
        label: window.GihConfig.serviceLabel(d.label, d.serviceLine),
        gapBefore: d.gapBefore || 0,
        adultsOnly: !!d.adultsOnly,
        plain: !!d.plain,
        total: !!d.total,
        rows: (d.buckets || []).map(function (n) { return buckets.indexOf(n); })
          .filter(function (i) { return i !== -1; })
      };
    });
  }

  /* ---------------------------------------------------------------- state */

  var state = {
    data: [],           // GIH records
    source: 'seed data',
    bizDate: todayIso(),
    outlets: {},        // outlet name -> [{room, table}]
    active: 'IMPORT',

    lastImport: null,   // {kind, file, report} for the import pane
    rawSheets: null     // last Opera workbook, kept so the toggle can reconvert
  };

  var index = {};       // room -> record (first match, as XLOOKUP does)
  var dupRooms = {};    // rooms appearing more than once in the GIH list

  function todayIso() {
    var d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      var saved = JSON.parse(raw);
      if (!saved || !Array.isArray(saved.data) || !saved.data.length) return false;
      state.data = saved.data;
      state.source = saved.source || 'saved data';
      state.outlets = saved.outlets || {};
      state.bizDate = saved.bizDate || todayIso();

      state.lastImport = saved.lastImport || null;
      state.dhathuru = saved.dhathuru || { moves: [], celebrations: [], hosts: [], note: '' };
      return true;
    } catch (e) { return false; }
  }

  function save() {
    try {
      // rawSheets is deliberately not saved - it is the whole Opera file again.
      // Written even when online, so a server that goes down mid-service leaves
      // this station with the seating it already had.
      localStorage.setItem(STORE_KEY, JSON.stringify({
        data: state.data, source: state.source,
        outlets: state.outlets, bizDate: state.bizDate,
        lastImport: state.lastImport, dhathuru: state.dhathuru
      }));
    } catch (e) { toast('Could not save locally: ' + e.message, true); }

    if (window.GihApi.isOnline()) pushOutlets();
  }

  /* --------------------------------------------------------------- server */

  var remote = {
    outletRevisions: {},   // outlet -> the revision the server last accepted
    sent: {},              // outlet -> what we last got it to accept, serialised
    dayRevision: 0,
    settingsRevision: 0,
    dayExists: false,
    seededFrom: null,
    pushing: false,
    pending: false,
    pollTimer: null
  };

  function station() {
    try { return localStorage.getItem('gih-web:station') || ''; }
    catch (e) { return ''; }
  }

  function setStation(name) {
    try { localStorage.setItem('gih-web:station', name); } catch (e) {}
  }

  // Sends the outlets whose seating differs from what the server last accepted.
  // Serialised, one at a time, so a burst of edits cannot interleave.
  function pushOutlets() {
    if (remote.pushing) { remote.pending = true; return; }

    var changed = Object.keys(state.outlets).filter(function (name) {
      var rows = state.outlets[name] || [];
      // An outlet the server has never heard of and that nobody has seated is
      // not a change - otherwise every station announces all eight on startup.
      if (remote.sent[name] === undefined && !rows.length) return false;
      return JSON.stringify(rows) !== remote.sent[name];
    });
    if (!changed.length) return;

    remote.pushing = true;
    var date = state.bizDate;

    var next = function (i) {
      if (i >= changed.length) {
        remote.pushing = false;
        if (remote.pending) { remote.pending = false; pushOutlets(); }
        return;
      }
      var name = changed[i];
      var rows = (state.outlets[name] || []).slice();
      var base = remote.outletRevisions[name] || 0;

      window.GihApi.putOutlet(date, name, rows, base, station()).then(function (res) {
        if (res.ok) {
          remote.outletRevisions[name] = res.body.outletRevision;
          remote.sent[name] = JSON.stringify(rows);
          remote.dayRevision = res.body.revision;
        } else if (res.status === 409) {
          // Another station got there first. Theirs is what everyone else can
          // see, so take it rather than quietly overwriting their work.
          state.outlets[name] = res.body.rows || [];
          remote.outletRevisions[name] = res.body.outletRevision;
          remote.sent[name] = JSON.stringify(state.outlets[name]);
          remote.dayRevision = res.body.revision;
          toast(res.error + ' Their seating is now shown.', true);
          render();
        } else if (!res.offline) {
          toast('Could not save ' + name + ': ' + res.error, true);
        }
        next(i + 1);
      });
    };

    next(0);
  }

  // Takes a day document from the server and makes it the local state.
  function adoptDay(day, exists) {
    remote.outletRevisions = (day && day.outletRevisions) || {};
    remote.dayRevision = (day && day.revision) || 0;
    remote.dayExists = !!exists;
    remote.seededFrom = (day && day.seededFrom) || null;
    remote.sent = {};

    var outlets = (day && day.outlets) || {};
    Object.keys(outlets).forEach(function (name) {
      remote.sent[name] = JSON.stringify(outlets[name] || []);
    });

    state.outlets = JSON.parse(JSON.stringify(outlets));
    state.lastImport = (day && day.lastImport) || null;
    state.dhathuru = (day && day.dhathuru) ||
      { moves: [], celebrations: [], hosts: [], note: '' };
    setData((day && day.data) || [], (day && day.source) || 'nothing uploaded yet');
  }

  function loadDay(date, thenRender) {
    return window.GihApi.getDay(date).then(function (res) {
      if (!res.ok) {
        if (!res.offline) toast('Could not load ' + date + ': ' + res.error, true);
        return false;
      }
      adoptDay(res.body.day, res.body.exists);
      state.bizDate = date;
      saveLocalOnly();
      if (thenRender !== false) render();
      return true;
    });
  }

  // The local cache write, without the server push - used when the state we are
  // storing came from the server in the first place.
  function saveLocalOnly() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        data: state.data, source: state.source,
        outlets: state.outlets, bizDate: state.bizDate,
        lastImport: state.lastImport, dhathuru: state.dhathuru
      }));
    } catch (e) {}
  }

  // Polls for other stations' changes. Cheap: one small GET, and a refetch only
  // when a revision actually moved.
  function startPolling() {
    if (remote.pollTimer) clearInterval(remote.pollTimer);
    remote.pollTimer = setInterval(function () {
      if (document.hidden) return;
      window.GihApi.pulse(state.bizDate).then(function (res) {
        if (!res.ok) return;
        var body = res.body;

        if (body.settingsRevision !== remote.settingsRevision) {
          remote.settingsRevision = body.settingsRevision;
          window.GihApi.getSettings().then(function (s) {
            if (!s.ok) return;
            window.GihConfig.adopt(s.body.settings);
            render();
            toast('Settings updated by an admin.');
          });
        }

        if (body.dayRevision !== remote.dayRevision && !remote.pushing) {
          loadDay(state.bizDate);
        }
      });
    }, 6000);
  }

  /* Meal plan overrides driven by the Comment text.
   *
   * The reservation comment usually spells the real arrangement out - a room
   * carrying "COMP/1RO/1TRRT - Meals in Staff Canteen" is a COMP cover whatever
   * the MealPlan column says. Rules are tried in order and the first match wins.
   *
   * Every record keeps the plan it arrived with in `_sourcePlan`, so rules can
   * be edited or switched off and the original plan comes straight back - no
   * re-import, and running this twice never compounds.
   */
  /* Turns one rule's `contains` text into a test over a comment.
   *
   * `*` and `?` are wildcards, because the package quantity moves: COMP/1FB one
   * day and COMP/4FB the next, so the rule that catches both is `COMP/*FB`.
   *   *  any run of characters, spaces excluded
   *   ?  exactly one character, spaces excluded
   * Holding the wildcards inside a single word is what keeps `COMP/*FB` meaning
   * "one COMP/…FB token" rather than "COMP/ somewhere, then FB much later".
   * Text with neither wildcard stays a plain substring match.
   */
  function ruleMatcher(rule) {
    var needle = String(rule.contains || '').trim();
    if (!needle) return null;

    if (needle.indexOf('*') === -1 && needle.indexOf('?') === -1) {
      var plain = rule.caseSensitive ? needle : needle.toLowerCase();
      return function (text) {
        return (rule.caseSensitive ? text : text.toLowerCase()).indexOf(plain) !== -1;
      };
    }

    // Split on the wildcards first so the literal parts can be escaped without
    // the escaping and the un-escaping tripping over each other.
    var pattern = needle.split(/([*?])/).map(function (part) {
      if (part === '*') return '\\S*';
      if (part === '?') return '\\S';
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');

    var re;
    try {
      re = new RegExp(pattern, rule.caseSensitive ? '' : 'i');
    } catch (e) {
      return null;
    }
    return function (text) { return re.test(text); };
  }

  function compileRules(rules) {
    return (rules || []).map(function (rule) {
      return { rule: rule, test: ruleMatcher(rule) };
    });
  }

  // Index of the first rule that claims this record, or -1.
  function firstRuleFor(compiled, rec) {
    for (var i = 0; i < compiled.length; i++) {
      var c = compiled[i];
      if (!c.test) continue;
      if (c.rule.onlyIfBlank && rec._sourcePlan) continue;
      if (c.test(String(rec.comment || ''))) return i;
    }
    return -1;
  }

  function applyCommentRules(rows) {
    var compiled = compileRules(conf().commentRules);
    var hits = 0;

    rows.forEach(function (r) {
      if (r._sourcePlan === undefined) r._sourcePlan = r.meal || '';
      var base = r._sourcePlan;
      var at = firstRuleFor(compiled, r);
      var next = at === -1 ? base : String(compiled[at].rule.plan || '').trim().toUpperCase();

      r.meal = next;
      if (next !== base) hits++;
    });

    return hits;
  }

  function setData(rows, label) {
    state.data = rows;
    state.source = label;
    state.commentOverrides = applyCommentRules(state.data);
    buildIndex();
    outletNames().forEach(function (o) { if (!state.outlets[o]) state.outlets[o] = []; });
  }

  function buildIndex() {
    index = {};
    dupRooms = {};
    state.data.forEach(function (r) {
      var k = String(r.room).trim();
      if (index[k]) dupRooms[k] = true; else index[k] = r;
    });
  }

  function lookup(room) {
    return index[String(room == null ? '' : room).trim()] || null;
  }

  /* ------------------------------------------------------------- calendar */

  function inHouse(rec, date) {
    if (!rec) return false;
    if (!rec.arrival || !rec.departure) return true;   // undated rows always show
    return rec.arrival <= date && date <= rec.departure;
  }

  function houseList(date) {
    return state.data.filter(function (r) { return inHouse(r, date); });
  }

  // Flags drive the row colour, in the workbook's conditional-format priority.
  function flags(rec, date) {
    if (!rec) return { missing: true };
    return {
      dep: !!rec.departure && rec.departure === date,
      rem: !!(rec.remarks && String(rec.remarks).trim()),
      arr: !!rec.arrival && rec.arrival === date
    };
  }

  function rowClass(rec, date, i) {
    var f = flags(rec, date);
    if (f.missing) return 'missing';
    if (f.dep) return 'dep';
    if (f.rem) return 'rem';
    if (f.arr) return 'arr';
    return i % 2 ? 'band' : '';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var p = iso.split('-');
    if (p.length !== 3) return iso;
    return p[2] + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][parseInt(p[1], 10) - 1];
  }

  /* -------------------------------------------------------------- summary */

  // Mirrors SUMIF($E$2:$E$100,$E103,$F$2:$F$100) over the rows placed here.
  function summarise(rows, date) {
    var adults = [], kids = [];
    packages().forEach(function () { adults.push(0); kids.push(0); });

    rows.forEach(function (row) {
      var rec = lookup(row.room);
      if (!rec) return;
      var i = packages().indexOf(String(rec.meal || '').trim().toUpperCase());
      if (i === -1) return;
      adults[i] += rec.adults || 0;
      kids[i] += rec.child || 0;
    });

    function sum(arr, idxs) {
      return idxs.reduce(function (t, i) { return t + arr[i]; }, 0);
    }

    // gapBefore becomes real spacer entries, so the panel and the CSV lay the
    // block out the same way the generated workbook does.
    var derived = [];
    derivedLines().forEach(function (d) {
      for (var g = 0; g < d.gapBefore; g++) derived.push({ gap: true });
      derived.push({
        label: d.label,
        adults: sum(adults, d.rows),
        kids: d.adultsOnly ? null : sum(kids, d.rows),
        blank: !d.plain, plain: d.plain, total: d.total
      });
    });

    return {
      adults: adults, kids: kids, derived: derived,
      totalAdults: sum(adults, adults.map(function (_, i) { return i; })),
      totalKids: sum(kids, kids.map(function (_, i) { return i; })),
      covers: rows.length,
      unknown: rows.filter(function (r) { return r.room && !lookup(r.room); }).length,
      dateLabel: fmtDate(date)
    };
  }

  /* ------------------------------------------------------------------ dom */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function $(sel, root) { return (root || document).querySelector(sel); }

  var toastTimer;
  function toast(msg, isErr) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast on' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, isErr ? 6000 : 3000);
  }

  /* --------------------------------------------------------------- render */

  function render() {
    renderTabs();
    renderStats();
    renderConnection();
    renderServiceToggle();

    var dateBox = $('#bizDate');
    dateBox.value = state.bizDate;
    dateBox.disabled = !may('bizDate');
    dateBox.title = may('bizDate') ? '' : 'You do not have rights to change the business date.';

    var resetBtn = $('#btnReset');
    resetBtn.disabled = !may('reset');
    resetBtn.title = may('reset')
      ? (window.GihApi.isOnline()
        ? 'Clear every outlet for this date, on every station'
        : 'Clear the seating and go back to the seed data')
      : 'You do not have rights to reset the day.';

    var view = $('#view');
    view.innerHTML = '';
    view.appendChild(
      state.active === 'IMPORT' ? buildImportPane() :
      state.active === 'SETTINGS' ? buildSettingsPane() :
      state.active === 'MASTER' ? buildMasterPane() :
      state.active === 'DHATHURU' ? buildDhathuruPane() :
      state.active === 'GIH' ? buildGihPane() :
      buildOutletPane(state.active)
    );
  }

  // Highlight colours are set from the Control Panel, so the on-screen rows and
  // the generated workbook always agree.
  function applyTheme() {
    var hl = conf().highlight;
    var root = document.documentElement;
    root.style.setProperty('--dep', hl.dep);
    root.style.setProperty('--arr', hl.arr);
    root.style.setProperty('--rem', hl.rem);
    root.style.setProperty('--band', hl.band);
    root.style.setProperty('--miss', hl.miss);
    var prop = conf().property;
    $('#appTitle').textContent = prop.reportTitle || 'Outlets Cover Report';
    $('#appMark').textContent = prop.name || 'GIH';
    document.title = (prop.name ? prop.name + ' — ' : '') +
      (prop.reportTitle || 'Outlets Cover Report');
    renderServiceToggle();
  }

  // Lunch and Dinner are worked one after the other, so the switch belongs on
  // the page rather than three clicks into the Control Panel.
  function renderServiceToggle() {
    var box = $('#serviceToggle');
    if (!box) return;
    box.innerHTML = '';

    var current = window.GihConfig.service();
    var allowed = may('service');

    window.GihConfig.SERVICES.forEach(function (option) {
      var b = el('button', 'svc-btn' + (option === current ? ' on' : ''),
        option.charAt(0) + option.slice(1).toLowerCase());
      b.type = 'button';
      b.disabled = !allowed;
      b.title = allowed
        ? 'Cover sheets and the breakdown switch to ' + option.toLowerCase()
        : 'You do not have rights to switch service.';
      b.onclick = function () {
        if (option === window.GihConfig.service()) return;
        var next = JSON.parse(window.GihConfig.toJson());
        next.service = option;
        window.GihConfig.save(next);
        render();
        toast('Switched to ' + option.toLowerCase() + ' service.');
      };
      box.appendChild(b);
    });
  }

  /* The uploaded Opera report, whole: every room it carried and the pax on them.
   *
   * Not the rooms in house on the business date. Those two are different numbers
   * and the tiles do not say which they are, so they show what was uploaded -
   * the same figures the Import & Template tab reports after a conversion. */
  function renderStats() {
    $('#statRooms').textContent = state.data.length;
    $('#statAdults').textContent =
      state.data.reduce(function (t, r) { return t + (r.adults || 0); }, 0);
    $('#statKids').textContent =
      state.data.reduce(function (t, r) { return t + (r.child || 0); }, 0);
  }

  // The Import tab can be put away for staff; an admin keeps it so there is
  // always a way back to the toggle - and to the upload.
  function showImportTab() {
    return conf().ui.importTab !== false || canEditGih();
  }

  // Which outlets the Master tab compiles. Empty means all of them, and a name
  // that no longer exists is simply skipped.
  function masterSources() {
    var chosen = (conf().master && conf().master.sources) || [];
    var live = outletNames();
    if (!chosen.length) return live;
    var kept = chosen.filter(function (n) { return live.indexOf(n) !== -1; });
    return kept.length ? kept : live;
  }

  function compiledRows(sources) {
    var out = [];
    (sources || outletNames()).forEach(function (outlet) {
      (state.outlets[outlet] || []).forEach(function (row) {
        out.push({ outlet: outlet, room: row.room, table: row.table || '' });
      });
    });
    return out;
  }

  function masterRows() { return compiledRows(masterSources()); }

  // The tab badge: what the sheet holds, or what the guest list would give it.
  function dhathuruCount() {
    var d = state.dhathuru || {};
    var wel = (d.welcome || []).length ||
      state.data.filter(function (r) { return r.arrival === state.bizDate; }).length;
    var far = (d.farewell || []).length ||
      state.data.filter(function (r) { return r.departure === state.bizDate; }).length;
    return wel + far;
  }

  function renderTabs() {
    var nav = $('#tabs');
    nav.innerHTML = '';
    var hidden = window.GihApi.hiddenTabs();
    var tabs = (showImportTab() ? ['IMPORT'] : [])
      .concat(['GIH'])
      .concat(outletNames())
      .concat(['MASTER', 'DHATHURU', 'SETTINGS'])
      .filter(function (name) { return hidden.indexOf(name) === -1; });

    // Hiding every tab would leave nothing to look at.
    if (!tabs.length) tabs = ['GIH'];

    tabs.forEach(function (name) {
      var b = el('button', 'tab' + (state.active === name ? ' active' : '') +
        (name === 'SETTINGS' ? ' tab-settings' : '') +
        (name === 'MASTER' ? ' tab-master' : ''));
      var label = name === 'IMPORT' ? 'Import & Template'
        : name === 'SETTINGS' ? '⚙ Control Panel'
        : name === 'MASTER' ? 'Master'
        : name === 'DHATHURU' ? 'Dhathuru'
        : name === 'GIH' ? 'Guest In House' : name;
      b.appendChild(document.createTextNode(label));

      if (name !== 'IMPORT' && name !== 'SETTINGS') {
        var n = name === 'GIH' ? state.data.length
          : name === 'MASTER' ? masterRows().length
          : name === 'DHATHURU' ? dhathuruCount()
          : (state.outlets[name] || []).length;
        b.appendChild(el('span', 'badge' + (n ? '' : ' zero'), n));
      }
      b.onclick = function () { state.active = name; render(); };
      nav.appendChild(b);
    });

    // The active tab may have just been hidden or removed under us.
    if (tabs.indexOf(state.active) === -1) state.active = 'GIH';
  }

  /* ------------------------------------------------------------- gih pane */

  var gihFilter = { q: '', plan: '', status: '', cols: {} };

  // What a per-column "contains" filter is matched against. Dates match either
  // the ISO value or the "21 Aug" the cell actually shows, so both read right.
  function columnText(rec, col) {
    if (col === 'arrival' || col === 'departure') {
      return (rec[col] || '') + ' ' + fmtDate(rec[col]);
    }
    return rec[col] == null ? '' : String(rec[col]);
  }

  function activeColFilters() {
    return Object.keys(gihFilter.cols).filter(function (c) {
      return gihFilter.cols[c].trim() !== '';
    });
  }

  function matchesFilters(rec, date) {
    if (gihFilter.plan && String(rec.meal || '').toUpperCase() !== gihFilter.plan) return false;
    switch (gihFilter.status) {
      case 'inhouse': if (!inHouse(rec, date)) return false; break;
      case 'arr': if (rec.arrival !== date) return false; break;
      case 'dep': if (rec.departure !== date) return false; break;
      case 'rem': if (!(rec.remarks && String(rec.remarks).trim())) return false; break;
      // dupRooms is built by buildIndex and holds every room the list names
      // more than once. Showing them together is how you check a second line
      // is meant, since only the first is ever looked up.
      case 'dup': if (!dupRooms[String(rec.room).trim()]) return false; break;
    }

    // Every column filter has to match - they narrow, they do not widen.
    var cols = activeColFilters();
    for (var i = 0; i < cols.length; i++) {
      var needle = gihFilter.cols[cols[i]].trim().toLowerCase();
      if (columnText(rec, cols[i]).toLowerCase().indexOf(needle) === -1) return false;
    }

    var q = gihFilter.q.trim().toLowerCase();
    if (!q) return true;
    return [rec.room, rec.guest, rec.comment, rec.remarks, rec.meal]
      .join(' ').toLowerCase().indexOf(q) !== -1;
  }

  function filteredGihRows() {
    var date = state.bizDate;
    return state.data.filter(function (r) { return matchesFilters(r, date); });
  }

  function buildGihPane() {
    var pane = document.getElementById('tpl-gih').content.cloneNode(true);
    var search = $('#gihSearch', pane);
    var plan = $('#gihPlan', pane);
    var status = $('#gihStatus', pane);
    var clear = $('#gihClear', pane);
    var colInputs = Array.prototype.slice.call(
      pane.querySelectorAll('#gihColFilters input'));

    var plans = [];
    state.data.forEach(function (r) {
      var m = String(r.meal || '').trim().toUpperCase();
      if (m && plans.indexOf(m) === -1) plans.push(m);
    });
    plans.sort().forEach(function (p) {
      var o = el('option', null, p);
      o.value = p;
      plan.appendChild(o);
    });

    search.value = gihFilter.q;
    plan.value = gihFilter.plan;
    status.value = gihFilter.status;

    $('.pane-head h1', pane).setAttribute('data-print-date', fmtDate(state.bizDate));

    var tbody = $('#gihTable tbody', pane);
    var count = $('#gihCount', pane);
    // Read now, not in paint(): appending the fragment empties it, so a lookup
    // through `pane` later finds nothing.
    var columns = $('#gihTable thead tr', pane).children.length;

    colInputs.forEach(function (i) {
      var col = i.getAttribute('data-col');
      i.value = gihFilter.cols[col] || '';
      i.title = 'Show only rows whose ' + i.getAttribute('aria-label').replace('Filter ', '') +
        ' contains this text';
    });

    function paint() {
      var date = state.bizDate;
      var rows = filteredGihRows();

      tbody.innerHTML = '';
      if (!rows.length) {
        var tr = el('tr');
        var td = el('td', 'empty', 'No rooms match this filter.');
        td.colSpan = columns;
        tr.appendChild(td);
        tbody.appendChild(tr);
      } else {
        rows.forEach(function (r, i) { tbody.appendChild(gihRow(r, date, i)); });
      }

      colInputs.forEach(function (i) {
        i.classList.toggle('on', (gihFilter.cols[i.getAttribute('data-col')] || '').trim() !== '');
      });

      var narrowed = gihFilter.q || gihFilter.plan || gihFilter.status || activeColFilters().length;
      clear.hidden = !narrowed;
      count.textContent = rows.length + ' of ' + state.data.length + ' rooms' +
        (narrowed ? ' — filtered' : '');
    }

    search.oninput = function () { gihFilter.q = this.value; paint(); };
    plan.onchange = function () { gihFilter.plan = this.value; paint(); };
    status.onchange = function () { gihFilter.status = this.value; paint(); };

    colInputs.forEach(function (i) {
      i.oninput = function () {
        gihFilter.cols[i.getAttribute('data-col')] = this.value;
        paint();
      };
    });

    clear.onclick = function () {
      gihFilter = { q: '', plan: '', status: '', cols: {} };
      search.value = '';
      plan.value = '';
      status.value = '';
      colInputs.forEach(function (i) { i.value = ''; });
      paint();
    };

    $('#gihExport', pane).onclick = function () { exportGihCsv(); };

    /* ---- putting lines on the list ---- */

    var addBtn = $('#gihAdd', pane);
    var fromDha = $('#gihFromDha', pane);

    // Add makes a blank line that then has to be typed into, so on its own it
    // would be a dead end - it needs the right that makes cells editable too.
    // Add from Today's Welcome brings finished lines over and needs neither.
    addBtn.hidden = !(may('gihAdd') && canEditGih());
    fromDha.hidden = !may('gihWelcome');

    addBtn.title = 'Add a blank line, arriving today';
    addBtn.onclick = function () {
      // A blank line matches no filter, so adding one under a live filter
      // would look like nothing had happened.
      gihFilter = { q: '', plan: '', status: '', cols: {} };
      state.data.push(blankGihRow());
      commitGihList();            // rebuilds the pane; the locals here are gone
      focusLastGihRow();
    };

    fromDha.title = 'Bring Today\u2019s Welcome across from the Dhathuru tab';
    fromDha.onclick = function () {
      var welcome = (state.dhathuru && state.dhathuru.welcome) || [];
      if (!welcome.length) {
        toast('Today\u2019s Welcome is empty \u2014 upload or fill in the Dhathuru first.', true);
        return;
      }

      var made = welcome.map(gihFromWelcome).filter(function (r) { return r.room; });
      if (!made.length) { toast('No line on Today\u2019s Welcome has a room number.', true); return; }

      var res = addGihRows(made);
      var full = res.skipped.length + ' room(s) already have ' + GIH_ROOM_LIMIT + ' lines';
      if (!res.added.length) {
        toast('Nothing added \u2014 ' + full + '.', true);
        return;
      }
      toast('Added ' + res.added.length + ' from Today\u2019s Welcome' +
        (res.skipped.length ? ' \u2014 ' + full : '') + '.');
    };

    paint();
    return pane;
  }

  /* Puts the cursor in the Room cell of the line just added. render() has
   * replaced the pane by now, so this looks the new one up rather than
   * holding a reference into the old one. */
  function focusLastGihRow() {
    var rows = document.querySelectorAll('#gihTable tbody tr');
    var last = rows[rows.length - 1];
    if (!last) return;
    last.scrollIntoView({ block: 'center' });
    var cell = last.querySelector('.c-room .cell-edit');
    if (cell) cell.focus();
  }

  // Offline there is nobody to be, so the browser has the run of its own copy.
  // Online, correcting the guest list is an admin job - it is what everyone else
  // is looking at.
  function canEditGih() { return may('guestList'); }

  // Whether this station may send the list up at all. The list travels whole,
  // so putting a line on it and correcting one take the same route, and any of
  // the three rights is enough to use it.
  function canWriteGihList() {
    return may('guestList') || may('gihAdd') || may('gihWelcome');
  }

  /* Builds one editable cell. `commit(value)` is called when the value settles;
   * it returns false to reject and put the old text back. */
  function editableCell(cls, value, commit, opts) {
    var td = el('td', cls + ' editable');
    var box = el('div', 'cell-edit');
    box.contentEditable = 'true';
    box.spellcheck = false;
    box.textContent = value == null ? '' : String(value);
    if (opts && opts.placeholder) box.setAttribute('data-placeholder', opts.placeholder);

    var original = box.textContent;

    box.onkeydown = function (e) {
      if (e.key === 'Escape') { box.textContent = original; box.blur(); return; }
      // Newlines matter in Guest Name and Comment; elsewhere Enter means done.
      if (e.key === 'Enter' && !(opts && opts.multiline)) { e.preventDefault(); box.blur(); }
    };

    box.onblur = function () {
      var next = box.textContent.replace(/ /g, ' ').trim();
      if (next === original) return;
      if (commit(next) === false) { box.textContent = original; return; }
      original = next;
    };

    td.appendChild(box);
    return td;
  }

  function gihRow(r, date, i) {
    var tr = el('tr', rowClass(r, date, i));
    var full = canEditGih();

    // Remarks is the column staff fill in during service, so anyone may write
    // it - signed in or not. Everything else describes the reservation and is
    // the admin's to correct.
    var editRow = function (field, value, opts) {
      return editableCell(opts.cls, value, function (next) {
        return commitGihEdit(r, field, next);
      }, opts);
    };

    if (full) tr.appendChild(editRow('room', r.room, { cls: 'c-room' }));
    else tr.appendChild(el('td', 'c-room', r.room));

    if (may('remarks')) {
      tr.appendChild(editRow('remarks', r.remarks || '',
        { cls: 'c-rem', placeholder: 'add a remark' }));
    } else {
      tr.appendChild(el('td', 'c-rem', r.remarks || ''));
    }

    if (full) {
      tr.appendChild(editRow('guest', r.guest || '', { cls: 'c-guest', multiline: true }));
      tr.appendChild(editRow('meal', r.meal || '', { cls: 'c-plan' }));
      tr.appendChild(editRow('adults', r.adults || 0, { cls: 'c-num' }));
      tr.appendChild(editRow('child', r.child || 0, { cls: 'c-num' }));
      tr.appendChild(editRow('arrival', r.arrival || '', { cls: 'c-date', placeholder: 'yyyy-mm-dd' }));
      tr.appendChild(editRow('departure', r.departure || '', { cls: 'c-date', placeholder: 'yyyy-mm-dd' }));
      tr.appendChild(editRow('comment', r.comment || '', { cls: 'c-comment', multiline: true }));
      tr.appendChild(gihDeleteCell(r));
      return tr;
    }

    var g = el('td', 'c-guest');
    g.appendChild(el('div', 'guest-lines', r.guest || ''));
    tr.appendChild(g);

    var p = el('td', 'c-plan');
    if (r.meal) p.appendChild(el('span', 'plan-tag', r.meal));
    tr.appendChild(p);

    tr.appendChild(el('td', 'c-num', r.adults || 0));
    tr.appendChild(el('td', 'c-num', r.child || 0));
    tr.appendChild(el('td', 'c-date', fmtDate(r.arrival)));
    tr.appendChild(el('td', 'c-date', fmtDate(r.departure)));

    var c = el('td', 'c-comment');
    var box = el('div', 'comment', r.comment || '');
    box.onclick = function () { this.classList.toggle('open'); };
    c.appendChild(box);
    tr.appendChild(c);
    tr.appendChild(gihDeleteCell(r));
    return tr;
  }

  /* The ✕ at the end of a row. Empty for anyone who cannot edit the list, so
   * the column lines up either way. Lines can be put on the guest list by hand
   * now, so there has to be a way to take one off again short of re-importing
   * the whole export. */
  function gihDeleteCell(rec) {
    var td = el('td', 'c-x');
    if (!canEditGih()) return td;
    var b = el('button', 'rowdel', '✕');
    b.type = 'button';
    b.title = 'Remove ' + (rec.room ? 'room ' + rec.room : 'this line') + ' from the guest list';
    b.onclick = function () { removeGihRow(rec); };
    td.appendChild(b);
    return td;
  }

  /* A room may hold two lines on the guest list, and no more.
 *
 * One room really can be occupied twice in a day - a day use that checks out
 * before the next guest arrives, or a split reservation - and the Opera
 * export flattens those into one line, so bringing the second one in by hand
 * is the only way to see it. A third line is a mistake: every lookup in the
 * workbook takes the first match, so the ones after it are never read, and
 * past two they are only noise on the sheet.
 */
  var GIH_ROOM_LIMIT = 2;

  // How many lines the list already holds for this room. `except` is the
  // record being edited, which must not count itself.
  function roomLineCount(room, except) {
    var key = String(room == null ? '' : room).trim();
    if (!key) return 0;
    var n = 0;
    state.data.forEach(function (o) {
      if (o !== except && String(o.room).trim() === key) n++;
    });
    return n;
  }

  var NUMERIC_FIELDS = { adults: true, child: true };
  var DATE_FIELDS = { arrival: true, departure: true };

  /* Applies one cell edit. Returns false when the value will not do, which puts
   * the old one back on screen. */
  function commitGihEdit(rec, field, value) {
    if (field === 'remarks' ? !may('remarks') : !canEditGih()) {
      toast('You do not have rights to change that column.', true);
      return false;
    }

    if (NUMERIC_FIELDS[field]) {
      if (value !== '' && !/^\d+$/.test(value)) {
        toast('Adults and Child must be whole numbers.', true);
        return false;
      }
      rec[field] = value === '' ? 0 : parseInt(value, 10);
    } else if (DATE_FIELDS[field]) {
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        toast('Dates go in as yyyy-mm-dd — for example 2026-08-30.', true);
        return false;
      }
      rec[field] = value;
    } else if (field === 'room') {
      if (!value) { toast('A room number cannot be blank.', true); return false; }
      if (roomLineCount(value, rec) >= GIH_ROOM_LIMIT) {
        toast('Room ' + value + ' already has ' + GIH_ROOM_LIMIT + ' lines on the list.', true);
        return false;
      }
      rec.room = value;
    } else if (field === 'meal') {
      rec.meal = value.toUpperCase();
      // A hand-set plan is a decision, not something a comment rule should undo.
      rec._sourcePlan = rec.meal;
    } else {
      rec[field] = value;
    }

    buildIndex();
    save();
    pushGihEdit(rec, field);
    render();
    return true;
  }

  var remarkQueue = {};
  var dataPushTimer = null;

  // Remarks go up one room at a time - any station may write them, and two
  // people noting different rooms must not overwrite each other. Everything
  // else is an admin edit of the list itself, sent whole but debounced.
  function pushGihEdit(rec, field) {
    if (!window.GihApi.isOnline()) return;

    if (field === 'remarks') {
      var room = String(rec.room);
      remarkQueue[room] = rec.remarks || '';
      window.GihApi.putRemarks(state.bizDate, room, remarkQueue[room], station())
        .then(function (res) {
          if (res.ok) { remote.dayRevision = res.body.revision; return; }
          if (!res.offline) toast('Remark not saved: ' + res.error, true);
        });
      return;
    }

    if (!canWriteGihList()) return;
    if (dataPushTimer) clearTimeout(dataPushTimer);
    dataPushTimer = setTimeout(function () {
      dataPushTimer = null;
      window.GihApi.putData(state.bizDate, state.data, station()).then(function (res) {
        if (res.ok) { remote.dayRevision = res.body.revision; return; }
        if (!res.offline) toast('Change not saved: ' + res.error, true);
      });
    }, 600);
  }

  /* ------------------------------------------- putting lines on the list */

  function blankGihRow() {
    return {
      room: '', remarks: '', guest: '', meal: '',
      adults: 0, child: 0,
      arrival: todayIso(), departure: '', comment: ''
    };
  }

  /* "2+1" is two adults and one child; "2" is two adults and none. The
   * Welcome table prints the pair in one cell, the guest list counts them
   * apart. Anything past the first number is taken as children, so "2+1+1" is
   * 2 and 2.
   *
   * Not splitPax: that one reads the week summary's "154/33", which is a
   * different notation for a different thing. */
  function splitWelcomePax(raw) {
    var nums = String(raw == null ? '' : raw).match(/\d+/g) || [];
    return {
      adults: nums.length ? parseInt(nums[0], 10) : 0,
      child: nums.slice(1).reduce(function (t, n) { return t + parseInt(n, 10); }, 0)
    };
  }

  /* The inverse of tidyDate: back from what a briefing sheet shows to the
   * yyyy-mm-dd the guest list keeps.
   *
   * "01 Sep" carries no year, because a Dhathuru is one day's sheet and does
   * not need one. The year comes from `near` - the business date - rolling
   * forward when that would put the date behind it, since a departure printed
   * on today's sheet is ahead of today. "05 Jan" on a December sheet is next
   * January, not last.
   */
  function isoFromLoose(raw, near) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return '';

    var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (iso) return iso[1] + '-' + pad2(+iso[2]) + '-' + pad2(+iso[3]);

    // Excel keeps a date as a count of days.
    if (/^\d+(\.\d+)?$/.test(s)) {
      var serial = parseFloat(s);
      if (serial > 20000 && serial < 90000) {
        return window.XlsxReader.serialToIso(Math.floor(serial)) || '';
      }
      return '';
    }

    // Slashed dates are month-first, as everywhere else here.
    var slash = /^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})$/.exec(s);
    if (slash) {
      var sy = +slash[3];
      if (sy < 100) sy += 2000;
      return sy + '-' + pad2(+slash[1]) + '-' + pad2(+slash[2]);
    }

    // "01 Sep", "1 Sep 2026", "1-Sep", "Sep 1".
    var dayFirst = /^\d/.test(s);
    var named = dayFirst
      ? /^(\d{1,2})\s*[-\s]\s*([a-z]{3,})\.?(?:\s*[-,\s]\s*(\d{4}))?$/i.exec(s)
      : /^([a-z]{3,})\.?\s*[-\s]\s*(\d{1,2})(?:\s*[-,\s]\s*(\d{4}))?$/i.exec(s);
    if (!named) return '';

    var day = +(dayFirst ? named[1] : named[2]);
    var word = String(dayFirst ? named[2] : named[1]).slice(0, 3).toLowerCase();
    var month = 0;
    for (var i = 0; i < MONTHS.length; i++) {
      if (MONTHS[i].toLowerCase() === word) { month = i + 1; break; }
    }
    if (!month || day < 1 || day > 31) return '';

    var year = named[3] ? +named[3] : 0;
    if (!year) {
      var anchor = /^\d{4}-\d{2}-\d{2}$/.test(String(near)) ? String(near) : todayIso();
      year = +anchor.slice(0, 4);
      if (year + '-' + pad2(month) + '-' + pad2(day) < anchor) year++;
    }
    return year + '-' + pad2(month) + '-' + pad2(day);
  }

  /* One line of Today's Welcome as the guest list keeps it.
   *
   * The two sheets do not say the same things the same way. The Dhathuru prints
   * pax as "2+1" and a departure as "01 Sep", and calls its free-text column
   * Remarks - but that is the guest list's Comment. The guest list's own
   * Remarks column is the one staff write in during service, so it starts
   * empty. Arrival is today: a line on Today's Welcome is a guest arriving
   * today, and the sheet has no column that says so.
   */
  function gihFromWelcome(row) {
    var pax = splitWelcomePax(row.pax);
    return {
      // "421 / D/U" is a room with a day-use note under it. The number on its
      // own is what every lookup in the workbook matches on.
      room: String(row.room == null ? '' : row.room).split(/[\r\n]/)[0].trim().split(/\s+/)[0],
      remarks: '',
      guest: String(row.guest == null ? '' : row.guest).trim(),
      meal: String(row.mealPlan == null ? '' : row.mealPlan).trim().toUpperCase(),
      adults: pax.adults,
      child: pax.child,
      arrival: todayIso(),
      departure: isoFromLoose(row.depDate, state.bizDate),
      comment: String(row.remarks == null ? '' : row.remarks).trim()
    };
  }

  /* Puts new lines on the guest list. A room already there gets its second
   * line, but not a third - see GIH_ROOM_LIMIT. The count is read back from
   * state.data each time round, so a Welcome table naming the same room three
   * times fills up and then stops. */
  function addGihRows(rows) {
    var added = [], skipped = [];
    rows.forEach(function (r) {
      var key = String(r.room || '').trim();
      if (key && roomLineCount(key) >= GIH_ROOM_LIMIT) {
        skipped.push(key);
        return;
      }
      state.data.push(r);
      added.push(r);
    });
    if (added.length) commitGihList();
    return { added: added, skipped: skipped };
  }

  function removeGihRow(rec) {
    if (!canEditGih()) { toast('You do not have rights to change the guest list.', true); return; }

    var room = String(rec.room || '').trim();
    var ask = 'Remove ' + (room ? 'room ' + room : 'this blank line') + ' from the guest list?';

    // A seat whose room has left the list shows as not in house and every
    // looked-up column on it comes back blank, so say so before it happens.
    var seated = room ? outletNames().filter(function (o) {
      return (state.outlets[o] || []).some(function (line) {
        return String(line.room).trim() === room;
      });
    }) : [];
    if (seated.length) {
      ask += '\n\nIt is seated on ' + seated.join(', ') +
        '. Those lines stay, but will show as not in house.';
    }
    if (!confirm(ask)) return;

    var at = state.data.indexOf(rec);
    if (at === -1) return;
    state.data.splice(at, 1);
    commitGihList();
  }

  // The list changed as a whole rather than one cell of it. Comment rules are
  // re-run because a new line brings a new comment with it.
  function commitGihList() {
    state.commentOverrides = applyCommentRules(state.data);
    buildIndex();
    save();
    pushGihEdit(null, 'data');
    render();
  }

  /* -------------------------------------------------------- dhathuru pane */

  /* The five tables of the Dhathuru sheet, defined once.
   *
   * The columns are the real sheet's, in its order. Everything else - the
   * markup, the reader that pulls these tables out of an uploaded workbook, and
   * the CSV that writes them back - is generated from this, so the three can
   * never drift apart.
   *
   * `aliases` are matched against a heading cell after lower-casing and
   * squashing runs of whitespace. `signature` names the columns that tell this
   * table apart from the others: Welcome and Farewell share nine headings, and
   * only the flight and transfer columns separate them.
   */
  var DHA_TABLES = [
    {
      key: 'welcome', label: "Today's Welcome",
      columns: [
        { f: 'room', h: 'Room', cls: 'c-room', aliases: ['room', 'room no', 'villa'] },
        { f: 'status', h: 'Status', cls: 'c-plan', aliases: ['status'] },
        { f: 'guest', h: 'Guest Name', cls: 'c-guest', wide: true, aliases: ['guest name', 'guest'] },
        { f: 'eta', h: 'ETA to Fares', cls: 'c-time', type: 'time', fillDown: true,
          aliases: ['eta to fares', 'eta to resort', 'eta to fares/resort'] },
        { f: 'depDate', h: 'Departure Date', cls: 'c-date', type: 'date',
          aliases: ['departure date', 'dep date'] },
        { f: 'pax', h: 'Pax', cls: 'c-num', aliases: ['pax', 'no of pax'] },
        { f: 'nationality', h: 'Nat', cls: 'c-num', aliases: ['nationality', 'nat'] },
        { f: 'vip', h: 'VIP', cls: 'c-num', aliases: ['vip'] },
        { f: 'mealPlan', h: 'Meal Plan', cls: 'c-plan', aliases: ['meal plan', 'mealplan'] },
        { f: 'agent', h: 'Travel Agent', cls: 'c-agent', aliases: ['travel agent', 'agent'] },
        { f: 'host', h: 'Haharu Host', cls: 'c-agent', aliases: ['haharu host', 'host'] },
        { f: 'remarks', h: 'Remarks', cls: 'c-comment', wide: true, aliases: ['remarks', 'remark'] }
      ],
      required: ['room', 'guest'],
      // Welcome and Farewell share most headings. These two are Welcome's own,
      // and are still looked for in an uploaded file even though the arrival
      // flight columns are no longer shown.
      signature: ['eta', 'depDate'],
      // Read out of a file to tell the two tables apart, then discarded.
      probe: [
        { f: 'arrFlight', aliases: ['int arr flt / resort', 'int arr flt/resort', 'int arr flt'] },
        { f: 'etd', aliases: ['etd from airport / resort', 'etd from airport/resort', 'etd'] }
      ]
    },
    {
      key: 'farewell', label: "Today's Farewell",
      columns: [
        { f: 'room', h: 'Room', cls: 'c-room', aliases: ['room', 'room no', 'villa'] },
        { f: 'status', h: 'Status', cls: 'c-plan', aliases: ['status'] },
        { f: 'guest', h: 'Guest Name', cls: 'c-guest', wide: true, aliases: ['guest name', 'guest'] },
        { f: 'checkout', h: 'Check-Out Time', cls: 'c-time', type: 'time', fillDown: true,
          aliases: ['check-out time', 'check out time', 'checkout time'] },
        { f: 'depTime', h: 'Dep Time from Resort', cls: 'c-time', type: 'time', fillDown: true,
          aliases: ['dep time from resort', 'dep time'] },
        { f: 'nationality', h: 'Nat', cls: 'c-num', aliases: ['nationality', 'nat'] },
        { f: 'pax', h: 'Pax', cls: 'c-num', aliases: ['pax', 'no of pax'] },
        { f: 'vip', h: 'VIP', cls: 'c-num', aliases: ['vip'] },
        { f: 'mealPlan', h: 'Meal Plan', cls: 'c-plan', aliases: ['meal plan', 'mealplan'] },
        { f: 'agent', h: 'Travel Agent', cls: 'c-agent', aliases: ['travel agent', 'agent'] },
        { f: 'host', h: 'Haharu Host', cls: 'c-agent', aliases: ['haharu host', 'host'] },
        { f: 'remarks', h: 'Remarks', cls: 'c-comment', wide: true, aliases: ['remarks', 'remark'] }
      ],
      required: ['room', 'guest'],
      signature: ['checkout', 'depTime'],
      probe: [
        { f: 'luggage', aliases: ['luggage pick-up', 'luggage pickup', 'luggage pick up'] },
        { f: 'transfer', aliases: ['seap/ spd / dom', 'seap / spd / dom', 'seap/spd/dom', 'seap'] },
        { f: 'etaMle', aliases: ['eta to mle / resort', 'eta to mle/resort', 'eta to mle'] }
      ]
    },
    {
      key: 'moves', label: 'Room Moves',
      columns: [
        { f: 'from', h: 'From', cls: 'c-room', aliases: ['from', 'from room', 'from:'] },
        { f: 'to', h: 'To', cls: 'c-room', aliases: ['to', 'to:', 'to room'] },
        { f: 'guest', h: 'Guest Name', cls: 'c-guest', wide: true, aliases: ['guest name', 'guest'] },
        { f: 'time', h: 'Time', cls: 'c-time', type: 'time', aliases: ['time'] },
        { f: 'agent', h: 'Travel Agent', cls: 'c-agent', aliases: ['travel agent', 'agent'] },
        { f: 'pax', h: 'No of Pax', cls: 'c-num', aliases: ['no of pax', 'pax'] },
        { f: 'host', h: 'Haharu Host', cls: 'c-agent', aliases: ['haharu host', 'host'] },
        { f: 'remarks', h: 'Remarks', cls: 'c-comment', wide: true, aliases: ['remarks', 'remark'] }
      ],
      required: ['from', 'to'],
      signature: ['from', 'to']
    },
    {
      key: 'celebrations', label: 'Celebration',
      columns: [
        { f: 'room', h: 'Room', cls: 'c-room', aliases: ['room', 'room no', 'villa'] },
        { f: 'guest', h: 'Guest Name', cls: 'c-guest', wide: true, aliases: ['guest name', 'guest'] },
        { f: 'celebration', h: 'Celebration', cls: 'c-plan',
          aliases: ['celebration', 'occasion', 'event'] },
        { f: 'locationTime', h: 'Location & Time', cls: 'c-agent',
          aliases: ['location & time', 'location and time', 'location', 'location & time '] },
        { f: 'bedDecoration', h: 'Bed Decoration', cls: 'c-comment', wide: true,
          aliases: ['bed decoration', 'decoration', 'bed deco'] }
      ],
      required: ['celebration'],
      signature: ['celebration', 'bedDecoration']
    }
  ];

  // The host allocation is a grid rather than a list: a name, then a numbered
  // column per villa, then remarks.
  var DHA_HOST_SLOTS = 20;

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function clockFace(hour, mins) {
    var suffix = hour < 12 ? 'AM' : 'PM';
    var shown = hour % 12;
    if (shown === 0) shown = 12;
    return pad2(shown) + ':' + pad2(mins) + ' ' + suffix;
  }

  /* Tidies a time into "08:30 AM".
   *
   * Excel keeps a time as a fraction of a day, so a cell showing 8:30 arrives
   * here as 0.3541666… - that is what the reader hands over, and printing it
   * raw is how "0.35416666666666669" ended up in a briefing sheet. Anything it
   * cannot read is left as typed: a sheet has to be able to say "TBA".
   */
  function tidyTime(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return '';

    // An Excel serial: a bare number whose fractional part is the time of day.
    if (/^\d*\.?\d+$/.test(s)) {
      var serial = parseFloat(s);
      if (isFinite(serial) && serial >= 0 && (serial < 1 || serial > 20000)) {
        var dayFraction = serial - Math.floor(serial);
        var totalMinutes = Math.round(dayFraction * 24 * 60);
        if (totalMinutes >= 24 * 60) totalMinutes = 0;
        return clockFace(Math.floor(totalMinutes / 60), totalMinutes % 60);
      }
    }

    var m = /^(\d{1,2})[:.\s]?(\d{2})?\s*([ap])\.?m?\.?$/i.exec(s);
    if (!m) m = /^(\d{1,2})[:.](\d{2})$/.exec(s);
    if (!m && /^\d{3,4}$/.test(s)) {
      var digits = ('0000' + s).slice(-4);
      m = [s, digits.slice(0, 2), digits.slice(2)];
    }
    if (!m) return s;

    var hour = parseInt(m[1], 10);
    var mins = m[2] === undefined ? 0 : parseInt(m[2], 10);
    var half = m[3] ? m[3].toLowerCase() : null;
    if (isNaN(hour) || isNaN(mins) || mins > 59) return s;

    if (half) {
      if (hour < 1 || hour > 12) return s;
      if (half === 'p' && hour !== 12) hour += 12;
      if (half === 'a' && hour === 12) hour = 0;
    } else if (hour > 23) {
      return s;
    }

    return clockFace(hour, mins);
  }

  /* Tidies a date into "30 Aug", the same form the rest of the app uses.
   *
   * Takes an Excel day serial (46266), an ISO date, or a slashed one. Slashed
   * dates are read month-first: 8/31/2026 in the source can only be 31 August.
   * Anything it cannot read is left as typed.
   */
  function tidyDate(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return '';

    var y, mo, d;

    // An Excel serial: whole days since 1899-12-30.
    if (/^\d+(\.\d+)?$/.test(s)) {
      var serial = parseFloat(s);
      if (serial > 20000 && serial < 90000) {
        var iso = window.XlsxReader.serialToIso(Math.floor(serial));
        if (iso) {
          var bits = iso.split('-');
          y = +bits[0]; mo = +bits[1]; d = +bits[2];
        }
      }
    }

    if (y === undefined) {
      var isoHit = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
      var slash = /^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})$/.exec(s);
      if (isoHit) {
        y = +isoHit[1]; mo = +isoHit[2]; d = +isoHit[3];
      } else if (slash) {
        mo = +slash[1]; d = +slash[2]; y = +slash[3];
        if (y < 100) y += 2000;
      } else {
        return s;
      }
    }

    if (mo < 1 || mo > 12 || d < 1 || d > 31) return s;
    return pad2(d) + ' ' + MONTHS[mo - 1];
  }

  function tidyByType(type, value) {
    if (type === 'time') return tidyTime(value);
    if (type === 'date') return tidyDate(value);
    return value;
  }

  // Rows the Celebration table is not about. These are headings for the other
  // things printed under it on the same sheet, and they are not celebrations.
  var DHA_CELEBRATION_SKIP = /avanifit|wellness|our offerings/i;

  /* The week summary printed at the top of the Dhathuru: one column per date,
   * one row per figure. This is where the real house count lives - the guest
   * list only knows the rooms in whatever export it was given. */
  var DHA_WEEK_ROWS = [
    { key: 'occ', label: 'Daily OCC%', aliases: ['daily occ%', 'daily occ %', 'daily occ'] },
    { key: 'pax', label: 'Adults / Children In-House',
      aliases: ['adults / children in-house', 'adults/children in-house',
        'adults / children in house', 'adults/children in house'] },
    { key: 'welcomeRms', label: 'Welcome Rms', aliases: ['welcome rms', 'welcome rooms'] },
    { key: 'farewellRms', label: 'Farewell Rms', aliases: ['farewell rms', 'farewell rooms'] },
    { key: 'occupiedRms', label: 'Occupied Rms', aliases: ['occupied rms', 'occupied rooms'] },
    { key: 'oooRms', label: 'OOO Rms', aliases: ['ooo rms', 'ooo rooms', 'o.o.o rms'] },
    { key: 'welcomeGuests', label: 'Welcome No. of Guests',
      aliases: ['welcome no. of guests', 'welcome no of guests'] },
    { key: 'farewellGuests', label: 'Farewell No. of Guests',
      aliases: ['farewell no. of guests', 'farewell no of guests'] }
  ];

  // "30-Aug", "30 Aug" and "01 Sep" all have to compare equal to a date column
  // heading, so reduce each to day-plus-month with nothing else in it.
  function dateKey(raw) {
    var s = String(raw == null ? '' : raw).toLowerCase().replace(/[^a-z0-9]/g, '');
    var m = /^(\d{1,2})([a-z]{3})/.exec(s);
    if (m) return String(parseInt(m[1], 10)) + m[2];
    m = /^([a-z]{3})(\d{1,2})$/.exec(s);
    if (m) return String(parseInt(m[2], 10)) + m[1];
    return '';
  }

  // The week summary's column for a business date, or -1.
  function weekColumnFor(week, isoDate) {
    if (!week || !week.dates || !week.dates.length) return -1;
    var want = dateKey(fmtDate(isoDate));
    if (!want) return -1;
    for (var i = 0; i < week.dates.length; i++) {
      if (dateKey(week.dates[i]) === want) return i;
    }
    return -1;
  }

  function weekValue(week, key, col) {
    if (col < 0 || !week || !week.rows || !week.rows[key]) return '';
    return String(week.rows[key][col] == null ? '' : week.rows[key][col]).trim();
  }

  // "154/33" -> {adults: 154, children: 33}
  function splitPax(value) {
    var m = /^\s*(\d+)\s*[\/|]\s*(\d+)\s*$/.exec(String(value || ''));
    if (!m) return null;
    return { adults: parseInt(m[1], 10), children: parseInt(m[2], 10) };
  }

  // Kept outside the pane so a repaint does not lose what was being looked for.
  var dhaVillaFind = '';

  function dhaTableByKey(key) {
    for (var i = 0; i < DHA_TABLES.length; i++) if (DHA_TABLES[i].key === key) return DHA_TABLES[i];
    return null;
  }

  function blankRowFor(spec) {
    var row = {};
    spec.columns.forEach(function (c) { row[c.f] = ''; });
    return row;
  }

  function blankHost() {
    return { name: '', villas: new Array(DHA_HOST_SLOTS).join(',').split(','), remarks: '' };
  }

  function emptyDhathuru() {
    return {
      welcome: [], farewell: [], moves: [], celebrations: [], hosts: [],
      // Typed-in house figures. The guest list only knows the rooms in the
      // export it was given, which is not always the whole island, so these
      // override it when set and are left blank when they do not need to.
      house: { adults: '', children: '', rooms: '' },
      week: null,
      header: null,
      note: '', updatedAt: 0, by: ''
    };
  }

  function dhathuruSheet() {
    var d = state.dhathuru || {};
    return {
      welcome: (d.welcome || []).slice(),
      farewell: (d.farewell || []).slice(),
      moves: (d.moves || []).slice(),
      celebrations: (d.celebrations || []).slice(),
      hosts: (d.hosts || []).slice(),
      house: d.house || { adults: '', children: '', rooms: '' },
      week: d.week || null,
      header: d.header || null,
      note: d.note || ''
    };
  }

  function saveDhathuru() {
    saveLocalOnly();
    if (!window.GihApi.isOnline()) return;
    if (!may('dhathuru')) { toast('You do not have rights to edit the Dhathuru sheet.', true); return; }
    window.GihApi.putDhathuru(state.bizDate, dhathuruSheet()).then(function (res) {
      if (!res.ok) { if (!res.offline) toast('Not saved: ' + res.error, true); return; }
      remote.dayRevision = res.body.revision;
      // Update in place. Swapping the object for the server's copy would orphan
      // the reference the open pane is editing, and the next keystroke would
      // land in an object nothing is showing.
      state.dhathuru.updatedAt = res.body.dhathuru.updatedAt;
      state.dhathuru.by = res.body.dhathuru.by;
      var stamp = $('#dhaSaved');
      if (stamp) {
        stamp.textContent = 'saved ' + new Date(state.dhathuru.updatedAt).toLocaleTimeString() +
          (state.dhathuru.by ? ' by ' + state.dhathuru.by : '');
      }
    });
  }

  /* ---- what the guest list can fill in on its own ---- */

  function welcomeFromGih(date) {
    return state.data.filter(function (r) { return r.arrival === date; });
  }

  function farewellFromGih(date) {
    return state.data.filter(function (r) { return r.departure === date; });
  }

  // Pre-fills the columns the Opera export actually carries. The flight and
  // transfer columns stay blank - nothing in the export knows them, and a guess
  // in a briefing sheet is worse than a gap.
  function seedWelcome(date) {
    return welcomeFromGih(date).map(function (r) {
      var row = blankRowFor(dhaTableByKey('welcome'));
      row.room = r.room;
      row.guest = r.guest || '';
      row.depDate = tidyDate(r.departure || '');
      row.pax = String((r.adults || 0) + (r.child || 0));
      row.mealPlan = r.meal || '';
      row.remarks = r.remarks || '';
      return row;
    });
  }

  function seedFarewell(date) {
    return farewellFromGih(date).map(function (r) {
      var row = blankRowFor(dhaTableByKey('farewell'));
      row.room = r.room;
      row.guest = r.guest || '';
      row.pax = String((r.adults || 0) + (r.child || 0));
      row.mealPlan = r.meal || '';
      row.remarks = r.remarks || '';
      return row;
    });
  }

  /* The block across the top of the Dhathuru, as the sheet itself lays it out:
   * the day's figures and the targets on the left, the date and the week
   * summary on the right. All of it read from the uploaded file - none
   * of it is worked out here, because none of it is in the Opera export. */
  function renderDhaHeader(host, sheet, date, weekCol) {
    if (!host) return;
    host.innerHTML = '';

    var header = sheet.header || {};
    var hasWeek = !!(sheet.week && sheet.week.dates && sheet.week.dates.length);
    var hasHeader = !!(header.title || (header.stats || []).length ||
      (header.targets || []).length);

    if (!hasHeader && !hasWeek) {
      var empty = el('div', 'dha-head-empty');
      empty.appendChild(el('strong', null, fmtDate(date)));
      empty.appendChild(el('span', null,
        'Upload the Dhathuru on the Import & Template tab to bring in the day\'s ' +
        'figures, targets and week summary.'));
      host.appendChild(empty);
      return;
    }

    var block = el('div', 'dha-head');

    /* left: the day's figures, then the targets under them */
    var left = el('div', 'dha-head-left');

    if ((header.stats || []).length) {
      var statList = el('div', 'dha-pairs');
      header.stats.forEach(function (s) {
        var row = el('div', 'dha-pair');
        row.appendChild(el('span', 'dha-pair-label', s.label));
        row.appendChild(el('span', 'dha-pair-value', s.value));
        statList.appendChild(row);
      });
      left.appendChild(statList);
    }

    if ((header.targets || []).length) {
      var box = el('div', 'dha-list');
      box.appendChild(el('h3', null, 'Targets'));
      header.targets.forEach(function (e) {
        var row = el('div', 'dha-pair');
        row.appendChild(el('span', 'dha-pair-label', e.label));
        row.appendChild(el('span', 'dha-pair-value', e.value));
        box.appendChild(row);
      });
      left.appendChild(box);
    }

    if (left.childNodes.length) block.appendChild(left);

    /* right: the date the sheet is for, and the week summary */
    var right = el('div', 'dha-head-right');
    right.appendChild(el('h2', 'dha-head-date', header.title || fmtDate(date)));

    if (hasWeek) {
      var wrap = el('div', 'table-wrap');
      var table = el('table', 'grid dha-table dha-week');
      var thead = el('thead');
      var hrow = el('tr');
      hrow.appendChild(el('th', 'c-agent', 'This Week Summary'));
      sheet.week.dates.forEach(function (label, i) {
        hrow.appendChild(el('th', 'c-slot' + (i === weekCol ? ' dha-today' : ''), label));
      });
      thead.appendChild(hrow);
      table.appendChild(thead);

      var body = el('tbody');
      DHA_WEEK_ROWS.forEach(function (spec) {
        var values = sheet.week.rows[spec.key];
        if (!values) return;
        var tr = el('tr');
        tr.appendChild(el('td', 'c-agent dha-week-label', spec.label));
        values.forEach(function (v, i) {
          tr.appendChild(el('td', 'c-slot' + (i === weekCol ? ' dha-today' : ''), v));
        });
        body.appendChild(tr);
      });
      table.appendChild(body);
      wrap.appendChild(table);
      right.appendChild(wrap);

      if (weekCol === -1) {
        right.appendChild(el('p', 'cp-hint',
          'No column here is ' + fmtDate(date) + '.'));
      }
    }

    block.appendChild(right);
    host.appendChild(block);
  }

  /* ---- the pane ---- */

  function buildDhathuruPane() {
    var pane = document.getElementById('tpl-dhathuru').content.cloneNode(true);
    var date = state.bizDate;
    var editable = may('dhathuru');

    if (!state.dhathuru) state.dhathuru = emptyDhathuru();
    DHA_TABLES.forEach(function (spec) {
      if (!Array.isArray(state.dhathuru[spec.key])) state.dhathuru[spec.key] = [];
    });
    if (!Array.isArray(state.dhathuru.hosts)) state.dhathuru.hosts = [];
    var sheet = state.dhathuru;

    // A sheet read before times and dates were understood still holds Excel
    // serials. Tidy them here so they read properly straight away; the fix
    // persists the next time anything on the sheet is saved. Tidying an
    // already-tidy value does nothing, so this is safe to run every time.
    DHA_TABLES.forEach(function (spec) {
      spec.columns.forEach(function (c) {
        if (!c.type) return;
        sheet[spec.key].forEach(function (row) {
          row[c.f] = tidyByType(c.type, row[c.f]);
        });
      });
    });

    var title = $('#dhaTitle', pane);
    title.textContent = 'Dhathuru — ' + fmtDate(date);
    title.setAttribute('data-print-date', fmtDate(date));

    var saved = $('#dhaSaved', pane);
    if (sheet.updatedAt) {
      saved.textContent = 'saved ' + new Date(sheet.updatedAt).toLocaleTimeString() +
        (sheet.by ? ' by ' + sheet.by : '');
    }

    /* ---- the strip across the top ---- */
    var house = houseList(date);
    var adults = house.reduce(function (t, r) { return t + (r.adults || 0); }, 0);
    var kids = house.reduce(function (t, r) { return t + (r.child || 0); }, 0);
    var totalRooms = parseInt(conf().property.totalRooms, 10) || 0;

    // The sheet's own rows if it has them, otherwise what the guest list says.
    var welCount = sheet.welcome.length || welcomeFromGih(date).length;
    var farCount = sheet.farewell.length || farewellFromGih(date).length;

    /* ---- the sheet's own header block ---- */
    var weekCol = weekColumnFor(sheet.week, date);
    renderDhaHeader($('#dhaHeader', pane), sheet, date, weekCol);

    var host = $('#dhaTables', pane);

    /* ---- one card per table, built from the column definition ---- */
    DHA_TABLES.forEach(function (spec) {
      var rows = sheet[spec.key];
      var card = el('section', 'dha-card');

      var head = el('h2', null, spec.label);
      var count = el('span', 'dha-count', String(rows.length));
      head.appendChild(count);

      var tools = el('div', 'dha-tools');
      head.appendChild(tools);
      card.appendChild(head);

      var wrap = el('div', 'table-wrap');
      var table = el('table', 'grid dha-table');
      var thead = el('thead');
      var hrow = el('tr');
      spec.columns.forEach(function (c) { hrow.appendChild(el('th', c.cls, c.h)); });
      hrow.appendChild(el('th', 'c-x'));
      thead.appendChild(hrow);
      table.appendChild(thead);
      var body = el('tbody');
      table.appendChild(body);
      wrap.appendChild(table);
      card.appendChild(wrap);
      host.appendChild(card);

      var paint = function () {
        body.innerHTML = '';
        count.textContent = rows.length;

        if (!rows.length) {
          var tr = el('tr');
          var td = el('td', 'empty', editable
            ? 'Nothing yet — use Add, or upload the Dhathuru file.'
            : 'Nothing yet.');
          td.colSpan = spec.columns.length + 1;
          tr.appendChild(td);
          body.appendChild(tr);
          return;
        }

        rows.forEach(function (row, i) {
          var tr = el('tr', i % 2 ? 'band' : '');
          spec.columns.forEach(function (c) {
            if (!editable) {
              var td = el('td', c.cls);
              td.appendChild(el('div', c.wide ? 'guest-lines' : null, row[c.f] || ''));
              tr.appendChild(td);
              return;
            }
            // No placeholder: the heading is directly above, and grey prompt
            // text in sixteen narrow columns is just noise.
            tr.appendChild(editableCell(c.cls, row[c.f] || '', function (next) {
              row[c.f] = tidyByType(c.type, next);
              saveDhathuru();
              // A tidied value differs from what was typed, so put it back on
              // screen rather than leaving "630" where "6:30 AM" is stored.
              if (row[c.f] !== next) paint();
              return true;
            }, { multiline: !!c.wide }));
          });

          var del = el('td', 'c-x');
          if (editable) {
            var b = el('button', 'rowdel', '✕');
            b.type = 'button';
            b.title = 'Remove this line';
            b.onclick = function () {
              rows.splice(rows.indexOf(row), 1);
              saveDhathuru();
              paint();
            };
            del.appendChild(b);
          }
          tr.appendChild(del);
          body.appendChild(tr);
        });
      };

      if (editable) {
        // Welcome and Farewell can be started from the guest list: it knows the
        // rooms, names, pax and plans, and leaves the flight columns to be
        // filled in from the transfer sheet.
        if (spec.key === 'welcome' || spec.key === 'farewell') {
          var seed = el('button', 'btn small ghost-line', 'Fill from guest list');
          seed.type = 'button';
          seed.title = 'Bring in today’s rooms, names, pax and meal plans';
          seed.onclick = function () {
            var made = spec.key === 'welcome' ? seedWelcome(date) : seedFarewell(date);
            if (!made.length) { toast('Nobody ' + (spec.key === 'welcome' ? 'arriving' : 'leaving') +
              ' on ' + fmtDate(date) + '.', true); return; }
            if (rows.length && !confirm('Replace the ' + rows.length + ' line(s) already here?')) return;
            rows.length = 0;
            made.forEach(function (r) { rows.push(r); });
            saveDhathuru();
            paint();
            toast('Brought in ' + made.length + ' from the guest list.');
          };
          tools.appendChild(seed);
        }

        var add = el('button', 'btn small', 'Add');
        add.type = 'button';
        add.onclick = function () {
          rows.push(blankRowFor(spec));
          saveDhathuru();
          paint();
        };
        tools.appendChild(add);
      }

      paint();
    });

    /* ---- the host allocation grid ---- */
    var hostRows = sheet.hosts;
    var hcard = el('section', 'dha-card');
    var hhead = el('h2', null, 'Haharu Host Villa Allocations');
    var hcount = el('span', 'dha-count', String(hostRows.length));
    hhead.appendChild(hcount);
    var htools = el('div', 'dha-tools');
    hhead.appendChild(htools);
    hcard.appendChild(hhead);

    // "Who has 412?" is the question this grid gets asked all day, and reading
    // twenty columns across a dozen rows to answer it is the slow way.
    var findVilla = el('input', 'cp-input dha-find');
    findVilla.type = 'search';
    findVilla.placeholder = 'Find a villa…';
    findVilla.value = dhaVillaFind;
    htools.appendChild(findVilla);

    var findAnswer = el('div', 'dha-find-answer');
    hcard.appendChild(findAnswer);

    var hwrap = el('div', 'table-wrap');
    var htable = el('table', 'grid dha-table dha-hosts');
    var hthead = el('thead');
    var hhrow = el('tr');
    hhrow.appendChild(el('th', 'c-agent', 'Name'));
    for (var s = 1; s <= DHA_HOST_SLOTS; s++) hhrow.appendChild(el('th', 'c-slot', String(s)));
    hhrow.appendChild(el('th', 'c-comment', 'Remarks'));
    hhrow.appendChild(el('th', 'c-x'));
    hthead.appendChild(hhrow);
    htable.appendChild(hthead);
    var hbody = el('tbody');
    htable.appendChild(hbody);
    hwrap.appendChild(htable);
    hcard.appendChild(hwrap);
    host.appendChild(hcard);

    var paintHosts = function () {
      hbody.innerHTML = '';
      hcount.textContent = hostRows.length;

      var needle = dhaVillaFind.trim().toLowerCase();
      findAnswer.innerHTML = '';
      findAnswer.hidden = !needle;

      if (needle) {
        var hits = [];
        hostRows.forEach(function (row) {
          (row.villas || []).forEach(function (v, at) {
            if (String(v).trim().toLowerCase().indexOf(needle) !== -1) {
              hits.push({ host: row.name || '(unnamed)', villa: v, slot: at + 1 });
            }
          });
        });
        if (!hits.length) {
          findAnswer.appendChild(el('span', 'dha-find-none',
            'No villa matching "' + dhaVillaFind.trim() + '" is allocated.'));
        } else {
          hits.forEach(function (h) {
            var chip = el('span', 'dha-find-hit');
            chip.appendChild(el('strong', null, h.villa));
            chip.appendChild(document.createTextNode(' → ' + h.host + ' (slot ' + h.slot + ')'));
            findAnswer.appendChild(chip);
          });
        }
      }

      if (!hostRows.length) {
        var tr = el('tr');
        var td = el('td', 'empty', editable
          ? 'No hosts yet — use Add, or upload the Dhathuru file.'
          : 'No hosts yet.');
        td.colSpan = DHA_HOST_SLOTS + 3;
        tr.appendChild(td);
        hbody.appendChild(tr);
        return;
      }

      hostRows.forEach(function (row, i) {
        row.villas = row.villas || [];
        var tr = el('tr', i % 2 ? 'band' : '');

        var nameCell = editable
          ? editableCell('c-agent dha-host-name', row.name || '', function (next) {
            row.name = next; saveDhathuru(); return true;
          }, {})
          : el('td', 'c-agent dha-host-name', row.name || '');
        tr.appendChild(nameCell);

        var rowHasHit = false;
        for (var slot = 0; slot < DHA_HOST_SLOTS; slot++) {
          (function (at) {
            var value = row.villas[at] || '';
            var hit = !!needle && String(value).trim().toLowerCase().indexOf(needle) !== -1;
            if (hit) rowHasHit = true;
            var cls = 'c-slot' + (hit ? ' dha-hit' : '');
            if (!editable) {
              tr.appendChild(el('td', cls, value));
              return;
            }
            tr.appendChild(editableCell(cls, value, function (next) {
              row.villas[at] = next;
              saveDhathuru();
              if (needle) paintHosts();
              return true;
            }, {}));
          })(slot);
        }
        if (needle && !rowHasHit) tr.classList.add('dha-dim');

        tr.appendChild(editable
          ? editableCell('c-comment', row.remarks || '', function (next) {
            row.remarks = next; saveDhathuru(); return true;
          }, {})
          : el('td', 'c-comment', row.remarks || ''));

        var del = el('td', 'c-x');
        if (editable) {
          var b = el('button', 'rowdel', '✕');
          b.type = 'button';
          b.title = 'Remove this host';
          b.onclick = function () {
            hostRows.splice(hostRows.indexOf(row), 1);
            saveDhathuru();
            paintHosts();
          };
          del.appendChild(b);
        }
        tr.appendChild(del);
        hbody.appendChild(tr);
      });
    };

    findVilla.oninput = function () {
      dhaVillaFind = this.value;
      paintHosts();
    };

    if (editable) {
      var addHost = el('button', 'btn small', 'Add');
      addHost.type = 'button';
      addHost.onclick = function () {
        hostRows.push(blankHost());
        saveDhathuru();
        paintHosts();
      };
      htools.appendChild(addHost);
    }
    paintHosts();

    $('#dhaPrint', pane).onclick = function () { window.print(); };
    $('#dhaExport', pane).onclick = function () { exportDhathuruCsv(date); };

    return pane;
  }

  function exportDhathuruCsv(date) {
    var sheet = state.dhathuru || emptyDhathuru();
    var house = houseList(date);
    var totalRooms = parseInt(conf().property.totalRooms, 10) || 0;

    var lines = [csvCell('Dhathuru — ' + date), ''];
    lines.push(['Rooms in house', house.length].map(csvCell).join(','));
    lines.push(['Adults', house.reduce(function (t, r) { return t + (r.adults || 0); }, 0)].join(','));
    lines.push(['Children', house.reduce(function (t, r) { return t + (r.child || 0); }, 0)].join(','));
    if (totalRooms > 0) {
      lines.push(['Occupancy', Math.round((house.length / totalRooms) * 100) + '%']
        .map(csvCell).join(','));
    }

    DHA_TABLES.forEach(function (spec) {
      var rows = sheet[spec.key] || [];
      lines.push('', csvCell(spec.label.toUpperCase() + ' (' + rows.length + ')'));
      lines.push(spec.columns.map(function (c) { return csvCell(c.h); }).join(','));
      rows.forEach(function (row) {
        lines.push(spec.columns.map(function (c) { return csvCell(row[c.f]); }).join(','));
      });
    });

    lines.push('', csvCell('HAHARU HOST VILLA ALLOCATIONS'));
    var head = ['Name'];
    for (var s = 1; s <= DHA_HOST_SLOTS; s++) head.push(String(s));
    head.push('Remarks');
    lines.push(head.map(csvCell).join(','));
    (sheet.hosts || []).forEach(function (row) {
      var cells = [row.name];
      for (var i = 0; i < DHA_HOST_SLOTS; i++) cells.push((row.villas || [])[i] || '');
      cells.push(row.remarks || '');
      lines.push(cells.map(csvCell).join(','));
    });

    download('Dhathuru_' + date + '.csv', lines.join('\r\n'));
    toast('Exported the Dhathuru sheet');
  }

  /* ---------------------------------------------------------- master pane */

  var masterFilter = { q: '', outlet: '' };
  var rollupFilter = { q: '', outlet: '' };

  function buildMasterPane() {
    return buildCompiledPane({
      title: 'Master — ' + describeSources(masterSources()),
      sources: masterSources(),
      filter: masterFilter,
      canSave: true,
      fileStem: 'Master'
    });
  }

  function buildRollupPane(name, sources) {
    return buildCompiledPane({
      title: name + ' — ' + describeSources(sources),
      sources: sources,
      filter: rollupFilter,
      canSave: false,
      fileStem: name
    });
  }

  function describeSources(sources) {
    var all = outletNames();
    if (sources.length === all.length) return 'every outlet';
    if (sources.length <= 3) return sources.join(' + ');
    return sources.length + ' outlets';
  }

  /* One compiled, read-only sheet over a set of outlets. The Master tab and any
   * roll-up outlet are the same view over different sources - the place to
   * change a seating is always the outlet it belongs to. */
  function buildCompiledPane(opts) {
    var pane = document.getElementById('tpl-master').content.cloneNode(true);
    var all = compiledRows(opts.sources);
    var masterFilter = opts.filter;

    var heading = $('#masterName', pane);
    heading.textContent = opts.title;
    heading.setAttribute('data-print-date', fmtDate(state.bizDate));

    var picker = $('#masterOutlet', pane);
    opts.sources.forEach(function (o) {
      var n = (state.outlets[o] || []).length;
      var opt = el('option', null, o + ' (' + n + ')');
      opt.value = o;
      picker.appendChild(opt);
    });
    if (opts.sources.indexOf(masterFilter.outlet) === -1) masterFilter.outlet = '';
    picker.value = masterFilter.outlet;

    var search = $('#masterSearch', pane);
    search.value = masterFilter.q;

    // Saving a snapshot is a right of its own: it records what the floor was
    // actually working from, so it should be a deliberate act by someone named.
    var saveBtn = $('#masterSave', pane);
    if (!opts.canSave || !window.GihApi.isOnline()) {
      saveBtn.remove();
    } else {
      saveBtn.disabled = !may('master');
      saveBtn.title = may('master')
        ? 'Store this sheet on the server as it stands'
        : 'You do not have rights to save the Master sheet.';
      saveBtn.onclick = function () { saveMasterSnapshot(opts.sources); };
    }

    var tbody = $('#masterTable tbody', pane);
    var count = $('#masterCount', pane);
    var summaryBox = $('#masterSummary', pane);
    var dupNote = $('#masterDupNote', pane);

    // A room seated in two outlets at once is nearly always a mistake, and this
    // is the only view that can see it.
    var seen = {}, doubled = [];
    all.forEach(function (row) {
      if (seen[row.room]) {
        if (doubled.indexOf(row.room) === -1) doubled.push(row.room);
      }
      seen[row.room] = true;
    });
    if (doubled.length) {
      dupNote.hidden = false;
      dupNote.textContent = 'In two outlets at once: ' + doubled.join(', ');
    }

    function paint() {
      var q = masterFilter.q.trim().toLowerCase();
      var shown = all.filter(function (row) {
        if (masterFilter.outlet && row.outlet !== masterFilter.outlet) return false;
        if (!q) return true;
        var rec = lookup(row.room) || {};
        return [row.outlet, row.room, row.table, rec.guest, rec.comment, rec.remarks, rec.meal]
          .join(' ').toLowerCase().indexOf(q) !== -1;
      });

      tbody.innerHTML = '';
      if (!shown.length) {
        var tr = el('tr');
        var td = el('td', 'empty', all.length
          ? 'Nothing matches this filter.'
          : 'Nobody is seated anywhere yet.');
        td.colSpan = 11;
        tr.appendChild(td);
        tbody.appendChild(tr);
      } else {
        shown.forEach(function (row, i) {
          var rec = lookup(row.room);
          var tr = el('tr', rec ? rowClass(rec, state.bizDate, i) : 'missing');
          tr.appendChild(el('td', 'c-outlet', row.outlet));
          tr.appendChild(el('td', 'c-room', row.room +
            (doubled.indexOf(row.room) !== -1 ? ' ⚠' : '')));
          tr.appendChild(el('td', 'c-table', row.table || ''));
          tr.appendChild(el('td', 'c-rem', (rec && rec.remarks) || ''));

          var g = el('td', 'c-guest');
          g.appendChild(el('div', 'guest-lines', (rec && rec.guest) || ''));
          tr.appendChild(g);

          var p = el('td', 'c-plan');
          if (rec && rec.meal) p.appendChild(el('span', 'plan-tag', rec.meal));
          tr.appendChild(p);

          tr.appendChild(el('td', 'c-num', rec ? (rec.adults || 0) : ''));
          tr.appendChild(el('td', 'c-num', rec ? (rec.child || 0) : ''));
          tr.appendChild(el('td', 'c-date', rec ? fmtDate(rec.arrival) : ''));
          tr.appendChild(el('td', 'c-date', rec ? fmtDate(rec.departure) : ''));

          var c = el('td', 'c-comment');
          var box = el('div', 'comment', (rec && rec.comment) || '');
          box.onclick = function () { this.classList.toggle('open'); };
          c.appendChild(box);
          tr.appendChild(c);
          tbody.appendChild(tr);
        });
      }

      var busy = opts.sources.filter(function (o) { return (state.outlets[o] || []).length; });
      count.textContent = shown.length + ' of ' + all.length + ' covers across ' +
        busy.length + ' of ' + opts.sources.length + ' outlets';

      // The summary totals what is on screen, so filtering to one outlet gives
      // that outlet's numbers without leaving this tab.
      summaryBox.innerHTML = '';
      summaryBox.appendChild(buildSummary(summarise(shown, state.bizDate)));
    }

    search.oninput = function () { masterFilter.q = this.value; paint(); };
    picker.onchange = function () { masterFilter.outlet = this.value; paint(); };
    $('#masterExport', pane).onclick = function () {
      exportCompiledCsv(opts.sources, masterFilter, opts.fileStem);
    };

    paint();
    return pane;
  }

  function filteredCompiled(sources, filter) {
    var q = filter.q.trim().toLowerCase();
    return compiledRows(sources).filter(function (row) {
      if (filter.outlet && row.outlet !== filter.outlet) return false;
      if (!q) return true;
      var rec = lookup(row.room) || {};
      return [row.outlet, row.room, row.table, rec.guest, rec.comment, rec.remarks, rec.meal]
        .join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }

  function saveMasterSnapshot(sources) {
    var rows = filteredCompiled(sources, masterFilter).map(function (row) {
      var rec = lookup(row.room) || {};
      return {
        outlet: row.outlet, room: row.room, table: row.table,
        remarks: rec.remarks || '', guest: rec.guest || '', meal: rec.meal || '',
        adults: rec.adults || 0, child: rec.child || 0,
        arrival: rec.arrival || '', departure: rec.departure || ''
      };
    });
    if (!rows.length) { toast('Nothing seated to save.', true); return; }

    var note = prompt('A note for this snapshot (optional)', '');
    if (note === null) return;

    var s = summarise(filteredCompiled(sources, masterFilter), state.bizDate);
    window.GihApi.saveMaster(state.bizDate, {
      rows: rows,
      note: note,
      service: window.GihConfig.service(),
      station: station(),
      summary: { adults: s.totalAdults, kids: s.totalKids, covers: rows.length }
    }).then(function (res) {
      if (!res.ok) { toast('Not saved: ' + res.error, true); return; }
      remote.dayRevision = res.body.revision;
      toast('Master sheet saved — ' + rows.length + ' covers, by ' + res.body.snapshot.by + '.');
    });
  }

  function exportCompiledCsv(sources, filter, stem) {
    var q = filter.q.trim().toLowerCase();
    var rows = compiledRows(sources).filter(function (row) {
      if (masterFilter.outlet && row.outlet !== masterFilter.outlet) return false;
      if (!q) return true;
      var rec = lookup(row.room) || {};
      return [row.outlet, row.room, row.table, rec.guest, rec.comment, rec.remarks, rec.meal]
        .join(' ').toLowerCase().indexOf(q) !== -1;
    });

    var s = summarise(rows, state.bizDate);
    var lines = [
      csvCell(stem + ' — ' + describeSources(sources) + ' — ' + state.bizDate +
        ' — ' + window.GihConfig.service()),
      '',
      ['Outlet', 'Room No', 'Table #', 'Remarks', 'Guest Name', 'MealPlan',
        'Adults', 'Child', 'Arrival Date', 'Departure Date', 'Comment'].join(',')
    ];
    rows.forEach(function (row) {
      var r = lookup(row.room) || {};
      lines.push([row.outlet, row.room, row.table, r.remarks, r.guest, r.meal,
        r.adults, r.child, r.arrival, r.departure, r.comment].map(csvCell).join(','));
    });

    lines.push('', ['PACKAGE', 'ADULT', 'KID'].join(','));
    packages().forEach(function (label, i) {
      lines.push([label, s.adults[i], s.kids[i]].map(csvCell).join(','));
    });
    lines.push(['TOTAL', s.totalAdults, s.totalKids].join(','));

    lines.push('');
    s.derived.forEach(function (d) {
      if (d.gap) return lines.push('');
      var val = d.plain ? d.adults
        : [d.adults ? d.adults + ' Adults' : '', d.kids ? d.kids + ' Kids' : '']
          .filter(Boolean).join(' / ');
      lines.push([d.label + ':', val].map(csvCell).join(','));
    });

    download(safeName(stem) + '_' + state.bizDate + '.csv', lines.join('\r\n'));
    toast('Exported ' + rows.length + ' covers');
  }

  /* ---------------------------------------------------------- outlet pane */

  function buildOutletPane(name) {
    // An outlet that rolls up from others is not typed into - it shows what
    // those sheets hold, the way the OT sheet does in the workbook.
    var sources = rollupSources(name);
    if (sources) return buildRollupPane(name, sources);

    var pane = document.getElementById('tpl-outlet').content.cloneNode(true);
    var rows = state.outlets[name] || (state.outlets[name] = []);

    var h1 = $('#outletName', pane);
    h1.textContent = name;
    h1.setAttribute('data-print-date', fmtDate(state.bizDate));

    var tbody = $('#outletTable tbody', pane);
    var summaryBox = $('#summary', pane);
    var addInput = $('#roomAdd', pane);

    function repaint() {
      paintRows();
      summaryBox.innerHTML = '';
      summaryBox.appendChild(buildSummary(summarise(rows, state.bizDate)));
      renderTabs();
      save();
    }

    function paintRows() {
      tbody.innerHTML = '';
      if (!rows.length) {
        var tr = el('tr');
        var td = el('td', 'empty',
          'No rooms seated yet. Search above by room, guest or comment — or paste a list of room numbers.');
        td.colSpan = 11;
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }
      rows.forEach(function (row, i) { tbody.appendChild(outletRow(row, i, repaint, rows)); });
    }

    function addRooms(text) {
      var tokens = String(text).split(/[\s,;]+/).filter(Boolean);
      if (!tokens.length) return;
      var added = 0, unknown = [];
      tokens.forEach(function (tok) {
        var room = tok.trim();
        if (rows.some(function (r) { return r.room === room; })) return;
        rows.push({ room: room, table: '' });
        added++;
        if (!lookup(room)) unknown.push(room);
      });
      repaint();
      if (unknown.length) toast('Added ' + added + '; not in house: ' + unknown.join(', '), true);
      else if (added) toast('Added ' + added + ' room' + (added > 1 ? 's' : ''));
    }

    /* ---- search-to-seat -------------------------------------------------
     * A room number is not always what someone has to hand: they have a guest
     * on the phone, or a ticket number from a comment. So this searches the
     * whole GIH list and lets you pick. Pasting a list of room numbers still
     * works, because that is faster when you do have the numbers.
     */
    var resultBox = $('#seekResults', pane);
    var marked = -1;

    function seatedAlready(room) {
      return rows.some(function (r) { return r.room === String(room); });
    }

    function matchesFor(q) {
      var needle = q.trim().toLowerCase();
      if (!needle) return [];
      return state.data.filter(function (r) {
        return [r.room, r.guest, r.comment, r.remarks, r.meal]
          .join(' ').toLowerCase().indexOf(needle) !== -1;
      }).slice(0, 40);
    }

    function closeResults() {
      resultBox.hidden = true;
      resultBox.innerHTML = '';
      marked = -1;
    }

    function paintResults() {
      var q = addInput.value;
      // A list of room numbers is a paste, not a search - leave it alone.
      if (!q.trim() || /^[\s,;0-9]+$/.test(q) && /[\s,;]/.test(q.trim())) return closeResults();

      var hits = matchesFor(q);
      resultBox.innerHTML = '';
      if (!hits.length) {
        resultBox.appendChild(el('div', 'seek-empty', 'Nothing matches "' + q.trim() + '".'));
        resultBox.hidden = false;
        return;
      }

      hits.forEach(function (rec, i) {
        var seated = seatedAlready(rec.room);
        var item = el('button', 'seek-item' + (seated ? ' seated' : '') + (i === marked ? ' on' : ''));
        item.type = 'button';

        item.appendChild(el('span', 'seek-room', rec.room));
        var mid = el('span', 'seek-mid');
        mid.appendChild(el('strong', null, (rec.guest || '').split('\n')[0] || '—'));
        var sub = [rec.meal, (rec.adults || 0) + 'A', (rec.child || 0) + 'C',
          inHouse(rec, state.bizDate) ? '' : 'not in house'].filter(Boolean).join(' · ');
        mid.appendChild(el('span', 'seek-sub', sub));
        item.appendChild(mid);
        item.appendChild(el('span', 'seek-tag', seated ? 'seated' : 'add'));

        item.onclick = function () {
          if (seated) { toast(rec.room + ' is already on this sheet.'); return; }
          rows.push({ room: String(rec.room), table: '' });
          repaint();
          toast('Added ' + rec.room);
          addInput.value = '';
          closeResults();
          addInput.focus();
        };
        resultBox.appendChild(item);
      });
      resultBox.hidden = false;
    }

    addInput.oninput = paintResults;
    addInput.onfocus = paintResults;

    addInput.onkeydown = function (e) {
      var items = resultBox.hidden ? [] : resultBox.querySelectorAll('.seek-item');

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!items.length) return;
        e.preventDefault();
        marked += (e.key === 'ArrowDown' ? 1 : -1);
        if (marked < 0) marked = items.length - 1;
        if (marked >= items.length) marked = 0;
        Array.prototype.forEach.call(items, function (n, i) { n.classList.toggle('on', i === marked); });
        items[marked].scrollIntoView({ block: 'nearest' });
        return;
      }

      if (e.key === 'Escape') { closeResults(); return; }
      if (e.key !== 'Enter') return;

      e.preventDefault();
      if (marked >= 0 && items[marked]) { items[marked].click(); return; }

      // No pick made: treat what was typed as room numbers, so a pasted list
      // and a single typed number both still work.
      var typed = this.value;
      if (/[0-9]/.test(typed)) {
        addRooms(typed);
        this.value = '';
        closeResults();
        return;
      }
      // A one-hit search needs no pick.
      if (items.length === 1) items[0].click();
    };

    addInput.onblur = function () { setTimeout(closeResults, 160); };

    // Filling straight from the in-house list is a breakfast habit - everyone is
    // in for breakfast. At the other outlets it just makes a sheet to prune.
    var fill = $('#btnFillHouse', pane);
    if (!/breakfast/i.test(name)) {
      fill.remove();
    } else {
      fill.onclick = function () {
        var house = houseList(state.bizDate);
        if (!house.length) return toast('No rooms in house on ' + fmtDate(state.bizDate), true);
        var before = rows.length;
        house.forEach(function (r) {
          if (!rows.some(function (x) { return x.room === String(r.room); })) {
            rows.push({ room: String(r.room), table: '' });
          }
        });
        repaint();
        toast('Added ' + (rows.length - before) + ' in-house room(s)');
      };
    }

    var clearBtn = $('#btnClear', pane);
    clearBtn.disabled = !may('clear');
    clearBtn.title = may('clear')
      ? 'Take every room off this sheet'
      : 'You do not have rights to clear a whole outlet.';
    clearBtn.onclick = function () {
      if (!may('clear')) { toast('You do not have rights to clear a whole outlet.', true); return; }
      if (!rows.length) return;
      if (!confirm('Clear all ' + rows.length + ' rooms from ' + name + '?')) return;
      rows.length = 0;
      repaint();
    };

    $('#btnExport', pane).onclick = function () { exportOutletCsv(name, rows); };

    repaint();
    return pane;
  }

  function outletRow(row, i, repaint, rows) {
    var rec = lookup(row.room);
    var tr = el('tr', rowClass(rec, state.bizDate, i));

    // Room No - editable, drives the lookup.
    var tdRoom = el('td', 'c-room edit');
    var inRoom = document.createElement('input');
    inRoom.value = row.room;
    inRoom.onchange = function () { row.room = this.value.trim(); repaint(); };
    tdRoom.appendChild(inRoom);
    tr.appendChild(tdRoom);

    // Table # - editable, free text (the workbook allows "12/13", "A4" etc).
    var tdTable = el('td', 'c-table edit');
    var inTable = document.createElement('input');
    inTable.value = row.table || '';
    inTable.oninput = function () { row.table = this.value; };
    inTable.onchange = function () { save(); };
    tdTable.appendChild(inTable);
    tr.appendChild(tdTable);

    if (!rec) {
      var td = el('td', null, row.room ? 'Room ' + row.room + ' is not in the GIH list' : 'Enter a room number');
      td.colSpan = 8;
      tr.appendChild(td);
    } else {
      tr.appendChild(el('td', 'c-rem', rec.remarks || ''));

      var g = el('td', 'c-guest');
      g.appendChild(el('div', 'guest-lines', rec.guest || ''));
      if (dupRooms[String(rec.room).trim()]) {
        var warn = el('div', 'muted', 'duplicate room in GIH - first match shown');
        warn.style.fontSize = '10px';
        g.appendChild(warn);
      }
      tr.appendChild(g);

      var p = el('td', 'c-plan');
      if (rec.meal) p.appendChild(el('span', 'plan-tag', rec.meal));
      tr.appendChild(p);

      tr.appendChild(el('td', 'c-num', rec.adults || 0));
      tr.appendChild(el('td', 'c-num', rec.child || 0));
      tr.appendChild(el('td', 'c-date', fmtDate(rec.arrival)));
      tr.appendChild(el('td', 'c-date', fmtDate(rec.departure)));

      var c = el('td', 'c-comment');
      var box = el('div', 'comment', rec.comment || '');
      box.onclick = function () { this.classList.toggle('open'); };
      c.appendChild(box);
      tr.appendChild(c);
    }

    var tdX = el('td', 'c-x');
    var del = el('button', 'rowdel', '×');
    del.title = 'Remove row';
    del.onclick = function () { rows.splice(rows.indexOf(row), 1); repaint(); };
    tdX.appendChild(del);
    tr.appendChild(tdX);

    return tr;
  }

  /* ------------------------------------------------------- summary render */

  function buildSummary(s) {
    var frag = document.createDocumentFragment();

    var kpi = el('div', 'kpi');
    [['Rooms', s.covers], ['Adults', s.totalAdults], ['Kids', s.totalKids]].forEach(function (p) {
      var d = el('div');
      d.appendChild(el('strong', null, p[1]));
      d.appendChild(el('small', null, p[0]));
      kpi.appendChild(d);
    });
    frag.appendChild(kpi);

    if (s.unknown) {
      var w = el('p', 'muted', s.unknown + ' room(s) not found in the GIH list');
      w.style.color = '#b3261e';
      frag.appendChild(w);
    }

    // Package block - the SUMIF grid.
    var b1 = el('div', 'sum-block');
    b1.appendChild(el('h2', null, 'Package'));
    var t1 = el('table', 'sum-table');
    var head = el('tr');
    ['Package', 'Adult', 'Kid'].forEach(function (h) { head.appendChild(el('th', null, h)); });
    var thead = el('thead');
    thead.appendChild(head);
    t1.appendChild(thead);

    var tb1 = el('tbody');
    packages().forEach(function (label, i) {
      var zero = !s.adults[i] && !s.kids[i];
      var tr = el('tr', zero ? 'zero' : '');
      tr.appendChild(el('td', null, label));
      tr.appendChild(el('td', null, s.adults[i]));
      tr.appendChild(el('td', null, s.kids[i]));
      tb1.appendChild(tr);
    });
    var totRow = el('tr', 'total');
    totRow.appendChild(el('td', null, 'TOTAL'));
    totRow.appendChild(el('td', null, s.totalAdults));
    totRow.appendChild(el('td', null, s.totalKids));
    tb1.appendChild(totRow);
    t1.appendChild(tb1);
    b1.appendChild(t1);
    frag.appendChild(b1);

    // Derived block - DINNER PKG / GIH FOOD / GIH BEV / per-plan lines.
    var b2 = el('div', 'sum-block');
    b2.appendChild(el('h2', null, 'Covers breakdown'));
    var t2 = el('table', 'sum-table sum-derived');
    var tb2 = el('tbody');

    s.derived.forEach(function (d) {
      if (d.gap) {
        var sp = el('tr');
        var td = el('td', null, ' ');
        td.colSpan = 2;
        td.style.borderBottom = '0';
        sp.appendChild(td);
        tb2.appendChild(sp);
        return;
      }
      var isZero = !d.adults && !d.kids;
      var tr = el('tr', (d.total ? 'total ' : '') + (isZero && d.blank ? 'zero' : ''));
      tr.appendChild(el('td', null, d.label + ':'));

      var text;
      if (d.plain) {
        text = String(d.adults);
      } else {
        var parts = [];
        if (d.adults) parts.push(d.adults + ' Adults');
        if (d.kids) parts.push(d.kids + ' Kids');
        text = parts.length ? parts.join(' / ') : (d.blank ? '—' : '0');
      }
      tr.appendChild(el('td', null, text));
      tb2.appendChild(tr);
    });

    t2.appendChild(tb2);
    b2.appendChild(t2);
    frag.appendChild(b2);

    return frag;
  }

  /* --------------------------------------------------------------- export */

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function download(name, text) {
    downloadBlob(name, new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
  }

  function downloadBlob(name, blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function safeName(s) { return s.replace(/[^\w-]+/g, '_'); }

  // Exports what is on screen, filters and all - the list you are looking at is
  // the list you meant to hand over.
  function exportGihCsv() {
    var rows = filteredGihRows();
    var lines = [['Room No', 'Remarks', 'Guest Name', 'MealPlan', 'Adults', 'Child',
      'Arrival Date', 'Departure Date', 'Comment'].join(',')];
    rows.forEach(function (r) {
      lines.push([r.room, r.remarks, r.guest, r.meal, r.adults, r.child,
        r.arrival, r.departure, r.comment].map(csvCell).join(','));
    });
    download('GIH_' + state.bizDate + '.csv', lines.join('\r\n'));
    toast('Exported ' + rows.length +
      (rows.length === state.data.length ? ' rooms' : ' of ' + state.data.length + ' rooms'));
  }

  function exportOutletCsv(name, rows) {
    var s = summarise(rows, state.bizDate);
    var lines = [
      csvCell(name + ' - Cover Report - ' + state.bizDate),
      '',
      ['Room No', 'Table #', 'Remarks', 'Guest Name', 'MealPlan', 'Adults', 'Child',
        'Arrival Date', 'Departure Date', 'Comment'].join(',')
    ];
    rows.forEach(function (row) {
      var r = lookup(row.room) || {};
      lines.push([row.room, row.table, r.remarks, r.guest, r.meal, r.adults, r.child,
        r.arrival, r.departure, r.comment].map(csvCell).join(','));
    });

    lines.push('', ['PACKAGE', 'ADULT', 'KID'].join(','));
    packages().forEach(function (label, i) {
      lines.push([label, s.adults[i], s.kids[i]].map(csvCell).join(','));
    });
    lines.push(['TOTAL', s.totalAdults, s.totalKids].join(','));

    lines.push('');
    s.derived.forEach(function (d) {
      if (d.gap) return lines.push('');
      var val = d.plain ? d.adults
        : [d.adults ? d.adults + ' Adults' : '', d.kids ? d.kids + ' Kids' : '']
          .filter(Boolean).join(' / ');
      lines.push([d.label + ':', val].map(csvCell).join(','));
    });

    download(safeName(name) + '_' + state.bizDate + '.csv', lines.join('\r\n'));
    toast('Exported ' + rows.length + ' covers');
  }

  /* --------------------------------------------------------------- import */

  // Reads any supported file: an Opera "Guest INH - Meal Plan" export gets
  // folded into GIH records first; a GIH workbook or CSV is taken as it is.
  function importFile(file) {
    if (!file) return;
    toast('Reading ' + file.name + '…');

    window.XlsxReader.readWorkbook(file).then(function (wb) {
      if (window.Opera.looksLikeOpera(wb.sheets)) {
        var res = window.Opera.convert(wb.sheets);
        if (!res.rows.length) throw new Error('The Opera export had no reservations in it.');
        state.lastImport = { kind: 'opera', file: file.name, report: res.report };
        state.rawSheets = wb.sheets;
        state.active = 'IMPORT';
        setData(res.rows, file.name + ' → GIH (' + res.report.sheetName + ')');
        finishImport(res.rows.length + ' rooms converted from ' + file.name);
        return;
      }

      var gih = window.XlsxReader.pickGihSheet(wb.sheets);
      if (!gih || !gih.rows.length) {
        throw new Error(
          'Not recognised. Expected either an Opera "Guest INH - Meal Plan" export, ' +
          'or a GIH workbook with "Room No" and "Guest Name" columns.'
        );
      }
      state.lastImport = { kind: 'gih', file: file.name, report: null };
      state.rawSheets = null;
      setData(gih.rows, file.name + ' (' + gih.sheetName + ')');
      finishImport('Loaded ' + gih.rows.length + ' rooms from ' + gih.sheetName);
    }).catch(function (err) {
      toast('Import failed: ' + err.message, true);
    });
  }

  function finishImport(message) {
    snapDateToData();
    saveLocalOnly();
    render();
    toast(message);
    publishImport();
  }

  // An upload is only worth anything if every station gets it, so push it to the
  // server. Staff can still import for themselves - it just stays on their PC.
  function publishImport() {
    if (!window.GihApi.isOnline()) return;
    if (!may('importData')) {
      toast('Loaded on this station only — you do not have rights to share it.', true);
      return;
    }
    window.GihApi.importDay(state.bizDate, {
      data: state.data,
      source: state.source,
      lastImport: state.lastImport,
      station: station()
    }).then(function (res) {
      if (!res.ok) {
        toast('Could not share it: ' + res.error, true);
        return;
      }
      adoptDay(res.body.day, true);
      render();
      toast('Shared with every station for ' + fmtDate(state.bizDate) + '.');
    });
  }

  // Re-runs the conversion after the "checked in only" toggle changes, without
  // asking for the file again.
  // Recomputes state.data from whatever we still hold - the Opera workbook when
  // there is one, otherwise the records themselves, whose `_sourcePlan` lets the
  // comment rules be re-applied from scratch. Callers save and render.
  function reconvert() {
    if (!state.rawSheets) {
      setData(state.data, state.source);
      return;
    }
    try {
      var res = window.Opera.convert(state.rawSheets);
      state.lastImport.report = res.report;
      setData(res.rows, state.source);
    } catch (err) {
      toast('Could not reconvert: ' + err.message, true);
    }
  }

  /* ----------------------------------------------------- dhathuru import */

  /* Pulls the five tables out of an uploaded Dhathuru workbook.
   *
   * The tables sit one under another on a single sheet, each behind a yellow
   * banner row, so the reader works by heading rather than by position:
   *   - a candidate heading row has to match two or more of a table's columns,
   *     so a banner like "ROOM MOVES" on its own is never mistaken for one;
   *   - Welcome and Farewell share nine headings, so each also has to show one
   *     of its own - the arrival flight columns, or the luggage and check-out
   *     ones;
   *   - a table ends at a blank row or at the next banner, so it cannot run on
   *     and swallow the section beneath it.
   */

  function headerKey(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function rowIsBlank(row) {
    return !row || !row.some(function (c) { return String(c == null ? '' : c).trim(); });
  }

  var DHA_BANNER =
    /welcome|farewell|room move|celebrat|haharu|allocation|avanifit|wellness|our offerings|week summary/i;

  /* A banner is one piece of text standing alone on its row.
   *
   * "Standing alone" has to mean *one distinct value*, not one filled cell: a
   * banner is a cell merged across the whole width, and expanding merges - which
   * is what makes the transfer times fill down - repeats that text into every
   * column. Counting filled cells would stop seeing banners the moment merges
   * were expanded, and each table would run on into the next.
   */
  function rowIsBanner(row) {
    if (!row) return false;
    var distinct = [];
    for (var i = 0; i < row.length; i++) {
      var v = String(row[i] == null ? '' : row[i]).trim();
      if (!v) continue;
      if (distinct.indexOf(v) === -1) distinct.push(v);
      if (distinct.length > 1) return false;
    }
    if (distinct.length !== 1) return false;
    return DHA_BANNER.test(distinct[0]);
  }

  function matchHeader(row, spec) {
    var map = {};
    var matched = 0;
    // `probe` columns are not shown any more but are still read here: they are
    // what tells Welcome and Farewell apart in a file that has both.
    var lookFor = spec.columns.concat(spec.probe || []);

    for (var c = 0; c < row.length; c++) {
      var h = headerKey(row[c]);
      if (!h) continue;
      for (var i = 0; i < lookFor.length; i++) {
        var col = lookFor[i];
        if (map[col.f] !== undefined) continue;
        if (col.aliases.indexOf(h) !== -1) { map[col.f] = c; matched++; break; }
      }
    }

    if (matched < 2) return null;
    if (!spec.required.every(function (f) { return map[f] !== undefined; })) return null;

    var tells = (spec.signature || []).concat((spec.probe || []).map(function (p) { return p.f; }));
    if (tells.length && !tells.some(function (f) { return map[f] !== undefined; })) return null;
    return { map: map, matched: matched };
  }

  function readDhaTable(rows, spec) {
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i]) continue;
      var hit = matchHeader(rows[i], spec);
      if (!hit) continue;

      var out = [];
      for (var r = i + 1; r < rows.length; r++) {
        if (rowIsBlank(rows[r]) || rowIsBanner(rows[r])) break;
        if (matchHeader(rows[r], spec)) break;          // the next table's heading
        var line = rows[r];

        // Other things are printed under the Celebration table on the same
        // sheet. Their headings are not celebrations.
        if (spec.key === 'celebrations' &&
            DHA_CELEBRATION_SKIP.test(line.join(' '))) continue;

        var rec = {};
        var any = false;
        spec.columns.forEach(function (col) {
          var at = hit.map[col.f];
          var val = at === undefined ? ''
            : String(line[at] == null ? '' : line[at]).replace(/\s+$/, '').trim();
          rec[col.f] = tidyByType(col.type, val);
          if (rec[col.f]) any = true;
        });
        if (!any) continue;
        out.push(rec);
      }

      /* Transfer times are merged down the group that shares them, so only the
       * first row of each carries a value. A workbook records those merges and
       * the reader expands them exactly; a CSV cannot, so there the value is
       * carried down instead. Only for the columns that are genuinely merged -
       * carrying anything else down would invent data. */
      if (!rows.mergeCount) {
        spec.columns.forEach(function (col) {
          if (!col.fillDown) return;
          var last = '';
          out.forEach(function (rec) {
            if (rec[col.f]) last = rec[col.f];
            else rec[col.f] = last;
          });
        });
      }

      if (out.length) return { rows: out, headerRow: i + 1 };
    }
    return null;
  }

  /* The header block above the tables: the day's figures on the left, the
   * targets under them, and the date over the week summary on the right.
   *
   * Matched by label rather than by position, because the block is a patchwork
   * of merged cells whose columns shift about. Labels that carry their own
   * value ("Security: 729 2299") are split on the colon; the rest take the
   * first non-empty cell to their right.
   */
  var DHA_HEAD_STATS = [
    { label: 'ADR', aliases: ['adr'] },
    { label: 'Welcome Rooms / Adult / Child',
      aliases: ['welcome rooms / adult / child', 'welcome rooms/adult/child',
        'welcome rooms / adult /child'] },
    { label: 'Farewell Rooms / Adult / Child',
      aliases: ['farewell rooms / adult / child', 'farewell rooms/adult/child',
        'farewell rooms / adult /child'] }
  ];

  var DHA_LONG_DATE =
    /^(sun|mon|tues|wednes|thurs|fri|satur)day\s*,?\s+\d{1,2}\s+[a-z]+\s+\d{4}$/i;

  function readDhaHeader(rows) {
    var out = { title: '', stats: [], targets: [] };
    var limit = Math.min(rows.length, 40);

    var cellAt = function (r, c) {
      var row = rows[r];
      return row ? String(row[c] == null ? '' : row[c]).replace(/\s+/g, ' ').trim() : '';
    };
    var rightOf = function (r, c) {
      var row = rows[r] || [];
      for (var i = c + 1; i < row.length; i++) {
        var v = String(row[i] == null ? '' : row[i]).replace(/\s+/g, ' ').trim();
        // A merged label repeats across its span; skip the repeats.
        if (v && v !== cellAt(r, c)) return v;
      }
      return '';
    };
    var seen = {};

    for (var r = 0; r < limit; r++) {
      if (!rows[r]) continue;
      for (var c = 0; c < rows[r].length; c++) {
        var raw = cellAt(r, c);
        if (!raw) continue;
        var key = raw.toLowerCase().replace(/:\s*$/, '').trim();

        if (!out.title && DHA_LONG_DATE.test(raw)) out.title = raw;

        DHA_HEAD_STATS.forEach(function (spec) {
          if (seen[spec.label] || spec.aliases.indexOf(key) === -1) return;
          var value = rightOf(r, c);
          if (!value) return;
          seen[spec.label] = true;
          out.stats.push({ label: spec.label, value: value });
        });

        /* The targets list: labels running down this column with their values
         * in the very next one. It ends at the first row that breaks that
         * shape - below the block the sheet carries on with full-width merged
         * notices, and a value looked for further right would find the week
         * summary printed alongside them.
         *
         * The hotlines beside it are deliberately not read - they are a wall
         * phone list, not part of the day's briefing. */
        if (key === 'targets' && !seen[key]) {
          seen[key] = true;
          for (var d = r + 1; d < rows.length && out.targets.length < 12; d++) {
            var entry = cellAt(d, c);
            var value2 = cellAt(d, c + 1);
            // A merged cell repeats itself across its span, so a value equal to
            // the label is the end of the two-column block, not a target.
            if (!entry || !value2 || value2 === entry) break;
            out.targets.push({ label: entry, value: value2 });
          }
        }
      }
    }
    return (out.title || out.stats.length || out.targets.length) ? out : null;
  }

  /* The week summary: a row whose first cell says "This Week Summary" and whose
   * remaining cells are dates, then a row per figure. */
  function readDhaWeek(rows) {
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row) continue;

      var labelAt = -1;
      for (var c = 0; c < row.length; c++) {
        if (/this week summary/i.test(String(row[c] == null ? '' : row[c]))) { labelAt = c; break; }
      }
      if (labelAt === -1) continue;

      var dates = [];
      var cols = [];
      for (var d = labelAt + 1; d < row.length; d++) {
        var text = String(row[d] == null ? '' : row[d]).trim();
        if (!text) continue;
        // The date headings may be Excel serials rather than text.
        var shown = /^\d{5}(\.\d+)?$/.test(text) ? tidyDate(text) : text;
        if (!dateKey(shown)) continue;
        if (dates.length && dates[dates.length - 1] === shown) continue;
        dates.push(shown);
        cols.push(d);
      }
      if (dates.length < 2) continue;

      var out = { dates: dates, rows: {} };
      var found = 0;

      for (var r = i + 1; r < rows.length; r++) {
        if (rowIsBlank(rows[r])) break;
        var line = rows[r];
        // The label sits directly under "This Week Summary". Taking the first
        // non-empty cell on the row instead would pick up the header block
        // printed to its left, and every row it shares a line with would be
        // skipped as unrecognised.
        var head = String(line[labelAt] == null ? '' : line[labelAt])
          .replace(/\s+/g, ' ').trim().toLowerCase();
        if (!head) continue;

        for (var s = 0; s < DHA_WEEK_ROWS.length; s++) {
          var spec = DHA_WEEK_ROWS[s];
          if (spec.aliases.indexOf(head) === -1) continue;
          out.rows[spec.key] = cols.map(function (at) {
            return String(line[at] == null ? '' : line[at]).trim();
          });
          found++;
          break;
        }
      }

      if (found) return out;
    }
    return null;
  }

  // The host grid: a "Name" column followed by numbered slots.
  function readDhaHosts(rows) {
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row) continue;

      var nameAt = -1;
      var slots = [];
      for (var c = 0; c < row.length; c++) {
        var h = headerKey(row[c]);
        if (!h) continue;
        if (nameAt === -1 && (h === 'name' || h === 'host' || h === 'haharu host')) { nameAt = c; continue; }
        if (nameAt !== -1 && /^\d{1,2}$/.test(h)) slots.push(c);
      }
      if (nameAt === -1 || slots.length < 3) continue;

      var remarksAt = -1;
      for (var c2 = 0; c2 < row.length; c2++) {
        if (headerKey(row[c2]) === 'remarks') { remarksAt = c2; break; }
      }

      var out = [];
      for (var r = i + 1; r < rows.length; r++) {
        if (rowIsBanner(rows[r])) break;
        var line = rows[r] || [];
        var name = String(line[nameAt] == null ? '' : line[nameAt]).trim();
        var villas = slots.map(function (at) {
          return String(line[at] == null ? '' : line[at]).trim();
        });
        var remarks = remarksAt === -1 ? ''
          : String(line[remarksAt] == null ? '' : line[remarksAt]).trim();

        // A host with no villas yet is still on the roster, so a named row is
        // kept even when empty; a wholly blank row ends the grid.
        if (!name && !villas.some(Boolean) && !remarks) {
          if (rowIsBlank(rows[r])) break;
          continue;
        }
        while (villas.length < DHA_HOST_SLOTS) villas.push('');
        out.push({ name: name, villas: villas.slice(0, DHA_HOST_SLOTS), remarks: remarks });
      }
      if (out.length) return { rows: out, headerRow: i + 1 };
    }
    return null;
  }

  function importDhathuruFile(file) {
    if (!file) return;
    if (!may('dhathuru')) { toast('You do not have rights to edit the Dhathuru sheet.', true); return; }
    toast('Reading ' + file.name + '…');

    // Merged transfer times are the whole point here, so expand them. The Opera
    // importer deliberately does not - it groups a booking's guest rows by the
    // blanks a merge leaves behind.
    window.XlsxReader.readWorkbook(file, { expandMerges: true }).then(function (wb) {
      var found = {};
      var weekFound = null;
      var headFound = null;
      var seen = [];

      wb.sheets.forEach(function (sheet) {
        DHA_TABLES.forEach(function (spec) {
          if (found[spec.key]) return;
          var hit = readDhaTable(sheet.rows, spec);
          if (hit) found[spec.key] = { label: spec.label, sheet: sheet.name, rows: hit.rows };
        });
        if (!found.hosts) {
          var hosts = readDhaHosts(sheet.rows);
          if (hosts) {
            found.hosts = {
              label: 'Haharu Host Villa Allocations', sheet: sheet.name, rows: hosts.rows
            };
          }
        }
        if (!weekFound) {
          var week = readDhaWeek(sheet.rows);
          if (week) weekFound = { label: 'This Week Summary', sheet: sheet.name, week: week };
        }
        if (!headFound) {
          var head = readDhaHeader(sheet.rows);
          if (head) headFound = { label: 'the header block', sheet: sheet.name, header: head };
        }

        // Kept for the "could not read it" message, so the headings can be
        // handed back to whoever has to teach this reader the real layout.
        var headings = [];
        for (var i = 0; i < Math.min(sheet.rows.length, 40); i++) {
          (sheet.rows[i] || []).forEach(function (cell) {
            var h = headerKey(cell);
            if (h && h.length < 34 && headings.indexOf(h) === -1) headings.push(h);
          });
        }
        seen.push({ name: sheet.name, rows: sheet.rows.length, headings: headings.slice(0, 30) });
      });

      var keys = Object.keys(found);
      state.dhathuruImport = {
        file: file.name, found: found, seen: seen, week: weekFound, header: headFound
      };

      if (!keys.length && !weekFound && !headFound) {
        render();
        toast('Nothing recognised in ' + file.name + ' — see what it found below.', true);
        return;
      }

      if (!state.dhathuru) state.dhathuru = emptyDhathuru();
      keys.forEach(function (k) { state.dhathuru[k] = found[k].rows; });
      if (weekFound) state.dhathuru.week = weekFound.week;
      if (headFound) state.dhathuru.header = headFound.header;
      saveDhathuru();
      render();
      var told = keys.map(function (k) {
        return found[k].rows.length + ' ' + found[k].label;
      });
      if (weekFound) told.push('the week summary');
      if (headFound) told.push('the header block');
      toast('Read ' + told.join(', ') + '.');
    }).catch(function (err) {
      toast('Could not read it: ' + err.message, true);
    });
  }

  /* ------------------------------------------------------- template build */

  // The Control Panel's file-name pattern, with {date}/{property} filled in.
  function templateFileName() {
    var p = conf().property;
    var base = (p.fileName || 'GIH Report {date}')
      .replace(/\{date\}/g, state.bizDate)
      .replace(/\{property\}/g, p.name || '')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .trim();
    return (base || 'GIH Report') + '.xlsx';
  }

  function buildTemplate() {
    if (!state.data.length) { toast('Nothing to build - import a report first.', true); return; }
    toast('Building workbook…');

    window.XlsxWriter.buildGihWorkbook(state.data, {
      source: state.source,
      title: 'GIH - Outlets Cover Report'
    }).then(function (blob) {
      var name = templateFileName();
      downloadBlob(name, blob);
      toast(name + ' built (' + Math.round(blob.size / 1024) + ' KB)');
    }).catch(function (err) {
      toast('Build failed: ' + err.message, true);
    });
  }

  /* -------------------------------------------------------- control panel */

  function buildSettingsPane() {
    return window.ControlPanel.build({
      toast: toast,
      download: download,
      station: station,
      setStation: setStation,
      promptLogin: promptLogin,
      openDay: function (date) {
        state.bizDate = date;
        loadDay(date);
      },
      // A settings change can rename or drop an outlet, so the whole view is
      // rebuilt rather than patched.
      refresh: function () {
        outletNames().forEach(function (o) { if (!state.outlets[o]) state.outlets[o] = []; });
        // An import rule may have changed, so re-fold the Opera file we still
        // hold rather than making the user upload it again to see the effect.
        // Without it, re-running setData still re-applies the comment rules,
        // which read the plan each record arrived with.
        reconvert();
        save();
        render();
      },
      rerender: render,

      // Seating is keyed by outlet name, so a rename has to carry it across.
      renameOutlet: function (from, to) {
        if (!state.outlets[from]) return;
        state.outlets[to] = state.outlets[from];
        delete state.outlets[from];
        if (state.active === from) state.active = to;
      },
      dropOutlet: function (name) {
        delete state.outlets[name];
        if (state.active === name) state.active = 'SETTINGS';
      },

      // How many of the rooms loaded right now a comment rule would catch, so
      // the rule can be checked against real data before it is trusted.
      previewRule: function (rule, index) {
        // Compile the rules up to and including this one: a room an earlier
        // rule already claims is not one this rule gets, so it must not be
        // counted here either.
        var compiled = compileRules((conf().commentRules || []).slice(0, index + 1));
        var matched = [];

        state.data.forEach(function (r) {
          if (firstRuleFor(compiled, r) === index) matched.push(r.room);
        });

        return {
          count: matched.length,
          total: state.data.length,
          examples: matched.slice(0, 3),
          invalid: !!String(rule.contains || '').trim() && !ruleMatcher(rule)
        };
      }
    });
  }

  /* --------------------------------------------------------- import pane */

  function kvTable(pairs) {
    var t = el('table', 'kv');
    pairs.forEach(function (p) {
      var tr = el('tr');
      tr.appendChild(el('th', null, p[0]));
      tr.appendChild(el('td', null, String(p[1])));
      t.appendChild(tr);
    });
    return t;
  }

  function countList(obj) {
    var keys = Object.keys(obj).sort(function (a, b) { return obj[b] - obj[a]; });
    var wrap = el('div', 'chips');
    keys.forEach(function (k) {
      var known = packages().indexOf(k) !== -1;
      var chip = el('span', 'chip' + (known ? '' : ' chip-warn'), k + ' · ' + obj[k]);
      if (!known) chip.title = k + ' is not one of the 15 package buckets, so it will not ' +
        'appear in any outlet PACKAGE total.';
      wrap.appendChild(chip);
    });
    return wrap;
  }

  function buildImportPane() {
    var pane = document.getElementById('tpl-import').content.cloneNode(true);

    $('#dropTarget', pane).onclick = function () { $('#fileInput').click(); };
    $('#btnPickFile', pane).onclick = function (e) { e.stopPropagation(); $('#fileInput').click(); };

    // The same setting as the Control Panel's "Import only rooms whose status…",
    // surfaced here because it is the one people flip day to day.
    var chk = $('#chkCheckedIn', pane);
    chk.checked = !!conf().opera.checkedInOnly;
    chk.onchange = function () {
      var next = JSON.parse(window.GihConfig.toJson());
      next.opera.checkedInOnly = this.checked;
      window.GihConfig.save(next);
      if (state.rawSheets) {
        reconvert();
        save();
        render();
      } else {
        render();
        if (state.lastImport && state.lastImport.kind === 'opera') {
          toast('Upload the Opera file again to apply this — it is not kept after a refresh.');
        }
      }
    };

    // The Dhathuru upload.
    var dhaInput = $('#dhathuruInput', pane);
    var pickDha = function () { dhaInput.click(); };
    $('#dhaDropTarget', pane).onclick = pickDha;
    $('#btnPickDhathuru', pane).onclick = function (e) { e.stopPropagation(); pickDha(); };
    dhaInput.onchange = function () {
      importDhathuruFile(this.files[0]);
      this.value = '';
    };

    var dhaReport = $('#dhathuruReport', pane);
    var imp2 = state.dhathuruImport;
    if (imp2) {
      var keys2 = Object.keys(imp2.found);
      if (keys2.length) {
        var okLine = el('p', 'ok', 'Read from ' + imp2.file + ':');
        dhaReport.appendChild(okLine);
        var ul2 = el('ul', 'notes');
        keys2.forEach(function (k) {
          ul2.appendChild(el('li', null, imp2.found[k].rows.length + ' × ' +
            imp2.found[k].label + ' (sheet "' + imp2.found[k].sheet + '")'));
        });
        dhaReport.appendChild(ul2);
      } else {
        dhaReport.appendChild(el('p', 'muted',
          'Nothing in ' + imp2.file + ' looked like a Room Move, Celebration or ' +
          'Haharu Host table. The reader matches on column headings — these are ' +
          'the ones it saw, so they are what it needs to be taught:'));
        imp2.seen.forEach(function (s) {
          var box = el('div', 'dha-seen');
          box.appendChild(el('strong', null, s.name + ' (' + s.rows + ' rows)'));
          box.appendChild(el('span', null, s.headings.length
            ? s.headings.join(' · ') : 'no headings found'));
          dhaReport.appendChild(box);
        });
      }
    }

    var build = $('#btnBuildTemplate', pane);
    build.disabled = !state.data.length;
    build.onclick = buildTemplate;

    $('#btnBuildCount', pane).textContent = state.data.length
      ? state.data.length + ' rooms ready'
      : 'no data loaded';

    var out = $('#importReport', pane);
    var imp = state.lastImport;

    if (!imp) {
      out.appendChild(el('p', 'muted',
        'No file imported in this session — the app is running on ' + state.source + '.'));
      return pane;
    }

    if (imp.kind === 'gih') {
      out.appendChild(el('p', 'ok',
        imp.file + ' was read as a GIH workbook, so no conversion was needed.'));
      if (state.commentOverrides) {
        out.appendChild(el('p', 'muted', state.commentOverrides +
          ' room(s) had their meal plan overridden by a comment rule.'));
      }
      return pane;
    }

    var rep = imp.report;
    out.appendChild(el('h2', null, 'Conversion of ' + imp.file));
    out.appendChild(kvTable([
      ['Source sheet', rep.sheetName + ' (header on row ' + rep.headerRow + ')'],
      ['Opera guest rows read', rep.guestRows],
      ['Rooms after grouping', rep.rooms],
      ['Guest names carried over', rep.guests],
      ['Adults / Children', rep.adults + ' / ' + rep.child],
      ['Rooms with a comment', rep.withComment],
      ['Meal plan taken from "Extra Meal Plan"', rep.planOverrides],
      ['Meal plan overridden by a comment rule', state.commentOverrides || 0]
    ]));

    var notes = [];
    if (rep.mergedRooms.length) {
      notes.push('Merged ' + rep.mergedRooms.length + ' duplicate room' +
        (rep.mergedRooms.length === 1 ? '' : 's') + ' (' + rep.mergedRooms.join(', ') +
        ') — XLOOKUP only ever finds the first match, so split reservations are combined.');
    }
    if (rep.droppedByStatus) {
      notes.push('Left out ' + rep.droppedByStatus + ' room(s) that are not CHECKED IN.');
    }
    if (rep.orphanRows) {
      notes.push('Skipped ' + rep.orphanRows + ' row(s) that appeared before the first room number.');
    }
    if (notes.length) {
      var ul = el('ul', 'notes');
      notes.forEach(function (n) { ul.appendChild(el('li', null, n)); });
      out.appendChild(ul);
    }

    out.appendChild(el('h3', null, 'Reservation status'));
    out.appendChild(countList(rep.statuses));
    out.appendChild(el('h3', null, 'Meal plans'));
    out.appendChild(countList(rep.plans));
    out.appendChild(el('p', 'muted',
      'Plans shown in amber are not among the 15 package buckets the outlet sheets total, ' +
      'so those covers land in no PACKAGE row.'));

    return pane;
  }

  // A GIH export is a snapshot of one business date, so the latest arrival in
  // the list is that date. If today falls outside the window every outlet would
  // read empty for no obvious reason, so snap to the snapshot date instead.
  function snapDateToData() {
    if (houseList(state.bizDate).length) return;
    var arrivals = state.data.map(function (r) { return r.arrival; }).filter(Boolean).sort();
    if (!arrivals.length) return;
    var snap = arrivals[arrivals.length - 1];
    state.bizDate = snap;
    toast('No rooms in house today - business date set to ' + fmtDate(snap));
  }

  /* ----------------------------------------------------------------- wire */

  function wire() {
    $('#bizDate').onchange = function () {
      if (!may('bizDate')) {
        this.value = state.bizDate;
        toast('You do not have rights to change the business date.', true);
        return;
      }
      state.bizDate = this.value || todayIso();
      // Online, each business date is its own shared document, so switching
      // date means loading that day rather than re-filtering this one.
      if (window.GihApi.isOnline()) loadDay(state.bizDate);
      else { save(); render(); }
    };

    $('#fileInput').onchange = function () {
      importFile(this.files[0]);
      this.value = '';
    };

    $('#btnPrint').onclick = function () { window.print(); };

    $('#btnReset').onclick = function () {
      if (!may('reset')) {
        toast('You do not have rights to reset the day.', true);
        return;
      }

      // Online, Reset empties the day for everybody, so say so plainly.
      if (window.GihApi.isOnline()) {
        var seated = outletNames().reduce(function (t, o) {
          return t + (state.outlets[o] || []).length;
        }, 0);
        if (!confirm('Clear all ' + seated + ' seated covers for ' +
          fmtDate(state.bizDate) + ' on every station? The guest list is kept.')) return;

        window.GihApi.resetDay(state.bizDate, station()).then(function (res) {
          if (!res.ok) { toast('Not reset: ' + res.error, true); return; }
          adoptDay(res.body.day, true);
          saveLocalOnly();
          render();
          toast('Cleared ' + res.body.cleared + ' covers for ' + fmtDate(state.bizDate) + '.');
        });
        return;
      }

      if (!confirm('Reset to the bundled seed data and clear all outlet seating?')) return;
      localStorage.removeItem(STORE_KEY);
      state.outlets = {};
      state.bizDate = todayIso();
      state.lastImport = null;
      state.rawSheets = null;
      setData((window.GIH_SEED || []).slice(), 'seed data');
      snapDateToData();
      save();
      render();
      toast('Reset');
    };

    // Drag & drop a workbook anywhere on the page.
    var dz = $('#dropzone');
    var depth = 0;
    window.addEventListener('dragenter', function (e) {
      e.preventDefault();
      if (++depth === 1) dz.classList.add('on');
    });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('dragleave', function () {
      if (--depth <= 0) { depth = 0; dz.classList.remove('on'); }
    });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      dz.classList.remove('on');
      importFile(e.dataTransfer.files[0]);
    });

    // Ctrl+P prints the active cover sheet; Ctrl+F focuses search on the GIH tab.
    window.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f' && state.active === 'GIH') {
        var s = $('#gihSearch');
        if (s) { e.preventDefault(); s.focus(); s.select(); }
      }
    });
  }

  /* -------------------------------------------------------------- connect */

  // Settings are written to the server once it is there, and to this browser
  // when it is not. Either way the in-memory copy has already changed, so the
  // screen never waits on the network.
  function installSettingsTransport() {
    window.GihConfig.setTransport(function (settings, before) {
      if (!window.GihApi.isOnline()) return;

      // Flipping Lunch/Dinner is a settings write, but it is an operational one.
      // Someone given only that right may make it and nothing else.
      var onlyService = settings.service !== before.service &&
        JSON.stringify(Object.assign({}, settings, { service: before.service })) ===
          JSON.stringify(before);

      if (!(may('settings') || (onlyService && may('service')))) {
        window.GihConfig.adopt(before);
        render();
        toast(onlyService
          ? 'You do not have rights to switch service.'
          : 'You do not have rights to change the settings.', true);
        return;
      }
      window.GihApi.putSettings(settings, station()).then(function (res) {
        if (res.ok) {
          remote.settingsRevision = res.body.revision;
          return;
        }
        // Put back what was there rather than leaving this station showing
        // settings the server never accepted.
        window.GihConfig.adopt(before);
        render();
        toast('Settings not saved: ' + res.error, true);
      });
    });
  }

  function renderConnection() {
    var box = $('#connection');
    if (!box) return;
    box.innerHTML = '';

    var online = window.GihApi.isOnline();
    var admin = window.GihApi.isAdmin();
    var signedIn = window.GihApi.isSignedIn();
    box.className = 'conn ' + (online ? (admin ? 'admin' : signedIn ? 'user' : 'shared') : 'local');

    box.appendChild(el('span', 'conn-dot'));
    box.appendChild(el('span', 'conn-label',
      !online ? 'This PC only'
        : admin ? 'Admin'
        : signedIn ? window.GihApi.whoName()
        : 'Shared'));

    var action = el('button', 'conn-btn', online ? (signedIn ? 'Sign out' : 'Sign in') : 'Retry');
    action.type = 'button';
    action.onclick = online
      ? (signedIn ? doLogout : promptLogin)
      : function () { connect(true); };
    box.appendChild(action);

    if (!online) {
      box.title = (window.GihApi.state.lastError || 'No server') +
        ' Working from this browser only; nothing is shared.';
    } else if (admin) {
      box.title = 'Signed in as admin — everything is open to you.';
    } else {
      var allowed = window.GihConfig.RIGHTS
        .filter(function (r) { return may(r.key); })
        .map(function (r) { return r.label; });
      box.title = (signedIn ? 'Signed in as ' + window.GihApi.whoName() : 'Not signed in') +
        '. ' + (allowed.length ? 'You may: ' + allowed.join('; ') + '.' : 'View only.');
    }
  }

  // A proper form rather than chained browser prompts: two accounts' worth of
  // fields, one error line, and Enter submits.
  function promptLogin() {
    var box = $('#signin');
    var name = $('#signinName');
    var pass = $('#signinPass');
    var err = $('#signinError');

    err.hidden = true;
    pass.value = '';
    box.hidden = false;
    setTimeout(function () { name.focus(); name.select(); }, 0);

    var close = function () {
      box.hidden = true;
      pass.value = '';
      err.hidden = true;
    };

    $('#signinCancel').onclick = close;
    box.onmousedown = function (e) { if (e.target === box) close(); };
    box.onkeydown = function (e) { if (e.key === 'Escape') close(); };

    $('#signinForm').onsubmit = function (e) {
      e.preventDefault();
      err.hidden = true;
      window.GihApi.login(pass.value, name.value.trim()).then(function (res) {
        if (!res.ok) {
          err.textContent = res.error;
          err.hidden = false;
          pass.value = '';
          pass.focus();
          return;
        }
        close();
        toast('Signed in as ' + (res.body.name || 'admin') + '.');
        connect(false);
      });
    };
  }

  function doLogout() {
    window.GihApi.logout().then(function () {
      toast('Signed out.');
      render();
    });
  }

  // Talks to the server and adopts whatever it says. Falls back to whatever this
  // browser already had when there is no server to talk to.
  function connect(announce) {
    return window.GihApi.bootstrap(state.bizDate).then(function (res) {
      if (!res.ok) {
        if (announce) toast(res.error || 'Still no server — working locally.', true);
        render();
        return false;
      }

      var b = res.body;
      remote.settingsRevision = b.settingsRevision;
      if (b.settings && Object.keys(b.settings).length) window.GihConfig.adopt(b.settings);

      if (b.day) {
        adoptDay(b.day, b.dayExists);
        if (b.day.bizDate) state.bizDate = b.day.bizDate;
      }

      saveLocalOnly();
      startPolling();
      render();
      if (announce) toast('Connected — sharing with the other stations.');
      return true;
    });
  }

  /* ----------------------------------------------------------------- boot */

  if (!load()) {
    setData((window.GIH_SEED || []).slice(), 'seed data - GIH Report.xlsx');
    snapDateToData();
  } else {
    setData(state.data, state.source);
  }

  wire();
  // Any settings change repaints the chrome, whoever made it.
  window.GihConfig.subscribe(applyTheme);

  // Gaining or losing admin changes what is on screen - which tabs show, which
  // cells are editable - so it needs a full repaint, not just the badge. A
  // session quietly expiring goes through here too. Anything else that moves
  // (online, offline) only touches the badge, so typing is never interrupted.
  // What someone may do decides what is on screen - which tabs show, which
  // cells are editable, whether the date and service switches work - so any
  // change to the rights set needs a full repaint, not just the badge. Signing
  // in as one user after another changes the rights without changing `admin`,
  // and a session quietly expiring goes through here too. Anything else that
  // moves (online, offline) only touches the badge, so typing is never
  // interrupted.
  // Everything about who you are that changes what is on screen: the rights
  // decide which controls work, the hidden tabs decide which tabs exist, and
  // the name decides what the badge says. One fingerprint over the lot, so a
  // new piece of identity added later cannot be forgotten here.
  function identity() {
    var s = window.GihApi.state;
    return JSON.stringify([s.admin, s.who, s.name, s.rights, s.hiddenTabs]);
  }

  var lastIdentity = identity();
  window.GihApi.subscribe(function () {
    var now = identity();
    if (now !== lastIdentity) {
      lastIdentity = now;
      render();
      return;
    }
    renderConnection();
  });
  installSettingsTransport();
  applyTheme();
  render();

  // The local view is already on screen; the server only ever improves on it.
  connect(false);
})();
