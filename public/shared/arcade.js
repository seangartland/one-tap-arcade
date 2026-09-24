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

  /* ---------- score-distribution helpers ---------- */
  /* Buckets are right-open: bucket 0 is exactly {0}, bucket i covers
     (HIST_EDGES[i-1], HIST_EDGES[i]]. The last (Infinity) bucket has no
     upper bound, so it is capped at 1000 for scaling and sampling. */
  var HIST_EDGES = [0, 1, 2, 4, 9, 19, 29, 49, 74, 99, 149, 249, 499, 999, Infinity];
  function histTotal(hist) {
    var t = 0;
    for (var i = 0; i < hist.length; i++) t += hist[i];
    return t;
  }
  function histMax(hist) {
    for (var i = hist.length - 1; i >= 0; i--) {
      if (hist[i] > 0) return i === hist.length - 1 ? 1000 : HIST_EDGES[i];
    }
    return 0;
  }
  /* p-th percentile of a count histogram. Walk cumulative counts to the
     bucket holding rank p * (total - 1), then interpolate linearly inside
     that bucket. Values never exceed the last bucket's 1000 cap. Returns a
     rounded int, or null when the histogram is empty. */
  function histPctile(hist, p) {
    var total = histTotal(hist);
    if (!total) return null;
    var rank = p * (total - 1);
    var cum = 0;
    for (var i = 0; i < hist.length; i++) {
      if (cum + hist[i] > rank) {
        var lo = i === 0 ? 0 : HIST_EDGES[i - 1];
        var hi = i === hist.length - 1 ? 1000 : HIST_EDGES[i];
        var frac = hist[i] > 0 ? (rank - cum) / hist[i] : 0;
        return Math.round(lo + (hi - lo) * frac);
      }
      cum += hist[i];
    }
    var loLast = HIST_EDGES[HIST_EDGES.length - 2];
    return Math.round(loLast + (1000 - loLast) * Math.min(1, (rank - cum) / Math.max(1, hist[hist.length - 1])));
  }
  /* 0..1 position of a score on the histogram strip: the bar row is
     divided evenly across buckets, so a score starts at its bucket and
     interpolates between that bucket's edges. The last (Infinity) bucket
     is capped at 1000 for scaling, and xMax clamps the score so markers
     never run off the right edge. */
  function scorePos(score, xMax) {
    if (!isFinite(score)) score = 1000;
    if (score < 0) score = 0;
    if (xMax > 0 && score > xMax) score = xMax;
    var i = 0;
    while (i < HIST_EDGES.length && score > HIST_EDGES[i]) i++;
    if (i >= HIST_EDGES.length) i = HIST_EDGES.length - 1;
    var lo = i === 0 ? 0 : HIST_EDGES[i - 1];
    var hi = i === HIST_EDGES.length - 1 ? 1000 : HIST_EDGES[i];
    var f = hi > lo ? (score - lo) / (hi - lo) : 0;
    if (f > 1) f = 1;
    return (i + f) / HIST_EDGES.length;
  }
  /* Bar spans for a histogram: height % of the peak bucket, empty buckets
     get a small 10% stub so the row never vanishes. */
  function distBarsHTML(hist) {
    var peak = 0;
    for (var i = 0; i < hist.length; i++) if (hist[i] > peak) peak = hist[i];
    if (!peak) peak = 1;
    var html = '';
    for (var j = 0; j < hist.length; j++) {
      html += '<span class="dist-bar" style="height:' + Math.max(10, Math.round(hist[j] / peak * 100)) + '%"></span>';
    }
    return html;
  }

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
    var host = document.getElementById('runDist');
    if (!host) {
      host = document.createElement('div');
      host.id = 'runDist';
      host.className = 'run-dist';
      host.innerHTML = '<div class="run-dist-bars"></div><i class="run-dist-mark"></i>';
      el.parentNode.insertBefore(host, el);
    }
    host.hidden = true;
    el.hidden = true;
    fetchBoard().then(function () {
      if (my !== pctToken) return;
      if (boardStats && boardStats.hist && histTotal(boardStats.hist) > 0) {
        var bars = host.querySelector('.run-dist-bars');
        var mark = host.querySelector('.run-dist-mark');
        bars.innerHTML = distBarsHTML(boardStats.hist);
        mark.style.left = (scorePos(score, Math.max(histMax(boardStats.hist), score)) * 100) + '%';
        host.setAttribute('aria-label', 'Your score ' + score + ' in the distribution of ' + (boardStats.runs || histTotal(boardStats.hist)) + ' runs');
        host.hidden = false;
      }
      if (!boardStats || !boardStats.runs) return;
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
      function adoptBestRows(rows) {
        var u = getUser();
        var mine = null;
        if (u) {
          for (var i = 0; i < rows.length; i++) {
            if (rows[i] && rows[i].username === u.username && rows[i].bests) { mine = rows[i].bests; break; }
          }
        }
        myBests = mine;
        for (var g = 0; g < games.length; g++) paint(games[g]);
      }
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
        if (cached && Date.now() - cached.t < 300000 && Array.isArray(cached.rows)) {
          render(cached.rows);
          adoptBestRows(cached.rows);
        }
      } catch (e) {}
      fetch('/api/scores?board=global&_=' + Date.now())
        .then(function (r) { if (!r.ok) throw new Error('bad'); return r.json(); })
        .then(function (d) {
          var rows = (d && d.board) || [];
          render(rows);
          adoptBestRows(rows);
          try { localStorage.setItem('arcade-global', JSON.stringify({ t: Date.now(), rows: rows })); } catch (e) {}
        })
        .catch(function () { render([]); });
    }
    renderHubUser();
    loadGlobal();

    var plays = {};
    var stats = {};
    var myBests = null;
    var done = 0;
    function fmt(n) { return n.toLocaleString('en-US') + (n === 1 ? ' play' : ' plays'); }
    function renderDistVals(dist, hist, best) {
      var vals = dist.querySelector('.dist-vals');
      if (!vals) {
        vals = document.createElement('div');
        vals.className = 'dist-vals';
        dist.appendChild(vals);
      }
      vals.innerHTML = '';
      var v25 = histPctile(hist, .25);
      var v50 = histPctile(hist, .5);
      var v75 = histPctile(hist, .75);
      var vMax = histMax(hist);
      var xMax = Math.max(vMax, best && best > 0 ? best : 0);
      var placed = [];
      function add(v, isMax) {
        if (v == null) return;
        var x = scorePos(v, xMax) * 100;
        if (isMax) {
          if (x > 100) x = 100;
        } else {
          if (x < 6) x = 6;
          else if (x > 94) x = 94;
        }
        for (var k = 0; k < placed.length; k++) {
          if (Math.abs(x - placed[k]) < 8) return;
        }
        var span = document.createElement('span');
        span.className = 'dist-val';
        span.textContent = v.toLocaleString('en-US');
        span.style.left = x + '%';
        span.style.transform = isMax ? 'translateX(-100%)' : 'translateX(-50%)';
        vals.appendChild(span);
        placed.push(x);
      }
      if (vMax > 0) {
        add(vMax, true);
        if (v50 > 0) add(v50, false);
        if (v75 > 0) add(v75, false);
        if (v25 > 0) add(v25, false);
      }
      dist.setAttribute('aria-label', 'Score distribution: 25th ' + v25.toLocaleString('en-US') + ', median ' + v50.toLocaleString('en-US') + ', 75th ' + v75.toLocaleString('en-US') + ', max ' + vMax.toLocaleString('en-US'));
    }
    function paint(gameKey) {
      var el = document.getElementById('spread-' + gameKey);
      if (!el) return;
      var hist = stats[gameKey] ? stats[gameKey].hist : null;
      var histOk = hist && histTotal(hist) > 0;
      var n = plays[gameKey];
      var best = myBests ? myBests[gameKey] : null;
      var dist = el.querySelector('.dist');
      var bars = dist.querySelector('.dist-bars');
      var mark = dist.querySelector('.dist-best');
      var meta = el.querySelector('.spread-meta');
      if (!histOk) {
        if (typeof n === 'number') {
          dist.hidden = true;
          meta.innerHTML = 'No scores yet &middot; <b>' + fmt(n) + '</b>';
          el.hidden = false;
        }
        return;
      }
      bars.innerHTML = distBarsHTML(hist);
      renderDistVals(dist, hist, best);
      dist.hidden = false;
      if (best && best > 0) {
        mark.style.left = (scorePos(best, Math.max(histMax(hist), best)) * 100) + '%';
        mark.hidden = false;
      } else {
        mark.hidden = true;
      }
      var bits = [];
      if (best && best > 0) bits.push('best <b>' + best.toLocaleString('en-US') + '</b>');
      if (typeof n === 'number') bits.push('<b>' + n.toLocaleString('en-US') + '</b> plays');
      meta.innerHTML = bits.join(' &middot; ');
      el.hidden = false;
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
        if (cached && Date.now() - cached.t < 300000 && Array.isArray(cached.hist)) {
          stats[gameKey] = { hist: cached.hist };
          if (typeof cached.plays === 'number') plays[gameKey] = cached.plays;
          paint(gameKey);
          finishOne();
          return;
        }
      } catch (e) {}
      fetch('/api/scores?game=' + gameKey)
        .then(function (r) { if (!r.ok) throw new Error('bad'); return r.json(); })
        .then(function (d) {
          var hist = (d && Array.isArray(d.hist)) ? d.hist : null;
          var n = d && typeof d.plays === 'number' ? d.plays : null;
          if (hist) stats[gameKey] = { hist: hist };
          if (typeof n === 'number') plays[gameKey] = n;
          paint(gameKey);
          try { localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), hist: hist, plays: n })); } catch (e) {}
        })
        .catch(function () {})
        .then(function () { finishOne(); });
    }
    for (var i = 0; i < games.length; i++) loadGame(games[i]);
  }
})();