/* End-to-end check of the running server.
 *
 *   npm run verify        (or: node server/verify.js)
 *
 * Starts a real server on a spare port with a throwaway data directory, drives
 * it over real HTTP with real cookies, then cleans up. Exits 0 if everything
 * passed, 1 if anything did not - so it is usable in a scheduled task too.
 *
 * Nothing here touches your live data: GIH_DATA points at a temp folder.
 */
'use strict';

var http = require('http');
var path = require('path');
var fs = require('fs');
var os = require('os');
var net = require('net');
var childProcess = require('child_process');

var PASSWORD = 'verify-password-1234';
var results = [];
var child = null;
var dataDir = null;
var savedUserId = null;
var userClient = null;
var adderClient = null;

function check(name, condition, detail) {
  results.push({ name: name, pass: !!condition, detail: condition ? null : detail });
}

function freePort() {
  return new Promise(function (resolve, reject) {
    var srv = net.createServer();
    srv.listen(0, '127.0.0.1', function () {
      var port = srv.address().port;
      srv.close(function () { resolve(port); });
    });
    srv.on('error', reject);
  });
}

/* ------------------------------------------------------------- requests */

function makeClient(port) {
  var cookies = {};

  function request(method, urlPath, body) {
    return new Promise(function (resolve, reject) {
      var payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
      var headers = { 'Accept': 'application/json' };
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
      }
      var jar = Object.keys(cookies).map(function (k) { return k + '=' + cookies[k]; });
      if (jar.length) headers['Cookie'] = jar.join('; ');

      var req = http.request({
        host: '127.0.0.1', port: port, method: method, path: urlPath, headers: headers
      }, function (res) {
        var chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          (res.headers['set-cookie'] || []).forEach(function (line) {
            var pair = line.split(';')[0];
            var at = pair.indexOf('=');
            var name = pair.slice(0, at);
            var value = pair.slice(at + 1);
            if (value === '') delete cookies[name];
            else cookies[name] = value;
          });
          var text = Buffer.concat(chunks).toString('utf8');
          var parsed = null;
          try { parsed = JSON.parse(text); } catch (e) { /* not JSON */ }
          resolve({ status: res.statusCode, body: parsed, text: text, headers: res.headers });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    request: request,
    clearCookies: function () { cookies = {}; },
    cookies: function () { return cookies; }
  };
}

function waitForServer(port, tries) {
  return new Promise(function (resolve, reject) {
    var attempt = 0;
    var poke = function () {
      attempt++;
      var req = http.request({ host: '127.0.0.1', port: port, path: '/api/session', method: 'GET' },
        function (res) { res.resume(); resolve(); });
      req.on('error', function (e) {
        if (attempt >= tries) return reject(new Error('Server never came up: ' + e.message));
        setTimeout(poke, 200);
      });
      req.end();
    };
    poke();
  });
}

/* ----------------------------------------------------------------- run */

function run() {
  var port;

  return freePort().then(function (p) {
    port = p;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gih-verify-'));

    child = childProcess.spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: Object.assign({}, process.env, {
        PORT: String(port),
        HOST: '127.0.0.1',
        GIH_DATA: dataDir,
        GIH_ADMIN_PASSWORD: PASSWORD
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    var stderr = '';
    child.stderr.on('data', function (d) { stderr += d.toString(); });
    child.stdout.on('data', function () { /* quiet */ });
    child.on('exit', function (code) {
      if (code !== 0 && code !== null) {
        console.error('Server exited early with code ' + code);
        if (stderr) console.error(stderr);
      }
    });

    return waitForServer(port, 40);
  }).then(function () {
    var c = makeClient(port);
    var today = new Date().toISOString().slice(0, 10);

    return Promise.resolve()
      /* static */
      .then(function () { return c.request('GET', '/index.html'); })
      .then(function (r) {
        check('the app itself is served', r.status === 200 && /GIH|Outlets/.test(r.text), r.status);
      })
      .then(function () { return c.request('GET', '/assets/app.js'); })
      .then(function (r) {
        check('assets are served', r.status === 200, r.status);
        check('assets get a JS content type',
          /javascript/.test(r.headers['content-type'] || ''), r.headers['content-type']);
      })
      .then(function () { return c.request('GET', '/../package.json'); })
      .then(function (r) {
        check('paths cannot escape the web root', r.status === 404, r.status);
      })
      .then(function () { return c.request('GET', '/server/data/admin.json'); })
      .then(function (r) {
        check('the password hash is not downloadable', r.status === 404, r.status);
      })
      .then(function () { return c.request('GET', '/server/server.js'); })
      .then(function (r) {
        check('the server folder is not served', r.status === 404, r.status);
      })
      .then(function () { return c.request('GET', '/server/lib/api.js'); })
      .then(function (r) {
        check('server code is not served either', r.status === 404, r.status);
      })

      /* session and settings */
      .then(function () { return c.request('GET', '/api/session'); })
      .then(function (r) { check('starts signed out', r.body && r.body.admin === false, r.body); })

      .then(function () { return c.request('GET', '/api/settings'); })
      .then(function (r) {
        check('settings are readable signed out', r.status === 200, r.status);
        check('settings defaults came from assets/config.js',
          r.body && r.body.settings && Array.isArray(r.body.settings.packages) &&
          r.body.settings.packages.length === 15,
          r.body && r.body.settings && r.body.settings.packages);
        check('default outlets came through too',
          r.body.settings.outlets && r.body.settings.outlets.length === 8,
          r.body.settings.outlets && r.body.settings.outlets.length);
      })

      .then(function () { return c.request('PUT', '/api/settings', { settings: { packages: ['X'] } }); })
      .then(function (r) { check('settings are read-only signed out', r.status === 403, r.status); })

      /* login */
      .then(function () { return c.request('POST', '/api/login', { password: 'wrong' }); })
      .then(function (r) { check('a wrong password is refused', r.status === 401, r.status); })

      .then(function () { return c.request('POST', '/api/login', { password: PASSWORD }); })
      .then(function (r) {
        check('the right password signs in', r.status === 200, r.body);
        check('a session cookie is set', !!c.cookies().gih_session, c.cookies());
        check('the cookie is HttpOnly',
          /HttpOnly/i.test((r.headers['set-cookie'] || []).join(';')), r.headers['set-cookie']);
      })

      .then(function () { return c.request('GET', '/api/session'); })
      .then(function (r) { check('the session sticks', r.body.admin === true, r.body); })

      /* the day */
      .then(function () { return c.request('GET', '/api/day/' + today); })
      .then(function (r) {
        check('an untouched day reads back empty',
          r.status === 200 && r.body.exists === false, r.body);
      })

      .then(function () {
        return c.request('POST', '/api/day/' + today + '/import', {
          data: [
            { room: '104', guest: 'Mr Tooley Joel', meal: 'AI', adults: 2, child: 0,
              arrival: '2026-08-21', departure: '2026-09-02', comment: '', remarks: '' },
            { room: '108', guest: 'Mr Bagrov Aleksandr', meal: 'AI', adults: 2, child: 2,
              arrival: '2026-08-24', departure: '2026-09-02', comment: '', remarks: '' }
          ],
          source: 'verify.js',
          station: 'verify'
        });
      })
      .then(function (r) {
        check('an admin can upload a day', r.status === 200, r.body);
        check('the upload stored both rooms', r.body.day.data.length === 2, r.body.day.data);
      })

      .then(function () { return c.request('GET', '/api/day/' + today); })
      .then(function (r) {
        check('the day reads back', r.body.exists === true && r.body.day.data.length === 2, r.body);
      })

      /* seating, and the conflict rule, as a second station */
      .then(function () {
        return c.request('PUT', '/api/day/' + today + '/outlet', {
          outlet: 'Skipjack', rows: [{ room: '104', table: '1' }],
          baseRevision: 0, station: 'verify'
        });
      })
      .then(function (r) {
        check('seating saves', r.status === 200, r.body);
        check('the outlet revision moves to 1', r.body.outletRevision === 1, r.body);
      })

      .then(function () {
        return c.request('PUT', '/api/day/' + today + '/outlet', {
          outlet: 'Skipjack', rows: [{ room: '999' }], baseRevision: 0
        });
      })
      .then(function (r) {
        check('a stale seating write is rejected', r.status === 409, r.status);
        check('the rejection carries the winning rows',
          r.body.rows && r.body.rows[0].room === '104', r.body.rows);
      })

      .then(function () {
        return c.request('PUT', '/api/day/' + today + '/outlet', {
          outlet: 'Tribe', rows: [{ room: '108' }], baseRevision: 0
        });
      })
      .then(function (r) {
        check('a different outlet is not blocked', r.status === 200, r.body);
      })

      /* a second, signed-out client sees the same day */
      .then(function () {
        var anon = makeClient(port);
        return anon.request('GET', '/api/day/' + today).then(function (r) {
          check('another station sees the shared day',
            r.body.day.data.length === 2 && r.body.day.outlets.Skipjack.length === 1, r.body.day);
          return anon.request('PUT', '/api/day/' + today + '/outlet', {
            outlet: 'Charcoal', rows: [{ room: '104' }], baseRevision: 0
          });
        }).then(function (r) {
          check('staff can seat without signing in', r.status === 200, r.body);
          return anon.request('POST', '/api/day/' + today + '/import', { data: [] });
        }).then(function (r) {
          check('staff cannot upload', r.status === 403, r.status);
        });
      })

      /* remarks - the one guest-list column staff may write */
      .then(function () {
        var anon = makeClient(port);
        return anon.request('PUT', '/api/day/' + today + '/remarks',
          { room: '104', remarks: 'window table', station: 'verify' });
      })
      .then(function (r) { check('staff can set a remark', r.status === 200, r.body); })
      .then(function () { return c.request('GET', '/api/day/' + today); })
      .then(function (r) {
        var room104 = r.body.day.data.filter(function (x) { return x.room === '104'; })[0];
        check('the remark is stored on the room', room104.remarks === 'window table', room104);
        check('the remark did not disturb the other room',
          r.body.day.data.filter(function (x) { return x.room === '108'; })[0].remarks === '',
          r.body.day.data);
      })
      .then(function () {
        return c.request('PUT', '/api/day/' + today + '/remarks', { room: '777', remarks: 'x' });
      })
      .then(function (r) { check('a remark on an unknown room is a 404', r.status === 404, r.status); })
      .then(function () {
        return c.request('PUT', '/api/day/' + today + '/remarks', { remarks: 'x' });
      })
      .then(function (r) { check('a remark with no room is a 400', r.status === 400, r.status); })

      /* editing the guest list itself is admin-only */
      .then(function () {
        var anon = makeClient(port);
        return anon.request('PUT', '/api/day/' + today + '/data', { data: [] });
      })
      .then(function (r) { check('staff cannot edit the guest list', r.status === 403, r.status); })

      /* The list goes up whole, so putting a line on it writes the same route a
       * correction does. Each of the three rights is enough on its own. */
      .then(function () {
        return c.request('POST', '/api/users', {
          name: 'adder', password: 'add-pass', rights: { gihWelcome: true }
        });
      })
      .then(function (r) { check('an admin can grant only the Welcome-add right', r.status === 200, r.body); })
      .then(function () {
        adderClient = makeClient(port);
        return adderClient.request('POST', '/api/login', { name: 'adder', password: 'add-pass' });
      })
      .then(function (r) {
        check('the add-only account signs in', r.status === 200, r.body);
        check('it has the Welcome-add right and neither of the other two',
          r.body.rights.gihWelcome === true && r.body.rights.guestList === false &&
          r.body.rights.gihAdd === false, r.body.rights);
      })
      .then(function () {
        return adderClient.request('PUT', '/api/day/' + today + '/data', {
          data: [{ room: '104', guest: 'x', meal: 'AI', adults: 1, child: 0,
            arrival: today, departure: today, comment: '', remarks: '' }]
        });
      })
      .then(function (r) {
        check('the Welcome-add right alone may write the guest list', r.status === 200, r.body);
      })
      .then(function () {
        return c.request('PUT', '/api/day/' + today + '/data', {
          data: [
            { room: '104', guest: 'Mr Tooley Joel', meal: 'AI', adults: 3, child: 0,
              arrival: '2026-08-21', departure: '2026-09-02', comment: '', remarks: 'window table' },
            { room: '108', guest: 'Mr Bagrov Aleksandr', meal: 'HB', adults: 2, child: 2,
              arrival: '2026-08-24', departure: '2026-09-02', comment: '', remarks: '' }
          ],
          station: 'verify'
        });
      })
      .then(function (r) { check('an admin can edit the guest list', r.status === 200, r.body); })
      .then(function () { return c.request('GET', '/api/day/' + today); })
      .then(function (r) {
        var room104 = r.body.day.data.filter(function (x) { return x.room === '104'; })[0];
        check('the edit stuck', room104.adults === 3, room104);
        check('editing the list keeps the seating',
          r.body.day.outlets.Skipjack.length === 1, r.body.day.outlets);
      })

      /* pulse, days, log */
      .then(function () { return c.request('GET', '/api/pulse?date=' + today); })
      .then(function (r) {
        check('pulse reports a revision', r.body.dayRevision > 0, r.body);
        check('pulse knows we are admin', r.body.admin === true, r.body);
      })

      .then(function () { return c.request('GET', '/api/days'); })
      .then(function (r) {
        check('the day is listed', r.body.days.length === 1 && r.body.days[0].date === today, r.body);
        check('the listing counts seats', r.body.days[0].seated === 3, r.body.days[0]);
      })

      .then(function () { return c.request('GET', '/api/log'); })
      .then(function (r) {
        check('the change log records the upload',
          r.body.entries.some(function (e) { return e.action === 'uploaded a report'; }),
          r.body.entries);
        check('the change log names the station',
          r.body.entries.some(function (e) { return e.station === 'verify'; }),
          r.body.entries);
      })

      /* settings round trip */
      .then(function () {
        return c.request('PUT', '/api/settings', {
          settings: { packages: ['AI', 'COMP'], commentRules: [{ contains: 'COMP/*FB', plan: 'COMP' }] }
        });
      })
      .then(function (r) { check('an admin can save settings', r.status === 200, r.body); })
      .then(function () { return c.request('GET', '/api/settings'); })
      .then(function (r) {
        check('settings persist',
          r.body.settings.commentRules[0].contains === 'COMP/*FB', r.body.settings);
        check('the settings revision moved', r.body.revision === 1, r.body.revision);
      })

      /* files really are on disk */
      .then(function () {
        var dayFile = path.join(dataDir, 'day', today + '.json');
        check('the day is a file on disk', fs.existsSync(dayFile), dayFile);
        check('the settings are a file on disk',
          fs.existsSync(path.join(dataDir, 'settings.json')), dataDir);
        check('the log is a file on disk',
          fs.existsSync(path.join(dataDir, 'log.jsonl')), dataDir);
        var onDisk = JSON.parse(fs.readFileSync(dayFile, 'utf8'));
        check('the file on disk holds the rooms', onDisk.data.length === 2, onDisk.data);
      })

      /* settings saved before rights existed must not lock the floor out */
      .then(function () {
        var stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
        delete stored.settings.access;
        fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(stored), 'utf8');
        var anon = makeClient(port);
        return anon.request('GET', '/api/session');
      })
      .then(function (r) {
        check('older settings still allow anonymous seating',
          r.body.rights.seat === true, r.body.rights);
        check('older settings still withhold what was never given',
          r.body.rights.settings === false, r.body.rights);
      })

      /* named users and their rights */
      .then(function () {
        var anon = makeClient(port);
        return anon.request('GET', '/api/users');
      })
      .then(function (r) { check('only an admin may list users', r.status === 403, r.status); })

      .then(function () {
        return c.request('POST', '/api/users', {
          name: 'nacera', password: 'floor-pass',
          rights: { seat: true, remarks: true, master: true }
        });
      })
      .then(function (r) {
        check('an admin can add a user', r.status === 200, r.body);
        check('the reply carries no password material',
          r.body.user.hash === undefined && r.body.user.salt === undefined, r.body.user);
        savedUserId = r.body.user.id;
      })
      .then(function () { return c.request('POST', '/api/users', { name: 'admin', password: 'x1234' }); })
      .then(function (r) { check('"admin" is refused as a user name', r.status === 400, r.status); })
      .then(function () {
        return c.request('POST', '/api/users', { name: 'nacera', password: 'other-pass' });
      })
      .then(function (r) { check('a duplicate user name is refused', r.status === 409, r.status); })

      // sign in as that user and check the rights bite
      .then(function () {
        userClient = makeClient(port);
        return userClient.request('POST', '/api/login', { name: 'nacera', password: 'wrong' });
      })
      .then(function (r) { check('a wrong user password is refused', r.status === 401, r.status); })
      .then(function () {
        return userClient.request('POST', '/api/login', { name: 'nacera', password: 'floor-pass' });
      })
      .then(function (r) {
        check('a user can sign in', r.status === 200, r.body);
        check('a signed-in user is not admin', r.body.admin === false, r.body);
        check('the user gets the rights they were given',
          r.body.rights.seat === true && r.body.rights.settings === false, r.body.rights);
      })
      .then(function () {
        return userClient.request('PUT', '/api/day/' + today + '/outlet',
          { outlet: 'Tribe', rows: [{ room: '104' }] });
      })
      .then(function (r) { check('a user with seat rights can seat', r.status === 200, r.body); })
      .then(function () {
        return userClient.request('PUT', '/api/settings', { settings: { packages: ['X'] } });
      })
      .then(function (r) {
        check('a user without settings rights cannot change them', r.status === 403, r.status);
      })
      .then(function () {
        return userClient.request('PUT', '/api/day/' + today + '/data', { data: [] });
      })
      .then(function (r) {
        check('a user without guest-list rights cannot edit it', r.status === 403, r.status);
      })

      /* clearing an outlet is its own right, recognised from the rows */
      .then(function () {
        return userClient.request('PUT', '/api/day/' + today + '/outlet',
          { outlet: 'Tribe', rows: [] });
      })
      .then(function (r) {
        check('a user without clear rights cannot empty an outlet', r.status === 403, r.status);
      })
      .then(function () {
        return userClient.request('PUT', '/api/day/' + today + '/outlet',
          { outlet: 'Tribe', rows: [{ room: '104' }, { room: '108' }] });
      })
      .then(function (r) { check('but may still seat into it', r.status === 200, r.body); })
      .then(function () {
        // An outlet that was already empty is not a clear.
        return userClient.request('PUT', '/api/day/' + today + '/outlet',
          { outlet: 'OT - Breakfast', rows: [] });
      })
      .then(function (r) {
        check('emptying an already-empty outlet is not a clear', r.status === 200, r.body);
      })
      .then(function () {
        return c.request('PUT', '/api/users/' + savedUserId, {
          rights: { seat: true, remarks: true, master: true, clear: true }
        });
      })
      .then(function () {
        return userClient.request('PUT', '/api/day/' + today + '/outlet',
          { outlet: 'Tribe', rows: [] });
      })
      .then(function (r) { check('with clear rights, the outlet empties', r.status === 200, r.body); })

      /* resetting the whole day */
      .then(function () {
        return userClient.request('POST', '/api/day/' + today + '/reset', {});
      })
      .then(function (r) {
        check('a user without reset rights cannot reset the day', r.status === 403, r.status);
      })
      .then(function () { return c.request('POST', '/api/day/' + today + '/reset', {}); })
      .then(function (r) {
        check('an admin can reset the day', r.status === 200, r.body);
        check('the reset reports what it cleared', r.body.cleared >= 1, r.body);
      })
      .then(function () { return c.request('GET', '/api/day/' + today); })
      .then(function (r) {
        var seated = Object.keys(r.body.day.outlets).reduce(function (t, o) {
          return t + r.body.day.outlets[o].length;
        }, 0);
        check('every outlet is empty after a reset', seated === 0, r.body.day.outlets);
        check('the guest list survives a reset', r.body.day.data.length === 2, r.body.day.data);
      })
      // put a seating back for the snapshot test below
      .then(function () {
        return c.request('PUT', '/api/day/' + today + '/outlet',
          { outlet: 'Tribe', rows: [{ room: '104', table: '2' }] });
      })

      /* hidden tabs travel with the account */
      .then(function () {
        return c.request('PUT', '/api/users/' + savedUserId, {
          hiddenTabs: ['SETTINGS', 'IMPORT']
        });
      })
      .then(function (r) {
        check('an admin can hide tabs from a user',
          r.body.user.hiddenTabs.length === 2, r.body.user);
      })
      .then(function () { return userClient.request('GET', '/api/session'); })
      .then(function (r) {
        check('the user is told which tabs to hide',
          r.body.hiddenTabs.indexOf('SETTINGS') !== -1, r.body.hiddenTabs);
      })
      .then(function () {
        // Signing in is the first thing that happens, so the reply itself has
        // to carry the hidden tabs - waiting for the next call is too late.
        var fresh = makeClient(port);
        return fresh.request('POST', '/api/login', { name: 'nacera', password: 'floor-pass' });
      })
      .then(function (r) {
        check('the login reply carries the hidden tabs',
          Array.isArray(r.body.hiddenTabs) && r.body.hiddenTabs.indexOf('SETTINGS') !== -1,
          r.body.hiddenTabs);
      })
      .then(function () { return c.request('GET', '/api/session'); })
      .then(function (r) {
        check('an admin is never hidden from anything',
          r.body.hiddenTabs.length === 0, r.body.hiddenTabs);
      })

      /* the Dhathuru sheet */
      .then(function () {
        return c.request('PUT', '/api/users/' + savedUserId, {
          rights: { seat: true, remarks: true, master: true, clear: true, dhathuru: true }
        });
      })
      .then(function () {
        return userClient.request('PUT', '/api/day/' + today + '/dhathuru', {
          welcome: [{ room: '307', status: 'VC', guest: 'Ms Suhaa Shareef',
            eta: '8:30 AM', depDate: '1 Sep 2026', pax: '2+1', nationality: 'MV',
            vip: '', mealPlan: 'BB', agent: 'F&F Rate', host: 'Leesha',
            remarks: '02N F&F of Thaaif' }],
          farewell: [{ room: '2137', status: 'VC', guest: 'Mrs Yuliia Kulaga',
            checkout: '5:40 AM', depTime: '6:10 AM',
            nationality: 'RU', pax: '2+1', vip: '', mealPlan: 'HB',
            agent: 'Maldives Bonus', host: 'Nisso', remarks: '' }],
          moves: [{ from: '129', to: '414', guest: 'Ms Valeriia Tereshchuk & Family',
            time: '8:00 AM', agent: 'Let Me Travel', pax: '2+1', host: 'Ali',
            remarks: '9:00 AM - Floating Breakfast' }],
          celebrations: [{ room: '129 -> 414', guest: 'Ms Valeriia Tereshchuk',
            celebration: 'Birthday', locationTime: 'Villa 414 / 8:00 AM',
            bedDecoration: 'In Villa 414' }],
          hosts: [{ name: 'Ali', villas: ['129', '325', '323'], remarks: '' }],
          house: { adults: '154', children: '33', rooms: '47' },
          week: {
            dates: ['30-Aug', '31-Aug', '1-Sep'],
            rows: { occ: ['39%', '34%', '33%'], pax: ['154/33', '138/30', '131/40'] }
          },
          header: {
            title: 'Sunday 30 August 2026',
            stats: [{ label: 'ADR', value: '$227' }],
            // The wall phone list is no longer part of the briefing; the
            // server should drop it rather than store it.
            hotlines: [{ label: 'Security', value: '729 2299' }],
            targets: [{ label: 'GRI MTD / YTD (Tar 97.2)', value: '95.5 / 95.3' }]
          },
          note: 'calm sea'
        });
      })
      .then(function (r) {
        check('a user with dhathuru rights can save the sheet', r.status === 200, r.body);
        check('the sheet records who saved it', r.body.dhathuru.by === 'nacera', r.body.dhathuru);
      })
      .then(function () { return c.request('GET', '/api/day/' + today); })
      .then(function (r) {
        var d = r.body.day.dhathuru;
        check('the welcome row keeps its ETA and departure date',
          d.welcome[0].eta === '8:30 AM' && d.welcome[0].depDate === '1 Sep 2026',
          d.welcome[0]);
        check('columns taken off the sheet are not stored',
          d.welcome[0].arrFlight === undefined && d.farewell[0].luggage === undefined,
          [d.welcome[0], d.farewell[0]]);
        check('the welcome row keeps its host', d.welcome[0].host === 'Leesha', d.welcome[0]);
        check('the farewell row keeps its check-out and departure times',
          d.farewell[0].checkout === '5:40 AM' && d.farewell[0].depTime === '6:10 AM',
          d.farewell[0]);
        check('the room move is stored', d.moves[0].to === '414', d.moves);
        check('the room move keeps its time and host',
          d.moves[0].time === '8:00 AM' && d.moves[0].host === 'Ali', d.moves[0]);
        check('the celebration is stored',
          d.celebrations[0].celebration === 'Birthday', d.celebrations);
        check('the celebration keeps its bed decoration',
          d.celebrations[0].bedDecoration === 'In Villa 414', d.celebrations[0]);
        check('the host grid is stored', d.hosts[0].name === 'Ali', d.hosts);
        check('the host grid is padded to 20 slots',
          d.hosts[0].villas.length === 20 && d.hosts[0].villas[2] === '323', d.hosts[0]);
        check('the typed house figures are kept',
          d.house.adults === '154' && d.house.children === '33' && d.house.rooms === '47',
          d.house);
        check('the week summary is kept',
          d.week && d.week.dates.length === 3 && d.week.rows.pax[0] === '154/33', d.week);
        check('the header block is kept',
          d.header && d.header.title === 'Sunday 30 August 2026' &&
          d.header.targets[0].value === '95.5 / 95.3', d.header);
        check('the hotlines are dropped, not stored',
          d.header.hotlines === undefined, d.header);
      })
      .then(function () {
        // The week summary covers seven days, so it should be there on a date
        // nobody has opened yet - unlike the five tables, which are day-specific.
        return c.request('GET', '/api/day/2027-03-14');
      })
      .then(function (r) {
        check('the week summary carries to an untouched day',
          r.body.day.dhathuru.week && r.body.day.dhathuru.week.rows.pax[0] === '154/33',
          r.body.day.dhathuru.week);
        check('the day tables do not carry with it',
          r.body.day.dhathuru.welcome.length === 0, r.body.day.dhathuru.welcome);
        check('the targets carry too',
          r.body.day.dhathuru.header &&
          r.body.day.dhathuru.header.targets[0].value === '95.5 / 95.3',
          r.body.day.dhathuru.header);
        check('the header title does not carry, since it names its own day',
          r.body.day.dhathuru.header.title === '', r.body.day.dhathuru.header.title);
      })
      .then(function () {
        // The house figures are counts, so anything that is not a digit goes.
        return c.request('PUT', '/api/day/' + today + '/dhathuru', {
          house: { adults: '12 people', children: '', rooms: 'many' }
        });
      })
      .then(function (r) {
        check('house figures keep only their digits',
          r.body.dhathuru.house.adults === '12' && r.body.dhathuru.house.rooms === '',
          r.body.dhathuru.house);
      })
      .then(function () {
        // Only the fields we know about survive - a client cannot smuggle extras
        // into the day document.
        return c.request('PUT', '/api/day/' + today + '/dhathuru', {
          moves: [{ from: '1', to: '2', sneaky: 'x' }], celebrations: [], hosts: []
        });
      })
      .then(function (r) {
        check('unknown fields are dropped',
          r.body.dhathuru.moves[0].sneaky === undefined, r.body.dhathuru.moves[0]);
      })
      .then(function () {
        return c.request('PUT', '/api/users/' + savedUserId, {
          rights: { seat: true, remarks: true, master: true, clear: true }
        });
      })
      .then(function () {
        return userClient.request('PUT', '/api/day/' + today + '/dhathuru', { moves: [] });
      })
      .then(function (r) {
        check('without the right, the sheet is refused', r.status === 403, r.status);
      })

      /* the Master snapshot */
      .then(function () {
        return userClient.request('POST', '/api/day/' + today + '/master', {
          rows: [{ outlet: 'Tribe', room: '104', table: '2' }],
          note: 'first sitting', service: 'DINNER', station: 'verify'
        });
      })
      .then(function (r) {
        check('a user with master rights can save a snapshot', r.status === 200, r.body);
        check('the snapshot is credited to them', r.body.snapshot.by === 'nacera', r.body.snapshot);
      })
      .then(function () {
        var anon = makeClient(port);
        return anon.request('POST', '/api/day/' + today + '/master', { rows: [] });
      })
      .then(function (r) {
        check('someone without master rights cannot save one', r.status === 403, r.status);
      })
      .then(function () { return c.request('GET', '/api/day/' + today); })
      .then(function (r) {
        check('the snapshot is stored on the day',
          r.body.day.masters && r.body.day.masters.length === 1, r.body.day.masters);
        check('the snapshot kept its note',
          r.body.day.masters[0].note === 'first sitting', r.body.day.masters[0]);
      })

      /* anonymous rights come from the settings */
      .then(function () {
        return c.request('PUT', '/api/settings', {
          settings: { access: { anonymous: { seat: false, remarks: true } } }
        });
      })
      .then(function () {
        var anon = makeClient(port);
        return anon.request('PUT', '/api/day/' + today + '/outlet',
          { outlet: 'Charcoal', rows: [{ room: '108' }] });
      })
      .then(function (r) {
        check('turning off anonymous seating takes effect', r.status === 403, r.status);
      })
      .then(function () {
        var anon = makeClient(port);
        return anon.request('PUT', '/api/day/' + today + '/remarks',
          { room: '104', remarks: 'still allowed' });
      })
      .then(function (r) {
        check('a right left on still works', r.status === 200, r.body);
      })

      /* removing a user ends their session */
      .then(function () { return c.request('DELETE', '/api/users/' + savedUserId); })
      .then(function (r) { check('an admin can remove a user', r.status === 200, r.body); })
      .then(function () { return userClient.request('GET', '/api/session'); })
      .then(function (r) {
        check('a removed user falls back to anonymous', r.body.who === 'anonymous', r.body);
      })

      /* password change */
      .then(function () {
        return c.request('POST', '/api/password', { current: 'nope', next: 'another-password' });
      })
      .then(function (r) { check('the wrong current password is refused', r.status === 401, r.status); })
      .then(function () {
        return c.request('POST', '/api/password', { current: PASSWORD, next: 'short' });
      })
      .then(function (r) { check('a too-short password is refused', r.status === 400, r.status); })
      .then(function () {
        return c.request('POST', '/api/password', { current: PASSWORD, next: 'another-password' });
      })
      .then(function (r) { check('the password can be changed', r.status === 200, r.body); })
      .then(function () { return c.request('GET', '/api/session'); })
      .then(function (r) { check('the changing session stays in', r.body.admin === true, r.body); })

      /* sign out */
      .then(function () { return c.request('POST', '/api/logout'); })
      .then(function (r) { check('sign out works', r.status === 200, r.status); })
      .then(function () { return c.request('GET', '/api/session'); })
      .then(function (r) { check('after sign out, not admin', r.body.admin === false, r.body); })
      .then(function () { return c.request('POST', '/api/login', { password: PASSWORD }); })
      .then(function (r) { check('the old password no longer works', r.status === 401, r.status); })
      .then(function () { return c.request('POST', '/api/login', { password: 'another-password' }); })
      .then(function (r) { check('the new password works', r.status === 200, r.status); })

      /* bad input */
      .then(function () { return c.request('GET', '/api/day/nonsense'); })
      .then(function (r) { check('a bad date is refused', r.status === 400, r.status); })
      .then(function () { return c.request('GET', '/api/nope'); })
      .then(function (r) { check('an unknown route is a 404', r.status === 404, r.status); });
  });
}

function cleanup() {
  if (child && !child.killed) { try { child.kill(); } catch (e) {} }
  if (dataDir) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {} }
}

run().then(function () {
  cleanup();
  var failed = results.filter(function (r) { return !r.pass; });
  results.forEach(function (r) {
    console.log((r.pass ? '  ok    ' : '  FAIL  ') + r.name +
      (r.pass ? '' : '\n          got: ' + JSON.stringify(r.detail)));
  });
  console.log('');
  console.log(results.length + ' checks, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
}).catch(function (e) {
  cleanup();
  console.error('verify could not run:', e && e.stack || e);
  process.exit(1);
});

process.on('SIGINT', function () { cleanup(); process.exit(1); });
