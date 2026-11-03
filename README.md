# TCRS — School 4 Combined Movement Builder

A single-page website that combines one month of **School 4 vehicle data** with
**troop-lift bus movements** into one clean, printable schedule.

Two source workbooks in, one School 4 schedule out — grouped **by date** or
**by company**, fully editable in a **Live sheet**, and exportable as a
formatted Excel workbook. Clean pastel UI. Runs password-protected on a small server that
remembers your work, or fully offline from any static server.

```
                           ┌────────────────┐      ┌────────────────┐
                           │   ICRF .xlsx    │      │ Troop Lift .xlsx│
                           │  (fixed 4-row   │      │ (free-text day  │
                           │   header template)     │  blocks, 1 col) │
                           └───────┬────────┘      └───────┬────────┘
                                   │  fixed-layout parse   │  line-grammar parse
                                   └───────────┬───────────┘
                                               ▼
                          combine · filter to School 4 · flag & note
                                               ▼
                          ┌──────────────────────────────────────┐
                          │  Live sheet — edit any cell, rows     │
                          │  add / duplicate / delete, auto-saved │
                          │  locally                              │
                          │            ▼ reflected instantly in   │
                          │  Schedule: By Date | By Company       │
                          │  Export: .xlsx (2 formatted sheets    │
                          │           + a "Data notes" audit sheet)│
                          │  Print: page-break per day/company    │
                          └──────────────────────────────────────┘
```

Parsing and editing happen **in the browser**. When you run it with `server.py`
(below) your workbooks and edits are also stored on *your* server so they're still
there next time; without it, nothing leaves the device.

## Run it (password-protected, remembers your edits)

```bash
TCRS_PASSWORD='a long passphrase' python3 server.py
# open http://127.0.0.1:8000 and sign in
```

Python 3.9+ standard library only — nothing to install. Everything, including the
site itself, sits behind the password. Options (environment variables):

| Variable | Default | Meaning |
| --- | --- | --- |
| `TCRS_PASSWORD` | *(required, ≥ 6 chars)* | The shared password |
| `PORT` / `HOST` | `8000` / `127.0.0.1` | Use `HOST=0.0.0.0` to listen on all interfaces |
| `TCRS_DATA_DIR` | `./data` | Where `state.json` (your work) is kept — back this up |
| `TCRS_TRUST_PROXY` | off | Set `1` behind a reverse proxy / PaaS (real client IP, HTTPS cookies) |
| `TCRS_SESSION_DAYS` | `30` | How long a sign-in lasts |
| `TCRS_SECRET` | generated | Cookie-signing secret (otherwise created in the data dir) |

### Deployment architecture

The app is now split into a static frontend and a backend API:

- Frontend source: `frontend/` — deploy as a static site on GitHub Pages
- Backend source: `backend/` — deploy on Google Cloud Run
- Shared secret: `.M` (or equivalent Secret Manager secret) stores the backend password outside source control
- Allowed frontend origin: `TCRS_ALLOWED_ORIGINS` or `TCRS_ALLOWED_ORIGIN` restricts backend calls to the GitHub Pages domain only

### GitHub Pages + Cloud Run

1. Publish the contents of `frontend/` from the repository's Pages workflow.
2. Set the frontend `window.TCRS_API_BASE` to your Cloud Run URL or add the value in the deployment config.
3. Deploy the backend from `backend/` to Cloud Run using the provided `backend/Dockerfile` and `backend/cloudbuild.yaml`.
4. Define the allowed front-end domain via `TCRS_ALLOWED_ORIGINS` (for example `https://your-user.github.io`) and keep the real password in `.M` / Secret Manager.

### Putting it on the internet

The server speaks plain HTTP, so publish it **behind HTTPS** — the easy way is a host
that terminates TLS for you and gives the app a persistent disk:

- **Render:** *New → Blueprint*, pick this repo (`render.yaml` is included — it mounts a
  1 GB disk at `/data`). Enter `TCRS_PASSWORD` when asked.
