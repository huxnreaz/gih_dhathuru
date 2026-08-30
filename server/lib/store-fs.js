/* The storage interface api.js expects, backed by plain JSON files.
 *
 * No database: one file per key under data/, written temp-then-rename so a crash
 * mid-write cannot leave a half-written file where the real one was. A hotel
 * outlet list is a few hundred kilobytes at most, and files can be copied,
 * diffed and restored by anyone without a client.
 *
 * Keys map to paths: "day:2026-08-29" -> data/day/2026-08-29.json
 */
'use strict';

var fs = require('fs');
var path = require('path');

function safeSegment(s) {
  return String(s).replace(/[^A-Za-z0-9._-]/g, '_');
}

function createStore(rootDir) {
  fs.mkdirSync(rootDir, { recursive: true });

  function fileFor(key) {
    var bits = String(key).split(':');
    var parts = bits.map(safeSegment);
    var last = parts.pop();
    return path.join(rootDir, path.join.apply(path, parts.concat([last + '.json'])));
  }

  function logFile(key) {
    return path.join(rootDir, safeSegment(key) + '.jsonl');
  }

  function get(key) {
    try {
      return JSON.parse(fs.readFileSync(fileFor(key), 'utf8'));
    } catch (e) {
      return undefined;
    }
  }

  function set(key, value) {
    var file = fileFor(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    var tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  function del(key) {
    try { fs.unlinkSync(fileFor(key)); } catch (e) { /* already gone */ }
  }

  // Only prefixes of the form "day:" are used, so one directory level is enough.
  function keys(prefix) {
    var bits = String(prefix || '').split(':').filter(Boolean);
    var dir = path.join(rootDir, path.join.apply(path, bits.map(safeSegment)));
    var out = [];
    var names;
    try { names = fs.readdirSync(dir); } catch (e) { return out; }
    names.forEach(function (n) {
      if (!/\.json$/.test(n)) return;
      out.push(bits.join(':') + (bits.length ? ':' : '') + n.replace(/\.json$/, ''));
    });
    return out;
  }

  function append(key, entry) {
    fs.appendFileSync(logFile(key), JSON.stringify(entry) + '\n', 'utf8');
  }

  function tail(key, n) {
    var text;
    try { text = fs.readFileSync(logFile(key), 'utf8'); } catch (e) { return []; }
    var lines = text.split('\n').filter(Boolean);
    return lines.slice(Math.max(0, lines.length - n)).map(function (l) {
      try { return JSON.parse(l); } catch (e) { return { at: 0, action: 'unreadable entry' }; }
    }).reverse();
  }

  return {
    get: get, set: set, del: del, keys: keys, append: append, tail: tail,
    root: rootDir
  };
}

module.exports = { createStore: createStore };
