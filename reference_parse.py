#!/usr/bin/env python3
"""Reference implementation of the combine logic (mirrors parser.js) used to
derive expected values for tests/test.html assertions."""
import re, collections, datetime
import openpyxl

MONTHS = {m: i + 1 for i, m in enumerate(
    ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY',
     'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'])}

def ord_rank(t):
    m = re.match(r'^(\d+)(ST|ND|RD|TH)$', t.upper())
    return int(m.group(1)) if m else 99

def norm(s):
    return re.sub(r'\s+', ' ', s.replace('\xa0', ' ')).strip()

def text_date(s, target):
    s = s.strip().strip('*').strip()
    m = re.match(r'^(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?', s)
    if not m:
        return None
    d, mo = int(m.group(1)), int(m.group(2))
    y = m.group(3)
    y = (2000 + int(y)) if y and int(y) < 100 else 2026 if not y else int(y)
    if mo != target and mo != d and d == target:
        d, mo = mo, d
    return datetime.date(y, mo, d)

def main():
    fixes = []
    # ---------------- ICRF ----------------
    wb = openpyxl.load_workbook('ICRF.xlsx', data_only=True)
    ws = wb.worksheets[0]
    target = 11  # NOV detected from 'V1 NOV'
    icrf_entries = []
    for r in range(1, ws.max_row + 1):
        a = ws.cell(r, 1).value
        if not isinstance(a, str):
            continue
        a = a.strip()
        m = re.match(r'^SCH\s*(\d+)\s*-\s*(.+?)\s*-\s*(.+)$', a, re.I)
        if not m:
            if a and not re.match(r'^(PREPARK VEHICLE|AMMO VEHICLE|RECENTLY ADDED|NOT CONFIRMED|) $', a):
                print('ICRF skipped r%d: %r' % (r, a))
            continue
        coypart, act = m.group(2).strip(), m.group(3).strip()
        coys = []
        if coypart.upper() == 'SCHWIDE':
            coys = ['SCHWIDE']
        else:
            for tok in re.split(r'\s*/\s*', coypart):
                tok = re.sub(r'\s*COY\.?\s*$', '', tok.strip(), flags=re.I).upper()
                if re.match(r'^\d+(ST|ND|RD|TH)$', tok):
                    coys.append(tok)
        if not coys:
            print('ICRF no-coy r%d: %r' % (r, a))
            continue
        v = ws.cell(r, 5).value
        if hasattr(v, 'year'):
            d = v.date()
            if d.month != target:
                try:
                    sw = d.replace(day=1).replace(month=d.day, day=d.month)
                except Exception:
                    sw = None
                if sw and sw.month == target:
                    d = sw
                    fixes.append(('ICRF', r))
        elif isinstance(v, str):
            d = text_date(v, target)
            if d and (d.month != target):
                continue
        else:
            d = None
        if d is None:
            print('ICRF nodate r%d' % r)
            continue
        icrf_entries.append({'date': d.isoformat(), 'coys': coys, 'act': act,
                             'veh': str(ws.cell(r, 2).value).strip()})
    # ---------------- Troop Lift ----------------
    wb2 = openpyxl.load_workbook('Troop Lift Sample.xlsx', data_only=True)
    ws2 = wb2.worksheets[0]
    tl_entries, tl_days = [], set()
    unmatched = []
    cur_date = None
    line_re = re.compile(
        r'^\*?\s*(\d{4}|TBC)\s+(.+?)\s+(\d+)\s+(BUSES|BUS|TONNERS|TONNER)\s*\((.*)\)\*?\s*$',
        re.I)
    line_re_nocnt = re.compile(
        r'^\*?\s*(\d{4}|TBC)\s+(.+?)\s+(BUSES|BUS|TONNERS|TONNER)\s*\((.*)\)\*?\s*$',
        re.I)
    months_seen = collections.Counter()
    for r in range(1, ws2.max_row + 1):
        v = ws2.cell(r, 1).value
        if v is None:
            continue
        if hasattr(v, 'year'):
            cur_date = v.date().isoformat(); tl_days.add(cur_date)
            months_seen[v.month] += 1
            continue
        if not isinstance(v, str) or not v.strip():
            continue
        t = v.strip()
        mo = re.match(r'^\*?\s*(NOVEMBER|DECEMBER|JANUARY|FEBRUARY|FEB|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOV|DEC)\b',
                      t.upper())
        if mo:
            months_seen[MONTHS.get(mo.group(1)[:3].upper(), 0) or MONTHS.get(mo.group(1).upper(), 0)] += 1
            continue
        dm = re.match(r'^\*?\s*(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\s*(?:\(\s*\*?TBC\*?\s*\))?\*?\s*$', t)
        if dm:
            cur_date = text_date(t, 11).isoformat(); tl_days.add(cur_date)
            continue
        t2 = norm(t)
        m = line_re.match(t2) or line_re_nocnt.match(t2)
        if not m:
            unmatched.append((r, v))
            continue
        time, route, cnt, noun, paren = m.group(1), m.group(2), m.group(3) or m.group(0), m.group(0), None
        if line_re.match(t2):
            time, route, cnt, noun, paren = m.groups()
            cnt = int(cnt); noun = noun.upper()
        else:
            time, route, noun, paren = m.groups()
            cnt = None; noun = noun.upper()
        paren = norm(paren).strip()
        if ' ' in paren:
            tag, rest = paren.split(' ', 1)
        else:
            tag, rest = paren, ''
        ordinals = re.findall(r'\d+(?:ST|ND|RD|TH)', tag.upper())
        coys = [x.upper() for x in ordinals]
        if '/' in tag:
            parts = [p.strip().upper() for p in tag.split('/')]
            ordinals2 = [p for p in parts if re.match(r'^\d+(ST|ND|RD|TH)$', p)]
            if len(ordinals2) > 1:
                coys = [''] * len(ordinals2)
                coys = [x for x in ordinals2]
        if cur_date is None:
            unmatched.append((r, 'no date: ' + v))
            continue
        tl_entries.append({'date': cur_date, 'time': time, 'coys': coys,
                           'act': rest.strip(), 'from': route.split(' - ')[0].strip() if ' - ' in route else route,
                           'to': route.split(' - ')[1].strip() if ' - ' in route else '',
                           'cnt': cnt, 'noun': noun})
    SCH4 = {'1ST', '4TH', '5TH', '6TH', '7TH', 'SCHWIDE'}
    icrf_keys = collections.Counter()
    for e in icrf_entries:
        for c in set(e['coys']):
            icrf_keys[(e['date'], c)] += 1
    tl_sch4 = [e for e in tl_entries if set(e['coys']) & SCH4]
    tl_key = collections.Counter()
    for e in tl_sch4:
        for c in set(e['coys']):
            tl_key[(e['date'], c)] += 1
    days = sorted(set([e['date'] for e in icrf_entries] +
                      [e['date'] for e in tl_sch4]))
    print('== EXPECTED VALUES ==')
    print('icrf entries:', len(icrf_entries), '| with fixes:', len(fixes))
    print('icrf days:', len(set(e["date"] for e in icrf_entries)))
    print('icrf coy set:', sorted(set(c for e in icrf_entries for c in e["coys"])))
    print('icrf veh types:', dict(collections.Counter(e["veh"] for e in icrf_entries)))
    print('tl entries total:', len(tl_entries), '| sch4-relevant:', len(tl_sch4),
          '| unmatched:', unmatched)
    print('tl days:', len(tl_days), sorted(tl_days))
    print('tl buses (sch4):', sum(e["cnt"] or 1 for e in tl_sch4 if e["noun"].startswith("BUS")),
          'tonners:', sum(e["cnt"] or 1 for e in tl_sch4 if e["noun"].startswith("TONNER")))
    print('merged days:', len(days), days[0], '->', days[-1])
    print('tl tags present (sch4):', sorted(set(e['coys'][0] for e in tl_sch4)))
    print('tl act samples:', dict(collections.Counter(e['act'] for e in tl_sch4).most_common(15)))
    d2 = {'2': icrf_keys[('2026-11-02', '6TH')], }
    for day in ['2026-11-02', '2026-11-04', '2026-11-12', '2026-11-18']:
        print(day, 'icrf:', {c: icrf_keys[(day, c)] for c in SCH4 if icrf_keys[(day, c)]},
              'tl:', {c: tl_key[(day, c)] for c in SCH4 if tl_key[(day, c)]})
    print('fixes:', fixes)

if __name__ == '__main__':
    main()
