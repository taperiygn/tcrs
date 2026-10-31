/* =========================================================================
 * TCRS — School 4 Combined Movement Builder
 * parser.js — pure parsing + merge logic (no DOM). Exposes window.TCRS.
 *
 * Expected source sheets (fixed official templates):
 *   ICRF    - 4 header rows; data from first row whose action column (A)
 *             matches "SCH <n> - <X> COY - <ACTIVITY>".
 *             Cols: A activity | B veh type | C qty | D req'd TO |
 *                   E start date | F start time | G end date | H end time |
 *                   I reporting | J destination | K officer | L phone | M unit
 *   TROOPLIFT - free text schedule, one column:
 *             title "NOVEMBER TL"; date rows (date cells or "23/11 (*TBC*)");
 *             lines "<HHMM|TBC> <FROM> - <TO> <N> BUSES|TONNERS (<TAG ACTIVITY>)"
 *             lines with " (*TBC*)" / leading-trailing * are flagged, not TBC.
 *========================================================================= */
(function () {
  'use strict';

  var MONTH_WORD = {
    JANUARY: 1, JAN: 1, FEBRUARY: 2, FEB: 2, MARCH: 3, MAR: 3, APRIL: 4, APR: 4,
    MAY: 5, JUNE: 6, JUN: 6, JULY: 7, JUL: 7, AUGUST: 8, AUG: 8,
    SEPTEMBER: 9, SEP: 9, OCTOBER: 10, OCT: 10,
    NOVEMBER: 11, NOV: 11, DECEMBER: 12, DEC: 12
  };
  var MONTH_NAME = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
    'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
  var DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

  var ORDINAL = /^\d+(ST|ND|RD|TH)$/i;
  var TL_LINE = /^\*?\s*(\d{4}|TBC)\s+(.+?)\s+(?:(\d+)\s+)?(BUSES|BUS|TONNERS|TONNER)\s*\((.*)\)\*?\s*$/i;
  var TL_TBC_DATE = /^\*?\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*(?:\(\s*\*?TBC\*?\s*\))?\*?\s*$/;
  var ICRF_ACTIVITY = /^SCH\s*(\d+)\s*-\s*(.+?)\s*-\s*(.+)$/i;

  /* ------------------------------------------------------------------ */
  function norm(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/\xa0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function cellValue(cell) {
    var v = cell.value;
    if (v && typeof v === 'object') {
      if (v instanceof Date) return v;
      if (v.result !== undefined) return v.result;   // formula cell
      if (typeof v.richText !== 'undefined') return v.richText.map(function (t) { return t.text; }).join('');
      return v.text !== undefined ? v.text : v;
    }
    return v;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function hhmmFromTime(v) {
    if (!v) return '';
    if (typeof v === 'string') {
      var m = v.trim().match(/^(\d{1,2}):?(\d{2})(:\d{2})?$/);
      if (m) return pad(+m[1]) + m[2];
      if (/^\d{4}$/.test(v.trim())) return v.trim();
      return '';
    }
    if (v instanceof Date) {
      // pure-time cells load with a 1899-12-31-style anchor
      if (v.getUTCFullYear() < 1901) return pad(v.getUTCHours()) + pad(v.getUTCMinutes());
      return pad(v.getUTCHours()) + pad(v.getUTCMinutes());
    }
    if (typeof v === 'number') {                            // excel time serial
      var mins = Math.round((v % 1) * 24 * 60);
      return pad(Math.floor(mins / 60) % 24) + pad(mins % 60);
    }
    return '';
  }

  function ymd(date) {
    return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate());
  }

  /* Excel date serial (1900 system) -> y-m-d string */
  function excelSerialToYMD(n) {
    var days = Math.floor(n) - 25569;                       // offset to 1970
    var ms = days * 86400000;
    var d = new Date(ms);
    d.setUTCMinutes(d.getUTCMinutes() - d.getUTCSeconds()); // snap
    var dd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    return ymd(dd);
  }

  /* Parse "24/11/26" style (dd/mm/yy). Applies same swap heuristic. */
  function textDateToYMD(s, targetMonth, fixes, label) {
    var t = norm(s).replace(/^\*+|\*+$/g, '').trim();
    var m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (!m) return null;
    var d = +m[1], mo = +m[2], y = m[3] ? +m[3] : null;
    if (y === null) y = new Date().getUTCFullYear();
    else if (y < 100) y += 2000;
    if (mo !== targetMonth && d === targetMonth && d !== mo) {
      var tmp = d; d = mo; mo = tmp;
      fixes.push({ label: label, from: s, to: MONTH_NAME[mo - 1] + ' ' + d + ' (day/month swapped)' });
    }
    return y + '-' + pad(mo) + '-' + pad(d);
  }

  /* Apply day/month swap heuristic when template-locale mangling is found.
     quiet=true: fix silently (used for paired end-date column). */
  function fixDatetime(v, targetMonth, fixes, label, quiet) {
    if (!(v instanceof Date)) return null;
    var mo = v.getUTCMonth() + 1, d = v.getUTCDate(), y = v.getUTCFullYear();
    if (mo === targetMonth) return ymd(v);
    if (d === targetMonth && d !== mo && d <= 12) {
      var fixed = y + '-' + pad(d) + '-' + pad(mo);
      if (!quiet) fixes.push({ label: label, from: MONTH_NAME[mo - 1] + ' ' + d, to: MONTH_NAME[d - 1] + ' ' + mo + ' (day/month swapped)' });
      return fixed;
    }
    if (!quiet) fixes.push({ label: label, from: MONTH_NAME[mo - 1] + ' ' + d + ' ' + y, to: 'kept as-is (outside expected month - please check)' });
    return ymd(v);
  }

  function coyRank(c) {
    var m = /^(\d+)(?:ST|ND|RD|TH)$/i.exec(c);
    return m ? +m[1] : 99;
  }

  function sortCoys(arr) {
    return arr.slice().sort(function (a, b) {
      return coyRank(a) - coyRank(b) || a.localeCompare(b);
    });
  }

  /* ------------------------------------------------- month detection -- */

  /* --------------------------------------------------------- parsing -- */
  function parseICRF(worksheet, workbook, monthRef) {
    var res = { sheetMonthWord: null, entries: [], skipped: [], coySet: {} };
    var sheetName = worksheet.name.toUpperCase();
    var sm = /(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/.exec(sheetName);
    if (sm && MONTH_WORD[sm[1]]) res.sheetMonthWord = MONTH_WORD[sm[1]];

    worksheet.eachRow({ includeEmpty: true }, function (row) {
      var r = row.number;
      if (r > 5000) return;   // safety cap
      var a = norm(cellValue(row.getCell(1)));
      var vehType = norm(cellValue(row.getCell(2)));
      var qtyRaw = cellValue(row.getCell(3));
      var qty = typeof qtyRaw === 'number' ? qtyRaw : parseFloat(qtyRaw);
      var sDateV = cellValue(row.getCell(5)), sDateY = null;
      var eDateV = cellValue(row.getCell(7)), eDateY = null;
      var sTime = hhmmFromTime(cellValue(row.getCell(6)));
      var eTime = hhmmFromTime(cellValue(row.getCell(8)));
      var from = norm(cellValue(row.getCell(9)));
      var to = norm(cellValue(row.getCell(10)));
      var officer = norm(cellValue(row.getCell(11)));
      var phone = cellValue(row.getCell(12));
      var unit = norm(cellValue(row.getCell(13)));

      if (!a) return;
      var am = ICRF_ACTIVITY.exec(a);
      if (!am) {
        res.skipped.push({ row: r, text: a, why: 'behind the header / organisational row' });
        return;
      }
      var coypart = am[2].trim().toUpperCase();
      var coys = [];
      if (coypart === 'SCHWIDE' || /SCH.*WIDE/.test(coypart)) {
        coys = ['SCHWIDE'];
        res.coySet['SCHWIDE'] = 1;
      } else {
        coypart.split(/\s*\/\s*/).forEach(function (tok) {
          tok = tok.trim().replace(/\s*COY\.?$/i, '').trim().toUpperCase();
          if (ORDINAL.test(tok)) { coys.push(tok); res.coySet[tok] = 1; }
        });
      }
      if (!coys.length) {
        res.skipped.push({ row: r, text: am[2], why: 'unrecognised company tag' });
        return;
      }
      // dates
      if (sDateV instanceof Date) {
        sDateY = fixDatetime(sDateV, monthRef.month(), res.fixes || (res.fixes = []), 'ICRF row ' + r);
      } else if (typeof sDateV === 'string') {
        sDateY = textDateToYMD(sDateV, monthRef.month(), res.fixes || (res.fixes = []), 'ICRF row ' + r);
      } else if (typeof sDateV === 'number') {
        sDateY = excelSerialToYMD(sDateV);
      }
      if (!sDateY) { res.skipped.push({ row: r, text: a, why: 'missing/unreadable start date' }); return; }

      var nextDay = false, dayDiff = 0;
      var eY = null;
      if (eDateV instanceof Date) {
        eY = fixDatetime(eDateV, monthRef.month(), [], '', true);  // paired col: fix quietly
      } else if (typeof eDateV === 'string') { eY = textDateToYMD(eDateV, monthRef.month(), [], ''); }
      else if (typeof eDateV === 'number') { eY = excelSerialToYMD(eDateV); }
      if (eY && sDateY && eY > sDateY) {
        var sd = new Date(sDateY + 'T00:00:00Z'), ed = new Date(eY + 'T00:00:00Z');
        dayDiff = Math.round((ed - sd) / 86400000);
        nextDay = dayDiff >= 1;
      }

      res.entries.push({
        id: 'i' + r,
        source: 'ICRF',
        date: sDateY,
        coys: coys,
        coyLabel: coys.join(' / '),
        activity: am[3].trim(),
        timeStart: sTime,
        timeEnd: nextDay ? (eTime || '2359') : eTime,
        nextDay: nextDay,
        dayDiff: dayDiff,
        from: from, to: to,
        qty: (typeof qty === 'number' && !isNaN(qty)) ? Math.round(qty) : null,
        vehicleType: vehType,
        kind: 'veh',
        officer: officer,
        phone: phone === null || phone === undefined ? '' :
          (typeof phone === 'number' ? String(Math.round(phone)) : String(phone).trim()),
        unit: unit,
        flagged: false,
        tbc: false,
        row: r
      });
    });
    return res;
  }

  function parseTROOPLIFT(worksheet) {
    var res = { monthWord: null, tlDateMonths: [], entries: [], unmatched: [], coySet: {}, days: {}, tbcDays: {} };
    var curDate = null;
    worksheet.eachRow({ includeEmpty: true }, function (row) {
      var r = row.number;
      var v = cellValue(row.getCell(1));
      if (v === null || v === undefined || v === '') return;

      if (v instanceof Date) {
        curDate = ymd(v);
        res.days[curDate] = 1;
        res.tlDateMonths.push(v.getUTCMonth() + 1);
        return;
      }
      var t = norm(v);
      if (!t) return;

      // monthly title, e.g. "NOVEMBER TL"
      var mm = /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s*(\d{4})?\s*(TL)?\s*$/i.exec(t);
      if (mm) {
        res.monthWord = MONTH_WORD[mm[1].toUpperCase()];
        return;
      }
      // date placeholder row, e.g. "23/11 (*TBC*)"
      var dm = TL_TBC_DATE.exec(t);
      if (dm) {
        var y = dm[3] ? +dm[3] : new Date().getUTCFullYear();
        if (y < 100) y += 2000;
        curDate = y + '-' + pad(+dm[2]) + '-' + pad(+dm[1]);
        res.days[curDate] = 1;
        res.tlDateMonths.push(+dm[2]);
        if (/\*\s*TBC\s*\*|\*TBC\*/.test(t)) res.tbcDays[curDate] = 1;
        return;
      }

      var lm = TL_LINE.exec(t);
      if (!lm) {
        res.unmatched.push({ row: r, text: t });
        return;
      }
      var time = lm[1] === 'TBC' ? 'TBC' : lm[1];
      var route = lm[2];
      var cnt = lm[3] ? +lm[3] : null;
      var noun = lm[4].toUpperCase();
      var paren = norm(lm[5]);
      paren = paren.replace(/^\*+|\*+$/g, '').trim();

      var tag = paren, act = '';
      var sp = paren.indexOf(' ');
      if (sp > -1) { tag = paren.slice(0, sp); act = paren.slice(sp + 1); }
      var coys = [];
      var parts = tag.split('/');
      parts.forEach(function (p) {
        p = norm(p).toUpperCase();
        if (ORDINAL.test(p)) { coys.push(p); res.coySet[p] = 1; }
      });
      // route: split at first " - "
      var from = route, to = '';
      var sep = route.indexOf(' - ');
      if (sep > -1) { from = route.slice(0, sep); to = route.slice(sep + 3); }
      var flagged = /^\*|\*$/.test(t) || (t.length > 2 && t[0] === '*' && t[t.length - 1] === '*');

      res.entries.push({
        id: 't' + r,
        source: 'TROOPLIFT',
        date: curDate,
        coys: coys,
        coyLabel: coys.join(' / '),
        activity: act.trim() || '—',
        timeStart: time,
        timeEnd: '',
        nextDay: false,
        from: from, to: to,
        qty: cnt,
        vehicleType: noun === 'BUS' ? 'BUSES' : noun,
        kind: 'bus',
        officer: '', phone: '', unit: '',
        flagged: flagged,
        tbc: time === 'TBC',
        row: r
      });
    });
    return res;
  }

  /* ---------------------------------------------------------- merge -- */
  function makeMonthRef(tl, icrfWorksheet) {
    var mc = null;
    var self = {
      month: function () {
        if (mc) return mc;
        if (tl.monthWord) { mc = tl.monthWord; return mc; }
        // majority of TL date rows
        var counts = {};
        tl.tlDateMonths.forEach(function (mo) { counts[mo] = (counts[mo] || 0) + 1; });
        var best = 0, bestM = null;
        for (var k in counts) if (counts[k] > best) { best = counts[k]; bestM = +k; }
        if (bestM) { mc = bestM; return mc; }
        // last resort: ICRF sheet name, e.g. "V1 NOV"
        var sm = /(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/i.exec(icrfWorksheet.name.toUpperCase());
        mc = sm && MONTH_WORD[sm[1]] ? MONTH_WORD[sm[1]] : new Date().getUTCMonth() + 1;
        return mc;
      }
    };
    return self;
  }

  function combineModels(icrf, tl) {
    var monthRef = makeMonthRef(tl, icrf.sheet);
    var icrfRes = parseICRF(icrf.sheet, icrf.workbook, monthRef);

    var entries = icrfRes.entries.concat(tl.entries);
    var all = {};
    for (var k in icrfRes.coySet) all[k] = 1;
    for (k in tl.coySet) all[k] = 1;
    var companies = sortCoys(Object.keys(all));

    return {
      month: monthRef.month(),
      monthName: MONTH_NAME[monthRef.month() - 1],
      year: (function () {
        var ys = entries.filter(function (e) { return e.date; })
          .map(function (e) { return +e.date.slice(0, 4); });
        if (!ys.length) return new Date().getUTCFullYear();
        ys.sort();
        return ys[Math.floor(ys.length / 2)];
      })(),
      companies: companies,
      entries: entries,
      icrfSkipped: icrfRes.skipped,
      icrfFixes: icrfRes.fixes || [],
      tlUnmatched: tl.unmatched,
      tbcDays: Object.keys(tl.tbcDays)
    };
  }

  /* ------------------------------------------------------- entry view -- */
  function timeLabel(e) {
    if (e.timeStart === 'TBC') return 'TBC';
    if (!e.timeStart) return '';
    var t = e.timeStart.slice(0, 2) + ':' + e.timeStart.slice(2, 4);
    if (e.timeEnd && e.timeEnd !== e.timeStart) {
      t += ' - ' + e.timeEnd.slice(0, 2) + ':' + e.timeEnd.slice(2, 4);
      if (e.dayDiff > 1) t += ' (+' + e.dayDiff + 'd)';
    }
    return t;
  }

  function vehicleLabel(e) {
    if (e.kind === 'bus') {
      return (e.qty == null ? '' : e.qty + '× ') + (e.vehicleType || 'BUSES');
    }
    if (e.qty && e.vehicleType) return e.vehicleType + ' ×' + e.qty;
    return e.vehicleType || '—';
  }

  function prettyDate(ymdStr) {
    if (!ymdStr) return 'date not yet parsed';
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymdStr);
    if (!m) return ymdStr;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return DOW[d.getUTCDay()] + '  ' + pad(+m[3]) + '/' + pad(+m[2]) + '/' + m[1];
  }

  function dowOf(ymdStr) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymdStr);
    if (!m) return '';
    return DOW[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
  }

  function fmtDate(ymdStr) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymdStr || '');
    return m ? m[3] + '/' + m[2] + '/' + m[1].slice(2) : (ymdStr || '');
  }

  function sortEntries(entries) {
    return entries.slice().sort(function (a, b) {
      return (a.date || '').localeCompare(b.date || '') ||
        ((a.timeStart === 'TBC' ? '9999' : a.timeStart) || '').localeCompare((b.timeStart === 'TBC' ? '9999' : b.timeStart) || '') ||
        (a.coys[0] || '' ).localeCompare(b.coys[0] || '') ||
        a.id.localeCompare(b.id);
    });
  }

  function filterEntries(model, opts) {
    var enabled = {};
    (opts.companies || model.companies).forEach(function (c) { enabled[c] = 1; });
    return sortEntries(model.entries.filter(function (e) {
      if (opts.onlySchool4) {
        var hit = e.coys.some(function (c) { return enabled[c]; });
        if (!hit) return false;
      }
      return e.coys.some(function (c) { return enabled[c]; }) || !opts.onlySchool4;
    }));
  }

  /* export */
  window.TCRS = {
    parseWorkbooks: function (icrfWb, tlWb) {
      var tlFiles = tlWb.worksheets[0];
      var icrfSheet = null;
      var icrfWbNum = icrfWb.worksheets.length;
      if (icrfWbNum) icrfSheet = icrfWb.worksheets[0];
      var tl = parseTROOPLIFT(tlFiles);
      var combined = combineModels({ sheet: icrfSheet, workbook: icrfWb }, tl);
      return combined;
    },
    filterEntries: filterEntries,
    sortEntries: sortEntries,
    timeLabel: timeLabel,
    vehicleLabel: vehicleLabel,
    prettyDate: prettyDate,
    dowOf: dowOf,
    fmtDate: fmtDate,
    sortCoys: sortCoys,
    MONTH_NAME: MONTH_NAME,
    coyRank: coyRank
  };
})();
