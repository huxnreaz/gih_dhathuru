/* Firestore Store Adapter for GIH Outlets Cover Report.
 *
 * Implements the synchronous store interface that server/lib/api.js expects,
 * with real-time backing to Google Cloud Firestore using credentials
 * and database configuration from firebase-applet-config.json.
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
  var firestore = null;
  var isConnected = false;

  var appConfig = null;
  try {
    var raw = fs.readFileSync(configPath || path.join(__dirname, '..', '..', 'firebase-applet-config.json'), 'utf8');
    appConfig = JSON.parse(raw);
  } catch (e) {
    console.warn('[Firestore] No firebase-applet-config.json found, running with local store only.');
  }

  if (appConfig && appConfig.projectId) {
    try {
      var Firestore = require('@google-cloud/firestore').Firestore;
      var dbOptions = {
        projectId: appConfig.projectId
      };
      if (appConfig.firestoreDatabaseId) {
        dbOptions.databaseId = appConfig.firestoreDatabaseId;
      }
      firestore = new Firestore(dbOptions);
      isConnected = true;
      console.log('[Firestore] Connected to project:', appConfig.projectId, 'database:', appConfig.firestoreDatabaseId || '(default)');
      
      // Async initial sync from Firestore to local cache on startup
      syncFromFirestore();
    } catch (e) {
      console.warn('[Firestore] Could not initialize Firestore client:', e.message);
    }
  }

  function getDocRef(key) {
    if (!firestore) return null;
    var str = String(key || '');
    if (str === 'admin') return firestore.collection('system').doc('admin');
    if (str === 'settings') return firestore.collection('system').doc('settings');
    if (str === 'users') return firestore.collection('system').doc('users');
    if (str.indexOf('day:') === 0) {
      var date = str.slice(4);
      return firestore.collection('days').doc(date);
    }
    return firestore.collection('misc').doc(str.replace(/[^a-zA-Z0-9_-]/g, '_'));
  }

  function syncFromFirestore() {
    if (!firestore) return;
    
    // Sync system docs
    ['admin', 'settings', 'users'].forEach(function (sysKey) {
      var ref = getDocRef(sysKey);
      if (!ref) return;
      ref.get().then(function (snap) {
        if (snap.exists) {
          var data = snap.data();
          localStore.set(sysKey, data);
        } else {
          // If Firestore is empty but local exists, seed Firestore
          var local = localStore.get(sysKey);
          if (local) {
            ref.set(local).catch(function () {});
          }
        }
      }).catch(function (err) {
        console.warn('[Firestore] Error syncing', sysKey, err.message);
      });
    });

    // Sync days
    firestore.collection('days').get().then(function (snapshot) {
      snapshot.forEach(function (doc) {
        var dayData = doc.data();
        if (dayData && doc.id) {
          localStore.set('day:' + doc.id, dayData);
        }
      });
      // Also write any local days to Firestore if not already present
      localStore.keys('day:').forEach(function (key) {
        var date = key.slice(4);
        var ref = firestore.collection('days').doc(date);
        ref.get().then(function (snap) {
          if (!snap.exists) {
            var val = localStore.get(key);
            if (val) ref.set(val).catch(function () {});
          }
        }).catch(function () {});
      });
    }).catch(function (err) {
      console.warn('[Firestore] Error syncing days:', err.message);
    });
  }

  function get(key) {
    return localStore.get(key);
  }

  function set(key, value) {
    localStore.set(key, value);
    if (firestore) {
      var ref = getDocRef(key);
      if (ref) {
        ref.set(value).catch(function (err) {
          console.warn('[Firestore] Error writing key', key, err.message);
        });
      }
    }
  }

  function del(key) {
    localStore.del(key);
    if (firestore) {
      var ref = getDocRef(key);
      if (ref) {
        ref.delete().catch(function (err) {
          console.warn('[Firestore] Error deleting key', key, err.message);
        });
      }
    }
  }

  function keys(prefix) {
    return localStore.keys(prefix);
  }

  function append(key, entry) {
    localStore.append(key, entry);
    if (firestore && key === 'log') {
      firestore.collection('logs').add(entry).catch(function (err) {
        console.warn('[Firestore] Error logging entry:', err.message);
      });
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
