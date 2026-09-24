# Arcade Style Guide

How a game earns a place on https://one-tap-arcade.vercel.app. Read this before
building a new game or promoting a prototype. Sean's bar, in his words: minimal,
self-explanatory, fun, addicting, beautiful. Never wonky, always visually stunning.

## 1. Visual system

- Dark-only Tron vector theme. Background `--paper: #05070f`. Text `--ink: #9df2ff`,
  secondary `--muted: #66879f`. All in `public/shared/arcade.css`.
- Type: `"DM Mono", ui-monospace, SFMono-Regular, Menlo, monospace` everywhere.
  No other font stacks.
- Accents come from three CSS variables: `--cyan`, `--coral`, `--lime`. Game code
  must read them through `Arcade.colors` (refreshed via `Arcade.refreshColors()`),
  never hardcode neon hexes. A game's unique identity (rock browns, ship shapes)
  may use its own muted tones, but every glow, line, and effect follows the phase.
- Glow, not clutter: `shadowBlur` sparingly, thin strokes, translucent fills.
  Keep per-frame canvas work cheap for iOS Safari.
- Grain overlay (`.grain`) and vignette are provided by the shell. Do not add
  blend modes, SVG drop-shadow filters, or body gradients; they jank scrolling
  on iOS. Backgrounds belong on fixed pseudo-elements that composite, not repaint.

## 2. The five phases (mandatory, identical across games)

Every game progresses Daybreak, Dusk, Ember, Tide, Noir. Copy the PHASES array
from an existing game verbatim; do not invent palettes.

| # | Name     | dark cyan | dark coral | dark lime |
|---|----------|-----------|------------|-----------|
| 1 | Daybreak | #4bc7cf   | #ff765f    | #cde85a   |
| 2 | Dusk     | #9a8ff5   | #f2b25c    | #57d6a0   |
| 3 | Ember    | #fb923c   | #f87171    | #fbbf24   |
| 4 | Tide     | #22d3ee   | #60a5fa    | #34d399   |
| 5 | Noir     | #a1a1aa   | #f472b6    | #d4d4d8   |

Rules: `applyPhase(n)` sets `--cyan/--coral/--lime` on `documentElement` and calls
`Arcade.refreshColors()`. Survival games (dodge, lanes, meteor) advance one phase
per 15 seconds of elapsed time, capped at 5, toasting the phase name on change.
Round-based games (lander) advance every 2 rounds. Every run silently resets to
phase 1 on start. The site is dark-only; use the dark trios and the dark-only
scheme stub from lanes.

## 3. Game page anatomy

Copy `public/lanes/index.html` as the template. Required structure:

- `<body class="game">`, `<main class="game" id="game">`
- `<canvas id="canvas">` (the id is a contract, `arcade.js` depends on it)
- `.hud.hud-center` with `span.score#score`; game-specific extras (lives pips,
  combo) sit near it, never as separate floating panels
- `.toast#toast`, `.hint` (one-line control reminder)
- `section.overlay#overlay > .card`: `.mark` (inline SVG game icon), `.result-label`,
  `h1#title` ("Name." with the period), `p.instruction#instruction`,
  `p.session-best#sessionBest`, `p.run-pct#runPct`, `#entry` (username claim form),
  `#board` (global leaders), `button.primary#start`, `#viewLeaders`
- `button.sound#sound`, `a.home[href="../"]`, `.grain`

Set `window.ARCADE` before loading `/shared/arcade.js`:

```js
window.ARCADE = {
  game: 'meteor',                 // leaderboard key, lowercase one word
  tagline: 'Tap the falling rocks.',
  startLabel: 'Start blasting',
  restartLabel: 'Run it back',
  resultLabel: 'Run complete',
  boardHeading: 'Meteor · Global leaders'
};
```

Then: `Arcade.startFlow()` on start, `Arcade.gameOver({score, title, instruction,
restartLabel})` on game over, `ARCADE.onStart = startGame`. Use `Arcade.tone`
for all sound, `Arcade.showToast` for transient messages.

## 4. Canvas setup (read this twice)

```js
dpr = Math.min(window.devicePixelRatio || 1, 2);
W = window.innerWidth; H = window.innerHeight;
canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
```

