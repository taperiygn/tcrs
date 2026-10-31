/* =====================================================================
 * TCRS — sheet.js : lightweight editable "live sheet" grid
 *
 *      window.TCRSSheet.mount(container, opts)
 *
 *  opts = {
 *    columns : [{key,label,w,flex,type('date'|'time'|'coys'|'num'|'text'|'src')}]
 *    getRows : () => array of entries (already filtered & sorted)
 *    commit  : (id, field, value) => {ok, msg?} — persists the edit
 *    onAdd   : () => {}                        add a movement
 *    onDup   : (id) => {}                      duplicate row
 *    onDel   : (id) => {}                      delete row (2-step confirm)
 *  }
 *  returns { rerender(), setSearch(term) }
 *
 * The grid never mutates data itself — validation & storage live in the app.
 * All commits re-render; scrollTop is preserved.
 *===================================================================== */
(function () {
  'use strict';

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function mount(container, opts) {
    var state = { search: '', editing: null, delArm: null, scrollTop: 0 };

    container.classList.add('sheet');
    container.innerHTML =
      '<div class="sheet-scroll" tabindex="-1">' +
      '<table class="sheet-table"><thead></thead><tbody></tbody></table>' +
      '<div class="sheet-addrow">＋ Add movement</div>' +
      '</div>';

    var scroll = container.querySelector('.sheet-scroll');
    var thead = container.querySelector('thead');
    var tbody = container.querySelector('tbody');
    var addRowBtn = container.querySelector('.sheet-addrow');

    /* ------------------------------------------------------------- head */
    function drawHead() {
      var html = '<tr>';
      opts.columns.forEach(function (c) {
        html += '<th style="width:' + (c.flex ? 240 : c.w) + 'px" class="' +
          (c.type === 'src' ? 'h-src' : '') + '">' + esc(c.label) + '</th>';
      });
      html += '<th class="h-gutter"></th></tr>';
      thead.innerHTML = html;
    }

    /* ------------------------------------------------------------- rows */
    function matchRow(e) {
      if (!state.search) return true;
      var hay = [e.date, e.timeStart, e.timeEnd, (e.coys || []).join(' / '),
        e.activity, e.from, e.to, e.vehicleType, e.officer, e.phone, e.source]
        .join(' ').toLowerCase();
      return hay.indexOf(state.search.toLowerCase()) > -1;
    }

    function cellValue(e, key) {
      switch (key) {
        case 'coys': return (e.coys || []).join(' / ');
        case 'qty': return e.qty === null || e.qty === undefined ? '' : String(e.qty);
        case 'officer': return e.officer || '';
        case 'phone': return e.phone || '';
        case 'from': return e.from || '';
        case 'to': return e.to || '';
        case 'activity': return e.activity || '';
        case 'vehicleType': return e.vehicleType || '';
        default: return e[key] || '';
      }
    }

    function renderQuick(e, key, value) {
      var v = value;
      if (key === 'timeEnd' && e.dayDiff > 1 && v)
        return esc(v) + ' <span class="plusday">+' + e.dayDiff + 'd</span>';
      return v === null || v === undefined || v === '' ? '' : esc(v);
    }

    function drawBody() {
      var all = opts.getRows();
      var rows = all.filter(matchRow);
      var html = '';
      rows.forEach(function (e) {
        html += '<tr data-id="' + esc(e.id) + '">';
        opts.columns.forEach(function (c) {
          if (c.type === 'src') {
            html += '<td class="c-src noclick">' +
              '<span class="srcbadge ' + (e.source === 'ICRF' ? 'icrf' : e.source === 'MANUAL' ? 'manual' : 'tl') + '">' +
              esc(e.source === 'MANUAL' ? 'ADD' : e.source) + '</span>' +
              (e.edited ? '<span class="editdot" title="edited since load">✎</span>' : '') +
              (e.flagged ? '<span class="flagstar" title="flagged in the source sheet">*</span>' : '') +
              '</td>';
          } else {
            html += '<td class="c-' + c.key + '" data-key="' + c.key + '">' +
              renderQuick(e, c.key, cellValue(e, c.key)) + '</td>';
          }
        });
        html += '<td class="gutter noclick">' +
          '<button class="g-btn" data-act="dup" title="Duplicate this movement">⧉</button>' +
          '<button class="g-btn g-del" data-act="del" title="Delete this movement">✕</button>' +
          '</td></tr>';
      });
      tbody.innerHTML = html || '<tr class="sheet-empty"><td colspan="20">no rows match your filters</td></tr>';
      var note = container.parentElement.querySelector('.sheet-note');
      if (note) note.textContent =
        rows.length + ' of ' + all.length + ' rows shown' +
        (rows.length !== all.length ? ' — the rest hidden by your filters' : '');
      scroll.scrollTop = state.scrollTop;
    }

    /* ----------------------------------------------------------- editing */
    function coordsOf(td) {
      var tr = td.closest('tr');
      var tdsInRow = Array.prototype.filter.call(tr.cells, function (c) { return c.dataset && c.dataset.key; });
      var colIdx = tdsInRow.indexOf(td);
      var trs = Array.prototype.slice.call(tbody.querySelectorAll('tr:not(.sheet-empty)'));
      return { row: trs.indexOf(tr), col: colIdx, rows: trs.length, cols: tdsInRow.length };
    }

    function beginEdit(td) {
      var tr = td.closest('tr');
      var id = tr.dataset.id, key = td.dataset.key;
      var e = opts.getRows().find(function (r) { return r.id === id; });
      if (!e) return;

      td.innerHTML = '';
      var input = document.createElement('input');
      input.className = 'sheet-input';
      input.value = cellValue(e, key);
      td.appendChild(input);
      input.focus();
      input.select();
      state.editing = { td: td, input: input };

      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          var pos = coordsOf(td);
          commit();
          // snap down: same column, next row
          var fresh = liveCell(pos.row + 1, pos.col);
          if (fresh) beginEdit(fresh);
        } else if (ev.key === 'Escape') {
          ev.stopPropagation();
          state.editing = null;
          drawBody();
        } else if (ev.key === 'Tab') {
          ev.preventDefault();
          var delta = ev.shiftKey ? -1 : 1;
          var pos = coordsOf(td);
          var rowLen = opts.columns.length - 1;          // editable columns (excl src)
          var cand = pos.col + delta;
          var r = pos.row, c = cand;
          while (c < 0 && r > 0) { r--; c = rowLen - 1; }
          while (c >= rowLen && r < pos.rows - 1) { r++; c = 0; }
          commit();
          var cell = (r >= 0 && r < pos.rows && c >= 0 && c < rowLen) ? liveCell(r, c) : null;
          if (cell) beginEdit(cell);
        }
      });
      input.addEventListener('blur', function () { commit(); });

      function commit() {
        if (!state.editing) return;
        state.editing = null;
        var res = opts.commit(id, key, input.value.trim());
        drawBody();
        if (res && !res.ok && res.msg) {
          var trNow = tbody.querySelector('tr[data-id="' + id + '"]');
          var bad = null;
          if (trNow) {
            Array.prototype.forEach.call(trNow.cells, function (c) {
              if (c.dataset && c.dataset.key === key) bad = c;
            });
          }
          if (bad) {
            bad.classList.add('cell-error');
            bad.title = res.msg;
            setTimeout(function () { bad.classList.remove('cell-error'); }, 1800);
          }
        }
      }
    }

    function liveCell(rowIdx, colIdx) {
      var trs = Array.prototype.slice.call(tbody.querySelectorAll('tr:not(.sheet-empty)'));
      var tr = trs[rowIdx];
      if (!tr) return null;
      var tds = Array.prototype.filter.call(tr.cells, function (c) { return c.dataset && c.dataset.key; });
      return tds[colIdx] || null;
    }

    /* ----------------------------------------------------------- events */
    tbody.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.g-btn');
      if (btn) {
        var tr0 = ev.target.closest('tr'); var id = tr0 ? tr0.dataset.id : null;
        if (!id) return;
        if (btn.dataset.act === 'dup') opts.onDup(id);
        else if (btn.dataset.act === 'del') {
          if (state.delArm === id) { state.delArm = null; opts.onDel(id); }
          else {
            state.delArm = id;
            btn.classList.add('armed');
            btn.title = 'click again to confirm delete';
            setTimeout(function () { state.delArm = null; drawBody(); }, 2600);
          }
        }
        return;
      }
      var td = ev.target.closest('td');
      if (!td || td.classList.contains('noclick') || td.classList.contains('gutter')) return;
      if (state.editing) return;                    // blur commit will re-render
      beginEdit(td);
    });

    addRowBtn.addEventListener('click', function () { opts.onAdd(); });
    scroll.addEventListener('scroll', function () { state.scrollTop = scroll.scrollTop; });

    drawHead();
    drawBody();

    return {
      rerender: drawBody,
      setSearch: function (t) { state.search = t || ''; drawBody(); }
    };
  }

  window.TCRSSheet = { mount: mount };
})();
