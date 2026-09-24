// Leaderboard backend: a single secret GitHub gist holding
// { pulse: { scores: [...], plays: n }, ... }. Old { game: [...] } boards auto-migrate on read.
// Env vars (set on the Vercel project): GIST_ID, GITHUB_TOKEN (encrypted, server-side only).

const GAMES = ['pulse', 'tower', 'breakout', 'lander', 'dodge'];
const FILENAME = 'arcade-leaderboard.json';
const MAX_ENTRIES = 10;

/* Score histogram: counts every completed run's final score (including 0s,
   which never reach the named leaderboard). Bucket i covers scores
   (HIST_EDGES[i-1], HIST_EDGES[i]], with bucket 0 = {0} exactly. */
const HIST_EDGES = [0, 1, 2, 4, 9, 19, 29, 49, 74, 99, 149, 249, 499, 999, Infinity];
function histBin(score) {
  for (let i = 0; i < HIST_EDGES.length; i++) if (score <= HIST_EDGES[i]) return i;
  return HIST_EDGES.length - 1;
}
function normHist(v) {
  const n = HIST_EDGES.length;
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

function cleanEntries(list) {
  return (Array.isArray(list) ? list : [])
    .filter((e) => e && typeof e.name === 'string' && Number.isInteger(e.score))
    .map((e) => ({ name: e.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3), score: e.score }))
    .filter((e) => e.name && e.score >= 1 && e.score <= 99999)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ENTRIES);
}

module.exports = async function handler(req, res) {
  try {
    if (!GIST_ID || !GITHUB_TOKEN) return json(res, 500, { error: 'unavailable' });

    if (req.method === 'GET') {
      const game = req.query.game;
      if (!GAMES.includes(game)) return json(res, 400, { error: 'invalid' });
      const board = await readBoard();
      const g = board[game];
      const payload = JSON.stringify({ scores: cleanEntries(g.scores), plays: g.plays, hist: normHist(g.hist), runs: g.runs });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=15, stale-while-revalidate=60',
      });
      res.end(payload);
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const game = body.game;
      if (!GAMES.includes(game)) return json(res, 400, { error: 'invalid' });
      const board = await readBoard();
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
        g.hist[histBin(stScore)] += 1;
        g.runs = (Number(g.runs) || 0) + 1;
        await writeBoard(board);
        return json(res, 200, { ok: true });
      }
      const name = String(body.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
      const score = Number(body.score);
      if (!name || !Number.isInteger(score) || score < 1 || score > 99999) {
        return json(res, 400, { error: 'invalid' });
      }
      const entries = cleanEntries(board[game].scores);
      entries.push({ name, score, at: Date.now() });
      entries.sort((a, b) => b.score - a.score || (a.at || 0) - (b.at || 0));
      board[game].scores = entries.slice(0, MAX_ENTRIES).map(({ name, score }) => ({ name, score }));
      await writeBoard(board);
      return json(res, 200, { ok: true, scores: board[game].scores, plays: board[game].plays });
    }

    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { error: 'method' });
  } catch (err) {
    return json(res, 500, { error: 'unavailable' });
  }
};

// Test hook (no-op on Vercel).
module.exports._test = { histBin, normHist, HIST_EDGES };
