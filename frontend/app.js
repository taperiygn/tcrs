/* =====================================================================
 * TCRS — app.js : UI orchestration, live-sheet binding, styled export
 * ===================================================================== */
(function () {
  'use strict';

  var API_BASE = window.TCRS_API_BASE || '';
  var T = window.TCRS;

  /* ---------------------------------------------------------- state -- */
  var state = {
    school: 4,              // active school profile (1–4); drives rosters, keys & texts
    icrfWb: null, icrfName: '',
    tlWb: null, tlName: '',
    model: null,            // parse result (entries, fixes, skipped, unmatched)
    entries: [],            // AUTHORITATIVE editable copy (may include manual rows)
    pristine: null,         // untouched snapshot from the last parse (for "Reset edits")
    restoredAt: null,       // timestamp when localStorage edits were restored
    tlLines: [],            // Troop-lift sheet as live lines ({row,kind,date,text,status,entryId})
    skipped: [],            // ICRF rows behind the template (`s`-prefixed ids in the grid)
    tab: 'schedule',
    srcTab: 'icrf',
    view: 'date',           // schedule grouping
    coys: {},               // enabled coy set
    schwide: true,
    onlyS4: true,
    poc: true,
    touched: false,         // true once there is anything worth keeping beyond the parsed files
    files: { icrf: null, tl: null },   // {name, b64} — kept so the workspace reopens without re-uploading
    icrfGrid: null, tlGrid: null
  };

  /* Pastel palette, applied by roster order; school 4 keeps its established
     colours, letter schools cycle through the same fills. */
  var COY_FILL_CYCLE = [
    ['#86650f', '#fcf3d3'], ['#4f5f8a', '#e3e8f6'], ['#a9582f', '#fde9dd'],
    ['#ad4660', '#fbe1e7'], ['#2c7557', '#dff4ea'], ['#35698f', '#dcedfa'],
    ['#5a4fb8', '#e8e4fb'], ['#8a5470', '#f6e2ee']
  ];
  var COY_COLORS = {
    '1ST': COY_FILL_CYCLE[0], '2ND': COY_FILL_CYCLE[1], '3RD': COY_FILL_CYCLE[2],
    '4TH': COY_FILL_CYCLE[3], '5TH': COY_FILL_CYCLE[4], '6TH': COY_FILL_CYCLE[5],
    '7TH': COY_FILL_CYCLE[6],
    'SCHWIDE': ['#56606e', '#e8ebf0']
  };
  function coyStyle(c) {
    var p = COY_COLORS[c];
    if (!p) {
      var roster = T.schoolCompanies(state.school);
      var i = roster.indexOf(c);
      p = i > -1 ? COY_FILL_CYCLE[i % COY_FILL_CYCLE.length] : COY_FILL_CYCLE[0];
    }
    return { cc: p[0], cb: p[1] };
  }

  var $ = function (id) { return document.getElementById(id); };

  /* ----------------------------------------------------------- toast -- */
  var toastTimer = null;
  function toast(msg, isErr) {
    var t = $('toast');
    $('toast-msg').innerHTML = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast' + (isErr ? ' err' : ''); }, 5200);
  }

  /* --------------------------------------------------------- helpers -- */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtHHMM(t) {
    return t && t !== 'TBC' ? t.slice(0, 2) + ':' + t.slice(2, 4) : t;
  }
  function enabledCoys() {
    var out = [];
    (state.model ? state.model.companies : []).forEach(function (c) {
      if (c === 'SCHWIDE') { if (state.schwide) out.push(c); return; }
      if (state.coys[c]) out.push(c);
    });
    return out;
  }

  /* ------------------------------------------------------ persistence -- */
  /* Edits are kept in three places, newest wins on open:
       1. the server (/api/state) — survives closing the browser, shared across devices
       2. localStorage            — instant, and the fallback when the server is unreachable
     The two source workbooks are stored next to the edits, so reopening the site
     brings the whole workspace back without uploading anything again.
     Each school is a separate profile: every storage key is prefixed with the
     school, so School 4 months and School 2 months never share data. */
  function schoolPart() { return 's' + state.school; }
  function monthStr(k) { return k || (state.model ? state.model.month + '-' + state.model.year : 'current'); }
  function monthKey() { return schoolPart() + '-' + state.model.month + '-' + state.model.year; }
  function storeKey(k) { return 'tcrs:v3:' + schoolPart() + ':' + monthStr(k); }
  function filesKey(k) { return 'tcrs:files:' + schoolPart() + ':' + monthStr(k); }
  function lastKey() { return 'tcrs:last:' + schoolPart() + ':'; }

  /* one-time rename: the original keys ('tcrs:v3:11-2026', month NUMBER not name)
     belonged to School 4; rewrite them to the school-prefixed form */
  function migrateLegacyKeys() {
    var keys = [];
    try { for (var i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)); } catch (e) { return; }
    var re = /^(tcrs:v3:|tcrs:files:)((?:\d{1,2}|JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)-\d{4})$/;
    keys.forEach(function (k) {
      var m = re.exec(k);
      if (m) { lsSet(m[1] + 's4:' + m[2], lsGet(k)); lsDel(k); }
    });
    var last = lsGet('tcrs:last');
    var lastS4 = lsGet('tcrs:last:s4:');
    if (last !== null) { lsSet('tcrs:last:s4:', 's4-' + last); lsDel('tcrs:last'); }
    else if (lastS4 !== null && lastS4 !== '' && lastS4.indexOf('s4-') !== 0) {
      lsSet('tcrs:last:s4:', 's4-' + lastS4);      // repair a wrongly-shaped earlier copy
    }
  }
  migrateLegacyKeys();

  var remote = {
    online: false,          // server reachable and signed in
    doc: null,              // last /api/state response
    revs: {},               // month key → revision we last saw (optimistic concurrency)
    filesDirty: false,      // workbooks not yet sent to the server
    localFilesDirty: false, // workbooks not yet cached locally
    conflict: false         // another device saved first — stop overwriting it
  };
  var saveTimer = null, savePending = false;
  var TEST_MODE = typeof window !== 'undefined' && !!window.__TCRS_TEST_MODE;   // smoke harness: pruning off

  /* backend automation carries into the app: rows whose last day is in the
     past are dropped at parse/restore time (server archives its deletes) */
  function prunePastDates(entries) {
    var d = new Date();
    var today = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    var kept = entries.filter(function (e) {
      var end = e.eDate || e.date || '';
      return !(typeof end === 'string' && end.length === 10 && end[4] === '-' && end < today);
    });
    return { entries: kept, gone: entries.length - kept.length };
  }

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { } }

  function currentOpts() {
    return {
      coys: state.coys, schwide: state.schwide, onlyS4: state.onlyS4, poc: state.poc,
      view: state.view, tab: state.tab, srcTab: state.srcTab
    };
  }
  function applyOpts(o) {
    if (!o || typeof o !== 'object') return;
    if (o.coys && typeof o.coys === 'object') {
      Object.keys(state.coys).forEach(function (c) { if (c in o.coys) state.coys[c] = !!o.coys[c]; });
    }
    ['schwide', 'onlyS4', 'poc'].forEach(function (k) { if (typeof o[k] === 'boolean') state[k] = o[k]; });
    if (o.view === 'date' || o.view === 'coy') state.view = o.view;
    if (o.srcTab === 'icrf' || o.srcTab === 'tl') state.srcTab = o.srcTab;
    if (o.tab === 'schedule' || o.tab === 'grid') state.tab = o.tab;
  }
  function syncControls() {
    $('opt-schwide').checked = state.schwide;
    $('opt-onlys4').checked = state.onlyS4;
    $('opt-poc').checked = state.poc;
    $('opt-poc-inline').checked = state.poc;
    $('view-date').classList.toggle('on', state.view === 'date');
    $('view-coy').classList.toggle('on', state.view === 'coy');
  }

  /* -- sync pill (top bar) -- */
  var sync = { kind: '', text: '' };
  function setSync(kind, text, title) {
    sync = { kind: kind, text: text };
    var p = $('sync-pill');
    if (!state.model) { p.hidden = true; return; }
    p.hidden = false;
    p.className = 'sync-pill ' + kind;
    p.title = title || '';
    $('sync-text').textContent = text;
  }
  function clockTime(iso) {
    var d = iso ? new Date(iso) : new Date();
    if (isNaN(d)) return '';
    var t = d.toTimeString().slice(0, 5);
    return d.toDateString() === new Date().toDateString() ? t : d.toLocaleDateString() + ' ' + t;
  }
  function updateSavePill() {
    if (!state.model) { $('sync-pill').hidden = true; return; }
    if (sync.text) { setSync(sync.kind, sync.text, $('sync-pill').title); return; }
    if (remote.online) {
      setSync('ok', state.restoredAt ? 'Restored · saved ' + clockTime(state.restoredAt) : 'Auto-saves to the server');
    } else {
      setSync('local', state.restoredAt ? 'Restored · saved ' + clockTime(state.restoredAt) : 'Auto-saves on this device');
    }
  }

  /* -- base64 <-> ArrayBuffer (workbooks travel inside the JSON state) -- */
  function bufToB64(buf) {
    var bytes = new Uint8Array(buf), out = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(out);
  }
  function b64ToBuf(b64) {
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  function rememberFile(which, name, buf, extra) {
    state.files[which] = { name: name, b64: bufToB64(buf) };
    if (extra) { state.files[which].gs = extra.gs; state.files[which].gsAt = extra.gsAt; }
    remote.filesDirty = true;
    remote.localFilesDirty = true;
  }

  /* -- saving -- */
  function saveStore(optsOnly) {    // debounced — heavy JSON write happens after a pause
    if (!state.model) return;
    if (!optsOnly) state.touched = true;
    savePending = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 700);
    if (!remote.conflict) setSync('busy', 'Saving…');
  }
  function editsPayload() {         // null = nothing edited, the parsed workbooks are the truth
    if (!state.touched) return null;
    return {
      updatedAt: new Date().toISOString(),
      entries: state.entries, tlLines: state.tlLines, skipped: state.skipped
    };
  }
  function flushSave(keepalive) {
    clearTimeout(saveTimer);
    if (!savePending || !state.model) return;
    savePending = false;
    var e = editsPayload() || { updatedAt: new Date().toISOString(), entries: [], tlLines: [], skipped: [] };
    var o = currentOpts(), key = monthKey();
    var okLocal = lsSet(storeKey(), JSON.stringify({
      v: 3, at: Date.now(), updatedAt: e.updatedAt,
      entries: e.entries, tlLines: e.tlLines, skipped: e.skipped, opts: o
    }));
    if (remote.localFilesDirty && state.files.icrf && state.files.tl) {
      if (lsSet(filesKey(), JSON.stringify(state.files))) remote.localFilesDirty = false;
    }
    lsSet(lastKey(), key);
    if (remote.online) pushRemote(keepalive === true);
    else setSync('local', okLocal ? 'Saved on this device' : 'Not saved — storage unavailable');
  }

  var pushing = false, pushAgain = false;
  async function pushRemote(keepalive) {
    if (!remote.online || remote.conflict || !state.model) return;
    if (pushing) { pushAgain = true; return; }
    pushing = true;
    try {
      do {
        pushAgain = false;
        var key = monthKey();
        var body = { baseRev: remote.revs[key] || 0, edits: editsPayload(), opts: currentOpts() };
        var sendingFiles = remote.filesDirty && state.files.icrf && state.files.tl;
        if (sendingFiles) body.files = state.files;
        var json = JSON.stringify(body);
        var r = await fetch(API_BASE + '/api/state/' + encodeURIComponent(key), {
          method: 'PUT', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-TCRS': '1' },
          body: json, keepalive: !!keepalive && json.length < 60000
        });
        if (r.status === 401) { location.href = 'login'; return; }
        if (r.status === 409) {
          remote.conflict = true;
          setSync('err', 'Changed elsewhere — click to reload', 'Another device saved newer edits. Reload to load them; this tab will not overwrite them.');
          toast('Someone saved newer edits from another device. <b>Reload the page</b> to pick them up — this tab has stopped saving so nothing is overwritten.', true);
          return;
        }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var d = await r.json();
        remote.revs[key] = d.rev;
        if (sendingFiles) remote.filesDirty = false;
      } while (pushAgain);
      setSync('ok', 'Saved · ' + clockTime(), 'Stored on the server — reopen the site any time.');
    } catch (err) {
      setSync('local', 'Saved on this device — server unreachable', 'Will retry on your next edit.');
      savePending = true;                     // retry on next change / reconnect
    } finally {
      pushing = false;
    }
  }

  /* -- loading -- */
  function readLocal(key) {          // key = month key, e.g. '11-2026'
    try {
      var d = JSON.parse(lsGet('tcrs:v3:' + schoolPart() + ':' + key) || 'null');
      if (d && d.v === 3 && Array.isArray(d.entries)) { d.hasEdits = d.entries.length > 0; return d; }
    } catch (e) { }
    return null;
  }
  function readRemote(key) {
    var rec = remote.doc && remote.doc.months && remote.doc.months[key];
    if (!rec) return null;
    var ed = rec.edits, has = !!(ed && Array.isArray(ed.entries) && ed.entries.length);
    return {
      v: 3, hasEdits: has, updatedAt: (ed && ed.updatedAt) || rec.savedAt,
      entries: has ? ed.entries : [], tlLines: has ? ed.tlLines : [], skipped: has ? ed.skipped : [],
      opts: rec.opts, _remote: true
    };
  }
  function loadStore() {            // newest of server vs this device
    var key = monthKey();
    var a = readRemote(key), b = readLocal(key);
    if (a && b) return String(b.updatedAt || '') > String(a.updatedAt || '') ? b : a;
    return a || b;
  }
  function discardStore(silent) {
    if (state.model) { lsDel(storeKey()); }
    state.restoredAt = null;
    if (!silent) toast('Restored the freshly parsed data.', false);
  }

  function resetEdits() {
    if (!state.pristine) return;
    discardStore(true);
    state.entries = JSON.parse(JSON.stringify(state.pristine.entries));
    state.tlLines = JSON.parse(JSON.stringify(state.pristine.tlLines));
    state.skipped = JSON.parse(JSON.stringify(state.pristine.skipped));
    normalizeTLLines();
    changed();
    rerenderSrc(true);
    state.touched = false;
    saveStore(true);                // forgets the edits on the server too
    toast('Restored the freshly parsed data.', false);
  }

  function normalizeTLLines() {
    state.tlLines.forEach(function (l) {
      if (l.kind === 'line' && !l.id) l.id = 'l' + l.row;
    });
  }

  /* ------------------------------------------------------ file intake -- */
  async function loadWorkbook(arrayBuffer) {
    var wb = new ExcelJS.Workbook();
    await wb.xlsx.load(arrayBuffer);
    return wb;
  }

  function pickICRFSheet(wb) {
    var best = wb.worksheets[0] || null, bestN = -1;
    wb.worksheets.forEach(function (ws) {
      var n = 0;
      ws.eachRow({ includeEmpty: false }, function (row) {
        var v = row.getCell(1).value;
        if (typeof v === 'string' && /^SCH\s*\d+\s*-/i.test(v.trim())) n++;
      });
      if (n > bestN) { bestN = n; best = ws; }
    });
    return best;
  }
  function pickTLSheet(wb) {
    var best = wb.worksheets[0] || null, bestN = -1;
    wb.worksheets.forEach(function (ws) {
      var n = 0;
      ws.eachRow({ includeEmpty: false }, function (row) {
        var v = row.getCell(1).value;
        if (v instanceof Date) n++;
        else if (typeof v === 'string') {
          var t = v.trim();
          if (/^\*?\s*\d{1,2}\/\d{1,2}/.test(t) || /\d{4}\s|TBC/i.test(t)) n++;
        }
      });
      if (n > bestN) { bestN = n; best = ws; }
    });
    return best;
  }

  async function handleFile(file, which) {
    if (!file) return;
    if (!/\.xlsx?$/i.test(file.name)) { toast('<b>' + esc(file.name) + '</b> is not an .xlsx workbook.', true); return; }
    try {
      var buf = await file.arrayBuffer();
      var wb = await loadWorkbook(buf);
      rememberFile(which, file.name, buf);
      if (which === 'icrf') {
        state.icrfWb = wb; state.icrfName = file.name;
        renderUploadStatus('icrf', { ok: true, msg: 'loaded' });
      } else {
        state.tlWb = wb; state.tlName = file.name;
        renderUploadStatus('tl', { ok: true, msg: 'loaded' });
      }
      maybeCombine();
    } catch (err) {
      console.error(err);
      toast('Could not read <b>' + esc(file.name) + '</b> — make sure it is the original .xlsx workbook.', true);
      renderUploadStatus(which, { ok: false, msg: String(err && err.message || err) });
    }
  }

  function renderUploadStatus(which, info) {
    var box = $(which === 'icrf' ? 'icrf-status' : 'tl-status');
    var card = $(which === 'icrf' ? 'up-icrf' : 'up-tl');
    box.hidden = false;
    card.classList.toggle('done', !!info.ok);
    if (info.ok) {
      box.innerHTML = '<div class="line"><span>' + esc(info.msg) + '</span>' +
        '<button class="remove" data-which="' + which + '">remove</button></div>';
    } else {
      box.innerHTML = '<div class="err">⚠ ' + esc(info.msg) + '</div>';
    }
  }

  /* Removing a workbook unloads it for good (it won't reappear on reload); the edits
     stay stored, and come back if the same month is combined again. */
  function forgetFiles(key) {
    lsDel(filesKey(key));
    lsDel(lastKey());
    if (remote.online && !remote.conflict) {
      fetch(API_BASE + '/api/state/' + encodeURIComponent(key), {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-TCRS': '1' },
        body: JSON.stringify({ baseRev: remote.revs[key] || 0, files: null })
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d) remote.revs[key] = d.rev; }).catch(function () { });
    }
  }

  function clearFile(which) {
    var hadKey = state.model ? monthKey() : null;
    state.files[which] = null;
    remote.filesDirty = remote.localFilesDirty = false;
    if (hadKey) forgetFiles(hadKey);
    if (which === 'icrf') { state.icrfWb = null; state.icrfName = ''; state._gsCsv = null; $('file-icrf').value = ''; renderGsRow(); }
    else { state.tlWb = null; state.tlName = ''; $('file-tl').value = ''; }
    var box = $(which === 'icrf' ? 'icrf-status' : 'tl-status');
    var card = $(which === 'icrf' ? 'up-icrf' : 'up-tl');
    box.hidden = true; box.innerHTML = '';
    card.classList.remove('done');
    maybeCombine();
  }

  /* ------------------------------------------- google sheets ICRF source -- */
  /* A shared Google Sheet can stand in for the ICRF workbook. The site every
     15 minutes re-fetches the sheet (through the server, since the browser
     cannot read it directly) and refreshes the vehicles — user edits whose
     row still exists are kept, manual rows always survive, rows removed in
     the sheet disappear. Nothing is deleted from the sheet itself. */
  var SHEET_INTERVAL = 15 * 60 * 1000, sheetSyncing = false, sheetIo = null;

  function gsMeta() { return (state.files && state.files.icrf && state.files.icrf.gs) || null; }

  function parseCsv(text) {
    if (!text) return [];
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    var rows = [], row = [], f = '', i = 0, q = false;
    function endField() { row.push(f); f = ''; }
    function endRow() { endField(); rows.push(row); row = []; }
    while (i < text.length) {
      var c = text.charAt(i);
      if (q) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { f += '"'; i += 2; continue; }
          q = false; i++; continue;
        }
        f += c; i++; continue;
      }
      if (c === '"') { q = true; i++; continue; }
      if (c === ',') { endField(); i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { endRow(); i++; continue; }
      f += c; i++;
    }
    if (f !== '' || row.length) endRow();
    return rows;
  }

  function csvToWorkbook(rows) {
    var wb = new ExcelJS.Workbook();
    var ws = wb.addWorksheet('ICRF');
    rows.forEach(function (r) {
      if (!r.some(function (c) { return String(c || '').trim() !== ''; })) return;
      ws.addRow(r);
    });
    return wb;
  }

  /* the Google Sheet is the single most accurate source: on refresh its ICRF
     rows override everything stored earlier, including the user's older
     edits; sheet rows that no longer exist are dropped. Troop Lift rows and
     manual rows the user built in the app (which the sheet cannot contain)
     are kept, so their own work never silently disappears. */
  function mergeEntries(fresh, prev) {
    var freshBy = {};
    fresh.forEach(function (e) { if (e.source === 'ICRF') freshBy[e.id] = e; });
    var merged = [];
    prev.forEach(function (e) {
      if (e.source === 'ICRF') {
        if (freshBy[e.id]) merged.push(JSON.parse(JSON.stringify(freshBy[e.id])));   // sheet wins
        /* else: the row is gone from the sheet — it disappears */
      } else {
        merged.push(JSON.parse(JSON.stringify(e)));                                   // TL / manual rows kept
      }
    });
    prev.forEach(function (e) { if (e.source === 'ICRF') delete freshBy[e.id]; });
    fresh.forEach(function (e) {          // sheet rows added since last sync
      if (freshBy[e.id]) merged.push(JSON.parse(JSON.stringify(e)));
    });
    return merged;
  }

  function gsEscape(url) { return encodeURIComponent(String(url || '').trim()); }

  async function fetchSheet(url) {
    var r = await fetch(API_BASE + '/api/sheet?url=' + gsEscape(url),
      { credentials: 'same-origin', headers: { 'X-TCRS': '1' } });
    if (r.status === 401) { location.href = 'login'; throw new Error('login required'); }
    if (!r.ok) throw new Error((await r.json().catch(function () { return {}; })).error || 'HTTP ' + r.status);
    return r.json();
  }

  function gsStatus(msg, isErr) {
    var box = $('gs-err');
    box.hidden = !msg;
    box.textContent = msg || '';
    box.classList.toggle('err', isErr === true);
  }

  function renderGsRow() {
    var link = gsMeta();
    var row = $('gs-linked');
    row.hidden = !link;
    if (link) {
      $('gs-linked-name').textContent = state.files.icrf.name || 'Google Sheets ICRF';
      var at = state.files.icrf.gsAt && new Date(state.files.icrf.gsAt);
      $('gs-linked-info').textContent = 'auto-updates every 15 min' +
        (at ? ' · last sync ' + ('0' + at.getHours()).slice(-2) + ':' + ('0' + at.getMinutes()).slice(-2) : '');
    }
    $('gs-url').placeholder = link ? 'Replace with another Google Sheets link…' : 'Paste Google Sheets ICRF link…';
    $('gs-url').value = '';
  }

  async function linkSheet(rawUrl) {
    var url = String(rawUrl || '').trim();
    if (!url) { gsStatus('Paste a link first.', true); return; }
    if (!/^https:\/\/docs\.google\.com\/spreadsheets\/d\//.test(url)) {
      gsStatus('That is not a Google Sheets link — paste the web address of the sheet (docs.google.com/spreadsheets/…).', true);
      return;
    }
    var btn = $('btn-gs-use');
    btn.disabled = true; gsStatus('Reading the sheet…');
    try {
      var d = await fetchSheet(url);
      var wb = csvToWorkbook(parseCsv(d.csv));
      var buf = await wb.xlsx.writeBuffer();
      var name = (d.title || 'Google Sheets ICRF').slice(0, 60);
      var gs = { url: url, gid: d.gid || '0' };
      rememberFile('icrf', name, buf, { gs: gs, gsAt: new Date().toISOString() });
      state.icrfWb = wb; state.icrfName = name;
      state._gsCsv = d.csv;
      renderUploadStatus('icrf', { ok: true, msg: 'linked — ' + name });
      gsStatus('');
      renderGsRow();
      if (state.tlWb) {
        applySheetData(wb, false);
        toast('<b>' + esc(name) + '</b> linked — vehicles now flow from the Google Sheet and auto-refresh every 15 min.');
      } else {
        maybeCombine();
        gsStatus('Linked. Add the Troop Lift workbook to build the schedule — the sheet then keeps itself up to date.', false);
      }
    } catch (err) {
      console.error(err);
      gsStatus(String(err && err.message || err), true);
    } finally {
      btn.disabled = false;
    }
  }

  async function refreshSheet(manual) {
    var m = gsMeta();
    if (!m || !state.model || !state.tlWb || sheetSyncing) return;   // needs a working schedule + TL workbook
    if (document.querySelector('.sheet-input')) return;              // never move the floor under a typing user
    sheetSyncing = true;
    $('gs-err').hidden = true;
    try {
      var d = await fetchSheet(m.url);
      var fresh = parseCsv(d.csv);
      var prevCsv = state._gsCsv;
      if (prevCsv === d.csv) {
        state.files.icrf.gsAt = new Date().toISOString();
        renderGsRow();
        if (manual) toast('<b>Sheet refreshed.</b> No changes since last sync.');
        return;
      }
      var nb = csvToWorkbook(fresh);
      var buf = await nb.xlsx.writeBuffer();
      rememberFile('icrf', state.icrfName || state.files.icrf.name, buf, { gs: m, gsAt: new Date().toISOString() });
      state.icrfWb = nb;
      applySheetData(nb, manual);
      state._gsCsv = d.csv;
      renderGsRow();
    } catch (err) {
      console.error(err);
      if (manual) gsStatus('Sheet refresh failed: ' + String(err && err.message || err), true);
    } finally {
      sheetSyncing = false;
    }
  }

  /* Common core of linking and the routine refresh: the sheet's ICRF rows
     replace the stored ones outright (the sheet is the most accurate
     source) — only TL rows and manual app-made rows are carried over. */
  function applySheetData(wb, manual) {
    var prev = state.entries.slice();
    var model = null;
    try {
      model = T.parseWorkbooks(
        { worksheets: [pickICRFSheet(wb)] },
        { worksheets: [pickTLSheet(state.tlWb)] },
        state.school);
    } catch (err) {
      console.error(err);
    }
    if (!model) return;
    var merged = mergeEntries(model.entries, prev);
    if (!TEST_MODE) merged = prunePastDates(merged).entries;
    // new companies from the sheet appear as chips
    merged.forEach(function (e) {
      (e.coys || []).forEach(function (c) {
        if (c !== 'SCHWIDE' && model.companies.indexOf(c) === -1) {
          model.companies.push(c);
          if (!(c in state.coys)) state.coys[c] = true;
        }
      });
    });
    var added = 0, removed = 0, updated = 0;
    var prevIds = {}, e0 = {};
    prev.forEach(function (e) { prevIds[e.id] = e; e0[e.id] = JSON.stringify(e); });
    merged.forEach(function (e) {
      if (!(e.id in prevIds)) added++;
      else if (e0[e.id] !== JSON.stringify(e)) updated++;
    });
    Object.keys(prevIds).forEach(function (id) {
      if (!merged.some(function (e) { return e.id === id; })) removed++;
    });
    state.model = model;
    model.companies = T.sortCoys(model.companies, state.school);
    state.entries = merged;
    state.pristine.entries = JSON.parse(JSON.stringify(merged));
    state.touched = true;
    refreshDerived();
    renderChips();
    $('results').hidden = false;
    $('empty-state').hidden = true;
    $('btn-export').disabled = false;
    $('btn-print').disabled = false;
    setSrc(state.srcTab);
    setTab(state.tab);
    saveStore();
    if (manual) {
      toast('<b>Sheet refreshed.</b> ' +
        (added ? added + ' added, ' : '') + (updated ? updated + ' updated, ' : '') + (removed ? removed + ' removed, ' : '') +
        merged.length + ' rows on screen.');
    }
  }

  function unlinkSheet() {
    var f = state.files.icrf;
    if (!f) return;
    delete f.gs; delete f.gsAt;
    state._gsCsv = null;
    remote.filesDirty = true; remote.localFilesDirty = true;
    renderGsRow();
    saveStore();
    flushSave(true);
    toast('Google Sheets link removed. The workbook snapshot stays — upload new files whenever you like.');
  }

  function maybeCombine() {
    var model = null;

    if (state.icrfWb && state.tlWb) {
      try {
        var icrfSheet = pickICRFSheet(state.icrfWb);
        var tlSheet = pickTLSheet(state.tlWb);
        model = T.parseWorkbooks(
          { worksheets: [icrfSheet] },
          { worksheets: [tlSheet] },
          state.school);
      } catch (err) {
        console.error(err);
        toast('Parsing failed: ' + esc(String(err && err.message || err)), true);
        model = null;
      }
    }

    if (!model) {
      state.model = null; state.entries = []; state.restoredAt = null; state.touched = false;
      $('sync-pill').hidden = true;
      state.tlLines = []; state.skipped = [];
      $('results').hidden = true;
      $('empty-state').hidden = false;
      $('month-banner').hidden = true;
      $('btn-export').disabled = true;
      $('btn-print').disabled = true;
      setTab('schedule');
      renderChips();
      renderNotes();
      return;
    }

    state.model = model;

    /* the roster decides the chip list: every company of the school is offered
       even if the current files have no movements for it yet */
    T.schoolCompanies(state.school).forEach(function (c) {
      if (model.companies.indexOf(c) === -1) model.companies.push(c);
    });

    // company defaults
    state.coys = {};
    model.companies.forEach(function (c) { if (c !== 'SCHWIDE') state.coys[c] = true; });

    // restore saved edits for this month if present
    var saved = loadStore();
    applyOpts(saved && saved.opts);
    var hadEdits = !!(saved && saved.hasEdits);
    state.touched = hadEdits;
    if (hadEdits) {
      state.entries = saved.entries;
      state.tlLines = Array.isArray(saved.tlLines) && saved.tlLines.length
        ? saved.tlLines : JSON.parse(JSON.stringify(model.tlLines));
      state.skipped = Array.isArray(saved.skipped)
        ? saved.skipped : JSON.parse(JSON.stringify(model.icrfSkipped));
      state.restoredAt = saved.updatedAt || null;
    } else {
      state.entries = model.entries;
      state.tlLines = JSON.parse(JSON.stringify(model.tlLines));
      state.skipped = JSON.parse(JSON.stringify(model.icrfSkipped));
      state.restoredAt = null;
    }

    // companies added by manual rows in an earlier session
    state.entries.forEach(function (e) {
      (e.coys || []).forEach(function (c) {
        if (c !== 'SCHWIDE' && model.companies.indexOf(c) === -1) {
          model.companies.push(c);
          if (!(c in state.coys)) state.coys[c] = true;
        }
      });
    });
    model.companies = T.sortCoys(model.companies, state.school);

    /* keep the workspace clear of movements that already happened; pristine
       gets the pruned too so "Reset edits" matches what is on screen */
    var prunedRows = 0;
    if (!TEST_MODE) {
      var pr = prunePastDates(state.entries);
      if (pr.gone) { state.entries = pr.entries; prunedRows = pr.gone; }
    }

    // pristine snapshot ("Reset edits") — plain copy, order preserved as parsed
    state.pristine = JSON.parse(JSON.stringify({
      entries: state.entries, tlLines: model.tlLines, skipped: model.icrfSkipped
    }));

    // line ids (used by the live sheet and manual lines)
    normalizeTLLines();

    syncControls();
    renderChips();
    renderNotes();
    refreshDerived();
    $('results').hidden = false;
    $('empty-state').hidden = true;
    $('btn-export').disabled = false;
    $('btn-print').disabled = false;
    setSrc(state.srcTab);
    setTab(state.tab);
    sync = { kind: '', text: '' };
    updateSavePill();
    if (!saved || !saved._remote || remote.filesDirty || remote.localFilesDirty ||
        remote.revs[monthKey()] === undefined) saveStore(true);

    var s = statsFor(filteredEntries());
    toast('<b>Combined.</b> ' + s.movements + ' movements over ' + s.days + ' days.' +
      (prunedRows ? ' <span class="sub">' + prunedRows + ' past-dated row' + (prunedRows === 1 ? '' : 's') + ' auto-removed by sweep.</span>' : '') +
      (hadEdits ? ' Your previous edits were restored.' : ''));
  }

  /* ----------------------------------------------------- entry store -- */
  function filteredEntries() {
    return T.filterEntries({ entries: state.entries }, { companies: enabledCoys(), onlySchool4: state.onlyS4 });
  }

  function findEntry(id) {
    return state.entries.filter(function (e) { return e.id === id; })[0] || null;
  }

  var ORDINAL = /^\d+(ST|ND|RD|TH)$/i;

  function parseDateInput(raw, base) {
    var r = raw.trim();
    var m;
    if ((m = r.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { }
    else if ((m = r.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})$/))) {
      var d = +m[1], mo = +m[2], y = +m[3]; if (y < 100) y += 2000;
      return validYMD(y, mo, d);
    } else return null;
    return validYMD(+m[1], +m[2], +m[3]);
  }
  function validYMD(y, mo, d) {
    mo--; var dt = new Date(Date.UTC(y, mo, d));
    if (dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) return null;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return y + '-' + p(mo + 1) + '-' + p(d);
  }
  function dayDelta(a, b) {
    return Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000);
  }

  function normalizeTime(raw) {
    var r = raw.trim().toUpperCase();
    if (r === 'TBC') return 'TBC';
    if (r === '') return '';
    if (/^\d{4}$/.test(r)) return r;
    var m = r.match(/^(\d{1,2}):?(\d{2})$/);
    if (m) {
      var h = +m[1], mm = +m[2];
      if (h < 24 && mm < 60) return (h < 10 ? '0' : '') + h + m[2];
    }
    return null;
  }

  /* ------------------------------------------------------ helpers ----- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function dateRoll(ymdStr, delta) {
    var d = new Date(ymdStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + delta);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function registerCoy(c) {
    if (state.model && c !== 'SCHWIDE' && state.model.companies.indexOf(c) === -1) {
      state.model.companies.push(c);
      state.model.companies = T.sortCoys(state.model.companies, state.school);
      state.coys[c] = true;
      renderChips();
    }
  }
  function applyDateShift(e, nd) {   // move a movement's date, keeping its span
    var delta = dayDelta(nd, e.date || nd);
    e.date = nd;
    if (e.eDate && delta) {
      try { e.eDate = dateRoll(e.eDate, delta); } catch (err) { e.eDate = nd; }
    }
    if (!e.eDate) e.eDate = nd;
    e.dayDiff = dayDelta(e.eDate, e.date) > 0 ? dayDelta(e.eDate, e.date) : 0;
    e.nextDay = e.dayDiff > 0;
  }
  function markEdited(e) {
    e.edited = true;
    saveStore();
    changed();                       // the grid already redraws itself after a commit
  }

  /* The Schedule tab is rebuilt lazily: edits made in the Live sheet only mark
     it stale, and it is refreshed when you switch back to it. */
  function changed() {
    state.scheduleStale = true;
    if (state.tab !== 'grid') flushSchedule();
  }
  function flushSchedule() {
    if (!state.scheduleStale || !state.model) return;
    state.scheduleStale = false;
    refreshDerived();
  }

  /* ===================================================== ICRF view ==== */
  function icrfColA(e) {
    var part = e.coys[0] === 'SCHWIDE' ? 'SCHWIDE'
      : (e.coys.length ? e.coys.map(function (c) { return c + ' COY'; }).join(' / ') : '? COY');
    return 'SCH ' + state.school + ' - ' + part + ' - ' + (e.activity || '');
  }
  function numRow(r) {
    return typeof r === 'number' ? r : (typeof r === 'string' && r !== '' ? +r : 9e6);
  }

  function icrfRows() {
    var rows = [];
    state.entries.forEach(function (e) {
      if (e.source === 'ICRF' || (e.source === 'MANUAL' && e.via === 'icrf')) {
        rows.push({
          id: e.id, source: e.source, _row: numRow(e.row), edited: e.edited, flagged: e.flagged,
          colA: icrfColA(e),
          vehicleType: e.vehicleType || '',
          qty: e.qty == null ? '' : String(e.qty),
          reqTo: e.reqTo || '',
          sdate: e.date ? T.fmtDate(e.date) : '',
          stime: fmtHHMM(e.timeStart || ''),
          edate: e.eDate ? T.fmtDate(e.eDate) : '',
          etime: fmtHHMM(e.timeEnd || ''),
          from: e.from || '', to: e.to || '',
          officer: e.officer || '', phone: e.phone || '', unit: e.unit || ''
        });
      }
    });
    state.skipped.forEach(function (s, i) {
      rows.push({ id: 's' + i, source: 'SKIP', _skip: true, _row: numRow(s.row), colA: s.text, why: s.why });
    });
    rows.sort(function (a, b) { return a._row - b._row || a.id.localeCompare(b.id); });
    return rows;
  }

  function commitICRF(id, key, raw) {
    if (id.charAt(0) === 's') return commitSkip(id, key, raw);
    var e = findEntry(id);
    if (!e) return { ok: false, msg: 'row not found' };
    switch (key) {
      case 'colA': {
        var p = T.parseICRFColA(raw, state.school);
        if (!p.ok) return { ok: false, msg: 'keep "SCH ' + state.school + ' - <COY> - <ACTIVITY>" — ' + p.msg };
        e.coys = p.coys; e.coyLabel = p.coys.join(' / '); e.activity = p.activity;
        p.coys.forEach(registerCoy);
        break;
      }
      case 'vehicleType': {
        e.vehicleType = raw.trim();
        e.kind = /^(BUSES?|TONNERS?)$/i.test(raw.trim()) ? 'bus' : 'veh';
        break;
      }
      case 'qty': {
        if (raw === '') { e.qty = null; break; }
        var q = parseInt(raw, 10);
        if (isNaN(q) || q < 0 || q > 99) return { ok: false, msg: '0 – 99, or empty' };
        e.qty = q;
        break;
      }
      case 'reqTo': e.reqTo = raw.trim(); break;
      case 'sdate': {
        var nd = parseDateInput(raw);
        if (!nd) return { ok: false, msg: 'use DD/MM/YYYY (or YYYY-MM-DD)' };
        applyDateShift(e, nd);            // keeps multi-day span (+Nd)
        break;
      }
      case 'edate': {
        var ne = parseDateInput(raw);
        if (!ne) return { ok: false, msg: 'use DD/MM/YYYY (or YYYY-MM-DD), or empty' };
        e.eDate = ne;
        e.dayDiff = dayDelta(ne, e.date) > 0 ? dayDelta(ne, e.date) : 0;
        e.nextDay = e.dayDiff > 0;
        break;
      }
      case 'stime': {
        var t = normalizeTime(raw);
        if (t === null) return { ok: false, msg: 'use HH:MM (e.g. 07:45) or TBC' };
        e.timeStart = t;
        break;
      }
      case 'etime': {
        var t2 = normalizeTime(raw);
        if (t2 === null) return { ok: false, msg: 'use HH:MM (e.g. 14:00), or empty' };
        e.timeEnd = t2;
        break;
      }
      case 'from': e.from = raw.trim(); break;
      case 'to': e.to = raw.trim(); break;
      case 'officer': e.officer = raw.trim(); break;
      case 'phone': e.phone = raw.replace(/\s+/g, ''); break;
      case 'unit': e.unit = raw.trim(); break;
      default: return { ok: false, msg: 'locked column' };
    }
    markEdited(e);
    return { ok: true };
  }

  function commitSkip(id, key, raw) {
    if (key !== 'colA') return { ok: false, msg: 'this row was skipped by the parser — only the first cell is editable' };
    var idx = +id.slice(1);
    var s = state.skipped[idx];
    if (!s) return { ok: false, msg: 'row not found' };
    var p = T.parseICRFColA(raw, state.school);
    if (!p.ok) return { ok: false, msg: 'keep "SCH ' + state.school + ' - <COY> - <ACTIVITY>" — ' + p.msg };
    p.coys.forEach(registerCoy);
    state.entries.push({
      id: 'i' + s.row, source: 'ICRF',
      date: '', eDate: '', dayDiff: 0, nextDay: false,
      coys: p.coys, coyLabel: p.coys.join(' / '), activity: p.activity,
      timeStart: '', timeEnd: '', from: '', to: '',
      qty: null, vehicleType: '', kind: 'veh',
      officer: '', phone: '', unit: '', reqTo: '',
      flagged: false, tbc: false, row: s.row, edited: true
    });
    state.skipped.splice(idx, 1);
    saveStore();
    changed();
    rerenderSrc();
    toast('Row ' + s.row + ' brought back — <b>set its start date next</b> so it lands in the schedule.', false);
    return { ok: true };
  }

  function addIcrfRow() {
    var maxRow = 0;
    state.entries.forEach(function (e) { if (e.row > maxRow) maxRow = e.row; });
    var coy = enabledCoys()[0] || T.schoolCompanies(state.school)[0];
    state.entries.push({
      id: 'm' + Date.now(), source: 'MANUAL', via: 'icrf',
      date: '', eDate: '', dayDiff: 0, nextDay: false,
      coys: [coy], coyLabel: coy, activity: '',
      timeStart: '', timeEnd: '', from: '', to: '',
      qty: null, vehicleType: '', kind: 'veh',
      officer: '', phone: '', unit: '', reqTo: '',
      flagged: false, tbc: false, row: maxRow + 1, edited: true
    });
    saveStore();
    changed();
    rerenderSrc();
  }
  /* insert a blank row directly below `afterId` (hover-insert handle) */
  function insertIcrfAfter(afterId) {
    var e = findEntry(afterId);
    var idx, row, src;
    if (e) {
      idx = state.entries.indexOf(e) + 1;
      row = e.row == null ? 0 : e.row + 0.05;   // stays right below (same trick as duplicate)
      src = e;
    } else if (afterId && afterId.charAt(0) === 's') {
      var sk = state.skipped[+afterId.slice(1)];
      if (!sk) return null;
      row = numRow(sk.row) + 0.05;              // below the skipped sheet row
      idx = state.entries.length;
      src = null;
    } else return null;
    var coy = (src && src.coys && src.coys[0]) || enabledCoys()[0] || T.schoolCompanies(state.school)[0];
    var nid = 'm' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    state.entries.splice(idx, 0, {
      id: nid, source: 'MANUAL', via: 'icrf',
      date: (src && src.date) || '', eDate: (src && src.eDate) || '',
      dayDiff: (src && src.dayDiff) || 0, nextDay: !!(src && src.nextDay),
      coys: [coy], coyLabel: coy, activity: '',
      timeStart: (src && src.timeStart) || '', timeEnd: (src && src.timeEnd) || '',
      from: (src && src.from) || '', to: (src && src.to) || '',
      qty: null, vehicleType: (src && src.vehicleType) || '', kind: (src && src.kind) || 'veh',
      officer: '', phone: '', unit: '', reqTo: '',
      flagged: false, tbc: false, row: row, edited: true
    });
    saveStore();
    changed();
    return nid;
  }

  function dupIcrf(id) {
    var e = findEntry(id);
    if (!e) return;
    var copy = JSON.parse(JSON.stringify(e));
    copy.id = 'm' + Date.now() + Math.floor(Math.random() * 99);
    copy.row = e.row + 0.05;               // stays right below the original
    copy.edited = true;
    if (copy.source === 'ICRF') copy.source = 'MANUAL';
    copy.via = 'icrf';
    state.entries.push(copy);
    saveStore();
    changed();
    rerenderSrc();
  }
  function delIcrf(id) {
    if (id.charAt(0) === 's') {
      var idx = +id.slice(1);
      if (state.skipped[idx]) { state.skipped.splice(idx, 1); saveStore(); updateSavePill(); rerenderSrc(); }
      return;
    }
    var e = findEntry(id);
    if (!e) return;
    state.entries.splice(state.entries.indexOf(e), 1);
    saveStore();
    changed();
    rerenderSrc();
  }

  /* ================================================ Troop-lift view === */
  /* The TL live sheet is one big editable text block: date headings and
     one movement per line. It is only parsed when "Update" is pressed. */

  var TL_TITLE_RE = /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s*(\d{4})?\s*(TL)?\s*$/i;
  var TL_DATE_RE = /^\*?\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*(?:\(\s*\*?TBC\*?\s*\))?\*?\s*$/;

  function tlText() {
    var out = [];
    state.tlLines.forEach(function (l) {
      if (l.kind === 'title') { if ((l.text || '').trim()) out.push(l.text.trim()); return; }
      if (l.kind === 'date') {
        if ((l.text || '').trim()) { out.push(l.text.trim()); return; }
        var p = (l.date || '').split('-');
        if (p.length === 3) out.push((+p[2]) + '/' + (+p[1]) + (l.tbc ? ' (*TBC*)' : ''));
        return;
      }
      var t = (l.text || '').trim();
      if (t) out.push(t);
    });
    return out.join('\n') + (out.length ? '\n' : '');
  }

  function applyTLText(raw) {
    var model = state.model;
    if (!model) return { msg: 'nothing is loaded yet' };
    if (!(raw || '').trim()) return { msg: 'the text is empty — nothing changed' };
    var baseYear = model.year || new Date().getUTCFullYear();
    var now = Date.now(), seq = 0;

    /* old movement lines, grouped by their exact text — matching lines keep
       their entries (and any edits) instead of being re-parsed */
    var pool = {};
    state.tlLines.forEach(function (l) {
      if (l.kind !== 'line') return;
      var t = (l.text || '').trim();
      if (!t) return;
      (pool[t] = pool[t] || []).push(l);
    });

    var lines = [], cur = null;
    var added = 0, dropped = 0, bad = 0, total = 0, removalIds = [];

    raw.split('\n').forEach(function (line) {
      var t = line.trim();
      if (!t) return;

      /* title, e.g. "NOVEMBER TL" */
      if (TL_TITLE_RE.test(t)) {
        lines.push({ id: null, row: null, kind: 'title', date: null, text: t, status: '' });
        return;
      }
      /* date heading, e.g. "23/11" or "23/11 (*TBC*)" */
      var dm = TL_DATE_RE.exec(t);
      if (dm) {
        var y = dm[3] ? +dm[3] : baseYear;
        if (y < 100) y += 2000;
        cur = y + '-' + pad2(+dm[2]) + '-' + pad2(+dm[1]);
        lines.push({ id: null, row: null, kind: 'date', date: cur, text: t, status: '', tbc: /\*\s*TBC\s*\*|\*TBC\*/.test(t) });
        return;
      }

      /* movement line */
      total++;
      var lp = T.parseTLLineText(t, state.school);
      var old = pool[t] && pool[t].length ? pool[t].shift() : null;
      var nl = {
        id: old ? old.id : ('m' + now + '-' + (++seq)),
        row: old ? old.row : null, kind: 'line',
        text: t, date: cur, status: lp.ok ? 'ok' : 'unparsed', entryId: null
      };
      var e = old ? (old.entryId ? findEntry(old.entryId) : (old.row != null ? findEntry('t' + old.row) : null)) : null;

      if (e && lp.ok) {
        T.applyTLFields(e, lp.fields);
        e.rawText = t;
        if ((nl.date || '') !== (e.date || '')) {
          e.date = nl.date || ''; e.eDate = e.date;
          e.dayDiff = 0; e.nextDay = false; e.edited = true;
        }
        nl.entryId = e.id;
      } else if (lp.ok) {
        e = {
          id: 'm' + now + '-' + (++seq) + 'e', source: 'TROOPLIFT', via: 'tl',
          date: nl.date || '', eDate: nl.date || '', dayDiff: 0, nextDay: false,
          officer: '', phone: '', unit: '', row: nl.row,
          flagged: false, tbc: false, edited: true, rawText: t
        };
        T.applyTLFields(e, lp.fields);
        nl.entryId = e.id;
        state.entries.push(e);
        added++;
      } else {
        if (e) removalIds.push(e.id);       // line text replaced by an unparseable one
        bad++;
      }
      if (lp.ok) lp.fields.coys.forEach(registerCoy);
      lines.push(nl);
    });

    if (!total) return { msg: 'no movement lines recognized — nothing changed' };

    /* entries whose lines were deleted from the text (unconsumed pool) */
    Object.keys(pool).forEach(function (t) {
      pool[t].forEach(function (old) {
        var e = old.entryId ? findEntry(old.entryId)
          : (old.row != null ? findEntry('t' + old.row) : null);
        if (e) removalIds.push(e.id);
      });
    });

    /* entries whose lines no longer exist in the text */
    if (removalIds.length) {
      removalIds = removalIds.filter(function (id, i) { return removalIds.indexOf(id) === i; });
      state.entries = state.entries.filter(function (e) { return removalIds.indexOf(e.id) === -1; });
      dropped = removalIds.length;
    }

    state.tlLines = lines;
    normalizeTLLines();
    saveStore();
    changed();
    rerenderSrc();
    return {
      msg: total + (total === 1 ? ' line' : ' lines') + ' parsed · ' + (total - bad) + ' movements in the schedule' +
        (bad ? ' · ' + bad + ' unrecognized (marked, kept as text)' : '') +
        (added ? ' · ' + added + ' newly added' : '') +
        (dropped ? ' · ' + dropped + ' deleted' : '')
    };
  }

  function tlNote() {
    var days = 0, n = 0, bad = 0;
    state.tlLines.forEach(function (l) {
      if (l.kind === 'date') days++;
      if (l.kind === 'line') { n++; if (l.status === 'unparsed') bad++; }
    });
    return (state.tlName || 'Troop lift') + ' · ' + days + ' days · ' + n + ' lines' + (bad ? ' · ' + bad + ' unparsed' : '');
  }

  /* ---------------------------------------------------------- tabs -- */
  function setTab(tab) {
    state.tab = tab;
    $('btn-tab-schedule').classList.toggle('on', tab === 'schedule');
    $('btn-tab-grid').classList.toggle('on', tab === 'grid');
    $('panel-schedule').style.display = tab === 'schedule' ? '' : 'none';
    $('panel-grid').style.display = tab === 'grid' ? '' : 'none';
    document.body.classList.toggle('tab-grid', tab === 'grid');
    // blank state when nothing is parsed yet
    var blank = tab === 'grid' && !state.model;
    $('sheet-panel').classList.toggle('blank', blank);
    if (tab === 'grid' && state.model) setSrc(state.srcTab);
    if (tab === 'schedule') { flushSchedule(); flushSave(); }
  }

  function setSrc(s) {
    state.srcTab = s;
    $('sheet-panel').classList.remove('blank');
    $('btn-src-icrf').classList.toggle('on', s === 'icrf');
    $('btn-src-tl').classList.toggle('on', s === 'tl');
    $('icrf-container').style.display = s === 'icrf' ? '' : 'none';
    $('tl-container').style.display = s === 'tl' ? '' : 'none';
    $('icrf-foot').style.display = s === 'icrf' ? '' : 'none';
    $('tl-foot').style.display = s === 'tl' ? '' : 'none';
    $('grid-searchwrap').style.display = s === 'icrf' ? '' : 'none';
    if (s !== 'icrf') $('grid-search').value = '';
    mountSrc();
    applySearch();
  }

  function mountSrc() {
    if (!window.TCRSSheet || !state.model) return;
    if (state.srcTab === 'icrf' && !state.icrfGrid) {
      state.icrfGrid = TCRSSheet.mount($('icrf-container'), {
        columns: ICRF_COLS,
        getRows: icrfRows,
        commit: commitICRF,
        onAdd: addIcrfRow, onDup: dupIcrf, onDel: delIcrf,
        onInsertAfter: insertIcrfAfter,
        note: rowsNote
      });
    } else if (state.srcTab === 'icrf') {
      state.icrfGrid.rerender();
    }
    if (state.srcTab === 'tl' && !state.tlGrid) {
      state.tlGrid = TCRSSheet.mountTLText($('tl-container'), {
        getText: tlText, apply: applyTLText, note: tlNote
      });
    } else if (state.srcTab === 'tl') {
      state.tlGrid.rerender();
    }
  }

  function rerenderSrc(fresh) {      // only the visible grid; the other redraws when shown
    if (state.srcTab === 'icrf' && state.icrfGrid) state.icrfGrid.rerender();
    if (state.srcTab === 'tl' && state.tlGrid) state.tlGrid.rerender(fresh === true);
  }

  function applySearch() {
    var t = $('grid-search').value;
    if (state.icrfGrid && state.srcTab === 'icrf') state.icrfGrid.setSearch(t);
    if (state.tlGrid && state.srcTab === 'tl') state.tlGrid.setSearch(t);
  }

  function rowsNote(all, shown) {
    var skips = state.skipped.length;
    var base = shown.length + ' of ' + all.length + ' vehicle rows shown';
    if (shown.length !== all.length) base += ' — the rest hidden by your filters';
    if (skips) base += ' · ' + skips + ' skipped row' + (skips === 1 ? '' : 's') +
      ' (only the first cell can fix them into the schedule)';
    return base;
  }

  var ICRF_COLS = [
    { key: 'colA', label: 'SCH / company / activity', w: 210, flex: true, type: 'text' },
    { key: 'vehicleType', label: 'Veh type', w: 84, type: 'text' },
    { key: 'qty', label: 'Qty', w: 44, type: 'num' },
    { key: 'reqTo', label: "Req'd TO", w: 74, type: 'text' },
    { key: 'sdate', label: 'Start date', w: 82, type: 'date' },
    { key: 'stime', label: 'Start time', w: 74, type: 'time' },
    { key: 'edate', label: 'End date', w: 82, type: 'date' },
    { key: 'etime', label: 'End time', w: 74, type: 'time' },
    { key: 'from', label: 'Reporting', w: 128, type: 'text' },
    { key: 'to', label: 'Destination', w: 128, type: 'text' },
    { key: 'officer', label: 'Officer', w: 126, type: 'text' },
    { key: 'phone', label: 'Phone', w: 92, type: 'text' },
    { key: 'unit', label: 'Unit', w: 86, type: 'text' },
    { key: '_src', label: 'Row', w: 78, type: 'src' }
  ];

  /* ---------------------------------------------------------- render -- */
  function refreshDerived() {
    var list = filteredEntries();      // one filter+sort shared by every renderer
    renderStats(list);
    drawView(list);
    renderMonthBanner(list);
    if (state.tab === 'grid') rerenderSrc();
    updateSavePill();
  }

  function renderMonthBanner(list) {
    var m = state.model;
    if (!m) { $('month-banner').hidden = true; return; }
    $('month-banner').hidden = false;
    $('mb-top').textContent = m.monthName ? m.monthName.slice(0, 3) : '—';
    $('mb-mon').textContent = m.year;
    var days = {};
    (list || filteredEntries()).forEach(function (e) { if (e.date) days[e.date] = 1; });
    $('mb-day').textContent = Object.keys(days).length;
    $('mb-title').textContent = m.monthName + ' ' + m.year + ' · School ' + state.school + ' combined schedule';
    $('mb-sub').textContent = Object.keys(days).length + ' days with movements · from ' +
      (state.icrfName || '—') + ' + ' + (state.tlName || '—');
  }

  function renderChips() {
    var box = $('coy-chips');
    box.innerHTML = '';
    if (!state.model) {
      box.innerHTML = '<span class="hintline">Load both files to detect companies.</span>';
      return;
    }
    /* roster-driven: every company of the school shows as a chip, even when it
       has no movements in the current data (inactive companies stay visible) */
    var list = T.schoolCompanies(state.school).slice();
    state.model.companies.forEach(function (c) {
      if (list.indexOf(c) === -1) list.push(c);      // manual / extra tags
    });
    T.sortCoys(list, state.school).forEach(function (c) {
      var on = c === 'SCHWIDE' ? state.schwide : !!state.coys[c];
      var st = coyStyle(c);
      var b = document.createElement('span');
      b.className = 'chip' + (on ? ' on' : '');
      b.style.setProperty('--chip-c', st.cc);
      b.style.setProperty('--chip-bg', st.cb);
      b.textContent = c === 'SCHWIDE' ? 'SCHWIDE' : c + ' Coy';
      b.dataset.coy = c;
      b.addEventListener('click', function () {
        if (b.classList.contains('on')) {
          b.classList.remove('on');
        } else {
          b.classList.add('on');
        }
        if (c === 'SCHWIDE') state.schwide = b.classList.contains('on');
        else state.coys[c] = b.classList.contains('on');
        refreshDerived();
        saveStore(true);
      });
      box.appendChild(b);
    });
  }

  function renderNotes() {
    var m = state.model;
    function fill(id, countId, items, html) {
      $(countId).textContent = items.length;
      $(countId).classList.toggle('zero', items.length === 0);
      $(id).innerHTML = items.length ? items.map(html).join('') : '<div class="empty">none — all good</div>';
    }
    var fx = m ? m.icrfFixes : [];
    var sk = m ? m.icrfSkipped : [];
    var um = m ? m.tlUnmatched : [];
    fill('fix-list', 'fix-count', fx, function (f) {
      return '<div class="fx"><span class="where">' + esc(f.label) + '</span><span>' + esc(f.from) +
        '</span><span class="arrow">→</span><span><b>' + esc(f.to) + '</b></span></div>';
    });
    fill('skip-list', 'skip-count', sk, function (s) {
      return '<div class="rowmsg"><span class="r">' + esc(s.why) + '</span><span>“' + esc(s.text) + '”</span></div>';
    });
    fill('unmatch-list', 'unmatch-count', um, function (u) {
      return '<div class="rowmsg"><span class="r">line ' + u.row + '</span><span>“' + esc(u.text) + '”</span></div>';
    });
  }

  /* ------------------------------------------------------- schedule UI -- */
  function statsFor(entries) {
    var s = { movements: entries.length, buses: 0, veh: 0, days: new Set(), flags: 0, coys: new Set(), tbc: 0 };
    entries.forEach(function (e) {
      if (e.date) s.days.add(e.date);
      if (e.coys) e.coys.forEach(function (c) { s.coys.add(c); });
      if (e.kind === 'bus') s.buses += (e.qty || 0);
      else s.veh += (e.qty || 0);
      if (e.flagged) s.flags++;
      if (e.timeStart === 'TBC') s.tbc++;
    });
    return { movements: s.movements, buses: s.buses, veh: s.veh, groups: s.coys.size, days: s.days.size, flags: s.flags, tbc: s.tbc };
  }

  function renderStats(list) {
    var s = statsFor(list || filteredEntries());
    var warn = s.flags + s.tbc;
    $('statsbar').innerHTML =
      stat(s.movements, 'Movements', '') +
      stat(s.buses, 'Buses needed', 'bus') +
      stat(s.veh, 'Own vehicles', 'veh') +
      stat(s.groups, 'Companies', '') +
      stat(s.days, 'Days covered', '') +
      stat(warn, 'Flagged / TBC', warn > 0 ? 'warn' : '');
    function stat(v, k, cls) {
      return '<div class="stat ' + cls + '"><div class="v">' + v + '</div><div class="k">' + k + '</div></div>';
    }
  }

  function coyChipsHTML(coys) {
    return coys.map(function (c) {
      var st = coyStyle(c);
      return '<span class="coychip" style="--c-c:' + st.cc + ';--c-bg:' + st.cb + '">' + esc(c) + '</span>';
    }).join('');
  }

  function routeHTML(e) {
    var from = esc(e.from || '—');
    var to = e.to ? esc(e.to) : '<span class="ghostnote">same point</span>';
    return '<span class="org">' + from + '</span><span class="arr">→</span><span class="loc">' + to + '</span>';
  }

  function vehHTML(e) {
    var cls = 'veh ' + (e.kind === 'bus' ? 'bus' : 'vehk');
    return '<span class="' + cls + '">' + esc(T.vehicleLabel(e)) + '</span>';
  }

  function pocHTML(e) {
    if (!state.poc) return '<span class="ghostnote">hidden</span>';
    var t = esc(e.officer || '—');
    var tel = e.phone ? '<span class="tel">' + esc(e.phone) + '</span>' : '';
    return t + tel;
  }

  function srcHTML(e) {
    var cls = e.source === 'ICRF' ? 'icrf' : e.source === 'MANUAL' ? 'manual' : 'tl';
    var label = e.source === 'MANUAL' ? 'ADD' : e.source;
    return '<span class="srcbadge ' + cls + '">' + label + '</span>' +
      (e.flagged ? '<span class="flagstar" title="Flagged in the source sheet">*</span>' : '');
  }

  function rowCells(e, view, poc) {
    if (view === 'date') {
      return '<td class="t">' + timeCellContent(e) + '</td>' +
        '<td>' + coyChipsHTML(e.coys) + '</td>' +
        '<td class="act">' + esc(e.activity) + '</td>' +
        '<td class="route">' + routeHTML(e) + '</td>' +
        '<td>' + vehHTML(e) + '</td>' +
        (poc ? '<td class="poc">' + pocHTML(e) + '</td>' : '') +
        '<td>' + srcHTML(e) + '</td>';
    }
    return '<td class="datecell">' + esc(T.fmtDate(e.date)) + '<span class="dow">' + esc(T.dowOf(e.date)) + '</span></td>' +
      '<td class="t">' + timeCellContent(e) + '</td>' +
      '<td class="act">' + esc(e.activity) + '</td>' +
      '<td class="route">' + routeHTML(e) + '</td>' +
      '<td>' + vehHTML(e) + '</td>' +
      (poc ? '<td class="poc">' + pocHTML(e) + '</td>' : '') +
      '<td>' + srcHTML(e) + '</td>';
  }

  function timeCellContent(e) {
    if (e.timeStart === 'TBC') return '<span class="tbctag">TBC</span>';
    if (!e.timeStart) return '<span class="ghostnote">—</span>';
    var s = fmtHHMM(e.timeStart);
    var h = '';
    if (e.timeEnd && e.timeEnd !== e.timeStart) {
      h = '–' + fmtHHMM(e.timeEnd);
      if (e.dayDiff > 1) h += ' <span class="plusday">+' + e.dayDiff + 'd</span>';
    }
    return s + (h ? '&nbsp;' + h : '');
  }

  function tableHead(view, poc) {
    var cols = view === 'date'
      ? ['Time', 'Coy', 'Activity', 'Run', 'Vehicles']
      : ['Date', 'Time', 'Activity', 'Run', 'Vehicles'];
    if (poc) cols.push('POC / Contact');
    cols.push('Src');
    return '<thead><tr>' + cols.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr></thead>';
  }

  function drawView(list) {
    var entries = list || filteredEntries();
    var view = state.view;
    var poc = state.poc;
    var c = $('content');
    c.innerHTML = '';

    $('view-note').innerHTML = view === 'date'
      ? '<b>' + entries.length + '</b> movements · grouped by date — export/print breaks pages per day'
      : '<b>' + entries.length + '</b> movements · grouped by company — cross-coy movements appear under each company';

    if (view === 'date') {
      var byDate = {};
      entries.forEach(function (e) {
        (byDate[e.date || '?'] = byDate[e.date || '?'] || []).push(e);
      });
      Object.keys(byDate).sort().forEach(function (d) {
        var list = byDate[d], buses = 0, veh = 0, flags = 0, tbc = null;
        list.forEach(function (e) {
          if (e.kind === 'bus') buses += (e.qty || 0); else veh += (e.qty || 0);
          if (e.flagged) flags++;
          if (e.timeStart === 'TBC') tbc = e;
        });
        var sec = document.createElement('section');
        sec.className = 'group';
        sec.innerHTML =
          '<div class="chead"><div class="dateline"><span class="dow">' + esc(T.dowOf(d)) + '</span>' +
          '<span class="dbig">' + esc(d.slice(8)) + '</span><span class="dsub">' +
          esc(monthShort(d)) + ' ' + esc(state.model.year) + '</span></div>' +
          '<span class="cbadge">' + list.length + ' movements</span>' +
          (buses ? '<span class="cbadge bus">' + buses + ' buses</span>' : '') +
          (veh ? '<span class="cbadge veh">' + veh + ' own veh</span>' : '') +
          (tbc ? '<span class="cbadge sens">timing TBC</span>' : '') +
          '</div>' +
          '<table class="mov">' + tableHead('date', poc) + '<tbody>' +
          list.map(function (e) { return '<tr>' + rowCells(e, 'date', poc) + '</tr>'; }).join('') +
          '</tbody></table>';
        c.appendChild(sec);
      });
    } else {
      var any = false;
      enabledCoys().forEach(function (coy) {
        var list = entries.filter(function (e) { return e.coys.indexOf(coy) > -1; });
        if (!list.length) return;
        any = true;
        var buses = 0, veh = 0;
        list.forEach(function (e) {
          if (e.kind === 'bus') buses += (e.qty || 0); else veh += (e.qty || 0);
        });
        var st = coyStyle(coy);
        var sec = document.createElement('section');
        sec.className = 'group';
        sec.innerHTML =
          '<div class="chead"><div class="dateline">' +
          '<span class="coychip" style="--c-c:' + st.cc + ';--c-bg:' + st.cb + ';font-size:13px;padding:4px 12px">' + esc(coy) + '</span>' +
          '<span class="dsub">' + (coy === 'SCHWIDE' ? 'School-wide movements' : esc(coy) + ' Coy') + '</span></div>' +
          '<span class="cbadge">' + list.length + ' movements</span>' +
          (buses ? '<span class="cbadge bus">' + buses + ' bus pax-slots</span>' : '') +
          (veh ? '<span class="cbadge veh">' + veh + ' own veh</span>' : '') +
          '</div>' +
          '<table class="mov">' + tableHead('coy', poc) + '<tbody>' +
          list.map(function (e) { return '<tr>' + rowCells(e, 'coy', poc) + '</tr>'; }).join('') +
          '</tbody></table>';
        c.appendChild(sec);
      });
      if (!any) {
        c.innerHTML = '<div class="empty"><h2 style="margin:0;color:var(--ink)">No movements match the current filters</h2>' +
          '<p class="hintline">Try enabling more companies, or turning “Keep only School ' + state.school + ' movements” off.</p></div>';
      }
    }
  }

  var MON_SHORTS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  function monthShort(d) {
    return MON_SHORTS[(+d.slice(5, 7)) - 1] || '·';
  }

  function refresh() {
    renderChips();
    refreshDerived();
    renderNotes();
  }

  /* ---------------------------------------------------------- export -- */
  async function exportXlsx() {
    if (!state.model) return;
    var entries = filteredEntries();
    var poc = state.poc;
    var m = state.model;
    var wb = new ExcelJS.Workbook();
    wb.creator = 'TCRS School ' + state.school + ' Combined Movement Builder';
    wb.created = new Date();

    var NAVY = 'FF16324A', NAVYPAT = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    var STEEL = 'FFDCE5EE', STEELPAT = { type: 'pattern', pattern: 'solid', fgColor: { argb: STEEL } };
    var DAYS = 'FFF1F5F8', DAYSPAT = { type: 'pattern', pattern: 'solid', fgColor: { argb: DAYS } };
    var HAIR = 'FFD8DDE4', SOFT = 'FFF3F1EC';

    function titleRows(ws, main, sub, ncols) {
      var t = ws.addRow([main]);
      ws.mergeCells(1, 1, 1, ncols);
      t.height = 30;
      t.getCell(1).font = { size: 15, bold: true, color: { argb: 'FFFFFFFF' }, name: 'Calibri' };
      t.getCell(1).fill = NAVYPAT;
      t.getCell(1).alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      for (var i = 1; i <= ncols; i++) t.getCell(i).fill = NAVYPAT;
      var s = ws.addRow([sub]);
      ws.mergeCells(2, 1, 2, ncols);
      s.height = 18;
      s.getCell(1).font = { size: 9, italic: true, color: { argb: 'FF5B6A75' } };
      s.getCell(1).alignment = { vertical: 'middle', indent: 1 };
      for (var j = 1; j <= ncols; j++) s.getCell(j).fill = NAVYPAT;
      ws.addRow([]);
      ws.getRow(3).height = 6;
    }
    function headerRow(ws, colNames) {
      var hr = ws.addRow(colNames);
      hr.eachCell(function (cell) {
        cell.font = { bold: true, size: 10, color: { argb: 'FF16324A' } };
        cell.fill = STEELPAT;
        cell.border = { bottom: { style: 'thin', color: { argb: HAIR } } };
        cell.alignment = { vertical: 'middle' };
      });
      hr.height = 18;
    }
    function bannerRow(ws, text, ncols) {
      var r = ws.addRow([text]);
      ws.mergeCells(r.number, 1, r.number, ncols);
      r.height = 19;
      r.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF0F2436' } };
      r.getCell(1).alignment = { vertical: 'middle', indent: 1 };
      for (var i = 1; i <= ncols; i++) {
        r.getCell(i).fill = DAYSPAT;
        r.getCell(i).border = { top: { style: 'thin', color: { argb: HAIR } }, bottom: { style: 'thin', color: { argb: HAIR } } };
      }
      return r;
    }
    function dataRow(ws, cells, zebra) {
      var r = ws.addRow(cells);
      r.height = 17;
      r.eachCell(function (cell, colNumber) {
        cell.font = { size: 10, color: { argb: 'FF1C2833' } };
        cell.border = { bottom: { style: 'hair', color: { argb: SOFT } } };
        if (zebra) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFAF8' } };
        if (cells[colNumber - 1] && /^\d{4}(-\d{4})?$/.test(String(cells[colNumber - 1]).slice(0, 9))) {
          cell.numFmt = '@';
        }
      });
      return r;
    }

    var genNote = 'Assembled from ICRF (School ' + state.school + ' vehicles) + Troop Lift (buses/tonners) · generated ' +
      new Date().toISOString().slice(0, 16).replace('T', ' ') +
      (state.onlyS4 ? ' · School ' + state.school + ' movements only' : ' · ALL movements (incl. other units)') +
      (state.schwide ? ' · SCHWIDE included' : '') +
      (state.entries.some(function (e) { return e.edited || e.source === 'MANUAL'; })
        ? ' · some rows manually adjusted — see the Data notes sheet' : '');

    function remarksOf(e) {
      var rem = [];
      if (e.flagged) rem.push('flagged *');
      if (e.timeStart === 'TBC') rem.push('timing TBC');
      if (e.dayDiff > 1) rem.push('runs ' + e.dayDiff + ' days');
      return rem.join(' · ');
    }

    function pageSetup(orientation) {
      // Excel validates page readiness strictly: pageMargins must carry
      // header/footer and the DPI values must be real numbers, or the file
      // opens in repair mode ("unsupported elements / fixed the sheet").
      return {
        orientation: orientation, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        horizontalDpi: 300, verticalDpi: 300,
        margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 }
      };
    }

    /* sheet 1: By Date */
    {
      var ws = wb.addWorksheet('By Date', { pageSetup: pageSetup('landscape') });
      var cols = ['TIME', 'COY', 'ACTIVITY', 'FROM', 'TO', 'VEHICLES'];
      if (poc) cols.push('POC / CONTACT');
      cols.push('REMARKS');
      ws.columns = [10, 11, 34, 18, 18, 16].concat(poc ? [26] : []).concat([12])
        .map(function (w) { return { width: w }; });
      titleRows(ws, 'SCHOOL 4 — COMBINED VEHICLE MOVEMENTS — BY DATE — ' + m.monthName + ' ' + m.year,
        genNote, cols.length);
      headerRow(ws, cols);

      var byDate = {};
      entries.forEach(function (e) { (byDate[e.date || '?'] = byDate[e.date || '?'] || []).push(e); });
      Object.keys(byDate).sort().forEach(function (d) {
        var list = byDate[d];
        var buses = 0, veh = 0;
        list.forEach(function (e) { if (e.kind === 'bus') buses += (e.qty || 0); else veh += (e.qty || 0); });
        bannerRow(ws, T.dowOf(d) + '  ·  ' + T.fmtDate(d).slice(0, 5) + '/' + String(m.year).slice(2) + '  ·  ' +
          list.length + ' movements' + (buses ? '  ·  ' + buses + ' buses' : '') +
          (veh ? '  ·  ' + veh + ' own vehicles' : ''), cols.length);
        list.forEach(function (e, i) {
          var cells = [T.timeLabel(e), e.coys.join(' / '), e.activity, e.from || '—', e.to || '—', T.vehicleLabel(e)];
          if (poc) cells.push(e.officer ? e.officer + (e.phone ? ' (' + e.phone + ')' : '') : '—');
          cells.push(remarksOf(e));
          dataRow(ws, cells, i % 2 === 1);
        });
      });
      ws.views = [{ state: 'frozen', ySplit: 4 }];
    }

    /* sheet 2: By Company */
    {
      var ws2 = wb.addWorksheet('By Company', { pageSetup: pageSetup('landscape') });
      var cols2 = ['DATE', 'DAY', 'TIME', 'ACTIVITY', 'FROM', 'TO', 'VEHICLES'];
      if (poc) cols2.push('POC / CONTACT');
      cols2.push('REMARKS');
      ws2.columns = [11, 6, 10, 34, 18, 18, 16].concat(poc ? [26] : []).concat([12])
        .map(function (w) { return { width: w }; });
      titleRows(ws2, 'SCHOOL 4 — COMBINED VEHICLE MOVEMENTS — BY COMPANY — ' + m.monthName + ' ' + m.year,
        genNote, cols2.length);
      headerRow(ws2, cols2);

      enabledCoys().forEach(function (coy) {
        var list = entries.filter(function (e) { return e.coys.indexOf(coy) > -1; });
        if (!list.length) return;
        var buses = 0, veh = 0;
        list.forEach(function (e) { if (e.kind === 'bus') buses += (e.qty || 0); else veh += (e.qty || 0); });
        bannerRow(ws2, coy + (coy === 'SCHWIDE' ? '  ·  school-wide' : ' Coy') + '  ·  ' +
          list.length + ' movements' + (buses ? '  ·  ' + buses + ' buses' : '') +
          (veh ? '  ·  ' + veh + ' own vehicles' : ''), cols2.length);
        list.forEach(function (e, i) {
          var cells = [T.fmtDate(e.date), T.dowOf(e.date), T.timeLabel(e), e.activity, e.from || '—', e.to || '—', T.vehicleLabel(e)];
          if (poc) cells.push(e.officer ? e.officer + (e.phone ? ' (' + e.phone + ')' : '') : '—');
          cells.push(remarksOf(e));
          dataRow(ws2, cells, i % 2 === 1);
        });
      });
      ws2.views = [{ state: 'frozen', ySplit: 4 }];
    }

    /* sheet 3: data notes */
    {
      var ws3 = wb.addWorksheet('Data notes', { pageSetup: pageSetup('portrait') });
      ws3.columns = [{ width: 18 }, { width: 30 }, { width: 46 }, { width: 46 }];
      titleRows(ws3, 'DATA NOTES — SANITY CHECKS', 'Fixes and skipped rows found while parsing. Review before distributing.', 4);
      headerRow(ws3, ['AREA', 'WHERE', 'BEFORE', 'DETECTED']);
      m.icrfFixes.forEach(function (f) {
        dataRow(ws3, ['date fix', f.label, String(f.from), String(f.to)], true);
      });
      m.icrfSkipped.forEach(function (s) {
        dataRow(ws3, ['skipped row', 'ICRF row ' + s.row, s.text, s.why], true);
      });
      m.tlUnmatched.forEach(function (u) {
        dataRow(ws3, ['unparsed TL line', 'troop lift line ' + u.row, u.text, '—'], true);
      });
      ws3.views = [{ state: 'frozen', ySplit: 4 }];
    }

    /* open the workbook on the sheet that matches the grouping on screen */
    var activeSheet = state.view === 'coy' ? 1 : 0;
    wb.views = [{ activeTab: activeSheet, firstSheet: activeSheet }];

    var buf = await wb.xlsx.writeBuffer();
    var blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'SCH' + state.school + '_' + m.monthName + '_' + m.year + '_Combined.xlsx';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
    toast('Exported <b>' + esc(a.download) + '</b> — reflects your current entries' + (entries.some(function (e) { return e.source === 'MANUAL' || e.edited; }) ? ' incl. manual changes' : '') + '.');
  }

  /* ----------------------------------------------------------- wire -- */
  function init() {
    $('file-icrf').addEventListener('change', function (e) { handleFile(e.target.files[0], 'icrf'); });
    $('file-tl').addEventListener('change', function (e) { handleFile(e.target.files[0], 'tl'); });
    ['icrf', 'tl'].forEach(function (which) {
      var zone = document.querySelector('#up-' + which + ' .upzone');
      zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('drag'); });
      zone.addEventListener('dragleave', function () { zone.classList.remove('drag'); });
      zone.addEventListener('drop', function (e) {
        e.preventDefault(); zone.classList.remove('drag');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0], which);
      });
    });
    document.addEventListener('click', function (e) {
      if (e.target.classList && e.target.classList.contains('remove')) {
        clearFile(e.target.getAttribute('data-which'));
      }
    });

    // Google Sheets ICRF source
    if (!TEST_MODE) {
      $('btn-gs-use').addEventListener('click', function () { linkSheet($('gs-url').value); });
      $('gs-url').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); linkSheet($('gs-url').value); }
      });
      $('btn-gs-now').addEventListener('click', function () { refreshSheet(true); });
      $('btn-gs-unlink').addEventListener('click', function () { unlinkSheet(); });
      setInterval(function () {
        if (document.visibilityState === 'visible' && remote.online) refreshSheet(false);
      }, SHEET_INTERVAL);
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) { flushSave(true); if (remote.online) refreshSheet(false); }
      });
      window.addEventListener('online', function () { if (state.model) refreshSheet(false); });
    }

    // tabs
    $('btn-tab-schedule').addEventListener('click', function () { setTab('schedule'); saveStore(true); });
    $('btn-tab-grid').addEventListener('click', function () { setTab('grid'); saveStore(true); });

    // live-sheet sub-tabs
    $('btn-src-icrf').addEventListener('click', function () { setSrc('icrf'); saveStore(true); });
    $('btn-src-tl').addEventListener('click', function () { setSrc('tl'); saveStore(true); });

    // schedule view
    $('view-date').addEventListener('click', function () { state.view = 'date'; syncControls(); refreshDerived(); saveStore(true); });
    $('view-coy').addEventListener('click', function () { state.view = 'coy'; syncControls(); refreshDerived(); saveStore(true); });

    $('opt-schwide').addEventListener('change', function (e) { state.schwide = e.target.checked; refresh(); saveStore(true); });
    $('opt-onlys4').addEventListener('change', function (e) { state.onlyS4 = e.target.checked; refresh(); saveStore(true); });
    $('opt-poc').addEventListener('change', function (e) {
      state.poc = e.target.checked;
      $('opt-poc-inline').checked = e.target.checked;
      refreshDerived();
      saveStore(true);
    });
    $('opt-poc-inline').addEventListener('change', function (e) {
      state.poc = e.target.checked;
      $('opt-poc').checked = e.target.checked;
      refreshDerived();
      saveStore(true);
    });

    $('rail-toggle').addEventListener('click', function () {
      var collapsed = document.body.classList.toggle('rail-collapsed');
      this.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      this.textContent = collapsed ? '›' : '‹';
      this.title = collapsed ? 'Show the side panel' : 'Hide the side panel';
      lsSet('tcrs:rail', collapsed ? 'collapsed' : 'open');
    });

    $('grid-search').addEventListener('input', function (e) { applySearch(); });
    var discardArm = null;
    $('grid-discard').addEventListener('click', function () {
      if (!state.model) return;
      var btn = this;
      if (discardArm) {
        clearTimeout(discardArm); discardArm = null;
        btn.classList.remove('armed'); btn.textContent = 'Reset edits';
        resetEdits();
        $('grid-search').value = '';
        applySearch();
      } else {
        btn.classList.add('armed');
        btn.textContent = 'Confirm reset?';
        discardArm = setTimeout(function () {
          btn.classList.remove('armed');
          btn.textContent = 'Reset edits';
          discardArm = null;
        }, 3000);
      }
    });

    $('btn-export').addEventListener('click', exportXlsx);
    $('btn-print').addEventListener('click', function () { flushSchedule(); window.print(); });
    window.addEventListener('beforeunload', function () { flushSave(true); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) flushSave(true); });
    window.addEventListener('online', function () { if (state.model) { savePending = true; flushSave(); } });
    $('sync-pill').addEventListener('click', function () { if (remote.conflict) location.reload(); });
    $('btn-logout').addEventListener('click', async function () {
      flushSave();
      try { await fetch(API_BASE + '/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-TCRS': '1' } }); } catch (e) { }
      location.href = 'login';
    });

    document.querySelectorAll('.acc-head').forEach(function (h) {
      h.addEventListener('click', function () { h.parentElement.classList.toggle('open'); });
    });
  }

  (function () {
    var saved = parseInt(lsGet('tcrs:school'), 10);
    if (saved >= 1 && saved <= 4 && !/^#auto/.test(location.hash)) state.school = saved;
  })();
  init();
  initSchoolMenu();
  applySchoolTexts();
  setTab(state.tab);   // sync visibility with the (possibly hash-set) tab
  syncControls();

  /* ------------------------------------------------- school profiles -- */
  function schoolDef(n) {
    return T.SCHOOLS.filter(function (x) { return x.n === n; })[0] || T.SCHOOLS[3];
  }
  function setText(sel, txt) {
    document.querySelectorAll(sel).forEach(function (el) { el.textContent = txt; });
  }
  function applySchoolTexts() {
    var n = state.school, def = schoolDef(n);
    setText('.sn', n);
    setText('.smark', def.mark);
    setText('.scoy', def.companies[def.companies.length > 5 ? 5 : 0]);
    document.title = 'TCRS · School ' + n + ' Combined Movement Builder';
    var fav = document.querySelector('link[rel="icon"]');
    if (fav) {
      fav.href = "data:image/svg+xml," + encodeURIComponent(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>" +
        "<stop offset='0' stop-color='#c9c1f5'/><stop offset='1' stop-color='#a9d8ec'/></linearGradient></defs>" +
        "<rect width='64' height='64' rx='16' fill='url(#g)'/><text x='32' y='43' font-family='Helvetica' font-size='25' " +
        "font-weight='bold' fill='#2b2560' text-anchor='middle'>" + def.mark + "</text></svg>");
    }
    var menu = $('school-menu');
    if (menu) [].forEach.call(menu.children, function (b) { b.classList.toggle('on', +b.dataset.school === n); });
  }

  /* Each school is its own workspace: park this one (saved under its keys),
     blank the screen, then reopen whatever the new school had open. */
  async function setSchool(n) {
    n = +n;
    if (n === state.school || !T.SCHOOLS.some(function (x) { return x.n === n; })) return;
    flushSave();
    clearTimeout(saveTimer);
    savePending = false;
    state.school = n;
    lsSet('tcrs:school', String(n));

    state.icrfWb = null; state.tlWb = null; state.icrfName = ''; state.tlName = '';
    state.files = { icrf: null, tl: null };
    state.icrfGrid = null; state.tlGrid = null;
    state.restoredAt = null; state.touched = false; state.scheduleStale = false;
    remote.filesDirty = remote.localFilesDirty = false;
    state.coys = {}; state.schwide = true; state.onlyS4 = true; state.poc = true;
    ['icrf', 'tl'].forEach(function (which) {
      $('file-' + which).value = '';
      var box = $(which + '-status');
      box.hidden = true; box.innerHTML = '';
      $('up-' + which).classList.remove('done');
    });
    applySchoolTexts();
    maybeCombine();               // no files → clears the results and shows the empty state
    syncControls();
    await restoreWorkspace();
  }

  function initSchoolMenu() {
    var btn = $('school-btn'), menu = $('school-menu');
    menu.innerHTML = T.SCHOOLS.map(function (x) {
      return '<button type="button" role="menuitem" data-school="' + x.n + '"><span class="sm-mark">' + x.mark +
        '</span><span>School ' + x.n + '<span class="sm-sub">' + x.companies.join(' · ') + '</span></span></button>';
    }).join('');
    function close() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    menu.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-school]');
      if (!b) return;
      close();
      setSchool(+b.dataset.school);
    });
    document.addEventListener('click', close);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }

  /* Reopen the workspace: ask the server (or, failing that, this device) what was open last. */
  async function bootRestore() {
    var auto = /^#auto/.test(location.hash);
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      try {
        var r = await fetch(API_BASE + '/api/state', { credentials: 'same-origin', headers: { 'X-TCRS': '1' } });
        if (r.status === 401) { location.href = 'login'; return; }
        if (r.ok) {
          remote.doc = await r.json();
          remote.online = true;
          Object.keys(remote.doc.months || {}).forEach(function (k) { remote.revs[k] = remote.doc.months[k].rev || 0; });
          $('btn-logout').hidden = false;
        }
      } catch (e) { /* no server (static hosting / offline) — fall back to this device */ }
    }
    if (auto || state.model) return;
    await restoreWorkspace();
  }

  /* reopen whatever this school's profile had open last */
  async function restoreWorkspace() {
    var rl = null, ll = null, sp = 's' + state.school + '-';
    if (remote.doc && remote.doc.last) {
      // only months that belong to this school's profile
      if (remote.doc.last.indexOf(sp) === 0) rl = remote.doc.last;
      else Object.keys(remote.doc.months || {}).forEach(function (k) {
        if (rl === null && k.indexOf(sp) === 0) rl = k;
      });
    }
    ll = lsGet(lastKey());
    if (ll && ll.indexOf(sp) !== 0) ll = null;
    var rRec = rl && remote.doc.months[rl], lRec = ll && readLocal(ll);
    var ru = rRec ? ((rRec.edits && rRec.edits.updatedAt) || rRec.savedAt || '') : '';
    var key = (ll && lRec && String(lRec.updatedAt || '') > ru) ? ll : (rl || ll);
    if (!key) return;

    var files = rRec && key === rl && rRec.files, fromLocal = false;
    if (!files || !files.icrf || !files.tl) {
      try { files = JSON.parse(lsGet(filesKey(key)) || 'null'); fromLocal = true; } catch (e) { files = null; }
    }
    if (!files || !files.icrf || !files.tl) return;
    try {
      state.icrfWb = await loadWorkbook(b64ToBuf(files.icrf.b64)); state.icrfName = files.icrf.name;
      state.tlWb = await loadWorkbook(b64ToBuf(files.tl.b64)); state.tlName = files.tl.name;
      state.files = { icrf: files.icrf, tl: files.tl };
      remote.filesDirty = fromLocal && remote.online;
      remote.localFilesDirty = false;
      if (!fromLocal) lsSet(filesKey(key), JSON.stringify(state.files));
      renderUploadStatus('icrf', { ok: true, msg: 'restored — ' + state.icrfWb.worksheets[0].name });
      renderUploadStatus('tl', { ok: true, msg: 'restored — ' + state.tlWb.worksheets[0].name });
      state._gsCsv = null;          // rebuild the sync baseline from the sheet on first self-check
      renderGsRow();
      maybeCombine();
    } catch (err) {
      console.error(err);
      toast('Could not reopen your saved workbooks <span class="sub">(' +
        esc(String(err && err.message || err).slice(0, 90)) + ')</span> — load the files again.', true);
    }
  }
  bootRestore();
  /* first self-check shortly after boot so a shared sheet syncs without waiting a full cycle */
  if (!TEST_MODE) setTimeout(function () { if (remote.online) refreshSheet(false); }, 5000);

  /* debug hook (used by tests / smoke runs; harmless otherwise) */
  window.__tcrs = {
    state: state,
    maybeCombine: maybeCombine,
    setSchool: setSchool,
    exportXlsx: exportXlsx,
    drawView: drawView,
    filteredEntries: filteredEntries,
    refresh: refresh,
    commitICRF: commitICRF,
    applyTLText: applyTLText, tlText: tlText,
    addIcrfRow: addIcrfRow, dupIcrf: dupIcrf, delIcrf: delIcrf,
    prunePastDates: prunePastDates,
    parseCsv: parseCsv, csvToWorkbook: csvToWorkbook, mergeEntries: mergeEntries,
    resetEdits: resetEdits,
    saveStore: saveStore, flushSave: flushSave, flushSchedule: flushSchedule,
    setTab: setTab, setSrc: setSrc,
    renderUploadStatus: renderUploadStatus
  };
})();
