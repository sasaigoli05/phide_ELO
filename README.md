# PhiDE Rush — ELO Review

A lightweight web app for reviewing PhiDE applications with **head-to-head Elo
comparisons** in a **2-phase Swiss** format. Humans are bad at absolute scores
("is this a 7 or an 8?") but great at relative calls ("A is clearly stronger than
B") — this turns the whole committee's relative judgments into a stable ranking.

- **Static frontend** on GitHub Pages (plain HTML/CSS/JS, no build step).
- **Shared data** in Firebase Firestore (free) so ~12 reviewers on their own
  laptops stay in sync in real time.
- **No servers, no bills, ~0 maintenance.**

## Quick start

1. **Set up Firebase + GitHub Pages** — follow **[docs/HANDOFF.md](docs/HANDOFF.md)**
   (two 5-minute Firebase toggles + one GitHub Pages setting). Required once.
2. Open the site, log in with the **team password** (default `phide`) or the
   **admin password** (default `admin`) — change both from the ⚙ gear on first login.
3. Admin uploads the filled-in template (`data/sample-template.xlsx` shows the
   expected format) → **Push to committee**.
4. Committee members click their name and work through their matchups.
5. Phase 2 unlocks automatically when everyone finishes Phase 1; final rankings
   `.xlsx` downloads when Phase 2 is done.

## How the ranking works

- **Phase 1:** every applicant gets ~4 random matchups, split evenly across the
  committee. Standard Elo update after each pick.
- **Phase 2:** the bottom tier is frozen; the top ~67% get ~4 more matchups against
  similar-Elo opponents to sharpen the cutoff. Survivors end with ~8 comparisons.
- **Output:** a **Rankings** sheet (Elo, record, made-cut) and a **Comments** sheet
  (every comment, who wrote it, phase, opponent) for in-person deliberation.

Tune matches-per-phase, the Phase-2 cutoff %, and the Elo K-factor from ⚙ Settings.

## Try it without Firebase

Append `?mock=1` to the URL to run the whole app against your browser's local
storage (great for demos/training). Data stays on that machine.

## Project layout

```
index.html            entry point (password gate → dashboard → wizard)
css/styles.css        styles
js/parse.js           template .xlsx → candidates + committee
js/elo.js             Elo update + Swiss phase-1/phase-2 pairing
js/db.js              data layer (Firebase + local mock backends)
js/dashboard.js       admin console + committee grid
js/wizard.js          head-to-head wizard + review screen
js/export.js          final rankings/comments .xlsx
js/firebase.js        your Firebase project config
lib/                  vendored Firebase SDK + SheetJS (no external CDN)
firestore.rules       database access rules
docs/HANDOFF.md       full setup + handoff guide
```
