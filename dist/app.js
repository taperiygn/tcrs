/* =====================================================================
 * TCRS — app.js : UI orchestration, live-sheet binding, styled export
 * ===================================================================== */
(function () {
  'use strict';

  var T = window.TCRS;

  /* ---------------------------------------------------------- state -- */
  var state = {
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
    icrfGrid: null, tlGrid: null
  };

  var COY_COLORS = {
    '1ST': ['#8a6d3b', '#f2ecdf'],
    '2ND': ['#5d6b8a', '#e9edf4'],
    '3RD': ['#b26a00', '#f9ecd9'],
    '4TH': ['#b3403c', '#f9e9e7'],
    '5TH': ['#2e7d32', '#e7f2e7'],
    '6TH': ['#1565c0', '#e8f1fa'],
    '7TH': ['#6a4fa3', '#f0ebf8'],
    '8TH': ['#7a5546', '#f2e8e3'],
    'SCHWIDE': ['#455a64', '#eceff1']
  };
  function coyStyle(c) {
    var p = COY_COLORS[c];
    if (!p) return { cc: '#16324a', cb: '#eef2f7' };
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
  var STORE_PREFIX = 'tcrs:v3:';
  function storeKey() {
    return STORE_PREFIX + state.model.month + '-' + state.model.year;
  }
  function saveStore() {
    if (!state.model) return;
    try {
      localStorage.setItem(storeKey(), JSON.stringify({
        v: 3, at: Date.now(),
        updatedAt: new Date().toISOString(),
        entries: state.entries,
        tlLines: state.tlLines,
        skipped: state.skipped
      }));
      $('save-pill').classList.remove('unsaved');
      $('save-pill').textContent = 'saved on this device';
    } catch (e) { /* storage full/unavailable */ }
  }
  function loadStore() {
    try {
      var raw = localStorage.getItem(storeKey());
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (d && d.v === 3 && Array.isArray(d.entries) && d.entries.length) {
        return d;
      }
    } catch (e) { }
    return null;
  }
  function discardStore(silent) {
    if (state.model) { try { localStorage.removeItem(storeKey()); } catch (e) { } }
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
    refreshDerived();
    rerenderSrc();
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

  function clearFile(which) {
    if (which === 'icrf') { state.icrfWb = null; state.icrfName = ''; $('file-icrf').value = ''; }
    else { state.tlWb = null; state.tlName = ''; $('file-tl').value = ''; }
    var box = $(which === 'icrf' ? 'icrf-status' : 'tl-status');
    var card = $(which === 'icrf' ? 'up-icrf' : 'up-tl');
    box.hidden = true; box.innerHTML = '';
    card.classList.remove('done');
    maybeCombine();
  }

  /* -------------------------------------------------------- combine -- */
  function maybeCombine() {
    var model = null;

    if (state.icrfWb && state.tlWb) {
      try {
        var icrfSheet = pickICRFSheet(state.icrfWb);
        var tlSheet = pickTLSheet(state.tlWb);
        model = T.parseWorkbooks(
          { worksheets: [icrfSheet] },
          { worksheets: [tlSheet] });
      } catch (err) {
        console.error(err);
        toast('Parsing failed: ' + esc(String(err && err.message || err)), true);
        model = null;
      }
    }

    if (!model) {
      state.model = null; state.entries = []; state.restoredAt = null;
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

    // company defaults
    state.coys = {};
    model.companies.forEach(function (c) { if (c !== 'SCHWIDE') state.coys[c] = true; });

    // restore saved edits for this month if present
    var saved = loadStore();
    if (saved) {
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

    // pristine snapshot ("Reset edits") — plain copy, order preserved as parsed
    state.pristine = JSON.parse(JSON.stringify({
      entries: model.entries, tlLines: model.tlLines, skipped: model.icrfSkipped
    }));

    // line ids (used by the live sheet and manual lines)
    normalizeTLLines();

    renderMonthBanner();
    renderChips();
    renderNotes();
    refreshDerived();
    $('results').hidden = false;
    $('empty-state').hidden = true;
    $('btn-export').disabled = false;
    $('btn-print').disabled = false;
    setSrc(state.srcTab);

    var s = statsFor(filteredEntries());
    toast('<b>Combined.</b> ' + s.movements + ' movements over ' + s.days + ' days.' +
      (saved ? ' Your previous edits were restored.' : ''));
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
      state.model.companies = T.sortCoys(state.model.companies);
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
    refreshDerived();
    rerenderSrc();
  }

  /* ===================================================== ICRF view ==== */
  function icrfColA(e) {
    var part = e.coys[0] === 'SCHWIDE' ? 'SCHWIDE'
      : (e.coys.length ? e.coys.map(function (c) { return c + ' COY'; }).join(' / ') : '? COY');
    return 'SCH 4 - ' + part + ' - ' + (e.activity || '');
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
        var p = T.parseICRFColA(raw);
        if (!p.ok) return { ok: false, msg: 'keep "SCH 4 - <6TH COY> - <ACTIVITY>" — ' + p.msg };
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
    var p = T.parseICRFColA(raw);
    if (!p.ok) return { ok: false, msg: 'keep "SCH 4 - <6TH COY> - <ACTIVITY>" — ' + p.msg };
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
    refreshDerived();
    rerenderSrc();
    toast('Row ' + s.row + ' brought back — <b>set its start date next</b> so it lands in the schedule.', false);
    return { ok: true };
  }

  function addIcrfRow() {
    var maxRow = 0;
    state.entries.forEach(function (e) { if (e.row > maxRow) maxRow = e.row; });
    var coy = enabledCoys()[0] || '1ST';
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
    updateSavePill();
    rerenderSrc();
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
    updateSavePill();
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
    refreshDerived();
    rerenderSrc();
  }

  /* ================================================ Troop-lift view === */
  function findTLLine(id) {
    for (var i = 0; i < state.tlLines.length; i++) {
      if (state.tlLines[i].id === String(id)) return state.tlLines[i];
    }
    return null;
  }
  function lineEntry(l) {
    if (l.entryId) return findEntry(l.entryId);
    if (l.status === 'ok' && l.row != null) return findEntry('t' + l.row);
    return null;
  }

  function tlBlocks() {
    var blocks = [], title = '', cur = null;
    state.tlLines.forEach(function (l) {
      if (l.kind === 'title') { title = l.text; return; }
      if (l.kind === 'date') {
        cur = { key: 'b' + l.row, date: l.date, tbc: !!l.tbc, lines: [] };
        blocks.push(cur);
        return;
      }
      if (!cur) { cur = { key: 'b0', date: null, lines: [] }; blocks.push(cur); }
      cur.lines.push({ id: l.id, status: l.status || 'ok', text: l.text || '' });
    });
    return { blocks: blocks, title: title };
  }

  function commitTL(id, raw) {
    var l = findTLLine(id);
    if (!l) return { ok: false, msg: 'line not found' };
    if (!raw) return { ok: false, msg: 'line is empty — use ✕ to delete it' };
    var p = T.parseTLLineText(raw);
    if (!p.ok) {
      return { ok: false, msg: 'expected: <HHMM|TBC> <FROM> - <TO> <N> BUSES|TONNERS (<COY ACTIVITY>)' };
    }
    var e = lineEntry(l);
    if (!e) {
      e = {
        id: (l.row != null && !l.entryId) ? 't' + l.row : l.id,
        source: (l.status === 'new' || l.dup || l.entryId) ? 'MANUAL' : 'TROOPLIFT',
        via: 'tl', rawText: raw,
        date: l.date || '', eDate: l.date || '', dayDiff: 0, nextDay: false,
        officer: '', phone: '', unit: '', row: l.row,
        flagged: false, tbc: false, edited: true
      };
      state.entries.push(e);
    }
    T.applyTLFields(e, p.fields);
    e.edited = true;
    e.date = l.date || e.date || '';
    e.eDate = e.date;
    e.dayDiff = 0; e.nextDay = false;
    e.rawText = raw;
    l.status = 'ok'; l.text = raw; l.entryId = e.id;
    p.fields.coys.forEach(registerCoy);
    saveStore();
    refreshDerived();
    return { ok: true };
  }

  function addTLLine(blockKey) {
    var b = tlBlocks().blocks.filter(function (x) { return String(x.key) === String(blockKey); })[0];
    if (!b) return;
    var idx = -1;
    for (var i = 0; i < state.tlLines.length; i++) {
      var l = state.tlLines[i];
      if (l.kind === 'line' && (l.date || null) === (b.date || null)) idx = i;
    }
    var nl = { id: 'm' + Date.now(), row: null, kind: 'line', status: 'new', text: '', date: b.date || null, entryId: null };
    if (idx > -1) state.tlLines.splice(idx + 1, 0, nl);
    else state.tlLines.push(nl);
    saveStore();
    updateSavePill();
    rerenderSrc();
  }
  function dupTLLine(id) {
    var l = findTLLine(id);
    if (!l) return;
    var copy = { id: 'm' + Date.now() + Math.floor(Math.random() * 99), row: null, kind: 'line', status: 'new', text: l.text, date: l.date || null, entryId: null, dup: true };
    state.tlLines.splice(state.tlLines.indexOf(l) + 1, 0, copy);
    saveStore();
    updateSavePill();
    rerenderSrc();
  }
  function delTLLine(id) {
    var l = findTLLine(id);
    if (!l) return;
    var e = lineEntry(l);
    if (e) state.entries.splice(state.entries.indexOf(e), 1);
    state.tlLines.splice(state.tlLines.indexOf(l), 1);
    l.entryId && delete l.entryId;
    saveStore();
    refreshDerived();
    rerenderSrc();
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
    mountSrc();
    applySearch();
  }

  function mountSrc() {
    if (!window.TCRSSheet || !state.model) return;
    if (!state.icrfGrid) {
      state.icrfGrid = TCRSSheet.mount($('icrf-container'), {
        columns: ICRF_COLS,
        getRows: icrfRows,
        commit: commitICRF,
        onAdd: addIcrfRow, onDup: dupIcrf, onDel: delIcrf,
        note: rowsNote
      });
    } else {
      state.icrfGrid.rerender();
    }
    if (!state.tlGrid) {
      state.tlGrid = TCRSSheet.mountTL($('tl-container'), {
        getBlocks: tlViewBlocks,
        commitLine: commitTL,
        dupLine: dupTLLine,
        delLine: delTLLine,
        addLine: addTLLine,
        entryFor: entryForLine,
        note: tlNote
      });
    } else {
      state.tlGrid.rerender();
    }
  }

  function rerenderSrc() {
    if (state.icrfGrid) state.icrfGrid.rerender();
    if (state.tlGrid) state.tlGrid.rerender();
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

  function tlViewBlocks() {
    return tlBlocks().blocks;
  }
  function entryForLine(line) {
    var l = findTLLine(line.id);
    return l ? lineEntry(l) : null;
  }
  function tlNote(total, shown, blocks) {
    var title = tlBlocks().title;
    var n = blocks.length;
    return title + ' · ' + n + ' days · ' + shown + ' of ' + total + ' lines shown' +
      (shown !== total ? ' — the rest hidden by your filters' : '');
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
    renderStats(filteredEntries());
    drawView();
    renderMonthBanner();
    if (state.tab === 'grid') rerenderSrc();
    updateSavePill();
  }

  function updateSavePill() {
    var pill = $('save-pill');
    if (!state.model) { pill.textContent = ''; return; }
    pill.classList.add('show');
    if (state.restoredAt) {
      pill.textContent = 'edits restored — saved ' + String(state.restoredAt).slice(0, 16).replace('T', ' ');
    } else {
      pill.textContent = 'edits auto-save on this device';
    }
  }

  function renderMonthBanner() {
    var m = state.model;
    if (!m) { $('month-banner').hidden = true; return; }
    $('month-banner').hidden = false;
    $('mb-top').textContent = m.monthName ? m.monthName.slice(0, 3) : '—';
    $('mb-mon').textContent = m.year;
    var days = {};
    filteredEntries().forEach(function (e) { if (e.date) days[e.date] = 1; });
    $('mb-day').textContent = Object.keys(days).length;
    $('mb-title').textContent = m.monthName + ' ' + m.year + ' · School 4 combined schedule';
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
    state.model.companies.forEach(function (c) {
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

  function renderStats(entries) {
    var s = statsFor(entries);
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

  function drawView() {
    var entries = filteredEntries();
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
        c.innerHTML = '<div class="empty"><h2 style="margin:0;color:var(--navy)">No movements match the current filters</h2>' +
          '<p class="hintline">Try enabling more companies, or turning “Keep only School 4 movements” off.</p></div>';
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
    wb.creator = 'TCRS School 4 Combined Movement Builder';
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

    var genNote = 'Assembled from ICRF (School 4 vehicles) + Troop Lift (buses/tonners) · generated ' +
      new Date().toISOString().slice(0, 16).replace('T', ' ') +
      (state.onlyS4 ? ' · School 4 movements only' : ' · ALL movements (incl. other units)') +
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

    /* sheet 1: By Date */
    {
      var ws = wb.addWorksheet('By Date', {
        pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5 } }
      });
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
      var ws2 = wb.addWorksheet('By Company', {
        pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5 } }
      });
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
      var ws3 = wb.addWorksheet('Data notes', { pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
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

    var buf = await wb.xlsx.writeBuffer();
    var blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'SCH4_' + m.monthName + '_' + m.year + '_Combined.xlsx';
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

    // tabs
    $('btn-tab-schedule').addEventListener('click', function () { setTab('schedule'); });
    $('btn-tab-grid').addEventListener('click', function () { setTab('grid'); });

    // live-sheet sub-tabs
    $('btn-src-icrf').addEventListener('click', function () { setSrc('icrf'); });
    $('btn-src-tl').addEventListener('click', function () { setSrc('tl'); });

    // schedule view
    $('view-date').addEventListener('click', function () { state.view = 'date'; refreshDerived(); });
    $('view-coy').addEventListener('click', function () { state.view = 'coy'; refreshDerived(); });

    $('opt-schwide').addEventListener('change', function (e) { state.schwide = e.target.checked; refresh(); });
    $('opt-onlys4').addEventListener('change', function (e) { state.onlyS4 = e.target.checked; refresh(); });
    $('opt-poc').addEventListener('change', function (e) {
      state.poc = e.target.checked;
      $('opt-poc-inline').checked = e.target.checked;
      refreshDerived();
    });
    $('opt-poc-inline').addEventListener('change', function (e) {
      state.poc = e.target.checked;
      $('opt-poc').checked = e.target.checked;
      refreshDerived();
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
    $('btn-print').addEventListener('click', function () { window.print(); });

    $('btn-sample').addEventListener('click', async function () {
      try {
        var a = await fetch('samples/ICRF.xlsx');
        var b = await fetch('samples/Troop Lift Sample.xlsx');
        if (!a.ok || !b.ok) throw new Error('not served');
        var ab = await a.arrayBuffer(); var bb = await b.arrayBuffer();
        state.icrfWb = await loadWorkbook(ab); state.icrfName = 'ICRF.xlsx (sample)';
        state.tlWb = await loadWorkbook(bb); state.tlName = 'Troop Lift Sample.xlsx (sample)';
        renderUploadStatus('icrf', { ok: true, msg: 'sample workbook — ' + state.icrfWb.worksheets[0].name });
        renderUploadStatus('tl', { ok: true, msg: 'sample workbook — ' + state.tlWb.worksheets[0].name });
        maybeCombine();
      } catch (err) {
        toast('Could not auto-load samples (works only over a local web server — e.g. <b>python3 -m http.server</b>). Drop the files manually instead.', true);
      }
    });

    $('new-row-date') && ($('new-row-date').dataset.default = '');
    $('grid-note-addrow') && ($('grid-note-addrow').hidden = false);
    document.querySelectorAll('.acc-head').forEach(function (h) {
      h.addEventListener('click', function () { h.parentElement.classList.toggle('open'); });
    });
  }

  /* auto-load samples when URL arrives with #auto (preview / demo shortcut) */
  if (/^#auto/.test(location.hash)) {
    if (location.hash === '#auto-coy') state.view = 'coy';
    if (location.hash === '#auto-grid') state.tab = 'grid';
    if (location.hash === '#auto-tl') { state.tab = 'grid'; state.srcTab = 'tl'; }
    setTimeout(function () { $('btn-sample').click(); }, 60);
  }

  init();
  setTab(state.tab);   // sync visibility with the (possibly hash-set) tab

  /* debug hook (used by tests / smoke runs; harmless otherwise) */
  window.__tcrs = {
    state: state,
    maybeCombine: maybeCombine,
    exportXlsx: exportXlsx,
    drawView: drawView,
    filteredEntries: filteredEntries,
    refresh: refresh,
    commitICRF: commitICRF,
    commitTL: commitTL,
    addIcrfRow: addIcrfRow, dupIcrf: dupIcrf, delIcrf: delIcrf,
    dupTLLine: dupTLLine, delTLLine: delTLLine, addTLLine: addTLLine,
    resetEdits: resetEdits,
    setTab: setTab, setSrc: setSrc,
    renderUploadStatus: renderUploadStatus
  };
})();
