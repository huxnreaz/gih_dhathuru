/* Opera "Guest INH - Meal Plan" report  ->  GIH records.
 *
 * The Opera export is one row per *guest*, with the room-level fields
 * (Room No., Room Type, Resv. Status, Arrival, Departure) written only on the
 * first row of each reservation and left blank on the rows below it. The GIH
 * workbook wants one row per *room*, so this module walks the sheet, groups the
 * guest rows under the room row above them, and folds each group into a single
 * record.
 *
 * Folding rules, read off GIH Report.xlsx:
 *   Guest Name  every non-empty name in the group, joined with newlines
 *   Adults      sum over the group (Opera puts the party total on one row)
 *   Child       sum over the group
 *   MealPlan    Extra Meal Plan when present, otherwise MealPlan
 *   Comment     the distinct non-empty comments, joined with newlines
 *   Remarks     always blank - it is the one column staff fill in by hand
 *
 * Exposes: window.Opera.{ detect, looksLikeOpera, convert }
 */
(function () {
  'use strict';

  var HEADERS = {
    room:      ['room no.', 'room no', 'room number', 'room'],
    roomType:  ['room type', 'roomtype'],
    status:    ['resv. status', 'resv status', 'reservation status', 'status'],
    arrival:   ['arrival date', 'arrival'],
    departure: ['departure date', 'departure'],
    guest:     ['guest name', 'guest'],
    adults:    ['adults', 'adult'],
    child:     ['child', 'children', 'kids'],
    vip:       ['vip'],
    block:     ['block code'],
    rate:      ['rate code'],
    email:     ['email', 'e-mail'],
    member:    ['membership type', 'membership'],
    meal:      ['mealplan', 'meal plan'],
    extraMeal: ['extra meal plan', 'extra mealplan'],
    source:    ['source code', 'source'],
    comment:   ['comment', 'comments']
  };

  // Columns only an Opera export has. Two of them is enough to tell it apart
  // from the GIH workbook, which also has Room No / Guest Name / MealPlan but
  // no Room Type, Resv. Status or Extra Meal Plan.
  var OPERA_ONLY = ['roomType', 'status', 'extraMeal', 'rate', 'block'];

  var HEADER_SCAN_ROWS = 40;

  function shape(s) { return String(s || '').replace(/[^A-Z0-9]/gi, '').toUpperCase(); }

  // Opera writes some plan codes without the punctuation the GIH workbook uses
  // ("FBCSAI" for the "FBC+SAI" bucket). Matching on letters and digits alone
  // puts those covers back in the right PACKAGE row; the settings can add
  // outright renames on top of that.
  function planLookup() {
    var conf = window.GihConfig.get();
    var byShape = {};
    conf.packages.forEach(function (b) { byShape[shape(b)] = b; });
    Object.keys(conf.opera.planAliases || {}).forEach(function (from) {
      byShape[shape(from)] = conf.opera.planAliases[from];
    });
    return byShape;
  }

  function norm(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }
  function key(v) { return norm(v).toLowerCase(); }

  // Maps one row of cells onto field names. Returns null when it is not a header.
  function mapHeader(row) {
    if (!row) return null;
    var map = {};
    for (var i = 0; i < row.length; i++) {
      var h = key(row[i]);
      if (!h) continue;
      for (var field in HEADERS) {
        if (map[field] !== undefined) continue;
        if (HEADERS[field].indexOf(h) !== -1) { map[field] = i; break; }
      }
    }
    if (map.room === undefined || map.guest === undefined) return null;
    var hits = 0;
    OPERA_ONLY.forEach(function (f) { if (map[f] !== undefined) hits++; });
    return hits >= 2 ? map : null;
  }

  // Opera writes its title in A1 and then, on page breaks, leaks that same title
  // into unrelated cells (VIP, Block Code, Extra Meal Plan). Treat it as noise.
  function noiseTest(rows) {
    var title = '';
    for (var i = 0; i < Math.min(rows.length, 3); i++) {
      var first = norm((rows[i] || [])[0]);
      if (first) { title = first.toLowerCase(); break; }
    }
    return function (v) {
      var s = key(v);
      return !s || (!!title && s === title);
    };
  }

  // Finds the header row in a sheet. Returns {headerRow, map} or null.
  function findHeader(rows) {
    var limit = Math.min(rows.length, HEADER_SCAN_ROWS);
    for (var i = 0; i < limit; i++) {
      var map = mapHeader(rows[i]);
      if (map) return { headerRow: i, map: map };
    }
    return null;
  }

  // Picks the Opera sheet out of a workbook read by XlsxReader.readWorkbook.
  function detect(sheets) {
    var best = null;
    (sheets || []).forEach(function (sheet) {
      var found = findHeader(sheet.rows);
      if (!found) return;
      var body = sheet.rows.length - found.headerRow - 1;
      if (!best || body > best.body) {
        best = { sheet: sheet, headerRow: found.headerRow, map: found.map, body: body };
      }
    });
    return best;
  }

  function looksLikeOpera(sheets) { return !!detect(sheets); }

  function toInt(v) {
    var n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? Math.round(n) : 0;
  }

  function toDate(v) {
    var s = norm(v);
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    if (/^\d+(\.\d+)?$/.test(s)) {
      var n = parseFloat(s);
      if (n > 20000 && n < 90000) return window.XlsxReader.serialToIso(n);
    }
    var d = new Date(s);
    if (isNaN(d)) return '';
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  // Rooms sort numerically where they can (104 before 1204), else lexically.
  function roomSort(a, b) {
    var aNum = /^\d+$/.test(a.room), bNum = /^\d+$/.test(b.room);
    if (aNum && bNum) return parseInt(a.room, 10) - parseInt(b.room, 10);
    if (aNum) return -1;
    if (bNum) return 1;
    return a.room < b.room ? -1 : a.room > b.room ? 1 : 0;
  }

  // Folds one reservation's rows into a single GIH record.
  function fold(group, map, isNoise, opts) {
    var plans = opts.plans;
    var canonicalPlan = function (v) {
      var s = norm(v).toUpperCase();
      return s ? (plans[shape(s)] || s) : '';
    };
    var head = group[0];
    var cell = function (row, field) {
      return map[field] === undefined ? '' : norm(row[map[field]]);
    };
    var clean = function (row, field) {
      var v = cell(row, field);
      return isNoise(v) ? '' : v;
    };

    var names = [], comments = [], seenComment = {};
    var adults = 0, child = 0, meal = '', extra = '', status = '', vip = '';

    group.forEach(function (row) {
      var name = clean(row, 'guest');
      if (name) names.push(name);

      adults += toInt(cell(row, 'adults'));
      child += toInt(cell(row, 'child'));

      if (!meal) meal = canonicalPlan(clean(row, 'meal'));
      if (!extra) extra = canonicalPlan(clean(row, 'extraMeal'));
      if (!status) status = clean(row, 'status').toUpperCase();
      if (!vip) vip = clean(row, 'vip');

      var c = clean(row, 'comment');
      if (c && !seenComment[c]) { seenComment[c] = true; comments.push(c); }
    });

    return {
      room: norm(head[map.room]),
      remarks: '',
      guest: names.join('\n'),
      meal: (opts.preferExtraMealPlan && extra) || meal || extra,
      adults: adults,
      child: child,
      arrival: toDate(cell(head, 'arrival')),
      departure: toDate(cell(head, 'departure')),
      comment: comments.join('\n'),
      // Kept for the import review panel only; not written to the workbook.
      _status: status,
      _vip: vip,
      _roomType: clean(head, 'roomType'),
      _guests: names.length,
      _basePlan: meal,
      _extraPlan: extra
    };
  }

  /* Converts an Opera workbook into GIH records plus a conversion report.
   * Rules come from the Control Panel; `options` overrides them per call. */
  function convert(sheets, options) {
    var conf = window.GihConfig.get().opera;
    var over = options || {};
    var opts = {
      preferExtraMealPlan: over.preferExtraMealPlan != null
        ? over.preferExtraMealPlan : conf.preferExtraMealPlan,
      mergeDuplicateRooms: over.mergeDuplicateRooms != null
        ? over.mergeDuplicateRooms : conf.mergeDuplicateRooms,
      checkedInOnly: over.checkedInOnly != null ? over.checkedInOnly : conf.checkedInOnly,
      inHouseStatuses: (over.inHouseStatuses || conf.inHouseStatuses || [])
        .map(function (s) { return String(s).toUpperCase(); }),
      plans: planLookup()
    };
    var found = detect(sheets);
    if (!found) {
      throw new Error(
        'This does not look like an Opera "Guest INH - Meal Plan" export - no header ' +
        'row with Room No. and Guest Name plus Opera-only columns was found.'
      );
    }

    var rows = found.sheet.rows;
    var map = found.map;
    var isNoise = noiseTest(rows);
    var groups = [];
    var current = null;
    var orphanRows = 0;

    for (var i = found.headerRow + 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row) continue;

      // A repeated header (Opera prints one per page) is not data.
      if (mapHeader(row)) continue;

      var hasAny = false;
      for (var j = 0; j < row.length; j++) {
        if (norm(row[j]) !== '') { hasAny = true; break; }
      }
      if (!hasAny) continue;

      var room = norm(row[map.room]);
      if (room && !isNoise(room)) {
        current = [row];
        groups.push(current);
      } else if (current) {
        current.push(row);
      } else {
        orphanRows++;
      }
    }

    var records = groups
      .map(function (g) { return fold(g, map, isNoise, opts); })
      .filter(function (r) { return r.room; });

    // The same room twice in one export (a split reservation) is merged, so the
    // workbook's XLOOKUP - which only ever finds the first match - is not lying.
    var byRoom = {}, merged = [], mergedRooms = [];
    records.forEach(function (r) {
      var prev = opts.mergeDuplicateRooms ? byRoom[r.room] : null;
      if (!prev) { byRoom[r.room] = r; merged.push(r); return; }
      mergedRooms.push(r.room);
      prev.guest = [prev.guest, r.guest].filter(Boolean).join('\n');
      prev.adults += r.adults;
      prev.child += r.child;
      prev._guests += r._guests;
      if (r.comment && prev.comment.indexOf(r.comment) === -1) {
        prev.comment = [prev.comment, r.comment].filter(Boolean).join('\n');
      }
      if (!prev.meal) prev.meal = r.meal;
      if (r.arrival && (!prev.arrival || r.arrival < prev.arrival)) prev.arrival = r.arrival;
      if (r.departure && (!prev.departure || r.departure > prev.departure)) prev.departure = r.departure;
    });

    var kept = merged;
    var droppedByStatus = 0;
    if (opts.checkedInOnly && opts.inHouseStatuses.length) {
      kept = merged.filter(function (r) {
        var ok = !r._status || opts.inHouseStatuses.some(function (s) {
          return r._status.indexOf(s) !== -1;
        });
        if (!ok) droppedByStatus++;
        return ok;
      });
    }

    kept.sort(roomSort);

    var statuses = {}, plans = {};
    kept.forEach(function (r) {
      var s = r._status || '(blank)';
      var p = r.meal || '(blank)';
      statuses[s] = (statuses[s] || 0) + 1;
      plans[p] = (plans[p] || 0) + 1;
    });

    return {
      rows: kept,
      report: {
        sheetName: found.sheet.name,
        headerRow: found.headerRow + 1,
        guestRows: groups.reduce(function (t, g) { return t + g.length; }, 0),
        rooms: kept.length,
        guests: kept.reduce(function (t, r) { return t + r._guests; }, 0),
        adults: kept.reduce(function (t, r) { return t + r.adults; }, 0),
        child: kept.reduce(function (t, r) { return t + r.child; }, 0),
        withComment: kept.filter(function (r) { return !!r.comment; }).length,
        planOverrides: kept.filter(function (r) {
          return r._extraPlan && r._extraPlan !== r._basePlan;
        }).length,
        mergedRooms: mergedRooms,
        droppedByStatus: droppedByStatus,
        orphanRows: orphanRows,
        statuses: statuses,
        plans: plans
      }
    };
  }

  window.Opera = { detect: detect, looksLikeOpera: looksLikeOpera, convert: convert };
})();
