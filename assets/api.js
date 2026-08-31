/* Client for the backend.
 *
 * The app has to keep working when the server does not - a service does not
 * stop because a PC rebooted - so every call reports failure rather than
 * throwing, and the app falls back to browser-local storage when `online` is
 * false. Going offline and coming back is normal, not an error state.
 *
 * Exposes: window.GihApi (client half; the server half of the same name lives
 * in server/lib/api.js and the two never meet).
 */
(function () {
  'use strict';

  var BASE = 'api';
  var TIMEOUT_MS = 12000;

  // Offline, this browser is on its own and may do everything. Online, the
  // server decides and sends the set down with every reply.
  var ALL = ['seat', 'clear', 'remarks', 'guestList', 'gihAdd', 'gihWelcome',
    'bizDate', 'service', 'master', 'importData', 'dhathuru', 'reset', 'settings'];

  function full() {
    var out = {};
    ALL.forEach(function (k) { out[k] = true; });
    return out;
  }

  var state = {
    online: false,
    admin: false,
    who: 'anonymous',
    name: '',
    rights: full(),
    hiddenTabs: [],
    checked: false,
    lastError: ''
  };

  var listeners = [];
  function notify() {
    listeners.forEach(function (fn) { try { fn(state); } catch (e) {} });
  }

  function setOnline(on, why) {
    if (state.online === on) return;
    state.online = on;
    state.lastError = on ? '' : (why || '');
    // Losing the server hands the browser back its own copy, and with it the
    // run of that copy - there is nobody left to ask.
    if (!on) {
      state.admin = false;
      state.who = 'anonymous';
      state.name = '';
      state.rights = full();
    }
    notify();
  }

  var TOKEN_KEY = 'gih_session_token';
  function getStoredToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function setStoredToken(t) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  }

  // Applies whatever the server said about who we are. Any reply may carry it.
  function adoptIdentity(body) {
    if (!body || typeof body !== 'object') return;
    if (body.token) setStoredToken(body.token);
    var changed = false;

    if (typeof body.admin === 'boolean' && state.admin !== body.admin) {
      state.admin = body.admin;
      changed = true;
    }
    if (typeof body.who === 'string' && state.who !== body.who) {
      state.who = body.who;
      changed = true;
    }
    if (typeof body.name === 'string' && state.name !== body.name) {
      state.name = body.name;
      changed = true;
    }
    if (body.rights && typeof body.rights === 'object') {
      if (JSON.stringify(body.rights) !== JSON.stringify(state.rights)) {
        state.rights = body.rights;
        changed = true;
      }
    }
    if (Array.isArray(body.hiddenTabs)) {
      if (JSON.stringify(body.hiddenTabs) !== JSON.stringify(state.hiddenTabs)) {
        state.hiddenTabs = body.hiddenTabs;
        changed = true;
      }
    }
    if (changed) notify();
  }

  // Every response comes back as { ok, status, body, error } - never a rejection,
  // so no caller has to wrap a request in try/catch to stay alive.
  function request(method, path, body) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, TIMEOUT_MS) : null;

    var init = {
      method: method,
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    };
    var token = getStoredToken();
    if (token) {
      init.headers['Authorization'] = 'Bearer ' + token;
    }
    if (controller) init.signal = controller.signal;
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    return fetch(BASE + '/' + path, init).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.text().then(function (text) {
        var parsed = null;
        try { parsed = text ? JSON.parse(text) : {}; } catch (e) { parsed = null; }

        if (parsed === null) {
          // A login portal or a stray static file - not our API.
          setOnline(false, 'The server answered with something that was not JSON.');
          return { ok: false, status: res.status, body: null, error: 'Unexpected reply from the server.' };
        }

        setOnline(true);
        adoptIdentity(parsed);

        if (!res.ok) {
          return {
            ok: false, status: res.status, body: parsed,
            error: parsed.error || ('Request failed (' + res.status + ').')
          };
        }
        return { ok: true, status: res.status, body: parsed, error: '' };
      });
    }).catch(function (e) {
      if (timer) clearTimeout(timer);
      var why = e && e.name === 'AbortError'
        ? 'The server did not answer in time.'
        : 'Could not reach the server.';
      setOnline(false, why);
      return { ok: false, status: 0, body: null, error: why, offline: true };
    });
  }

  return window.GihApi = {
    state: state,
    subscribe: function (fn) { listeners.push(fn); },

    isOnline: function () { return state.online; },
    isAdmin: function () { return state.online && state.admin; },
    isSignedIn: function () { return state.online && state.who !== 'anonymous'; },
    whoName: function () { return state.name; },

    /* The one question the whole UI asks: may this person do X? */
    may: function (right) {
      if (!state.online) return true;
      return !!state.rights[right];
    },

    // Tabs this person does not see. Empty offline, and empty for an admin.
    hiddenTabs: function () {
      return state.online ? (state.hiddenTabs || []) : [];
    },

    putDhathuru: function (date, sheet) {
      return request('PUT', 'day/' + encodeURIComponent(date) + '/dhathuru', sheet);
    },

    resetDay: function (date, station) {
      return request('POST', 'day/' + encodeURIComponent(date) + '/reset',
        { station: station });
    },

    bootstrap: function (date) {
      return request('GET', 'bootstrap?date=' + encodeURIComponent(date || ''))
        .then(function (res) {
          state.checked = true;
          return res;
        });
    },

    pulse: function (date) {
      return request('GET', 'pulse?date=' + encodeURIComponent(date || ''));
    },

    // No name means the admin password; a name means one of the accounts.
    login: function (password, name) {
      return request('POST', 'login', { password: password, name: name || '' });
    },

    logout: function () {
      setStoredToken('');
      return request('POST', 'logout').then(function (res) {
        state.admin = false;
        state.who = 'anonymous';
        state.name = '';
        return request('GET', 'session').then(function () { return res; });
      });
    },

    listUsers: function () { return request('GET', 'users'); },
    addUser: function (user) { return request('POST', 'users', user); },
    updateUser: function (id, patch) {
      return request('PUT', 'users/' + encodeURIComponent(id), patch);
    },
    removeUser: function (id) {
      return request('DELETE', 'users/' + encodeURIComponent(id));
    },

    saveMaster: function (date, payload) {
      return request('POST', 'day/' + encodeURIComponent(date) + '/master', payload);
    },

    changePassword: function (current, next) {
      return request('POST', 'password', { current: current, next: next });
    },

    getSettings: function () { return request('GET', 'settings'); },
    putSettings: function (settings, station) {
      return request('PUT', 'settings', { settings: settings, station: station });
    },

    getDay: function (date) { return request('GET', 'day/' + encodeURIComponent(date)); },
    listDays: function () { return request('GET', 'days'); },
    deleteDay: function (date) { return request('DELETE', 'day/' + encodeURIComponent(date)); },

    importDay: function (date, payload) {
      return request('POST', 'day/' + encodeURIComponent(date) + '/import', payload);
    },

    putData: function (date, data, station) {
      return request('PUT', 'day/' + encodeURIComponent(date) + '/data',
        { data: data, station: station });
    },

    putRemarks: function (date, room, remarks, station) {
      return request('PUT', 'day/' + encodeURIComponent(date) + '/remarks',
        { room: room, remarks: remarks, station: station });
    },

    putOutlet: function (date, outlet, rows, baseRevision, station) {
      return request('PUT', 'day/' + encodeURIComponent(date) + '/outlet', {
        outlet: outlet, rows: rows, baseRevision: baseRevision, station: station
      });
    },

    getLog: function (limit) {
      return request('GET', 'log?limit=' + (limit || 200));
    }
  };
})();
