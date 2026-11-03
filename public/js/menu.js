import {
  loadGames, snapshot, isEmpty, getMeta, setMeta, restore, wipe, cloud,
  downloadSave, readSaveFile, askPersistentStorage, timeAgo,
} from './saves.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let games = [];
let cloudOn = false;

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

async function saveInfo(game) {
  if (game.external) return { has: false, external: true };
  const snap = await snapshot(game.id);
  const meta = getMeta(game.id);
  return { has: !isEmpty(snap), meta, snap };
}

async function renderGames() {
  const box = $('#games');
  box.innerHTML = '';
  for (const g of games) {
    const info = await saveInfo(g);
    let saveText;
    let dot = '';
    if (!g.installed) {
      saveText = 'Game files not added yet';
      dot = 'bad';
    } else if (info.external) {
      saveText = 'Saves are kept by the game host';
    } else if (info.has) {
      saveText = `Save found · last saved ${timeAgo(info.meta.updatedAt)}`;
      dot = 'good';
    } else {
      saveText = 'No save yet - start a new game!';
    }
    const card = document.createElement('article');
    card.className = 'card' + (g.installed ? '' : ' missing');
    card.style.setProperty('--team', g.color || '#e94f37');
    card.innerHTML = `
      <div class="art"><span>${esc(g.title)}</span></div>
      <div class="body">
        <h2>${esc(g.title)}</h2>
        <p class="tagline">${esc(g.tagline || '')}</p>
        <p class="save-line"><span class="dot ${dot}"></span>${esc(saveText)}</p>
        <a class="btn play" href="/play?game=${encodeURIComponent(g.id)}">${info.has ? '▶ CONTINUE' : '▶ PLAY'}</a>
      </div>`;
    box.appendChild(card);
  }
}

async function renderSaves() {
  const box = $('#save-rows');
  box.innerHTML = '';
  for (const g of games) {
    if (g.external) continue;
    const info = await saveInfo(g);
    const row = document.createElement('div');
    row.className = 'save-row';
    row.innerHTML = `
      <div>
        <div class="name">${esc(g.title)}</div>
        <div class="sub">${info.has ? `Last saved ${timeAgo(info.meta.updatedAt)}` : 'No save yet'}</div>
      </div>
      <div class="row">
        <button data-act="export" ${info.has ? '' : 'disabled'}>⬇ Download</button>
        <button data-act="import">⬆ Load file</button>
        <button data-act="delete" class="danger" ${info.has ? '' : 'disabled'}>✖ Delete</button>
      </div>`;
    row.querySelector('[data-act=export]').onclick = async () => {
      const snap = await snapshot(g.id);
      downloadSave(snap, g.title);
      toast(`${g.title} save downloaded.`);
    };
    row.querySelector('[data-act=import]').onclick = () => importInto(g);
    row.querySelector('[data-act=delete]').onclick = async () => {
      if (!confirm(`Delete your ${g.title} save on this device? This can't be undone (download a backup first if you want to keep it).`)) return;
      await wipe(g.id);
      toast(`${g.title} save deleted.`);
      refresh();
    };
    box.appendChild(row);
  }
}

function importInto(game) {
  const input = $('#import-file');
  input.value = '';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const snap = await readSaveFile(file);
      if (snap.game !== game.id) {
        const other = games.find((g) => g.id === snap.game);
        if (!confirm(`This file is a ${other ? other.title : snap.game} save. Load it into ${game.title} anyway?`)) return;
        snap.game = game.id;
      }
      const current = await snapshot(game.id);
      if (!isEmpty(current) && !confirm(`Replace your current ${game.title} save with this file?`)) return;
      snap.updatedAt = Date.now();
      await restore(snap);
      const code = cloud.getCode();
      if (cloudOn && code) await cloud.push(code, snap).catch(() => {});
      toast(`${game.title} save loaded!`);
      refresh();
    } catch (e) {
      toast(e.message, true);
    }
  };
  input.click();
}

