# Game ideation brief: one-tap arcade

We run a neon one-tap arcade at https://one-tap-arcade.vercel.app. Six live games: pulse, tower, lander, dodge, lanes, meteor. (Breakout exists but is hidden.)

## House style (match this)

- Minimal, self-explanatory, fun, addicting, beautiful. No tutorials needed; the game teaches itself in 3 seconds.
- One-tap / one-finger controls. Portrait, mobile-first. Touch plus arrow-key fallback.
- Short sessions: good runs last 30-90 seconds. Threatening around 20s, brutal around 60s.
- Scores stay LOW and comparable across games: 1-3 points per action, flattened combo math (diminishing returns, never exponential), resets keep combos honest. A great run is tens of points, low hundreds is exceptional.
- Difficulty ramps continuously with time: faster, denser, more concurrent threats.
- 5 phase color progression: the palette shifts (cyan/coral/amber trios, e.g. Daybreak, Dusk, Tide, Noir) as you survive longer. Visual reward for lasting.
- Synthesized Web Audio sound effects only (oscillators, no audio files). Must mix politely with background music.
- Shared chrome per game: game-over result screen (score, percentile vs histogram, Play Again, Leaderboard), global leaderboards with old-school arcade initials entry, per-game score-distribution histograms on the hub.
- Tech: each game is one self-contained public/<game>/index.html using public/shared/arcade.js + arcade.css for the shared chrome. No build step, no frameworks.

## Current mechanics (don't duplicate these)

- pulse: tap at the right moment on an orbiting dot (timing).
- tower: stack falling blocks, perfect drops score bonus (precision stacking).
- lander: land a craft gently (thrust control).
- dodge: drag a comet, dodge a storm (continuous dodging).
- lanes: 3-lane dodger, tap left/right half to switch lanes (reaction).
- meteor: tap falling meteors to blast them, combo scoring (tap-the-threat).

## Your task

Give me your TOP 10 new game ideas ranked by how addictive they'd be, all matching the house style above. For each:

1. Name (one word, arcade-y)
2. One-line hook
3. Core mechanic in 2-3 sentences (must be one-tap learnable)
4. Scoring sketch (keep it low, 1-3 pts/action, note the combo behavior)
5. How difficulty ramps with time
6. One sentence on why it's addictive (the compulsion loop)

Rules: no em dashes anywhere in your output. No ideas that need more than one finger, more than 90-second sessions, or tutorial text. Prefer mechanics we haven't done (no more pure dodgers or pure tappers unless the twist is genuinely fresh).

Write the full ranked list to `.ideas-tmp/game-ideas.md` in the repo, and also return the complete top 10 in your final response.
