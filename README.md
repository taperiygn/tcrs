# TCRS — School 4 Combined Movement Builder

A single-page website that combines one month of **School 4 vehicle data** with
**troop-lift bus movements** into one clean, printable schedule.

Two source workbooks in, one School 4 schedule out — grouped **by date** or
**by company**, fully editable in a **Live sheet**, and exportable as a
formatted Excel workbook. Glass-morphic UI; everything runs offline.

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

Everything runs **entirely in the browser** — neither file is ever uploaded.

## Usage

Any static server works (needed for the *Load sample data* button; manual
drag-and-drop works without one, e.g. straight from `file://`):

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Two tabs share one authoritative dataset:

- **Schedule** — the formatted views (stats bar, company chips, by-date /
  by-company grouping, print & export).
- **Live sheet** — an editable spreadsheet of the combined movements.

## Live sheet

Every cell is click-to-edit. `Enter` commits and moves down, `Tab`/`Shift+Tab`
move sideways, `Esc` cancels. Row tools appear on hover (⧉ duplicate, ✕ delete
with a two-step confirm), and *＋ Add movement* appends a manual row (badge
`ADD`). Invalid values are rejected inline with a reason (e.g. dates accept
`YYYY-MM-DD` or `DD/MM/YYYY`; times `0545` or `07:05`; companies are the
detected ordinals or `SCHWIDE`).

Editing a **date** shifts the end date too, so multi-day movements keep their
span (`+3d` is recalculated).

**Storage** — changes auto-save to `localStorage` under
`tcrs:v2:<month>-<year>` and are restored the next time the same month is
combined (the save pill shows the restore time). Everything stays on your
device; nothing syncs. **Reset edits** restores the freshly parsed data
(snapshot kept at parse time).

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
| `index.html`, `styles.css`, `app.js` | The site (UI, tabs, Excel export, persistence) |
| `sheet.js` | Editable live-sheet grid (no third-party grid library) |
| `parser.js` | Pure parsing/merge logic — no DOM, reusable |
| `vendor/exceljs.min.js` | Vendored ExcelJS 4.4.0 (offline, no CDN) |
| `dist/` | Deployment copy — site files only, no samples or tests |
| `samples/` | The two reference workbooks (copied from the repo root) |
| `tests/test.html` | 28 parser assertions (reference values) |
| `tests/smoke.html` | UI + live-sheet + export read-back smoke test |
| `tests/screens/` | Rendered screenshots |
| `reference_parse.py` | Python mirror of the parser; source of the expected values |

## URL hashes

`#auto` loads the bundled samples and shows the by-date schedule; `#auto-coy`
switches to the by-company view; `#auto-grid` opens the Live sheet tab.
Useful as demo bookmarks after combining.

## Tests

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless=new --allow-file-access-from-files --dump-dom \
  "file://$(pwd)/tests/test.html"        # 28 parser tests
"$CHROME" --headless=new --allow-file-access-from-files --dump-dom \
  "file://$(pwd)/tests/smoke.html"       # UI + export smoke (title: SMOKE OK / FAILED)
```

## Notes & future ideas

- Vehicle naming keeps the source casing (`5-Ton GS`); counts render as `4× BUSES` / `LUV ×1`.
- Export keeps times as **text** so leading zeros (`0545`) survive Excel.
- Sticky section headers use `backdrop-filter`; headless-screenshot captures may
  show ghost rows inside them (a known compositor artifact), real browsers render them correctly.
- Ideas: attach-number summary per day, route preset dictionary, drag-and-drop of
  both files at once, month selector when workbooks contain several sheets,
  CSV/Google-Sheets paste-in for the live sheet.
