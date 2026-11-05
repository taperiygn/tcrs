# TCRS — Code Improvement Plan

*Grounded in an audit of the repo on 2026-11-04. Constraint honored throughout: keep the
stdlib-only backend and no-build vanilla frontend philosophy — improvements should reduce
complexity, not add tooling for its own sake.*

---

## Status log

**Decisions (2026-11-04):** do NOT build 2.3 (password rotation runbook) or 3.1 (script-tag module split).
User picked two new features: **3 · Month picker** and **5 · Edit history**. Everything else is unapproved; ask first.

**Where work stopped:** audit done, features chosen, code reading started. No feature code written yet.
- Month picker: sheet selection happens in `frontend/app.js` ~L349 and ~L361 (`best = wb.worksheets[0]`, scored by row count) and `frontend/parser.js` ~L516-519 (`worksheets[0]`). Restore messages at app.js ~L2018-2028 also read `worksheets[0]`.
- Edit history: not started. Save stream is `saveStore` / `flushSave` / `pushRemote` in app.js ~L219-290.
- Next: Month picker first (nearest), then Edit history.

**2026-11-05 — Month picker DONE** (commit 9a22c75, live on Pages):
- Sheet dropdown on each upload card when a workbook has 2+ sheets; "Auto" keeps the content-best pick; an explicit choice is stored on the file record and survives save/restore.
- Bonus bug fix found by the new test: `monthStr`/`readLocal` doubled the school prefix in localStorage keys (`tcrs:files:s4:s4-11-2026`), so local-only restore of workbooks/edits never matched what `flushSave` writes. Fixed centrally in `monthStr`.
- Verified by `tests/sheetsel.html` (17 assertions, headless Chrome, all passing).
- Next: Edit history (feature 5).

**2026-11-05 — Edit history DONE** (commit 6e0f189, live on Pages):
- One event per save burst in `flushSave`: live-sheet cell edits diffed against the previous save (`histSig` snapshot → added/changed/removed); named actions record themselves (`applySheetData` → "Google Sheet sync — …", `applyTLText` → "Troop lift text updated — …", `resetEdits` → "Edits reset…").
- Trail stored in the edits payload (opaque to the backend), capped at 50, newest first; persists locally (`flushSave` now writes `history` into the v3 record — was dropped) and to the server (`readRemote` passes it through).
- UI: "Recent changes" accordion, first in the left rail options card; 15 rows visible + overflow line.
- Verified by `tests/histtest.html` (18 assertions over the real save stream, all passing); sheetsel suite re-run green.
- Both user-chosen features complete. Everything else in this plan remains unapproved — ask before building.

---

## Tier 0 — Hazards to fix first (bugs / traps that bite you today)

### 0.1 Kill the stale root-level frontend copies ⚠️ highest priority
- `app.js` and `login.js` at the repo root are **stale pre-fix copies** that silently
  diverged from `frontend/` during this session's bug fixes (root copies still have the
  broken `/login` redirects and `same-origin` credentials).
- Six other root files are byte-identical duplicates of `frontend/`.
- **Risk:** edit the wrong copy, deploy the right one, lose the fix — exactly the trap
  that already happened once.
- **Do:** delete root `index.html, app.js, styles.css, sheet.js, parser.js, login.*,
  config.js, vendor/` and the whole `dist/` directory (it even ships a stale `server.py`
  and `cs.py`). Update the README's *Repository layout* table (it still references
  `samples/` and `dist/`), and make `frontend/` the single source of truth.
- *Effort: 30 min. Payoff: removes the #1 source of silent regressions.*

### 0.2 Single-instance guard for the data store
- `Store` uses a `threading.Lock` — correct **within one instance only**. Cloud Run can
  scale to >1 instance; two instances would read-modify-write the same
  `state.json` on the GCS volume → lost updates / split-brain.
- **Do (cheap):** pin `--max-instances=1` (concurrency 80 is plenty for this app) in
  `backend/cloudbuild.yaml`, plus a comment explaining why.
- **Do (later, if scale ever matters):** move month records to Firestore or make the
  store optimistic-concurrency-aware via GCS object generation numbers.
- *Effort: 5 min now. Payoff: prevents silent data corruption.*

### 0.3 Repair the smoke test
- `tests/smoke.html` fails under modern headless Chrome because it `fetch()`es
  `../index.html` / `../app.js` over `file://` (blocked). The parser test page similarly
  lost its fixtures when sample workbooks were removed (`SAMPLE WORKBOOKS REMOVED`).
