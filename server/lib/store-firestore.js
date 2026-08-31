/* Firestore REST Store Adapter for GIH Outlets Cover Report.
 *
 * Implements the synchronous store interface that server/lib/api.js expects,
 * with real-time backing to Google Cloud Firestore via the REST API using
 * the Firebase apiKey and database configuration from firebase-applet-config.json.
 *
 * Keys map to Firestore documents:
 *   admin            -> collection: 'system', doc: 'admin'
 *   settings         -> collection: 'system', doc: 'settings'
 *   users            -> collection: 'system', doc: 'users'
 *   day:<YYYY-MM-DD> -> collection: 'days',   doc: '<YYYY-MM-DD>'
 *   log              -> collection: 'logs'
 */
'use strict';

var fs = require('fs');
var path = require('path');
var storeFs = require('./store-fs');

function createFirestoreStore(rootDir, configPath) {
  var localStore = storeFs.createStore(rootDir);
  var appConfig = null;
  var isConnected = false;
  var baseUrl = '';
  var apiKey = '';

  try {
    var raw = fs.readFileSync(configPath || path.join(__dirname, '..', '..', 'firebase-applet-config.json'), 'utf8');
    appConfig = JSON.parse(raw);
  } catch (e) {
    // Local-only mode if no config
  }

  if (appConfig && appConfig.projectId && appConfig.apiKey) {
    var dbId = appConfig.firestoreDatabaseId || '(default)';
    baseUrl = 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(appConfig.projectId) +
              '/databases/' + encodeURIComponent(dbId) + '/documents';
    apiKey = appConfig.apiKey;
    isConnected = true;
    console.log('[Firestore] Connected via REST to project:', appConfig.projectId, 'database:', dbId);
    syncFromFirestore();
  }

  function getDocPath(key) {
    var str = String(key || '');
    if (str === 'admin') return 'system/admin';
    if (str === 'settings') return 'system/settings';
    if (str === 'users') return 'system/users';
    if (str.indexOf('day:') === 0) {
      var date = str.slice(4);
      return 'days/' + encodeURIComponent(date);
    }
    return 'misc/' + encodeURIComponent(str.replace(/[^a-zA-Z0-9_-]/g, '_'));
  }

  function toFirestoreBody(value) {
    return {
      fields: {
        json: { stringValue: JSON.stringify(value) },
        updatedAt: { stringValue: new Date().toISOString() }
      }
    };
  }

  function fromFirestoreDoc(doc) {
    if (!doc || !doc.fields) return null;
    if (doc.fields.json && typeof doc.fields.json.stringValue === 'string') {
      try {
        return JSON.parse(doc.fields.json.stringValue);
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  function restFetch(url, options) {
    if (typeof fetch === 'function') {
      return fetch(url, options);
    }
    // Fallback for older environments without global fetch
    return new Promise(function (resolve, reject) {
      try {
        var https = require('https');
        var parsed = new URL(url);
        var req = https.request({
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: parsed.pathname + parsed.search,
          method: (options && options.method) || 'GET',
          headers: (options && options.headers) || {}
        }, function (res) {
          var chunks = [];
          res.on('data', function (c) { chunks.push(c); });
          res.on('end', function () {
            var bodyText = Buffer.concat(chunks).toString('utf8');
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              json: function () {
                try { return Promise.resolve(JSON.parse(bodyText)); }
                catch (e) { return Promise.resolve(null); }
              }
            });
          });
        });
        req.on('error', reject);
        if (options && options.body) {
          req.write(options.body);
        }
        req.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  function syncFromFirestore() {
    if (!isConnected) return;

    // Sync system docs
    ['admin', 'settings', 'users'].forEach(function (sysKey) {
      var docPath = getDocPath(sysKey);
      var url = baseUrl + '/' + docPath + '?key=' + encodeURIComponent(apiKey);
      restFetch(url).then(function (res) {
        if (res.ok) {
          return res.json().then(function (doc) {
            var data = fromFirestoreDoc(doc);
            if (data !== null) {
              localStore.set(sysKey, data);
            }
          });
        } else if (res.status === 404) {
          // Document not in cloud yet, seed if present locally
          var local = localStore.get(sysKey);
          if (local) {
            set(sysKey, local);
          }
        }
      }).catch(function () {});
    });

    // Sync days collection
    var daysUrl = baseUrl + '/days?pageSize=100&key=' + encodeURIComponent(apiKey);
    restFetch(daysUrl).then(function (res) {
      if (res.ok) {
        return res.json().then(function (body) {
          var docs = (body && body.documents) || [];
          docs.forEach(function (doc) {
            var data = fromFirestoreDoc(doc);
            var parts = (doc.name || '').split('/');
            var docId = parts[parts.length - 1];
            if (data !== null && docId) {
              localStore.set('day:' + decodeURIComponent(docId), data);
            }
          });
        });
      }
    }).catch(function () {});
  }

  function get(key) {
    return localStore.get(key);
  }

  function set(key, value) {
    localStore.set(key, value);
    if (isConnected) {
      var docPath = getDocPath(key);
      var url = baseUrl + '/' + docPath + '?key=' + encodeURIComponent(apiKey);
      restFetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toFirestoreBody(value))
      }).catch(function () {});
    }
  }

  function del(key) {
    localStore.del(key);
    if (isConnected) {
      var docPath = getDocPath(key);
      var url = baseUrl + '/' + docPath + '?key=' + encodeURIComponent(apiKey);
      restFetch(url, { method: 'DELETE' }).catch(function () {});
    }
  }

  function keys(prefix) {
    return localStore.keys(prefix);
  }

  function append(key, entry) {
    localStore.append(key, entry);
    if (isConnected && key === 'log') {
      var url = baseUrl + '/logs?key=' + encodeURIComponent(apiKey);
      restFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toFirestoreBody(entry))
      }).catch(function () {});
    }
  }

  function tail(key, n) {
    return localStore.tail(key, n);
  }

  return {
    get: get,
    set: set,
    del: del,
    keys: keys,
    append: append,
    tail: tail,
    root: rootDir,
    isFirestoreEnabled: function () { return isConnected; }
  };
}

module.exports = { createFirestoreStore: createFirestoreStore };
