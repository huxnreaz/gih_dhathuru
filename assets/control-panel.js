/* Control Panel - the master settings editor.
 *
 * Reads and writes window.GihConfig. Everything here is a view over that one
 * object; nothing else in the app holds a copy, so a change takes effect on the
 * next render and on the next workbook build.
 *
 * Two renames are handled rather than left to bite later:
 *   - renaming an outlet moves its seating and repoints any roll-up that names it
 *   - renaming a package bucket repoints every covers-breakdown line that sums it
 *
 * Exposes: window.ControlPanel.build(api) -> DocumentFragment
 */
(function () {
  'use strict';

  var SECTIONS = [
    { id: 'property', label: 'Property & report' },
    { id: 'outlets', label: 'Outlets' },
    { id: 'packages', label: 'Package buckets' },
    { id: 'derived', label: 'Covers breakdown' },
    { id: 'opera', label: 'Import rules' },
    { id: 'commentRules', label: 'Plan from comment' },
    { id: 'highlight', label: 'Highlighting' },
    { id: 'workbook', label: 'Workbook output' },
    { id: 'manage', label: 'Settings file' },
    { id: 'users', label: 'Users & rights' },
    { id: 'server', label: 'Server & access' }
  ];

  var openSection = 'property';

  /* ------------------------------------------------------------- elements */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function field(label, control, hint) {
    var wrap = el('label', 'cp-field');
    wrap.appendChild(el('span', 'cp-label', label));
    wrap.appendChild(control);
    if (hint) wrap.appendChild(el('span', 'cp-hint', hint));
    return wrap;
  }

  function input(type, value, onCommit) {
    var i = el('input', 'cp-input');
    i.type = type;
    i.value = value == null ? '' : value;
    // Colours and numbers update live; free text waits for blur or Enter, so a
    // half-typed name never lands in the settings.
    i.addEventListener(type === 'color' ? 'input' : 'change', function () {
      onCommit(i.value);
    });
    return i;
  }

  function numberInput(value, min, max, onCommit) {
    var i = input('number', value, function (v) {
      var n = parseInt(v, 10);
      if (isNaN(n)) n = min;
      onCommit(Math.max(min, Math.min(max, n)));
    });
    i.min = min;
    i.max = max;
    return i;
  }

  function checkbox(label, checked, onCommit) {
    var wrap = el('label', 'cp-check');
    var i = el('input');
    i.type = 'checkbox';
    i.checked = !!checked;
    i.onchange = function () { onCommit(i.checked); };
    wrap.appendChild(i);
    wrap.appendChild(el('span', null, label));
    return wrap;
  }

  function button(label, cls, onClick) {
    var b = el('button', 'btn ' + (cls || ''), label);
    b.type = 'button';
    b.onclick = onClick;
    return b;
  }

  function iconButton(glyph, title, onClick, disabled) {
    var b = el('button', 'cp-icon', glyph);
    b.type = 'button';
    b.title = title;
    b.disabled = !!disabled;
    b.onclick = onClick;
    return b;
  }

  // Excel's rules for a worksheet name. An outlet name becomes a sheet name, so
  // it has to pass these or the generated workbook will not open.
  function sheetNameProblem(name) {
    if (!name) return 'An outlet needs a name.';
    if (name.length > 31) return 'Sheet names are limited to 31 characters.';
    if (/[:\\\/?*\[\]]/.test(name)) return 'Sheet names cannot contain :  \\  /  ?  *  [  ]';
    if (/^'|'$/.test(name)) return 'Sheet names cannot start or end with an apostrophe.';
    return null;
  }

  // Every breakdown line across every service - a bucket rename has to reach
  // the lines you are not currently looking at.
  function eachBreakdownLine(cfg, fn) {
    var byService = cfg.breakdowns || {};
    Object.keys(byService).forEach(function (svc) {
      (byService[svc] || []).forEach(fn);
    });
  }

  // Every tab that can be hidden, as {key, label}. Outlets come from settings
  // so the list follows whatever the outlets are called today.
  function tabChoices(cfg) {
    var out = [
      { key: 'IMPORT', label: 'Import & Template' },
      { key: 'GIH', label: 'Guest In House' }
    ];
    (cfg.outlets || []).forEach(function (o) { out.push({ key: o.name, label: o.name }); });
    out.push({ key: 'MASTER', label: 'Master' });
    out.push({ key: 'DHATHURU', label: 'Dhathuru' });
    out.push({ key: 'SETTINGS', label: 'Control Panel' });
    return out;
  }

  /* A grid of "can see" ticks. `hidden` is the deny list, so a tab added later
   * shows up by default rather than being invisible until someone notices. */
  function tabPicker(cfg, hidden, onChange) {
    var box = el('div', 'cp-rights');
    tabChoices(cfg).forEach(function (t) {
      box.appendChild(checkbox(t.label, hidden.indexOf(t.key) === -1, function (on) {
        var next = hidden.slice();
        var at = next.indexOf(t.key);
        if (!on && at === -1) next.push(t.key);
        if (on && at !== -1) next.splice(at, 1);
        onChange(next);
      }));
    });
    return box;
  }

  function move(list, from, to) {
    if (to < 0 || to >= list.length) return false;
    var item = list.splice(from, 1)[0];
    list.splice(to, 0, item);
    return true;
  }

  /* ------------------------------------------------------------- sections */

  function propertySection(cfg, commit) {
    var box = el('div');
    box.appendChild(el('p', 'cp-intro',
      'Names the app header, the workbook title and the download file name.'));

    box.appendChild(field('Property code / name',
      input('text', cfg.property.name, function (v) {
        cfg.property.name = v.trim();
        commit();
      }), 'Shown in the corner badge — e.g. VFAR.'));

    box.appendChild(field('Report title',
      input('text', cfg.property.reportTitle, function (v) {
        cfg.property.reportTitle = v.trim() || 'Outlets Cover Report';
        commit();
      })));

    box.appendChild(field('Download file name',
      input('text', cfg.property.fileName, function (v) {
        cfg.property.fileName = v.trim() || 'GIH Report {date}';
        commit();
      }), '{date} becomes the business date. ".xlsx" is added for you.'));

    box.appendChild(field('Rooms in the resort',
      numberInput(cfg.property.totalRooms || 0, 0, 10000, function (n) {
        cfg.property.totalRooms = n;
        commit();
      }), 'Used for the occupancy figure on the Dhathuru sheet. Leave at 0 and ' +
      'the figure is left off rather than guessed.'));

    box.appendChild(el('h3', null, 'Tabs'));
    box.appendChild(checkbox('Show the "Import & Template" tab',
      cfg.ui.importTab !== false, function (on) {
        cfg.ui.importTab = on;
        commit();
      }));
    box.appendChild(el('p', 'cp-hint',
      'Off hides it from staff, who rarely need it. An admin keeps the tab either ' +
      'way — otherwise there would be no way back to this switch. Uploading is ' +
      'also on the "Upload report…" button in the top bar, which is unaffected.'));

    return box;
  }

  function outletsSection(cfg, commit, api) {
    var box = el('div');
    box.appendChild(el('p', 'cp-intro',
      'One tab in this app and one sheet in the generated workbook per outlet, ' +
      'in this order. "Rows" is how many rooms staff can type into that sheet.'));

    var table = el('table', 'cp-table');
    var head = el('tr');
    ['', 'Outlet', 'Rows', 'Package block', 'Covers breakdown', 'Gap', 'Rolls up from', '']
      .forEach(function (h) { head.appendChild(el('th', null, h)); });
    var thead = el('thead');
    thead.appendChild(head);
    table.appendChild(thead);

    var body = el('tbody');
    cfg.outlets.forEach(function (o, i) {
      var tr = el('tr');

      var ord = el('td', 'cp-ord');
      ord.appendChild(iconButton('▲', 'Move up', function () {
        if (move(cfg.outlets, i, i - 1)) commit();
      }, i === 0));
      ord.appendChild(iconButton('▼', 'Move down', function () {
        if (move(cfg.outlets, i, i + 1)) commit();
      }, i === cfg.outlets.length - 1));
      tr.appendChild(ord);

      var nameCell = el('td');
      nameCell.appendChild(input('text', o.name, function (v) {
        var next = v.trim();
        if (!next || next === o.name) return commit();
        var problem = sheetNameProblem(next);
        if (problem) {
          api.toast(problem, true);
          return commit();
        }
        if (cfg.outlets.some(function (x) { return x !== o && x.name === next; })) {
          api.toast('An outlet called "' + next + '" already exists.', true);
          return commit();
        }
        var was = o.name;
        o.name = next;
        cfg.outlets.forEach(function (x) {
          if (!x.rollupFrom) return;
          x.rollupFrom = x.rollupFrom.map(function (s) { return s === was ? next : s; });
        });
        api.renameOutlet(was, next);
        commit();
      }));
      tr.appendChild(nameCell);

      var rowsCell = el('td');
      rowsCell.appendChild(numberInput(o.capacity, 1, 5000, function (n) {
        o.capacity = n;
        commit();
      }));
      tr.appendChild(rowsCell);

      var pkgCell = el('td', 'cp-mid');
      pkgCell.appendChild(checkbox('', o.packageBlock !== false, function (on) {
        o.packageBlock = on;
        if (!on) o.breakdown = false;
        commit();
      }));
      tr.appendChild(pkgCell);

      var brkCell = el('td', 'cp-mid');
      brkCell.appendChild(checkbox('', o.breakdown, function (on) {
        o.breakdown = on;
        if (on) o.packageBlock = true;
        commit();
      }));
      tr.appendChild(brkCell);

      var gapCell = el('td');
      gapCell.appendChild(numberInput(o.packageGap == null ? 2 : o.packageGap, 0, 200,
        function (n) { o.packageGap = n; commit(); }));
      tr.appendChild(gapCell);

      var rollCell = el('td');
      rollCell.appendChild(rollupPicker(cfg, o, commit));
      tr.appendChild(rollCell);

      var del = el('td', 'cp-mid');
      del.appendChild(iconButton('✕', 'Remove this outlet', function () {
        if (!confirm('Remove "' + o.name + '"? Its seating in this app is cleared too.')) return;
        cfg.outlets.splice(i, 1);
        cfg.outlets.forEach(function (x) {
          if (x.rollupFrom) {
            x.rollupFrom = x.rollupFrom.filter(function (s) { return s !== o.name; });
          }
        });
        api.dropOutlet(o.name);
        commit();
      }, cfg.outlets.length <= 1));
      tr.appendChild(del);

      body.appendChild(tr);
    });
    table.appendChild(body);
    box.appendChild(el('div', 'cp-scroll')).appendChild(table);

    box.appendChild(button('Add outlet', 'small', function () {
      var n = 1;
      while (cfg.outlets.some(function (o) { return o.name === 'New outlet ' + n; })) n++;
      cfg.outlets.push({
        name: 'New outlet ' + n, capacity: 99, packageBlock: true,
        breakdown: true, packageGap: 2
      });
      commit();
    }));

    box.appendChild(el('h3', null, 'What the Master tab compiles'));
    cfg.master = cfg.master || { sources: [] };
    var chosen = cfg.master.sources || [];
    box.appendChild(el('p', 'cp-hint',
      chosen.length
        ? 'Only the outlets ticked below.'
        : 'Nothing ticked, so the Master tab compiles every outlet.'));

    var pickBox = el('div', 'cp-rights');
    cfg.outlets.forEach(function (o) {
      pickBox.appendChild(checkbox(o.name, chosen.indexOf(o.name) !== -1, function (on) {
        var list = (cfg.master.sources || []).slice();
        var at = list.indexOf(o.name);
        if (on && at === -1) list.push(o.name);
        if (!on && at !== -1) list.splice(at, 1);
        cfg.master.sources = list;
        commit();
      }));
    });
    box.appendChild(pickBox);
    box.appendChild(el('p', 'cp-hint',
      'A roll-up outlet such as OT already shows its own sections, so ticking ' +
      'both it and them would count those covers twice.'));

    box.appendChild(el('p', 'cp-hint',
      '"Gap" is the blank rows between the last room row and the PACKAGE header — ' +
      'the source workbook uses 2 on Skipjack, 10 on Charcoal and Tribe, 9 on the ' +
      'OT sections. "Rolls up from" makes column A collect the rooms typed into ' +
      'the sheets you pick, instead of being typed into directly.'));

    return box;
  }

  // A roll-up sheet lists the other sheets it collects rooms from.
  function rollupPicker(cfg, outlet, commit) {
    var wrap = el('div', 'cp-rollup');
    var current = outlet.rollupFrom || [];
    var summary = el('button', 'cp-rollup-btn',
      current.length ? current.length + ' sheet' + (current.length === 1 ? '' : 's') : 'none');
    summary.type = 'button';

    var menu = el('div', 'cp-rollup-menu');
    cfg.outlets.forEach(function (other) {
      if (other === outlet) return;
      menu.appendChild(checkbox(other.name, current.indexOf(other.name) !== -1, function (on) {
        var list = (outlet.rollupFrom || []).slice();
        var at = list.indexOf(other.name);
        if (on && at === -1) list.push(other.name);
        if (!on && at !== -1) list.splice(at, 1);
        if (list.length) outlet.rollupFrom = list; else delete outlet.rollupFrom;
        commit();
      }));
    });

    summary.onclick = function () { wrap.classList.toggle('open'); };
    wrap.appendChild(summary);
    wrap.appendChild(menu);
    if (current.length) summary.title = current.join(', ');
    return wrap;
  }

  function packagesSection(cfg, commit, api) {
    var box = el('div');
    box.appendChild(el('p', 'cp-intro',
      'The buckets every outlet totals covers into, in the order they appear in ' +
      'the PACKAGE block. A meal plan that matches none of these is counted ' +
      'nowhere — the import panel flags those in amber.'));

    var list = el('div', 'cp-list');
    cfg.packages.forEach(function (name, i) {
      var row = el('div', 'cp-list-row');
      row.appendChild(el('span', 'cp-num', String(i + 1)));

      row.appendChild(input('text', name, function (v) {
        var next = v.trim().toUpperCase();
        if (!next || next === name) return commit();
        if (cfg.packages.indexOf(next) !== -1) {
          api.toast('"' + next + '" is already a bucket.', true);
          return commit();
        }
        cfg.packages[i] = next;
        // Keep every breakdown line pointing at the bucket it meant - in both
        // services, not just the one on screen.
        eachBreakdownLine(cfg, function (d) {
          d.buckets = (d.buckets || []).map(function (b) { return b === name ? next : b; });
        });
        commit();
      }));

      row.appendChild(iconButton('▲', 'Move up', function () {
        if (move(cfg.packages, i, i - 1)) commit();
      }, i === 0));
      row.appendChild(iconButton('▼', 'Move down', function () {
        if (move(cfg.packages, i, i + 1)) commit();
      }, i === cfg.packages.length - 1));
      row.appendChild(iconButton('✕', 'Remove this bucket', function () {
        if (!confirm('Remove the "' + name + '" bucket? Any breakdown line that ' +
          'sums it will stop counting it.')) return;
        cfg.packages.splice(i, 1);
        eachBreakdownLine(cfg, function (d) {
          d.buckets = (d.buckets || []).filter(function (b) { return b !== name; });
        });
        commit();
      }, cfg.packages.length <= 1));

      list.appendChild(row);
    });
    box.appendChild(list);

    box.appendChild(button('Add bucket', 'small', function () {
      var n = 1;
      while (cfg.packages.indexOf('NEW' + n) !== -1) n++;
      cfg.packages.push('NEW' + n);
      commit();
    }));

    return box;
  }

  function derivedSection(cfg, commit, api) {
    var box = el('div');
    var service = String(cfg.service || 'DINNER').toUpperCase();
    cfg.breakdowns = cfg.breakdowns || {};
    var lines = cfg.breakdowns[service] || (cfg.breakdowns[service] = []);
    box.appendChild(el('p', 'cp-intro',
      'The lines under the PACKAGE block. Each one sums the buckets you tick — ' +
      'the same figure appears in the summary panel, the CSV export and the ' +
      'generated workbook.'));

    // The same outlets run both sittings, so the service is a switch rather
    // than two sets of lines to keep in step.
    var svc = el('div', 'cp-service');
    svc.appendChild(el('span', 'cp-label', 'Service'));
    var group = el('div', 'cp-segmented');
    ['LUNCH', 'DINNER'].forEach(function (option) {
      var on = String(cfg.service || 'DINNER').toUpperCase() === option;
      var b = el('button', 'cp-seg' + (on ? ' on' : ''), option.charAt(0) + option.slice(1).toLowerCase());
      b.type = 'button';
      b.onclick = function () { cfg.service = option; commit(); };
      group.appendChild(b);
    });
    svc.appendChild(group);
    svc.appendChild(el('span', 'cp-hint',
      'Each service has its own breakdown — you are editing the ' +
      String(cfg.service || 'DINNER').toLowerCase() + ' one below. Lines marked ' +
      '"Name follows service" also take their name from this switch, so ' +
      '"DINNER PKG" reads "LUNCH PKG" everywhere the figure appears.'));
    box.appendChild(svc);

    var otherService = String(cfg.service || 'DINNER').toUpperCase() === 'LUNCH'
      ? 'DINNER' : 'LUNCH';
    var copyRow = el('div', 'cp-buttons');
    copyRow.appendChild(button('Copy this breakdown to ' + otherService.toLowerCase(),
      'small ghost-line', function () {
        if (!confirm('Replace the ' + otherService.toLowerCase() +
          ' breakdown with this one?')) return;
        cfg.breakdowns[otherService] = JSON.parse(JSON.stringify(lines));
        commit();
        api.toast('Copied to ' + otherService.toLowerCase() + '.');
      }));
    box.appendChild(copyRow);

    lines.forEach(function (d, i) {
      var card = el('div', 'cp-derived');

      var head = el('div', 'cp-derived-head');
      head.appendChild(input('text', d.label, function (v) {
        d.label = v.trim() || d.label;
        commit();
      }));
      if (d.serviceLine) {
        head.appendChild(el('span', 'cp-shows-as',
          'shows as ' + window.GihConfig.serviceLabel(d.label, true)));
      }
      head.appendChild(iconButton('▲', 'Move up', function () {
        if (move(lines, i, i - 1)) commit();
      }, i === 0));
      head.appendChild(iconButton('▼', 'Move down', function () {
        if (move(lines, i, i + 1)) commit();
      }, i === lines.length - 1));
      head.appendChild(iconButton('✕', 'Remove this line', function () {
        if (!confirm('Remove the "' + d.label + '" line?')) return;
        lines.splice(i, 1);
        commit();
      }, lines.length <= 1));
      card.appendChild(head);

      var opts = el('div', 'cp-derived-opts');
      opts.appendChild(checkbox('Adults only', d.adultsOnly, function (on) {
        d.adultsOnly = on;
        commit();
      }));
      opts.appendChild(checkbox('Bare number', d.plain, function (on) {
        d.plain = on;
        commit();
      }));
      opts.appendChild(checkbox('Emphasise', d.total, function (on) {
        d.total = on;
        commit();
      }));
      opts.appendChild(checkbox('Name follows service', d.serviceLine, function (on) {
        d.serviceLine = on;
        commit();
      }));
      var gap = el('label', 'cp-check');
      gap.appendChild(el('span', null, 'Blank rows above'));
      gap.appendChild(numberInput(d.gapBefore || 0, 0, 10, function (n) {
        d.gapBefore = n;
        commit();
      }));
      opts.appendChild(gap);
      card.appendChild(opts);

      var picks = el('div', 'cp-buckets');
      cfg.packages.forEach(function (name) {
        var on = (d.buckets || []).indexOf(name) !== -1;
        var chip = el('button', 'cp-bucket' + (on ? ' on' : ''), name);
        chip.type = 'button';
        chip.onclick = function () {
          var list = (d.buckets || []).slice();
          var at = list.indexOf(name);
          if (at === -1) list.push(name); else list.splice(at, 1);
          d.buckets = list;
          commit();
        };
        picks.appendChild(chip);
      });
      card.appendChild(picks);

      box.appendChild(card);
    });

    box.appendChild(button('Add line', 'small', function () {
      lines.push({ label: 'NEW LINE', gapBefore: 1, buckets: [] });
      commit();
    }));

    box.appendChild(el('p', 'cp-hint',
      '"Bare number" prints the figure on its own; otherwise it reads "n Adults" ' +
      'and is left blank at zero, the way the workbook writes it. "Emphasise" is ' +
      'the bold TOTAL styling.'));

    return box;
  }

  function operaSection(cfg, commit) {
    var box = el('div');
    box.appendChild(el('p', 'cp-intro',
      'How an Opera "Guest INH - Meal Plan" export is folded into the GIH list.'));

    box.appendChild(checkbox('Use "Extra Meal Plan" when the reservation has one',
      cfg.opera.preferExtraMealPlan, function (on) {
        cfg.opera.preferExtraMealPlan = on;
        commit();
      }));
    box.appendChild(el('p', 'cp-hint',
      'On: a room with MealPlan AI and Extra Meal Plan PAI is counted as PAI. ' +
      'Off: the plain MealPlan column wins.'));

    box.appendChild(checkbox('Merge a room that appears twice in one export',
      cfg.opera.mergeDuplicateRooms, function (on) {
        cfg.opera.mergeDuplicateRooms = on;
        commit();
      }));
    box.appendChild(el('p', 'cp-hint',
      'On: split reservations become one row — widest dates, summed pax, ' +
      'comments deduplicated. Off: only the first one is ever found by XLOOKUP.'));

    box.appendChild(checkbox('Import only rooms whose status is in the list below',
      cfg.opera.checkedInOnly, function (on) {
        cfg.opera.checkedInOnly = on;
        commit();
      }));

    box.appendChild(field('In-house statuses',
      input('text', (cfg.opera.inHouseStatuses || []).join(', '), function (v) {
        cfg.opera.inHouseStatuses = v.split(',')
          .map(function (s) { return s.trim().toUpperCase(); })
          .filter(Boolean);
        commit();
      }), 'Comma separated. Matched as a substring of Opera’s Resv. Status.'));

    box.appendChild(el('h3', null, 'Meal plan renames'));
    box.appendChild(el('p', 'cp-hint',
      'Punctuation is already ignored when matching, so Opera’s "FBCSAI" finds ' +
      'the "FBC+SAI" bucket on its own. Add a rename here only for a code that ' +
      'is genuinely spelt differently.'));

    var aliases = cfg.opera.planAliases || {};
    var list = el('div', 'cp-list');
    Object.keys(aliases).forEach(function (from) {
      var row = el('div', 'cp-list-row');
      row.appendChild(input('text', from, function (v) {
        var next = v.trim().toUpperCase();
        if (!next || next === from) return commit();
        var to = aliases[from];
        delete aliases[from];
        aliases[next] = to;
        commit();
      }));
      row.appendChild(el('span', 'cp-arrow', '→'));
      row.appendChild(input('text', aliases[from], function (v) {
        aliases[from] = v.trim().toUpperCase();
        commit();
      }));
      row.appendChild(iconButton('✕', 'Remove this rename', function () {
        delete aliases[from];
        commit();
      }));
      list.appendChild(row);
    });
    box.appendChild(list);

    box.appendChild(button('Add rename', 'small', function () {
      cfg.opera.planAliases = aliases;
      var n = 1;
      while (aliases['CODE' + n] !== undefined) n++;
      aliases['CODE' + n] = cfg.packages[0] || '';
      commit();
    }));

    return box;
  }

  // A <select> over the package buckets, plus whatever value is already set even
  // if it is not a bucket - so an old rule is never silently rewritten.
  function planSelect(cfg, value, onCommit) {
    var s = el('select', 'cp-input');
    var options = cfg.packages.slice();
    if (value && options.indexOf(value) === -1) options.push(value);
    options.forEach(function (p) {
      var o = el('option', null, p);
      o.value = p;
      if (p === value) o.selected = true;
      s.appendChild(o);
    });
    s.onchange = function () { onCommit(s.value); };
    return s;
  }

  function commentRulesSection(cfg, commit, api) {
    var box = el('div');
    box.appendChild(el('p', 'cp-intro',
      'Override a room’s meal plan when its Comment contains a given piece of ' +
      'text. The reservation comment usually spells the real arrangement out — ' +
      '"COMP/1RO/1TRRT - Meals in Staff Canteen" is a COMP cover whatever the ' +
      'MealPlan column says. Rules are tried top to bottom and the first match wins.'));

    var wild = el('p', 'cp-wildcards');
    wild.appendChild(el('strong', null, 'Wildcards: '));
    wild.appendChild(el('code', null, '*'));
    wild.appendChild(document.createTextNode(' stands for any run of characters and '));
    wild.appendChild(el('code', null, '?'));
    wild.appendChild(document.createTextNode(' for exactly one — neither crosses a space, ' +
      'so they stay inside one word. The pax count moves from booking to booking, so '));
    wild.appendChild(el('code', null, 'COMP/*FB'));
    wild.appendChild(document.createTextNode(' catches COMP/1FB, COMP/2FB and COMP/12FB alike.'));
    box.appendChild(wild);

    var rules = cfg.commentRules || (cfg.commentRules = []);

    if (!rules.length) {
      box.appendChild(el('p', 'cp-hint',
        'No rules yet — every room keeps the plan it was imported with.'));
    }

    rules.forEach(function (rule, i) {
      var card = el('div', 'cp-rule');

      var line = el('div', 'cp-rule-line');
      line.appendChild(el('span', 'cp-num', String(i + 1)));
      line.appendChild(el('span', 'cp-rule-word', 'Comment contains'));

      var text = input('text', rule.contains, function (v) {
        rule.contains = v;
        commit();
      });
      text.className = 'cp-input cp-rule-text';
      text.placeholder = 'e.g. COMP/*FB';
      line.appendChild(text);

      line.appendChild(el('span', 'cp-rule-word', '→ count as'));
      line.appendChild(planSelect(cfg, rule.plan, function (v) {
        rule.plan = v;
        commit();
      }));

      line.appendChild(iconButton('▲', 'Move up', function () {
        if (move(rules, i, i - 1)) commit();
      }, i === 0));
      line.appendChild(iconButton('▼', 'Move down', function () {
        if (move(rules, i, i + 1)) commit();
      }, i === rules.length - 1));
      line.appendChild(iconButton('✕', 'Remove this rule', function () {
        rules.splice(i, 1);
        commit();
      }));
      card.appendChild(line);

      var opts = el('div', 'cp-rule-opts');
      opts.appendChild(checkbox('Only when the room has no plan at all',
        rule.onlyIfBlank, function (on) { rule.onlyIfBlank = on; commit(); }));
      opts.appendChild(checkbox('Match case',
        rule.caseSensitive, function (on) { rule.caseSensitive = on; commit(); }));
      card.appendChild(opts);

      // What this rule does to the data that is loaded right now.
      var hit = api.previewRule(rule, i);
      var summary = hit.invalid
        ? 'That pattern could not be read — check the wildcards.'
        : hit.count
          ? hit.count + ' of the ' + hit.total + ' loaded rooms match this rule' +
            (hit.examples.length ? ' — e.g. room ' + hit.examples.join(', ') : '')
          : 'No loaded room matches this rule.';
      card.appendChild(el('p', 'cp-rule-hit' +
        (hit.invalid ? ' bad' : hit.count ? ' on' : ''), summary));

      box.appendChild(card);
    });

    box.appendChild(button('Add rule', 'small', function () {
      rules.push({ contains: '', plan: cfg.packages[0] || '', onlyIfBlank: false, caseSensitive: false });
      commit();
    }));

    box.appendChild(el('p', 'cp-hint',
      'Rules apply to Opera imports and GIH workbooks alike, and are re-applied ' +
      'whenever you change them — every room remembers the plan it arrived with, ' +
      'so removing a rule puts the original plan straight back.'));

    return box;
  }

  function highlightSection(cfg, commit) {
    var box = el('div');
    box.appendChild(el('p', 'cp-intro',
      'The four conditional-format rules, in priority order — the first one that ' +
      'matches a row wins. These colours are used both on screen and in the ' +
      'generated workbook.'));

    var rules = [
      ['dep', 'Departing on the business date', '$I2=TODAY()'],
      ['rem', 'Has a Remarks value', '$C2<>""'],
      ['arr', 'Arriving on the business date', '$H2=TODAY()'],
      ['band', 'Every other row', 'MOD(ROW(),2)=0']
    ];

    rules.forEach(function (r, i) {
      var row = el('div', 'cp-colour-row');
      row.appendChild(el('span', 'cp-num', String(i + 1)));
      row.appendChild(input('color', cfg.highlight[r[0]], function (v) {
        cfg.highlight[r[0]] = v;
        commit();
      }));
      var text = el('div', 'cp-colour-text');
      text.appendChild(el('strong', null, r[1]));
      text.appendChild(el('code', null, r[2]));
      row.appendChild(text);
      box.appendChild(row);
    });

    var extra = el('div', 'cp-colour-row');
    extra.appendChild(el('span', 'cp-num', '—'));
    extra.appendChild(input('color', cfg.highlight.miss, function (v) {
      cfg.highlight.miss = v;
      commit();
    }));
    var t2 = el('div', 'cp-colour-text');
    t2.appendChild(el('strong', null, 'Room not in the GIH list'));
    t2.appendChild(el('code', null, 'this app only — the workbook leaves it blank'));
    extra.appendChild(t2);
    box.appendChild(extra);

    return box;
  }

  function workbookSection(cfg, commit) {
    var box = el('div');
    box.appendChild(el('p', 'cp-intro', 'Options for the .xlsx the app writes.'));

    var fmt = el('select', 'cp-input');
    ['dd/mm/yyyy', 'mm/dd/yyyy', 'yyyy-mm-dd', 'd mmm yyyy', 'dd-mmm-yy']
      .forEach(function (f) {
        var o = el('option', null, f);
        o.value = f;
        if (f === cfg.workbook.dateFormat) o.selected = true;
        fmt.appendChild(o);
      });
    fmt.onchange = function () { cfg.workbook.dateFormat = fmt.value; commit(); };
    box.appendChild(field('Date format in the workbook', fmt));

    box.appendChild(checkbox('Freeze the header row on every sheet',
      cfg.workbook.freezeHeader, function (on) {
        cfg.workbook.freezeHeader = on;
        commit();
      }));

    box.appendChild(checkbox('Print the DEPARTURE / ARRIVAL / REMARKS legend on outlet sheets',
      cfg.workbook.legend, function (on) {
        cfg.workbook.legend = on;
        commit();
      }));

    var specs = window.XlsxWriter.layout();
    box.appendChild(el('h3', null, 'Sheets that will be written'));
    var t = el('table', 'cp-table');
    var head = el('tr');
    ['Sheet', 'Room rows', 'PACKAGE at', 'Breakdown'].forEach(function (h) {
      head.appendChild(el('th', null, h));
    });
    var thead = el('thead');
    thead.appendChild(head);
    t.appendChild(thead);
    var tb = el('tbody');
    tb.appendChild((function () {
      var tr = el('tr');
      tr.appendChild(el('td', null, 'Sheet1'));
      tr.appendChild(el('td', null, 'the Comments table'));
      tr.appendChild(el('td', null, '—'));
      tr.appendChild(el('td', null, '—'));
      return tr;
    })());
    specs.forEach(function (s) {
      var tr = el('tr');
      tr.appendChild(el('td', null, s.name));
      tr.appendChild(el('td', null, s.sources ? 'rolled up' : '2–' + s.lastRow));
      tr.appendChild(el('td', null, s.pkgHeader ? 'row ' + s.pkgHeader : '—'));
      tr.appendChild(el('td', null, s.breakdown ? 'yes' : '—'));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    box.appendChild(el('div', 'cp-scroll')).appendChild(t);

    return box;
  }

  function manageSection(cfg, commit, api) {
    var box = el('div');
    box.appendChild(el('p', 'cp-intro',
      'Settings live in this browser only. Export them to carry the same setup ' +
      'to another machine, or to keep a copy before experimenting.'));

    var row = el('div', 'cp-buttons');
    row.appendChild(button('Export settings…', '', function () {
      api.download('gih-settings.json', window.GihConfig.toJson());
      api.toast('Settings exported');
    }));

    var picker = el('input');
    picker.type = 'file';
    picker.accept = '.json,application/json';
    picker.style.display = 'none';
    picker.onchange = function () {
      var file = picker.files[0];
      picker.value = '';
      if (!file) return;
      file.text().then(function (text) {
        window.GihConfig.fromJson(text);
        api.toast('Settings imported');
        api.refresh();
      }).catch(function (e) {
        api.toast('Could not read that settings file: ' + e.message, true);
      });
    };
    row.appendChild(button('Import settings…', 'ghost-line', function () { picker.click(); }));
    row.appendChild(picker);

    row.appendChild(button('Reset everything to defaults', 'ghost-line danger-line', function () {
      if (!confirm('Reset every setting to the GIH Report.xlsx defaults?')) return;
      window.GihConfig.reset();
      api.toast('Settings reset');
      api.refresh();
    }));
    box.appendChild(row);

    box.appendChild(el('h3', null, 'Current settings'));
    var pre = el('pre', 'cp-json', window.GihConfig.toJson());
    box.appendChild(pre);

    return box;
  }

  function serverSection(cfg, commit, api) {
    var box = el('div');
    var online = window.GihApi.isOnline();
    var admin = window.GihApi.isAdmin();

    if (!online) {
      box.appendChild(el('p', 'cp-intro',
        'No server is answering, so this browser is on its own: settings and ' +
        'seating stay on this PC and nothing is shared. ' +
        (window.GihApi.state.lastError || '')));
      box.appendChild(button('Try again', '', function () {
        window.GihApi.bootstrap('').then(function () { api.refresh(); });
      }));
      box.appendChild(el('h3', null, 'Starting the server'));
      var pre = el('pre', 'cp-json',
        'From the folder this app lives in:\n\n  node server/server.js\n\n' +
        'It prints the address other stations should use. On first run it also\n' +
        'prints the admin password once — write it down.');
      box.appendChild(pre);
      return box;
    }

    box.appendChild(el('p', 'cp-intro',
      admin
        ? 'Signed in as admin. Uploads and settings changes made here reach every station.'
        : 'Connected and sharing with the other stations. Sign in as admin to upload ' +
          'a report or change any of these settings.'));

    // Station name - what the change log calls this PC.
    box.appendChild(field('This station is called',
      input('text', api.station(), function (v) {
        api.setStation(v.trim().slice(0, 40));
        api.toast('Station name saved on this PC.');
      }), 'Shown in the change log so you can tell the stations apart.'));

    if (!admin) {
      box.appendChild(button('Sign in as admin', 'accent', function () { api.promptLogin(); }));
      return box;
    }

    box.appendChild(el('h3', null, 'Admin password'));
    var current = input('password', '', function () {});
    current.placeholder = 'current password';
    var next = input('password', '', function () {});
    next.placeholder = 'new password (8+ characters)';
    var confirm2 = input('password', '', function () {});
    confirm2.placeholder = 'new password again';
    [current, next, confirm2].forEach(function (i) {
      i.className = 'cp-input cp-rule-text';
      box.appendChild(i);
    });
    box.appendChild(button('Change password', 'small', function () {
      if (next.value.length < 8) return api.toast('Use at least 8 characters.', true);
      if (next.value !== confirm2.value) return api.toast('The two new passwords differ.', true);
      window.GihApi.changePassword(current.value, next.value).then(function (res) {
        if (!res.ok) return api.toast(res.error, true);
        current.value = next.value = confirm2.value = '';
        api.toast('Password changed. Everyone else has been signed out.');
      });
    }));
    box.appendChild(el('p', 'cp-hint',
      'Changing it signs out every other admin session. If it is ever lost, restart ' +
      'the server with --set-password "something new".'));

    box.appendChild(el('h3', null, 'Stored days'));
    var days = el('div', 'cp-days', 'loading…');
    box.appendChild(days);
    window.GihApi.listDays().then(function (res) {
      days.innerHTML = '';
      if (!res.ok) { days.appendChild(el('p', 'cp-hint', res.error)); return; }
      if (!res.body.days.length) {
        days.appendChild(el('p', 'cp-hint', 'Nothing stored yet.'));
        return;
      }
      var t = el('table', 'cp-table');
      var head = el('tr');
      ['Business date', 'Rooms', 'Seated', 'Source', ''].forEach(function (h) {
        head.appendChild(el('th', null, h));
      });
      var thead = el('thead'); thead.appendChild(head); t.appendChild(thead);
      var tb = el('tbody');
      res.body.days.slice().reverse().forEach(function (d) {
        var tr = el('tr');
        tr.appendChild(el('td', null, d.date));
        tr.appendChild(el('td', null, String(d.rooms)));
        tr.appendChild(el('td', null, String(d.seated)));
        tr.appendChild(el('td', null, d.source || '—'));
        var act = el('td');
        act.appendChild(button('Open', 'small ghost-line', function () { api.openDay(d.date); }));
        act.appendChild(iconButton('✕', 'Delete this day', function () {
          if (!confirm('Delete ' + d.date + ' from the server? Its seating goes with it.')) return;
          window.GihApi.deleteDay(d.date).then(function (r) {
            if (!r.ok) return api.toast(r.error, true);
            api.toast(d.date + ' deleted.');
            api.refresh();
          });
        }));
        tr.appendChild(act);
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      days.appendChild(el('div', 'cp-scroll')).appendChild(t);
    });

    box.appendChild(el('h3', null, 'Change log'));
    var logBox = el('div', 'cp-log', 'loading…');
    box.appendChild(logBox);
    window.GihApi.getLog(120).then(function (res) {
      logBox.innerHTML = '';
      if (!res.ok) { logBox.appendChild(el('p', 'cp-hint', res.error)); return; }
      if (!res.body.entries.length) {
        logBox.appendChild(el('p', 'cp-hint', 'Nothing recorded yet.'));
        return;
      }
      res.body.entries.forEach(function (e) {
        var row = el('div', 'cp-log-row');
        row.appendChild(el('span', 'cp-log-when', new Date(e.at).toLocaleString()));
        row.appendChild(el('span', 'cp-log-who' + (e.who === 'admin' ? ' admin' : ''),
          e.who + (e.station ? ' · ' + e.station : '')));
        row.appendChild(el('span', 'cp-log-what', e.action +
          (e.detail && e.detail.date ? ' (' + e.detail.date + ')' : '')));
        logBox.appendChild(row);
      });
    });

    return box;
  }

  /* Named accounts, and what each may do. Anonymous use stays possible - the
   * point of accounts is to give some people more, not to lock everyone out. */
  function usersSection(cfg, commit, api) {
    var box = el('div');

    if (!window.GihApi.isOnline()) {
      box.appendChild(el('p', 'cp-intro',
        'Accounts live on the server. With no server there is nobody to be, and ' +
        'this browser may do everything.'));
      return box;
    }

    box.appendChild(el('p', 'cp-intro',
      'Anyone can open the app and work without signing in — the ticks under ' +
      '"Without signing in" say how much. Give someone an account when they need ' +
      'more than that. The admin password is separate and always has everything.'));

    box.appendChild(el('h3', null, 'Without signing in'));
    var anon = cfg.access.anonymous;
    var anonBox = el('div', 'cp-rights');
    window.GihConfig.RIGHTS.forEach(function (r) {
      anonBox.appendChild(checkbox(r.label, anon[r.key], function (on) {
        anon[r.key] = on;
        commit();
      }));
    });
    box.appendChild(anonBox);
    box.appendChild(el('p', 'cp-hint',
      'Leave "Change Control Panel settings" off unless you mean it — with it on, ' +
      'anyone on the network can rewrite the outlets and the package maths.'));
    box.appendChild(el('p', 'cp-hint',
      '"Add a blank line to the guest list" needs "Correct any other guest-list ' +
      'column" alongside it — the line it makes is empty and has to be typed into, ' +
      'so on its own the button stays hidden. "Add to the guest list from Today’s ' +
      'Welcome" stands on its own: the lines it brings over are already filled in.'));

    box.appendChild(el('h4', 'cp-sub', 'Tabs they can see'));
    cfg.access.anonymousTabs = cfg.access.anonymousTabs || [];
    box.appendChild(tabPicker(cfg, cfg.access.anonymousTabs, function (next) {
      cfg.access.anonymousTabs = next;
      commit();
    }));
    box.appendChild(el('p', 'cp-hint',
      'Unticking a tab takes it off the screen. It is tidying, not a lock — the ' +
      'figures behind it are still on the API for anyone who goes looking. The ' +
      'rights above are the ones that actually stop anything.'));

    if (!window.GihApi.isAdmin()) {
      box.appendChild(el('h3', null, 'Accounts'));
      box.appendChild(el('p', 'cp-hint', 'Only the admin can add or change accounts.'));
      return box;
    }

    box.appendChild(el('h3', null, 'Accounts'));
    var list = el('div', 'cp-users', 'loading…');
    box.appendChild(list);

    var draw = function () {
      window.GihApi.listUsers().then(function (res) {
        list.innerHTML = '';
        if (!res.ok) { list.appendChild(el('p', 'cp-hint', res.error)); return; }
        if (!res.body.users.length) {
          list.appendChild(el('p', 'cp-hint', 'No accounts yet.'));
          return;
        }
        res.body.users.forEach(function (u) {
          var card = el('div', 'cp-user');
          var head = el('div', 'cp-user-head');
          head.appendChild(el('strong', null, u.name));

          var pw = el('input', 'cp-input cp-user-pw');
          pw.type = 'password';
          pw.placeholder = 'set a new password';
          head.appendChild(pw);
          head.appendChild(button('Set', 'small ghost-line', function () {
            if (pw.value.length < 4) return api.toast('Use at least 4 characters.', true);
            window.GihApi.updateUser(u.id, { password: pw.value }).then(function (r) {
              if (!r.ok) return api.toast(r.error, true);
              pw.value = '';
              api.toast(u.name + '’s password changed — they will need to sign in again.');
            });
          }));
          head.appendChild(iconButton('✕', 'Remove this account', function () {
            if (!confirm('Remove the account "' + u.name + '"?')) return;
            window.GihApi.removeUser(u.id).then(function (r) {
              if (!r.ok) return api.toast(r.error, true);
              api.toast(u.name + ' removed.');
              draw();
            });
          }));
          card.appendChild(head);

          var rights = el('div', 'cp-rights');
          window.GihConfig.RIGHTS.forEach(function (r) {
            rights.appendChild(checkbox(r.label, u.rights && u.rights[r.key], function (on) {
              var next = {};
              window.GihConfig.RIGHTS.forEach(function (x) {
                next[x.key] = x.key === r.key ? on : !!(u.rights && u.rights[x.key]);
              });
              window.GihApi.updateUser(u.id, { rights: next }).then(function (resp) {
                if (!resp.ok) { api.toast(resp.error, true); draw(); return; }
                u.rights = next;
              });
            }));
          });
          card.appendChild(rights);

          card.appendChild(el('h4', 'cp-sub', 'Tabs ' + u.name + ' can see'));
          card.appendChild(tabPicker(cfg, u.hiddenTabs || [], function (next) {
            window.GihApi.updateUser(u.id, { hiddenTabs: next }).then(function (resp) {
              if (!resp.ok) { api.toast(resp.error, true); draw(); return; }
              u.hiddenTabs = next;
            });
          }));

          list.appendChild(card);
        });
      });
    };
    draw();

    box.appendChild(el('h3', null, 'Add an account'));
    var addName = input('text', '', function () {});
    addName.placeholder = 'name';
    addName.className = 'cp-input cp-rule-text';
    var addPw = input('password', '', function () {});
    addPw.placeholder = 'password (4+ characters)';
    addPw.className = 'cp-input cp-rule-text';

    var newRights = {};
    var rightsBox = el('div', 'cp-rights');
    window.GihConfig.RIGHTS.forEach(function (r) {
      newRights[r.key] = (r.key === 'seat' || r.key === 'remarks');
      rightsBox.appendChild(checkbox(r.label, newRights[r.key], function (on) {
        newRights[r.key] = on;
      }));
    });

    var addRow = el('div', 'cp-list-row');
    addRow.appendChild(addName);
    addRow.appendChild(addPw);
    box.appendChild(addRow);
    box.appendChild(rightsBox);
    box.appendChild(button('Add account', 'small', function () {
      if (!addName.value.trim()) return api.toast('Give the account a name.', true);
      if (addPw.value.length < 4) return api.toast('Use at least 4 characters.', true);
      window.GihApi.addUser({
        name: addName.value.trim(), password: addPw.value, rights: newRights
      }).then(function (r) {
        if (!r.ok) return api.toast(r.error, true);
        api.toast(r.body.user.name + ' added.');
        addName.value = '';
        addPw.value = '';
        draw();
      });
    }));

    return box;
  }

  var BUILDERS = {
    property: propertySection,
    outlets: outletsSection,
    packages: packagesSection,
    derived: derivedSection,
    opera: operaSection,
    commentRules: commentRulesSection,
    highlight: highlightSection,
    workbook: workbookSection,
    manage: manageSection,
    users: usersSection,
    server: serverSection
  };

  /* ------------------------------------------------------------------ api */

  function build(api) {
    var frag = document.createDocumentFragment();
    var pane = el('section', 'pane control');

    // With a server in front of it, the settings belong to everyone, so only an
    // admin may change them. With no server they are this browser's own.
    var locked = window.GihApi.isOnline() && !window.GihApi.may('settings');

    var head = el('div', 'cp-head');
    head.appendChild(el('h1', null, 'Control Panel'));
    head.appendChild(el('p', 'muted',
      window.GihApi.isOnline()
        ? 'Master settings for the outlets, the package maths, the import rules and ' +
          'the generated workbook. They are held on the server, so a change here ' +
          'reaches every station.'
        : 'Master settings for the outlets, the package maths, the import rules and ' +
          'the generated workbook. No server is answering, so these are this ' +
          'browser\'s own.'));
    pane.appendChild(head);

    if (locked) {
      var bar = el('div', 'cp-locked');
      bar.appendChild(el('span', null,
        'Read-only — sign in as admin to change any of this.'));
      bar.appendChild(button('Sign in', 'small', function () { api.promptLogin(); }));
      pane.appendChild(bar);
    }

    var body = el('div', 'cp-body');

    var nav = el('nav', 'cp-nav');
    SECTIONS.forEach(function (s) {
      var b = el('button', 'cp-nav-item' + (openSection === s.id ? ' active' : ''), s.label);
      b.type = 'button';
      b.onclick = function () { openSection = s.id; api.rerender(); };
      if (s.id !== 'manage' && s.id !== 'server' && s.id !== 'users' &&
          !window.GihConfig.isDefault(s.id === 'derived' ? 'breakdowns' : s.id)) {
        b.appendChild(el('span', 'cp-dot', '•'));
        b.title = 'Changed from the defaults';
      }
      nav.appendChild(b);
    });
    body.appendChild(nav);

    var panel = el('div', 'cp-panel');
    var section = SECTIONS.filter(function (s) { return s.id === openSection; })[0] || SECTIONS[0];

    var title = el('div', 'cp-panel-head');
    title.appendChild(el('h2', null, section.label));
    // "Settings file" and "Server & access" are not settings sections - there is
    // nothing in them to reset.
    if (section.id !== 'manage' && section.id !== 'server' && section.id !== 'users') {
      var resetKey = section.id === 'derived' ? 'breakdowns' : section.id;
      var reset = button('Reset this section', 'small ghost-line', function () {
        if (!confirm('Reset "' + section.label + '" to its default?')) return;
        window.GihConfig.reset(resetKey);
        api.toast(section.label + ' reset');
        api.refresh();
      });
      reset.disabled = window.GihConfig.isDefault(resetKey);
      title.appendChild(reset);
    }
    panel.appendChild(title);

    // Sections edit a working copy; commit() writes it back in one go so a
    // half-finished edit can never be observed by the rest of the app.
    var draft = JSON.parse(window.GihConfig.toJson());
    var commit = function () {
      window.GihConfig.save(draft);
      api.refresh();
    };

    panel.appendChild(BUILDERS[section.id](draft, commit, api));

    // One sweep rather than a guard in every control: nothing in the settings
    // sections is operable while read-only. "Server & access" stays live, since
    // signing in is exactly what a locked-out user needs to do there.
    if (locked && section.id !== 'server' && section.id !== 'users') {
      Array.prototype.forEach.call(
        panel.querySelectorAll('input, select, button, .cp-bucket'),
        function (node) {
          if (node.classList.contains('cp-bucket')) node.classList.add('locked');
          node.disabled = true;
        }
      );
    }

    body.appendChild(panel);

    pane.appendChild(body);
    frag.appendChild(pane);
    return frag;
  }

  window.ControlPanel = { build: build };
})();
