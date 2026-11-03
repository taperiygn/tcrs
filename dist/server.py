#!/usr/bin/env python3
"""TCRS server — serves the site behind a password and stores your work.

Everything (the site, the saved workbooks, every edit) lives behind one shared
password. Edits are written to a JSON file on disk, so they survive closing the
browser, switching devices, and restarting the server.

    TCRS_PASSWORD='something long' python3 server.py

Environment
    TCRS_PASSWORD       required — the shared password
    PORT                default 8000
    HOST                default 127.0.0.1 (use 0.0.0.0 to listen publicly)
    TCRS_DATA_DIR       default ./data   (state.json lives here — keep it on a persistent disk)
    TCRS_SITE_DIR       default: this file's folder
    TCRS_SECRET         optional cookie-signing secret (otherwise generated into the data dir)
    TCRS_SESSION_DAYS   default 30
    TCRS_TRUST_PROXY    set to 1 when behind a reverse proxy / PaaS (uses X-Forwarded-For/-Proto)
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

HERE = Path(__file__).resolve().parent
SITE_DIR = Path(os.environ.get("TCRS_SITE_DIR", HERE)).resolve()
DATA_DIR = Path(os.environ.get("TCRS_DATA_DIR", HERE / "data")).resolve()
PASSWORD = os.environ.get("TCRS_PASSWORD", "")
SESSION_DAYS = float(os.environ.get("TCRS_SESSION_DAYS", "30"))
TRUST_PROXY = os.environ.get("TCRS_TRUST_PROXY", "") == "1"
FORCE_SECURE = os.environ.get("TCRS_COOKIE_SECURE", "") == "1"

MAX_BODY = 12 * 1024 * 1024
MAX_MONTHS = 60
KEY_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
COOKIE = "tcrs_session"

LOGIN_FAILS_MAX = 5
LOGIN_WINDOW = 300          # seconds
LOGIN_LOCKOUT = 300

# Only these files are ever served (never server.py, data/, .git, the root .xlsx copies…).
PUBLIC = {"/login": "login.html", "/login.css": "login.css", "/login.js": "login.js"}
PROTECTED = {
    "/": "index.html", "/index.html": "index.html", "/styles.css": "styles.css",
    "/app.js": "app.js", "/sheet.js": "sheet.js", "/parser.js": "parser.js",
    "/vendor/exceljs.min.js": "vendor/exceljs.min.js",
    "/samples/ICRF.xlsx": "samples/ICRF.xlsx",
    "/samples/Troop Lift Sample.xlsx": "samples/Troop Lift Sample.xlsx",
}
TYPES = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


# ------------------------------------------------------------------ storage --
class Store:
    """state.json = {"last": key|None, "months": {key: record}} — written atomically."""

    def __init__(self, folder):
        self.dir = folder
        self.path = folder / "state.json"
        self.bak = folder / "state.json.bak"
        self.lock = threading.Lock()
        folder.mkdir(parents=True, exist_ok=True)
        self.doc = {"last": None, "months": {}}
        if self.path.exists():
            try:
                self.doc = json.loads(self.path.read_text("utf-8"))
            except ValueError:
                broken = self.path.with_name("state.json.corrupt-%d" % int(time.time()))
                shutil.copy(self.path, broken)
                print("WARNING: state.json was unreadable — kept a copy at %s" % broken, file=sys.stderr)
        self._migrate_legacy_keys()

    def _migrate_legacy_keys(self):
        """Before per-school profiles, months were stored as '<MONTH>-<YEAR>'
        (e.g. '11-2026') and all of it belonged to School 4. Rename those keys
        to the school-prefixed form so the data survives; when the same month
        was re-saved under both names, keep the newest and fill any missing
        edits/files from the other copy. Idempotent."""
        legacy = re.compile(r"^(?:(\d{1,2})|([A-Z]{3,9}))-(\d{4})$")
        changed = False
        for key in [k for k in self.doc.get("months", {}) if legacy.match(k)]:
            months = self.doc["months"]
            new = "s4-" + key
            old = months.pop(key)
            if new not in months:
                months[new] = old
            else:
                cur = months[new]
                late, early = (cur, old) if str(cur.get("savedAt", "")) >= str(old.get("savedAt", "")) else (old, cur)
                merged = dict(late)
                if not (late.get("edits") or {}).get("entries") and (early.get("edits") or {}).get("entries"):
                    merged["edits"] = early["edits"]
                if not late.get("files") and early.get("files"):
                    merged["files"] = early["files"]
                merged["rev"] = max(int(late.get("rev", 0)), int(early.get("rev", 0))) + 1
                months[new] = merged
            changed = True
        last = self.doc.get("last")
        if last and legacy.match(last):
            self.doc["last"] = "s4-" + last
            changed = True
        if changed:
            print("migrated legacy month keys to School 4 profile keys")
            self._write()

    def snapshot(self):
        with self.lock:
            return json.dumps(self.doc)

    def put(self, key, patch):
        """Merge `patch` into one month. Returns (ok, rev)."""
        with self.lock:
            months = self.doc.setdefault("months", {})
            rec = months.get(key)
            base = patch.get("baseRev")
            cur = rec["rev"] if rec else 0
            if (base or 0) != cur:
                return False, cur
            if rec is None:
                if len(months) >= MAX_MONTHS:
                    return False, -1
                rec = months[key] = {"rev": 0}
            for field in ("files", "edits", "opts"):
                if field in patch:
                    if patch[field] is None:
                        rec.pop(field, None)
                    else:
                        rec[field] = patch[field]
            rec["rev"] = cur + 1
            rec["savedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            self.doc["last"] = key
            self._write()
            return True, rec["rev"]

    def delete(self, key):
        with self.lock:
            if self.doc.get("months", {}).pop(key, None) is not None:
                if self.doc.get("last") == key:
                    self.doc["last"] = next(iter(self.doc["months"]), None)
                self._write()

    def _write(self):
        data = json.dumps(self.doc, separators=(",", ":"))
        if self.path.exists() and (not self.bak.exists() or time.time() - self.bak.stat().st_mtime > 600):
            shutil.copy(self.path, self.bak)           # rolling backup, at most every 10 min
        tmp = self.path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)


# --------------------------------------------------------------------- auth --
def load_secret():
    env = os.environ.get("TCRS_SECRET")
    if env:
        raw = env.encode()
    else:
        p = DATA_DIR / "secret.key"
        if not p.exists():
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            p.write_text(secrets.token_hex(32))
            os.chmod(p, 0o600)
        raw = p.read_text().strip().encode()
    # bound to the password so changing the password signs everybody out
    return hmac.new(raw, PASSWORD.encode(), hashlib.sha256).digest()


class Auth:
    def __init__(self):
        self.key = load_secret()
        self.pw_digest = hashlib.sha256(PASSWORD.encode()).digest()
        self.fails = {}                 # ip -> [timestamps]
        self.locked = {}                # ip -> until
        self.lock = threading.Lock()

    def check_password(self, given):
        return hmac.compare_digest(hashlib.sha256(given.encode()).digest(), self.pw_digest)

    def make_token(self):
        exp = str(int(time.time() + SESSION_DAYS * 86400))
        nonce = secrets.token_hex(8)
        body = exp + "." + nonce
        sig = hmac.new(self.key, body.encode(), hashlib.sha256).hexdigest()
        return body + "." + sig

    def valid_token(self, token):
        try:
            exp, nonce, sig = token.split(".")
            good = hmac.new(self.key, (exp + "." + nonce).encode(), hashlib.sha256).hexdigest()
            return hmac.compare_digest(sig, good) and int(exp) > time.time()
        except (ValueError, AttributeError):
            return False

    def throttled(self, ip):
        with self.lock:
            until = self.locked.get(ip, 0)
            if until > time.time():
                return int(until - time.time()) + 1
            self.locked.pop(ip, None)
            return 0

    def record_fail(self, ip):
        now = time.time()
        with self.lock:
            hits = [t for t in self.fails.get(ip, []) if now - t < LOGIN_WINDOW] + [now]
            self.fails[ip] = hits
            if len(hits) >= LOGIN_FAILS_MAX:
                self.locked[ip] = now + LOGIN_LOCKOUT
                self.fails.pop(ip, None)

    def record_ok(self, ip):
        with self.lock:
            self.fails.pop(ip, None)


STORE = None
AUTH = None


# ------------------------------------------------------------------ handler --
class Handler(BaseHTTPRequestHandler):
    server_version = "TCRS"
    sys_version = ""
    protocol_version = "HTTP/1.0"      # one request per connection — no unread-body hazards

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.client_ip(), fmt % args))

    # -- helpers
    def client_ip(self):
        if TRUST_PROXY:
            fwd = self.headers.get("X-Forwarded-For", "")
            if fwd:
                return fwd.split(",")[-1].strip()
        return self.client_address[0]

    def is_https(self):
        return FORCE_SECURE or (TRUST_PROXY and self.headers.get("X-Forwarded-Proto", "") == "https")

    def authed(self):
        for part in self.headers.get("Cookie", "").split(";"):
            name, _, val = part.strip().partition("=")
            if name == COOKIE and AUTH.valid_token(val):
                return True
        return False

    def send_bytes(self, code, body, ctype, extra=None, cache="no-store"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        if self.is_https():
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        for k, v in (extra or []):
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, code, obj, extra=None):
        self.send_bytes(code, json.dumps(obj).encode(), "application/json", extra)

    def redirect(self, where):
        self.send_bytes(302, b"", "text/plain", [("Location", where)])

    def read_json(self):
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = -1
        if n < 0 or n > MAX_BODY:
            self.send_json(413, {"error": "payload too large"})
            return None
        raw = self.rfile.read(n) if n else b""
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            self.send_json(400, {"error": "invalid JSON"})
            return None
        if not isinstance(data, dict):
            self.send_json(400, {"error": "expected an object"})
            return None
        return data

    def csrf_ok(self):
        # A custom header forces a CORS preflight, which this server never grants.
        return self.headers.get("X-TCRS") == "1"

    def serve_file(self, rel):
        path = (SITE_DIR / rel).resolve()
        if SITE_DIR not in path.parents or not path.is_file():
            return self.send_json(404, {"error": "not found"})
        self.send_bytes(200, path.read_bytes(), TYPES.get(path.suffix, "application/octet-stream"),
                        cache="no-cache")

    # -- routes
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path == "/healthz":
            return self.send_bytes(200, b"ok", "text/plain")
        if path in PUBLIC:
            if path == "/login" and self.authed():
                return self.redirect("/")
            return self.serve_file(PUBLIC[path])
        if not self.authed():
            if path.startswith("/api/"):
                return self.send_json(401, {"error": "login required"})
            return self.redirect("/login")
        if path == "/api/state":
            return self.send_bytes(200, STORE.snapshot().encode(), "application/json")
        if path in PROTECTED:
            return self.serve_file(PROTECTED[path])
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        path = unquote(urlsplit(self.path).path)
        if not self.csrf_ok():
            return self.send_json(403, {"error": "bad request"})
        if path == "/api/login":
            return self.login()
        if path == "/api/logout":
            return self.send_json(200, {"ok": True}, [("Set-Cookie", self.cookie("", 0))])
        self.send_json(404, {"error": "not found"})

    def do_PUT(self):
        path = unquote(urlsplit(self.path).path)
        if not self.csrf_ok():
            return self.send_json(403, {"error": "bad request"})
        if not self.authed():
            return self.send_json(401, {"error": "login required"})
        m = re.match(r"^/api/state/([^/]+)$", path)
        if not m or not KEY_RE.match(m.group(1)):
            return self.send_json(404, {"error": "not found"})
        body = self.read_json()
        if body is None:
            return
        if "files" in body and body["files"] is not None:
            f = body["files"]
            if not isinstance(f, dict) or not all(isinstance(f.get(k), dict) for k in ("icrf", "tl")):
                return self.send_json(400, {"error": "files must contain icrf and tl"})
        ok, rev = STORE.put(m.group(1), body)
        if rev == -1:
            return self.send_json(507, {"error": "too many saved months"})
        if not ok:
            return self.send_json(409, {"error": "newer version exists", "rev": rev})
        self.send_json(200, {"ok": True, "rev": rev})

    def do_DELETE(self):
        path = unquote(urlsplit(self.path).path)
        if not self.csrf_ok():
            return self.send_json(403, {"error": "bad request"})
        if not self.authed():
            return self.send_json(401, {"error": "login required"})
        m = re.match(r"^/api/state/([^/]+)$", path)
        if not m or not KEY_RE.match(m.group(1)):
            return self.send_json(404, {"error": "not found"})
        STORE.delete(m.group(1))
        self.send_json(200, {"ok": True})

    def cookie(self, value, max_age):
        parts = ["%s=%s" % (COOKIE, value), "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=%d" % max_age]
        if self.is_https():
            parts.append("Secure")
        return "; ".join(parts)

    def login(self):
        ip = self.client_ip()
        wait = AUTH.throttled(ip)
        if wait:
            return self.send_json(429, {"error": "Too many attempts. Try again in %d min." % ((wait + 59) // 60)})
        body = self.read_json()
        if body is None:
            return
        given = body.get("password")
        if isinstance(given, str) and AUTH.check_password(given):
            AUTH.record_ok(ip)
            return self.send_json(200, {"ok": True},
                                  [("Set-Cookie", self.cookie(AUTH.make_token(), int(SESSION_DAYS * 86400)))])
        AUTH.record_fail(ip)
        time.sleep(0.6)
        self.send_json(401, {"error": "Wrong password."})


SWEEP_INTERVAL = 6 * 3600    # deletions run at startup, then every 6 hours


# ------------------------------------------------- past-dated automation --
def sweep_past_dates(store):
    """Backend automation: movements whose last day is in the past are
    deleted from every stored month. Nothing is lost — the removed rows go
    to data/archive-<timestamp>.json and the source workbooks are untouched."""
    today = time.strftime("%Y-%m-%d")
    removed = {}
    with store.lock:
        for key, rec in store.doc.get("months", {}).items():
            ed = rec.get("edits")
            if not isinstance(ed, dict) or not isinstance(ed.get("entries"), list):
                continue
            keep, gone = [], []
            for e in ed["entries"]:
                end = e.get("eDate") or e.get("date") or ""
                if isinstance(end, str) and len(end) == 10 and end[4] == "-" and end < today:
                    gone.append(e)
                else:
                    keep.append(e)
            if gone:
                removed[key] = gone
                ed["entries"] = keep   # undated / current / future rows survive
    if not removed:
        return 0
    stamp = time.strftime("%Y%m%d-%H%M%S")
    archive = store.dir / ("archive-%s.json" % stamp)
    archive.write_text(json.dumps(
        {"sweeper": "past-dated", "ranAt": today, "months": removed}, indent=1,
    ), encoding="utf-8")
    store._write()
    n = sum(len(v) for v in removed.values())
    print("sweeper: removed %d past-dated row%s across %d month%s — archived to %s"
          % (n, "" if n == 1 else "s", len(removed), "" if len(removed) == 1 else "s", archive.name),
          flush=True)
    return n


def sweep_loop(store, interval):
    """Runs the sweep at startup and again every `interval` seconds."""
    while True:
        try:
            sweep_past_dates(store)
        except Exception as exc:            # never take the server down over the sweep
            print("sweeper error: %r" % exc, file=sys.stderr, flush=True)
        time.sleep(interval)


def main():
    global STORE, AUTH
    if len(PASSWORD) < 6:
        sys.exit("Set TCRS_PASSWORD (at least 6 characters) before starting, e.g.\n"
                 "  TCRS_PASSWORD='a long passphrase' python3 server.py")
    STORE = Store(DATA_DIR)
    AUTH = Auth()
    threading.Thread(target=sweep_loop, args=(STORE, SWEEP_INTERVAL), daemon=True).start()
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    print("TCRS listening on http://%s:%d  (data: %s)" % (host, port, DATA_DIR), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
