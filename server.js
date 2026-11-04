// Ben's Bowls - web server
// Serves the menu, the games, and (optionally) cloud saves.
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const GAMES_DIR = path.join(ROOT, 'games');
// Cloud saves are only turned on when DATA_DIR points at storage that survives
// restarts (a Render persistent disk). Without it, saves still work: they are
// kept in the player's browser.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : null;
const SAVES_DIR = DATA_DIR ? path.join(DATA_DIR, 'saves') : null;

const GAMES = JSON.parse(fs.readFileSync(path.join(ROOT, 'games.json'), 'utf8'));
const GAME_IDS = new Set(GAMES.map((g) => g.id));

const app = express();
app.disable('x-powered-by');

function isInstalled(game) {
  return fs.existsSync(path.join(GAMES_DIR, game.id, 'index.html'));
}

app.get('/healthz', (req, res) => res.send('ok'));

app.get('/api/games', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    cloudSaves: Boolean(SAVES_DIR),
    // Game files in games/<id>/ win; otherwise fall back to the game's official "url".
    games: GAMES.map((g) => {
      const local = isInstalled(g);
      const external = !local && Boolean(g.url);
      return {
        ...g,
        installed: local || external,
        src: external ? g.url : `/games/${g.id}/`,
        external,
        embeddable: external ? g.embeddable !== false : true,
      };
    }),
  });
});

// ---------------------------------------------------------------------------
// Game files. Every HTML page of a game gets a small save script injected at
// the top of <head>, which keeps each game's save data separate and tells the
// menu whenever the game saves.
// ---------------------------------------------------------------------------
function shimTag(gameId) {
  return (
    `<script>window.__BENS_BOWLS_GAME=${JSON.stringify(gameId)};</script>` +
    `<script src="/save-shim.js"></script>`
  );
}

app.get('/games/:id', (req, res, next) => {
  if (!GAME_IDS.has(req.params.id) || req.path.endsWith('/')) return next();
  res.redirect(301, `/games/${req.params.id}/`);
});

app.get('/games/:id/*', async (req, res, next) => {
  const id = req.params.id;
  if (!GAME_IDS.has(id)) return next();
  let rel;
  try {
    rel = decodeURIComponent(req.params[0] || '');
  } catch {
    return res.status(400).send('Bad path');
  }
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  if (!/\.html?$/i.test(rel)) return next();

  const gameRoot = path.join(GAMES_DIR, id);
  const file = path.resolve(gameRoot, rel);
  if (!file.startsWith(gameRoot + path.sep)) return res.status(400).send('Bad path');

  let html;
  try {
    html = await fsp.readFile(file, 'utf8');
  } catch {
    if (rel === 'index.html') {
      return res
        .status(404)
        .type('html')
        .send(
          `<body style="font-family:sans-serif;background:#111;color:#eee;padding:2em">` +
            `<h2>Game files not installed yet</h2><p>Put the game's files in ` +
            `<code>games/${id}/</code> (with <code>index.html</code> at the top) and redeploy.</p></body>`
        );
    }
    return next();
  }

  const tag = shimTag(id);
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    const at = headMatch.index + headMatch[0].length;
    html = html.slice(0, at) + tag + html.slice(at);
  } else {
    html = tag + html;
  }
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(html);
});

app.use(
  '/games',
  express.static(GAMES_DIR, {
    maxAge: '1h',
    index: false,
    dotfiles: 'ignore',
  })
);

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// ---------------------------------------------------------------------------
// Cloud saves (only when DATA_DIR is set). A player gets a random save code;
// anyone with that code can load the saves, so it acts like a password.
// ---------------------------------------------------------------------------
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function normalizeCode(raw) {
  const code = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-HJ-NP-Z2-9]{10}$/.test(code) ? code : null;
}

async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, file);
}

const cloud = express.Router();
cloud.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!SAVES_DIR) return res.status(503).json({ error: 'Cloud saves are not turned on for this site.' });
  next();
});

cloud.post('/', async (req, res) => {
  await fsp.mkdir(SAVES_DIR, { recursive: true });
  let code;
  for (;;) {
    code = newCode();
    try {
      await fsp.mkdir(path.join(SAVES_DIR, code));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  res.json({ code });
});

cloud.get('/:code', async (req, res) => {
  const code = normalizeCode(req.params.code);
  if (!code) return res.status(400).json({ error: 'That save code is not valid.' });
  const dir = path.join(SAVES_DIR, code);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'No saves found for that code.' });
  const games = {};
  for (const id of GAME_IDS) {
    try {
      const snap = JSON.parse(await fsp.readFile(path.join(dir, `${id}.json`), 'utf8'));
      games[id] = { updatedAt: snap.updatedAt || 0 };
    } catch {
      /* no save for this game yet */
    }
  }
  res.json({ code, games });
});

cloud.get('/:code/:game', async (req, res) => {
  const code = normalizeCode(req.params.code);
  if (!code || !GAME_IDS.has(req.params.game)) return res.status(400).json({ error: 'Bad request' });
  const dir = path.join(SAVES_DIR, code);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'No saves found for that code.' });
  try {
    const text = await fsp.readFile(path.join(dir, `${req.params.game}.json`), 'utf8');
    res.type('json').send(text);
  } catch {
    res.json(null);
  }
});

cloud.put('/:code/:game', express.json({ limit: '25mb' }), async (req, res) => {
  const code = normalizeCode(req.params.code);
  const game = req.params.game;
  if (!code || !GAME_IDS.has(game)) return res.status(400).json({ error: 'Bad request' });
  const dir = path.join(SAVES_DIR, code);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'No saves found for that code.' });
  const snap = req.body;
  if (!snap || snap.format !== 'bens-bowls-save' || snap.game !== game) {
    return res.status(400).json({ error: 'Not a Ben\'s Bowls save.' });
  }
  const file = path.join(dir, `${game}.json`);
  // Never let an older save overwrite a newer one.
  try {
    const existing = JSON.parse(await fsp.readFile(file, 'utf8'));
    if ((existing.updatedAt || 0) > (snap.updatedAt || 0)) {
      return res.status(409).json({ error: 'A newer save is already in the cloud.', updatedAt: existing.updatedAt });
    }
  } catch {
    /* nothing saved yet */
  }
  await writeJsonAtomic(file, snap);
  res.json({ ok: true, updatedAt: snap.updatedAt });
});

app.use('/api/cloud', cloud);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => {
  console.log(`Ben's Bowls running on http://localhost:${PORT}`);
  console.log(SAVES_DIR ? `Cloud saves ON (${SAVES_DIR})` : 'Cloud saves OFF (set DATA_DIR to enable)');
  for (const g of GAMES) {
    if (!isInstalled(g)) console.log(g.url ? `  ${g.title}: using official version at ${g.url}` : `  ! ${g.title}: no files in games/${g.id}/ yet`);
  }
});
