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
    history: [],            // recent-changes trail ({at,src,text}), newest first — saved with the edits
    busPlan: {},            // saved planner drafts: { day: {order:[entryId], times:{id:'HHMM'}, auto} } — not applied until Submit
    planOrder: {},          // working trip order per day ({day:[entryId]}) — a day left untouched has none (schedule order)
    planTimes: {},          // working respaced times per day ({day:{id:'HHMM'}}) — only kept while auto adjust is on
    planAuto: {},           // days with auto adjust switched on (default off: dragging only reorders)
    planDirty: {},          // days with unsaved working changes
    planDragId: null,       // trip just dragged — adopts its new slot on the next respace
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
    ['#8A660C', '#F6E8BE'], ['#6E7D1F', '#EAEDC6'], ['#B4501E', '#F6DECE'],
    ['#1E7A6A', '#D2E9E4'], ['#1E7A4A', '#D8EEDD'], ['#2E7391', '#D9E9F2'],
    ['#3E6E8E', '#DCE7F0'], ['#5F7A6A', '#DCE5DC']
  ];
  var COY_COLORS = {
    '1ST': COY_FILL_CYCLE[0], '2ND': COY_FILL_CYCLE[1], '3RD': COY_FILL_CYCLE[2],
    '4TH': COY_FILL_CYCLE[3], '5TH': COY_FILL_CYCLE[4], '6TH': COY_FILL_CYCLE[5],
    '7TH': COY_FILL_CYCLE[6],
    'SCHWIDE': ['#57655A', '#E4E7DC']
  };
  /* every palette colour rides the theme hue: a fixed brand hex becomes
     hsl(calc(var(--theme-h) + OFF), S%, L%) — OFF is the colour's original
     distance from the rust default (hue 14), so moving the Settings slider
     rotates the whole wheel rigidly and all colour relations hold */
  function themeCol(hex, a) {
    var r = parseInt(hex.slice(1, 3), 16) / 255,
      g = parseInt(hex.slice(3, 5), 16) / 255,
      b = parseInt(hex.slice(5, 7), 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    var l = (max + min) / 2;
    var s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
    var off = Math.round(h - 14);
    if (off > 180) off -= 360;
    if (off <= -180) off += 360;
    return 'hsl' + (a !== undefined ? 'a' : '') + '(calc(var(--theme-h) + ' + off + '),' +
      (Math.round(s * 1000) / 10) + '%,calc(' + (Math.round(l * 1000) / 10) + '% * var(--theme-b))' +
      (a !== undefined ? ',' + a : '') + ')';
  }
  function coyStyle(c) {
    var p = COY_COLORS[c];
    if (!p) {
      var roster = T.schoolCompanies(state.school);
      var i = roster.indexOf(c);
      p = i > -1 ? COY_FILL_CYCLE[i % COY_FILL_CYCLE.length] : COY_FILL_CYCLE[0];
    }
    return { cc: themeCol(p[0]), cb: themeCol(p[1]), cbA: themeCol(p[1], .65) };
  }

  var $ = function (id) { return document.getElementById(id); };

  /* ----------------------------------------------------------- toast -- */
  /* toast(msg, isErr) as before, or toast(msg, { err, ms, action:{label,fn} })
     — with an action the toast carries a button (e.g. "Undo") that fires fn */
  var toastTimer = null, toastAction = null;
  function toast(msg, opts) {
    var isErr = opts === true || !!(opts && opts.err);
    var t = $('toast'), act = $('toast-act');
    toastAction = (opts && opts.action) || null;
    if (toastAction) { act.hidden = false; act.textContent = toastAction.label || 'Undo'; }
    else { act.hidden = true; }
    $('toast-msg').innerHTML = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.className = 'toast' + (isErr ? ' err' : '');
      toastAction = null; act.hidden = true;
    }, (opts && opts.ms) || 5200);
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
  function monthStr(k) {            // accepts a full month key ('s4-11-2026') or bare ('11-2026')
    if (k) k = String(k).replace(/^s\d+-/, '');
    return k || (state.model ? state.model.month + '-' + state.model.year : 'current');
  }
  function monthKey() { return schoolPart() + '-' + state.model.month + '-' + state.model.year; }
  function storeKey(k) { return 'tcrs:v3:' + schoolPart() + ':' + monthStr(k); }
  function filesKey(k) { return 'tcrs:files:' + schoolPart() + ':' + monthStr(k); }
  function lastKey() { return 'tcrs:last:' + schoolPart() + ':'; }
  var MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  /* every month this school has touched — remote (server memory) merged with
     local storage, newest first */
  function listMonths() {
    var sp = schoolPart() + '-', out = {};
    var doc = remote.doc && remote.doc.months;
    if (doc) Object.keys(doc).forEach(function (key) {
      if (key.indexOf(sp) === 0) out[monthStr(key)] = 1;
    });
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
      var re = new RegExp('^tcrs:v3:' + schoolPart() + ':(\\d{1,2})-(\\d{4})$');
      keys.forEach(function (key) {
        var m = re.exec(key);
        if (m) out[m[1] + '-' + m[2]] = 1;
      });
    } catch (e) { }
    var last = lsGet(lastKey());
    if (last && last.indexOf(sp) === 0) out[monthStr(last)] = 1;
    return Object.keys(out).sort(function (a, b) {
      var pa = a.split('-'), pb = b.split('-');
      return (+pb[1] - +pa[1]) || (+pb[0] - +pa[0]);
    });
  }
  function monthLabel(k) {
    var p = monthStr(k).split('-');
    return (MONTH_FULL[(+p[0]) - 1] || '?') + ' ' + p[1];
  }

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
    if (o.srcTab === 'icrf' || o.srcTab === 'tl' || o.srcTab === 'clash' || o.srcTab === 'plan') state.srcTab = o.srcTab;
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
    renderPlanner();                // the planner tab tracks edits live
    if (!optsOnly) { state.touched = true; dataEpoch++; }
    savePending = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 700);
    if (!remote.conflict) setSync('busy', 'Saving…');
  }
  function editsPayload() {         // null = nothing edited, the parsed workbooks are the truth
    if (!state.touched && !(state.history && state.history.length) &&
        !(state.busPlan && Object.keys(state.busPlan).length)) return null;
    return {
      updatedAt: new Date().toISOString(),
      entries: state.entries, tlLines: state.tlLines, skipped: state.skipped,
      history: state.history, busPlan: state.busPlan || {}
    };
  }
  function flushSave(keepalive) {
    clearTimeout(saveTimer);
    if (!savePending || !state.model) return;
    savePending = false;
    recordHistoryTick();
    var e = editsPayload() || { updatedAt: new Date().toISOString(), entries: [], tlLines: [], skipped: [], history: state.history };
    var o = currentOpts(), key = monthKey();
    var okLocal = lsSet(storeKey(), JSON.stringify({
      v: 3, at: Date.now(), updatedAt: e.updatedAt,
      entries: e.entries, tlLines: e.tlLines, skipped: e.skipped, history: e.history || [],
      busPlan: e.busPlan || {}, opts: o
    }));
    if (remote.localFilesDirty && (state.files.icrf || state.files.tl)) {
      if (lsSet(filesKey(), JSON.stringify(state.files))) remote.localFilesDirty = false;
    }
    lsSet(lastKey(), key);
    if (remote.online) pushRemote(keepalive === true);
    else setSync('local', okLocal ? 'Saved on this device' : 'Not saved — storage unavailable');
  }

  /* ------------------------------------------------- edit history -- */
  /* Small audit trail of what changed this month, stored inside the edits
     payload (opaque to the server). One event per save burst: live-sheet
     cell edits are diffed against the previous save; named actions (sheet
     sync, Troop-lift text, reset) record themselves as they happen. */
  var HIST_MAX = 50, histLast = {}, histNote = null;

  function histSig() {
    var m = {};
    state.entries.forEach(function (e) {
      m[e.id] = [e.activity, e.date, e.eDate, e.timeStart, e.timeEnd, e.from, e.to, e.qty,
        (e.coys || []).join('+')].join('|');
    });
    return m;
  }
  /* ---------------------------- in-session undo (Recent changes) -------
     Every history event also stores a full snapshot of the editable data
     as it was just *after* that event (undoStack, oldest pushed first),
     plus one base snapshot (undoBase) taken when the month was loaded.
     "Undo" on a Recent-changes row puts the data back to how it was
     *before* that change — dropping it and every later one. In memory
     only: events from a previous session have no snapshots and show no
     undo button. */
  var UNDO_CAP = 20;
  var undoBase = null, undoStack = [], undoTrimmed = 0, sessionEvents = 0;
  var dataEpoch = 0;         // bumped on every data mutation — stale undo offers are refused

  function undoSnap() {
    return JSON.stringify({ entries: state.entries, tlLines: state.tlLines,
      skipped: state.skipped, coys: state.coys });
  }
  function undoResetBase() { undoBase = undoSnap(); undoStack = []; undoTrimmed = 0; sessionEvents = 0; }

  function applySnapshot(json) {
    var s = JSON.parse(json);
    state.entries = s.entries; state.tlLines = s.tlLines;
    state.skipped = s.skipped; state.coys = s.coys;
    histLast = histSig();    // the restore itself must not double-count as an edit burst
    changed(); rerenderSrc(); renderChips(); renderNotes(); renderHistory();
    saveStore();
  }

  function canRevert(k) {    // k = index into state.history (0 = newest)
    if (k >= sessionEvents) return false;   // recorded in an earlier session
    var j = sessionEvents - 2 - k;          // snapshot after event k+1 = state before event k
    if (j < 0) return true;                 // oldest session event → the load-time base
    return j - undoTrimmed >= 0;            // old snapshots may have been trimmed away
  }

  function revertEvent(k) {
    var j = sessionEvents - 2 - k;
    var snap = j < 0 ? undoBase : undoStack[j - undoTrimmed];
    if (!snap) return false;
    histNote = { src: 'revert', text: 'Reverted to ' + histWhen((state.history[k] || {}).at) };
    applySnapshot(snap);
    return true;
  }

  function pushHistory(src, text) {
    undoStack.push(undoSnap());
    if (undoStack.length > UNDO_CAP) { undoStack.shift(); undoTrimmed++; }
    sessionEvents++;
    state.history.unshift({ at: new Date().toISOString(), src: src, text: text });
    if (state.history.length > HIST_MAX) state.history.length = HIST_MAX;
    renderHistory();
  }
  function recordHistoryTick() {
    var note = histNote; histNote = null;
    var sig = histSig(), added = 0, changed = 0, removed = 0;
    Object.keys(sig).forEach(function (id) {
      if (!(id in histLast)) added++;
      else if (sig[id] !== histLast[id]) changed++;
    });
    Object.keys(histLast).forEach(function (id) { if (!(id in sig)) removed++; });
    histLast = sig;
    if (note) { pushHistory(note.src, note.text); return; }
    if (!added && !changed && !removed) return;
    var parts = [];
    if (added) parts.push(added + ' added');
    if (changed) parts.push(changed + ' changed');
    if (removed) parts.push(removed + ' removed');
    pushHistory('edit', 'Live sheet — ' + parts.join(', '));
  }
  function histWhen(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d)) return '';
    var t = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    if (d.toDateString() === new Date().toDateString()) return t;
    return d.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] + ', ' + t;
  }
  function renderHistory() {
    var count = $('hist-count');
    if (!count) return;                     // rail not present (tests inject partial DOM)
    var h = state.history || [];
    count.textContent = h.length;
    count.classList.toggle('zero', h.length === 0);
    var rows = h.slice(0, 15).map(function (ev, k) {
      var rev = canRevert(k)
        ? '<button type="button" class="hrev" data-k="' + k +
          '" title="Undo this change — later changes are undone too">↩</button>'
        : '';
      return '<div class="hrow"><span class="when">' + esc(histWhen(ev.at)) +
        '</span><span class="txt">' + esc(ev.text) + '</span>' + rev + '</div>';
    });
    if (h.length > 15) rows.push('<div class="hrow more">…and ' + (h.length - 15) + ' earlier</div>');
    $('hist-list').innerHTML = h.length ? rows.join('') : '<div class="empty">nothing yet this month</div>';
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
        var sendingFiles = remote.filesDirty && (state.files.icrf || state.files.tl);
        if (sendingFiles) body.files = { icrf: state.files.icrf, tl: state.files.tl };
        var json = JSON.stringify(body);
        var r = await fetch(API_BASE + '/api/state/' + encodeURIComponent(key), {
          method: 'PUT', credentials: 'include',
          headers: apiHeaders(true),
          body: json, keepalive: !!keepalive && json.length < 60000
        });
        if (r.status === 401) { dropToken(); location.href = 'login'; return; }
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
  /* Saved records come from localStorage or the server; either may hold data
     written by an older build or mangled by hand. Each collection is checked
     and malformed pieces are dropped — a month with one corrupt row still
     loads, and nothing untrusted ever reaches state. */
  function validateSaved(rec) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
    var str = function (v) { return typeof v === 'string' && v.length > 0; };
    var out = {
      v: 3, hasEdits: false,
      updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : '',
      entries: [], tlLines: [], skipped: [], history: [], busPlan: {},
      opts: (rec.opts && typeof rec.opts === 'object' && !Array.isArray(rec.opts)) ? rec.opts : null
    };
    if (rec._remote) out._remote = true;

    if (Array.isArray(rec.entries)) {
      out.entries = rec.entries.filter(function (e) {
        return e && typeof e === 'object' && !Array.isArray(e) && str(e.id);
      });
    }
    out.hasEdits = out.entries.length > 0;

    if (Array.isArray(rec.tlLines)) {
      out.tlLines = rec.tlLines.filter(function (l) {
        return l && typeof l === 'object' && !Array.isArray(l) &&
          (l.kind === 'line' || l.kind === 'date' || l.kind === 'title');
      });
    }
    if (Array.isArray(rec.skipped)) {
      out.skipped = rec.skipped.filter(function (s) {
        return s && typeof s === 'object' && !Array.isArray(s);
      });
    }
    if (Array.isArray(rec.history)) {
      out.history = rec.history.filter(function (h) {
        return h && typeof h === 'object' && !Array.isArray(h) && typeof h.text === 'string';
      });
    }
    if (rec.busPlan && typeof rec.busPlan === 'object' && !Array.isArray(rec.busPlan)) {
      Object.keys(rec.busPlan).forEach(function (day) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
        var d = rec.busPlan[day];
        if (!d || typeof d !== 'object' || Array.isArray(d) || !Array.isArray(d.order)) return;
        var order = d.order.filter(str);
        if (!order.length) return;
        var times = {};
        if (d.times && typeof d.times === 'object' && !Array.isArray(d.times)) {
          Object.keys(d.times).forEach(function (id) {
            var t = d.times[id];
            if (str(id) && (t === 'TBC' || /^\d{4}$/.test(String(t)))) times[id] = String(t);
          });
        }
        out.busPlan[day] = { order: order, times: times, auto: !!d.auto };
      });
    }
    return out;
  }

  function readLocal(key) {          // key = month key, e.g. '11-2026' (school prefix tolerated)
    try {
      var d = JSON.parse(lsGet(storeKey(key)) || 'null');
      if (d && d.v === 3) {
        var rec = validateSaved(d);
        if (rec) { rec.hasEdits = rec.entries.length > 0; return rec; }
      }
    } catch (e) { }
    return null;
  }
  function readRemote(key) {
    var rec = remote.doc && remote.doc.months && remote.doc.months[key];
    if (!rec) return null;
    var ed = rec.edits, has = !!(ed && Array.isArray(ed.entries) && ed.entries.length);
    return validateSaved({
      v: 3, updatedAt: (ed && ed.updatedAt) || rec.savedAt,
      entries: has ? ed.entries : [], tlLines: has ? ed.tlLines : [], skipped: has ? ed.skipped : [],
      history: (ed && Array.isArray(ed.history)) ? ed.history : [],
      busPlan: (ed && ed.busPlan && typeof ed.busPlan === 'object' && !Array.isArray(ed.busPlan)) ? ed.busPlan : {},
      opts: rec.opts, _remote: true
    });
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
    histNote = { src: 'reset', text: 'Edits reset to the parsed data' };
    discardStore(true);
    state.entries = JSON.parse(JSON.stringify(state.pristine.entries));
    state.tlLines = JSON.parse(JSON.stringify(state.pristine.tlLines));
    state.skipped = JSON.parse(JSON.stringify(state.pristine.skipped));
    normalizeTLLines();
    state.busPlan = {};
    state.planOrder = {}; state.planTimes = {}; state.planAuto = {};
    state.planDirty = {}; state.planDragId = null;
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

  /* The user's explicit sheet choice (stored on the file record so it is saved
     with the workbook) wins; otherwise the best content match is used. */
  function autoSheet(which, wb) { return which === 'icrf' ? pickICRFSheet(wb) : pickTLSheet(wb); }
  function chosenSheet(which, wb) {
    var f = state.files[which], name = f && f.sheet, found = null;
    if (name) wb.worksheets.forEach(function (ws) { if (ws.name === name) found = ws; });
    return found || autoSheet(which, wb);
  }
  function setSheetChoice(which, name) {
    var f = state.files[which];
    if (!f) return;
    if (name) f.sheet = name; else delete f.sheet;
    remote.filesDirty = true; remote.localFilesDirty = true;
    maybeCombine();
  }
  function sheetPickerHtml(which) {
    var wb = which === 'icrf' ? state.icrfWb : state.tlWb;
    if (!wb || wb.worksheets.length < 2) return '';
    var f = state.files[which], cur = (f && f.sheet) || '', auto = autoSheet(which, wb);
    var h = '<div class="sheetpick"><label>Sheet<select class="sheetsel" data-which="' + which + '">' +
      '<option value=""' + (cur ? '' : ' selected') + '>Auto — ' + esc(auto ? auto.name : '') + '</option>';
    wb.worksheets.forEach(function (ws) {
      h += '<option value="' + esc(ws.name) + '"' + (cur === ws.name ? ' selected' : '') + '>' + esc(ws.name) + '</option>';
    });
    return h + '</select></label></div>';
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
        '<button class="remove" data-which="' + which + '">remove</button></div>' + sheetPickerHtml(which);
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
        method: 'PUT', credentials: 'include',
        headers: apiHeaders(true),
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

  /* Session token from the login response — sent as a header because
     browsers may block third-party cookies on the Pages→API split. */
  function apiHeaders(json) {
    var h = { 'X-TCRS': '1' };
    var t = lsGet('tcrs:token');
    if (t) h['Authorization'] = 'Bearer ' + t;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }
  function dropToken() { lsDel('tcrs:token'); }

  async function fetchSheet(url) {
    var r = await fetch(API_BASE + '/api/sheet?url=' + gsEscape(url),
      { credentials: 'include', headers: apiHeaders(false) });
    if (r.status === 401) { dropToken(); location.href = 'login'; throw new Error('login required'); }
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
        { worksheets: [chosenSheet('tl', state.tlWb)] },
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
    if (added || updated || removed) {
      var hp = [];
      if (added) hp.push(added + ' added');
      if (updated) hp.push(updated + ' changed');
      if (removed) hp.push(removed + ' removed');
      histNote = { src: 'sheet', text: 'Google Sheet sync — ' + hp.join(', ') };
    }
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
        var icrfSheet = chosenSheet('icrf', state.icrfWb);
        var tlSheet = chosenSheet('tl', state.tlWb);
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
      histLast = {}; histNote = null;
      undoResetBase();
      state.busPlan = {}; state.planOrder = {}; state.planTimes = {};
      state.planAuto = {}; state.planDirty = {}; state.planDragId = null;
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
      renderPlanner();
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
    state.history = (saved && Array.isArray(saved.history)) ? saved.history : [];
    state.busPlan = (saved && saved.busPlan && typeof saved.busPlan === 'object' && !Array.isArray(saved.busPlan)) ? saved.busPlan : {};
    state.planOrder = {}; state.planTimes = {}; state.planAuto = {};
    state.planDirty = {}; state.planDragId = null;

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
    histLast = histSig();             // history diff baseline = what is on screen now
    undoResetBase();                  // undo baseline = the freshly (re)opened month

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
    renderPlanner();
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
  /* Deletes are instant — the undo comes as a toast button, backed by a
     full pre-delete snapshot. The offer is voided if any other data edit
     happens before it is used (the epoch moved), pointing at the
     Recent-changes list instead. */
  function offerRowUndo(msg, snap) {
    toast(msg, { action: { label: 'Undo', fn: function () {
      if (dataEpoch !== snap._epoch) {
        toast('Other edits happened since — undo from <b>Recent changes</b> in the left panel instead.', true);
        return;
      }
      applySnapshot(snap._data);
      toast('Row restored.', false);
    } } });
  }
  function delIcrf(id) {
    if (id.charAt(0) === 's') {
      var idx = +id.slice(1);
      var s = state.skipped[idx];
      if (!s) return;
      var snapS = { _data: undoSnap(), _epoch: dataEpoch };
      state.skipped.splice(idx, 1);
      saveStore();
      snapS._epoch = dataEpoch;
      updateSavePill(); rerenderSrc();
      offerRowUndo('Skipped row removed.', snapS);
      return;
    }
    var e = findEntry(id);
    if (!e) return;
    var snap = { _data: undoSnap() };
    state.entries.splice(state.entries.indexOf(e), 1);
    saveStore();
    snap._epoch = dataEpoch;
    changed();
    rerenderSrc();
    offerRowUndo('Row deleted.', snap);
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
    var hparts = [];
    if (added) hparts.push(added + ' added');
    if (dropped) hparts.push(dropped + ' removed');
    histNote = { src: 'tl', text: 'Troop lift text updated' + (hparts.length ? ' — ' + hparts.join(', ') : '') };
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
    $('btn-src-planner').classList.toggle('on', s === 'plan');
    $('icrf-container').style.display = s === 'icrf' ? '' : 'none';
    $('tl-container').style.display = s === 'tl' ? '' : 'none';
    $('planner-container').style.display = s === 'plan' ? '' : 'none';
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
    if (state.srcTab === 'plan') renderPlanner();
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
    syncMonthBtn();
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
      b.innerHTML = '<i class="dot" style="background:' + st.cc + '"></i>' +
        esc(c === 'SCHWIDE' ? 'SCHWIDE' : c + ' Coy');
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
    renderHistory();
  }

  /* ------------------------------------------------- bus planner tab -- */
  /* All of the month's bus trips, day by day in one scroll — clean trips
     included. Dragging reorders a day; a small per-day "auto adjust"
     toggle (default off) lets the timings re-space after each drag with
     a minimal fix (entered times kept unless they would clash). The
     working plan lives in memory; Save draft stores it with the month
     (busPlan in the edits payload) and Submit writes the times into the
     entries and Troop-lift text, so nothing reaches the schedule until
     Submit. 2359/TBC activation trips are listed but locked. */

  function planDays() {             // day -> bus entries
    var days = {};
    state.entries.forEach(function (e) {
      if (e.kind !== 'bus' || !e.date || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) return;
      (days[e.date] = days[e.date] || []).push(e);
    });
    return days;
  }

  function planLabel(day) { return T.dowOf(day) + ' ' + T.fmtDate(day); }

  function planLocked(e) {          // late-night activation — not plannable
    var ts = String(e.timeStart || '').trim();
    return ts === '2359' || ts === 'TBC';
  }

  /* make the per-day working state match the loaded entries; a day the
     user never touched and that has no draft stays lazy (schedule order,
     entered times, auto adjust off) */
  function planEnsureAll(days) {
    Object.keys(state.busPlan || {}).forEach(function (d) {
      if (!days[d]) delete state.busPlan[d];   // drafts for days that lost their trips
    });
    Object.keys(days).forEach(function (day) {
      var cur = days[day];
      var have = {};
      cur.forEach(function (e) { have[e.id] = true; });
      if (!state.planOrder[day]) {
        var draft = (state.busPlan || {})[day];
        if (draft && Array.isArray(draft.order) && draft.order.length) {
          state.planOrder[day] = draft.order.filter(function (id) { return have[id]; });
          state.planTimes[day] = Object.assign({}, draft.times || {});
          state.planAuto[day] = !!draft.auto;
        }
      }
      if (!state.planOrder[day]) return;
      state.planOrder[day] = state.planOrder[day].filter(function (id) { return have[id]; });
      /* slot in entries the order does not know yet (rows added after the
         draft keep the time order) */
      cur.forEach(function (e) {
        if (state.planOrder[day].indexOf(e.id) !== -1) return;
        var CLm2 = window.TCRSClash;
        var pt = state.planTimes[day] || {};
        var t = CLm2 ? CLm2.toMin(pt[e.id] || e.timeStart) : null;
        var at = state.planOrder[day].length;
        for (var i = 0; i < state.planOrder[day].length; i++) {
          var o = findEntry(state.planOrder[day][i]);
          if (!o) continue;
          var ot = CLm2 ? CLm2.toMin(pt[o.id] || o.timeStart) : null;
          if ((ot === null ? 1441 : ot) > (t === null ? 1441 : t)) { at = i; break; }
        }
        state.planOrder[day].splice(at, 0, e.id);
      });
    });
  }

  /* the day's trip order — materialized from the schedule on first change */
  function planOrderOf(day, days) {
    if (state.planOrder[day]) return state.planOrder[day];
    var CLm = window.TCRSClash;
    return (days ? days[day] : planDays()[day] || []).slice().sort(function (a, b) {
      var ta = CLm ? CLm.toMin(a.timeStart) : null;
      var tb = CLm ? CLm.toMin(b.timeStart) : null;
      return (ta === null ? 1441 : ta) - (tb === null ? 1441 : tb);
    }).map(function (e) { return e.id; });
  }

  function planTrips(day, order) {  // respace input from the day's working plan
    var pt = state.planTimes[day] || {};
    return order.map(function (id) {
      var e = findEntry(id);
      if (!e) return { id: id, timeStart: 'TBC', from: '', to: '', qty: null, lock: true };
      var locked = planLocked(e);
      return {
        id: id,
        timeStart: locked ? e.timeStart : (pt[id] || e.timeStart),
        from: e.from, to: e.to, qty: e.qty, lock: locked
      };
    });
  }

  function planMove(day, dragId, targetId) {
    var order = state.planOrder[day] || (state.planOrder[day] = planOrderOf(day));
    var from = order.indexOf(dragId), to = order.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    order.splice(to, 0, order.splice(from, 1)[0]);
    state.planDragId = dragId;      // the dragged trip adopts its new slot (auto adjust on)
    state.planDirty[day] = true;
    renderPlanner();
  }

  function planSaveDraft() {
    var touchedDays = Object.keys(state.planDirty || {}).filter(function (d) {
      return state.planDirty[d];
    });
    if (!touchedDays.length) return;
    state.busPlan = state.busPlan || {};
    touchedDays.forEach(function (day) {
      state.busPlan[day] = {
        order: planOrderOf(day).slice(),
        times: Object.assign({}, state.planTimes[day] || {}),
        auto: !!state.planAuto[day]
      };
    });
    state.touched = true;
    state.planDirty = {};
    histNote = { src: 'plan', text: 'Bus plan draft saved — ' +
      (touchedDays.length === 1
        ? planOrderOf(touchedDays[0]).length + ' trips (' + planLabel(touchedDays[0]) + ')'
        : touchedDays.length + ' days') };
    saveStore();
    flushSave();
    renderPlanner();
  }

  function planSubmit() {
    var re = /^(\*?\s*)(\d{4}|TBC)(?=\s)/;
    var n = 0, dayCount = 0, lastDay = null;
    Object.keys(state.planOrder).forEach(function (day) {
      var order = state.planOrder[day], pt = state.planTimes[day] || {};
      var dayN = 0;
      order.forEach(function (id) {
        var e = findEntry(id);
        if (!e) return;
        var nt = pt[id];
        if (!nt || nt === e.timeStart || planLocked(e)) return;
        e.timeStart = nt;
        e.edited = true;
        if (typeof e.rawText === 'string' && re.test(e.rawText)) {
          e.rawText = e.rawText.replace(re, function (m, p1) { return p1 + nt; });
        }
        state.tlLines.forEach(function (l) {
          if (l.entryId === e.id && l.kind === 'line' && typeof l.text === 'string' && re.test(l.text)) {
            l.text = l.text.replace(re, function (m, p1) { return p1 + nt; });
          }
        });
        n++; dayN++;
      });
      if (dayN) { dayCount++; lastDay = day; }
    });
    state.busPlan = {};
    state.planDirty = {};
    state.planOrder = {}; state.planTimes = {}; state.planAuto = {};
    state.touched = true;
    histNote = { src: 'plan', text: 'Bus plan submitted — ' + n + ' trip' + (n === 1 ? '' : 's') +
      ' retimed' + (dayCount > 1 ? ' across ' + dayCount + ' days' :
        dayCount === 1 ? ' (' + planLabel(lastDay) + ')' : '') };
    saveStore();
    flushSave();
    changed();
    renderPlanner();
    if (n) toast('Plan submitted — ' + n + ' trip' + (n === 1 ? '' : 's') + ' retimed.', false);
  }

  function planDiscard() {
    var hadDraft = state.busPlan && Object.keys(state.busPlan).length;
    var hadWork = Object.keys(state.planDirty || {}).some(function (d) { return state.planDirty[d]; });
    state.busPlan = {};
    state.planDirty = {};
    state.planOrder = {}; state.planTimes = {}; state.planAuto = {};
    if (hadDraft || hadWork) {
      state.touched = true;
      histNote = { src: 'plan', text: 'Bus plan draft discarded' };
      saveStore();
      flushSave();
    }
    renderPlanner();
  }

  function renderPlanner() {
    var btn = $('btn-src-planner'), host = $('planner-container');
    if (!btn || !host) return;
    var CL = window.TCRSClash;
    if (!CL) {                          // module missing — never break the save path
      btn.textContent = 'Bus planner';
      host.innerHTML = '<div class="clash-empty">Bus planner unavailable.</div>';
      return;
    }
    if (!state.model) {
      btn.textContent = 'Bus planner';
      host.innerHTML = '<div class="clash-empty">Load the month’s files to plan the buses.</div>';
      return;
    }
    var days = planDays();
    var dayList = Object.keys(days).sort();
    if (!dayList.length) {
      btn.textContent = 'Bus planner';
      host.innerHTML = '<div class="clash-empty clean">No bus trips in this month.</div>';
      return;
    }
    planEnsureAll(days);

    /* per-day preview: only days with auto adjust on get respaced times —
       the rest keep their entered times, drags just reorder */
    var skippedByDay = {};
    dayList.forEach(function (day) {
      var order = planOrderOf(day, days);
      var r = CL.respace(planTrips(day, order),
        { drag: state.planAuto[day] ? state.planDragId : null });
      var sk = {};
      r.skipped.forEach(function (id) { sk[id] = true; });
      skippedByDay[day] = sk;
      if (state.planAuto[day]) {
        var pt = {};
        r.plan.forEach(function (p) { pt[p.id] = p.time; });
        state.planTimes[day] = pt;
      } else {
        state.planTimes[day] = {};
      }
    });
    state.planDragId = null;          // consumed — further renders are stable

    /* badges come from the checker run over the projected times */
    var proj = state.entries.map(function (e) {
      if (e.kind !== 'bus' || !e.date) return e;
      var pt = state.planTimes[e.date];
      return (pt && pt[e.id] && !planLocked(e))
        ? Object.assign({}, e, { timeStart: pt[e.id] }) : e;
    });
    var res = CL.analyze(proj);
    var flagByDay = {};
    res.flags.forEach(function (f) {
      (flagByDay[f.date] = flagByDay[f.date] || {})[f.id] = f;
    });

    var totRed = 0, totOrange = 0;
    Object.keys(flagByDay).forEach(function (d) {
      Object.keys(flagByDay[d]).forEach(function (id) {
        var s = flagByDay[d][id].severity;
        if (s === 'red') totRed++;
        else if (s === 'orange') totOrange++;
      });
    });
    var anyDraft = Object.keys(state.busPlan || {}).length > 0;
    btn.textContent = 'Bus planner' + (totRed + totOrange ? ' · ' + (totRed + totOrange) : '') +
      (anyDraft ? ' · draft' : '');

    var dirtyN = Object.keys(state.planDirty).filter(function (d) { return state.planDirty[d]; }).length;
    var canSave = dirtyN > 0;
    var canAct = canSave || anyDraft;
    var html = '<div class="plan-toolbar">' +
      '<span class="plan-scope">' + dayList.length + ' day' + (dayList.length === 1 ? '' : 's') +
      ' with bus trips</span>' +
      '<span class="plan-actions">' +
      '<button id="plan-save" class="plan-btn"' + (canSave ? '' : ' disabled') + '>Save draft</button>' +
      '<button id="plan-submit" class="plan-btn plan-submit"' + (canAct ? '' : ' disabled') + '>Submit plan</button>' +
      '<button id="plan-discard" class="plan-btn"' + (canAct ? '' : ' disabled') + '>Discard</button>' +
      '</span></div>' +
      '<div class="plan-hint">Drag trips to reorder. With <b>auto adjust</b> on, that day’s timings ' +
      're-space after each drag; off, times stay exactly as entered. Nothing changes in the ' +
      'schedule until you submit the plan.</div>';

    dayList.forEach(function (day) {
      var flags = flagByDay[day] || {};
      var reds = 0, orange = 0, perm = 0;
      Object.keys(flags).forEach(function (id) {
        var s = flags[id].severity;
        if (s === 'red') reds++;
        else if (s === 'orange') orange++;
        else perm++;
      });
      var order = planOrderOf(day, days);
      var act = 0;
      order.forEach(function (id) {
        var e = findEntry(id);
        if (e && planLocked(e)) act++;
      });
      var draft = (state.busPlan || {})[day];
      var dirty = !!state.planDirty[day];
      var pt = state.planTimes[day] || {};
      var skipped = skippedByDay[day] || {};

      html += '<div class="plan-day" data-day="' + esc(day) + '">' +
        '<div class="plan-dayhead">' +
        '<span class="clash-date">' + esc(planLabel(day)) + ' — ' + order.length + ' trips</span>' +
        '<label class="plan-auto" title="Re-space this day’s timings after each drag">' +
        '<input type="checkbox" data-day="' + esc(day) + '"' +
        (state.planAuto[day] ? ' checked' : '') + '> auto adjust</label>' +
        '<span class="plan-daynote">' +
        (reds ? '<b class="sev-red">' + reds + ' clash' + (reds === 1 ? '' : 'es') + '</b>' : '') +
        (reds && orange ? ' · ' : '') +
        (orange ? '<b class="sev-orange">' + orange + ' tight</b>' : '') +
        ((reds || orange) && perm ? ' · ' : '') +
        (perm ? '<b class="sev-perm">' + perm + ' before 0700</b>' : '') +
        (act ? ((reds || orange || perm) ? ' · ' : '') + act + ' activation' : '') +
        (draft ? (dirty ? ' · draft saved — changes not saved' : ' · draft saved') :
          dirty ? ' · changes not saved' : '') +
        '</span></div>';

      html += '<div class="plan-list">';
      order.forEach(function (id) {
        var e = findEntry(id);
        if (!e) return;
        var f = flags[id];
        var locked = planLocked(e);
        var planned = pt[id] || e.timeStart || '';
        var moved = !locked && planned !== (e.timeStart || '');
        var sev = f ? f.severity : (locked ? 'activation' : skipped[id] ? 'skip' : 'ok');
        html += '<div class="clash-item plan-row sev-' + sev + (locked ? ' plan-locked' : '') +
          (moved ? ' plan-moved' : '') + '" data-id="' + esc(id) + '"' +
          (locked ? '' : ' draggable="true"') + '>' +
          '<span class="plan-handle" title="' + (locked ? '2359/TBC activation — locked' : 'Drag to reorder') + '">' +
            (locked ? '–' : '⋮⋮') + '</span>' +
          '<span class="clash-time">' + esc(planned) +
            (moved ? ' <s class="plan-was" title="was here before planning">' + esc(e.timeStart) + '</s>' : '') + '</span>' +
          '<span class="clash-route">' + esc(CL.normalizeLoc(e.from) || '—') + ' → ' +
            esc(CL.normalizeLoc(e.to) || '—') + '</span>' +
          '<span class="plan-qty">' + (e.qty === null || e.qty === undefined ? '?' : esc(String(e.qty))) + ' bus</span>' +
          '<span class="clash-why">' + esc(e.activity || '') +
            (e.coys && e.coys.length ? ' <i>(' + esc(e.coys.join(', ')) + ')</i>' : '') + '</span>' +
          '<span class="clash-badge">' + (f
            ? (f.severity === 'red' ? 'CLASH' : f.severity === 'orange' ? 'TIGHT' : 'PERMISSION')
            : locked ? 'ACTIVATION' : skipped[id] ? 'SKIP' : 'OK') + '</span>' +
          '</div>';
      });
      html += '</div></div>';
    });
    host.innerHTML = html;

    var bSave = $('plan-save');
    if (bSave) bSave.addEventListener('click', planSaveDraft);
    var bSub = $('plan-submit');
    if (bSub) bSub.addEventListener('click', planSubmit);
    var bDis = $('plan-discard');
    if (bDis) bDis.addEventListener('click', planDiscard);

    host.querySelectorAll('.plan-auto input').forEach(function (input) {
      input.addEventListener('change', function () {
        var day = input.getAttribute('data-day');
        state.planAuto[day] = input.checked;
        state.planTimes[day] = {};    // off = back to the entered times
        state.planDirty[day] = true;
        renderPlanner();
      });
    });

    var dragId = null;
    host.querySelectorAll('.plan-row[data-id]').forEach(function (row) {
      if (row.classList.contains('plan-locked')) return;
      var id = row.getAttribute('data-id');
      var daySec = row.closest('.plan-day');
      var day = daySec ? daySec.getAttribute('data-day') : null;
      row.addEventListener('dragstart', function (ev) {
        dragId = id;
        ev.dataTransfer.setData('text/plain', id);
        ev.dataTransfer.effectAllowed = 'move';
        row.classList.add('plan-dragging');
      });
      row.addEventListener('dragend', function () {
        row.classList.remove('plan-dragging');
        host.querySelectorAll('.plan-drop').forEach(function (n) { n.classList.remove('plan-drop'); });
      });
      row.addEventListener('dragover', function (ev) {
        if (!dragId || dragId === id) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        row.classList.add('plan-drop');
      });
      row.addEventListener('dragleave', function () { row.classList.remove('plan-drop'); });
      row.addEventListener('drop', function (ev) {
        ev.preventDefault();
        row.classList.remove('plan-drop');
        if (dragId && day && dragId !== id) planMove(day, dragId, id);
        dragId = null;
      });
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

  /* per-company colour wash for schedule rows — the company's own tint at
     ~65% alpha over the sage card, so each row carries its colour. Used
     when the row's company is unambiguous (single coy, or the group coy). */
  function rowWash(coys, coy) {
    var c = coy || (coys && coys.length === 1 ? coys[0] : null);
    if (!c) return '';
    return ' style="background:' + coyStyle(c).cbA + '"';
  }

  /* tiny stroke icon set (inline SVG, currentColor) — replaces the old
     labelled colour boxes with symbol + number */
  var ICONS = {
    mov: '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7"/>',
    bus: '<rect x="2" y="3" width="12" height="8.5" rx="2"/><path d="M2 7.2h12"/><circle cx="5.2" cy="13" r="1.2"/><circle cx="10.8" cy="13" r="1.2"/>',
    veh: '<rect x="1.5" y="4" width="8" height="6.5" rx="1"/><path d="M9.5 6h3.2l1.8 2.6v1.9h-5"/><circle cx="4.5" cy="12.5" r="1.2"/><circle cx="11.5" cy="12.5" r="1.2"/>',
    coy: '<path d="M3 1.8v12.4"/><path d="M3 2.8h8.5L9.7 5.5l1.8 2.7H3"/>',
    day: '<rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/>',
    warn: '<path d="M8 2.2 14.3 13.2H1.7L8 2.2z"/><path d="M8 6.6v3M8 11.5h.01"/>',
    clock: '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.3 1.7"/>'
  };
  function svgIcon(name) {
    return '<svg class="ic" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICONS[name] || '') + '</svg>';
  }

  function renderStats(list) {
    var s = statsFor(list || filteredEntries());
    var warn = s.flags + s.tbc;
    var items = [
      ['mov', s.movements, 'Movements', ''],
      ['bus', s.buses, 'Buses needed', ''],
      ['veh', s.veh, 'Own vehicles', ''],
      ['coy', s.groups, 'Companies', ''],
      ['day', s.days, 'Days covered', '']
    ];
    if (warn) items.push(['warn', warn, 'Flagged / TBC', 'warn']);
    $('statsbar').innerHTML = items.map(function (it) {
      return '<span class="sitem ' + it[3] + '" title="' + it[2] + '" aria-label="' + it[2] + ': ' + it[1] + '">' +
        svgIcon(it[0]) + '<span class="v">' + it[1] + '</span></span>';
    }).join('');
  }

  /* neutral icon+count cluster for group headers (replaces coloured pills) */
  function gstatsHTML(n, buses, veh, tbc) {
    return '<span class="gstats">' +
      '<span class="gstat" title="' + n + ' movements">' + svgIcon('mov') + n + '</span>' +
      (buses ? '<span class="gstat" title="' + buses + ' buses">' + svgIcon('bus') + buses + '</span>' : '') +
      (veh ? '<span class="gstat" title="' + veh + ' own vehicles">' + svgIcon('veh') + veh + '</span>' : '') +
      (tbc ? '<span class="gstat tbc" title="timing TBC">' + svgIcon('clock') + 'TBC</span>' : '') +
      '</span>';
  }

  function coyChipsHTML(coys) {
    return coys.map(function (c) {
      var st = coyStyle(c);
      return '<span class="coychip"><i class="dot" style="background:' + st.cc + '"></i>' + esc(c) + '</span>';
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
          gstatsHTML(list.length, buses, veh, !!tbc) +
          '</div>' +
          '<div class="mov-wrap"><table class="mov">' + tableHead('date', poc) + '<tbody>' +
          list.map(function (e) { return '<tr' + rowWash(e.coys) + '>' + rowCells(e, 'date', poc) + '</tr>'; }).join('') +
          '</tbody></table></div>';
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
          '<div class="chead" style="background:' + st.cb + '"><div class="dateline">' +
          '<span class="coychip" style="font-size:13px;padding:4px 12px;background:var(--paper)"><i class="dot" style="background:' + st.cc + '"></i>' + esc(coy) + '</span>' +
          '<span class="dsub">' + (coy === 'SCHWIDE' ? 'School-wide movements' : esc(coy) + ' Coy') + '</span></div>' +
          gstatsHTML(list.length, buses, veh, false) +
          '</div>' +
          '<div class="mov-wrap"><table class="mov">' + tableHead('coy', poc) + '<tbody>' +
          list.map(function (e) { return '<tr' + rowWash(null, coy) + '>' + rowCells(e, 'coy', poc) + '</tr>'; }).join('') +
          '</tbody></table></div>';
        c.appendChild(sec);
      });
      if (!any) {
        c.innerHTML = '<div class="empty"><h2 style="margin:0;color:var(--ink)">No movements match the current filters</h2>' +
          '<p class="hintline">Try enabling more companies, or turning “Keep only School ' + state.school + ' movements” off.</p></div>';
      }
    }
    if (stickySync) stickySync();   // re-rendered headers need their stuck state re-judged
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
    document.addEventListener('change', function (e) {
      if (e.target.classList && e.target.classList.contains('sheetsel')) {
        setSheetChoice(e.target.getAttribute('data-which'), e.target.value);
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
    $('btn-src-planner').addEventListener('click', function () { setSrc('plan'); saveStore(true); });

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
      railLabel(collapsed);
      lsSet('tcrs:rail', collapsed ? 'collapsed' : 'open');
    });

    // the rail toggle reads as a slim ‹ gutter on desktop, a full-width
    // "Options" bar once the rail stacks above the workspace (≤1140px)
    var railMQ = window.matchMedia ? window.matchMedia('(max-width: 1140px)') : null;
    function railLabel(collapsed) {
      var t = $('rail-toggle');
      t.textContent = (railMQ && railMQ.matches)
        ? (collapsed ? 'Options ▾' : 'Options ▴')
        : (collapsed ? '›' : '‹');
      t.title = collapsed ? 'Show the side panel' : 'Hide the side panel';
    }
    function syncRailMQ() {
      var collapsed = document.body.classList.contains('rail-collapsed');
      $('rail-toggle').setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      railLabel(collapsed);
    }
    if (railMQ) {
      if (railMQ.addEventListener) railMQ.addEventListener('change', syncRailMQ);
      else if (railMQ.addListener) railMQ.addListener(syncRailMQ);
      syncRailMQ();
    }

    var searchT = null;
    $('grid-search').addEventListener('input', function (e) {
      clearTimeout(searchT);
      searchT = setTimeout(applySearch, 140);   // debounce: full tbody rebuild per keystroke is the laggy path
    });
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

    // toast action button ("Undo" on deletes)
    $('toast-act').addEventListener('click', function () {
      var fn = toastAction && toastAction.fn;
      clearTimeout(toastTimer);
      $('toast').className = 'toast';
      this.hidden = true;
      toastAction = null;
      if (fn) fn();
    });

    // Recent changes: ↩ restores the data to just before that event
    $('hist-list').addEventListener('click', function (ev) {
      var b = ev.target.closest('.hrev');
      if (!b) return;
      var k = +b.dataset.k;
      if (!canRevert(k)) return;
      if (!b.dataset.armed) {      // two-step: it also drops every later change
        b.dataset.armed = '1';
        b.classList.add('armed');
        b.title = 'Click again to undo this change (later changes are undone too)';
        setTimeout(function () {
          if (!b.isConnected) return;
          b.dataset.armed = '';
          b.classList.remove('armed');
          b.title = 'Undo this change — later changes are undone too';
        }, 2600);
        return;
      }
      var e = (state.history || [])[k];
      if (!e || !revertEvent(k)) return;
      var n = k + 1;
      toast('Undid <b>' + esc(e.text) + '</b>' +
        (n > 1 ? ' and ' + (n - 1) + ' later change' + (n === 2 ? '' : 's') : '') + '.', false);
    });
    $('btn-logout').addEventListener('click', async function () {
      flushSave();
      try { await fetch(API_BASE + '/api/logout', { method: 'POST', credentials: 'include', headers: apiHeaders(false) }); } catch (e) { }
      dropToken();
      location.href = 'login';
    });

    document.querySelectorAll('.acc-head').forEach(function (h) {
      h.addEventListener('click', function () { h.parentElement.classList.toggle('open'); });
    });
  }

  /* ================================================== glass overlays == */
  function initOverlays() {
    /* movement detail modal — click any schedule row */
    document.addEventListener('click', function (ev) {
      var tr = ev.target.closest && ev.target.closest('table.mov tbody tr');
      if (!tr) return;
      var rows = Array.prototype.slice.call(document.querySelectorAll('table.mov tbody tr'));
      var idx = rows.indexOf(tr);
      var es = filteredEntries();
      if (idx > -1 && es[idx]) openMovementModal(es[idx]);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeOverlays(); });

    var slideT = null;
    /* direction-aware slide on tab + sub-tab switches — capture phase so the
       class lands before app's own handlers flip the panel display */
    document.addEventListener('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('#btn-tab-schedule, #btn-tab-grid, #btn-src-icrf, #btn-src-tl, #btn-src-planner');
      if (!b) return;
      var cls;
      if (b.id === 'btn-tab-schedule') cls = 'slide-r';
      else if (b.id === 'btn-tab-grid') cls = 'slide-l';
      else {
        var cur = document.querySelector('#btn-src-icrf.on, #btn-src-tl.on, #btn-src-planner.on');
        var from = cur ? (cur.id === 'btn-src-icrf' ? 'icrf' : cur.id === 'btn-src-tl' ? 'tl' : 'plan') : 'icrf';
        var to = b.id === 'btn-src-icrf' ? 'icrf' : b.id === 'btn-src-tl' ? 'tl' : 'plan';
        var ORD = { icrf: 0, tl: 1, plan: 2 };
        if (to === from) return;
        cls = 'slide-' + (ORD[to] > ORD[from] ? 'r2' : 'l2');
      }
      document.body.classList.remove('slide-l', 'slide-r', 'slide-l2', 'slide-r2');
      document.body.classList.add(cls);
      /* pause backdrop-filters for the slide's duration (see body.sliding CSS) */
      document.body.classList.add('sliding');
      clearTimeout(slideT);
      slideT = setTimeout(function () { document.body.classList.remove('sliding'); }, 560);
    }, true);
  }

  /* ------------------------------------------------ sticky head sync -- */
  /* .chead panes blur only while actually stuck (rows slide underneath);
     everywhere else the blur is a visual no-op on the static pools. */
  var stickySync = null;
  function initStickyHeads() {
    var topbarH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')) || 64;
    function update() {
      stickySync = update;          // cheap: also safe to call straight after a re-render
      var heads = document.querySelectorAll('.chead');
      for (var i = 0; i < heads.length; i++) {
        var r = heads[i].getBoundingClientRect();
        heads[i].classList.toggle('stuck', r.top <= topbarH + 1 && r.bottom > topbarH);
      }
    }
    var ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      (window.requestAnimationFrame || function (f) { setTimeout(f, 16); })(function () {
        ticking = false;
        update();
      });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    update();
  }

  function openMovementModal(e) {
    closeOverlays();
    var scrim = document.createElement('div');
    scrim.className = 'ov-scrim';
    document.body.appendChild(scrim);
    var tm = e.timeStart === 'TBC' ? 'TBC'
      : (e.timeStart || '') + (e.timeEnd && e.timeEnd !== e.timeStart ? '–' + fmtHHMM(e.timeEnd) : '');
    var d = document.createElement('div');
    d.className = 'ov-dlg';
    d.innerHTML =
      '<div class="hd"><span class="tm">' + esc(tm) + '</span>' +
      '<b>' + esc(e.activity || 'Movement') + '</b><span class="x" title="Close">✕</span></div>' +
      '<div class="grid">' +
      '<span class="k">Company</span><span class="v">' + esc((e.coys || []).join(' + ') || '—') + '</span>' +
      '<span class="k">Run</span><span class="v">' + esc((e.from || '—') + ' → ' + (e.to || 'same point')) + '</span>' +
      '<span class="k">Vehicles</span><span class="v">' + esc(T.vehicleLabel(e)) + '</span>' +
      '<span class="k">POC</span><span class="v">' + (state.poc ? esc(e.officer || '—') : 'hidden') + '</span>' +
      '<span class="k">Contact</span><span class="v">' + (state.poc ? esc(e.phone || '—') : 'hidden') + '</span>' +
      '<span class="k">Source</span><span class="v">' + esc(e.source || '—') + '</span>' +
      '</div><div class="ft"><button class="btn" data-ov="close">Close</button>' +
      '<button class="btn pri" data-ov="edit">Open in live sheet</button></div>';
    document.body.appendChild(d);
    d.querySelector('[data-ov="close"]').onclick = closeOverlays;
    d.querySelector('.x').onclick = closeOverlays;
    d.querySelector('[data-ov="edit"]').onclick = function () { closeOverlays(); setTab('grid'); setSrc('icrf'); };
    scrim.onclick = closeOverlays;
  }

  function closeOverlays() {
    var s = document.querySelector('.ov-scrim'), d = document.querySelector('.ov-dlg');
    if (s) s.remove(); if (d) d.remove();
  }

  /* ------------------------------------------------------- tap sound -- */
  /* one short tap.mp3 tick on every click. Web Audio path: the file is
     fetched + decoded once (kicked off at pointerdown, within the gesture),
     then a buffer source plays per click — reliable in every browser.
     Any failure is warned to the console instead of being swallowed. */
  var tapCtx = null, tapBuf = null, tapLoading = false, tapVol = 0.4;
  var typeBuf = null, typeLoading = false, typeLast = 0;
  function tapPlayBuf() {
    try {
      var src = tapCtx.createBufferSource();
      src.buffer = tapBuf;
      var g = tapCtx.createGain();
      g.gain.value = tapVol;
      src.connect(g); g.connect(tapCtx.destination);
      src.start();
    } catch (e) { console.warn('tap sound failed:', e && e.message); }
  }
  function typePlayBuf() {
    try {
      var src = tapCtx.createBufferSource();
      src.buffer = typeBuf;
      var g = tapCtx.createGain();
      g.gain.value = tapVol;
      src.connect(g); g.connect(tapCtx.destination);
      src.start();
    } catch (e) { console.warn('type sound failed:', e && e.message); }
  }
  function tapPrepare() {
    try {
      if (!tapCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        tapCtx = new AC();
      }
      if (tapCtx.state === 'suspended') tapCtx.resume().catch(function () { });
      if (!tapBuf && !tapLoading) {
        tapLoading = true;
        fetch('tap.mp3')
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
          .then(function (ab) {
            tapCtx.decodeAudioData(ab, function (buf) { tapBuf = buf; },
              function (e) { tapLoading = false; console.warn('tap sound decode failed:', e && e.message); });
          })
          .catch(function (e) { tapLoading = false; console.warn('tap sound load failed:', e && e.message); });
      }
      if (!typeBuf && !typeLoading) {
        typeLoading = true;
        fetch('type.mp3')
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
          .then(function (ab) {
            tapCtx.decodeAudioData(ab, function (buf) { typeBuf = buf; },
              function (e) { typeLoading = false; console.warn('type sound decode failed:', e && e.message); });
          })
          .catch(function (e) { typeLoading = false; console.warn('type sound load failed:', e && e.message); });
      }
    } catch (e) { console.warn('tap sound init failed:', e && e.message); }
  }
  function playTap() {
    tapPrepare();                 // also runs on the very first click
    if (tapCtx && tapBuf) tapPlayBuf();
  }
  /* typing sound: type.mp3 per real keystroke in a textbox. Throttled so
     held-down keys / autorepeat don't stack into a buzz (min 60 ms gap). */
  function isTypeTarget(t) {
    if (!t || !t.tagName) return false;
    if (t.tagName === 'TEXTAREA' || t.isContentEditable) return true;
    if (t.tagName === 'INPUT') {
      var ty = (t.getAttribute('type') || 'text').toLowerCase();
      return ty === 'text' || ty === 'search' || ty === 'password' ||
        ty === 'number' || ty === 'email' || ty === 'url';
    }
    return false;
  }
  function playType() {
    var now = Date.now();
    if (now - typeLast < 60) return;
    typeLast = now;
    tapPrepare();
    if (tapCtx && typeBuf) typePlayBuf();
  }
  function initTapSound() {
    document.addEventListener('pointerdown', tapPrepare, true);
    document.addEventListener('click', playTap, true);
    document.addEventListener('input', function (e) {
      if (isTypeTarget(e.target)) playType();
    }, true);
  }

  /* -------------------------------------------------------- settings -- */
  /* glass look + audio preferences, stored app-wide (not per school) */
  var PREF_DEFAULTS = { tint: 22, sat: 215, bri: 100, vol: 40, music: false, hue: 14 };
  var prefs = null, musicAudio = null, musicWaiting = false;

  function loadPrefs() {
    try {
      var p = JSON.parse(lsGet('tcrs:prefs') || '{}');
      var out = {}, k;
      for (k in PREF_DEFAULTS) out[k] = (p[k] !== undefined ? p[k] : PREF_DEFAULTS[k]);
      return out;
    } catch (e) {
      var copy = {}, k2;
      for (k2 in PREF_DEFAULTS) copy[k2] = PREF_DEFAULTS[k2];
      return copy;
    }
  }
  function savePrefs() {
    try { lsSet('tcrs:prefs', JSON.stringify(prefs)); } catch (e) { }
  }
  function applyGlassPrefs() {
    var r = document.documentElement.style;
    r.setProperty('--theme-h', String(prefs.hue));
    r.setProperty('--theme-b', (prefs.bri / 100).toFixed(3));
    r.setProperty('--glass-tint', (prefs.tint / 100).toFixed(3));
    r.setProperty('--glass-sat', prefs.sat + '%');
  }
  function musicVol() { return Math.max(0, Math.min(1, tapVol * 0.6)); }
  function musicStart() {
    try {
      if (!musicAudio) {
        musicAudio = new Audio('lofi.mp3');
        musicAudio.loop = true;
        musicAudio.preload = 'auto';
      }
      musicAudio.volume = musicVol();
      var pr = musicAudio.play();
      if (pr && pr.catch) pr.catch(function () {
        /* autoplay blocked — start on the next user gesture */
        if (musicWaiting) return;
        musicWaiting = true;
        var go = function () {
          musicWaiting = false;
          document.removeEventListener('pointerdown', go, true);
          if (prefs.music) musicStart();
        };
        document.addEventListener('pointerdown', go, true);
      });
    } catch (e) { console.warn('music failed:', e && e.message); }
  }
  function musicStop() {
    if (musicAudio) { try { musicAudio.pause(); } catch (e) { } }
    musicWaiting = false;
  }
  function musicSyncBtn() {
    var b = $('set-music');
    if (!b) return;
    b.classList.toggle('on', !!prefs.music);
    b.setAttribute('aria-pressed', prefs.music ? 'true' : 'false');
    b.querySelector('.sp-lbl').textContent = prefs.music ? 'On' : 'Off';
  }
  function syncSettingsUI() {
    var set = function (id, v, label) {
      var el = $(id);
      if (el) el.value = v;
      var lbl = $(id + '-v');
      if (lbl) lbl.textContent = label;
    };
    set('set-hue', prefs.hue, prefs.hue + '°');
    set('set-tint', prefs.tint, prefs.tint + '%');
    set('set-refract', prefs.sat, prefs.sat + '%');
    set('set-bright', prefs.bri, prefs.bri + '%');
    set('set-vol', prefs.vol, prefs.vol + '%');
    musicSyncBtn();
  }

  function initSettings() {
    var btn = $('btn-settings'), panel = $('settings-panel');
    if (!btn || !panel) return;   // pages without the panel (test suites)
    prefs = loadPrefs();
    tapVol = prefs.vol / 100;
    applyGlassPrefs();
    syncSettingsUI();

    function close() { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = panel.hidden;
      panel.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) syncSettingsUI();
    });
    document.addEventListener('click', function (e) {
      if (!panel.hidden && !(e.target.closest && e.target.closest('.set-switch'))) close();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

    var bindRange = function (id, key, apply, suffix) {
      $(id).addEventListener('input', function () {
        prefs[key] = parseInt(this.value, 10);
        $(id + '-v').textContent = prefs[key] + (suffix || '%');
        apply();
        savePrefs();
      });
    };
    bindRange('set-hue', 'hue', applyGlassPrefs, '°');
    bindRange('set-tint', 'tint', applyGlassPrefs);
    bindRange('set-refract', 'sat', applyGlassPrefs);
    bindRange('set-bright', 'bri', applyGlassPrefs);
    bindRange('set-vol', 'vol', function () {
      tapVol = prefs.vol / 100;
      if (musicAudio) musicAudio.volume = musicVol();
    });

    $('set-music').addEventListener('click', function () {
      prefs.music = !prefs.music;
      musicSyncBtn();
      savePrefs();
      if (prefs.music) musicStart(); else musicStop();
    });

    if (prefs.music) musicStart();   // may be blocked — musicStart waits for a gesture
  }

  (function () {
    var saved = parseInt(lsGet('tcrs:school'), 10);
    if (saved >= 1 && saved <= 4 && !/^#auto/.test(location.hash)) state.school = saved;
  })();
  init();
  initSchoolMenu();
  initMonthMenu();
  initOverlays();
  initTapSound();
  initSettings();
  initStickyHeads();
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

  /* Each month is its own workspace (its own key on the server): park the
     current one, blank the screen, then reopen the chosen month's files and
     edits — or, for a month never used, leave a fresh empty template. */
  async function setMonth(k) {
    k = monthStr(k);
    var cur = state.model ? monthKey() : lsGet(lastKey());
    if (cur && monthStr(cur) === k && state.model) return;
    flushSave();
    clearTimeout(saveTimer);
    savePending = false;

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
    lsSet(lastKey(), schoolPart() + '-' + k);
    maybeCombine();               // no files → clears the results and shows the empty state
    syncControls();
    syncMonthBtn();
    await restoreWorkspace(k);
    syncMonthBtn();
  }

  /* ------------------------------------------------------ month menu -- */
  function currentMonthKey() {
    if (state.model) return monthKey();
    var last = lsGet(lastKey());
    return (last && last.indexOf(schoolPart() + '-') === 0) ? monthStr(last) : null;
  }
  function syncMonthBtn() {
    var mo = $('month-cur-mo'), yr = $('month-cur-yr');
    if (!mo || !yr) return;
    var k = currentMonthKey(), p = k ? monthStr(k).split('-') : null;
    mo.textContent = p ? (MONTH_FULL[(+p[0]) - 1] || '?').slice(0, 3).toUpperCase() : '＋';
    yr.textContent = p ? p[1] : 'new';
  }
  function renderMonthMenu() {
    var menu = $('month-menu');
    if (!menu) return;
    var cur = currentMonthKey();
    var html = listMonths().map(function (k) {
      var p = monthStr(k).split('-');
      return '<button type="button" role="menuitem" data-mk="' + esc(k) + '"' +
        (cur === k ? ' class="on"' : '') + '><span class="sm-mark">' +
        esc((MONTH_FULL[(+p[0]) - 1] || '?').slice(0, 1)) + '</span><span>' +
        esc(monthLabel(k)) + '<span class="sm-sub">School ' + state.school + ' · ' +
        esc(p[1]) + '</span></span></button>';
    }).join('');
    var y0 = new Date().getFullYear();
    var years = []; for (var y = y0 - 1; y <= y0 + 3; y++) years.push(y);
    var selY = cur ? (+monthStr(cur).split('-')[1]) : y0;
    if (years.indexOf(selY) === -1) selY = y0;
    var selM = 0;
    if (cur) { selM = (+monthStr(cur).split('-')[0]) % 12; }   // default: month after the current one
    html += '<div class="mm-new"><select id="mm-m">' +
      MONTH_FULL.map(function (n, i) {
        return '<option value="' + (i + 1) + '"' + (selM === i ? ' selected' : '') + '>' + n.toUpperCase() + '</option>';
      }).join('') +
      '</select><select id="mm-y">' + years.map(function (y) {
        return '<option' + (selY === y ? ' selected' : '') + '>' + y + '</option>';
      }).join('') + '</select><button type="button" id="mm-start" title="Open this month as a fresh template">Start</button></div>';
    menu.innerHTML = html;
  }
  function initMonthMenu() {
    var btn = $('month-btn'), menu = $('month-menu');
    if (!btn || !menu) return;
    function close() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) renderMonthMenu();
    });
    menu.addEventListener('click', function (e) {
      var b = e.target.closest && (e.target.closest('button[data-mk]') || e.target.closest('#mm-start'));
      if (!b) return;
      e.stopPropagation();
      var k;
      if (b.id === 'mm-start') {
        k = schoolPart() + '-' + $('mm-m').value + '-' + $('mm-y').value;
      } else {
        k = b.dataset.mk;
      }
      close();
      setMonth(k);
    });
    document.addEventListener('click', function (e) {
      if (!menu.hidden && !(e.target.closest && e.target.closest('.month-switch'))) close();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
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
        var r = await fetch(API_BASE + '/api/state', { credentials: 'include', headers: apiHeaders(false) });
        if (r.status === 401) { dropToken(); location.href = 'login'; return; }
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

  /* reopen whatever this school's profile had open last — or, with forceKey,
     one specific month (its own files + edits, server memory first) */
  async function restoreWorkspace(forceKey) {
    var rl = null, ll = null, sp = 's' + state.school + '-';
    var key, rRec;
    if (forceKey) {
      key = monthStr(forceKey);
      rRec = (remote.doc && remote.doc.months && remote.doc.months[key]) || null;
    } else {
      if (remote.doc && remote.doc.last) {
        // only months that belong to this school's profile
        if (remote.doc.last.indexOf(sp) === 0) rl = remote.doc.last;
        else Object.keys(remote.doc.months || {}).forEach(function (k) {
          if (rl === null && k.indexOf(sp) === 0) rl = k;
        });
      }
      ll = lsGet(lastKey());
      if (ll && ll.indexOf(sp) !== 0) ll = null;
      var lRec = ll && readLocal(ll);
      var ru = rRec ? ((rRec.edits && rRec.edits.updatedAt) || rRec.savedAt || '') : '';
      key = (ll && lRec && String(lRec.updatedAt || '') > ru) ? ll : (rl || ll);
      if (!key) return;
      rRec = rl && key === rl && remote.doc.months[rl];
    }

    var files = rRec && rRec.files, fromLocal = false;
    if (!files || !(files.icrf || files.tl)) {
      try { files = JSON.parse(lsGet(filesKey(key)) || 'null'); fromLocal = true; } catch (e) { files = null; }
    }
    if (!files || !(files.icrf || files.tl)) return;
    try {
      state.files = { icrf: files.icrf, tl: files.tl };
      state.icrfWb = state.tlWb = state.icrfName = state.tlName = null;
      if (files.icrf) {
        state.icrfWb = await loadWorkbook(b64ToBuf(files.icrf.b64)); state.icrfName = files.icrf.name;
        renderUploadStatus('icrf', { ok: true, msg: 'restored — ' + (chosenSheet('icrf', state.icrfWb) || {}).name });
      }
      if (files.tl) {
        state.tlWb = await loadWorkbook(b64ToBuf(files.tl.b64)); state.tlName = files.tl.name;
        renderUploadStatus('tl', { ok: true, msg: 'restored — ' + (chosenSheet('tl', state.tlWb) || {}).name });
      }
      remote.filesDirty = fromLocal && remote.online;
      remote.localFilesDirty = false;
      if (!fromLocal) lsSet(filesKey(key), JSON.stringify(state.files));
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
    setMonth: setMonth, listMonths: listMonths,
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
    planMove: planMove, planSaveDraft: planSaveDraft,
    planSubmit: planSubmit, planDiscard: planDiscard,
    renderPlanner: renderPlanner,
    renderUploadStatus: renderUploadStatus,
    handleFile: handleFile, restoreWorkspace: restoreWorkspace,
    chosenSheet: chosenSheet, sheetPickerHtml: sheetPickerHtml,
    applySheetData: applySheetData, pushHistory: pushHistory,
    validateSaved: validateSaved, readLocal: readLocal
  };
})();