`arcade.css` already sizes `#canvas` to the viewport
(`position:absolute; inset:0; width:100%; height:100%`). Do not set canvas style
dimensions in JS. Never use `position:fixed; inset:0` without explicit
width/height on a canvas: the width/height attributes become its intrinsic size
and it renders oversized (this once shipped a whole game at 2x, with taps
missing by 2x). Game logic works in CSS pixels; input handlers map client
coords through `getBoundingClientRect()`.

## 5. Scoring

Score increases from in-game actions only: points per dodge, per block stacked,
per rock blasted, per landing. No flat per-second ticks, no arbitrary bonuses.
Combos and multipliers are fine when they reward skill (consecutive hits without
missing). Show the score big and centered; update it the moment it changes.

## 6. Game-over and leaderboard flow

`Arcade.gameOver()` handles everything: best line, username claim, score save
with one retry, the global board, the "better than X% of runs" percentile, and
the score-distribution strip. The game just passes the final score, a title
(usually the score), and a short instruction line that varies with performance.
Report every run's score for stats (the library does this), including zeros.
Never invent a custom save flow.

## 7. Hub card

One card per game in `public/index.html`, inside `.cards`:

```html
<div class="game-card game-split" data-game="meteor">
  <div class="game-info"><h2>Meteor</h2>
  <p class="tag">Tap the falling rocks.</p>
  <div class="spread" id="spread-meteor">
    <div class="dist" role="img" aria-label="Score distribution">
      <div class="dist-bars"></div>
      <i class="dist-best" hidden></i>
    </div>
    <p class="spread-meta"></p>
  </div>
  </div>
  <div class="game-side">
    <div class="game-shot"><svg viewBox="0 0 120 68" aria-hidden="true">…</svg></div>
    <a class="go" href="meteor/">Play</a>
  </div>
</div>
```

Tagline rules: one short imperative sentence, no "game" or "one-tap" filler,
few words per row (cards are narrow). Examples: "Stack the falling blocks.",
"Land softly on the pad.", "Dodge the falling blocks." The `.game-shot` SVG is
a minimal `currentColor` glyph of the game's essence on the 120x68 viewBox.
Cards auto-sort by plays; new games go last in the markup. The headline stays
number-agnostic.

## 8. API checklist (`api/scores.js`)

- Add the key to `GAMES` (breakout stays listed; it is hidden, not removed).
- Add 15 histogram edges to `HIST_EDGES`, shaped like the others: bucket 0 is
  exactly {0}, then edges spreading typical scores across the buckets. Calibrate
  to the game's scoring scale (a meteor run scores ~10x a dodge run).
- Add the key to `GLOBAL_GAMES` so it counts toward the global leaderboard.
- `node --check api/scores.js` after editing.

## 9. Sound

All sound through `Arcade.tone(freq, duration, type, volume, delay)`. Subtle:
hits, misses, deaths, phase chimes. Respect the shared mute button; add an
`onMute` hook only if the game runs its own audio loops. Audio on iPhone is a
known weak spot; keep the design working perfectly silent.

## 10. Motion and input

- Touch first: `touchstart` with `passive:false` + `preventDefault()`; mouse via
  `pointerdown` ignoring touch pointerType (no double-firing). Tap targets are
  judged against game state (e.g. the ship's lane), never raw screen halves.
- Honor `prefers-reduced-motion`: cap particles, kill screen shake.
- Every game must be fully playable with one finger and start fast.

## 11. Prototype workflow

New ideas start as single-file sketches in `public/proto/<name>/`, plus a card
in `public/proto/index.html` (never linked from the hub). Sean playtests; the
winner gets the full treatment above and the prototype is deleted. Losers are
deleted outright. Never promote to the hub without his pick.

## 12. Before you ship

- [ ] Headless mobile Chromium: start screen, gameplay, game over, retry, all
      with touch input and zero page errors
- [ ] Screenshots reviewed at phone size: no overlapping numbers, no clipped
      HUD, no empty histogram bars beyond the distribution
- [ ] All five phases render (spot-check at least two beyond Daybreak)
- [ ] API: `GET /api/scores?game=<key>` returns edges; a save round-trips
- [ ] Hub card renders with tagline, spread, and Play link; global board sums it
- [ ] No em dashes in copy, code, or comments
