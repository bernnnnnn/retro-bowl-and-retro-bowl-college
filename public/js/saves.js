// Ben's Bowls save library: read, back up, export, import and sync game saves.
// The games themselves save into this site's browser storage (namespaced by
// save-shim.js); this file works with that data from the menu and player pages.

const FORMAT = 'bens-bowls-save';
const ns = (id) => `bb:${id}:`;
const metaKey = (id) => `bb-meta:${id}`;
const idbListKey = (id) => `bb-idb:${id}`;
const CLOUD_KEY = 'bb-cloud-code';

// ------------------------------------------------------------------ helpers
function lsKeys(prefix) {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) out.push(k);
  }
  return out;
}

function hashString(str) {
  // cyrb53 - small, fast, good enough to spot changes
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// IndexedDB values can hold things JSON can't (binary data, dates...).
async function enc(v) {
  if (v === undefined) return { __bb: 'u' };
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return { __bb: 'date', v: v.getTime() };
  if (v instanceof ArrayBuffer) return { __bb: 'ab', v: toB64(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) {
    return { __bb: 'ta', t: v.constructor.name, v: toB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  }
  if (v instanceof Blob) return { __bb: 'blob', type: v.type, v: toB64(new Uint8Array(await v.arrayBuffer())) };
  if (v instanceof Map) return { __bb: 'map', v: await Promise.all([...v].map(async ([a, b]) => [await enc(a), await enc(b)])) };
  if (v instanceof Set) return { __bb: 'set', v: await Promise.all([...v].map(enc)) };
  if (Array.isArray(v)) return Promise.all(v.map(enc));
  const o = {};
  for (const k of Object.keys(v)) o[k] = await enc(v[k]);
  if (o.__bb !== undefined) return { __bb: 'obj', v: o }; // escape a real "__bb" field
  return o;
}
function dec(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(dec);
  switch (v.__bb) {
    case 'u': return undefined;
    case 'date': return new Date(v.v);
    case 'ab': return fromB64(v.v).buffer;
    case 'ta': {
      const C = globalThis[v.t] || Uint8Array;
      const bytes = fromB64(v.v);
      return new C(bytes.buffer, 0, bytes.byteLength / (C.BYTES_PER_ELEMENT || 1));
    }
    case 'blob': return new Blob([fromB64(v.v)], { type: v.type });
    case 'map': return new Map(v.v.map(([a, b]) => [dec(a), dec(b)]));
    case 'set': return new Set(v.v.map(dec));
    case 'obj': {
      const o = {};
      for (const k of Object.keys(v.v)) o[k] = dec(v.v[k]);
      return o;
    }
  }
  const o = {};
  for (const k of Object.keys(v)) o[k] = dec(v[k]);
  return o;
}

const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

async function idbNames(id) {
  const prefix = ns(id);
  const names = new Set();
  try { JSON.parse(localStorage.getItem(idbListKey(id)) || '[]').forEach((n) => names.add(n)); } catch {}
  if (indexedDB.databases) {
    try {
      for (const d of await indexedDB.databases()) {
        if (d.name && d.name.startsWith(prefix)) names.add(d.name.slice(prefix.length));
      }
    } catch {}
  }
  return [...names];
}

// Opens an existing database. Never creates one (that could break the game).
function openExisting(realName) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(realName);
    let created = false;
    req.onupgradeneeded = (e) => { if (e.oldVersion === 0) { created = true; req.transaction.abort(); } };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = (e) => { if (created) { e.preventDefault(); resolve(null); } else reject(req.error); };
    req.onblocked = () => {};
  });
}

async function dumpDb(id, name) {
  const db = await openExisting(ns(id) + name);
  if (!db) return null;
  try {
    const out = { name, version: db.version, stores: [] };
    const storeNames = [...db.objectStoreNames];
    if (!storeNames.length) return out;
    const tx = db.transaction(storeNames, 'readonly');
    const raw = await Promise.all(storeNames.map((sn) => new Promise((resolve, reject) => {
      const store = tx.objectStore(sn);
      const info = {
        name: sn,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes: [...store.indexNames].map((n) => {
          const ix = store.index(n);
          return { name: n, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry };
        }),
        records: [],
      };
      const cur = store.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve(info);
        info.records.push([c.primaryKey, c.value]);
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    })));
    for (const info of raw) {
      info.records = await Promise.all(info.records.map(async ([k, v]) => [await enc(k), await enc(v)]));
      out.stores.push(info);
    }
    return out;
  } finally {
    db.close();
  }
}

