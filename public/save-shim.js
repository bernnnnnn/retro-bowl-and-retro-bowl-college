/*
 * Ben's Bowls save shim. The server injects this into every game page before
 * the game's own scripts run.
 *
 * It does two things:
 *  1. Gives each game its own private save space. Both games live on the same
 *     website, so without this they could overwrite each other's saves.
 *     localStorage keys become "bb:<game>:<key>" and IndexedDB databases become
 *     "bb:<game>:<name>". The game never notices.
 *  2. Tells the Ben's Bowls player page every time the game saves, so it can
 *     show "Saved" and back the save up.
 */
(function () {
  'use strict';
  var GAME = window.__BENS_BOWLS_GAME;
  if (!GAME) return;
  var P = 'bb:' + GAME + ':';
  var IDB_LIST = 'bb-idb:' + GAME;

  var real;
  try {
    real = window.localStorage;
    real.getItem('bb-test');
  } catch (e) {
    return; // storage blocked (e.g. some private modes) - nothing we can do
  }

  function post() {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'bensbowls:changed', game: GAME }, location.origin);
      }
    } catch (e) {}
  }
  var notifyTimer = null;
  function notify() {
    if (notifyTimer) return;
    notifyTimer = setTimeout(function () { notifyTimer = null; post(); }, 250);
  }

  // ---------------------------------------------------------------- storage
  var getItem = Storage.prototype.getItem;
  var setItem = Storage.prototype.setItem;
  var removeItem = Storage.prototype.removeItem;
  var keyAt = Storage.prototype.key;
  var lengthGetter = Object.getOwnPropertyDescriptor(Storage.prototype, 'length').get;

  function ownKeys() {
    var out = [];
    var n = lengthGetter.call(real);
    for (var i = 0; i < n; i++) {
      var k = keyAt.call(real, i);
      if (k && k.indexOf(P) === 0) out.push(k.slice(P.length));
    }
    return out;
  }

  var api = {
    getItem: function (k) { return getItem.call(real, P + String(k)); },
    setItem: function (k, v) { setItem.call(real, P + String(k), String(v)); notify(); },
    removeItem: function (k) { removeItem.call(real, P + String(k)); notify(); },
    clear: function () {
      ownKeys().forEach(function (k) { removeItem.call(real, P + k); });
      notify();
    },
    key: function (i) { var ks = ownKeys(); return i >= 0 && i < ks.length ? ks[i] : null; }
  };
  Object.defineProperty(api, 'length', { get: function () { return ownKeys().length; }, configurable: true });
  try { Object.setPrototypeOf(api, Storage.prototype); } catch (e) {}

  // A Proxy so that "localStorage.foo = 1" and "localStorage['foo']" work too.
  var proxy = new Proxy(api, {
    get: function (t, p) {
      if (typeof p === 'symbol' || p in t) return t[p];
      var v = t.getItem(p);
      return v === null ? undefined : v;
    },
    set: function (t, p, v) {
      if (typeof p === 'symbol') return false;
      t.setItem(p, v);
      return true;
    },
    has: function (t, p) { return p in t || (typeof p === 'string' && t.getItem(p) !== null); },
    deleteProperty: function (t, p) { if (typeof p === 'string') t.removeItem(p); return true; },
    ownKeys: function () { return ownKeys(); },
    getOwnPropertyDescriptor: function (t, p) {
      if (typeof p !== 'string') return undefined;
      var v = t.getItem(p);
      if (v === null) return undefined;
      return { value: v, writable: true, enumerable: true, configurable: true };
    }
  });

  var swapped = false;
  try {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      enumerable: true,
      get: function () { return proxy; }
    });
    swapped = window.localStorage === proxy;
  } catch (e) {}

  if (!swapped) {
    // Fallback for browsers that won't let us replace window.localStorage:
    // patch the Storage methods instead (only affects localStorage).
    Storage.prototype.getItem = function (k) { return this === real ? api.getItem(k) : getItem.call(this, k); };
    Storage.prototype.setItem = function (k, v) { return this === real ? api.setItem(k, v) : setItem.call(this, k, v); };
    Storage.prototype.removeItem = function (k) { return this === real ? api.removeItem(k) : removeItem.call(this, k); };
    Storage.prototype.key = function (i) { return this === real ? api.key(i) : keyAt.call(this, i); };
    var origClear = Storage.prototype.clear;
    Storage.prototype.clear = function () { return this === real ? api.clear() : origClear.call(this); };
  }

  // -------------------------------------------------------------- indexedDB
  var idb = window.indexedDB;
  if (idb) {
    var rememberDb = function (name) {
      try {
        var list = JSON.parse(getItem.call(real, IDB_LIST) || '[]');
        if (list.indexOf(name) === -1) {
          list.push(name);
          setItem.call(real, IDB_LIST, JSON.stringify(list));
        }
      } catch (e) {}
    };
    var forgetDb = function (name) {
      try {
        var list = JSON.parse(getItem.call(real, IDB_LIST) || '[]').filter(function (n) { return n !== name; });
        setItem.call(real, IDB_LIST, JSON.stringify(list));
      } catch (e) {}
    };
    var origOpen = idb.open;
    var origDelete = idb.deleteDatabase;
    var origDatabases = idb.databases;

    idb.open = function (name, version) {
      var req = arguments.length > 1 && version !== undefined
        ? origOpen.call(idb, P + name, version)
        : origOpen.call(idb, P + name);
      req.addEventListener('success', function () { rememberDb(String(name)); });
      return req;
    };
    idb.deleteDatabase = function (name) {
      forgetDb(String(name));
      notify();
      return origDelete.call(idb, P + name);
    };
    if (origDatabases) {
      idb.databases = function () {
        return origDatabases.call(idb).then(function (list) {
          return list
            .filter(function (d) { return d.name && d.name.indexOf(P) === 0; })
            .map(function (d) { return { name: d.name.slice(P.length), version: d.version }; });
        });
      };
    }

    var wrap = function (proto, names) {
      if (!proto) return;
      names.forEach(function (n) {
        var orig = proto[n];
        if (typeof orig !== 'function') return;
        proto[n] = function () { notify(); return orig.apply(this, arguments); };
      });
    };
    wrap(window.IDBObjectStore && IDBObjectStore.prototype, ['put', 'add', 'delete', 'clear']);
    wrap(window.IDBCursor && IDBCursor.prototype, ['update', 'delete']);
  }

  // Save one last time when the game is closed or hidden.
  window.addEventListener('pagehide', post);
})();
