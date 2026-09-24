'use strict';
/* Mock-fetch test suite for api/scores.js. No network, no dependencies.
   Run with: node test/scores.test.js */

const assert = require('assert');

process.env.GIST_ID = 'test-gist';
process.env.GITHUB_TOKEN = 'test-token';

const api = require('../api/scores.js');

const FILENAME = api._test.FILENAME;
let gistContent = {};
const tokens = {};

function mockFetch(url, opts) {
  opts = opts || {};
  const method = (opts.method || 'GET').toUpperCase();
  if (method === 'GET') {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ files: { [FILENAME]: { content: JSON.stringify(gistContent) } } }),
    });
  }
  if (method === 'PATCH') {
    const body = JSON.parse(opts.body);
    const content = body.files[FILENAME].content;
    gistContent = JSON.parse(content);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  }
  return Promise.resolve({ ok: false, status: 405, json: () => Promise.resolve({}) });
}

global.fetch = mockFetch;

function reset() {
  gistContent = {};
}

function call(method, query, body) {
  const res = {
    statusCode: null,
    headers: {},
    text: '',
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); return this; },
    end(s) { this.text = s || ''; return this; },
  };
  return api({ method, query: query || {}, body }, res).then(() => ({ code: res.statusCode, body: res.text ? JSON.parse(res.text) : {} }));
}

const G = (q) => call('GET', q, null);
const P = (b) => call('POST', {}, b);

async function claim(name) {
  const r = await P({ action: 'claim', username: name });
  assert.strictEqual(r.code, 200, 'claim ' + name + ' ok');
  tokens[name] = r.body.token;
  return r;
}

async function save(user, game, score, tokenOverride) {
  return P({ action: 'save', username: user, token: tokenOverride != null ? tokenOverride : tokens[user], game, score });
}

