/* =====================================================================
 * TCRS — sheet.js : editable grid renderers for the live sheet
 *
 *      window.TCRSSheet.mount(container, opts)    — column/row grid
 *      window.TCRSSheet.mountTL(container, opts)  — one-column TL list
 *
 * The renderers never mutate data themselves; validation & storage
 * live in the app. All commits re-render; scrollTop is preserved.
 *===================================================================== */
(function () {
  'use strict';

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  var T = null;   // window.TCRS, lazy (load order: parser.js → sheet.js)

  /* ==================================================== generic grid == */
  function mount(container, opts) {
    T = window.TCRS;
    var state = { search: '', editing: null, scrollTop: 0 };
    container.classList.add('sheet');
    container.innerHTML =
      '<div class="sheet-scroll" tabindex="-1">' +
      '<table class="sheet-table"><thead></thead><tbody></tbody></table>' +
      '<div class="sheet-addrow">＋ Add row</div>' +
      '</div>';

    var scroll = container.querySelector('.sheet-scroll');
    var thead = container.querySelector('thead');
    var tbody = container.querySelector('tbody');
    var addRowBtn = container.querySelector('.sheet-addrow');

    function drawHead() {
      var html = '<tr>';
      opts.columns.forEach(function (c) {
        html += '<th style="width:' + (c.flex ? 240 : c.w) + 'px" class="' +
          (c.key === '_src' ? 'h-src' : '') + '">' + esc(c.label) + '</th>';
      });
      html += '<th class="h-gutter"></th></tr>';
      thead.innerHTML = html;
    }

    function matchRow(r) {
      if (!state.search) return true;
      var hay = opts.columns.filter(function (c) { return c.key !== '_src'; })
        .map(function (c) { return r[c.key]; }).join(' ').toLowerCase();
      return hay.indexOf(state.search.toLowerCase()) > -1;
    }

    function drawBody() {
      var all = opts.getRows();
      var rows = all.filter(matchRow);
      var html = '';
      rows.forEach(function (r) {
        html += '<tr data-id="' + esc(r.id) + '"' + (r._skip ? ' class="row-skip"' : '') + '>';
        opts.columns.forEach(function (c) {
          if (c.key === '_src') {
            html += '<td class="c-src noclick">' +
              '<span class="srcbadge ' + badgeClass(r) + '">' + (r._row ? 'row ' + esc(r._row) : badgeText(r)) + '</span>' +
              (r.edited ? '<span class="editdot" title="edited since load">✎</span>' : '') +
              (r.flagged ? '<span class="flagstar" title="flagged in the source sheet">*</span>' : '') +
              '</td>';
            return;
          }
          if (r._skip && c.key !== 'colA') {
            html += '<td class="c-skipfill noclick"></td>';
            return;
          }
          var v = r[c.key];
          html += '<td class="c-' + c.key + '"' + (r._skip && c.key === 'colA' ? ' style="white-space:normal"' : '') +
            ' data-key="' + c.key + '">' + (v == null || v === '' ? '' : esc(v)) + '</td>';
        });
        html += '<td class="gutter noclick">' +
          '<button class="g-btn" data-act="dup" title="Duplicate this row">⧉</button>' +
          '<button class="g-btn g-del" data-act="del" title="Delete this row">✕</button>' +
          '</td></tr>';
      });
      tbody.innerHTML = html || '<tr class="sheet-empty"><td colspan="20">no rows match your filters</td></tr>';
      var note = container.parentElement.querySelector('.sheet-note');
      if (note && typeof opts.note === 'function') note.textContent = opts.note(all, rows);
      scroll.scrollTop = state.scrollTop;
    }

    function badgeClass(r) {
      return r._skip ? 'skip' : r.source === 'ICRF' ? 'icrf' : r.source === 'MANUAL' ? 'manual' : 'tl';
    }
    function badgeText(r) {
      return r._skip ? 'SKIP' : r.source === 'MANUAL' ? 'ADD' : r.source === 'ICRF' ? 'ICRF' : 'TL';
    }

    /* ------------------------------------------------------- editing */
    function coordsOf(td) {
      var tr = td.closest('tr');
      var tdsInRow = Array.prototype.filter.call(tr.cells, function (c) { return c.dataset && c.dataset.key; });
      var trs = Array.prototype.slice.call(tbody.querySelectorAll('tr:not(.sheet-empty)'));
      return { row: trs.indexOf(tr), col: tdsInRow.indexOf(td), rows: trs.length };
    }

    function beginEdit(td) {
      var tr = td.closest('tr');
      var id = tr.dataset.id, key = td.dataset.key;
      var r = opts.getRows().filter(function (x) { return String(x.id) === String(id); })[0];
      if (!r) return;
      var cur = r[key] == null ? '' : String(r[key]);

      td.innerHTML = '';
      var input = document.createElement('input');
      input.className = 'sheet-input';
      input.value = cur;
      td.appendChild(input);
      input.focus();
      input.select();
      state.editing = { td: td, input: input };

      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          var pos = coordsOf(td);
          commit();
          var fresh = liveCell(pos.row + 1, pos.col);
          if (fresh && opts.autodown !== false) beginEdit(fresh);
        } else if (ev.key === 'Escape') {
          ev.stopPropagation();
          state.editing = null;
          drawBody();
        } else if (ev.key === 'Tab') {
          ev.preventDefault();
          var pos2 = coordsOf(td);
          var editable = opts.columns.filter(function (c) { return c.key !== '_src'; }).length;
          var c2 = pos2.col + (ev.shiftKey ? -1 : 1);
          var rr = pos2.row, cc = c2;
          while (cc < 0 && rr > 0) { rr--; cc = editable - 1; }
          while (cc >= editable && rr < pos2.rows - 1) { rr++; cc = 0; }
          commit();
          var cell = (rr >= 0 && rr < pos2.rows && cc >= 0 && cc < editable) ? liveCell(rr, cc) : null;
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

    /* ------------------------------------------------------- events */
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
      if (!td || !td.dataset || !td.dataset.key) return;
      if (state.editing) return;
      beginEdit(td);
    });

    addRowBtn.addEventListener('click', function () { opts.onAdd(); });
    scroll.addEventListener('scroll', function () { state.scrollTop = scroll.scrollTop; });

    drawHead();
    drawBody();

    return { rerender: drawBody, setSearch: function (t) { state.search = t || ''; drawBody(); } };
  }

  /* =========================================== one-column TL listing == */
  function mountTL(container, opts) {
    T = window.TCRS;
    var state = { search: '', editing: null, delArm: null, scrollTop: 0 };

    container.classList.add('sheet');
    container.innerHTML =
      '<div class="sheet-scroll" tabindex="-1">' +
      '<div class="tl-wrap"></div>' +
      '</div>';
    var scroll = container.querySelector('.sheet-scroll');
    var wrap = container.querySelector('.tl-wrap');

    function matchLine(l) {
      if (!state.search) return true;
      return (l.text || '').toLowerCase().indexOf(state.search.toLowerCase()) > -1;
    }

    function drawBody() {
      var blocks = opts.getBlocks();
      var html = '';      blocks.forEach(function (b) {
        var lines = b.lines.filter(matchLine);
        html += '<div class="tl-block">';
        html += b.date
          ? '<div class="tl-date"><span class="tl-day">' + esc(T.fmtDate(b.date)) + '</span>' +
            '<span class="tl-dow">' + esc(T.dowOf(b.date)) + '</span>' +
            (b.tbc ? '<span class="tbctag">*TBC*</span>' : '') +
            '<span class="tl-count">' + b.lines.length + " lines</span></div>"
          : '<div class="tl-date"><span class="tl-day">' + esc(b.title || '') + '</span>' +
            '<span class="tl-count">' + b.lines.length + ' lines</span></div>';
        html += '<div class="tl-lines">';
        lines.forEach(function (l) {
          var er = opts.entryFor ? opts.entryFor(l) : null;
          html += '<div class="tl-line' + (l.status === 'unparsed' ? ' bad' : '') + (l.status === 'new' ? ' new' : '') +
            '" data-id="' + esc(l.id) + '"' +
            (l.status === 'unparsed' ? ' title="This line was not recognised — click to fix it"' : '') + '>';
          html += '<span class="tl-text">' +
            (l.status === 'new' && !l.text ? '<span class="ghostnote">new line — click, then type the movement…</span>' : esc(l.text)) +
            '</span>';
          html += '<span class="tl-meta">';
          if (l.status === 'unparsed') html += '<span class="srcbadge skip">unparsed</span>';
          else if (er && er.id) {
            html += (er.coys || []).map(function (c) {
              return '<span class="coychip" style="--c-c:var(--navy);--c-bg:rgba(255,255,255,.7)">' + esc(c) + '</span>';
            }).join('');
            if (er.edited) html += '<span class="editdot" title="edited since load">✎</span>';
          }
          html += '</span>';
          html += '<span class="tl-gutter noclick">' +
            '<button class="g-btn" data-act="dup" title="Duplicate this line">⧉</button>' +
            '<button class="g-btn g-del" data-act="del" title="Delete this line">✕</button>' +
            '</span>';
          html += '</div>';
        });
        html += '</div>';
        html += '<div class="tl-add" data-b="' + esc(b.key) + '">＋ Add line under ' +
          (b.date ? esc(T.fmtDate(b.date)) : 'this block') + '</div>';
        html += '</div>';
      });
      wrap.innerHTML = html || '<div class="tl-none">no lines match your filters</div>';

      var total = 0, shown = 0;
      blocks.forEach(function (b) { total += b.lines.length; shown += b.lines.filter(matchLine).length; });
      var note = container.parentElement.querySelector('.sheet-note');
      if (note) {
        if (typeof opts.note === 'function') note.textContent = opts.note(total, shown, blocks);
        else note.textContent = shown + ' of ' + total + ' lines shown' +
          (shown !== total ? ' — the rest hidden by your filters' : '');
      }
      scroll.scrollTop = state.scrollTop;
    }

    /* ------------------------------------------------------- editing */
    function beginEdit(lineEl) {
      var id = lineEl.dataset.id;
      var info = opts.lineToEdit(id);          // {text, placeholder}
      if (!info) return;
      lineEl.innerHTML = '';
      var input = document.createElement('input');
      input.className = 'sheet-input tl-input';
      input.value = info.text;
      input.spellcheck = false;
      lineEl.appendChild(input);
      input.focus();
      input.select();
      state.editing = { el: lineEl, input: input };

      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        else if (ev.key === 'Escape') {
          ev.stopPropagation();
          state.editing = null;
          if (info.isNew) opts.delLine(id);
          drawBody();
        }
      });
      input.addEventListener('blur', function () { if (state.editing) commit(); });

      function commit() {
        if (!state.editing) return;
        state.editing = null;
        var txt = input.value.trim();
        if (!txt && info.isNew) { opts.delLine(id); drawBody(); return; }
        if (!txt) { drawBody(); return; }
        var res = opts.commitLine(id, txt) || { ok: false, msg: 'not accepted' };
        drawBody();
        if (!res.ok && res.msg) {
          var el2 = wrap.querySelector('.tl-line[data-id="' + id + '"]');
          if (el2) {
            el2.classList.add('cell-error');
            el2.title = res.msg;
            setTimeout(function () { el2.classList.remove('cell-error'); }, 2200);
          }
        }
      }
    }

    wrap.addEventListener('click', function (ev) {
      var add = ev.target.closest('.tl-add');
      if (add) { opts.addLine(add.dataset.b); return; }
      var btn = ev.target.closest('.g-btn');
      if (btn) {
        var el = ev.target.closest('.tl-line'); var id = el ? el.dataset.id : null;
        if (!id) return;
        if (btn.dataset.act === 'dup') { opts.dupLine(id); return; }
        if (btn.dataset.act === 'del') {
          if (state.delArm === id) { state.delArm = null; opts.delLine(id); }
          else {
            state.delArm = id;
            btn.classList.add('armed');
            btn.title = 'click again to confirm delete';
            setTimeout(function () { state.delArm = null; drawBody(); }, 2600);
          }
          return;
        }
      }
      var line = ev.target.closest('.tl-line');
      if (!line || line.classList.contains('noclick')) return;
      if (state.editing) return;
      beginEdit(line);
    });

    scroll.addEventListener('scroll', function () { state.scrollTop = scroll.scrollTop; });

    drawBody();

    return {
      rerender: drawBody,
      setSearch: function (t) { state.search = t || ''; drawBody(); }
    };
  }

  window.TCRSSheet = { mount: mount, mountTL: mountTL };
})();
