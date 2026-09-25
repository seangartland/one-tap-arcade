// Leaderboard backend: a single secret GitHub gist holding
// { pulse: { scores: [...], plays: n, hist: [...], runs: n }, users: {...} }.
// Old { game: [...] } boards auto-migrate on read.
// Env vars (set on the Vercel project): GIST_ID, GITHUB_TOKEN (encrypted, server-side only).

const crypto = require('crypto');

const GAMES = ['pulse', 'tower', 'breakout', 'lander', 'dodge', 'lanes', 'meteor', 'pin', 'span'];
const FILENAME = 'arcade-leaderboard.json';
const MAX_ENTRIES = 10;
const USER_RE = /^[A-Z0-9_]{3,12}$/;

/* Score histogram: counts every completed run's final score (including 0s,
   which never reach the named leaderboard). Edges are per-game; bucket i
   covers scores (EDGES[i-1], EDGES[i]], with bucket 0 = {0} exactly. */
const HIST_EDGES = {
  pulse:    [0, 5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, Infinity],
  tower:    [0, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 90, 110, 140, Infinity],
  breakout: [0, 10, 20, 30, 40, 50, 65, 80, 95, 110, 130, 160, 200, 260, Infinity],
  lander:   [0, 10, 20, 30, 40, 50, 65, 80, 100, 120, 150, 180, 230, 300, Infinity],
  dodge:    [0, 5, 10, 15, 20, 30, 40, 50, 60, 75, 90, 110, 140, 180, Infinity],
  lanes:    [0, 5, 10, 15, 20, 28, 36, 46, 58, 72, 90, 115, 150, 200, Infinity],
  meteor:   [0, 5, 10, 15, 25, 35, 50, 65, 85, 110, 140, 180, 230, 300, Infinity],
  pin:      [0, 5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, Infinity],
  span:     [0, 5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, Infinity],
};
function histBin(score, game) {
  const edges = HIST_EDGES[game] || HIST_EDGES.pulse;
  for (let i = 0; i < edges.length; i++) if (score <= edges[i]) return i;
  return edges.length - 1;
}
function normHist(v) {
  const n = HIST_EDGES.pulse.length;
  if (Array.isArray(v) && v.length === n && v.every((x) => Number.isInteger(x) && x >= 0)) return v.slice();
  return new Array(n).fill(0);
}

const GIST_ID = process.env.GIST_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

function json(res, status, obj) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function ghHeaders() {
  return {
    Authorization: 'Bearer ' + GITHUB_TOKEN,
    'User-Agent': 'seans-arcade',
    Accept: 'application/vnd.github+json',
  };
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function normGame(v) {
  if (Array.isArray(v)) return { scores: v, plays: 0, hist: normHist(), runs: 0 };
  if (v && Array.isArray(v.scores)) return {
    scores: v.scores,
    plays: Math.max(0, Number(v.plays) || 0),
    hist: normHist(v.hist),
    runs: Math.max(0, Number(v.runs) || 0),
  };
  return { scores: [], plays: 0, hist: normHist(), runs: 0 };
}

/* User accounts: { NAME: { tokenHash, created, bests } }. Tolerant of a
   partial or malformed users block left over from older gists. */
function normUsers(v) {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const name of Object.keys(v)) {
      const u = v[name];
      if (!u || typeof u.tokenHash !== 'string' || u.tokenHash.length !== 64) continue;
      const bests = {};
      for (const g of GAMES) {
        const b = Number(u.bests && u.bests[g]);
        if (Number.isInteger(b) && b >= 1 && b <= 99999) bests[g] = b;
      }
      out[name] = {
        tokenHash: u.tokenHash,
        created: Number.isFinite(Number(u.created)) ? Number(u.created) : 0,
        bests,
      };
    }
  }
  return out;
}

async function readBoard() {
  const r = await fetch('https://api.github.com/gists/' + GIST_ID, { headers: ghHeaders() });
  if (!r.ok) throw new Error('gist read failed: ' + r.status);
  const gist = await r.json();
  const content = (gist.files && gist.files[FILENAME] && gist.files[FILENAME].content) || '{}';
  let data = {};
  try {
    data = JSON.parse(content);
  } catch (e) {
    data = {};
  }
  const board = {};
  for (const g of GAMES) board[g] = normGame(data[g]);
  board.users = normUsers(data.users);
  return board;
}

async function writeBoard(board) {
  const r = await fetch('https://api.github.com/gists/' + GIST_ID, {
    method: 'PATCH',
    headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
    body: JSON.stringify({ files: { [FILENAME]: { content: JSON.stringify(board) } } }),
  });
  if (!r.ok) throw new Error('gist write failed: ' + r.status);
}

