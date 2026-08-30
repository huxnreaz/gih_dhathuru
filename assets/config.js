/* Master settings.
 *
 * Everything the outlets, the package buckets, the covers breakdown, the import
 * rules and the generated workbook are built from lives here, so the Control
 * Panel can change any of it without a code edit. The defaults reproduce
 * GIH Report.xlsx exactly - including its own layout drift, like the PACKAGE
 * block sitting 2 rows below the data on Skipjack and 10 rows below it on
 * Charcoal and Tribe.
 *
 * Covers-breakdown lines refer to buckets by *name*, not by index, so renaming
 * or reordering a package does not silently re-point a total at the wrong one.
 *
 * Exposes: window.GihConfig.{ get, save, patch, reset, subscribe, toJson, fromJson }
 */
(function () {
  'use strict';

  var KEY = 'gih-web:settings:v1';

  var P = {
    AI: 'AI', SAI: 'SAI', PAI: 'PAI', BAI: 'BAI', SOFT: 'FB + SOFT BEV',
    FB: 'FB', HB: 'HB', BB: 'BB', FBCSAI: 'FBC+SAI', FBC: 'FBC', BBC: 'BBC',
    AIC: 'AIC', SAIC: 'SAIC', COMP: 'COMP', HBC: 'HBC'
  };

  // Built fresh each time so the two services never share array instances.
  function standardBreakdown() {
    return [
      { label: 'DINNER PKG', gapBefore: 0, adultsOnly: true, plain: false, serviceLine: true,
        buckets: [P.AI, P.SAI, P.PAI, P.BAI, P.SOFT, P.FB, P.HB, P.FBCSAI, P.FBC] },
      { label: 'GIH FOOD', gapBefore: 1, adultsOnly: true, plain: true,
        buckets: [P.AI, P.SAI, P.PAI, P.BAI, P.SOFT, P.FB, P.HB, P.BB, P.FBCSAI, P.FBC] },
      { label: 'GIH BEV', gapBefore: 0, adultsOnly: true, plain: true,
        buckets: [P.AI, P.SAI, P.PAI, P.BAI, P.SOFT, P.FBCSAI] },
      { label: 'AI', gapBefore: 1, buckets: [P.AI, P.BAI] },
      { label: 'PAI', gapBefore: 0, buckets: [P.PAI] },
      { label: 'SAI', gapBefore: 0, buckets: [P.SAI, P.SOFT, P.FBCSAI] },
      { label: 'FB', gapBefore: 0, buckets: [P.FB, P.FBC] },
      { label: 'HB', gapBefore: 0, buckets: [P.HB] },
      { label: 'BB', gapBefore: 1, buckets: [P.BB, P.BBC] },
      { label: 'ENT', gapBefore: 1, buckets: [P.AIC, P.SAIC, P.COMP, P.HBC] },
      { label: 'TOTAL', gapBefore: 1, total: true,
        buckets: [P.AI, P.SAI, P.PAI, P.BAI, P.SOFT, P.FB, P.HB, P.BB,
          P.FBCSAI, P.FBC, P.BBC, P.AIC, P.SAIC, P.COMP, P.HBC] }
    ];
  }

  var DEFAULTS = {
    property: {
      name: 'VFAR',
      reportTitle: 'Outlets Cover Report',
      fileName: 'GIH Report {date}',
      // Keys in the resort. 0 means "unknown", and the occupancy figure on the
      // Dhathuru sheet is left off rather than guessed.
      totalRooms: 0
    },

    // Which service the cover sheets are for. Lines flagged `serviceLine` take
    // their name from this, so the same setup covers both sittings.
    service: 'DINNER',

    ui: {
      // Staff rarely need the upload/build tab; an admin can put it away.
      importTab: true
    },

    // capacity   rows staff can type a room into (sheet rows 2 .. capacity+1)
    // packageGap blank rows between the last data row and the PACKAGE header
    // rollupFrom when set, column A collects the rooms typed into these sheets
    outlets: [
      { name: 'OT - Section 500', capacity: 200, packageBlock: true, breakdown: false, packageGap: 9 },
      { name: 'OT - Section Outdoor', capacity: 200, packageBlock: true, breakdown: false, packageGap: 9 },
      { name: 'OT - Section 700', capacity: 200, packageBlock: true, breakdown: false, packageGap: 9 },
      { name: 'Skipjack', capacity: 99, packageBlock: true, breakdown: true, packageGap: 2 },
      { name: 'Charcoal', capacity: 99, packageBlock: true, breakdown: true, packageGap: 10 },
      { name: 'Tribe', capacity: 99, packageBlock: true, breakdown: true, packageGap: 10 },
      {
        name: 'OT', capacity: 200, packageBlock: false, breakdown: false, packageGap: 9,
        rollupFrom: ['OT - Section 500', 'OT - Section Outdoor', 'OT - Section 700']
      },
      { name: 'OT - Breakfast', capacity: 200, packageBlock: true, breakdown: false, packageGap: 9 }
    ],

    packages: [
      P.AI, P.SAI, P.PAI, P.BAI, P.SOFT, P.FB, P.HB, P.BB,
      P.FBCSAI, P.FBC, P.BBC, P.AIC, P.SAIC, P.COMP, P.HBC
    ],

    // Which outlets the Master tab compiles. Empty means every outlet.
    master: { sources: [] },

    // What someone who has not signed in may do. Named users get their own set
    // (held on the server, since those carry passwords); an admin gets the lot.
    access: {
      anonymous: {
        seat: true,        // seat rooms and assign tables
        clear: false,      // empty a whole outlet in one go
        remarks: true,     // write the Remarks column
        master: false,     // save a Master snapshot to the server
        service: false,    // flip Lunch/Dinner
        bizDate: false,    // move the business date
        guestList: false,  // correct any other guest-list column
        gihAdd: false,     // put a blank line on the guest list
        gihWelcome: false, // bring Today’s Welcome onto the guest list
        importData: false, // upload an Opera report
        dhathuru: true,    // edit the Dhathuru sheet - floor work, like remarks
        reset: false,      // clear every outlet for the day
        settings: false    // change anything in the Control Panel
      },
      // Tabs someone who has not signed in does not see. Hiding tidies the
      // screen; it is not a lock, since the data is still on the API.
      anonymousTabs: []
    },

    // gapBefore   blank rows above this line, both on screen and in the workbook
    // plain       print a bare number instead of "n Adults" / "n Kids"
    // adultsOnly  no Kids figure for this line
    // serviceLine the leading LUNCH/DINNER in the label follows the `service`
    //             setting, so one line covers both sittings
    // One breakdown per service. Both start the same; an admin can take them
    // apart, because lunch and dinner do not always count the same way.
    breakdowns: {
      DINNER: standardBreakdown(),
      LUNCH: standardBreakdown()
    },

    opera: {
      preferExtraMealPlan: true,
      mergeDuplicateRooms: true,
      checkedInOnly: false,
      inHouseStatuses: ['CHECKED IN'],
      // Opera writes some codes without punctuation; matched on letters and
      // digits alone, so "FBCSAI" finds the "FBC+SAI" bucket on its own. Add an
      // entry here only for a code that does not simply lose its punctuation.
      planAliases: {}
    },

    // Meal plan overrides driven by the Comment text. The reservation comment
    // usually spells the real arrangement out ("COMP/1RO/1TRRT- Meals in Staff
    // Canteen") even when the MealPlan column does not. Rules are tried in
    // order and the first match wins; `onlyIfBlank` limits a rule to rooms that
    // arrived with no plan at all. Empty by default - nothing is second-guessed
    // until someone asks for it.
    commentRules: [],

    highlight: {
      dep: '#ff7575', arr: '#c5e0b4', rem: '#ffff85',
      band: '#f2f3f5', miss: '#ffe0e6'
    },

    workbook: {
      dateFormat: 'dd/mm/yyyy',
      freezeHeader: true,
      legend: true
    }
  };

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  // Fills in anything a saved settings blob is missing, one level into objects,
  // so a settings file written by an older build still loads.
  function withDefaults(saved) {
    var out = clone(DEFAULTS);
    if (!saved || typeof saved !== 'object') return out;

    // Before the Lunch/Dinner split there was one list. Carry it into both
    // services rather than quietly reverting somebody's breakdown to stock.
    if (Array.isArray(saved.derived) && !saved.breakdowns) {
      saved = clone(saved);
      saved.breakdowns = { DINNER: clone(saved.derived), LUNCH: clone(saved.derived) };
      delete saved.derived;
    }
    Object.keys(out).forEach(function (k) {
      if (saved[k] === undefined) return;
      if (Array.isArray(out[k])) {
        if (Array.isArray(saved[k])) out[k] = clone(saved[k]);
      } else if (out[k] && typeof out[k] === 'object') {
        Object.keys(saved[k] || {}).forEach(function (sub) { out[k][sub] = clone(saved[k][sub]); });
      } else {
        out[k] = saved[k];
      }
    });
    return out;
  }

  var current = (function () {
    try { return withDefaults(JSON.parse(localStorage.getItem(KEY))); }
    catch (e) { return clone(DEFAULTS); }
  })();

  var listeners = [];
  function notify() { listeners.forEach(function (fn) { try { fn(current); } catch (e) {} }); }

  // Where a change is written. Offline that is this browser; once the server is
  // reachable the app swaps in a transport that PUTs to it, so every station
  // sees the same settings. The in-memory copy updates either way, immediately,
  // and a rejected write is reported rather than silently dropped.
  var transport = null;

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(current)); }
    catch (e) { /* private mode - settings live for this session only */ }
  }

  function save(next, options) {
    var before = current;
    current = withDefaults(next);
    persist();
    notify();
    if (transport && !(options && options.local)) {
      transport(current, before);
    }
    return current;
  }

  // Replaces the in-memory settings without writing them back out - used when
  // the server tells us what the settings now are.
  function adopt(next) {
    current = withDefaults(next);
    persist();
    notify();
    return current;
  }

  // Replaces one top-level section.
  function patch(section, value) {
    var next = clone(current);
    next[section] = clone(value);
    return save(next);
  }

  function reset(section) {
    var next = section ? clone(current) : clone(DEFAULTS);
    if (section) next[section] = clone(DEFAULTS[section]);
    return save(next);
  }

  // True when nothing has been changed from the shipped defaults.
  function isDefault(section) {
    var a = section ? current[section] : current;
    var b = section ? DEFAULTS[section] : DEFAULTS;
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // "DINNER PKG" with the toggle on LUNCH reads "LUNCH PKG". A label with no
  // service word in it simply gains one.
  function serviceLabel(label, serviceLine) {
    var name = String(label || '');
    if (!serviceLine) return name;
    var service = String(current.service || 'DINNER').toUpperCase();
    var stripped = name.replace(/^\s*(LUNCH|DINNER|BREAKFAST)\s+/i, '');
    return service + ' ' + stripped;
  }

  function service() { return String(current.service || 'DINNER').toUpperCase(); }

  // The breakdown in force for the service that is switched on.
  function breakdown() {
    var byService = current.breakdowns || {};
    return byService[service()] || byService.DINNER || [];
  }

  window.GihConfig = {
    DEFAULTS: DEFAULTS,
    serviceLabel: serviceLabel,
    service: service,
    breakdown: breakdown,
    SERVICES: ['LUNCH', 'DINNER'],
    RIGHTS: [
      { key: 'seat', label: 'Seat rooms and assign tables' },
      { key: 'clear', label: 'Clear a whole outlet' },
      { key: 'remarks', label: 'Write the Remarks column' },
      { key: 'guestList', label: 'Correct any other guest-list column' },
      { key: 'gihAdd', label: 'Add a blank line to the guest list' },
      { key: 'gihWelcome', label: 'Add to the guest list from Today’s Welcome' },
      { key: 'bizDate', label: 'Change the business date' },
      { key: 'service', label: 'Switch Lunch / Dinner' },
      { key: 'master', label: 'Save a Master snapshot to the server' },
      { key: 'importData', label: 'Upload an Opera report' },
      { key: 'dhathuru', label: 'Edit the Dhathuru sheet' },
      { key: 'reset', label: 'Reset the day — clear every outlet' },
      { key: 'settings', label: 'Change Control Panel settings' }
    ],
    get: function () { return current; },
    save: save,
    adopt: adopt,
    setTransport: function (fn) { transport = fn; },
    patch: patch,
    reset: reset,
    isDefault: isDefault,
    subscribe: function (fn) { listeners.push(fn); },
    toJson: function () { return JSON.stringify(current, null, 2); },
    fromJson: function (text) { return save(JSON.parse(text)); },

    // Handy derived views the other modules ask for.
    outletNames: function () {
      return current.outlets.map(function (o) { return o.name; });
    },
    bucketIndex: function (name) { return current.packages.indexOf(name); }
  };
})();
