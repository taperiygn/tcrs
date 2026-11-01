#!/usr/bin/env python3
"""Server tests: password gate, no file leaks, persistence across restarts, conflict detection.
Run:  python3 tests/server_test.py"""
import json, os, subprocess, sys, tempfile, time, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT, PW = 8791, "unit-test-pass"
BASE = "http://127.0.0.1:%d" % PORT
fails = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  [%s]" % extra))
    if not cond:
        fails.append(name)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


opener = urllib.request.build_opener(NoRedirect)


def call(method, path, body=None, cookie=None, csrf=True):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    if csrf:
        req.add_header("X-TCRS", "1")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        r = opener.open(req)
    except urllib.error.HTTPError as e:
        r = e
    raw = r.read()
    try:
        data = json.loads(raw)
    except ValueError:
        data = None
    return r.status, data, r.headers


def start(data_dir):
    p = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py")],
                         env=dict(os.environ, TCRS_PASSWORD=PW, PORT=str(PORT), TCRS_DATA_DIR=data_dir),
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            urllib.request.urlopen(BASE + "/healthz")
            return p
        except Exception:
            time.sleep(0.1)
    raise SystemExit("server did not start")


with tempfile.TemporaryDirectory() as d:
    srv = start(d)
    try:
        s, _, h = call("GET", "/")
        check("anonymous / redirects to /login", s == 302 and h["Location"] == "/login", s)
        check("anonymous API is 401", call("GET", "/api/state")[0] == 401)
        check("anonymous static is gated", call("GET", "/app.js")[0] == 302)
        check("login page is public", call("GET", "/login")[0] == 200)
        check("login without CSRF header rejected", call("POST", "/api/login", {"password": PW}, csrf=False)[0] == 403)
        check("wrong password rejected", call("POST", "/api/login", {"password": "nope"})[0] == 401)
        s, _, h = call("POST", "/api/login", {"password": PW})
        cookie = h["Set-Cookie"].split(";")[0]
        check("right password signs in", s == 200 and "HttpOnly" in h["Set-Cookie"] and "SameSite=Lax" in h["Set-Cookie"])
        check("forged cookie rejected", call("GET", "/api/state", cookie="tcrs_session=9999999999.aa.bb")[0] == 401)
        check("site served when signed in", call("GET", "/", cookie=cookie)[0] == 200)
        for leak in ("/server.py", "/data/state.json", "/ICRF.xlsx", "/.git/config", "/tests/server_test.py"):
            check("not served: " + leak, call("GET", leak, cookie=cookie)[0] == 404, leak)

        rec = {"baseRev": 0, "files": {"icrf": {"name": "a.xlsx", "b64": "AA=="}, "tl": {"name": "b.xlsx", "b64": "AA=="}},
               "edits": {"updatedAt": "2026-11-01T00:00:00Z", "entries": [{"id": "x"}], "tlLines": [], "skipped": []},
               "opts": {"view": "coy"}}
        s, r, _ = call("PUT", "/api/state/11-2026", rec, cookie)
        check("save a month", s == 200 and r["rev"] == 1, (s, r))
        check("save needs login", call("PUT", "/api/state/11-2026", rec)[0] == 401)
        check("stale revision gets 409", call("PUT", "/api/state/11-2026", dict(rec, baseRev=0), cookie)[0] == 409)
        check("bad month key rejected", call("PUT", "/api/state/..%2Fevil", rec, cookie)[0] == 404)
        check("bad files shape rejected", call("PUT", "/api/state/10-2026", {"baseRev": 0, "files": {"icrf": 1}}, cookie)[0] == 400)
        s, r, _ = call("PUT", "/api/state/11-2026", {"baseRev": 1, "edits": None}, cookie)
        check("edits can be cleared, files kept", s == 200 and r["rev"] == 2)
    finally:
        srv.terminate(); srv.wait()

    srv = start(d)
    try:
        s, h1, h = call("POST", "/api/login", {"password": PW})
        cookie = h["Set-Cookie"].split(";")[0]
        s, doc, _ = call("GET", "/api/state", cookie=cookie)
        m = doc["months"].get("11-2026", {})
        check("state survives a server restart", doc["last"] == "11-2026" and m.get("rev") == 2 and "files" in m and m["opts"] == {"view": "coy"} and "edits" not in m, doc)
        for i in range(5):
            call("POST", "/api/login", {"password": "bad%d" % i})
        check("lockout after repeated failures", call("POST", "/api/login", {"password": PW})[0] == 429)
    finally:
        srv.terminate(); srv.wait()

print("\n%s" % ("ALL SERVER TESTS PASSED" if not fails else "%d FAILED" % len(fails)))
sys.exit(1 if fails else 0)
