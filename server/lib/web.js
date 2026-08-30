/* HTTP odds and ends: cookies, bodies, static files. Node built-ins only. */
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

function parseCookies(header) {
  var out = {};
  String(header || '').split(';').forEach(function (part) {
    var at = part.indexOf('=');
    if (at === -1) return;
    var k = part.slice(0, at).trim();
    if (!k) return;
    try { out[k] = decodeURIComponent(part.slice(at + 1).trim()); }
    catch (e) { out[k] = part.slice(at + 1).trim(); }
  });
  return out;
}

function serialiseCookie(c) {
  var bits = [c.name + '=' + encodeURIComponent(c.value)];
  bits.push('Path=' + (c.path || '/'));
  if (c.maxAge != null) bits.push('Max-Age=' + c.maxAge);
  if (c.httpOnly) bits.push('HttpOnly');
  if (c.sameSite) bits.push('SameSite=' + c.sameSite);
  if (c.secure) bits.push('Secure');
  return bits.join('; ');
}

// Reads a JSON body, refusing anything oversized rather than buffering it.
function readJsonBody(req, limitBytes) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var size = 0;
    var done = false;

    req.on('data', function (chunk) {
      if (done) return;
      size += chunk.length;
      if (size > limitBytes) {
        done = true;
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', function () {
      if (done) return;
      done = true;
      var text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); }
      catch (e) { reject(Object.assign(new Error('Body was not valid JSON.'), { status: 400 })); }
    });

    req.on('error', function (e) {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

function sendJson(res, status, body, cookie) {
  var text = JSON.stringify(body);
  var headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  };
  if (cookie) headers['Set-Cookie'] = serialiseCookie(cookie);
  res.writeHead(status, headers);
  res.end(text);
}

/* Serves a file from `root`, refusing anything that escapes it. */
function serveStatic(res, root, urlPath, onMiss) {
  var decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0]); }
  catch (e) { return onMiss(); }

  if (decoded === '/' || decoded === '') decoded = '/index.html';

  var target = path.normalize(path.join(root, decoded));
  var rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && target.indexOf(rootWithSep) !== 0) return onMiss();

  fs.stat(target, function (err, stat) {
    if (err || !stat.isFile()) return onMiss();

    var etag = '"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"';
    var type = TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';

    res.setHeader('Content-Type', type);
    res.setHeader('ETag', etag);
    // The app is edited in place while it runs, so never let a stale copy stick.
    res.setHeader('Cache-Control', 'no-cache');

    if (res.req && res.req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      return res.end();
    }

    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(target).pipe(res);
  });
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes || 32).toString('hex');
}

function hashPassword(password, salt) {
  var useSalt = salt || crypto.randomBytes(16).toString('hex');
  var derived = crypto.scryptSync(String(password), useSalt, 64).toString('hex');
  return { salt: useSalt, hash: derived };
}

function verifyPassword(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  var derived = crypto.scryptSync(String(password), record.salt, 64);
  var known = Buffer.from(record.hash, 'hex');
  if (known.length !== derived.length) return false;
  return crypto.timingSafeEqual(known, derived);
}

// Readable but not guessable - what gets printed on first run.
function suggestPassword() {
  var words = ['harbour', 'lagoon', 'reef', 'palm', 'coral', 'tide', 'sunset', 'atoll',
    'anchor', 'compass', 'lantern', 'monsoon'];
  var pick = function () { return words[crypto.randomInt(words.length)]; };
  return pick() + '-' + pick() + '-' + crypto.randomInt(1000, 9999);
}

module.exports = {
  parseCookies: parseCookies,
  serialiseCookie: serialiseCookie,
  readJsonBody: readJsonBody,
  sendJson: sendJson,
  serveStatic: serveStatic,
  randomToken: randomToken,
  hashPassword: hashPassword,
  verifyPassword: verifyPassword,
  suggestPassword: suggestPassword
};
