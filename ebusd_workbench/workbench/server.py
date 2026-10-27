"""HTTP server: JSON API for the browser UI and the static files of the UI itself.

Reached through Home Assistant ingress only (no published port), so requests are accepted from
the ingress proxy and localhost unless WORKBENCH_ALLOW_ANY is set for development.
"""

import json
import logging
import mimetypes
import os
import re
import time
import traceback
import urllib.parse
from email.utils import formatdate, parsedate_to_datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import __version__, deploy
from .gitrepo import RepoError, safe_relative

log = logging.getLogger("http")

INGRESS_PROXY = "172.30.32.2"
LOCAL_CLIENTS = ("127.0.0.1", "::1", "::ffff:127.0.0.1")
MAX_BODY = 32 * 1024 * 1024
ROUTES = []


def route(method, pattern):
    def register(func):
        ROUTES.append((method, re.compile("^" + pattern + "$"), func))
        return func
    return register


class ApiError(Exception):
    def __init__(self, message, status=HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.status = status


class Context:
    def __init__(self, db, settings, repo, ha=None, deploy_dir=None, www_dir=None, allow_any=False):
        self.db = db
        self.settings = settings
        self.repo = repo
        self.ha = ha
        self.deploy_dir = deploy_dir
        self.www_dir = www_dir
        self.allow_any = allow_any or os.environ.get("WORKBENCH_ALLOW_ANY") == "1"
        self.started = time.time()


def window(query, default_span_ms=3600_000):
    """from/to query parameters in ms with defaults (last hour)."""
    now = int(time.time() * 1000)
    to_ms = int(query.get("to", now))
    from_ms = int(query.get("from", to_ms - default_span_ms))
    if from_ms >= to_ms:
        raise ApiError("'from' must be before 'to'")
    return from_ms, to_ms


def int_or_none(value, base=10):
    if value is None or value == "":
        return None
    return int(value, base)


# -- API routes -------------------------------------------------------------------

@route("GET", "/api/health")
def api_health(ctx, req):
    return {"ok": True, "version": __version__}


@route("GET", "/api/status")
def api_status(ctx, req):
    return {
        "version": __version__,
        "now_ms": int(time.time() * 1000),
        "uptime_s": int(time.time() - ctx.started),
        "db": ctx.db.info(),
        "ha": ctx.ha.status() if ctx.ha else {"configured": False, "connected": False, "entities": []},
        "repo": ctx.repo.status(),
        "deploy_dir": ctx.deploy_dir,
        "settings": ctx.settings.as_dict(),
    }


@route("GET", "/api/settings")
def api_settings(ctx, req):
    return ctx.settings.as_dict()


@route("PUT", "/api/settings")
def api_settings_put(ctx, req):
    try:
        entities_changed = ctx.settings.update(req.json())
    except (ValueError, TypeError) as err:
        raise ApiError(str(err))
    if entities_changed and ctx.ha:
        ctx.ha.resubscribe()
    return ctx.settings.as_dict()


@route("GET", "/api/telegrams/histogram")
def api_histogram(ctx, req):
    from_ms, to_ms = window(req.query, 10 * 86400_000)
    bucket = max(1, min(86400, int(req.query.get("bucket", 3600))))
    return {"from_ms": from_ms, "to_ms": to_ms, "bucket_s": bucket, "buckets": ctx.db.histogram(from_ms, to_ms, bucket)}


@route("GET", "/api/telegrams/runs")
def api_runs(ctx, req):
    from_ms, to_ms = window(req.query)
    settings = ctx.settings.as_dict()
    id_bytes = int(req.query.get("idbytes", settings["id_bytes"]))
    overrides = dict(settings["id_overrides"])
    if "overrides" in req.query:
        overrides = {}
        for item in req.query["overrides"].split(","):
            if ":" in item:
                pbsb, length = item.split(":", 1)
                overrides[pbsb.strip().lower()] = int(length)
    max_rows = max(1000, min(2_000_000, int(req.query.get("max", 300_000))))
    return ctx.db.runs(from_ms, to_ms, id_bytes=id_bytes, id_overrides=overrides, max_rows=max_rows)


@route("GET", "/api/telegrams")
def api_telegrams(ctx, req):
    from_ms, to_ms = window(req.query)
    q = req.query
    return {"telegrams": ctx.db.telegrams(
        from_ms, to_ms, qq=int_or_none(q.get("qq"), 16), zz=int_or_none(q.get("zz"), 16),
        pb=int_or_none(q.get("pb"), 16), sb=int_or_none(q.get("sb"), 16), id_prefix=q.get("id") or None,
        limit=int(q.get("limit", 500)), order=q.get("order", "DESC"))}


@route("GET", "/api/telegrams/distinct")
def api_distinct(ctx, req):
    from_ms, to_ms = window(req.query)
    return {"telegrams": ctx.db.distinct(from_ms, to_ms, limit=int(req.query.get("limit", 2000)),
                                          only_ok=req.query.get("all") != "1")}


@route("GET", "/api/events")
def api_events(ctx, req):
    from_ms, to_ms = window(req.query)
    return {"events": ctx.db.events(from_ms, to_ms), "entities": ctx.db.event_entities()}


@route("POST", "/api/events")
def api_events_post(ctx, req):
    body = req.json()
    note = str(body.get("note") or "").strip()[:500]
    if not note:
        raise ApiError("a note is required")
    ts_ms = body.get("ms")
    event_id = ctx.db.add_event("marker", note=note, ts_ns=int(ts_ms) * 1_000_000 if ts_ms else None)
    return {"id": event_id}


@route("DELETE", "/api/events/(?P<id>[0-9]+)")
def api_events_delete(ctx, req):
    if not ctx.db.delete_event(int(req.params["id"])):
        raise ApiError("no such event", HTTPStatus.NOT_FOUND)
    return {"ok": True}


@route("GET", "/api/ha/entities")
def api_ha_entities(ctx, req):
    if not ctx.ha or not ctx.ha.token:
        raise ApiError("Home Assistant API not available", HTTPStatus.SERVICE_UNAVAILABLE)
    try:
        states = ctx.ha.states()
    except OSError as err:
        raise ApiError(f"Home Assistant API: {err}", HTTPStatus.BAD_GATEWAY)
    q = (req.query.get("q") or "").lower().strip()
    if q:
        states = [s for s in states if q in (s["entity_id"] or "").lower() or q in (s["name"] or "").lower()]
    return {"entities": states[:200], "total": len(states)}


@route("GET", "/api/repo")
def api_repo(ctx, req):
    return ctx.repo.status()


@route("POST", "/api/repo/clone")
def api_repo_clone(ctx, req):
    body = req.json()
    ctx.repo.clone(body.get("url", ""), body.get("branch") or None)
    return ctx.repo.status()


@route("POST", "/api/repo/init")
def api_repo_init(ctx, req):
    ctx.repo.init()
    return ctx.repo.status()


@route("POST", "/api/repo/(?P<action>fetch|pull|push)")
def api_repo_remote(ctx, req):
    return getattr(ctx.repo, req.params["action"])()


@route("POST", "/api/repo/commit")
def api_repo_commit(ctx, req):
    body = req.json()
    return ctx.repo.commit(body.get("message", ""), body.get("paths") or None)


@route("POST", "/api/repo/discard")
def api_repo_discard(ctx, req):
    return ctx.repo.discard(req.json().get("path", ""))


@route("POST", "/api/repo/checkout")
def api_repo_checkout(ctx, req):
    body = req.json()
    return ctx.repo.checkout(body.get("branch", ""), bool(body.get("create")))


@route("GET", "/api/repo/branches")
def api_repo_branches(ctx, req):
    return {"branches": ctx.repo.branches()}


@route("GET", "/api/repo/log")
def api_repo_log(ctx, req):
    return {"log": ctx.repo.log(int(req.query.get("limit", 30)))}


@route("GET", "/api/repo/diff")
def api_repo_diff(ctx, req):
    return {"diff": ctx.repo.diff(req.query.get("path") or None, req.query.get("staged") == "1")}


@route("GET", "/api/repo/tree")
def api_repo_tree(ctx, req):
    if not ctx.repo.exists():
        return {"entries": []}
    return {"entries": ctx.repo.tree()}


@route("GET", "/api/repo/file")
def api_repo_file(ctx, req):
    return {"path": req.query.get("path"), "content": ctx.repo.read_file(req.query.get("path", ""))}


@route("PUT", "/api/repo/file")
def api_repo_file_put(ctx, req):
    ctx.repo.write_file(req.query.get("path", ""), req.text())
    return {"ok": True}


@route("DELETE", "/api/repo/file")
def api_repo_file_delete(ctx, req):
    ctx.repo.delete_file(req.query.get("path", ""))
    return {"ok": True}


@route("GET", "/api/repo/sources")
def api_repo_sources(ctx, req):
    return {"files": ctx.repo.sources(req.query.get("dir", ""))}


@route("GET", "/api/deploy")
def api_deploy(ctx, req):
    return deploy.list_deployed(ctx.deploy_dir)


@route("POST", "/api/deploy")
def api_deploy_post(ctx, req):
    body = req.json()
    return deploy.deploy(body.get("files"), ctx.deploy_dir, body.get("subdir") or "", bool(body.get("clean")))


# -- request handling -------------------------------------------------------------

class Request:
    def __init__(self, handler, path, query, params):
        self.handler = handler
        self.path = path
        self.query = query
        self.params = params
        self._body = None

    def body(self):
        if self._body is None:
            length = int(self.handler.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                raise ApiError("request too large", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            self._body = self.handler.rfile.read(length) if length else b""
        return self._body

    def text(self):
        return self.body().decode("utf-8", errors="replace")

    def json(self):
        if not self.body():
            return {}
        try:
            data = json.loads(self.body())
        except ValueError:
            raise ApiError("invalid JSON body")
        if not isinstance(data, dict):
            raise ApiError("JSON object expected")
        return data


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"ebusd-workbench/{__version__}"
    ctx = None  # set by make_server

    def log_message(self, fmt, *args):
        log.debug(fmt, *args)

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def do_HEAD(self):
        self.dispatch("GET", head=True)

    def client_allowed(self):
        if self.ctx.allow_any:
            return True
        return self.client_address[0] in LOCAL_CLIENTS or self.client_address[0] == INGRESS_PROXY

    def dispatch(self, method, head=False):
        parts = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(parts.path)
        query = {k: v[-1] for k, v in urllib.parse.parse_qs(parts.query, keep_blank_values=True).items()}
        try:
            if not self.client_allowed():
                raise ApiError("access only through Home Assistant ingress", HTTPStatus.FORBIDDEN)
            if path.startswith("/api/"):
                for route_method, pattern, func in ROUTES:
                    match = pattern.match(path)
                    if match and route_method == method:
                        request = Request(self, path, query, match.groupdict())
                        result = func(self.ctx, request)
                        self.send_json(result)
                        return
                if any(pattern.match(path) for _, pattern, _ in ROUTES):
                    raise ApiError("method not allowed", HTTPStatus.METHOD_NOT_ALLOWED)
                raise ApiError("not found", HTTPStatus.NOT_FOUND)
            if method != "GET":
                raise ApiError("method not allowed", HTTPStatus.METHOD_NOT_ALLOWED)
            self.send_static(path, head)
        except ApiError as err:
            self.send_json({"error": str(err)}, err.status)
        except RepoError as err:
            self.send_json({"error": str(err)}, HTTPStatus.BAD_REQUEST)
        except (ValueError, TypeError, KeyError) as err:
            self.send_json({"error": f"invalid request: {err}"}, HTTPStatus.BAD_REQUEST)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as err:  # noqa: BLE001 - report instead of killing the connection silently
            log.error("%s %s failed: %s\n%s", method, path, err, traceback.format_exc())
            self.send_json({"error": f"internal error: {err}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def send_json(self, obj, status=HTTPStatus.OK):
        data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_static(self, path, head=False):
        www = self.ctx.www_dir
        if not www:
            raise ApiError("not found", HTTPStatus.NOT_FOUND)
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        try:
            rel = safe_relative(rel)
        except RepoError:
            raise ApiError("not found", HTTPStatus.NOT_FOUND)
        full = os.path.join(www, rel)
        root = os.path.realpath(www)
        if not os.path.realpath(full).startswith(root + os.sep) or not os.path.isfile(full):
            raise ApiError("not found", HTTPStatus.NOT_FOUND)
        stat = os.stat(full)
        since = self.headers.get("If-Modified-Since")
        if since:
            try:
                if int(parsedate_to_datetime(since).timestamp()) >= int(stat.st_mtime):
                    self.send_response(HTTPStatus.NOT_MODIFIED)
                    self.end_headers()
                    return
            except (TypeError, ValueError):
                pass
        content_type = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if full.endswith(".wasm"):
            content_type = "application/wasm"
        elif full.endswith((".js", ".mjs")):
            content_type = "text/javascript"
        if content_type.startswith("text/") or content_type in ("application/json", "text/javascript"):
            content_type += "; charset=utf-8"
        body = None
        ingress_path = self.headers.get("X-Ingress-Path")
        if rel == "index.html" and ingress_path:
            # Home Assistant serves the app under /api/hassio_ingress/<token>; a <base> makes the
            # relative URLs of the page resolve there even without a trailing slash.
            with open(full, "rb") as f:
                body = f.read().replace(b"<head>", b'<head>\n<base href="%s/">' % ingress_path.rstrip("/").encode(), 1)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body) if body is not None else stat.st_size))
        self.send_header("Last-Modified", formatdate(stat.st_mtime, usegmt=True))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if head:
            return
        if body is not None:
            self.wfile.write(body)
            return
        with open(full, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)


def make_server(ctx, bind="0.0.0.0", port=8099):
    handler = type("BoundHandler", (Handler,), {"ctx": ctx})
    server = ThreadingHTTPServer((bind, port), handler)
    server.daemon_threads = True
    return server
