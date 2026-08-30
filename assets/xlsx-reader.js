/* Minimal, dependency-free .xlsx reader.
 *
 * Reads the ZIP container by hand and inflates entries with the browser's
 * native DecompressionStream('deflate-raw'), then parses the SpreadsheetML we
 * actually need: sharedStrings + worksheets. Enough for a GIH export; not a
 * general-purpose Excel library.
 *
 * Exposes: window.XlsxReader.readGih(File) -> Promise<{rows, sheetName}>
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ zip */

  function u16(dv, p) { return dv.getUint16(p, true); }
  function u32(dv, p) { return dv.getUint32(p, true); }

  // Locate the End Of Central Directory record by scanning backwards.
  function findEocd(dv) {
    var max = Math.min(dv.byteLength, 66000);
    for (var i = dv.byteLength - 22; i >= dv.byteLength - max; i--) {
      if (i < 0) break;
      if (u32(dv, i) === 0x06054b50) return i;
    }
    throw new Error('Not a zip file (no end-of-central-directory record).');
  }

  // Returns { name -> {method, start, compressedSize} } for every zip entry.
  function readCentralDirectory(buf) {
    var dv = new DataView(buf);
    var eocd = findEocd(dv);
    var count = u16(dv, eocd + 10);
    var cdOffset = u32(dv, eocd + 16);
    var dec = new TextDecoder('utf-8');
    var entries = {};
    var p = cdOffset;

    for (var i = 0; i < count; i++) {
      if (u32(dv, p) !== 0x02014b50) break;
      var method = u16(dv, p + 10);
      var compSize = u32(dv, p + 20);
      var nameLen = u16(dv, p + 28);
      var extraLen = u16(dv, p + 30);
      var commentLen = u16(dv, p + 32);
      var localOffset = u32(dv, p + 42);
      var name = dec.decode(new Uint8Array(buf, p + 46, nameLen));

      // Re-read the sizes from the local header: the central directory can
      // disagree with it when the writer used a data descriptor.
      if (u32(dv, localOffset) !== 0x04034b50) throw new Error('Bad local header for ' + name);
      var lNameLen = u16(dv, localOffset + 26);
      var lExtraLen = u16(dv, localOffset + 28);

      entries[name] = {
        method: method,
        start: localOffset + 30 + lNameLen + lExtraLen,
        compressedSize: compSize
      };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error(
        'This browser cannot unzip .xlsx files. Use Chrome or Edge 103+, or import a CSV instead.'
      ));
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer();
  }

  function readEntryText(buf, entries, name) {
    var e = entries[name];
    if (!e) return Promise.resolve(null);
    var slice = new Uint8Array(buf, e.start, e.compressedSize);
    var raw = e.method === 0 ? Promise.resolve(slice.buffer.slice(e.start, e.start + e.compressedSize))
                             : inflateRaw(slice);
    return raw.then(function (out) { return new TextDecoder('utf-8').decode(out); });
  }

  /* --------------------------------------------------------- spreadsheetml */

  function parseXml(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Malformed XML inside the workbook.');
    return doc;
  }

  // <si> can be a single <t> or a run of <r><t> fragments; concatenate either way.
  function parseSharedStrings(text) {
    if (!text) return [];
    var doc = parseXml(text);
    return Array.prototype.map.call(doc.getElementsByTagName('si'), function (si) {
      var ts = si.getElementsByTagName('t');
      var s = '';
      for (var i = 0; i < ts.length; i++) s += ts[i].textContent;
      return s;
    });
  }

  function colOf(ref) { return (ref || '').replace(/[0-9]/g, ''); }

  function colIndex(letters) {
    var n = 0;
    for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  }

  // Excel serial date -> yyyy-mm-dd. 1900 leap-year bug included, as Excel has it.
  function serialToIso(n) {
    var ms = Math.round((n - 25569) * 86400000);
    var d = new Date(ms);
    if (isNaN(d)) return '';
    return d.toISOString().slice(0, 10);
  }

  // <mergeCells> ranges, as {c1,r1,c2,r2} zero-based.
  function parseMerges(doc) {
    var els = doc.getElementsByTagName('mergeCell');
    var out = [];
    for (var i = 0; i < els.length; i++) {
      var m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(els[i].getAttribute('ref') || '');
      if (!m) continue;
      out.push({
        c1: colIndex(m[1]), r1: parseInt(m[2], 10) - 1,
        c2: colIndex(m[3]), r2: parseInt(m[4], 10) - 1
      });
    }
    return out;
  }

  /* Copies a merged cell's value into every cell it covers.
   *
   * A merged range only stores its value in the top-left cell, so a column
   * merged down four rows reads back as one value and three blanks. Off by
   * default and deliberately so: the Opera importer groups a reservation's
   * guest rows precisely by those blanks, and filling them would turn every
   * guest into their own booking.
   */
  function expandMerges(rows, merges) {
    merges.forEach(function (m) {
      var anchorRow = rows[m.r1];
      var anchor = anchorRow ? anchorRow[m.c1] : undefined;
      if (anchor === undefined || anchor === '') return;
      for (var r = m.r1; r <= m.r2; r++) {
        if (!rows[r]) rows[r] = [];
        for (var c = m.c1; c <= m.c2; c++) {
          if (rows[r][c] === undefined || rows[r][c] === '') rows[r][c] = anchor;
        }
      }
    });
    return rows;
  }

  // One worksheet -> array of arrays of strings, keeping both row and column
  // positions: rows are placed at their real sheet row, so a blank row in the
  // middle of a report does not shift everything below it up one.
  function parseSheet(text, strings, opts) {
    var doc = parseXml(text);
    var rowEls = doc.getElementsByTagName('row');
    var rows = [];
    for (var i = 0; i < rowEls.length; i++) {
      var rowNum = parseInt(rowEls[i].getAttribute('r'), 10);
      var at = isNaN(rowNum) ? rows.length : rowNum - 1;
      var cells = rowEls[i].getElementsByTagName('c');
      var row = [];
      for (var j = 0; j < cells.length; j++) {
        var c = cells[j];
        var t = c.getAttribute('t');
        var idx = colIndex(colOf(c.getAttribute('r')));
        var val = '';
        if (t === 'inlineStr') {
          var is = c.getElementsByTagName('t');
          for (var k = 0; k < is.length; k++) val += is[k].textContent;
        } else {
          var v = c.getElementsByTagName('v')[0];
          val = v ? v.textContent : '';
          if (t === 's' && val !== '') val = strings[parseInt(val, 10)] || '';
        }
        row[idx] = val;
      }
      rows[at] = row;
    }

    var merges = parseMerges(doc);
    if (opts && opts.expandMerges) expandMerges(rows, merges);
    rows.mergeCount = merges.length;
    return rows;
  }

  /* ------------------------------------------------------------ gih shape */

  var HEADER_ALIASES = {
    room: ['room no', 'room', 'room number', 'rm'],
    remarks: ['remarks', 'remark'],
    guest: ['guest name', 'guest', 'name'],
    meal: ['mealplan', 'meal plan', 'plan', 'package'],
    adults: ['adults', 'adult', 'ad'],
    child: ['child', 'children', 'kids', 'kid', 'ch'],
    arrival: ['arrival date', 'arrival', 'arr'],
    departure: ['departure date', 'departure', 'dep'],
    comment: ['comment', 'comments', 'notes']
  };

  // Maps a header row onto our field names; returns null if it is not a GIH header.
  function mapHeader(row) {
    var map = {};
    for (var i = 0; i < row.length; i++) {
      var h = String(row[i] || '').trim().toLowerCase();
      if (!h) continue;
      for (var field in HEADER_ALIASES) {
        if (map[field] !== undefined) continue;
        if (HEADER_ALIASES[field].indexOf(h) !== -1) { map[field] = i; break; }
      }
    }
    return (map.room !== undefined && map.guest !== undefined) ? map : null;
  }

  function toDate(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    if (/^\d+(\.\d+)?$/.test(s)) {
      var n = parseFloat(s);
      if (n > 20000 && n < 90000) return serialToIso(n);
    }
    var d = new Date(s);
    return isNaN(d) ? '' : d.toISOString().slice(0, 10);
  }

  function toInt(raw) {
    var n = parseInt(String(raw == null ? '' : raw).replace(/[^0-9-]/g, ''), 10);
    return isNaN(n) ? 0 : n;
  }

  function rowsToRecords(rows, map) {
    var out = [];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      if (!r) continue;
      var room = String(r[map.room] == null ? '' : r[map.room]).trim();
      if (!room || room.charAt(0) === '#') continue;
      var pick = function (f) {
        return map[f] === undefined ? '' : String(r[map[f]] == null ? '' : r[map[f]]).trim();
      };
      out.push({
        room: room,
        remarks: pick('remarks'),
        guest: pick('guest'),
        meal: pick('meal').toUpperCase(),
        adults: toInt(pick('adults')),
        child: toInt(pick('child')),
        arrival: toDate(pick('arrival')),
        departure: toDate(pick('departure')),
        comment: pick('comment')
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------ api */

  // Reads an .xlsx File into every worksheet it holds, as raw cell strings:
  //   { sheets: [ { name, rows: [ [cell, cell, ...], ... ] } ] }
  // Sheets keep workbook order, so a caller can tell "the sheet after this one".
  function readWorkbookXlsx(file, opts) {
    return file.arrayBuffer().then(function (buf) {
      var entries = readCentralDirectory(buf);
      var sheetNames = {};

      return readEntryText(buf, entries, 'xl/workbook.xml')
        .then(function (wbText) {
          // Sheet display names, in the same order the parts are numbered.
          if (wbText) {
            var els = parseXml(wbText).getElementsByTagName('sheet');
            for (var i = 0; i < els.length; i++) sheetNames[i + 1] = els[i].getAttribute('name');
          }
          return readEntryText(buf, entries, 'xl/sharedStrings.xml');
        })
        .then(function (ssText) {
          var strings = parseSharedStrings(ssText);
          var parts = Object.keys(entries)
            .filter(function (n) { return /^xl\/worksheets\/sheet\d+\.xml$/.test(n); })
            .sort(function (a, b) {
              return parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10);
            });
          if (!parts.length) throw new Error('No worksheets found in the workbook.');

          return parts.reduce(function (chain, part) {
            return chain.then(function (sheets) {
              return readEntryText(buf, entries, part).then(function (text) {
                var num = parseInt(part.match(/\d+/)[0], 10);
                sheets.push({
                  name: sheetNames[num] || ('Sheet' + num),
                  rows: parseSheet(text, strings, opts)
                });
                return sheets;
              });
            });
          }, Promise.resolve([]));
        })
        .then(function (sheets) { return { sheets: sheets }; });
    });
  }

  // Picks the richest GIH-shaped sheet out of an already-read workbook.
  function pickGihSheet(sheets) {
    var best = null;
    sheets.forEach(function (sheet) {
      if (!sheet.rows.length) return;
      var map = mapHeader(sheet.rows[0] || []);
      if (!map) return;
      var records = rowsToRecords(sheet.rows, map);
      if (best && best.rows.length >= records.length) return;
      best = { rows: records, sheetName: sheet.name };
    });
    return best;
  }

  function readXlsx(file) {
    return readWorkbookXlsx(file).then(function (wb) {
      var best = pickGihSheet(wb.sheets);
      if (!best || !best.rows.length) {
        throw new Error('No sheet with "Room No" and "Guest Name" columns was found.');
      }
      return best;
    });
  }

  /* ------------------------------------------------------------------ csv */

  function parseCsv(text) {
    var rows = [], row = [], cur = '', q = false;
    text = text.replace(/^﻿/, '');
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cur += '"'; i++; } else q = false;
        } else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (ch !== '\r') cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  function readCsv(file) {
    return file.text().then(function (text) {
      var rows = parseCsv(text);
      var map = mapHeader(rows[0] || []);
      if (!map) throw new Error('CSV needs at least "Room No" and "Guest Name" header columns.');
      return { rows: rowsToRecords(rows, map), sheetName: file.name };
    });
  }

  // A CSV is a one-sheet workbook, so callers can treat both the same way.
  // `opts.expandMerges` only means anything for .xlsx - a CSV has no merges,
  // and reports zero so a caller can tell the difference.
  function readWorkbook(file, opts) {
    if (!/\.csv$/i.test(file.name)) return readWorkbookXlsx(file, opts);
    return file.text().then(function (text) {
      var rows = parseCsv(text);
      rows.mergeCount = 0;
      return { sheets: [{ name: file.name, rows: rows }] };
    });
  }

  // Dispatches on file extension. Both paths return {rows, sheetName}.
  function readGih(file) {
    return /\.csv$/i.test(file.name) ? readCsv(file) : readXlsx(file);
  }

  window.XlsxReader = {
    readGih: readGih,
    readWorkbook: readWorkbook,
    pickGihSheet: pickGihSheet,
    serialToIso: serialToIso
  };
})();