// --------------------------------------------------------------- cloud UI
async function renderCloud() {
  const panel = $('#cloud-panel');
  panel.hidden = !cloudOn;
  if (!cloudOn) return;
  const body = $('#cloud-body');
  const code = cloud.getCode();
  if (code) {
    body.innerHTML = `
      <p>Cloud saves are ON. Your saves back up automatically while you play. On another device, open this site and enter this code to get your saves:</p>
      <div class="row" style="margin-bottom:12px"><span class="code">${esc(cloud.format(code))}</span></div>
      <p>Write it down - anyone with the code can load your saves.</p>
      <div class="row">
        <button id="cloud-pull">⬇ Get cloud saves now</button>
        <button id="cloud-unlink" class="danger">Turn off on this device</button>
      </div>`;
    $('#cloud-pull').onclick = () => pullAll(code, true);
    $('#cloud-unlink').onclick = () => {
      if (!confirm('Stop syncing on this device? Your saves stay here and in the cloud.')) return;
      cloud.clearCode();
      renderCloud();
    };
  } else {
    body.innerHTML = `
      <p>Play on more than one device? Turn on cloud saves to get a save code. Saves on this device get uploaded, and you can load them anywhere with the code.</p>
      <div class="row" style="margin-bottom:16px"><button id="cloud-new">☁ Get a save code</button></div>
      <p>Already have a code?</p>
      <form class="row" id="cloud-form">
        <input type="text" id="cloud-code" placeholder="XXXXX-XXXXX" autocomplete="off" aria-label="Save code">
        <button type="submit">Use code</button>
      </form>`;
    $('#cloud-new').onclick = async () => {
      try {
        const newCode = await cloud.create();
        cloud.setCode(newCode);
        await pushAll(newCode);
        toast('Cloud saves are on!');
        renderCloud();
      } catch (e) { toast(e.message, true); }
    };
    $('#cloud-form').onsubmit = async (e) => {
      e.preventDefault();
      const entered = $('#cloud-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      try {
        await cloud.info(entered);
        cloud.setCode(entered);
        await pullAll(entered, false);
        await pushAll(entered);
        toast('Connected! Your saves will sync with that code.');
        renderCloud();
      } catch (err) { toast(err.message, true); }
    };
  }
}

async function pushAll(code) {
  for (const g of games) {
    if (g.external) continue;
    const snap = await snapshot(g.id);
    if (isEmpty(snap)) continue;
    if (!snap.updatedAt) { snap.updatedAt = Date.now(); setMeta(g.id, { updatedAt: snap.updatedAt }); }
    await cloud.push(code, snap).catch(() => {});
  }
}

// Load cloud saves that are newer than what's on this device.
async function pullAll(code, announce) {
  let loaded = 0;
  try {
    const info = await cloud.info(code);
    for (const g of games) {
      if (g.external || !info.games[g.id]) continue;
      const localAt = getMeta(g.id).updatedAt || 0;
      if (info.games[g.id].updatedAt <= localAt) continue;
      const local = await snapshot(g.id);
      if (!isEmpty(local) && !confirm(`The cloud has a newer ${g.title} save (${timeAgo(info.games[g.id].updatedAt)}). Replace the save on this device with it?`)) continue;
      const snap = await cloud.fetch(code, g.id);
      if (snap) { await restore(snap); loaded++; }
    }
    if (announce) toast(loaded ? `Loaded ${loaded} save${loaded > 1 ? 's' : ''} from the cloud.` : 'This device already has your latest saves.');
  } catch (e) {
    toast(e.message, true);
  }
  refresh();
}

async function refresh() {
  await renderGames();
  await renderSaves();
}

async function init() {
  askPersistentStorage();
  try {
    const data = await loadGames();
    games = data.games;
    cloudOn = data.cloudSaves;
  } catch {
    $('#games').innerHTML = '<p>Could not load the game list. Refresh to try again.</p>';
    return;
  }
  await refresh();
  await renderCloud();
}

init();
