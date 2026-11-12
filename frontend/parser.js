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

  var TL_LINE = /^\*?\s*(\d{4}|TBC)\s+(.+?)\s+(?:(\d+)\s+)?(BUSES|BUS|TONNERS|TONNER)\s*\((.*)\)\*?\s*$/i;
  var TL_TBC_DATE = /^\*?\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*(?:\(\s*\*?TBC\*?\s*\))?\*?\s*$/;
  var ICRF_ACTIVITY = /^SCH\s*(\d+)\s*-\s*(.+?)\s*-\s*(.+)$/i;

  /* Each school is a profile: its own company tag set and saved workspace.
     n=4 is the original ordinal scheme; 1-3 use letters. SCHWIDE (school-wide
     vehicles) belongs to every school. */
  var SCHOOLS = [
    { n: 1, mark: 'S1', companies: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] },
    { n: 2, mark: 'S2', companies: ['H', 'J', 'K', 'L', 'M', 'N', 'O'] },
    { n: 3, mark: 'S3', companies: ['R', 'S', 'T', 'U', 'V', 'W', 'P'] },
    { n: 4, mark: 'S4', companies: ['1ST', '2ND', '3RD', '4TH', '5TH', '6TH', '7TH'] }
  ];
  function schoolDef(n) {
    for (var i = 0; i < SCHOOLS.length; i++) if (SCHOOLS[i].n === n) return SCHOOLS[i];
    return SCHOOLS[3];
  }
  function companyOK(c, school) {
    return c === 'SCHWIDE' || schoolDef(school).companies.indexOf(c) > -1;
  }

  /* ------------------------------------------------------------------ */
  function norm(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/\xa0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function cellValue(cell) {
    var v = cell.value;
    if (v && typeof v === 'object') {
      if (v instanceof Date) return v;
      if (v.result !== undefined) {
        /* uncached/invalid formula results come back as Invalid Date or NaN */
        if (v.result instanceof Date && isNaN(v.result.getTime())) return null;
        if (typeof v.result === 'number' && !isFinite(v.result)) return null;
        return v.result;
      }
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

  /* Parse "24/11/26" style (dd/mm/yy). Applies same swap heuristic. */  function textDateToYMD(s, targetMonth, fixes, label) {
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

  function coyRank(c, school) {
    var list = schoolDef(school).companies;
    var i = list.indexOf(c);
    if (i > -1) return i + 1;                          // roster order first
    if (c === 'SCHWIDE') return 99;                    // school-wide last
    var m = /^(\d+)(?:ST|ND|RD|TH)$/i.exec(c);
    return m ? +m[1] : 50;                             // manual / unknown tags after roster
  }

  function sortCoys(arr, school) {
    return arr.slice().sort(function (a, b) {
      return coyRank(a, school) - coyRank(b, school) || String(a).localeCompare(String(b));
    });
  }

  /* ------------------------------------------------- month detection -- */

  /* --------------------------------------------------------- parsing -- */
  function parseICRF(worksheet, workbook, monthRef, profile) {
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
      var school = Math.min(Math.max(parseInt(am[1], 10) || 4, 1), 4);
      if (profile && school !== profile) {
        res.skipped.push({ row: r, text: a, why: 'belongs to School ' + school + ' (this is the School ' + profile + ' profile)' });
        return;
      }
      var coys = [];
      if (coypart === 'SCHWIDE' || /SCH.*WIDE/.test(coypart)) {
        coys = ['SCHWIDE'];
        res.coySet['SCHWIDE'] = 1;
      } else {
        coypart.split(/\s*\/\s*/).forEach(function (tok) {
          tok = tok.trim().replace(/\s*COY\.?$/i, '').trim().toUpperCase();
          if (companyOK(tok, school)) { coys.push(tok); res.coySet[tok] = 1; }
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
        eDate: eY || sDateY,
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

  /* Parse one troop-lift movement line. Exported so edited lines can be
     re-parsed in the app. Returns {ok:false} or
     {ok:true, fields:{timeStart,from,to,qty,vehicleType,activity,coys,
                       coyLabel,flagged,tbc,kind}} */
  function parseTLLineText(t, school) {
    var lm = TL_LINE.exec(t);
    if (!lm) return { ok: false };
    if (school === undefined || school === null) school = 4;
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
      p = norm(p).toUpperCase().replace(/\s*COY\.?$/i, '').trim();
      if (companyOK(p, school)) coys.push(p);
    });
    // route: split at first " - "
    var from = route, to = '';
    var sep = route.indexOf(' - ');
    if (sep > -1) { from = route.slice(0, sep); to = route.slice(sep + 3); }
    var flagged = /^\*|\*$/.test(t) || (t.length > 2 && t[0] === '*' && t[t.length - 1] === '*');

    return {
      ok: true,
      fields: {
        timeStart: time,
        from: from, to: to,
        qty: cnt,
        vehicleType: noun === 'BUS' ? 'BUSES' : noun,
        kind: 'bus',
        coys: coys,
        coyLabel: coys.join(' / '),
        activity: act.trim() || '—',
        flagged: flagged,
        tbc: time === 'TBC'
      }
    };
  }

  /* ---- columnar TROOPLIFT ("Untitled spreadsheet" / TEKONG NODE style) ----
     A structured TL sheet: header row DATE | DAY | DAY OF WEEK | TIME |
     COY/UNIT | PURPOSE | PICK-UP POINT TO DROP-OFF POINT | NO. OF BUSES |
     REMARKS …, one movement per row. REMARKS like "4x 5-TON" also emit a
     separate tonner movement (same time/route), mirroring the sheet's own
     SCHEDULE TO TEXT (5TONs) column. Junk rows ("-DECEMBER-2026" formulas
     with no time) are skipped, never shown as unparsed. */
  var TL_HEAD_PATTERNS = [
    ['date', /^DATE$/],
    ['day', /^DAY$/],
    ['time', /^TIME$/],
    ['coy', /^COY\s*\/?\s*UNIT$|^COY$/],
    ['activity', /^PURPOSE$/],
    ['route', /^PICK-?UP/i],
    ['qty', /^NO\.?\s*OF\s*BUSES$/],
    ['remarks', /^REMARKS$/]
  ];
  function findTLColumnHeader(ws) {
    var limit = Math.min(30, ws.rowCount || 30);
    for (var r = 1; r <= limit; r++) {
      var map = {}, row = ws.getRow(r), seen = 0;
      for (var c = 1; c <= Math.min(20, ws.columnCount || 20); c++) {
        var t = norm(cellValue(row.getCell(c))).toUpperCase();
        if (!t) continue;
        for (var i = 0; i < TL_HEAD_PATTERNS.length; i++) {
          if (map[TL_HEAD_PATTERNS[i][0]]) continue;       // first match wins
          if (TL_HEAD_PATTERNS[i][1].test(t)) { map[TL_HEAD_PATTERNS[i][0]] = c; seen++; break; }
        }
      }
      if (map.date && map.time && map.coy && map.route && map.qty) return { row: r, map: map, cols: seen };
    }
    return null;
  }
  function tlDateCellToYMD(v) {
    if (v === null || v === undefined || norm(String(v)) === '') return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : ymd(v);
    if (typeof v === 'number' && isFinite(v)) {           // excel date serial
      return excelSerialToYMD(v);
    }
    var t = norm(v).toUpperCase();
    var dm = /^(\d{1,2})[-\/ ]([A-Z]+)[-\/ ](\d{2,4})$/.exec(t);
    if (dm) {
      var mo = MONTH_WORD[dm[2]] || MONTH_WORD[dm[2].slice(0, 3)];
      if (!mo) return null;
      var y = +dm[3]; if (y < 100) y += 2000;
      return y + '-' + pad(mo) + '-' + pad(+dm[1]);
    }
    var ph = TL_TBC_DATE.exec(t);                          // 23/11 or 23/11/26
    if (ph) {
      var y2 = ph[3] ? +ph[3] : new Date().getUTCFullYear();
      if (y2 < 100) y2 += 2000;
      return y2 + '-' + pad(+ph[2]) + '-' + pad(+ph[1]);
    }
    return null;
  }
  function tlComposeText(fields) {
    return fields.timeStart + ' ' + fields.from + ' - ' + fields.to + ' ' +
      (fields.qty ? fields.qty + ' ' : '') + fields.vehicleType +
      ' (' + (fields.coyLabel || fields.coyRaw || '') +
      (fields.coyLabel || fields.coyRaw ? ' ' : '') + fields.activity + ')';
  }
  function parseTROOPLIFT_COLUMNS(ws, head, school) {
    var res = { monthWord: null, tlDateMonths: [], entries: [], lines: [], unmatched: [], coySet: {}, days: {}, tbcDays: {} };
    var curDate = null;
    /* month/year of the sheet, for the DAY-column date fallback: the DATE
       column is often a shared formula whose cached value ExcelJS can't
       read — but col B "DAY" (1, 2, …) plus "DECEMBER-2026" in the header
       rebuilds the date. Header text first, then the sheet name. */
    var colMonth = null, colYear = null;
    var MY_RE = /\b(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER|JAN|FEB|MAR|APR|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b\D{0,3}(\d{2,4})?/;
    (function () {
      var limit = Math.min(30, ws.rowCount || 30);
      for (var r = 1; r <= limit; r++) {
        var row = ws.getRow(r);
        for (var c = 1; c <= Math.min(20, ws.columnCount || 20); c++) {
          var t = norm(cellValue(row.getCell(c))).toUpperCase();
          var m = MY_RE.exec(t);
          if (m && MONTH_WORD[m[1]]) {
            colMonth = MONTH_WORD[m[1]];
            if (m[2]) { colYear = +m[2]; if (colYear < 100) colYear += 2000; }
            return;
          }
        }
      }
      var sm = MY_RE.exec(norm(ws.name).toUpperCase());
      if (sm && MONTH_WORD[sm[1]]) {
        colMonth = MONTH_WORD[sm[1]];
        if (sm[2]) { colYear = +sm[2]; if (colYear < 100) colYear += 2000; }
      }
    })();
    if (colMonth) res.monthWord = colMonth;
    ws.eachRow({ includeEmpty: false }, function (row) {
      var r = row.number;
      if (r <= head.row) return;
      var gv = function (key) {
        var c = head.map[key];
        return c ? cellValue(row.getCell(c)) : null;
      };
      /* date transition — with the DAY-column fallback. Emit a date
         heading line whenever the date changes, so the TL text block
         round-trips (Update) without losing dates. */
      var dv = tlDateCellToYMD(gv('date'));
      if (!dv) {
        var dcell = gv('day'), dayNum = null;
        if (typeof dcell === 'number' && isFinite(dcell)) dayNum = Math.round(dcell);
        else if (/^\d{1,2}(\.0+)?$/.test(norm(dcell))) dayNum = parseInt(norm(dcell), 10);
        if (dayNum >= 1 && dayNum <= 31 && colMonth && colYear) {
          dv = colYear + '-' + pad(colMonth) + '-' + pad(dayNum);
        }
      }
      if (dv && dv !== curDate) {
        curDate = dv;
        res.days[curDate] = 1;
        res.tlDateMonths.push(+dv.slice(5, 7));
        var pd = dv.split('-');
        res.lines.push({ row: r, kind: 'date', date: curDate, text: (+pd[2]) + '/' + (+pd[1]) });
      }

      var timeRaw = gv('time');
      var tTime = norm(timeRaw).toUpperCase();
      var time = tTime === 'TBC' ? 'TBC' : hhmmFromTime(timeRaw);
      var routeRaw = norm(gv('route'));
      var coyRaw = norm(gv('coy'));
      if (!time && !routeRaw && !coyRaw) return;           // placeholder / junk row

      if (!time) {                                          // has coy/route but no time
        res.unmatched.push({ row: r, text: routeRaw || coyRaw });
        res.lines.push({ row: r, kind: 'line', text: routeRaw || coyRaw, status: 'unparsed', date: curDate });
        return;
      }

      var sp = routeRaw.indexOf(' - ');
      var qv = gv('qty');
      var qn = typeof qv === 'number' ? Math.round(qv) : (parseInt(norm(qv), 10) || 0);
      var act = norm(gv('activity')) || '—';
      var coys = [], label = [];
      coyRaw.split('/').forEach(function (p) {
        p = norm(p).toUpperCase().replace(/\s*COY\.?$/i, '').trim();
        if (!p) return;
        if (companyOK(p, school)) coys.push(p);
        label.push(p);
      });
      var fields = {
        timeStart: time,
        from: sp > -1 ? routeRaw.slice(0, sp) : routeRaw,
        to: sp > -1 ? routeRaw.slice(sp + 3) : '',
        qty: qn > 0 ? qn : null,
        vehicleType: 'BUSES', kind: 'bus',
        coys: coys, coyLabel: coys.join(' / '),
        coyRaw: coyRaw, coyAll: label.join(' / '),
        activity: act,
        flagged: false,
        tbc: time === 'TBC'
      };

      function pushEntry(suffix, vehType, q, rawText) {
        var e = {
          id: 't' + r + suffix,
          source: 'TROOPLIFT',
          date: curDate,
          activity: fields.activity,
          officer: '', phone: '', unit: '',
          nextDay: false, dayDiff: 0, eDate: curDate || '',
          from: '', to: '',
          flagged: false,
          tbc: fields.tbc,
          row: r,
          rawText: rawText
        };
        var f2 = {};
        for (var k in fields) f2[k] = fields[k];
        f2.vehicleType = vehType;
        f2.qty = q;
        applyTLFields(e, f2);
        fields.coys.forEach(function (c) { res.coySet[c] = 1; });
        res.entries.push(e);
        res.lines.push({ row: r, kind: 'line', id: e.id, text: rawText, status: 'ok', date: curDate, entryId: e.id });
      }
      var text = tlComposeText({ timeStart: time, from: fields.from, to: fields.to,
        qty: fields.qty, vehicleType: 'BUSES',
        coyLabel: fields.coyLabel, coyRaw: coyRaw, activity: fields.activity });
      pushEntry('', 'BUSES', fields.qty, text);

      /* remarks "4x 5-TON" -> separate tonner movement, same slot */
      var rm = norm(gv('remarks'));
      var tm = /^(\d+)\s*[X×]\s*5-?\s*TON/i.exec(rm);
      if (tm) {
        var tn = parseInt(tm[1], 10);
        var ttext = tlComposeText({ timeStart: time, from: fields.from, to: fields.to,
          qty: tn, vehicleType: 'TONNERS',
          coyLabel: fields.coyLabel, coyRaw: coyRaw, activity: fields.activity });
        pushEntry('x', 'TONNERS', tn, ttext);
      }
    });
    return res;
  }

  function parseTROOPLIFT(worksheet, school) {
    /* TEKONG columnar layout? (DATE/TIME/COY-UNIT/PURPOSE/PICK-UP/BUSES) */
    var head = findTLColumnHeader(worksheet);
    if (head) return parseTROOPLIFT_COLUMNS(worksheet, head, school);
    var res = { monthWord: null, tlDateMonths: [], entries: [], lines: [], unmatched: [], coySet: {}, days: {}, tbcDays: {} };
    var curDate = null;
    worksheet.eachRow({ includeEmpty: true }, function (row) {
      var r = row.number;
      var v = cellValue(row.getCell(1));
      if (v === null || v === undefined || v === '') return;

      if (v instanceof Date) {
        curDate = ymd(v);
        res.days[curDate] = 1;
        res.tlDateMonths.push(v.getUTCMonth() + 1);
        res.lines.push({ row: r, kind: 'date', date: curDate });
        return;
      }
      var t = norm(v);
      if (!t) return;

      // monthly title, e.g. "NOVEMBER TL"
      var mm = /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s*(\d{4})?\s*(TL)?\s*$/i.exec(t);
      if (mm) {
        res.monthWord = MONTH_WORD[mm[1].toUpperCase()];
        res.lines.push({ row: r, kind: 'title', text: t });
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
        var isTbc = /\*\s*TBC\s*\*|\*TBC\*/.test(t);
        if (isTbc) res.tbcDays[curDate] = 1;
        res.lines.push({ row: r, kind: 'date', date: curDate, text: t, tbc: isTbc });
        return;
      }

      var lp = parseTLLineText(t, school);
      if (!lp.ok) {
        res.unmatched.push({ row: r, text: t });
        res.lines.push({ row: r, kind: 'line', text: t, status: 'unparsed', date: curDate });
        return;
      }

      var e = {
        id: 't' + r,
        source: 'TROOPLIFT',
        date: curDate,
        activity: lp.fields.activity,
        officer: '', phone: '', unit: '',
        nextDay: false, dayDiff: 0, eDate: curDate || '',
        from: '', to: '',
        flagged: lp.fields.flagged,
        tbc: lp.fields.tbc,
        row: r,
        rawText: t
      };
      applyTLFields(e, lp.fields);
      lp.fields.coys.forEach(function (c) { res.coySet[c] = 1; });
      res.entries.push(e);
      res.lines.push({ row: r, kind: 'line', text: t, status: 'ok', date: curDate, entryId: e.id });
    });
    return res;
  }

  /* merge parsed TL line fields into an entry (kept rawer fields) */
  function applyTLFields(e, f) {
    e.timeStart = f.timeStart;
    e.from = f.from; e.to = f.to;
    e.qty = f.qty;
    e.vehicleType = f.vehicleType;
    e.kind = 'bus';
    e.coys = f.coys;
    e.coyLabel = f.coyLabel;
    e.activity = f.activity;
    e.flagged = f.flagged;
    e.tbc = f.tbc;
    if (f.timeStart === 'TBC') e.tbc = true;
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

  function combineModels(icrf, tl, school) {
    if (school === undefined || school === null) school = 4;
    var monthRef = makeMonthRef(tl, icrf.sheet);
    var icrfRes = parseICRF(icrf.sheet, icrf.workbook, monthRef, school);

    var entries = icrfRes.entries.concat(tl.entries);

    /* roster order: every company of the school, then any extras found in data */
    var all = [];
    schoolDef(school).companies.forEach(function (c) { all.push(c); });
    for (var k in icrfRes.coySet) if (companyOK(k, school) && all.indexOf(k) === -1) all.push(k);
    for (k in tl.coySet) if (companyOK(k, school) && all.indexOf(k) === -1) all.push(k);
    var companies = sortCoys(all, school);
    icrfRes.school = school;

    return {
      month: monthRef.month(),
      school: school,
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
      tlLines: tl.lines,
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

  /* Parse an ICRF "SCH <n> - <COYS> - <ACTIVITY>" cell. Exported for the
     live sheet's ICRF view and for repairing skipped rows on the fly. */
  function parseICRFColA(text, school) {
    var am = ICRF_ACTIVITY.exec(norm(text));
    if (!am) return { ok: false, msg: 'expected "SCH <n> - <COY> - <ACTIVITY>"' };
    var sn = Math.min(Math.max(parseInt(am[1], 10) || 4, 1), 4);
    if (school !== undefined && school !== null && sn !== school) {
      return { ok: false, msg: 'this is School ' + sn + ' data — the school ' + school + ' profile expects "SCH ' + school + '" rows' };
    }
    var coypart = am[2].trim().toUpperCase();
    var coys = [];
    if (coypart === 'SCHWIDE' || /SCH.*WIDE/.test(coypart)) {
      coys = ['SCHWIDE'];
    } else {
      coypart.split(/\s*\/\s*/).forEach(function (tok) {
        tok = tok.trim().replace(/\s*COY\.?$/i, '').trim().toUpperCase();
        if (companyOK(tok, sn)) coys.push(tok);
      });
    }
    if (!coys.length) return { ok: false, msg: 'no recognised company tag for School ' + (school || sn) };
    return { ok: true, school: sn, coys: coys, activity: am[3].trim() };
  }

  /* export */
  window.TCRS = {
    SCHOOLS: SCHOOLS,
    schoolCompanies: function (n) { return schoolDef(n).companies.slice(); },
    parseWorkbooks: function (icrfWb, tlWb, school) {
      var tlFiles = tlWb.worksheets[0];
      var icrfSheet = null;
      var icrfWbNum = icrfWb.worksheets.length;
      if (icrfWbNum) icrfSheet = icrfWb.worksheets[0];
      var tl = parseTROOPLIFT(tlFiles, school);
      var combined = combineModels({ sheet: icrfSheet, workbook: icrfWb }, tl, school);
      return combined;
    },
    filterEntries: filterEntries,
    sortEntries: sortEntries,
    timeLabel: timeLabel,
    vehicleLabel: vehicleLabel,
    dowOf: dowOf,
    fmtDate: fmtDate,
    parseTLLineText: parseTLLineText,
    parseICRFColA: parseICRFColA,
    applyTLFields: applyTLFields,
    sortCoys: sortCoys,
    MONTH_NAME: MONTH_NAME,
    coyRank: coyRank
  };
})();
