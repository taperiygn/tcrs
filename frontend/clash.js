/* TCRS bus-clash checker.
   Simulates the school's small bus fleet across each day and flags:
   - red    a trip that cannot run (buses not at the origin in time, more
            buses asked for than exist, or the bus count is missing)
   - orange a trip the buses can only just make if they drive fast
            (shortfall within GRACE_MIN minutes)
   - purple a trip that starts before the day's first legal movement time
            (0700) — needs special permission, not a clash
   Trips whose route is not in the duration table are skipped but counted,
   so the blind spot stays visible.

   Pure module: no DOM. The live sheet tab renders what analyze() returns. */
(function () {
  'use strict';

  var FLEET = 4;          // buses in the school
  var DAY_START = 7 * 60; // 0700 in minutes — earliest movement without special permission
  var GRACE_MIN = 5;      // "driving fast" tolerance before orange turns red

  /* One-way trip durations in minutes; the return leg takes the same.
     Keys below are written readably; the lookup normalises them to a
     canonical (sorted) pair so direction never matters. */
  var TRIPS = {
    'MTL|RHC': 15,
    'RHC|100M RANGE': 10,
    'RHC|FC SITE 6': 10,
    'RHC|FC SITE 10': 10,
    'RHC|FC SITE 11': 10,
    'RHC|S1': 15,
    'RHC|HG RANGE': 10
  };
  var LOOKUP = {};
  Object.keys(TRIPS).forEach(function (k) {
    var p = k.split('|');
    LOOKUP[tripKey(p[0], p[1])] = TRIPS[k];
  });

  /* Location names arrive from spreadsheets — tolerate the usual mess:
     case, stray spaces, the RANGLE typo, 100M RANGE's numbered gates. */
  function normalizeLoc(s) {
    s = String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
    if (s === 'HG RANGLE') s = 'HG RANGE';
    var m = /^100M RANGE( [12])?$/.exec(s);
    if (m) s = '100M RANGE';
    return s;
  }
  function tripKey(a, b) {
    var u = normalizeLoc(a), v = normalizeLoc(b);
    return u < v ? u + '|' + v : v + '|' + u;
  }
  function tripMinutes(from, to) {
    var d = LOOKUP[tripKey(from, to)];
    return typeof d === 'number' ? d : null;
  }

  function toMin(hhmm) {
    var m = /^(\d{1,2})(\d{2})$/.exec(String(hhmm || '').trim());
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  }
  function hhmm(min) {
    min = Math.round(min);
    return ('0' + Math.floor(min / 60) % 24).slice(-2) + ('0' + (min % 60)).slice(-2);
  }

  /* Analyse bus movements (kind 'bus') day by day. Entries need
     {id, date, timeStart, from, to, qty, activity, coys}. Returns
     { flags, unchecked, checked } — flags sorted by date then time. */
  function analyze(entries, opts) {
    opts = opts || {};
    var fleet = opts.fleet || FLEET;
    var dayStart = typeof opts.dayStart === 'number' ? opts.dayStart : DAY_START;
    var grace = typeof opts.grace === 'number' ? opts.grace : GRACE_MIN;

    var byDay = {};
    var unchecked = 0, checked = 0;
    (entries || []).forEach(function (e) {
      if (!e || e.kind !== 'bus') return;
      var day = e.date;
      if (!day || typeof day !== 'string' || day.length !== 10) { unchecked++; return; }
      (byDay[day] = byDay[day] || []).push(e);
    });

    var flags = [];
    Object.keys(byDay).sort().forEach(function (day) {
      var rows = byDay[day].slice().sort(function (a, b) {
        return (toMin(a.timeStart) || 0) - (toMin(b.timeStart) || 0);
      });
      /* buses start the day unplaced: they may be at any location, but
         cannot move before DAY_START without special permission */
      var buses = [];
      for (var i = 0; i < fleet; i++) buses.push({ loc: null, free: -1 });

      rows.forEach(function (e) {
        var s = toMin(e.timeStart);
        var d = s === null ? null : tripMinutes(e.from, e.to);
        if (s === null || d === null) { unchecked++; return; }   // unknown route/time
        checked++;

        var need = Math.round(+(e.qty === null || e.qty === undefined ? NaN : e.qty));
        var base = {
          id: e.id, date: day, time: e.timeStart, qty: isNaN(need) ? null : need,
          route: normalizeLoc(e.from) + ' → ' + normalizeLoc(e.to),
          activity: e.activity || '', coys: e.coys || [], from: normalizeLoc(e.from), to: normalizeLoc(e.to),
          dur: d
        };

        if (isNaN(need) || need <= 0) {
          flags.push(Object.assign({ severity: 'red',
            msg: 'number of buses missing — fill in how many this trip needs' }, base));
          return;
        }
        if (need > fleet) {
          flags.push(Object.assign({ severity: 'red',
            msg: 'asks for ' + need + ' buses — the school only has ' + fleet }, base));
          return;
        }

        /* buses already at the origin go first, then unplaced ones */
        var atOrigin = [], elsewhere = [];
        buses.forEach(function (b, idx) {
          if (b.loc === null) { if (b.free <= s) atOrigin.push(idx); }
          else if (b.loc === normalizeLoc(e.from) && b.free <= s) atOrigin.push(idx);
          else elsewhere.push(idx);
        });

        if (atOrigin.length >= need) {
          dispatch(buses, atOrigin.slice(0, need), e, s, d);
          if (s < dayStart) flags.push(Object.assign({ severity: 'perm',
            msg: 'starts ' + e.timeStart + ' — before ' + hhmm(dayStart) + ', needs special permission' }, base));
          return;
        }

        /* short — when can the missing buses reach the origin? */
        var missing = need - atOrigin.length;
        var used = atOrigin.slice();
        var earliest = -1, unknown = false;
        var cand = elsewhere.slice().sort(function (a, b) {
          return buses[a].free - buses[b].free;
        });
        for (var k = 0; k < cand.length && missing > 0; k++) {
          var b = buses[cand[k]];
          var dd = b.loc === null ? 0
            : (b.loc === normalizeLoc(e.from) ? 0 : tripMinutes(b.loc, e.from));
          if (dd === null) { unknown = true; break; }
          var ready = Math.max(b.free, dayStart) + dd;   // unplaced buses can move from DAY_START
          if (earliest < 0 || ready < earliest) earliest = ready;
          used.push(cand[k]);
          missing--;
        }
        if (unknown || missing > 0) {
          flags.push(Object.assign({ severity: 'red',
            msg: 'needs ' + need + ' buses at ' + normalizeLoc(e.from) + ' ' + e.timeStart +
                 ' — not enough buses can be there' }, base));
          return;
        }

        var late = earliest - s;
        /* dispatch on-time buses so they leave at s; buses that can only
           make it late effectively depart at `earliest`, occupying the
           bus until then + trip time */
        var dep = Math.max(s, earliest);
        dispatch(buses, atOrigin, e, s, d);
        var lateIdx = used.filter(function (i) { return atOrigin.indexOf(i) === -1; });
        lateIdx.forEach(function (i) { buses[i].loc = normalizeLoc(e.to); buses[i].free = dep + d; });
        if (late > grace) {
          flags.push(Object.assign({ severity: 'red',
            msg: 'needs ' + need + ' buses at ' + normalizeLoc(e.from) + ' ' + e.timeStart +
                 ' — earliest free ' + hhmm(earliest) + ' (' + late + ' min late)' }, base));
        } else if (late > 0) {
          flags.push(Object.assign({ severity: 'orange',
            msg: 'buses only just make ' + e.timeStart + ' — free ' + hhmm(earliest) +
                 ' (' + late + ' min late, they must drive fast)' }, base));
        } else if (s < dayStart) {
          flags.push(Object.assign({ severity: 'perm',
            msg: 'starts ' + e.timeStart + ' — before ' + hhmm(dayStart) + ', needs special permission' }, base));
        }
      });
    });

    flags.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (toMin(a.time) || 0) - (toMin(b.time) || 0); });
    return { flags: flags, unchecked: unchecked, checked: checked };
  }

  /* send buses on a trip: they end at the destination, free on arrival */
  function dispatch(buses, idxs, e, s, d) {
    var dest = normalizeLoc(e.to);
    idxs.forEach(function (i) { buses[i].loc = dest; buses[i].free = s + d; });
  }

  window.TCRSClash = {
    analyze: analyze,
    normalizeLoc: normalizeLoc,
    tripMinutes: tripMinutes,
    FLEET: FLEET, DAY_START: DAY_START, GRACE_MIN: GRACE_MIN
  };
})();