async function main() {
  reset();

  /* 1. claim ok */
  {
    let r = await P({ action: 'claim', username: 'NOVA' });
    assert.strictEqual(r.code, 200, 'claim ok status');
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.username, 'NOVA');
    assert.strictEqual(typeof r.body.token, 'string');
    assert.strictEqual(r.body.token.length, 64, '32-byte hex token');
    tokens.NOVA = r.body.token;
    const u = gistContent.users.NOVA;
    assert.ok(u, 'user stored');
    assert.ok(/^[0-9a-f]{64}$/.test(u.tokenHash), 'tokenHash is sha256 hex');
    assert.strictEqual(u.tokenHash, api._test.sha256(r.body.token), 'tokenHash matches sha256(token)');
    assert.strictEqual(typeof u.created, 'number');
    assert.deepStrictEqual(u.bests, {});
  }

  /* 2. claim taken (409), case-insensitive */
  {
    let r = await P({ action: 'claim', username: 'nova' });
    assert.strictEqual(r.code, 409, 'claim taken status');
    assert.strictEqual(r.body.error, 'taken');
  }

  /* 3. claim invalid name (400) */
  {
    for (const bad of ['AB', 'ABCDEFGHIJKLM', 'no-dash', 'with space', '', 'a1@']) {
      let r = await P({ action: 'claim', username: bad });
      assert.strictEqual(r.code, 400, 'invalid name "' + bad + '"');
      assert.strictEqual(r.body.error, 'invalid');
    }
  }

  /* 4. save ok: updates bests and per-game board */
  {
    await claim('ALPHA');

    let r = await save('ALPHA', 'pulse', 67);
    assert.strictEqual(r.code, 200, 'save ok status');
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.best, 67);
    assert.strictEqual(gistContent.users.ALPHA.bests.pulse, 67);
    assert.ok(gistContent.pulse.scores.some((e) => e.name === 'ALPHA' && e.score === 67), 'ALPHA on pulse board');

    // lower score does not regress the best
    await save('ALPHA', 'pulse', 12);
    assert.strictEqual(gistContent.users.ALPHA.bests.pulse, 67, 'best not regressed');

    // second game
    let r2 = await save('ALPHA', 'tower', 120);
    assert.strictEqual(r2.body.best, 120);
    assert.strictEqual(gistContent.users.ALPHA.bests.tower, 120);
    let t = await G({ game: 'tower' });
    assert.ok(t.body.scores.some((e) => e.name === 'ALPHA' && e.score === 120), 'ALPHA on tower board');
  }

  /* 5. save with wrong token (403) */
  {
    let r = await save('ALPHA', 'pulse', 50, 'not-the-token');
    assert.strictEqual(r.code, 403, 'wrong token status');
    assert.strictEqual(r.body.error, 'bad-token');
    // unknown user also 403
    let r2 = await save('GHOST', 'pulse', 50, 'x'.repeat(64));
    assert.strictEqual(r2.code, 403);
    assert.strictEqual(r2.body.error, 'bad-token');
  }

  /* 6. save with score 0 (400) */
  {
    let r = await save('ALPHA', 'pulse', 0);
    assert.strictEqual(r.code, 400, 'score 0 status');
    assert.strictEqual(r.body.error, 'invalid');
  }

  /* 7. global board ordering by total */
  {
    await claim('ZERO');
    await save('ZERO', 'pulse', 200);
    await claim('MARK');
    await save('MARK', 'dodge', 90);
    await claim('GHOST'); // claim-only, total 0, must be excluded

    let r = await G({ board: 'global' });
    assert.strictEqual(r.code, 200);
    const board = r.body.board;

    // ALPHA: pulse 67 + tower 120 = 187, ZERO: 200, MARK: 90
    assert.deepStrictEqual(board.map((b) => b.username), ['ZERO', 'ALPHA', 'MARK'], 'ranked by total desc');
    assert.deepStrictEqual(board.map((b) => b.total), [200, 187, 90], 'totals correct');
    assert.ok(!board.some((b) => b.username === 'GHOST'), 'zero-total users excluded');

    // bests carries all five game keys, 0 when unplayed
    for (const row of board) {
      for (const g of ['pulse', 'tower', 'breakout', 'lander', 'dodge']) {
        assert.ok(Object.prototype.hasOwnProperty.call(row.bests, g), g + ' key present');
      }
    }
    const alpha = board.find((b) => b.username === 'ALPHA');
    assert.deepStrictEqual(alpha.bests, { pulse: 67, tower: 120, breakout: 0, lander: 0, dodge: 0 });
  }

  /* 8. legacy initials entries still returned by per-game GET */
  {
    reset();
    gistContent = {
      pulse: {
        scores: [{ name: 'BEN', score: 55 }, { name: 'kay', score: 10 }, { name: 'AAA', score: 500 }],
        plays: 3,
        hist: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        runs: 3,
      },
    };
    let r = await G({ game: 'pulse' });
    assert.strictEqual(r.code, 200);
    const names = r.body.scores.map((s) => s.name);
    assert.ok(names.includes('BEN'), 'legacy BEN returned');
    assert.ok(names.includes('KAY'), 'legacy kay uppercased');
    assert.ok(names.includes('AAA'), 'legacy AAA returned');
    assert.strictEqual(r.body.scores[0].name, 'AAA', 'sorted by score desc');
    assert.strictEqual(r.body.plays, 3);
    assert.strictEqual(r.body.runs, 3);
    assert.ok(Array.isArray(r.body.hist) && r.body.hist.length === 15);
    // twelve-char usernames survive the cleaner
    const cleaned = api._test.cleanEntries([{ name: 'nova_delta_x', score: 42 }]);
    assert.strictEqual(cleaned[0].name, 'NOVA_DELTA_X');
  }

  /* play and stat pings still work */
  {
    let r = await P({ game: 'pulse', play: true });
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.plays, 4, 'plays incremented');
    r = await P({ game: 'pulse', stat: true, score: 33 });
    assert.strictEqual(r.code, 200);
    assert.strictEqual(gistContent.pulse.runs, 4, 'runs incremented');
  }

  console.log('All tests passed');
}

main().catch((e) => {
  console.error('FAIL: ' + e.message);
  process.exit(1);
});