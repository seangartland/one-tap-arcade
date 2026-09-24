// Leaderboard backend: a single secret GitHub gist holding { pulse: [...], tower: [...] }.
// Env vars (set on the Vercel project): GIST_ID, GITHUB_TOKEN (encrypted, server-side only).

const GAMES = ['pulse', 'tower', 'wave', 'breakout', 'lander', 'dodge'];
const FILENAME = 'arcade-leaderboard.json';
const MAX_ENTRIES = 10;

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
  for (const g of GAMES) board[g] = Array.isArray(data[g]) ? data[g] : [];
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
      const payload = JSON.stringify({ scores: cleanEntries(board[game]) });
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
      const name = String(body.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
      const score = Number(body.score);
      if (!name || !Number.isInteger(score) || score < 1 || score > 99999) {
        return json(res, 400, { error: 'invalid' });
      }
      const board = await readBoard();
      const entries = cleanEntries(board[game]);
      entries.push({ name, score, at: Date.now() });
      entries.sort((a, b) => b.score - a.score || (a.at || 0) - (b.at || 0));
      board[game] = entries.slice(0, MAX_ENTRIES).map(({ name, score }) => ({ name, score }));
      await writeBoard(board);
      return json(res, 200, { ok: true, scores: board[game] });
    }

    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { error: 'method' });
  } catch (err) {
    return json(res, 500, { error: 'unavailable' });
  }
};