- **Do:** serve the tests over HTTP in the test itself (tiny `python3 -m http.server`
  bootstrapped by the test, or inline the fixtures as JS constants instead of `.xlsx`
  files). Then re-enable parser assertions with inline fixture strings.
- *Effort: 1–2 h. Payoff: the test suite becomes trustworthy again.*

### 0.4 Add a CI workflow that actually runs the tests
- Today only deploy workflows exist; tests run only on your laptop.
- **Do:** `.github/workflows/test.yml` — on every PR/push: `python3 tests/server_test.py`,
  then the browser tests via headless Chrome on ubuntu (with the HTTP-serving fix from
  0.3). Keep it out of the deploy paths so it never triggers deploys.
- *Effort: 30 min after 0.3. Payoff: green/red signal on every change.*

---

## Tier 1 — Correctness & data integrity

### 1.1 Backup story for the GCS-backed store
- `state.json.bak` (rolling, 10-min) is fine, but the bucket can do better for free:
  enable **Object Versioning** on `tcrs-data-252721065839` + a lifecycle rule keeping
  e.g. 30 days of noncurrent versions. Then any bad write is recoverable from the
  console, and `.bak` becomes a convenience rather than the safety net.
- *Effort: 10 min in console/gcloud.*

### 1.2 Make saves resilient to gcsfuse latency
- Every save does `write tmp → fsync → rename` through gcsfuse, which is slow
  (hundreds of ms–seconds) and serializes edits server-side.
- **Do:** measure real latency; if noticeable, (a) raise the frontend debounce from
  700 ms, (b) drop the explicit `fsync` (rename is atomic enough on GCS FUSE with
  default settings — verify), or (c) move the store to a single Firestore doc per month
  (real transactions, real concurrency, no fuse).
- *Effort: measure 30 min; Firestore migration ~half a day (schema is already JSON).*

### 1.3 Conflict handling edge cases
- The 409 "Changed elsewhere" flow stops saving until manual reload — good. But
  `remote.revs` is only refreshed on boot; a tab left open overnight then editing will
  409 against every save with no auto-recovery path other than reload.
- **Do:** on 409, offer a one-click "load their version" that GETs state and re-parses
  in place (the plumbing exists via `bootRestore`/`restoreWorkspace`).
- *Effort: 1–2 h.*