- **Docker anywhere (Fly.io, Railway, a VPS behind Caddy/nginx):**
  ```bash
  docker build -t tcrs .
  docker run -d -p 8000:8000 -e TCRS_PASSWORD='…' -e TCRS_TRUST_PROXY=1 -v tcrs-data:/data tcrs
  ```
- **Quick share from your own machine:** run `server.py`, then expose port 8000 with a
  tunnel such as `cloudflared tunnel --url http://localhost:8000`.

Without a persistent disk the host wipes `state.json` on every redeploy — that is the
one thing that would lose your edits.

**Security model:** one shared password → a signed, `HttpOnly`, `SameSite=Lax` session
cookie. Wrong guesses are slowed down and locked out after 5 tries per 5 minutes per IP.
Only the site's own files are served (never `server.py`, `data/`, or the repo). Pick a
long passphrase; anyone who has it can read and change the schedule.

### Static-only mode

Any static server also works for a browser-only session with drag-and-drop uploads.
Edits then persist in this browser's `localStorage` only:

```bash
python3 -m http.server 8000
```

Two tabs share one authoritative dataset:

- **Schedule** — the formatted views (stats bar, company chips, by-date /
  by-company grouping, print & export).
- **Live sheet** — an editable spreadsheet of the combined movements.

## Live sheet

The Live sheet has two sub-tabs that mirror the source workbooks:

- **ICRF · vehicles** — the sheet in its original column template (SCH / company /
  activity, veh type, qty, req'd TO, start/end date & time, reporting,
  destination, officer, phone, unit). Rows the parser skipped (headers, notes)
  appear hatched; type a valid `SCH 4 - <6TH COY> - <ACTIVITY>` in their first
  cell to bring them into the schedule.
- **Troop lift · lines** — the original one-column list, grouped under each date,
  covering every unit. Each line is edited as raw text
  (`0545 MTL - RHC 4 BUSES (7TH BOOK IN)`) and re-parsed on commit; School 4
  companies show as chips, unrecognised lines are flagged and fixable in place.

Every cell is click-to-edit. `Enter` commits (and moves down in the ICRF grid),
`Tab`/`Shift+Tab` move sideways, `Esc` cancels. Row tools appear on hover
(⧉ duplicate, ✕ delete with a two-step confirm); *＋ Add row* / *＋ Add line*
append new ones. Invalid values are rejected inline with a reason (dates
`DD/MM/YYYY`, times `07:05` or `0705`).

Editing an ICRF **start date** shifts the end date too, so multi-day movements
keep their span (`+3d` is recalculated).

**Storage** — every change auto-saves (the pill in the top bar shows *Saving… /
Saved · 14:32*). Close the tab, come back tomorrow, or open it on another device and
sign in: the two workbooks, every edit, and your view settings (tab, grouping, company
filters, POC toggle) reopen exactly as you left them — no re-uploading.

- With `server.py` the state is written to `data/state.json` (one record per month,
  with a rolling `state.json.bak`). A copy is also cached in `localStorage`
  (`tcrs:v3:<month>-<year>`), so edits made while the server is unreachable are kept
  and pushed up as soon as it's back — the newest copy wins when you reopen.
- If two devices edit at once, the second one to save is told
  *Changed elsewhere — click to reload* instead of silently overwriting the first.
