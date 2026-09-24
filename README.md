# Sean's Arcade

Tiny one-tap web games with global leaderboards. Live at https://one-tap-arcade.vercel.app

- `public/` - hub page + one folder per game (self-contained HTML)
- `api/scores.js` - leaderboard API (Vercel serverless function)

Scores are stored in a private GitHub gist; the function reads `GIST_ID` / `GITHUB_TOKEN` from Vercel env vars (never committed).
