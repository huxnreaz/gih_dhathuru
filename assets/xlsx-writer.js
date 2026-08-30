/* Writes a GIH Report workbook - the same nine sheets, formulas, package block
 * and conditional formatting as GIH Report.xlsx - from a list of GIH records.
 *
 * Dependency-free: a small ZIP writer (CRC32 + native CompressionStream, or
 * stored entries when the browser has none) and hand-built SpreadsheetML.
 *
 * Two deliberate differences from the source workbook, both to make the file
 * robust rather than to change what it does:
 *   - The outlet lookups are one scalar XLOOKUP per column instead of one
 *     spilling XLOOKUP across a column range. Same values, no #SPILL risk and
 *     no dynamic-array metadata to get wrong.
 *   - The PACKAGE blocks are styled cells rather than named Excel tables.
 *
 * Which sheets exist, how many room rows each holds, the package buckets, the
 * covers-breakdown lines, the highlight colours and the date format all come
 * from the Control Panel (window.GihConfig).
 *
 * Exposes: window.XlsxWriter.{ buildGihWorkbook, layout, derivedLines }
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ zip */

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function deflateRaw(bytes) {
    if (typeof CompressionStream === 'undefined') return Promise.resolve(null);
    try {
      var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Response(stream).arrayBuffer()
        .then(function (buf) { return new Uint8Array(buf); })
        .catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function dosTime(d) {
    return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  }
  function dosDate(d) {
    return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  }

  // Builds a ZIP from [{name, bytes}], deflating where the browser can.
  function zip(files) {
    var now = new Date();
    return Promise.all(files.map(function (f) {
      return deflateRaw(f.bytes).then(function (packed) {
        var useDeflate = packed && packed.length < f.bytes.length;
        return {
          name: f.name,
          method: useDeflate ? 8 : 0,
          data: useDeflate ? packed : f.bytes,
          size: f.bytes.length,
          crc: crc32(f.bytes)
        };
      });
    })).then(function (entries) {
      var enc = new TextEncoder();
      var locals = [], central = [], offset = 0;

      entries.forEach(function (e) {
        var name = enc.encode(e.name);
        var local = new Uint8Array(30 + name.length + e.data.length);
        var dv = new DataView(local.buffer);
        dv.setUint32(0, 0x04034b50, true);
        dv.setUint16(4, 20, true);            // version needed
        dv.setUint16(6, 0x0800, true);        // UTF-8 names
        dv.setUint16(8, e.method, true);
        dv.setUint16(10, dosTime(now), true);
        dv.setUint16(12, dosDate(now), true);
        dv.setUint32(14, e.crc, true);
        dv.setUint32(18, e.data.length, true);
        dv.setUint32(22, e.size, true);
        dv.setUint16(26, name.length, true);
        dv.setUint16(28, 0, true);
        local.set(name, 30);
        local.set(e.data, 30 + name.length);
        locals.push(local);

        var cd = new Uint8Array(46 + name.length);
        var cv = new DataView(cd.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, e.method, true);
        cv.setUint16(12, dosTime(now), true);
        cv.setUint16(14, dosDate(now), true);
        cv.setUint32(16, e.crc, true);
        cv.setUint32(20, e.data.length, true);
        cv.setUint32(24, e.size, true);
        cv.setUint16(28, name.length, true);
        cv.setUint32(42, offset, true);
        cd.set(name, 46);
        central.push(cd);

        offset += local.length;
      });

      var cdSize = central.reduce(function (t, c) { return t + c.length; }, 0);
      var eocd = new Uint8Array(22);
      var ev = new DataView(eocd.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, entries.length, true);
      ev.setUint16(10, entries.length, true);
      ev.setUint32(12, cdSize, true);
      ev.setUint32(16, offset, true);

      return new Blob(locals.concat(central, [eocd]), {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
    });
  }

  /* --------------------------------------------------------------- helpers */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      // Excel rejects raw control characters; keep tab/newline, drop the rest.
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  function colName(n) {
    var s = '';
    n = n + 1;
    while (n > 0) {
      var r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - r) / 26);
    }
    return s;
  }

  // yyyy-mm-dd -> Excel serial (1900 system, with Excel's phantom leap day).
  function isoToSerial(iso) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(String(iso || ''))) return null;
    var p = iso.slice(0, 10).split('-');
    var ms = Date.UTC(+p[0], +p[1] - 1, +p[2]);
    var n = ms / 86400000 + 25569;
    return isFinite(n) ? n : null;
  }

  function cellText(ref, style, text) {
    if (text === '' || text == null) return '';
    return '<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' +
      esc(text) + '</t></is></c>';
  }

  function cellNum(ref, style, value) {
    if (value == null || value === '') return '';
    return '<c r="' + ref + '" s="' + style + '"><v>' + value + '</v></c>';
  }

  function cellFormula(ref, style, formula) {
    return '<c r="' + ref + '" s="' + style + '"><f>' + esc(formula) + '</f></c>';
  }

  // A spilling (dynamic array) formula. Without cm="1" pointing at the XLDAPR
  // record in metadata.xml, Excel reads it back as a legacy implicit-
  // intersection formula and only ever shows the first result.
  function cellSpill(ref, style, formula) {
    return '<c r="' + ref + '" s="' + style + '" cm="1">' +
      '<f t="array" ref="' + ref + '">' + esc(formula) + '</f></c>';
  }

  /* ---------------------------------------------------------------- layout */

  var GIH_COLUMNS = [
    'Room No', 'Remarks', 'Guest Name', 'MealPlan', 'Adults', 'Child',
    'Arrival Date', 'Departure Date', 'Comment'
  ];

  var OUTLET_COLUMNS = [
    'Room No', 'Table #', 'Remarks', 'Guest Name', 'MealPlan', 'Adults', 'Child',
    'Arrival Date', 'Departure Date', 'Comment'
  ];

  function cfg() { return window.GihConfig.get(); }

  function packages() { return cfg().packages; }

  // Covers-breakdown lines, with bucket names resolved to their row offsets.
  // A name that no longer exists among the buckets is simply dropped.
  function derivedLines() {
    var buckets = packages();
    return window.GihConfig.breakdown().map(function (d) {
      return {
        label: window.GihConfig.serviceLabel(d.label, d.serviceLine),
        gapBefore: d.gapBefore || 0,
        adultsOnly: !!d.adultsOnly,
        plain: !!d.plain,
        rows: (d.buckets || []).map(function (name) { return buckets.indexOf(name); })
          .filter(function (i) { return i !== -1; })
      };
    });
  }

  // One entry per outlet sheet, in workbook order. `lastRow` is the last row a
  // room may be typed into; `pkgHeader` is the PACKAGE header row; `sources`
  // marks a roll-up sheet, which pulls its rooms from other sheets.
  function layout() {
    return cfg().outlets.map(function (o) {
      var lastRow = Math.max(2, (o.capacity || 100) + 1);
      var spec = {
        name: o.name,
        lastRow: lastRow,
        breakdown: !!o.breakdown && o.packageBlock !== false
      };
      if (o.packageBlock !== false) {
        spec.pkgHeader = lastRow + (o.packageGap == null ? 2 : o.packageGap);
      }
      if (o.rollupFrom && o.rollupFrom.length) spec.sources = o.rollupFrom.slice();
      return spec;
    });
  }

  /* ---------------------------------------------------------------- styles */

  // cellXfs indexes used below.
  var S = {
    base: 0, header: 1, wrap: 2, date: 3, num: 4,
    pkgHeader: 5, pkgLabel: 6, pkgNum: 7, total: 8,
    derivedLabel: 9, derivedValue: 10,
    legendDep: 11, legendArr: 12, legendRem: 13, room: 14
  };

  // Config colours arrive as #rrggbb; SpreadsheetML wants AARRGGBB.
  function argb(hex, fallback) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    return 'FF' + (m ? m[1] : fallback).toUpperCase();
  }

  function stylesXml() {
    var hl = cfg().highlight;
    var dep = argb(hl.dep, 'FF7575');
    var arr = argb(hl.arr, 'C5E0B4');
    var rem = argb(hl.rem, 'FFFF85');
    var band = argb(hl.band, 'F2F2F2');

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="' +
        esc(cfg().workbook.dateFormat || 'dd/mm/yyyy') + '"/></numFmts>' +
      '<fonts count="3">' +
        '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
        '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
        '<font><b/><sz val="11"/><color rgb="FF1F3864"/><name val="Calibri"/><family val="2"/></font>' +
      '</fonts>' +
      '<fills count="7">' +
        '<fill><patternFill patternType="none"/></fill>' +
        '<fill><patternFill patternType="gray125"/></fill>' +
        '<fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/><bgColor indexed="64"/></patternFill></fill>' +
        '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>' +
        '<fill><patternFill patternType="solid"><fgColor rgb="' + dep + '"/><bgColor indexed="64"/></patternFill></fill>' +
        '<fill><patternFill patternType="solid"><fgColor rgb="' + arr + '"/><bgColor indexed="64"/></patternFill></fill>' +
        '<fill><patternFill patternType="solid"><fgColor rgb="' + rem + '"/><bgColor indexed="64"/></patternFill></fill>' +
      '</fills>' +
      '<borders count="3">' +
        '<border><left/><right/><top/><bottom/><diagonal/></border>' +
        '<border><left style="thin"><color indexed="64"/></left><right style="thin"><color indexed="64"/></right>' +
          '<top style="thin"><color indexed="64"/></top><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border>' +
        '<border><left/><right/><top style="thin"><color indexed="64"/></top><bottom style="double"><color indexed="64"/></bottom><diagonal/></border>' +
      '</borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="15">' +
        // 0 base
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>' +
        // 1 header
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
        // 2 wrapped text
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
        // 3 date
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>' +
        // 4 number
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>' +
        // 5 package header
        '<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>' +
        // 6 package label
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>' +
        // 7 package number
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>' +
        // 8 total
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>' +
        // 9 derived label
        '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
        // 10 derived value
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
        // 11-13 legend swatches
        '<xf numFmtId="0" fontId="1" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>' +
        '<xf numFmtId="0" fontId="1" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>' +
        '<xf numFmtId="0" fontId="1" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>' +
        // 14 room number
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>' +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      // Conditional-format fills, in the workbook's priority order.
      '<dxfs count="4">' +
        '<dxf><fill><patternFill><bgColor rgb="' + dep + '"/></patternFill></fill></dxf>' +
        '<dxf><fill><patternFill><bgColor rgb="' + rem + '"/></patternFill></fill></dxf>' +
        '<dxf><fill><patternFill><bgColor rgb="' + arr + '"/></patternFill></fill></dxf>' +
        '<dxf><fill><patternFill><bgColor rgb="' + band + '"/></patternFill></fill></dxf>' +
      '</dxfs>' +
      '</styleSheet>';
  }

  // The four workbook rules, anchored on the top-left cell of `sqref`.
  // `depCol`/`arrCol`/`remCol` are absolute column letters; `firstRow` the anchor row.
  function conditionalFormatting(sqref, depCol, remCol, arrCol, firstRow) {
    return '<conditionalFormatting sqref="' + sqref + '">' +
      '<cfRule type="expression" dxfId="0" priority="1"><formula>$' + depCol + firstRow + '=TODAY()</formula></cfRule>' +
      '<cfRule type="expression" dxfId="1" priority="2"><formula>$' + remCol + firstRow + '&lt;&gt;""</formula></cfRule>' +
      '<cfRule type="expression" dxfId="2" priority="3"><formula>$' + arrCol + firstRow + '=TODAY()</formula></cfRule>' +
      '<cfRule type="expression" dxfId="3" priority="4"><formula>MOD(ROW(),2)=0</formula></cfRule>' +
      '</conditionalFormatting>';
  }

  /* ----------------------------------------------------------- sheet: GIH */

  // The frozen-header pane, or nothing when the setting is off.
  function freezePane() {
    return cfg().workbook.freezeHeader === false ? '' :
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>';
  }

  function selection() {
    return cfg().workbook.freezeHeader === false
      ? '<selection activeCell="A2" sqref="A2"/>'
      : '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>';
  }

  function colsXml(widths) {
    return '<cols>' + widths.map(function (w, i) {
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
    }).join('') + '</cols>';
  }

  function headerRowXml(labels) {
    return '<row r="1" ht="26" customHeight="1">' + labels.map(function (label, i) {
      return cellText(colName(i) + '1', S.header, label);
    }).join('') + '</row>';
  }

  function gihSheet(records) {
    var lastRow = Math.max(records.length + 1, 2);
    var rows = [headerRowXml(GIH_COLUMNS)];

    records.forEach(function (rec, i) {
      var r = i + 2;
      var arr = isoToSerial(rec.arrival);
      var dep = isoToSerial(rec.departure);
      // The room number must land as a number, the way the source workbook has
      // it: XLOOKUP is type-strict, and staff type 104 into an outlet, not "104".
      var room = /^\d+$/.test(rec.room)
        ? cellNum('A' + r, S.room, parseInt(rec.room, 10))
        : cellText('A' + r, S.room, rec.room);

      rows.push('<row r="' + r + '">' + room +
        cellText('B' + r, S.wrap, rec.remarks) +
        cellText('C' + r, S.wrap, rec.guest) +
        cellText('D' + r, S.num, rec.meal) +
        cellNum('E' + r, S.num, rec.adults) +
        cellNum('F' + r, S.num, rec.child) +
        (arr == null ? cellText('G' + r, S.date, '') : cellNum('G' + r, S.date, arr)) +
        (dep == null ? cellText('H' + r, S.date, '') : cellNum('H' + r, S.date, dep)) +
        cellText('I' + r, S.wrap, rec.comment) +
        '</row>');
    });

    // A table needs at least one data row even when the import was empty.
    if (!records.length) rows.push('<row r="2"><c r="A2" s="' + S.room + '"/></row>');

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<dimension ref="A1:I' + lastRow + '"/>' +
      '<sheetViews><sheetView showGridLines="0" tabSelected="1" workbookViewId="0">' +
      freezePane() + selection() + '</sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      colsXml([10, 16, 34, 11, 7, 7, 13, 13, 70]) +
      '<sheetData>' + rows.join('') + '</sheetData>' +
      conditionalFormatting('A2:I' + lastRow, 'H', 'B', 'G', 2) +
      '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>' +
      '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' +
      '<tableParts count="1"><tablePart r:id="rId1"/></tableParts>' +
      '</worksheet>';
  }

  function commentsTableXml(records) {
    var lastRow = Math.max(records.length + 1, 2);
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" ' +
      'name="Comments" displayName="Comments" ref="A1:I' + lastRow + '" totalsRowShown="0">' +
      '<autoFilter ref="A1:I' + lastRow + '"/>' +
      '<tableColumns count="' + GIH_COLUMNS.length + '">' +
      GIH_COLUMNS.map(function (c, i) {
        return '<tableColumn id="' + (i + 1) + '" name="' + esc(c) + '"/>';
      }).join('') +
      '</tableColumns>' +
      '<tableStyleInfo name="TableStyleLight9" showFirstColumn="0" showLastColumn="0" ' +
      'showRowStripes="1" showColumnStripes="0"/>' +
      '</table>';
  }

  /* -------------------------------------------------------- sheet: outlet */

  var LOOKUP_COLUMNS = [
    { col: 'C', field: 'Remarks', style: 'wrap', suffix: '&""' },
    { col: 'D', field: 'Guest Name', style: 'wrap' },
    { col: 'E', field: 'MealPlan', style: 'num' },
    { col: 'F', field: 'Adults', style: 'num' },
    { col: 'G', field: 'Child', style: 'num' },
    { col: 'H', field: 'Arrival Date', style: 'date' },
    { col: 'I', field: 'Departure Date', style: 'date' },
    { col: 'J', field: 'Comment', style: 'wrap' }
  ];

  function lookupFormula(row, field, suffix) {
    return '_xlfn.XLOOKUP($A' + row + ',Comments[Room No],Comments[' + field + '],"")' +
      (suffix || '');
  }

  function outletSheet(spec, specs) {
    var rows = [headerRowXml(OUTLET_COLUMNS)];
    var legend = cfg().workbook.legend === false ? {}
      : { 3: ['DEPARTURE', S.legendDep], 4: ['ARRIVAL', S.legendArr], 5: ['REMARKS', S.legendRem] };

    for (var r = 2; r <= spec.lastRow; r++) {
      var cells = '';

      // A roll-up sheet collects the rooms typed into the sheets it names.
      // The source workbook does this with TOCOL over a 3-D reference, which
      // Excel rejects - its own cached value for that cell is #VALUE!. Stacking
      // the columns explicitly gives the result it was reaching for.
      if (spec.sources && r === 2) {
        var stacked = spec.sources.map(function (name) {
          // Each source is read over its own room rows, not this sheet's - a
          // taller source would otherwise have its last rooms cut off.
          var src = specs.filter(function (s) { return s.name === name; })[0];
          // A quoted sheet reference doubles any apostrophe inside the name.
          return "'" + String(name).replace(/'/g, "''") + "'!A2:A" +
            ((src && src.lastRow) || spec.lastRow);
        }).join(',');
        cells += cellSpill('A2', S.room,
          '_xlfn.TOCOL(_xlfn.VSTACK(' + stacked + '),1)');
      }

      cells += LOOKUP_COLUMNS.map(function (lc) {
        return cellFormula(lc.col + r, S[lc.style], lookupFormula(r, lc.field, lc.suffix));
      }).join('');

      if (legend[r]) cells += cellText('M' + r, legend[r][1], legend[r][0]);
      rows.push('<row r="' + r + '">' + cells + '</row>');
    }

    var lastRow = spec.lastRow;

    if (spec.pkgHeader) {
      var pkgs = packages();
      var h = spec.pkgHeader;
      var first = h + 1;
      var totalRow = h + pkgs.length + 1;

      rows.push('<row r="' + h + '">' +
        cellText('E' + h, S.pkgHeader, 'PACKAGE') +
        cellText('F' + h, S.pkgHeader, 'ADULT') +
        cellText('G' + h, S.pkgHeader, 'KID') +
        '</row>');

      pkgs.forEach(function (pkg, i) {
        var r2 = first + i;
        rows.push('<row r="' + r2 + '">' +
          cellText('E' + r2, S.pkgLabel, pkg) +
          cellFormula('F' + r2, S.pkgNum,
            'SUMIF($E$2:$E$' + spec.lastRow + ',$E' + r2 + ',$F$2:$F$' + spec.lastRow + ')') +
          cellFormula('G' + r2, S.pkgNum,
            'SUMIF($E$2:$E$' + spec.lastRow + ',$E' + r2 + ',$G$2:$G$' + spec.lastRow + ')') +
          '</row>');
      });

      rows.push('<row r="' + totalRow + '">' +
        cellText('E' + totalRow, S.total, 'TOTAL') +
        cellFormula('F' + totalRow, S.total, 'SUM(F' + first + ':F' + (totalRow - 1) + ')') +
        cellFormula('G' + totalRow, S.total, 'SUM(G' + first + ':G' + (totalRow - 1) + ')') +
        '</row>');

      lastRow = totalRow;

      if (spec.breakdown) {
        // Measured off the source workbook: the block opens three rows below
        // the PACKAGE total, and each line carries its own leading gap.
        var cursor = totalRow + 3;
        derivedLines().forEach(function (d) {
          cursor += d.gapBefore;
          if (!d.rows.length) { cursor++; return; }
          var refs = function (letter) {
            return sumRefs(letter, first, d.rows);
          };
          var adultExpr = 'SUM(' + refs('F') + ')';
          var kidExpr = 'SUM(' + refs('G') + ')';
          var cells2 = cellText('E' + cursor, S.derivedLabel, d.label + ':');

          if (d.plain) {
            cells2 += cellFormula('F' + cursor, S.derivedValue, adultExpr);
          } else {
            cells2 += cellFormula('F' + cursor, S.derivedValue,
              'IF(' + adultExpr + '=0,"",' + adultExpr + '&" Adults")');
            if (!d.adultsOnly) {
              cells2 += cellFormula('G' + cursor, S.derivedValue,
                'IF(' + kidExpr + '=0,"",' + kidExpr + '&" Kids")');
            }
          }
          rows.push('<row r="' + cursor + '">' + cells2 + '</row>');
          cursor++;
        });
        lastRow = cursor - 1;
      }
    }

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<dimension ref="A1:M' + lastRow + '"/>' +
      '<sheetViews><sheetView showGridLines="0" workbookViewId="0">' +
      freezePane() + selection() + '</sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      colsXml([10, 10, 15, 34, 11, 7, 7, 13, 13, 62, 3, 3, 14]) +
      '<sheetData>' + rows.join('') + '</sheetData>' +
      conditionalFormatting('A2:J' + spec.lastRow, 'I', 'C', 'H', 2) +
      '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>' +
      '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' +
      '</worksheet>';
  }

  // Turns [0,1,2,3,4,5,6,8,9] into "F103:F109,F111:F112" - contiguous runs
  // collapse to ranges, exactly as the workbook writes them.
  function sumRefs(letter, first, offsets) {
    var sorted = offsets.slice().sort(function (a, b) { return a - b; });
    var parts = [];
    var i = 0;
    while (i < sorted.length) {
      var start = sorted[i];
      var end = start;
      while (i + 1 < sorted.length && sorted[i + 1] === end + 1) { end = sorted[++i]; }
      parts.push(start === end
        ? letter + (first + start)
        : letter + (first + start) + ':' + letter + (first + end));
      i++;
    }
    return parts.join(',');
  }

  /* -------------------------------------------------------------- package */

  function workbookXml(specs) {
    var names = ['Sheet1'].concat(specs.map(function (s) { return s.name; }));
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<workbookPr defaultThemeVersion="166925"/>' +
      '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="20000" windowHeight="12000"/></bookViews>' +
      '<sheets>' + names.map(function (n, i) {
        return '<sheet name="' + esc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
      }).join('') + '</sheets>' +
      // Every value in the file is a formula result; make Excel work them out on open.
      '<calcPr calcId="191029" fullCalcOnLoad="1"/>' +
      '</workbook>';
  }

  function workbookRelsXml(specs) {
    var n = specs.length + 1;
    var rels = [];
    for (var i = 1; i <= n; i++) {
      rels.push('<Relationship Id="rId' + i + '" Type="http://schemas.openxmlformats.org/' +
        'officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + i + '.xml"/>');
    }
    rels.push('<Relationship Id="rId' + (n + 1) + '" Type="http://schemas.openxmlformats.org/' +
      'officeDocument/2006/relationships/styles" Target="styles.xml"/>');
    rels.push('<Relationship Id="rId' + (n + 2) + '" Type="http://schemas.openxmlformats.org/' +
      'officeDocument/2006/relationships/sheetMetadata" Target="metadata.xml"/>');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rels.join('') + '</Relationships>';
  }

  // The one metadata record every spilling formula in the file points at.
  function metadataXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray">' +
      '<metadataTypes count="1"><metadataType name="XLDAPR" minSupportedVersion="120000" ' +
      'copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" ' +
      'clearFormats="1" clearComments="1" assign="1" coerce="1" cellMeta="1"/></metadataTypes>' +
      '<futureMetadata name="XLDAPR" count="1"><bk><extLst>' +
      '<ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}">' +
      '<xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/></ext>' +
      '</extLst></bk></futureMetadata>' +
      '<cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata>' +
      '</metadata>';
  }

  function contentTypesXml(specs) {
    var overrides = [
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
      '<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>',
      '<Override PartName="/xl/metadata.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"/>',
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    ];
    for (var i = 1; i <= specs.length + 1; i++) {
      overrides.push('<Override PartName="/xl/worksheets/sheet' + i + '.xml" ' +
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
    }
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      overrides.join('') + '</Types>';
  }

  function rootRelsXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>';
  }

  function corePropsXml(meta) {
    var now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>' + esc(meta.title) + '</dc:title>' +
      '<dc:description>' + esc(meta.description) + '</dc:description>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created>' +
      '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>' +
      '</cp:coreProperties>';
  }

  function appPropsXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
      'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Application>GIH Outlets Cover Report (web)</Application>' +
      '</Properties>';
  }

  /* ------------------------------------------------------------------ api */

  /* Builds the workbook. `records` are GIH records; resolves to a Blob. */
  function buildGihWorkbook(records, meta) {
    var recs = (records || []).slice();
    var info = meta || {};
    var enc = new TextEncoder();
    var files = [];
    var add = function (name, text) { files.push({ name: name, bytes: enc.encode(text) }); };

    // Read the layout once, so every part of the package agrees on it even if
    // the settings change while the file is being zipped.
    var specs = layout();
    var prop = cfg().property;

    add('[Content_Types].xml', contentTypesXml(specs));
    add('_rels/.rels', rootRelsXml());
    add('docProps/core.xml', corePropsXml({
      title: info.title || (prop.name ? prop.name + ' - ' + prop.reportTitle : prop.reportTitle),
      description: info.description ||
        ('Generated from ' + (info.source || 'an Opera Guest INH - Meal Plan export'))
    }));
    add('docProps/app.xml', appPropsXml());
    add('xl/workbook.xml', workbookXml(specs));
    add('xl/_rels/workbook.xml.rels', workbookRelsXml(specs));
    add('xl/styles.xml', stylesXml());
    add('xl/metadata.xml', metadataXml());
    add('xl/worksheets/sheet1.xml', gihSheet(recs));
    add('xl/worksheets/_rels/sheet1.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/' +
      'relationships/table" Target="../tables/table1.xml"/></Relationships>');
    add('xl/tables/table1.xml', commentsTableXml(recs));

    specs.forEach(function (spec, i) {
      add('xl/worksheets/sheet' + (i + 2) + '.xml', outletSheet(spec, specs));
    });

    return zip(files);
  }

  window.XlsxWriter = {
    buildGihWorkbook: buildGihWorkbook,
    layout: layout,
    derivedLines: derivedLines
  };
})();