- **Remove** on a source file unloads it for good (it won't reappear on reload); edits
  stay stored and return when the same month is loaded again.
- **Reset edits** restores the freshly parsed data (snapshot kept at parse time) and
  forgets the saved edits.

The Schedule tab and the `.xlsx` export are generated from the live sheet's
current state — manual and edited rows are marked in the export's Data notes
sheet.

Options on the left rail (also respected by the live sheet, e.g. company
filters hide rows there too):

| Option | What it does |
| --- | --- |
| Company chips | Include / exclude each company from the combined schedule |
| Include **SCHWIDE** | Keep shared school-wide movements (e.g. "SCH 4 - SCHWIDE - RE-RM 3") |
| Keep only School 4 movements | Off = also list every other unit's Troop Lift lines (sanity check view) |
| Show POC / contact | On-screen + export column for the conducting officer & phone |

## What the parser expects (fixed official templates)

**ICRF** — 4 header rows, then per row:
`SCH <school> - <X COY>[ / <Y COY>] - <ACTIVITY>` in col A, with
vehicle type (LUV / 5-Ton GS / SOV…), qty, start/end date + time,
reporting, destination, conducting officer, phone, unit.

**Troop Lift** — one column. `NOVEMBER TL` title row, then one row per date
(either a date cell or `24/11 (*TBC*)`) followed by movement lines:

```
<HHMM|TBC> <FROM> - <TO> <count> BUSES|BUS|TONNERS|TONNER (<TAG ACTIVITY>)
```

Lines wrapped in `*asterisks*` are parsed and marked flagged. School 4 lines
are those whose parenthetical tag starts with a School 4 company ordinal
(`1ST`, `4TH`, `5TH`, `6TH`, `7TH`) — the ordinal set, like the whole month,
is auto-detected from the files.

Handled automatically — and reported on the **Data notes** export sheet:

- **Day/month swap repair.** The sample was authored on a mixed-locale
  machine, so e.g. `11/02` (11 Nov intent...) — actually stored as 11 *Feb*.
  When a date falls outside the detected month and swapping day/month lands
  inside it, the fix is applied and logged (38 fixes in the sample set).
- **Quirks.** `TBC` times, missing bus counts, `\xa0` nbsp padding inside
  routes, `(*TBC*)` placeholder days, multi-day movements (`+Nd` label),
  rows behind the template headers (`PREPARK VEHICLE`, `AMMO VEHICLE`, …).
- Organisational rows and lines that don't match the grammar are listed in
  accordions rather than dropped silently.

## Repository layout

| Path | Purpose |
| --- | --- |
| `server.py` | Password gate + static files + `/api/state` persistence (stdlib only) |
| `login.html/.css/.js` | The pastel sign-in page |
| `index.html`, `styles.css`, `app.js` | The site (UI, tabs, Excel export, persistence) |
| `sheet.js` | Editable live-sheet grid (no third-party grid library) |
| `parser.js` | Pure parsing/merge logic — no DOM, reusable |
| `vendor/exceljs.min.js` | Vendored ExcelJS 4.4.0 (offline, no CDN) |
| `Dockerfile`, `render.yaml` | Deployment recipes |
| `dist/` | Static-hosting copy of the site files (no server, no samples or tests) |
| `samples/` | The two reference workbooks (copied from the repo root) |
| `tests/test.html` | 28 parser assertions (reference values) |
| `tests/smoke.html` | UI + live-sheet + export read-back smoke test |
| `tests/screens/` | Rendered screenshots |
| `reference_parse.py` | Python mirror of the parser; source of the expected values |

## URL hashes

`#auto` loads the bundled samples and shows the by-date schedule; `#auto-coy`
switches to the by-company view; `#auto-grid` opens the Live sheet (ICRF) and `#auto-tl` its Troop lift tab.
Useful as demo bookmarks after combining.

## Tests

```bash
python3 tests/server_test.py             # password gate, no file leaks, persistence, conflicts
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless=new --allow-file-access-from-files --dump-dom \
  "file://$(pwd)/tests/test.html"        # 28 parser tests
"$CHROME" --headless=new --allow-file-access-from-files --dump-dom \
  "file://$(pwd)/tests/smoke.html"       # UI + export smoke (title: SMOKE OK / FAILED)
```

## Notes & future ideas

- Vehicle naming keeps the source casing (`5-Ton GS`); counts render as `4× BUSES` / `LUV ×1`.
- Export keeps times as **text** so leading zeros (`0545`) survive Excel.
- Ideas: attach-number summary per day, route preset dictionary, drag-and-drop of
  both files at once, month selector when workbooks contain several sheets,
  CSV/Google-Sheets paste-in for the live sheet.