async function restoreDb(id, dump) {
  const realName = ns(id) + dump.name;
  await reqP(indexedDB.deleteDatabase(realName)).catch(() => {});
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(realName, dump.version || 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const s of dump.stores) {
        const opts = { autoIncrement: !!s.autoIncrement };
        if (s.keyPath !== null && s.keyPath !== undefined) opts.keyPath = s.keyPath;
        const store = d.createObjectStore(s.name, opts);
        for (const ix of s.indexes || []) store.createIndex(ix.name, ix.keyPath, { unique: ix.unique, multiEntry: ix.multiEntry });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    if (dump.stores.length) {
      const tx = db.transaction(dump.stores.map((s) => s.name), 'readwrite');
      for (const s of dump.stores) {
        const store = tx.objectStore(s.name);
        const inline = s.keyPath !== null && s.keyPath !== undefined;
        for (const [k, v] of s.records) inline ? store.put(dec(v)) : store.put(dec(v), dec(k));
      }
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
    }
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------ public

/** Everything the game has saved, as one JSON-friendly object. */
export async function snapshot(id) {
  const prefix = ns(id);
  const local = {};
  for (const k of lsKeys(prefix).sort()) local[k.slice(prefix.length)] = localStorage.getItem(k);
  const dbs = [];
  if (window.indexedDB) {
    for (const name of (await idbNames(id)).sort()) {
      try {
        const d = await dumpDb(id, name);
        if (d) dbs.push(d);
      } catch (e) {
        console.warn('Could not read save database', name, e);
      }
    }
  }
  const meta = getMeta(id);
  return { format: FORMAT, version: 1, game: id, updatedAt: meta.updatedAt || 0, localStorage: local, indexedDB: dbs };
}

export function contentHash(snap) {
  return hashString(JSON.stringify([snap.localStorage, snap.indexedDB]));
}

export function isEmpty(snap) {
  if (!snap) return true;
  const hasDbData = (snap.indexedDB || []).some((d) => d.stores.some((s) => s.records.length));
  return Object.keys(snap.localStorage || {}).length === 0 && !hasDbData;
}

/** Replace this game's save data with a snapshot. Only call while the game is NOT running. */
export async function restore(snap) {
  if (!snap || snap.format !== FORMAT) throw new Error('That file is not a Ben\'s Bowls save.');
  const id = snap.game;
  await wipe(id, { keepMeta: true });
  for (const [k, v] of Object.entries(snap.localStorage || {})) localStorage.setItem(ns(id) + k, v);
  const names = [];
  for (const d of snap.indexedDB || []) {
    await restoreDb(id, d);
    names.push(d.name);
  }
  localStorage.setItem(idbListKey(id), JSON.stringify(names));
  setMeta(id, { updatedAt: snap.updatedAt || Date.now(), hash: contentHash(snap) });
}

/** Delete this game's save data. */
export async function wipe(id, { keepMeta = false } = {}) {
  for (const k of lsKeys(ns(id))) localStorage.removeItem(k);
  if (window.indexedDB) {
    for (const name of await idbNames(id)) await reqP(indexedDB.deleteDatabase(ns(id) + name)).catch(() => {});
  }
  localStorage.removeItem(idbListKey(id));
  if (!keepMeta) localStorage.removeItem(metaKey(id));
}

export function getMeta(id) {
  try { return JSON.parse(localStorage.getItem(metaKey(id)) || '{}'); } catch { return {}; }
}
export function setMeta(id, meta) {
  localStorage.setItem(metaKey(id), JSON.stringify({ ...getMeta(id), ...meta }));
}

/**
 * Check the current save against the last one we saw. If it changed, stamp it
 * with the current time. Returns { snap, changed }.
 */
export async function checkpoint(id) {
  const snap = await snapshot(id);
  const hash = contentHash(snap);
  const meta = getMeta(id);
  if (meta.hash === hash) return { snap, changed: false };
  const updatedAt = Date.now();
  snap.updatedAt = updatedAt;
  setMeta(id, { updatedAt, hash, lastPlayed: updatedAt });
  return { snap, changed: true };
}

export function downloadSave(snap, title) {
  const blob = new Blob([JSON.stringify(snap)], { type: 'application/json' });
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  a.href = URL.createObjectURL(blob);
  a.download = `${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-save-${date}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export async function readSaveFile(file) {
  let snap;
  try { snap = JSON.parse(await file.text()); } catch { throw new Error('That file is not a Ben\'s Bowls save.'); }
  if (!snap || snap.format !== FORMAT || !snap.game) throw new Error('That file is not a Ben\'s Bowls save.');
  return snap;
}

/** Ask the browser not to clear this site's storage when space runs low. */
export async function askPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {}
}

// ------------------------------------------------------------------ cloud
export const cloud = {
  getCode: () => localStorage.getItem(CLOUD_KEY),
  setCode: (code) => localStorage.setItem(CLOUD_KEY, code),
  clearCode: () => localStorage.removeItem(CLOUD_KEY),
  format: (code) => (code ? `${code.slice(0, 5)}-${code.slice(5)}` : ''),

  async create() {
    const r = await fetch('/api/cloud', { method: 'POST' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not make a save code.');
    return (await r.json()).code;
  },
  async info(code) {
    const r = await fetch(`/api/cloud/${encodeURIComponent(code)}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not reach cloud saves.');
    return r.json();
  },
  async fetch(code, id) {
    const r = await fetch(`/api/cloud/${encodeURIComponent(code)}/${id}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not load cloud save.');
    return r.json();
  },
  async push(code, snap) {
    const body = JSON.stringify(snap);
    const r = await fetch(`/api/cloud/${encodeURIComponent(code)}/${snap.game}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: body.length < 60000,
    });
    if (r.status === 409) return { conflict: true };
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Cloud save failed.');
    setMeta(snap.game, { cloudAt: snap.updatedAt });
    return { ok: true };
  },
};

export async function loadGames() {
  const r = await fetch('/api/games');
  return r.json();
}

export function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
