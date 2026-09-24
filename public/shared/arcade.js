/* ============================================================
   Arcade shared library: theme colors, audio, toast, leaderboard,
   username accounts, save flow, overlay wiring, run-flow helpers,
   and hub best-scores.

   Each game page sets a tiny window.ARCADE config BEFORE loading
   this file:

     window.ARCADE = {
       game: 'pulse',                                   // leaderboard key
       tagline: 'Tap when the moving spark reaches...', // start-screen instruction
       startLabel: 'Start orbit',                       // start button label
       restartLabel: 'Run it back',                     // game-over button label
       resultLabel: 'Run complete',                     // game-over eyebrow
       boardHeading: 'Pulse · Global leaders',          // #board h2 text
       onStart: function () {},    // game's startGame (wired to #start)
       onMute: function (m) {},    // extra mute handling, e.g. stop loops
       onVisibility: function () {}, // extra hidden-tab handling
       onSchemeChange: function () {} // replaces the default color refresh
     };

   Game scripts then use window.Arcade (colors, tone, showToast,
   startFlow, gameOver, ...). This library never hardcodes a game name.
   ============================================================ */
(function () {
  'use strict';

  /* ---------- username accounts ---------- */
  /* The browser keeps {username, token} under "arcade-user". The server
     stores only the SHA-256 hash of the token, never the token itself. */
  var USER_KEY = 'arcade-user';
  function getUser() {
    try {
      var raw = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
      if (raw && typeof raw.username === 'string' && raw.username && typeof raw.token === 'string' && raw.token) return raw;
    } catch (e) {}
    return null;
  }
  function setUser(u) {
    try { localStorage.setItem(USER_KEY, JSON.stringify(u)); } catch (e) {}
    return u;
  }
  function clearUser() {
    try { localStorage.removeItem(USER_KEY); } catch (e) {}
  }
  function postApi(body) {
    return fetch('/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; });
    });
  }
  function claimUser(username) {
    return postApi({ action: 'claim', username: username }).then(function (d) {
      if (d && d.ok && d.token) setUser({ username: d.username, token: d.token });
      return d;
    });
  }
  function saveUserScore(game, score) {
    var u = getUser();
    if (!u) return Promise.reject(new Error('no-user'));
    return postApi({ action: 'save', username: u.username, token: u.token, game: game, score: score });
  }

  /* The hub runs its own mode: load per-card best scores. */
  if (document.body && document.body.classList.contains('hub')) {
    initHub();
    return;
  }

  var cfg = window.ARCADE || {};
  var game = cfg.game || '';

  /* ---------- standard overlay DOM ---------- */
  var canvas = document.getElementById('canvas');
  var gameEl = document.getElementById('game');
  var overlay = document.getElementById('overlay');
  var startBtn = document.getElementById('start');
  var toastEl = document.getElementById('toast');
  var soundBtn = document.getElementById('sound');
  var titleEl = document.getElementById('title');
  var instructionEl = document.getElementById('instruction');
  var sessionBestEl = document.getElementById('sessionBest');
  var boardTitleEl = document.querySelector('#board h2');
  var resultLabelEl = document.querySelector('.result-label');
  var boardList = document.getElementById('boardList');
  var entryEl = document.getElementById('entry');
  var usernameEl = document.getElementById('username');
  var claimBtn = document.getElementById('claimBtn');
  var claimWrap = document.getElementById('claimWrap');
  var saveWrap = document.getElementById('saveWrap');
  var saveAsEl = document.getElementById('saveAs');
  var saveBtn = document.getElementById('saveScore');
  var viewLeadersBtn = document.getElementById('viewLeaders');
  var boardBackBtn = document.getElementById('boardBack');
  var skipBtn = document.getElementById('skipSave');

  /* Static copy driven by the page config. */
  if (boardTitleEl && cfg.boardHeading) boardTitleEl.textContent = cfg.boardHeading;
  if (resultLabelEl && cfg.resultLabel) resultLabelEl.textContent = cfg.resultLabel;
  if (instructionEl && cfg.tagline) instructionEl.textContent = cfg.tagline;
  if (startBtn && cfg.startLabel) startBtn.textContent = cfg.startLabel;

  /* ---------- theme colors ---------- */
  var colors = {};
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function refreshColors() {
    colors.paper = cssVar('--paper');
    colors.ink = cssVar('--ink');
    colors.muted = cssVar('--muted');
    colors.line = cssVar('--line');
    colors.cyan = cssVar('--cyan');
    colors.coral = cssVar('--coral');
    colors.lime = cssVar('--lime');
  }
  refreshColors();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
    if (typeof cfg.onSchemeChange === 'function') cfg.onSchemeChange();
    else refreshColors();
  });

  /* ---------- audio ---------- */
  var muted = false;
  var audio = null;
  var audioOut = null;
  function initAudio(onReady) {
    var AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!audio) {
      audio = new AudioContext();
      audioOut = audio.createGain();
      audioOut.gain.value = .9;
      audioOut.connect(audio.destination);
    }
    if (audio.state === 'suspended') {
      audio.resume().then(function () { if (onReady) onReady(); }).catch(function () {});
    } else if (onReady) {
      onReady();
    }
  }
  function tone(freq, duration, type, volume, delay) {
    if (muted) return;
    initAudio(function () {
      var when = audio.currentTime + (delay || 0);
      var o = audio.createOscillator();
      var g = audio.createGain();
      o.type = type || 'sine'; o.frequency.setValueAtTime(freq, when);
      g.gain.setValueAtTime(.0001, when);
      g.gain.exponentialRampToValueAtTime(volume || .09, when + .012);
      g.gain.exponentialRampToValueAtTime(.0001, when + duration);
      o.connect(g); g.connect(audioOut);
      o.start(when); o.stop(when + duration + .03);
    });
  }

  /* ---------- toast ---------- */
  function showToast(text, color) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.style.color = color || colors.ink;
    toastEl.classList.remove('pop'); void toastEl.offsetWidth; toastEl.classList.add('pop');
  }

  /* ---------- leaderboard ---------- */
  var HIST_EDGES = [0, 1, 2, 4, 9, 19, 29, 49, 74, 99, 149, 249, 499, 999, Infinity];
  var boardCache = null;
  var boardStats = null;
  var pendingScore = 0;
  var bestByGame = {};
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fetchBoard() {
    boardCache = fetch('/api/scores?game=' + game + '&_=' + Date.now())
      .then(function (r) { if (!r.ok) throw new Error('bad'); return r.json(); })
      .then(function (d) {
        boardStats = (d && d.hist) ? { hist: d.hist, runs: d.runs || 0 } : null;
        return (d && d.scores) || [];
      })
      .catch(function () { return null; });
    return boardCache;
  }
  function renderBoard(scores, highlightKey, force) {
    if (!overlay || !boardList) return;
    if ((!scores || !scores.length) && !force) { overlay.classList.remove('board-on'); return; }
    var html = '';
    if (scores && scores.length) {
      var done = false;
      scores.slice(0, 10).forEach(function (s, i) {
        var key = s.name + '|' + s.score;
        var me = highlightKey && !done && key === highlightKey;
        if (me) done = true;
        html += '<li' + (me ? ' class="me"' : '') + '><span>' + (i + 1) + '. ' + esc(s.name) + '</span><span>' + esc(s.score) + '</span></li>';
      });
    } else {
      html = '<li class="empty"><span>No scores yet. Be the first.</span></li>';
    }
    boardList.innerHTML = html;
    overlay.classList.add('board-on');
  }
  function showLeaders() {
    if (!overlay) return;
    overlay.classList.add('leaders-on');
    fetchBoard().then(function (scores) { renderBoard(scores, null, true); });
    if (boardBackBtn) setTimeout(function () { boardBackBtn.focus({ preventScroll: true }); }, 120);
  }
  function hideLeaders() {
    if (!overlay) return;
    overlay.classList.remove('leaders-on');
    if (viewLeadersBtn) setTimeout(function () { viewLeadersBtn.focus({ preventScroll: true }); }, 120);
  }

  function showClaimForm(show) {
    if (claimWrap) claimWrap.hidden = !show;
    if (saveWrap) saveWrap.hidden = show;
  }
  if (claimBtn) claimBtn.addEventListener('click', function () {
    var name = (usernameEl.value || '').trim().toUpperCase();
    if (!name) {
      usernameEl.classList.remove('shake'); void usernameEl.offsetWidth; usernameEl.classList.add('shake');
      showToast('Enter a username', colors.coral);
      return;
    }
    claimBtn.disabled = true;
    var label = claimBtn.textContent;
    claimBtn.textContent = 'Claiming…';
    claimUser(name)
      .then(function (d) {
        if (d && d.ok) {
          if (saveAsEl) saveAsEl.textContent = d.username;
          showClaimForm(false);
        } else if (d && d.error === 'taken') {
          showToast('Name taken', colors.coral);
        } else {
          showToast('Use 3 to 12 letters, numbers, or underscores', colors.coral);
        }
      })
      .catch(function () { showToast("Couldn't claim, offline?", colors.coral); })
      .then(function () { claimBtn.disabled = false; claimBtn.textContent = label; });
  });
  if (saveBtn) saveBtn.addEventListener('click', function () {
    var u = getUser();
    if (!u) { showClaimForm(true); return; }
    saveBtn.disabled = true;
    var label = saveBtn.textContent;
    saveBtn.textContent = 'Saving…';
    var finalScore = pendingScore;
    saveUserScore(game, finalScore)
      .then(function (d) {
        if (d && d.ok) {
          overlay.classList.remove('entry-on');
          var best = (d.best != null ? d.best : finalScore);
          var key = u.username + '|' + best;
          var cached = boardCache || fetchBoard();
          return cached.then(function (scores) {
            var list = (scores || []).filter(function (s) { return s.name !== u.username; });
            list.push({ name: u.username, score: best });
            list.sort(function (a, b) { return b.score - a.score; });
            list = list.slice(0, 10);
            boardCache = Promise.resolve(list);
            renderBoard(list, key);
          });
        }
        if (d && d.error === 'bad-token') {
          clearUser();
          showToast('Name not recognized', colors.coral);
          showClaimForm(true);
          return;
        }
        showToast("Couldn't save, offline?", colors.coral);
      })
      .catch(function () { showToast("Couldn't save, offline?", colors.coral); })
      .then(function () { saveBtn.disabled = false; saveBtn.textContent = label; });
  });
  if (viewLeadersBtn) viewLeadersBtn.addEventListener('click', showLeaders);
  if (boardBackBtn) boardBackBtn.addEventListener('click', hideLeaders);
  if (skipBtn) skipBtn.addEventListener('click', function () {
    overlay.classList.remove('entry-on');
    fetchBoard().then(function (scores) { renderBoard(scores, null); });
  });

  /* ---------- run-flow helpers ---------- */
  function startFlow() {
    statSent = false;
    initAudio();
    if (overlay) { overlay.classList.add('hidden'); overlay.classList.remove('over'); }
    /* Count the run: fire-and-forget, never blocks game start. */
    try {
      fetch('/api/scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game: game, play: true })
      }).catch(function () {});
    } catch (e) {}
  }
  var statSent = false;
  function gameOver(o) {
    o = o || {};
    pendingScore = o.score || 0;
    /* Report the final score for distribution stats (includes 0s): fire-and-forget, once per run. */
    if (!statSent) {
      statSent = true;
      try {
        fetch('/api/scores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game: game, stat: true, score: pendingScore })
        }).catch(function () {});
      } catch (e) {}
    }
    var best = Math.max(bestByGame[game] || 0, pendingScore);
    bestByGame[game] = best;
    if (titleEl) titleEl.textContent = (o.title != null ? o.title : '');
    if (instructionEl && o.instruction) instructionEl.textContent = o.instruction;
    if (sessionBestEl) sessionBestEl.textContent = 'Session best · ' + best;
    if (startBtn && o.restartLabel) startBtn.textContent = o.restartLabel;
    if (overlay) {
      overlay.classList.add('over'); overlay.classList.remove('hidden');
      overlay.classList.remove('entry-on', 'board-on', 'leaders-on');
    }
    if (boardList) boardList.innerHTML = '';
    if (pendingScore > 0 && entryEl) {
      var u = getUser();
      if (u) {
        if (saveAsEl) saveAsEl.textContent = u.username;
        showClaimForm(false);
      } else {
        showClaimForm(true);
      }
      if (overlay) overlay.classList.add('entry-on');
    }
    showRunPercentile(pendingScore);
    if (startBtn) setTimeout(function () { startBtn.focus({ preventScroll: true }); }, 320);
  }
  var pctToken = 0;
  /* % of all recorded runs this score beat (ties don't count). */
  function pctBeaten(hist, runs, score) {
    if (!runs) return null;
    var beaten = 0;
    for (var i = 0; i < hist.length; i++) {
      var lo = i === 0 ? 0 : HIST_EDGES[i - 1] + 1;
      var hi = i === hist.length - 1 ? 2000 : HIST_EDGES[i];
      if (hi < score) beaten += hist[i];
      else if (lo < score && hi > lo) beaten += hist[i] * ((score - lo) / (hi - lo));
    }
    return (beaten / runs) * 100;
  }
  function showRunPercentile(score) {
    var el = document.getElementById('runPct');
    if (!el) return;
    var my = ++pctToken;
    el.hidden = true;
    fetchBoard().then(function () {
      if (my !== pctToken || !boardStats || !boardStats.runs) return;
      var p = pctBeaten(boardStats.hist, boardStats.runs, score);
      if (p == null) return;
      var label;
      if (p >= 99.5) label = 'Top <b>1%</b> of runs';
      else if (p >= 90) label = 'Top <b>' + Math.round(100 - p) + '%</b> of runs';
      else label = 'Better than <b>' + Math.round(p) + '%</b> of runs';
      el.innerHTML = label;
      el.hidden = false;
    });
  }

  /* ---------- global wiring ---------- */
  if (startBtn) startBtn.addEventListener('click', function () {
    if (typeof cfg.onStart === 'function') cfg.onStart();
  });
  if (soundBtn) soundBtn.addEventListener('click', function (e) {
    e.stopPropagation(); muted = !muted;
    soundBtn.setAttribute('aria-pressed', String(!muted));
    soundBtn.setAttribute('aria-label', muted ? 'Turn sound on' : 'Mute sound');
    if (typeof cfg.onMute === 'function') cfg.onMute(muted);
    if (!muted) { initAudio(); tone(620, .1, 'sine', .04, 0); }
  });
  if (window.location.hash === '#leaders') showLeaders();
  document.addEventListener('visibilitychange', function () {
    if (typeof cfg.onVisibility === 'function') cfg.onVisibility();
  });
  document.addEventListener('pointerdown', function () { initAudio(); }, { once: true });

  /* ---------- public API for game scripts ---------- */
  window.Arcade = {
    game: game,
    colors: colors,
    canvas: canvas,
    gameEl: gameEl,
    cssVar: cssVar,
    refreshColors: refreshColors,
    initAudio: initAudio,
    tone: tone,
    isMuted: function () { return muted; },
    audioNodes: function () { return (audio && audioOut) ? { ctx: audio, out: audioOut } : null; },
    getUser: getUser,
    claimUser: claimUser,
    saveUserScore: saveUserScore,
    showToast: showToast,
    fetchBoard: fetchBoard,
    renderBoard: renderBoard,
    showLeaders: showLeaders,
    hideLeaders: hideLeaders,
    startFlow: startFlow,
    gameOver: gameOver
  };

  /* ---------- hub mode ---------- */
  function initHub() {
    var games = ['pulse', 'tower', 'breakout', 'lander', 'dodge'];
    var toastEl = document.getElementById('toast');
    function hubToast(text, color) {
      if (!toastEl) return;
      toastEl.textContent = text;
      toastEl.style.color = color || '#9df2ff';
      toastEl.classList.remove('pop'); void toastEl.offsetWidth; toastEl.classList.add('pop');
    }
    function renderHubUser() {
      var host = document.getElementById('hubUser');
      if (!host) return;
      var u = getUser();
      host.innerHTML = u
        ? '<p class="hub-user-line">Playing as <b>' + esc(u.username) + '</b></p>'
        : '<div class="hub-claim"><input id="hubUsername" maxlength="12" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="USERNAME" aria-label="Username" /><button id="hubClaimBtn" type="button">Claim username</button></div>';
      var input = document.getElementById('hubUsername');
      var btn = document.getElementById('hubClaimBtn');
      if (input && btn) {
        var onClaim = function () {
          var n = (input.value || '').trim().toUpperCase();
          if (!n) { hubToast('Enter a username', '#ffb300'); return; }
          btn.disabled = true;
          claimUser(n)
            .then(function (d) {
              if (d && d.ok) renderHubUser();
              else if (d && d.error === 'taken') hubToast('Name taken', '#ffb300');
              else hubToast('Use 3 to 12 letters, numbers, or underscores', '#ffb300');
            })
            .catch(function () { hubToast("Couldn't claim, offline?", '#ffb300'); })
            .then(function () { btn.disabled = false; });
        };
        btn.addEventListener('click', onClaim);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') onClaim(); });
      }
    }
    function loadGlobal() {
      var listEl = document.getElementById('globalList');
      if (!listEl) return;
      function render(rows) {
        if (!rows || !rows.length) {
          listEl.innerHTML = '<li class="empty"><span>No global plays yet. Be the first.</span></li>';
          return;
        }
        var html = '';
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          var bits = [];
          for (var g = 0; g < games.length; g++) {
            var key = games[g];
            bits.push(key + ' ' + (r.bests[key] != null ? r.bests[key] : 0));
          }
          html += '<li title="' + esc(bits.join(', ')) + '"><span class="grank">' + (i + 1) + '</span><span class="gname">' + esc(r.username) + '</span><span class="gtotal">' + r.total + '</span></li>';
        }
        listEl.innerHTML = html;
      }
      try {
        var cached = JSON.parse(localStorage.getItem('arcade-global') || 'null');
        if (cached && Date.now() - cached.t < 300000 && Array.isArray(cached.rows)) render(cached.rows);
      } catch (e) {}
      fetch('/api/scores?board=global&_=' + Date.now())
        .then(function (r) { if (!r.ok) throw new Error('bad'); return r.json(); })
        .then(function (d) {
          var rows = (d && d.board) || [];
          render(rows);
          try { localStorage.setItem('arcade-global', JSON.stringify({ t: Date.now(), rows: rows })); } catch (e) {}
        })
        .catch(function () { render([]); });
    }
    renderHubUser();
    loadGlobal();

    var plays = {};
    var done = 0;
    function fmt(n) { return n.toLocaleString('en-US') + (n === 1 ? ' play' : ' plays'); }
    function pct(sorted, p) {
      var i = (sorted.length - 1) * p;
      var lo = Math.floor(i), hi = Math.ceil(i);
      return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo));
    }
    function histTotal(hist) {
      var t = 0;
      for (var i = 0; i < hist.length; i++) t += hist[i];
      return t;
    }
    /* Interpolated percentile from histogram buckets. Bucket 0 = {0};
       bucket i covers (HIST_EDGES[i-1], HIST_EDGES[i]]. */
    function histPct(hist, p) {
      var total = histTotal(hist);
      if (!total) return null;
      var rank = p * (total - 1);
      var cum = 0;
      for (var i = 0; i < hist.length; i++) {
        var c = hist[i];
        if (rank < cum + c && c > 0) {
          var lo = i === 0 ? 0 : HIST_EDGES[i - 1] + 1;
          var hi = i === hist.length - 1 ? 2000 : HIST_EDGES[i];
          return Math.round(lo + ((rank - cum) / c) * (hi - lo));
        }
        cum += c;
      }
      return HIST_EDGES[0];
    }
    function histMax(hist) {
      for (var i = hist.length - 1; i >= 0; i--) {
        if (hist[i] > 0) return i === hist.length - 1 ? 1000 : HIST_EDGES[i];
      }
      return 0;
    }
    function summarize(scores, hist) {
      var vals = (scores || []).map(function (s) { return s.score; })
        .filter(function (v) { return typeof v === 'number' && isFinite(v); })
        .sort(function (a, b) { return a - b; });
      var top = vals.length ? vals[vals.length - 1] : null;
      if (hist && histTotal(hist) > 0) {
        return { q1: histPct(hist, .25), med: histPct(hist, .5), q3: histPct(hist, .75),
                 top: top != null ? top : histMax(hist) };
      }
      if (!vals.length) return null;
      return { q1: pct(vals, .25), med: pct(vals, .5), q3: pct(vals, .75), top: top };
    }
    function renderSpread(gameKey, sum, n) {
      var el = document.getElementById('spread-' + gameKey);
      if (!el) { finishOne(); return; }
      var bar = el.querySelector('.spread-bar');
      var meta = el.querySelector('.spread-meta');
      if (typeof n === 'number') plays[gameKey] = n;
      if (!sum) {
        if (typeof n === 'number') {
          bar.style.display = 'none';
          meta.innerHTML = 'No scores yet &middot; <b>' + fmt(n) + '</b>';
          el.hidden = false;
        }
        finishOne(); return;
      }
      if (sum.top > 0) {
        var band = el.querySelector('.spread-band');
        var mid = el.querySelector('.spread-mid');
        band.style.left = (sum.q1 / sum.top * 100) + '%';
        band.style.width = (Math.max(sum.q3 - sum.q1, sum.top * 0.02) / sum.top * 100) + '%';
        mid.style.left = (sum.med / sum.top * 100) + '%';
        bar.style.display = '';
        bar.setAttribute('aria-label', 'Typical scores ' + sum.q1 + ' to ' + sum.q3 + ', top ' + sum.top);
      } else {
        bar.style.display = 'none';
      }
      var bits = ['typical <b>' + sum.q1 + '&ndash;' + sum.q3 + '</b>',
                  'top <b>' + sum.top.toLocaleString('en-US') + '</b>'];
      if (typeof n === 'number') bits.push('<b>' + fmt(n) + '</b>');
      meta.innerHTML = bits.join(' &middot; ');
      el.hidden = false;
      finishOne();
    }
    function sortCards() {
      var wrap = document.querySelector('.cards');
      if (!wrap) return;
      var cards = Array.prototype.slice.call(wrap.querySelectorAll('.game-card'));
      cards.sort(function (a, b) {
        return (plays[b.getAttribute('data-game')] || 0) - (plays[a.getAttribute('data-game')] || 0);
      });
      for (var i = 0; i < cards.length; i++) wrap.appendChild(cards[i]);
    }
    function finishOne() {
      done++;
      if (done === games.length) sortCards();
    }
    function loadGame(gameKey) {
      var cacheKey = 'arcade-spread-' + gameKey;
      try {
        var cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
        if (cached && Date.now() - cached.t < 300000) { renderSpread(gameKey, cached.sum, cached.plays); return; }
      } catch (e) {}
      fetch('/api/scores?game=' + gameKey)
        .then(function (r) { if (!r.ok) throw new Error('bad'); return r.json(); })
        .then(function (d) {
          var sum = summarize(d && d.scores, d && d.hist);
          var n = d && typeof d.plays === 'number' ? d.plays : null;
          renderSpread(gameKey, sum, n);
          try { localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), sum: sum, plays: n })); } catch (e) {}
        })
        .catch(function () { renderSpread(gameKey, null, null); });
    }
    for (var i = 0; i < games.length; i++) loadGame(games[i]);
  }
})();