/* =====================================================================
 * TCRS — sheet.js : editable grid renderers for the live sheet
 *
 *      window.TCRSSheet.mount(container, opts)     — column/row grid
 *      window.TCRSSheet.mountTLText(container, opts) — bulk TL text editor
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
    var state = { search: '', editing: null, scrollTop: 0, hoverT: null };
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
      closeMenu();
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
      closeMenu();
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
        if (!state.editing || state.editing.input !== input) return;
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

    /* -------------------------------------- hover-row menu (0.25s) -- */
    /* Hold the pointer on a row for ~0.25s and a small white menu appears
       under the cursor: add row below / copy / delete. */
    function closeMenu() {
      if (state.hoverT) { clearTimeout(state.hoverT); state.hoverT = null; }
      if (state.outside) { document.removeEventListener('mousedown', state.outside); state.outside = null; }
      var m = container.querySelector('.hover-menu');
      if (m) m.remove();
      state.renderMenu = null;
    }
    function showMenu(tr, x, y) {
      closeMenu();
      var id = tr.dataset.id;
      var m = document.createElement('div');
      m.className = 'hover-menu';
      m.innerHTML =
        (opts.onInsertAfter ? '<button type="button" data-act="insert">＋ Add row below</button>' : '') +
        (opts.onDup ? '<button type="button" data-act="dup">⧉ Copy</button>' : '') +
        (opts.onDel ? '<button type="button" data-act="del" class="m-del">✕ Delete</button>' : '');
      var rect = container.getBoundingClientRect();
      m.style.left = Math.max(4, Math.min(x - rect.left, rect.width - 150)) + 'px';
      m.style.top = (y - rect.top + 16) + 'px';
      container.appendChild(m);
      state.renderMenu = id;
      state.outside = function (ev2) {
        if (m.contains(ev2.target)) return;
        closeMenu();
      };
      document.addEventListener('mousedown', state.outside);
      m.addEventListener('click', function (ev2) {
        var btn = ev2.target.closest('button');
        if (!btn) return;
        var act = btn.dataset.act;
        if (act === 'insert') {
          closeMenu();
          var newId = opts.onInsertAfter(id);
          drawBody();
          var tr2 = newId && tbody.querySelector('tr[data-id="' + newId + '"]');
          var first = tr2 && tr2.querySelector('td[data-key]');
          if (first) beginEdit(first);        // jump straight into the new row
        } else if (act === 'dup') {
          closeMenu();
          opts.onDup(id);
        } else if (act === 'del') {
          if (btn.dataset.armed) {            // two-step confirm, like the row gutter
            closeMenu();
            opts.onDel(id);
          } else {
            btn.dataset.armed = '1';
            btn.classList.add('armed');
            btn.textContent = 'Confirm delete?';
            setTimeout(function () {
              if (m.isConnected) { btn.dataset.armed = ''; btn.classList.remove('armed'); btn.textContent = '✕ Delete'; }
            }, 2600);
          }
        }
      });
    }
    tbody.addEventListener('mouseover', function (ev) {
      var tr = ev.target.closest('tr');
      if (!tr || tr.classList.contains('sheet-empty')) return;
      if (state.editing) return;
      if (!opts.onInsertAfter && !opts.onDup && !opts.onDel) return;
      if (state.hoverT) { clearTimeout(state.hoverT); state.hoverT = null; }
      var menu = container.querySelector('.hover-menu');
      if (menu && state.renderMenu === tr.dataset.id) return;   // already open for this row
      var x = ev.clientX, y = ev.clientY;
      state.hoverT = setTimeout(function () { showMenu(tr, x, y); }, 250);
    });
    tbody.addEventListener('mouseleave', function (ev) {
      if (state.hoverT) { clearTimeout(state.hoverT); state.hoverT = null; }
      var menu = container.querySelector('.hover-menu');
      if (menu && !(ev.relatedTarget && menu.contains(ev.relatedTarget))) closeMenu();
    });

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
    scroll.addEventListener('scroll', function () { state.scrollTop = scroll.scrollTop; closeMenu(); });

    drawHead();
    drawBody();

    return { rerender: drawBody, setSearch: function (t) { state.search = t || ''; drawBody(); } };
  }

  window.TCRSSheet = {
    mount: mount,
    mountTLText: mountTLText
  };

  /* ====================================== bulk TL text editor == */
  /* The whole month's Troop-lift sheet as one editable block of text
     (date headings + one movement per line). Nothing is parsed until
     "Update" is pressed, then the text is converted back to entries. */
  function mountTLText(container, opts) {
    container.classList.add('sheet', 'tl-textmode');
    container.innerHTML =
      '<div class="tl-editor-wrap">' +
      '<textarea class="tl-editor" spellcheck="false" wrap="soft"></textarea>' +
      '<div class="tl-editor-foot">' +
      '<span class="tl-editor-status"></span>' +
      '<button class="btn btn-primary sm tl-apply" type="button" title="Parse this text back into movements and update the schedule">Update</button>' +
      '</div>' +
      '</div>';

    var ta = container.querySelector('.tl-editor');
    var statusEl = container.querySelector('.tl-editor-status');
    var applyBtn = container.querySelector('.tl-apply');
    var state = { dirty: false, scrollTop: 0 };

    ta.value = opts.getText();
    ta.addEventListener('input', function () { state.dirty = true; });
    ta.addEventListener('scroll', function () { state.scrollTop = ta.scrollTop; });

    function apply() {
      var res = opts.apply(ta.value) || { msg: '' };
      state.dirty = false;
      statusEl.textContent = res.msg || '';
      var note = container.parentElement.querySelector('.sheet-note');
      if (note && typeof opts.note === 'function') note.textContent = opts.note();
      ta.scrollTop = state.scrollTop;
    }

    applyBtn.addEventListener('click', apply);
    ta.addEventListener('keydown', function (ev) {
      if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && ev.key === 'Enter') {
        ev.preventDefault();
        apply();
      }
    });

    return {
      rerender: function (fresh) {
        if (fresh) state.dirty = false;
        if (fresh || !state.dirty) ta.value = opts.getText();
        statusEl.textContent = fresh ? '' : statusEl.textContent;
      },
      setSearch: function () { }
    };
  }
})();
