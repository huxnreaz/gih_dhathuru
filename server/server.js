/* GIH Outlets Cover Report - server.
 *
 * Node built-ins only. There is nothing to install: `node server/server.js`.
 *
 *   PORT                 port to listen on            (default 8080)
 *   HOST                 interface to bind            (default 0.0.0.0, so the LAN can reach it)
 *   GIH_DATA             where the JSON files live    (default server/data)
 *   GIH_ADMIN_PASSWORD   set or reset the admin password on start
 *
 *   node server/server.js --set-password "new password"   set it and exit
 *
 * On first run, if no admin password exists, one is generated and printed once.
 */
'use strict';

var http = require('http');
var path = require('path');
var fs = require('fs');
var vm = require('vm');

var web = require('./lib/web');
var storeFirestore = require('./lib/store-firestore');
var apiLib = require('./lib/api');

var WEB_ROOT = path.resolve(__dirname, '..');
var DATA_DIR = process.env.GIH_DATA || path.join(__dirname, 'data');
var PORT = parseInt(process.env.PORT, 10) || 3000;
var HOST = process.env.HOST || '0.0.0.0';
var BODY_LIMIT = 24 * 1024 * 1024;   // a big GIH list is a few MB of JSON

/* The client's settings defaults are the settings defaults - reading them out of
 * assets/config.js keeps one source of truth instead of a copy that drifts. */
function loadDefaultSettings() {
  try {
    var src = fs.readFileSync(path.join(WEB_ROOT, 'assets', 'config.js'), 'utf8');
    var sandbox = {
      window: {},
      localStorage: { getItem: function () { return null; }, setItem: function () {} },
      JSON: JSON,
      console: { log: function () {}, warn: function () {}, error: function () {} }
    };
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { timeout: 3000 });
    var cfg = sandbox.window.GihConfig;
    return (cfg && cfg.DEFAULTS) || null;
  } catch (e) {
    console.warn('Could not read the settings defaults from assets/config.js:', e.message);
    return null;
  }
}

var store = storeFirestore.createFirestoreStore(DATA_DIR, path.join(WEB_ROOT, 'firebase-applet-config.json'));

var api = apiLib.createApi({
  store: store,
  hash: function (password) { return web.hashPassword(password); },
  verify: web.verifyPassword,
  token: function () { return web.randomToken(32); },
  now: Date.now,
  defaultSettings: loadDefaultSettings() || {}
});

/* ------------------------------------------------------------ first run */

function setPasswordAndExit(password) {
  api.setAdminPassword(password);
  console.log('Admin password updated. Everyone signed in elsewhere will need to sign in again.');
  process.exit(0);
}

var setFlag = process.argv.indexOf('--set-password');
if (setFlag !== -1) {
  var given = process.argv[setFlag + 1];
  if (!given) {
    console.error('Usage: node server/server.js --set-password "the new password"');
    process.exit(1);
  }
  // Whoever is at this console can already read and edit the JSON files by
  // hand, so a length rule here would only be for show. The rule that matters
  // is on /api/password, which anyone on the network can reach.
  if (given.length < 8) {
    console.log('Note: "' + given + '" is short. Anyone who reaches this server on the');
    console.log('network can try passwords against it, so keep it to the LAN.');
  }
  setPasswordAndExit(given);
}

if (process.env.GIH_ADMIN_PASSWORD) {
  api.setAdminPassword(process.env.GIH_ADMIN_PASSWORD);
  console.log('Admin password taken from GIH_ADMIN_PASSWORD.');
} else if (!api.hasAdminPassword()) {
  var generated = web.suggestPassword();
  api.setAdminPassword(generated);
  console.log('');
  console.log('  ┌───────────────────────────────────────────────────────────┐');
  console.log('  │  First run - this is the admin password. Write it down.    │');
  console.log('  │                                                           │');
  console.log('  │      ' + generated + new Array(Math.max(1, 53 - generated.length)).join(' ') + '│');
  console.log('  │                                                           │');
  console.log('  │  Change it from the Control Panel, or restart with        │');
  console.log('  │  --set-password "something else".                         │');
  console.log('  └───────────────────────────────────────────────────────────┘');
  console.log('');
}

/* --------------------------------------------------------------- server */

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function parseQuery(url) {
  var out = {};
  var at = url.indexOf('?');
  if (at === -1) return out;
  url.slice(at + 1).split('&').forEach(function (pair) {
    if (!pair) return;
    var eq = pair.indexOf('=');
    var k = eq === -1 ? pair : pair.slice(0, eq);
    var v = eq === -1 ? '' : pair.slice(eq + 1);
    try { out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); }
    catch (e) { out[k] = v; }
  });
  return out;
}

var server = http.createServer(function (req, res) {
  res.req = req;
  var url = req.url || '/';
  var pathname = url.split('?')[0];

  // The app and the API are the same origin, so no CORS is needed. Keep the
  // usual belt-and-braces headers on anyway.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  var notFound = function () {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  };

  if (pathname.indexOf('/api/') !== 0) {
    // The server folder sits inside the web root so the whole thing is one
    // folder to copy. It must never be reachable over HTTP - data/admin.json
    // holds the password hash, and data/day/*.json holds guest names.
    if (/^\/server(\/|$)/i.test(pathname) || /(^|\/)(package(-lock)?\.json)$/i.test(pathname)) {
      return notFound();
    }
    return web.serveStatic(res, WEB_ROOT, pathname, notFound);
  }

  var handleWith = function (body) {
    var result;
    try {
      result = api.handle({
        method: req.method,
        path: pathname,
        query: parseQuery(url),
        body: body,
        cookies: web.parseCookies(req.headers.cookie),
        headers: req.headers,
        ip: clientIp(req)
      });
    } catch (e) {
      console.error('API error on', req.method, pathname, '-', e && e.stack);
      result = { status: 500, body: { error: 'The server hit an unexpected error.' } };
    }
    web.sendJson(res, result.status, result.body, result.cookie);
  };

  if (req.method === 'GET' || req.method === 'DELETE' || req.method === 'HEAD') {
    return handleWith({});
  }

  web.readJsonBody(req, BODY_LIMIT).then(handleWith).catch(function (e) {
    web.sendJson(res, e.status || 400, { error: e.message || 'Could not read the request.' });
  });
});

server.listen(PORT, HOST, function () {
  var nets = require('os').networkInterfaces();
  var addresses = [];
  Object.keys(nets).forEach(function (name) {
    (nets[name] || []).forEach(function (net) {
      if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
    });
  });

  console.log('GIH Outlets Cover Report');
  console.log('  serving   ' + WEB_ROOT);
  console.log('  data      ' + DATA_DIR);
  console.log('  local     http://localhost:' + PORT + '/');
  addresses.forEach(function (a) {
    console.log('  network   http://' + a + ':' + PORT + '/');
  });
  console.log('');
  console.log('Ctrl+C to stop.');
});

server.on('error', function (e) {
  if (e.code === 'EADDRINUSE') {
    console.error('Port ' + PORT + ' is already in use. Start with a different one, e.g.');
    console.error('  set PORT=8090 && node server/server.js');
  } else {
    console.error(e.message);
  }
  process.exit(1);
});

module.exports = server;
