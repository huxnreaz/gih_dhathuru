/* The API, with nothing environment-specific in it.
 *
 * Everything it touches - storage, hashing, tokens, the clock - is injected, so
 * the same file runs on Node against the filesystem and in a browser against a
 * Map. That is deliberate: the routing, the admin gate and the conflict rules
 * are the parts most worth testing, and this way they can be tested without a
 * server running.
 *
 * Storage keys:
 *   admin              { salt, hash, updatedAt }
 *   settings           { settings, revision, updatedAt }
 *   day:<YYYY-MM-DD>   the day document (see emptyDay)
 *   log                append-only, one entry per line
 *
 * handle(req) takes { method, path, query, body, cookies, ip } and returns
 * { status, body, cookie? }. It never throws for a bad request - it answers.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  // Only a browser test harness ever loads this file directly. The name differs
  // from the client's window.GihApi on purpose - they are opposite ends of the
  // same conversation and must never be mistaken for each other.
  else root.GihServerApi = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SESSION_COOKIE = 'gih_session';
  var SESSION_MS = 12 * 60 * 60 * 1000;     // a long shift, then sign in again
  var LOGIN_WINDOW_MS = 60 * 1000;
  var LOGIN_MAX_TRIES = 5;
  var MAX_LOG = 2000;

  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  // Kept in step with GihConfig.RIGHTS on the client.
  var RIGHT_KEYS = ['seat', 'clear', 'remarks', 'guestList', 'gihAdd', 'gihWelcome',
    'bizDate', 'service', 'master', 'importData', 'dhathuru', 'reset', 'settings'];

  /* The Dhathuru sheet. The field lists mirror the real sheet's columns, and
   * nothing outside them is stored - a client cannot smuggle extra keys into
   * the day document. Kept here rather than derived from the guest list because
   * the flight, transfer, agent and host columns are not in the Opera export. */
  var DHA_FIELDS = {
    welcome: ['room', 'status', 'guest', 'eta', 'depDate',
      'pax', 'nationality', 'vip', 'mealPlan', 'agent', 'host', 'remarks'],
    farewell: ['room', 'status', 'guest', 'checkout', 'depTime',
      'nationality', 'pax', 'vip', 'mealPlan', 'agent', 'host', 'remarks'],
    moves: ['from', 'to', 'guest', 'time', 'agent', 'pax', 'host', 'remarks'],
    celebrations: ['room', 'guest', 'celebration', 'locationTime', 'bedDecoration']
  };

  var DHA_HOST_SLOTS = 20;

  function emptyDhathuru() {
    return {
      welcome: [], farewell: [], moves: [], celebrations: [], hosts: [],
      house: { adults: '', children: '', rooms: '' },
      week: null,
      header: null,
      note: '', updatedAt: 0, by: ''
    };
  }

  function cleanRows(rows, fields, limit) {
    if (!Array.isArray(rows)) return [];
    return rows.slice(0, limit || 400).map(function (row) {
      var out = {};
      fields.forEach(function (f) {
        out[f] = String((row && row[f]) == null ? '' : row[f]).slice(0, 600);
      });
      return out;
    });
  }

  // Typed-in house figures. Digits or blank, nothing else - blank means "use
  // whatever the guest list works out".
  function cleanHouse(given) {
    var out = {};
    ['adults', 'children', 'rooms'].forEach(function (f) {
      var v = String((given && given[f]) == null ? '' : given[f]).replace(/[^\d]/g, '');
      out[f] = v.slice(0, 6);
    });
    return out;
  }

  // The week summary read off the Dhathuru: a row of dates and a row of values
  // per figure, all kept as the text the sheet had.
  var DHA_WEEK_KEYS = ['occ', 'pax', 'welcomeRms', 'farewellRms', 'occupiedRms',
    'oooRms', 'welcomeGuests', 'farewellGuests'];

  function cleanWeek(given) {
    if (!given || !Array.isArray(given.dates) || !given.dates.length) return null;
    var dates = given.dates.slice(0, 31).map(function (d) {
      return String(d == null ? '' : d).slice(0, 20);
    });
    var rows = {};
    DHA_WEEK_KEYS.forEach(function (k) {
      var line = given.rows && given.rows[k];
      if (!Array.isArray(line)) return;
      rows[k] = dates.map(function (_, i) {
        return String(line[i] == null ? '' : line[i]).slice(0, 30);
      });
    });
    return { dates: dates, rows: rows };
  }

  // The header block read off the Dhathuru: a title and three label/value
  // lists, all kept as the text the sheet had.
  function cleanPairs(list, limit) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, limit).map(function (p) {
      return {
        label: String((p && p.label) == null ? '' : p.label).slice(0, 80),
        value: String((p && p.value) == null ? '' : p.value).slice(0, 80)
      };
    });
  }

  function cleanHeader(given) {
    if (!given || typeof given !== 'object') return null;
    return {
      title: String(given.title == null ? '' : given.title).slice(0, 80),
      stats: cleanPairs(given.stats, 8),
      targets: cleanPairs(given.targets, 12)
    };
  }

  // The host grid: a name, a fixed number of villa slots, and a remark.
  function cleanHosts(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.slice(0, 60).map(function (row) {
      var villas = [];
      var given = (row && Array.isArray(row.villas)) ? row.villas : [];
      for (var i = 0; i < DHA_HOST_SLOTS; i++) {
        villas.push(String(given[i] == null ? '' : given[i]).slice(0, 40));
      }
      return {
        name: String((row && row.name) == null ? '' : row.name).slice(0, 60),
        villas: villas,
        remarks: String((row && row.remarks) == null ? '' : row.remarks).slice(0, 300)
      };
    });
  }

  // Tab keys are 'IMPORT', 'GIH', 'MASTER', 'SETTINGS' and outlet names.
  function pickTabs(given) {
    if (!Array.isArray(given)) return [];
    var out = [];
    given.forEach(function (t) {
      var s = String(t == null ? '' : t).slice(0, 60);
      if (s && out.indexOf(s) === -1) out.push(s);
    });
    return out.slice(0, 60);
  }

  function isDate(s) { return DATE_RE.test(String(s || '')); }

  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

  function emptyDay(date) {
    return {
      bizDate: date,
      data: [],
      source: '',
      lastImport: null,
      outlets: {},
      outletRevisions: {},
      dhathuru: emptyDhathuru(),
      revision: 0,
      updatedAt: 0,
      seededFrom: null
    };
  }

  function ok(body, extra) {
    var res = { status: 200, body: body === undefined ? { ok: true } : body };
    if (extra && extra.cookie) res.cookie = extra.cookie;
    return res;
  }

  function fail(status, message, extra) {
    var body = { error: message };
    if (extra) Object.keys(extra).forEach(function (k) { body[k] = extra[k]; });
    return { status: status, body: body };
  }

  function createApi(deps) {
    var store = deps.store;
    var hash = deps.hash;
    var verify = deps.verify;
    var token = deps.token;
    var now = deps.now || function () { return Date.now(); };
    var defaultSettings = deps.defaultSettings || {};
    var log = deps.log || function () {};

    var sessions = Object.create(null);   // token -> { expires, kind, id, name }
    var loginTries = Object.create(null); // ip -> { count, until }

    /* ---------------------------------------------------------- sessions */

    function sessionFrom(req) {
      var t = (req.cookies || {})[SESSION_COOKIE];
      if (!t) return null;
      var s = sessions[t];
      if (!s) return null;
      if (s.expires < now()) { delete sessions[t]; return null; }
      return s;
    }

    function isAdmin(req) {
      var s = sessionFrom(req);
      return !!s && s.kind === 'admin';
    }

    function startSession(kind, id, name) {
      var t = token();
      sessions[t] = { expires: now() + SESSION_MS, kind: kind, id: id, name: name };
      return t;
    }

    /* ------------------------------------------------------------ rights */

    function userStore() { return store.get('users') || { list: [] }; }

    function findUser(id) {
      var list = userStore().list;
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return null;
    }

    function findUserByName(name) {
      var wanted = String(name || '').trim().toLowerCase();
      var list = userStore().list;
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].name).toLowerCase() === wanted) return list[i];
      }
      return null;
    }

    function allRights(value) {
      var out = {};
      RIGHT_KEYS.forEach(function (k) { out[k] = value; });
      return out;
    }

    // Settings saved before rights existed have no `access` key. Falling back
    // to the shipped defaults rather than to nothing matters: otherwise
    // upgrading would silently lock the floor out of seating until an admin
    // happened to save the settings once.
    function anonymousRights() {
      var conf = settingsDoc().settings || {};
      var given = (conf.access && conf.access.anonymous) ||
        (defaultSettings.access && defaultSettings.access.anonymous) || {};
      var out = allRights(false);
      RIGHT_KEYS.forEach(function (k) { if (given[k]) out[k] = true; });
      return out;
    }

    // Who this request is, and what they may do. Not signing in is a normal
    // state, not a failure - it just means the anonymous set applies.
    function actor(req) {
      var s = sessionFrom(req);
      // An admin is never hidden from anything - otherwise the switch that put
      // a tab away could end up behind the tab it put away.
      if (s && s.kind === 'admin') {
        return { kind: 'admin', name: 'admin', rights: allRights(true), hiddenTabs: [] };
      }
      if (s && s.kind === 'user') {
        var u = findUser(s.id);
        if (u) {
          var rights = allRights(false);
          RIGHT_KEYS.forEach(function (k) { if (u.rights && u.rights[k]) rights[k] = true; });
          return {
            kind: 'user', id: u.id, name: u.name, rights: rights,
            hiddenTabs: pickTabs(u.hiddenTabs)
          };
        }
        // The account was deleted mid-session.
        delete sessions[(req.cookies || {})[SESSION_COOKIE]];
      }
      var conf = settingsDoc().settings || {};
      return {
        kind: 'anonymous', name: '', rights: anonymousRights(),
        hiddenTabs: pickTabs((conf.access && conf.access.anonymousTabs) ||
          (defaultSettings.access && defaultSettings.access.anonymousTabs))
      };
    }

    function may(req, right) { return !!actor(req).rights[right]; }

    function publicUser(u) {
      return { id: u.id, name: u.name, rights: u.rights || {}, hiddenTabs: pickTabs(u.hiddenTabs) };
    }

    // Only the keys we know about, only as booleans - a client cannot invent a
    // right by sending one.
    function pickRights(given) {
      var out = {};
      RIGHT_KEYS.forEach(function (k) { out[k] = !!(given && given[k]); });
      return out;
    }

    function actorRightsFor(u) {
      var out = allRights(false);
      RIGHT_KEYS.forEach(function (k) { if (u.rights && u.rights[k]) out[k] = true; });
      return out;
    }

    function sessionCookie(value, maxAgeSeconds) {
      return {
        name: SESSION_COOKIE,
        value: value,
        maxAge: maxAgeSeconds,
        httpOnly: true,
        sameSite: 'Lax',
        path: '/'
      };
    }

    /* ------------------------------------------------------------- admin */

    // The admin record is created on first run by the server, not here.
    function adminRecord() { return store.get('admin') || null; }

    function throttled(ip) {
      var t = loginTries[ip];
      if (!t) return false;
      if (t.until && t.until > now()) return true;
      if (t.until && t.until <= now()) { delete loginTries[ip]; return false; }
      return false;
    }

    function noteLoginFailure(ip) {
      var t = loginTries[ip] || (loginTries[ip] = { count: 0, until: 0 });
      t.count++;
      if (t.count >= LOGIN_MAX_TRIES) {
        t.until = now() + LOGIN_WINDOW_MS;
        t.count = 0;
      }
    }

    /* --------------------------------------------------------- settings */

    function settingsDoc() {
      return store.get('settings') || { settings: clone(defaultSettings), revision: 0, updatedAt: 0 };
    }

    /* -------------------------------------------------------------- days */

    function dayKey(date) { return 'day:' + date; }

    function knownDays() {
      return store.keys('day:')
        .map(function (k) { return k.slice(4); })
        .filter(isDate)
        .sort();
    }

    function loadDay(date) { return store.get(dayKey(date)) || null; }

    function saveDay(date, doc) {
      doc.updatedAt = now();
      store.set(dayKey(date), doc);
      return doc;
    }

    // A day nobody has touched yet still shows the most recent GIH list, because
    // one Opera export covers a range of dates and each service day reuses it.
    // Nothing is written until somebody actually seats a room or imports.
    function dayForRead(date) {
      var doc = loadDay(date);
      if (doc) return { day: doc, exists: true };

      var days = knownDays().filter(function (d) { return d !== date; });
      var seed = null;
      for (var i = days.length - 1; i >= 0; i--) {
        var candidate = loadDay(days[i]);
        if (candidate && candidate.data && candidate.data.length) { seed = candidate; break; }
      }

      var fresh = emptyDay(date);
      if (seed) {
        fresh.data = clone(seed.data);
        fresh.source = seed.source;
        fresh.lastImport = clone(seed.lastImport);
        fresh.seededFrom = seed.bizDate;
        // The Dhathuru's week summary covers seven days and its targets change
        // rarely, so one upload should serve the whole week. Both carry; only
        // the five day tables stay behind, being that day's own.
        if (seed.dhathuru && seed.dhathuru.week) {
          fresh.dhathuru.week = clone(seed.dhathuru.week);
        }
        if (seed.dhathuru && seed.dhathuru.header) {
          fresh.dhathuru.header = clone(seed.dhathuru.header);
          // The title names the day it was written for, so it does not carry.
          fresh.dhathuru.header.title = '';
        }
      }
      return { day: fresh, exists: false };
    }

    // Materialises the day so it can be written to.
    function dayForWrite(date) {
      var read = dayForRead(date);
      return read.day;
    }

    function record(req, action, detail) {
      var entry = {
        at: now(),
        who: isAdmin(req) ? 'admin' : 'staff',
        station: String((req.body && req.body.station) || (req.query && req.query.station) || '')
          .slice(0, 40),
        action: action,
        detail: detail || null
      };
      store.append('log', entry);
      log(entry);
      return entry;
    }

    /* ------------------------------------------------------------ routes */

    function handle(req) {
      var method = req.method;
      var parts = String(req.path || '').replace(/^\/+|\/+$/g, '').split('/');
      var body = req.body || {};
      var query = req.query || {};

      if (parts[0] !== 'api') return fail(404, 'Not an API route.');
      var route = parts.slice(1);

      /* ------------------------------------------------------- session */

      if (route[0] === 'session' && method === 'GET') {
        var me = actor(req);
        return ok({ admin: me.kind === 'admin', who: me.kind, name: me.name,
          rights: me.rights, hiddenTabs: me.hiddenTabs });
      }

      if (route[0] === 'login' && method === 'POST') {
        var ip = req.ip || 'unknown';
        if (throttled(ip)) {
          return fail(429, 'Too many attempts. Wait a minute and try again.');
        }

        var given = String(body.password || '');
        var wantedName = String(body.name || '').trim();

        // No name means the admin password. A name means one of the accounts.
        if (!wantedName) {
          var rec = adminRecord();
          if (!rec) return fail(503, 'No admin password is set on this server yet.');
          if (!verify(given, rec)) {
            noteLoginFailure(ip);
            return fail(401, 'That password is not right.');
          }
          delete loginTries[ip];
          var t = startSession('admin', null, 'admin');
          var res = ok({ admin: true, who: 'admin', name: 'admin',
            rights: allRights(true), hiddenTabs: [] });
          res.cookie = sessionCookie(t, Math.floor(SESSION_MS / 1000));
          record({ cookies: { gih_session: t }, body: body }, 'signed in as admin');
          return res;
        }

        var user = findUserByName(wantedName);
        if (!user || !verify(given, user)) {
          noteLoginFailure(ip);
          return fail(401, 'That name and password do not match.');
        }
        delete loginTries[ip];
        var ut = startSession('user', user.id, user.name);
        var ures = ok({
          admin: false, who: 'user', name: user.name,
          rights: actorRightsFor(user), hiddenTabs: pickTabs(user.hiddenTabs)
        });
        ures.cookie = sessionCookie(ut, Math.floor(SESSION_MS / 1000));
        record({ cookies: { gih_session: ut }, body: body }, 'signed in as ' + user.name);
        return ures;
      }

      /* ------------------------------------------------------ user admin */

      if (route[0] === 'users') {
        if (!isAdmin(req)) return fail(403, 'Only an admin can manage users.');

        if (method === 'GET' && route.length === 1) {
          return ok({ users: userStore().list.map(publicUser) });
        }

        if (method === 'POST' && route.length === 1) {
          var name = String(body.name || '').trim();
          if (!name) return fail(400, 'A user needs a name.');
          if (name.toLowerCase() === 'admin') return fail(400, '"admin" is reserved.');
          if (findUserByName(name)) return fail(409, 'There is already a user called ' + name + '.');
          var pw = String(body.password || '');
          if (pw.length < 4) return fail(400, 'Use at least 4 characters.');

          var docU = userStore();
          var made = hash(pw);
          var fresh = {
            id: token().slice(0, 12),
            name: name,
            salt: made.salt,
            hash: made.hash,
            rights: pickRights(body.rights),
            hiddenTabs: pickTabs(body.hiddenTabs),
            createdAt: now()
          };
          docU.list.push(fresh);
          store.set('users', docU);
          record(req, 'added the user ' + name);
          return ok({ user: publicUser(fresh) });
        }

        if (route[1] && method === 'PUT') {
          var docE = userStore();
          var target = null;
          for (var ui = 0; ui < docE.list.length; ui++) {
            if (docE.list[ui].id === route[1]) { target = docE.list[ui]; break; }
          }
          if (!target) return fail(404, 'No such user.');

          if (body.name !== undefined) {
            var nn = String(body.name).trim();
            if (!nn) return fail(400, 'A user needs a name.');
            var clash = findUserByName(nn);
            if (clash && clash.id !== target.id) return fail(409, 'That name is taken.');
            target.name = nn;
          }
          if (body.password) {
            if (String(body.password).length < 4) return fail(400, 'Use at least 4 characters.');
            var re = hash(String(body.password));
            target.salt = re.salt;
            target.hash = re.hash;
            // Their existing sessions are no longer theirs to keep.
            Object.keys(sessions).forEach(function (k) {
              if (sessions[k].kind === 'user' && sessions[k].id === target.id) delete sessions[k];
            });
          }
          if (body.rights !== undefined) target.rights = pickRights(body.rights);
          if (body.hiddenTabs !== undefined) target.hiddenTabs = pickTabs(body.hiddenTabs);

          store.set('users', docE);
          record(req, 'changed the user ' + target.name);
          return ok({ user: publicUser(target) });
        }

        if (route[1] && method === 'DELETE') {
          var docD = userStore();
          var before = docD.list.length;
          var goneName = '';
          docD.list = docD.list.filter(function (u) {
            if (u.id === route[1]) { goneName = u.name; return false; }
            return true;
          });
          if (docD.list.length === before) return fail(404, 'No such user.');
          store.set('users', docD);
          Object.keys(sessions).forEach(function (k) {
            if (sessions[k].kind === 'user' && sessions[k].id === route[1]) delete sessions[k];
          });
          record(req, 'removed the user ' + goneName);
          return ok({ ok: true });
        }
      }

      if (route[0] === 'logout' && method === 'POST') {
        var current = sessionFrom(req);
        if (current) delete sessions[current];
        var out = ok({ admin: false });
        out.cookie = sessionCookie('', 0);
        return out;
      }

      if (route[0] === 'password' && method === 'POST') {
        if (!isAdmin(req)) return fail(403, 'Sign in as admin first.');
        var existing = adminRecord();
        if (!verify(String(body.current || ''), existing)) {
          return fail(401, 'The current password is not right.');
        }
        var next = String(body.next || '');
        if (next.length < 8) return fail(400, 'Use at least 8 characters.');
        var made = hash(next);
        made.updatedAt = now();
        store.set('admin', made);
        // Every other admin session is now stale - but not this one, which is
        // the token in our own cookie, not the session object it points at.
        var keep = (req.cookies || {})[SESSION_COOKIE];
        Object.keys(sessions).forEach(function (k) {
          if (k !== keep && sessions[k].kind === 'admin') delete sessions[k];
        });
        record(req, 'changed the admin password');
        return ok({ ok: true });
      }

      /* ------------------------------------------------------ settings */

      if (route[0] === 'settings' && method === 'GET') {
        var sd = settingsDoc();
        return ok({ settings: sd.settings, revision: sd.revision });
      }

      if (route[0] === 'settings' && method === 'PUT') {
        if (!body.settings || typeof body.settings !== 'object') {
          return fail(400, 'No settings in the request.');
        }
        var doc = settingsDoc();

        // Switching Lunch/Dinner is a settings write but an operational act, so
        // it has its own right. Anything beyond that needs the settings right,
        // checked here and not only in the browser.
        if (!may(req, 'settings')) {
          var proposed = clone(body.settings);
          var existing = clone(doc.settings || {});
          var serviceOnly = proposed.service !== existing.service;
          proposed.service = existing.service;
          if (!(serviceOnly && JSON.stringify(proposed) === JSON.stringify(existing) &&
                may(req, 'service'))) {
            return fail(403, 'You do not have rights to change the settings.');
          }
        }
        doc.settings = clone(body.settings);
        doc.revision = (doc.revision || 0) + 1;
        doc.updatedAt = now();
        store.set('settings', doc);
        record(req, 'changed the settings', { revision: doc.revision });
        return ok({ revision: doc.revision });
      }

      /* ---------------------------------------------------------- days */

      if (route[0] === 'days' && method === 'GET') {
        var list = knownDays().map(function (d) {
          var doc = loadDay(d) || {};
          var seated = 0;
          Object.keys(doc.outlets || {}).forEach(function (o) {
            seated += (doc.outlets[o] || []).length;
          });
          return {
            date: d,
            rooms: (doc.data || []).length,
            seated: seated,
            source: doc.source || '',
            updatedAt: doc.updatedAt || 0
          };
        });
        return ok({ days: list });
      }

      if (route[0] === 'day' && route[1]) {
        var date = route[1];
        if (!isDate(date)) return fail(400, 'Expected a date as YYYY-MM-DD.');

        // GET /api/day/:date
        if (route.length === 2 && method === 'GET') {
          var read = dayForRead(date);
          return ok({ day: read.day, exists: read.exists });
        }

        // DELETE /api/day/:date
        if (route.length === 2 && method === 'DELETE') {
          if (!isAdmin(req)) return fail(403, 'Only an admin can delete a day.');
          if (!loadDay(date)) return fail(404, 'No day stored for ' + date + '.');
          store.del(dayKey(date));
          record(req, 'deleted a day', { date: date });
          return ok({ ok: true });
        }

        // POST /api/day/:date/import
        if (route[2] === 'import' && method === 'POST') {
          if (!may(req, 'importData')) return fail(403, 'You do not have rights to upload a report.');
          if (!Array.isArray(body.data)) return fail(400, 'No records in the request.');

          var target = dayForWrite(date);
          target.data = clone(body.data);
          target.source = String(body.source || '');
          target.lastImport = clone(body.lastImport) || null;
          target.seededFrom = null;
          if (!body.keepSeating) {
            target.outlets = {};
            target.outletRevisions = {};
          }
          target.revision = (target.revision || 0) + 1;
          saveDay(date, target);
          record(req, 'uploaded a report', {
            date: date, rooms: target.data.length, source: target.source
          });
          return ok({ day: target });
        }

        // PUT /api/day/:date/data - an admin correcting the GIH list by hand.
        if (route[2] === 'data' && method === 'PUT') {
          // The list goes up whole, so adding a line and correcting one take
          // the same route. Any of the three rights may write it.
          if (!may(req, 'guestList') && !may(req, 'gihAdd') && !may(req, 'gihWelcome')) {
            return fail(403, 'You do not have rights to edit the guest list.');
          }
          if (!Array.isArray(body.data)) return fail(400, 'No records in the request.');

          var edited = dayForWrite(date);
          edited.data = clone(body.data);
          edited.revision = (edited.revision || 0) + 1;
          saveDay(date, edited);
          record(req, 'edited the guest list', { date: date, rooms: edited.data.length });
          return ok({ revision: edited.revision });
        }

        // PUT /api/day/:date/dhathuru - the hand-kept half of the Dhathuru
        // sheet: room moves, celebrations and host allocations. Floor work, so
        // it has its own right rather than being an admin job.
        if (route[2] === 'dhathuru' && method === 'PUT') {
          if (!may(req, 'dhathuru')) {
            return fail(403, 'You do not have rights to edit the Dhathuru sheet.');
          }
          var dDay = dayForWrite(date);
          var whoD = actor(req);
          dDay.dhathuru = {
            welcome: cleanRows(body.welcome, DHA_FIELDS.welcome),
            farewell: cleanRows(body.farewell, DHA_FIELDS.farewell),
            moves: cleanRows(body.moves, DHA_FIELDS.moves),
            celebrations: cleanRows(body.celebrations, DHA_FIELDS.celebrations),
            hosts: cleanHosts(body.hosts),
            house: cleanHouse(body.house),
            week: cleanWeek(body.week),
            header: cleanHeader(body.header),
            note: String(body.note == null ? '' : body.note).slice(0, 2000),
            updatedAt: now(),
            by: whoD.name || 'someone'
          };
          dDay.revision = (dDay.revision || 0) + 1;
          saveDay(date, dDay);
          record(req, 'updated the Dhathuru sheet', {
            date: date,
            welcome: dDay.dhathuru.welcome.length,
            farewell: dDay.dhathuru.farewell.length,
            moves: dDay.dhathuru.moves.length,
            celebrations: dDay.dhathuru.celebrations.length,
            hosts: dDay.dhathuru.hosts.length
          });
          return ok({ revision: dDay.revision, dhathuru: dDay.dhathuru });
        }

        // POST /api/day/:date/reset - empty every outlet for the day. The one
        // button that throws away a whole service's work, so it stands alone.
        if (route[2] === 'reset' && method === 'POST') {
          if (!may(req, 'reset')) {
            return fail(403, 'You do not have rights to reset the day.');
          }
          var toClear = dayForWrite(date);
          var cleared = 0;
          Object.keys(toClear.outlets || {}).forEach(function (o) {
            cleared += (toClear.outlets[o] || []).length;
            toClear.outlets[o] = [];
            toClear.outletRevisions[o] = (toClear.outletRevisions[o] || 0) + 1;
          });
          toClear.revision = (toClear.revision || 0) + 1;
          saveDay(date, toClear);
          record(req, 'reset the day', { date: date, covers: cleared });
          return ok({ revision: toClear.revision, cleared: cleared, day: toClear });
        }

        // POST /api/day/:date/master - a snapshot of the compiled Master view,
        // kept so the sheet that was actually worked from can be looked at
        // again once the outlets have moved on.
        if (route[2] === 'master' && method === 'POST') {
          if (!may(req, 'master')) {
            return fail(403, 'You do not have rights to save the Master sheet.');
          }
          if (!Array.isArray(body.rows)) return fail(400, 'No rows in the request.');

          var withMaster = dayForWrite(date);
          withMaster.masters = withMaster.masters || [];
          var who = actor(req);
          var snapshot = {
            id: token().slice(0, 10),
            at: now(),
            by: who.name || 'someone',
            station: String(body.station || '').slice(0, 40),
            service: String(body.service || '').toUpperCase(),
            note: String(body.note || '').slice(0, 120),
            rows: clone(body.rows),
            summary: clone(body.summary) || null
          };
          withMaster.masters.push(snapshot);
          // Keep the last dozen; this is a working record, not an archive.
          if (withMaster.masters.length > 12) {
            withMaster.masters = withMaster.masters.slice(-12);
          }
          withMaster.revision = (withMaster.revision || 0) + 1;
          saveDay(date, withMaster);
          record(req, 'saved the Master sheet', { date: date, covers: snapshot.rows.length });
          return ok({ snapshot: { id: snapshot.id, at: snapshot.at, by: snapshot.by,
            covers: snapshot.rows.length }, revision: withMaster.revision });
        }

        // PUT /api/day/:date/remarks - one room's Remarks, which is the column
        // staff fill in during service. Deliberately not admin-only, and one
        // room at a time so two stations never overwrite each other's notes.
        if (route[2] === 'remarks' && method === 'PUT') {
          if (!may(req, 'remarks')) {
            return fail(403, 'You do not have rights to write remarks.');
          }
          var room = String(body.room == null ? '' : body.room).trim();
          if (!room) return fail(400, 'No room named.');

          var noted = dayForWrite(date);
          var hit = null;
          for (var ri = 0; ri < noted.data.length; ri++) {
            if (String(noted.data[ri].room).trim() === room) { hit = noted.data[ri]; break; }
          }
          if (!hit) return fail(404, 'Room ' + room + ' is not in the list for ' + date + '.');

          hit.remarks = String(body.remarks == null ? '' : body.remarks);
          noted.revision = (noted.revision || 0) + 1;
          saveDay(date, noted);
          record(req, 'set a remark', { date: date, room: room });
          return ok({ revision: noted.revision, room: room, remarks: hit.remarks });
        }

        // PUT /api/day/:date/outlet
        if (route[2] === 'outlet' && method === 'PUT') {
          if (!may(req, 'seat')) return fail(403, 'You do not have rights to seat rooms.');
          var outlet = String(body.outlet || '');
          if (!outlet) return fail(400, 'No outlet named.');
          if (!Array.isArray(body.rows)) return fail(400, 'No rows in the request.');

          var doc2 = dayForWrite(date);

          // Emptying a sheet that had people on it is a different act from
          // seating, and worth its own right - it is the one that loses work.
          // Recognised from the rows themselves rather than trusting a flag.
          if (!body.rows.length && (doc2.outlets[outlet] || []).length &&
              !may(req, 'clear')) {
            return fail(403, 'You do not have rights to clear a whole outlet.');
          }
          doc2.outletRevisions = doc2.outletRevisions || {};
          var currentRev = doc2.outletRevisions[outlet] || 0;

          // Conflicts are checked per outlet, so two people working different
          // outlets never block each other - only two people on the same one do.
          if (body.baseRevision != null && body.baseRevision !== currentRev) {
            return fail(409, 'Someone else changed ' + outlet + ' while you were editing.', {
              conflict: true,
              outlet: outlet,
              rows: doc2.outlets[outlet] || [],
              outletRevision: currentRev,
              revision: doc2.revision
            });
          }

          doc2.outlets[outlet] = clone(body.rows);
          doc2.outletRevisions[outlet] = currentRev + 1;
          doc2.revision = (doc2.revision || 0) + 1;
          saveDay(date, doc2);
          record(req, 'seated ' + outlet, { date: date, rooms: body.rows.length });
          return ok({
            revision: doc2.revision,
            outletRevision: doc2.outletRevisions[outlet]
          });
        }
      }

      /* --------------------------------------------------------- pulse */

      // Cheap enough to poll: what a client needs to know whether to refetch.
      if (route[0] === 'pulse' && method === 'GET') {
        var pDate = String(query.date || '');
        var pDay = isDate(pDate) ? loadDay(pDate) : null;
        var pMe = actor(req);
        return ok({
          dayRevision: pDay ? pDay.revision : 0,
          dayExists: !!pDay,
          settingsRevision: settingsDoc().revision,
          admin: pMe.kind === 'admin',
          who: pMe.kind,
          name: pMe.name,
          rights: pMe.rights,
          hiddenTabs: pMe.hiddenTabs,
          serverTime: now()
        });
      }

      /* ----------------------------------------------------------- log */

      if (route[0] === 'log' && method === 'GET') {
        if (!isAdmin(req)) return fail(403, 'Only an admin can read the change log.');
        var limit = Math.min(parseInt(query.limit, 10) || 200, MAX_LOG);
        return ok({ entries: store.tail('log', limit) });
      }

      /* ----------------------------------------------------- bootstrap */

      if (route[0] === 'bootstrap' && method === 'GET') {
        var bDate = isDate(query.date) ? query.date : null;
        var days = knownDays();
        var chosen = bDate || days[days.length - 1] || null;
        var bMe = actor(req);
        var payload = {
          admin: bMe.kind === 'admin',
          who: bMe.kind,
          name: bMe.name,
          rights: bMe.rights,
          hiddenTabs: bMe.hiddenTabs,
          hasAdminPassword: !!adminRecord(),
          settings: settingsDoc().settings,
          settingsRevision: settingsDoc().revision,
          days: days,
          serverTime: now()
        };
        if (chosen) {
          var b = dayForRead(chosen);
          payload.day = b.day;
          payload.dayExists = b.exists;
        } else {
          payload.day = null;
          payload.dayExists = false;
        }
        return ok(payload);
      }

      return fail(404, 'No such API route: ' + method + ' /' + parts.join('/'));
    }

    return {
      handle: handle,
      // Exposed for the server's first-run setup and for tests.
      setAdminPassword: function (password) {
        var made = hash(password);
        made.updatedAt = now();
        store.set('admin', made);
        return made;
      },
      hasAdminPassword: function () { return !!adminRecord(); },
      sessionCookieName: SESSION_COOKIE
    };
  }

  return { createApi: createApi, emptyDay: emptyDay, SESSION_COOKIE: SESSION_COOKIE };
});
