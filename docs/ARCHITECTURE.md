# Architecture & storage contract

TCRS is a no-build vanilla frontend with a stdlib-only Python backend. There
is no bundler, no TypeScript, no Node — script load order is the module
system, and the files in `frontend/` are both the source and the deployment
artifact.

## Layers

```
frontend/index.html     shell; loads scripts in this order:
frontend/config.js      window.TCRS_API_BASE (backend origin)
frontend/vendor/…       ExcelJS (the only dependency)
frontend/parser.js      pure parsing + merge → window.TCRS      (docs/PARSER_RULES.md)
frontend/clash.js       pure clash/planner engine → window.TCRSClash
                        (TRIPS matrix, analyze(), respace(), toMin())
frontend/sheet.js       live-sheet table rendering + cell edit interactions
frontend/app.js         orchestration: state, file intake, persistence,
                        remote sync, tabs, schedule/planner/clash rendering,
                        export
backend/server.py       stdlib HTTP server: password gate, token cookie,
                        state storage, sheet proxy, origin checks
```

Pure modules (`parser.js`, `clash.js`) never touch the DOM; `app.js` is the
only writer of state. `sheet.js` renders and reports edits back.

## Storage schema

### Month key

`<school>-<MONTH>-<YEAR>`, e.g. `s4-11-2026`. Everything (localStorage keys,
server months) is keyed by it.

### localStorage keys

| Key | Holds |
|---|---|
| `tcrs:v3:<school>:<M>-<Y>` | the month's saved record (below) |
| `tcrs:files:<school>:<M>-<Y>` | the uploaded workbooks as `{icrf:{name,b64,sheet?,gs?,gsAt?}, tl:{…}}` |
| `tcrs:last:<school>:` | the month key to reopen on next visit |

(The unprefixed legacy keys `tcrs:v3:<M>-<Y>` are migrated to `s4:` on boot.)

### Saved record (`v: 3`)

```jsonc
{
  "v": 3,
  "at": 1730000000000,          // ms epoch of the save (local only)
  "updatedAt": "2026-11-07T01:23:45.678Z",
  "entries":   [ …entry objects… ],
  "tlLines":   [ …troop-lift line objects… ],
  "skipped":   [ { "row": 12, "text": "…", "why": "…" } ],
  "history":   [ { "at": "ISO", "src": "edit|plan|reset|…", "text": "…" } ],  // max 50
  "busPlan":   { "2026-11-23": { "order": ["t6","t5"], "times": {"t5":"0850"}, "auto": true } },
  "opts": { "coys": {"4TH": true}, "schwide": true, "onlyS4": false,
            "poc": false, "view": "date", "tab": "grid", "srcTab": "plan" }
}
```

- **entries** — the merged ICRF + TROOPLIFT rows *after* manual edits. Each
  has a string `id` (`i<row>` ICRF, `t<row>` TL, `m<ts>` manual), `source`,
  `date` (`YYYY-MM-DD`), `timeStart` (`HHMM` or `TBC`), `kind: 'veh'|'bus'`,
  `coys[]`, `qty` (number or `null`), and for TL rows `rawText`.
  `kind: 'bus'` means Troop-Lift only.
- **tlLines** — the Troop-lift sheet replay: `{kind:'title', text}`,
  `{kind:'date', date, text?, tbc?}` or `{kind:'line', text, status,
  date?, entryId?, id}`. `entryId` links a line to its entry; edits to the
  schedule rewrite `text` in place.
- **busPlan** — planner drafts, per day, **not applied** to entries until
  Submit. `order` is the drag order (entry ids), `times` the respaced times,
  `auto` the per-day auto-adjust toggle. Absent days = as scheduled.
- **opts** — view state, saved so a reopened month looks the same.

The parsed workbooks themselves are the truth for everything not in the
record; the record only carries what changed (plus history and drafts).

### Server side

- `GET /api/state` → `{ last: "<monthKey>", months: { "<monthKey>": {
  rev, savedAt, edits?, opts?, files? } } }` — `edits` has the same shape as
  the payload below; `files` holds the workbooks.
- `PUT /api/state/<monthKey>` body `{ baseRev, edits?, opts?, files? }` →
  `{ rev }`. `baseRev` is optimistic concurrency: a mismatch → **409**, the
  client stops saving and asks the user to reload (no overwrite, no merge).
- `edits` payload: `{ updatedAt, entries, tlLines, skipped, history, busPlan }`
  — or `null` when nothing was edited (the server then keeps/uses the parsed
  files alone). Deleting edits = PUT with `edits: null`.
- Backend storage is a directory (`/app/data` in Cloud Run, a GCS volume)
  with the doc JSON inside; auth is a shared password → signed token cookie
  (browser) or `Authorization: Bearer` (API/tests).

## Sync model (what changed / revisions / conflicts)

1. **What changed.** Any edit marks the month touched; `saveStore()` debounces
   700 ms, then `flushSave()` writes the full record to localStorage and, if
   online, `pushRemote()` PUTs the edits payload with `baseRev` = the last
   revision we saw. Files are only re-uploaded when dirty.
2. **Revisions.** The server bumps `rev` per accepted PUT; the client stores
   it in `remote.revs[key]`.
3. **Conflicts.** A 409 means another device saved newer edits. The client
   sets `remote.conflict`, stops saving entirely, and shows a reload prompt —
   it never silently overwrites or merges.
4. **Newest-wins load.** `loadStore()` picks the record (local vs remote)
   with the newer `updatedAt`; `restoreWorkspace()` reopens whichever month
   was last, preferring the copy with the workbooks available.
5. **Rollback.** "Reset edits" restores the freshly parsed model, clears
   drafts, and PUTs `edits: null` so the server forgets them too.
6. **Shape safety.** Everything read back — from either store — passes
   `validateSaved()` (below) before it reaches state; malformed pieces are
   dropped rather than trusted or fatal.

## Runtime shape validation

`validateSaved(rec)` in `app.js` is the gate for saved records from
localStorage or the server:

- the record must be a plain object;
- `entries` → keep only objects with a non-empty string `id`;
- `tlLines` → only objects with a known `kind` (`title`/`date`/`line`);
- `skipped` → objects; `history` → objects with a string `text`;
- `busPlan` → only `YYYY-MM-DD` keys whose value has a non-empty `order` of
  string ids; `times` values must be `HHMM` or `TBC`; `auto` coerced to bool.

A month with one corrupt row therefore loads with that row dropped instead of
failing wholesale, and hand-edited localStorage can never crash the app.

## Deployment

- **Frontend** — GitHub Pages serves `./frontend` on every push touching
  `frontend/**` (`.github/workflows/deploy-pages.yml`). This is the only
  canonical copy; root-level duplicates were removed on purpose.
- **Backend** — Cloud Build with `backend/Dockerfile` (`COPY . /app`,
  `TCRS_SITE_DIR=/app/frontend`, `TCRS_DATA_DIR=/app/data`) → Cloud Run
  `tcrs-backend` in `asia-southeast1`, on pushes touching `backend/**`.
- **Data** — `/app/data` is a GCS volume; the doc and uploaded workbooks
  survive deploys and restarts.
- **Tests** — `tests/*.html` headless-Chrome suites (plantest, clashtest,
  sheetsel, histtest), `tests/server_test.py` for the backend, and
  `reference_parse.py` as the Python mirror of the parse logic.
