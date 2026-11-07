# Parser rules — what parser.js does, and why

`frontend/parser.js` is pure parsing + merge logic (no DOM). It turns the two
official workbooks — **ICRF** and **TROOPLIFT** — into one model that the rest
of the app renders and edits. This document records the rules and heuristics
so a future maintainer can tell "intentional" from "bug".

---

## Source templates

### ICRF (vehicle movements)
Four header rows; data starts at the first row whose action column (A) matches
`SCH <n> - <COYS> - <ACTIVITY>`. Columns:

| A | B | C | D | E | F | G | H | I | J | K | L | M |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| activity | veh type | qty | req'd TO | start date | start time | end date | end time | reporting | destination | officer | phone | unit |

Rows above the header or with a non-matching column A are **skipped with a
reason** (`skipped[]`), never silently dropped. A 5,000-row safety cap applies.

### TROOPLIFT (bus movements)
One free-text column. Recognised row types, in order:

1. **Excel date cell** → sets the current date for following lines.
2. **Title** — `NOVEMBER TL` style (`<MONTH WORD> [year] [TL]`).
3. **Date placeholder** — `23/11` or `23/11 (*TBC*)` (`TL_TBC_DATE`); a
   `*TBC*` marker on the date row marks the whole day as TBC (`tbcDays`).
4. **Movement line** — must match `TL_LINE`:

   ```
   ^\*?\s*(\d{4}|TBC)\s+(.+?)\s+(?:(\d+)\s+)?(BUSES|BUS|TONNERS|TONNER)\s*\((.*)\)\*?\s*$
   ```
   i.e. `<HHMM|TBC> <FROM> - <TO> [<N>] BUSES|TONNERS (<TAG ACTIVITY>)`

   - time is `HHMM` or the literal `TBC`;
   - route splits at the **first** ` - `;
   - the bus count is optional (`4 BUSES` vs `BUSES`);
   - inside the parentheses the **first word** is the company tag
     (`4TH SECOND` → tag `4TH`, activity `SECOND`); tags may be slash-split
     (`1ST/2ND`);
   - leading/trailing `*` marks the line **flagged** — a human annotation,
     *not* TBC;
   - `TBC` as the time sets `tbc: true` (the 2359 late-night activation is a
     real time, not TBC);
   - anything else lands in `unmatched[]` and is shown as an unparsed line,
     never dropped.

---

## School / company mapping

Each school is a profile with its own company tag set:

| School | Mark | Companies |
|---|---|---|
| 1 | S1 | A B C D E F G |
| 2 | S2 | H J K L M N O |
| 3 | S3 | R S T U V W P |
| 4 | S4 | 1ST 2ND 3RD 4TH 5TH 6TH 7TH |

- `SCHWIDE` (school-wide vehicles) belongs to **every** school.
- The `COY`/`COY.` suffix is stripped (`4TH COY` → `4TH`).
- An ICRF row for a *different* school (`SCH 2 - ...` while in the School 4
  profile) is skipped with an explanatory reason, not merged.
- Company display order (`coyRank`): roster order first, then numeric ordinal
  tags (`3RD` → 3), then unknown tags (50), with `SCHWIDE` always last (99).

## Month detection precedence

The month is resolved lazily (via `monthRef`) because the ICRF rows need it
for the day/month swap heuristic, and ICRF is parsed after TROOPLIFT:

1. The TROOPLIFT **title row** (`NOVEMBER TL`).
2. The **majority month** across TROOPLIFT date rows.
3. The **ICRF sheet name** (`V1 NOV`).
4. The current UTC month as a last resort.

The **year** is the median year across parsed entry dates (robust against a
single typo'd year), else the current year.

## Day/month swap fix

Template locale mangling can store `23/11` as Nov 23 or as Nov 3 read as
"month 23". Rule, applied to both Date cells and `dd/mm/yy` text:

- If the parsed **month ≠ target month** but the **day == target month** and
  day ≠ month (day ≤ 12 for Date cells) → **swap day and month** and record a
  visible fix (`icrfFixes[]`, shown in the UI).
- The paired **end-date column** gets the same fix *quietly* (no fix entry) —
  it only refines `nextDay`.
- A date genuinely outside the expected month is **kept as-is** with a
  "please check" fix note.

## Date & time normalisation

- Dates arrive as Excel Date cells (read in UTC), `dd/mm/yy[yy]` strings, or
  1900-system Excel serials (offset 25569 → Unix days). Output is `YYYY-MM-DD`.
- Times (`hhmmFromTime`) accept `8:05`, `0805`, `08:05:00`, Date cells
  (including the 1899-12-31 pure-time anchor) and Excel time fractions.
  Output is `HHMM`.

## Entry shape produced

- ICRF rows → `id: 'i<row>'`, `kind: 'veh'`; end date after start date sets
  `nextDay`/`dayDiff` (end time falls back to `2359` when the movement ends on
  a later day); `qty` is `null` when not numeric.
- TROOPLIFT lines → `id: 't<row>'`, `kind: 'bus'`, plus `rawText` (the exact
  sheet line, kept so edits can rewrite it in place).
- Both carry `coys[]`, `coyLabel`, `activity`, `flagged`, `tbc`, `row`.

## Manual-edit merge rules

The parser exports the pieces the app needs to re-parse user edits instead of
guessing:

- `parseTLLineText(text, school)` — parse one Troop-lift line; used when the
  user edits TL text so edited lines get the same treatment as sheet lines.
- `parseICRFColA(text, school)` — parse/validate the `SCH n - COY - ACTIVITY`
  cell; used by the live ICRF editor and to repair skipped rows on the fly.
- `applyTLFields(entry, fields)` — merge parsed TL fields into an entry while
  **keeping the rawer fields** (`rawText`, `row`, officer/phone/unit).

App-side merge conventions:

- Manual ICRF rows get `id: 'm<timestamp>'` (`source: 'MANUAL'`); duplicates
  append a random suffix.
- The planner's Submit rewrites `entry.timeStart`, `entry.rawText` and the
  matching `tlLines` text with a targeted regex
  (`/^(\*?\s*)(\d{4}|TBC)(?=\s)/`) — deliberately *not* a re-parse, so entry
  ids stay stable.
- `filterEntries` sorts by date, time (TBC last), first company, id; the
  company filter is an enable-list over the school's roster.