/* Entry cleaner: legacy 3-letter initials pass through untouched and claimed
   usernames (up to 12 chars, letters/numbers/underscore) are preserved. */
function cleanEntries(list) {
  return (Array.isArray(list) ? list : [])
    .filter((e) => e && typeof e.name === 'string' && Number.isInteger(e.score))
    .map((e) => ({ name: e.name.toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 12), score: e.score }))
    .filter((e) => e.name && e.score >= 1 && e.score <= 99999)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ENTRIES);
}

/* Global leaderboard: sum of a user's best score per visible game, ranked.
   Breakout is hidden from the hub; its stored scores are kept but not counted. */
const GLOBAL_GAMES = ['pulse', 'tower', 'lander', 'dodge', 'lanes', 'meteor', 'pin', 'span'];
function globalBoard(users) {
  const rows = [];
  for (const name of Object.keys(users)) {
    const u = users[name];
    const bests = {};
    let total = 0;
    for (const g of GLOBAL_GAMES) {
      const b = Math.max(0, Number(u.bests && u.bests[g]) || 0);
      bests[g] = b;
      total += b;
    }
    if (total > 0) rows.push({ username: name, total, bests });
  }
  rows.sort((a, b) => b.total - a.total || a.username.localeCompare(b.username));
  return rows.slice(0, 25);
}

module.exports = async function handler(req, res) {
  try {
    if (!GIST_ID || !GITHUB_TOKEN) return json(res, 500, { error: 'unavailable' });

    if (req.method === 'GET') {
      const query = req.query || {};
      if (query.board === 'global') {
        const board = await readBoard();
        const payload = JSON.stringify({ board: globalBoard(board.users) });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 's-maxage=60, stale-while-revalidate=300',
        });
        res.end(payload);
        return;
      }
      const game = query.game;
      if (!GAMES.includes(game)) return json(res, 400, { error: 'invalid' });
      const board = await readBoard();
      const g = board[game];
      const payload = JSON.stringify({ scores: cleanEntries(g.scores), plays: g.plays, hist: normHist(g.hist), runs: g.runs, edges: HIST_EDGES[game] });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=15, stale-while-revalidate=60',
      });
      res.end(payload);
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const board = await readBoard();

      if (body.action === 'claim') {
        const username = String(body.username || '').toUpperCase();
        if (!USER_RE.test(username)) return json(res, 400, { error: 'invalid' });
        if (board.users[username]) return json(res, 409, { error: 'taken' });
        const token = crypto.randomBytes(32).toString('hex');
        board.users[username] = {
          tokenHash: sha256(token),
          created: Date.now(),
          bests: {},
        };
        await writeBoard(board);
        return json(res, 200, { ok: true, username, token });
      }

      const game = body.game;
      if (!GAMES.includes(game)) return json(res, 400, { error: 'invalid' });

      if (body.play === true) {
        board[game].plays += 1;
        await writeBoard(board);
        return json(res, 200, { ok: true, plays: board[game].plays });
      }

      if (body.stat === true) {
        const stScore = Number(body.score);
        if (!Number.isInteger(stScore) || stScore < 0 || stScore > 99999) {
          return json(res, 400, { error: 'invalid' });
        }
        const g = board[game];
        g.hist = normHist(g.hist);
        g.hist[histBin(stScore, game)] += 1;
        g.runs = (Number(g.runs) || 0) + 1;
        await writeBoard(board);
        return json(res, 200, { ok: true });
      }

      if (body.action === 'save') {
        const username = String(body.username || '').toUpperCase();
        const user = board.users[username];
        if (!user || sha256(String(body.token || '')) !== user.tokenHash) {
          return json(res, 403, { error: 'bad-token' });
        }
        const score = Number(body.score);
        if (!Number.isInteger(score) || score < 1 || score > 99999) {
          return json(res, 400, { error: 'invalid' });
        }
        const best = Math.max(Math.floor(Number(user.bests[game]) || 0), score);
        user.bests[game] = best;
        const entries = cleanEntries(board[game].scores).filter((e) => e.name !== username);
        entries.push({ name: username, score: best });
        entries.sort((a, b) => b.score - a.score);
        board[game].scores = entries.slice(0, MAX_ENTRIES);
        await writeBoard(board);
        return json(res, 200, { ok: true, best });
      }

      return json(res, 400, { error: 'invalid' });
    }

    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { error: 'method' });
  } catch (err) {
    return json(res, 500, { error: 'unavailable' });
  }
};

// Test hook (no-op on Vercel).
module.exports._test = {
  GAMES,
  USER_RE,
  FILENAME,
  HIST_EDGES,
  histBin,
  normHist,
  normGame,
  normUsers,
  cleanEntries,
  globalBoard,
  sha256,
  handler: module.exports,
};