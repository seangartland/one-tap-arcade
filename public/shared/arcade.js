/* ============================================================
   Arcade shared library: theme colors, audio, toast, leaderboard,
   save flow, overlay wiring, run-flow helpers, and hub best-scores.

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
  var initialsEl = document.getElementById('initials');
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
      .then(function (d) { return (d && d.scores) || []; })
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
      html = '<li class="empty"><span>No scores yet — be the first.</span></li>';
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

  if (saveBtn) saveBtn.addEventListener('click', function () {
    var name = (initialsEl.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
    if (!name) {
      initialsEl.classList.remove('shake'); void initialsEl.offsetWidth; initialsEl.classList.add('shake');
      showToast('Enter initials', colors.coral);
      return;
    }
    try { localStorage.setItem('arcade-initials', name); } catch (e) {}
    saveBtn.disabled = true;
    var label = saveBtn.textContent;
    saveBtn.textContent = 'Saving…';
    var finalScore = pendingScore;
    fetch('/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game: game, name: name, score: finalScore })
    }).then(function (r) { if (!r.ok) throw new Error('bad'); return r.json(); })
      .then(function () {
        overlay.classList.remove('entry-on');
        var key = name + '|' + finalScore;
        return boardCache.then(function (scores) {
          var list = (scores || []).slice();
          list.push({ name: name, score: finalScore });
          list.sort(function (a, b) { return b.score - a.score; });
          list = list.slice(0, 10);
          boardCache = Promise.resolve(list);
          renderBoard(list, key);
        });
      })
      .catch(function () { showToast("Couldn't save — offline?", colors.coral); })
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
  function gameOver(o) {
    o = o || {};
    pendingScore = o.score || 0;
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
    if (pendingScore > 0 && initialsEl) {
      try { initialsEl.value = localStorage.getItem('arcade-initials') || ''; } catch (e) {}
      if (overlay) overlay.classList.add('entry-on');
    }
    fetchBoard();
    if (startBtn) setTimeout(function () { startBtn.focus({ preventScroll: true }); }, 320);
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
    var plays = {};
    var done = 0;
    function fmt(n) { return n.toLocaleString('en-US') + (n === 1 ? ' play' : ' plays'); }
    function pct(sorted, p) {
      var i = (sorted.length - 1) * p;
      var lo = Math.floor(i), hi = Math.ceil(i);
      return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo));
    }
    function summarize(scores) {
      var vals = (scores || []).map(function (s) { return s.score; })
        .filter(function (v) { return typeof v === 'number' && isFinite(v); })
        .sort(function (a, b) { return a - b; });
      if (!vals.length) return null;
      return { q1: pct(vals, .25), med: pct(vals, .5), q3: pct(vals, .75), top: vals[vals.length - 1] };
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
          var sum = summarize(d && d.scores);
          var n = d && typeof d.plays === 'number' ? d.plays : null;
          renderSpread(gameKey, sum, n);
          try { localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), sum: sum, plays: n })); } catch (e) {}
        })
        .catch(function () { renderSpread(gameKey, null, null); });
    }
    for (var i = 0; i < games.length; i++) loadGame(games[i]);
  }
})();
