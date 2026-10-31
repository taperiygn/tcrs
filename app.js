/* =====================================================================
 * TCRS — app.js : UI orchestration + styled .xlsx export
 * ===================================================================== */
(function () {
  'use strict';

  var T = window.TCRS;

  /* ---------------------------------------------------------- state -- */
  var state = {
    icrfWb: null, icrfName: '',
    tlWb: null, tlName: '',
    model: null,
    view: 'date',
    coys: {},            // enabled coy set
    schwide: true,
    onlyS4: true,
    poc: true
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
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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

  /* ------------------------------------------------------ file intake -- */
  async function loadWorkbook(arrayBuffer, which) {
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
      var wb = await loadWorkbook(buf, which);
      if (which === 'icrf') {
        state.icrfWb = wb; state.icrfName = file.name;
        renderUploadStatus('icrf', { ok: true, msg: 'loaded — awaiting Troop Lift…' });
      } else {
        state.tlWb = wb; state.tlName = file.name;
        renderUploadStatus('tl', { ok: true, msg: 'loaded — awaiting ICRF…' });
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
    if (info.clean === false) card.classList.remove('done');
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
    box.hidden = true;
    box.innerHTML = '';
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
      state.model = null;
      $('results').hidden = true;
      $('empty-state').hidden = false;
      $('month-banner').hidden = true;
      $('btn-export').disabled = true;
      $('btn-print').disabled = true;
      renderChips();
      renderNotes();
      return;
    }

    state.model = model;
    state.coys = {};
    model.companies.forEach(function (c) { if (c !== 'SCHWIDE') state.coys[c] = true; });

    renderMonthBanner();
    renderChips();
    renderNotes();
    renderStats(filteredEntries());
    renderResults();
    $('btn-export').disabled = false;
    $('btn-print').disabled = false;

    var s = statsFor(T.filterEntries(model, { companies: enabledCoys(), onlySchool4: state.onlyS4 }));
    toast('<b>Combined.</b> ' + s.movements + ' movements over ' + s.days + ' days.');
  }

  function renderStats(entries) {
    var s = statsFor(entries);
    var tbcCount = entries.filter(function (e) { return e.timeStart === 'TBC'; }).length;
    $('statsbar').innerHTML =
      stat(s.movements, 'Movements', '') +
      stat(s.buses, 'Buses needed', 'bus') +
      stat(s.veh, 'Own vehicles', 'veh') +
      stat(s.groups, 'Companies', '') +
      stat(s.days, 'Days covered', '') +
      stat(s.flags + tbcCount ? (s.flags + tbcCount) : 0, 'Flagged / TBC', s.flags + tbcCount > 0 ? 'warn' : '');
    function stat(v, k, cls) {
      return '<div class="stat ' + cls + '"><div class="v">' + v + '</div><div class="k">' + k + '</div></div>';
    }
  }

  function statsFor(entries) {
    var s = { movements: entries.length, buses: 0, veh: 0, days: new Set(), flags: 0, coys: new Set() };
    entries.forEach(function (e) {
      if (e.date) s.days.add(e.date);
      if (e.coys) e.coys.forEach(function (c) { s.coys.add(c); });
      if (e.kind === 'bus') s.buses += (e.qty || 0);
      else s.veh += (e.qty || 0);
      if (e.flagged) s.flags++;
    });
    return { movements: s.movements, buses: s.buses, veh: s.veh, groups: s.coys.size, days: s.days.size, flags: s.flags };
  }

  function filteredEntries() {
    return T.filterEntries(state.model, { companies: enabledCoys(), onlySchool4: state.onlyS4 });
  }

  /* ---------------------------------------------------------- render -- */
  function renderMonthBanner() {
    var m = state.model;
    $('month-banner').hidden = false;
    $('mb-top').textContent = m.monthName ? m.monthName.slice(0, 3) : '—';
    $('mb-mon').textContent = m.year;
    var days = {};
    T.filterEntries(m, { companies: enabledCoys(), onlySchool4: state.onlyS4 }).forEach(function (e) {
      if (e.date) days[e.date] = 1;
    });
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
        if (c === 'SCHWIDE') state.schwide = !state.schwide;
        else state.coys[c] = !state.coys[c];
        refresh();
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
      var where = esc(f.label), from = esc(f.from), to = esc(f.to);
      return '<div class="fx"><span class="where">' + where + '</span><span>' + from +
        '</span><span class="arrow">→</span><span><b>' + to + '</b></span></div>';
    });
    fill('skip-list', 'skip-count', sk, function (s) {
      return '<div class="rowmsg"><span class="r">' + esc(s.why) + '</span><span>“' + esc(s.text) + '”</span></div>';
    });
    fill('unmatch-list', 'unmatch-count', um, function (u) {
      return '<div class="rowmsg"><span class="r">line ' + u.row + '</span><span>“' + esc(u.text) + '”</span></div>';
    });
  }

  function renderResults() {
    $('empty-state').hidden = true;
    $('results').hidden = false;
    drawView();
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
    var b = e.source === 'ICRF'
      ? '<span class="srcbadge icrf" title="Combined facilities? No — own ICRF movement">ICRF</span>'
      : '<span class="srcbadge tl" title="From the Troop Lift sheet">TL</span>';
    return b + (e.flagged ? '<span class="flagstar" title="Flagged with * in the source sheet">*</span>' : '');
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
    // by company
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
    $('view-date').className = view === 'date' ? 'on' : '';
    $('view-coy').className = view === 'coy' ? 'on' : '';

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
      var seen = {};
      enabledCoys().forEach(function (coy) {
        var list = entries.filter(function (e) { return e.coys.indexOf(coy) > -1; });
        if (!list.length) return;
        seen[coy] = true;
        var buses = 0, veh = 0, flags = 0;
        list.forEach(function (e) {
          if (e.kind === 'bus') buses += (e.qty || 0); else veh += (e.qty || 0);
          if (e.flagged) flags++;
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
      // any enabled coy with no rows is skipped silently; note others (only when showing non-S4)
      if (!Object.keys(seen).length) {
        c.innerHTML = '<div class="empty"><h2 style="margin:0;color:var(--navy)">No movements match the current filters</h2>' +
          '<p class="hintline">Try enabling more companies, or turning “Keep only School 4 movements” off.</p></div>';
      }
    }
  }

  var MON_SHORTS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  function monthShort(d) {
    return MON_SHORTS[(+d.slice(5, 7)) - 1];
  }

  function refresh() {
    renderChips();
    renderMonthBanner();
    renderNotes();
    renderStats(filteredEntries());
    drawView();
  }

  /* ---------------------------------------------------------- export -- */
  async function exportXlsx() {
    if (!state.model) return;
    var entries = filteredEntries();
    var view = state.view;
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

    function headerRow(ws, cols, colNames) {
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

    function dataRow(ws, cells, zebra, ncols) {
      var r = ws.addRow(cells);
      r.height = 17;
      r.eachCell(function (cell, colNumber) {
        cell.font = { size: 10, color: { argb: 'FF1C2833' } };
        cell.border = {
          bottom: { style: 'hair', color: { argb: SOFT } },
          right: zebra ? undefined : undefined
        };
        if (zebra) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFAF8' } };
        var col = colNumber;
        if (col >= 1 && cells[col - 1] && /^\d{4}(–\d{4})?$/.test(String(cells[col - 1]).slice(0, 9))) {
          cell.numFmt = '@';
        }
      });
      return r;
    }

    var genNote = 'Assembled from ICRF (School 4 vehicles) + Troop Lift (buses/tonners) · generated ' +
      new Date().toISOString().slice(0, 16).replace('T', ' ') + (state.onlyS4 ? ' · School 4 movements only' : ' · ALL movements (incl. other units)') +
      (state.schwide ? ' · SCHWIDE included' : '');

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
          var cells = [T.timeLabel(e),
            e.coys.join(' / '), e.activity, e.from || '—', e.to || '—',
            T.vehicleLabel(e)];
          if (poc) cells.push(e.officer ? e.officer + (e.phone ? ' (' + e.phone + ')' : '') : '—');
          var rem = [];
          if (e.flagged) rem.push('flagged *');
          if (e.timeStart === 'TBC') rem.push('timing TBC');
          if (e.dayDiff > 1) rem.push('runs ' + e.dayDiff + ' days');
          cells.push(rem.join(' · '));
          dataRow(ws, cells, i % 2 === 1, cols.length);
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
          var cells = [T.fmtDate(e.date), T.dowOf(e.date),
            T.timeLabel(e), e.activity, e.from || '—', e.to || '—', T.vehicleLabel(e)];
          if (poc) cells.push(e.officer ? e.officer + (e.phone ? ' (' + e.phone + ')' : '') : '—');
          var rem = [];
          if (e.flagged) rem.push('flagged *');
          if (e.timeStart === 'TBC') rem.push('timing TBC');
          if (e.dayDiff > 1) rem.push('runs ' + e.dayDiff + ' days');
          cells.push(rem.join(' · '));
          dataRow(ws2, cells, i % 2 === 1, cols2.length);
        });
      });
      ws2.views = [{ state: 'frozen', ySplit: 4 }];
    }

    /* sheet 3: data notes */
    {
      var ws3 = wb.addWorksheet('Data notes', { pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
      ws3.columns = [{ width: 18 }, { width: 30 }, { width: 46 }, { width: 46 }];
      titleRows(ws3, 'DATA NOTES — SANITY CHECKS', 'Fixes and skipped rows found while parsing. Review before distributing.',
        4);
      headerRow(ws3, ['AREA', 'WHERE', 'BEFORE', 'DETECTED']);
      m.icrfFixes.forEach(function (f) {
        dataRow(ws3, ['date fix', f.label, String(f.from), String(f.to)], true, 4);
      });
      m.icrfSkipped.forEach(function (s) {
        dataRow(ws3, ['skipped row', 'ICRF row ' + s.row, s.text, s.why], true, 4);
      });
      m.tlUnmatched.forEach(function (u) {
        dataRow(ws3, ['unparsed TL line', 'troop lift line ' + u.row, u.text, '—'], true, 4);
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
    toast('Exported <b>' + esc(a.download) + '</b> — check the “Data notes” sheet for parse fixes.');
  }

  /* ----------------------------------------------------------- wire -- */
  function init() {
    $('file-icrf').addEventListener('change', function (e) { handleFile(e.target.files[0], 'icrf'); });
    $('file-tl').addEventListener('change', function (e) { handleFile(e.target.files[0], 'tl'); });
    ['icrf', 'tl'].forEach(function (which) {
      var zone = document.querySelector('#up-' + which + ' .upzone');
      var input = $('file-' + which);
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

    $('view-date').addEventListener('click', function () {
      state.view = 'date';
      $('view-date').className = 'on'; $('view-coy').className = '';
      refresh();
    });
    $('view-coy').addEventListener('click', function () {
      state.view = 'coy';
      $('view-coy').className = 'on'; $('view-date').className = '';
      refresh();
    });

    $('opt-schwide').addEventListener('change', function (e) {
      state.schwide = e.target.checked; refresh();
    });
    $('opt-onlys4').addEventListener('change', function (e) {
      state.onlyS4 = e.target.checked; refresh();
    });
    $('opt-poc').addEventListener('change', function (e) {
      state.poc = e.target.checked;
      $('opt-poc-inline').checked = e.target.checked;
      drawView();
    });
    $('opt-poc-inline').addEventListener('change', function (e) {
      state.poc = e.target.checked;
      $('opt-poc').checked = e.target.checked;
      drawView();
    });

    $('btn-export').addEventListener('click', exportXlsx);
    $('btn-print').addEventListener('click', function () { window.print(); });

    $('btn-sample').addEventListener('click', async function () {
      try {
        var [a, b] = await Promise.all([
          fetch('samples/ICRF.xlsx').then(bindUp('icrf')),
          fetch('samples/Troop Lift Sample.xlsx').then(bindUp('tl'))
        ]);
        state.icrfWb = await loadWorkbook(a, 'icrf'); state.icrfName = 'ICRF.xlsx (sample)';
        state.tlWb = await loadWorkbook(b, 'tl'); state.tlName = 'Troop Lift Sample.xlsx (sample)';
        renderUploadStatus('icrf', { ok: true, msg: 'sample workbook — ' + state.icrfWb.worksheets[0].name });
        renderUploadStatus('tl', { ok: true, msg: 'sample workbook — ' + state.tlWb.worksheets[0].name });
        maybeCombine();
      } catch (err) {
        toast('Could not auto-load samples (works only over a local web server — e.g. <b>python3 -m http.server</b>). Drop the files manually instead.', true);
      }
    });

    document.querySelectorAll('.acc-head').forEach(function (h) {
      h.addEventListener('click', function () { h.parentElement.classList.toggle('open'); });
    });
  }

  function bindUp(which) {
    return function (res) {
      if (!res.ok) throw new Error('sample fetch failed');
      return res.arrayBuffer();
    };
  }

  init();

  /* auto-load samples when URL arrives with #auto (preview / demo shortcut) */
  if (/^#auto/.test(location.hash)) {
    if (location.hash === '#auto-coy') state.view = 'coy';
    setTimeout(function () { $('btn-sample').click(); }, 60);
  }

  /* debug hook (used by tests / smoke runs; harmless otherwise) */
  window.__tcrs = {
    state: state,
    maybeCombine: maybeCombine,
    exportXlsx: exportXlsx,
    drawView: drawView,
    filteredEntries: filteredEntries,
    refresh: refresh,
    renderUploadStatus: renderUploadStatus
  };
})();
