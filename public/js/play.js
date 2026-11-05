import { loadGames, snapshot, isEmpty, getMeta, setMeta, restore, checkpoint, cloud, downloadSave, askPersistentStorage, timeAgo } from './saves.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const id = decodeURIComponent(location.pathname.split('/')[2] || '');

let game = null;
let cloudOn = false;
let saving = null;
let pendingSave = false;
let lastCloudPush = 0;
let cloudTimer = null;

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

function setStatus(text, kind = '') {
  $('#status').innerHTML = `<span class="dot ${kind}"></span><span class="label">${esc(text)}</span>`;
  $('#status').title = text;
}

function clock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function showNotice(html) {
  $('#stage').innerHTML = `<div class="notice"><div>${html}</div></div>`;
}

// ------------------------------------------------------------------ saving
async function save({ final = false } = {}) {
  if (!game || game.external) return;
  if (saving) { pendingSave = true; return saving; }
  saving = (async () => {
    try {
      const { snap, changed } = await checkpoint(game.id);
      if (isEmpty(snap)) { setStatus('No save yet'); return; }
      const meta = getMeta(game.id);
      const code = cloudOn && cloud.getCode();
      if (code && (meta.cloudAt || 0) < meta.updatedAt) {
        // Upload at most every 5 seconds, plus right away when leaving.
        const wait = final ? 0 : Math.max(0, 5000 - (Date.now() - lastCloudPush));
        clearTimeout(cloudTimer);
        cloudTimer = setTimeout(() => pushCloud(code), wait);
      }
      if (changed || !code) setStatus(`Saved ${clock(meta.updatedAt)}`, 'good');
    } catch (e) {
      console.error(e);
      setStatus('Save check failed', 'bad');
    } finally {
      saving = null;
      if (pendingSave) { pendingSave = false; save(); }
    }
  })();
  return saving;
}

async function pushCloud(code) {
  lastCloudPush = Date.now();
  try {
    const snap = await snapshot(game.id);
    const res = await cloud.push(code, snap);
    if (res.conflict) {
      setStatus('Newer save in cloud - saved here', 'bad');
      toast('Another device has a newer cloud save. This device\'s save was kept here only. Go back to the menu and use "Get cloud saves" to switch.', true);
    } else {
      setStatus(`Saved + cloud ${clock(snap.updatedAt)}`, 'good');
    }
  } catch {
    setStatus(`Saved ${clock(getMeta(game.id).updatedAt)} (cloud offline)`, 'good');
  }
}

// Before the game starts: grab a newer save from the cloud if there is one.
async function syncFromCloud() {
  const code = cloudOn && cloud.getCode();
  if (!code) return;
  setStatus('Checking cloud save…');
  try {
    const info = await cloud.info(code);
    const remote = info.games[game.id];
    const localAt = getMeta(game.id).updatedAt || 0;
    if (remote && remote.updatedAt > localAt) {
      const snap = await cloud.fetch(code, game.id);
      if (snap) {
        await restore(snap);
        setMeta(game.id, { cloudAt: snap.updatedAt });
        toast(`Loaded your cloud save from ${timeAgo(snap.updatedAt)}.`);
      }
    }
  } catch {
    toast('Could not reach cloud saves - playing with the save on this device.', true);
  }
}

// ------------------------------------------------------------------ start
async function start() {
  askPersistentStorage();
  let data;
  try {
    data = await loadGames();
  } catch {
    showNotice('<h2>Could not load</h2><p>Check your connection and refresh.</p>');
    return;
  }
  cloudOn = data.cloudSaves;
  game = data.games.find((g) => g.id === id);
  if (!game) {
    showNotice('<h2>Game not found</h2><p><a href="/">Back to the menu</a></p>');
    setStatus('');
    return;
  }
  document.title = `${game.title} · 67 Bowls`;
  $('#title').textContent = game.title;

  if (!game.installed) {
    setStatus('Not installed', 'bad');
    $('#backup').disabled = true;
    showNotice(`<h2>${esc(game.title)} isn't installed yet</h2>
      <p>Put the game's files in the <code>games/${esc(game.id)}/</code> folder of the website
      (so that <code>games/${esc(game.id)}/index.html</code> exists), then redeploy.</p>
      <p><a href="/">Back to the menu</a></p>`);
    return;
  }

  if (game.external) {
    $('#backup').disabled = true;
    setStatus('Saves kept by game host');
  } else {
    await syncFromCloud();
    setMeta(game.id, { lastPlayed: Date.now() });
    const meta = getMeta(game.id);
    const snap = await snapshot(game.id);
    setStatus(isEmpty(snap) ? 'No save yet' : `Save loaded (${timeAgo(meta.updatedAt)})`, isEmpty(snap) ? '' : 'good');
  }

  const frame = document.createElement('iframe');
  frame.src = game.src;
  frame.title = game.title;
  frame.allow = 'autoplay; fullscreen; gamepad';
  frame.setAttribute('allowfullscreen', '');
  $('#stage').innerHTML = '';
  $('#stage').appendChild(frame);
  frame.addEventListener('load', () => { try { frame.contentWindow.focus(); } catch {} });

  if (game.external) return;

  // The save shim inside the game tells us whenever the game saves.
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || e.data.type !== 'site:changed' || e.data.game !== game.id) return;
    save();
  });
  // Safety net: also check every 15 seconds and whenever the tab is hidden.
  setInterval(save, 15000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save({ final: true }); });
  window.addEventListener('pagehide', () => save({ final: true }));
}

$('#backup').onclick = async () => {
  if (!game || game.external) return;
  const snap = await snapshot(game.id);
  if (isEmpty(snap)) { toast('Nothing to back up yet - play a bit first!'); return; }
  downloadSave(snap, game.title);
  toast('Backup downloaded. Load it from the menu\'s "Your saves" section any time.');
};

$('#fullscreen').onclick = () => {
  const el = $('#stage');
  if (document.fullscreenElement) document.exitFullscreen();
  else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
};

$('#back').onclick = async (e) => {
  if (!game || game.external) return;
  e.preventDefault();
  await save({ final: true });
  const code = cloudOn && cloud.getCode();
  const meta = getMeta(game.id);
  if (code && (meta.cloudAt || 0) < meta.updatedAt) {
    clearTimeout(cloudTimer);
    await pushCloud(code);
  }
  location.href = '/';
};

start();
