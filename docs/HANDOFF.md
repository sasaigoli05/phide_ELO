# PhiDE Rush ELO — Setup & Handoff Guide

This is the one document a future exec / SRMO needs. It explains how to get the
site running, how to run a recruitment cycle, and how to hand it off when you leave.
Nothing here requires you to write code.

---

## 1. What this is (30-second version)

A website for head-to-head ("this applicant vs. that applicant") review of PhiDE
applications, using the **Elo** rating system in a **2-phase Swiss** format.

- The website itself is **static files** hosted free on **GitHub Pages**.
- The shared data (applications, matchups, picks, comments) lives in a free
  Google-hosted database called **Firebase Firestore**, so every committee member
  on their own laptop sees the same thing in real time.
- There are **no servers to run and no bills to pay**. Realistic yearly upkeep: ~0.

```
Committee laptops  ─┐
                    ├─►  GitHub Pages (the website)  ─►  Firebase Firestore (shared data)
Admin laptop       ─┘
```

---

## 2. One-time setup (do this once, ~15 minutes)

You need the **shared PhiDE Google account** that owns the Firebase project
(currently `rush-elo-app`). Do NOT use a personal account — that's what makes
handoff painful later.

### 2a. Turn on Anonymous sign-in  ← REQUIRED, the app won't load without it
1. Go to <https://console.firebase.google.com> and open the **rush-elo-app** project.
2. Left sidebar → **Build → Authentication → Get started**.
3. **Sign-in method** tab → **Add new provider** → **Anonymous** → toggle **Enable** → **Save**.

> Why: the site signs every visitor in as an anonymous guest so the database can
> tell "a real visitor of our app" apart from random internet traffic. No one types
> a Google password — it's invisible to users.

### 2b. Publish the database security rules  ← REQUIRED, DB is locked until you do
1. Left sidebar → **Build → Firestore Database → Rules** tab.
2. Delete what's there and paste the entire contents of the repo file
   [`firestore.rules`](../firestore.rules).
3. Click **Publish**.

> Why: you created the database in "production mode", which blocks *everything* by
> default. These rules open it up to signed-in app visitors only.

### 2c. Put the site on GitHub Pages
1. Push this repository to GitHub (already at `sasaigoli05/phide_ELO`).
2. On GitHub: repo → **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Branch = **main**, folder = **/ (root)** → **Save**.
5. Wait ~1 minute. Your site is at **https://sasaigoli05.github.io/phide_ELO/**.

That's it. Share that link + the team password with the committee.

---

## 3. Passwords

| | Default | What it's for |
|---|---|---|
| **Team password** | `phide` | Share with the whole committee. Opens the dashboard. |
| **Admin password** | `admin` | For exec / SRMO. Adds upload + settings + download powers. |

**Change them immediately** after first login: log in as admin → click the ⚙ gear
(top right) → set new passwords → **Save**. They're stored in the database and can
be reset anytime from that same panel (this is the "reset by exec/SRMO" ask).

---

## 4. Running a recruitment cycle

**Before you start:** applicant photos come from the Google Drive links in the
"Picture:" column of the template. For a photo to show, that Drive file must be
shared **"Anyone with the link"**. Otherwise the app shows a neutral placeholder —
harmless, review still works.

1. **Fill in the template spreadsheet.** Use the same column layout as
   `data/sample-template.xlsx`: a **Responses** sheet (one row per applicant) and a
   **Recruitment Committee** sheet (one name per row). The applications come straight
   from the Google Form export.
2. **Log in as admin** → **Upload template** → pick your `.xlsx` → **Push to committee**.
   Phase 1 goes live instantly for everyone.
3. **Committee reviews Phase 1.** Each person opens the site with the team password,
   clicks their own name, and works through their matchups (pick a winner; optional
   comments). They can go back and change anything until they're done.
4. **Phase 2 unlocks automatically** the moment the *last* committee member finishes
   Phase 1. No admin action needed. The bottom ~1/3 of applicants are frozen; the top
   ~2/3 get another round, paired against similar-strength opponents.
5. **Committee reviews Phase 2** the same way.
6. **Download results.** When the last person finishes Phase 2, the admin's
   **Download rankings** button lights up. It produces an `.xlsx` with:
   - **Rankings** sheet — every applicant ranked by final Elo, with W–L record and
     whether they made the Phase-2 cut.
   - **Comments** sheet — every comment, who wrote it, which phase, and the opponent.

### Tuning the tournament (optional)
Admin ⚙ Settings has four dials (with sensible defaults):
- **Phase 1 matches / candidate** (default 4)
- **Phase 2 matches / candidate** (default 4)
- **Keep top % into Phase 2** (default **67%** — recommended when you invite ~60 of ~120)
- **Elo K-factor** (default 32)

Rule of thumb: set "Keep top %" a bit **above** the number you plan to invite, so the
people right at the invite cutoff get the extra Phase-2 scrutiny before you draw the line.

---

## 5. Handing it off when you leave

Pick whichever applies:

- **Same Firebase project (easiest):** just pass along the **shared PhiDE Google
  account** login to the next exec. Nothing else changes. Optionally add their
  Google account as a project **Owner** under Firebase → Project settings → Users and
  permissions.
- **New Firebase project:** the next person creates their own free project (see the
  Firebase steps above), then replaces the config object in
  [`js/firebase.js`](../js/firebase.js) with theirs, redoes steps 2a–2b, and pushes.

Either way, the GitHub repo and Pages site keep working untouched.

---

## 6. Good-to-know

- **Testing without touching real data:** add `?mock=1` to the URL
  (e.g. `…github.io/phide_ELO/?mock=1`). This runs the whole app against your
  browser's local storage instead of Firebase — perfect for demos or training. Data
  stays on that one machine and never hits the shared database.
- **Starting over mid-cycle:** admin toolbar → **Reset** wipes all applications,
  matchups, and picks (passwords are kept) and returns to the upload screen.
- **Security posture (be honest with yourself):** this is an intentionally
  low-security, trust-based tool, exactly as scoped. The team password gates the UI,
  but a technically-savvy person who viewed the site's code could reach the database
  directly. That's an accepted tradeoff for a club recruitment tool. **Don't store
  anything more sensitive than application text and photos here.**
- **Libraries** (Firebase SDK, SheetJS) are committed under `lib/` on purpose, so no
  external CDN can break the site years from now.