### 1.4 Session/token expiry UX
- Tokens/cookies last 30 days, but there's no proactive expiry check — an expired
  session mid-edit currently manifests as a 401 bounce with potential edit loss (the
  localStorage fallback saves it, but the user won't know why they were bounced).
- **Do:** on 401, stash the pending edits to localStorage *before* redirecting (verify
  this already happens — `flushSave(true)` on beforeunload covers most cases), and show
  "session expired — sign in again, your work is safe" on the login page via a query param.
- *Effort: 1 h.*

---

## Tier 2 — Security hardening (low effort, worth doing)

### 2.1 Content-Security-Policy on the frontend
- No CSP today. The app is self-contained (vendored ExcelJS, no CDN) so a strict CSP is
  easy: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  connect-src <API origin>; img-src 'self' data:`.
- **Do:** add `<meta http-equiv="Content-Security-Policy">` to `frontend/index.html`
  and `login.html` (meta-based works on Pages since there's no server header control).
- *Effort: 30 min + testing. Payoff: XSS blast-radius containment.*

### 2.2 Rate-limit `/api/sheet`
- It's authenticated, but each call makes the server fetch from Google (25s timeout).
  A logged-in user (or a leaked password) can hammer it.
- **Do:** reuse the existing throttle pattern (`AUTH.throttled`) with a small bucket,
  e.g. 10 fetches/min per IP, and cache the last fetch per sheet-id for ~60 s.
- *Effort: 1 h.*

### 2.3 Password rotation runbook
- Document (README) the exact 3-command rotation: new secret version → redeploy →
  verify. Keys are password-bound so all sessions invalidate — say so explicitly.
- *Effort: 15 min of writing.*

### 2.4 (Optional) Per-user accounts
- One shared password means no audit trail of *who* edited. If this ever matters,
  the token payload could carry a username chosen at login (still one password, but
  edits get attributed in the Data notes sheet). Low priority.

---

## Tier 3 — Frontend architecture & UX

### 3.1 Split app.js into logical modules (no build step needed)
- 2,042 lines / 258 functions in one IIFE is at the edge of maintainability. Natural
  seams already exist: parser glue, sheet grid wiring, export, remote sync, options.
- **Do:** split into `frontend/js/{state,remote,sync,export,ui}.js` loaded as plain
  `<script>` tags sharing a single `window.TCRS` namespace (no bundler). Keep
  `parser.js` and `sheet.js` as-is — they're already clean.
- *Effort: half a day, mechanical. Payoff: reviewable diffs, faster debugging.*

### 3.2 The stale-copy guard (complements 0.1)
- Add a CI check: fail if any file exists both at root and in `frontend/` (after 0.1
  this is just a guard test) — one-line script in the test workflow.

### 3.3 Mobile / small screens
- The UI is desktop-first (left rail, hover row tools). If soldiers/OCs will open this
  on phones: make the left rail collapsible, row tools tap-friendly (long-press or an
  explicit row menu), and test the live sheet grid on a small viewport.
- *Effort: half a day to make it usable, more to make it nice.*

### 3.4 Accessibility quick pass
- Keyboard: the live sheet has Enter/Tab/Esc — verify arrow-key navigation and
  screen-reader labels on the tabs/buttons (`aria-label` on icon-only buttons,
  `role="tablist"` on the tab bar). Focus outlines on the pastel theme.
- *Effort: 2–3 h for the 80/20.*

### 3.5 Empty/error states
- The sheet-link error box is good; extend the pattern: upload failures, export
  failures, and the "server unreachable" state all deserve the same inline, actionable
  copy (e.g. include the retry hint in the pill tooltip).

### 3.6 Sheet sync feedback
- The 15-min auto-refresh is invisible when it works. Consider a subtle "synced 14:32
  from Google Sheets" in the linked row (the timestamp exists — `gsAt`) and a manual
  "Refresh now" button next to it if there isn't one.
- *Effort: 1 h.*

---

## Tier 4 — Backend code quality

### 4.1 Extract the Handler god-class
- `backend/server.py` is one 657-line file with a Handler class covering routing, auth,
  sheets, store, sweeps. The section markers are good — formalize them into modules:
  `store.py` (Store + sweep), `auth.py` (Auth + load_secret), `api.py` (handler), keep
  `server.py` as the entrypoint. Same stdlib-only constraint, same behavior.
- *Effort: half a day. Payoff: each concern becomes testable in isolation.*

### 4.2 Type hints + docstring the store API
- `Store.put/delete/snapshot` are the critical surface; add type hints and a docstring
  documenting the merge semantics for `files` (now partial-aware — this session proved
  how load-bearing that contract is).

### 4.3 Structured request logging
- `log_message` writes to stderr; Cloud Run captures it but it's unstructured.
- **Do:** log one JSON line per request: method, path, status, ms, ip (already
  proxied), and for state writes: key + rev. Enables log-based queries later.
- *Effort: 1 h.*

### 4.4 Health endpoint that actually works on Cloud Run
- `/healthz` is intercepted by Google's frontend on `*.run.app` (known GFE quirk).
  Add `/healthz2` (or `/api/health`) and use it in any future uptime checks /
  Cloud Run startup probes.

---

## Tier 5 — Product ideas (from the README's own list, prioritized)

1. **Route preset dictionary** — most repeated origin/destination pairs; a small
   dropdown/autocomplete in the live sheet would remove the most typing.
2. **Attach-number summary per day** — a per-day count strip above each date group.
3. **CSV / Google-Sheets paste-in for the Live sheet** — same parser, new input path.
4. **Month selector when workbooks contain several sheets** — parser already
   auto-detects; surface a picker instead of first-sheet-wins.
5. **Diff view on sheet sync** — before `mergeEntries` overwrites ICRF rows, show
   "3 changed, 2 removed from the sheet — apply?" (the raw CSVs are already compared).
6. **Shareable read-only view** — a second, weaker token that can view but not edit
   (useful for the OC who just wants to look). Moderate auth work.

---

## Suggested order of execution

| Sprint | Items | Why first |
| --- | --- | --- |
| 1 | 0.1, 0.2, 2.1, 2.3 | All ≤1 h, remove real hazards |
| 2 | 0.3, 0.4, 4.4 | Trustworthy tests + CI green |
| 3 | 1.1, 1.3, 1.4, 2.2, 4.3 | Data safety + API hygiene |
| 4 | 3.1, 4.1, 4.2 | Structural cleanup while nothing is on fire |
| 5+ | 3.3–3.6, Tier 5 | Product polish, driven by actual usage |

*Revisit this file after each sprint; strike items, add findings.*
