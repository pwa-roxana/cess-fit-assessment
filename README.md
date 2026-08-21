# CESS Fit Assessment

A small internal tool for Pacific West Academy's CESS admissions process. Applicants choose from four
tests on one public page:

- **General EP Fit Assessment** (30 items) — a personality inventory (Conscientiousness, Emotional
  Stability, Extraversion, Agreeableness, Openness) plus 5 critical-thinking scenarios and 5 emotional-
  intelligence scenarios. Every applicant takes this one.
- **Estate Security Scenarios** (5 items) — situational judgment questions specific to residential/estate
  protection.
- **Event Security Scenarios** (5 items) — situational judgment questions specific to venue and crowd
  protection.
- **Driving Security Scenarios** (5 items) — situational judgment questions specific to transport and
  motorcade protection.

The same applicant can take more than one test (e.g. General plus whichever specialty track they're
interviewing for) — duplicate submission is blocked per test, not across all tests.

- **Public page (`/`)** — no login required.
- **Staff results page (`/results.html`)** — password-protected. Shows every submission across all four
  tests, with test name, full score breakdown, headline score/band, and a CSV export.

This is a decision-support tool, not a validated clinical instrument. Use results alongside the
structured behavioral interview and situational judgment scoring — not as a stand-alone admission gate.

## How it's built

- **Backend:** Node.js + Express
- **Content:** all four tests and their items live in `tests.json` — edit that file to add, remove, or
  reword questions without touching any code
- **Database:** SQLite (via `better-sqlite3`) — a single file, no external database service required
- **Auth:** up to two shared staff passwords (e.g. one for Admissions, one for Academics), each stored
  as a bcrypt hash, session cookie for login state — either password logs a staff member into the same
  shared results view
- **Backups:** an automatic daily snapshot of the database, plus on-demand snapshots and downloads from
  the Results page
- **Frontend:** plain HTML/CSS/JS, no build step

## 1. Run it locally

```bash
npm install
cp .env.example .env
```

Generate a session secret and put it in `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Generate a hash for each staff password and put them in `.env`:

```bash
node scripts/hash-password.js "choose-a-real-password"      # -> STAFF_PASSWORD_HASH_1
node scripts/hash-password.js "choose-a-different-password" # -> STAFF_PASSWORD_HASH_2 (optional)
```

Leave `STAFF_PASSWORD_HASH_2` blank in `.env` if you only want one password — either configured
password will log a staff member into the same results view; the app doesn't distinguish who used which.

Then start the server:

```bash
npm start
```

Visit `http://localhost:3000` for the assessment, and `http://localhost:3000/login.html` to log in
as staff and view results.

## 2. Push this to your own GitHub

This project isn't connected to a GitHub account yet — you'll need to do this part yourself since it
requires your own credentials:

1. Create a new **empty** repository on GitHub (no README/license, so there's nothing to conflict with).
2. From this project folder:

   ```bash
   git init
   git add .
   git commit -m "Initial commit: CESS fit assessment tool"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo-name>.git
   git push -u origin main
   ```

`.env` and `data.sqlite` are already in `.gitignore`, so your password hash and any local submissions
won't get pushed.

## 3. Deploy it somewhere with a live backend

GitHub itself only stores code — it doesn't run your server. You need a host that can run a Node.js
process. Since you already have a Railway account, that's the easiest path — steps below — with Render
as a fallback if you ever want it.

### Deploying on Railway

1. Push the code to GitHub first (step 2 above) — Railway deploys from a GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo you just pushed. Railway
   detects Node.js from `package.json` automatically and runs `npm install` / `npm start` — no build
   config needed.
3. Add a **volume** so the SQLite file and backups survive redeploys: right-click the project canvas
   (or press `⌘K` / `Ctrl+K`) → **New Volume**, attach it to this service, and set the mount path to
   `/data`.
4. In the service's **Variables** tab, add:
   - `SESSION_SECRET` — the random string you generated
   - `STAFF_PASSWORD_HASH_1` — the first bcrypt hash you generated
   - `STAFF_PASSWORD_HASH_2` — the second one, if you're using two passwords (optional)
   - `NODE_ENV=production`
   - `DB_PATH=/data/data.sqlite`
   - `BACKUP_DIR=/data/backups`
   Don't set `PORT` — Railway assigns it automatically and the app already reads `process.env.PORT`.
5. **Settings → Networking → Generate Domain** to get a public `https://your-app.up.railway.app` URL.
   That's what you share with admissions/academics staff for `/results.html`, and what you'd put in
   front of applicants for `/`.

The repo includes a `railway.json` that sets `overlapSeconds: 0`. That's specifically for SQLite: by
default Railway briefly runs the old and new containers side by side during a redeploy, which would
mean two processes writing to the same database file at once. Setting it to zero stops the old one
first, so there's never more than one writer.

### Deploying on Render (alternative)

1. Sign up at render.com and connect your GitHub account.
2. **New → Web Service**, pick the repo you just pushed.
3. Build command: `npm install` — Start command: `npm start`
4. Add a **persistent disk** (Render's Dashboard → your service → Disks) mounted at `/data`.
5. Add the same environment variables as above (`DB_PATH=/data/data.sqlite`, `BACKUP_DIR=/data/backups`,
   `SESSION_SECRET`, `STAFF_PASSWORD_HASH_1`, `STAFF_PASSWORD_HASH_2`, `NODE_ENV=production`).
6. Deploy. Render gives you a `https://your-app.onrender.com` URL.

## Changing a staff password later

Run `node scripts/hash-password.js "new-password"` again, update `STAFF_PASSWORD_HASH_1` (or `_2`) in
your host's environment variables, and redeploy. Anyone already logged in stays logged in for up to
8 hours (session length) unless they log out.

## Backups

A snapshot of the full SQLite database is copied into `BACKUP_DIR` automatically once when the server
starts and again every 24 hours it stays running. The Results page has a **Backups** panel where staff
can see all recent snapshots, download any of them, or trigger one immediately with **Snapshot Now**.
The last 30 snapshots are kept; older ones are pruned automatically.

Two things worth knowing:

- **This only protects against accidental data loss on the app itself** (a bad delete, a corrupted
  write) — it does not protect against losing the entire host. If the persistent disk itself is lost,
  the backups on it are lost too. For real off-site protection, periodically download a snapshot
  (via **Download Current DB** on the Results page) to somewhere else — a shared drive, email to
  yourself, wherever your other institutional backups live.
- If you move to a hosted Postgres database later (see the note on scale below), this file-copy backup
  approach won't apply — most hosted Postgres providers (Render, Railway, Supabase) include their own
  automatic backups instead.

## A few limits worth knowing

- **Shared passwords, not accounts** — even with two passwords, you still can't tell which staff member
  viewed or exported results, and revoking one person's access means changing that password for
  everyone who has it. If you outgrow that, the natural next step is per-user accounts (e.g. via a
  service like Supabase Auth or Auth0) rather than rolling your own — happy to help with that migration
  when it's needed.
- **SQLite** is fine at this scale (one campus's admissions cycle) but isn't built for many simultaneous
  writers. If PWA's usage grows well beyond that, moving to a hosted Postgres database (Render, Railway,
  and Supabase all offer one) is a small change to `db.js`, not a rewrite.
