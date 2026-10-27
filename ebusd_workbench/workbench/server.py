"""HTTP server: JSON API for the browser UI and the static files of the UI itself.

Reached through Home Assistant ingress only (no published port), so requests are accepted from
the ingress proxy and localhost unless WORKBENCH_ALLOW_ANY is set for development.
"""

import json
import logging
import mimetypes
import os
import re
import select
import socket
import sqlite3
import threading
import time
import traceback
import urllib.parse
from email.utils import formatdate, parsedate_to_datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import __version__, deploy
from .db import NO_VALUE
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


HEAVY_PATHS = ("/api/telegrams", "/api/events", "/api/export/rawlog")   # queries that scan the recording
HEAVY_LIMIT = 3                  # at most this many at once; the device may be a Raspberry Pi


class Cancelled(Exception):
    """The client went away while its request was running."""


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
        self.heavy = threading.BoundedSemaphore(HEAVY_LIMIT)


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
    return ctx.db.runs(from_ms, to_ms, id_bytes=id_bytes, id_overrides=overrides, max_rows=max_rows,
                       id_rules=settings.get("id_rules") or {})


@route("GET", "/api/telegrams")
def api_telegrams(ctx, req):
    from_ms, to_ms = window(req.query)
    q = req.query
    def addr(name):
        return NO_VALUE if q.get(name) == "--" else int_or_none(q.get(name), 16)

    return {"telegrams": ctx.db.telegrams(
        from_ms, to_ms, qq=addr("qq"), zz=addr("zz"), pb=addr("pb"), sb=addr("sb"), id_prefix=q.get("id") or None,
        limit=int(q.get("limit", 500)), order=q.get("order", "DESC"))}


@route("GET", "/api/telegrams/series")
def api_series(ctx, req):
    """Timestamps and telegrams of one row (source, destination, command, message ID) for a value history chart."""
    q = req.query
    from_ms, to_ms = window(q, 31 * 86400_000)

    def addr(name):
        return NO_VALUE if q.get(name) == "--" else int_or_none(q.get(name), 16)

    result = ctx.db.series(from_ms, to_ms, qq=addr("qq"), zz=addr("zz"), pb=addr("pb"), sb=addr("sb"), id_prefix=q.get("id") or None,
                           max_points=int(q.get("max", 20000)))
    result.update({"from_ms": from_ms, "to_ms": to_ms})
    return result


@route("GET", "/api/telegrams/distinct")
def api_distinct(ctx, req):
    from_ms, to_ms = window(req.query)
    return {"telegrams": ctx.db.distinct(from_ms, to_ms, limit=int(req.query.get("limit", 2000)),
                                          only_ok=req.query.get("all") != "1")}


@route("GET", "/api/events")
def api_events(ctx, req):
    from_ms, to_ms = window(req.query)
    return {"markers": ctx.db.markers(from_ms, to_ms), "states": ctx.db.states(from_ms, to_ms),
            "entities": ctx.db.state_entities()}


@route("POST", "/api/events")
def api_events_post(ctx, req):
    """Note an event (what the terminal's `log` command does): message (optional), ms (when, default now),
    uncertainty_ms (symmetric) or ms_min and ms_max (the range it may have happened in)."""
    body = req.json()
    message = str(body.get("message") or body.get("note") or "").strip()[:500]
    ts_ms = body.get("ms")
    kwargs = {}
    if body.get("ms_min") is not None or body.get("ms_max") is not None:
        if ts_ms is None:
            raise ApiError("ms (the time) is required with ms_min / ms_max")
        kwargs["ts_min_ns"] = int(body.get("ms_min", ts_ms)) * 1_000_000
        kwargs["ts_max_ns"] = int(body.get("ms_max", ts_ms)) * 1_000_000
    else:
        kwargs["uncertainty_ns"] = max(0, min(7 * 86400_000, int(body.get("uncertainty_ms", 500)))) * 1_000_000
    if ts_ms is not None and not (0 < int(ts_ms) < 4102444800000):
        raise ApiError("invalid time")
    event_id = ctx.db.add_marker(message, ts_ns=int(ts_ms) * 1_000_000 if ts_ms is not None else None, **kwargs)
    return {"id": event_id}


@route("GET", "/api/notes")
def api_notes(ctx, req):
    return {"notes": ctx.db.notes(int(req.query.get("limit", 50)))}


@route("DELETE", "/api/events/(?P<id>[0-9]+)")
def api_events_delete(ctx, req):
    if not ctx.db.delete_marker(int(req.params["id"])):
        raise ApiError("no such event", HTTPStatus.NOT_FOUND)
    return {"ok": True}


@route("GET", "/api/export/rawlog")
def api_export_rawlog(ctx, req):
    """The telegrams of a window as ebusd message-mode raw log (the input of ebus-evidence)."""
    from_ms, to_ms = window(req.query, 86400_000)
    if to_ms - from_ms > 31 * 86400_000:
        raise ApiError("at most 31 days at once")
    own = int(req.query.get("own") or ctx.settings.data.get("own_address", "31"), 16)
    name = "ebusd-%s-%s.raw" % (time.strftime("%Y%m%d-%H%M", time.localtime(from_ms / 1000)),
                                time.strftime("%Y%m%d-%H%M", time.localtime(to_ms / 1000)))
    req.handler.send_stream(ctx.db.rawlog(from_ms, to_ms, own_address=own, include_broken=req.query.get("all") == "1"),
                            "text/plain; charset=utf-8", name)
    return None


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
    if body.get("background"):
        ctx.repo.clone_background(body.get("url", ""), body.get("branch") or None)
    else:
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
    layers = [l for l in (req.query.get("layers") or "").split(",") if l]
    if not layers:
        return {"files": ctx.repo.sources(req.query.get("dir", "")), "origins": {}, "conflicts": [], "layers": []}
    return ctx.repo.sources_with_layers(req.query.get("dir", ""), layers)


@route("GET", "/api/repo/layers")
def api_repo_layers(ctx, req):
    settings = ctx.settings.as_dict()
    layers = [ctx.repo.layer_info(l["ref"], req.query.get("dir", "")) for l in settings.get("layers", [])] if ctx.repo.exists() else []
    return {"upstream": settings.get("upstream_url"), "layers": layers}


@route("GET", "/api/repo/layers/files")
def api_repo_layer_files(ctx, req):
    """The sources of one layer (to tell which definitions it adds)."""
    return {"files": ctx.repo.layer_files(req.query.get("ref", ""), req.query.get("dir", ""))}


@route("POST", "/api/repo/layers")
def api_repo_layers_post(ctx, req):
    body = req.json()
    settings = ctx.settings.as_dict()
    layer = ctx.repo.fetch_layer(body.get("ref", ""), settings.get("upstream_url") or None)
    refs = [l["ref"] for l in settings.get("layers", [])]
    if layer["ref"] not in refs:
        ctx.settings.update({"layers": settings.get("layers", []) + [{"ref": layer["ref"]}]})
    return layer


@route("DELETE", "/api/repo/layers/(?P<ref>.+)")
def api_repo_layers_delete(ctx, req):
    ref = ctx.repo.layer_ref(req.params["ref"])
    ctx.repo.remove_layer(ref)
    settings = ctx.settings.as_dict()
    ctx.settings.update({"layers": [l for l in settings.get("layers", []) if l["ref"] != ref]})
    return {"ok": True}


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

    def client_gone(self):
        """Whether the browser closed the connection (aborted the fetch, scrolled on, closed the tab)."""
        try:
            sock = self.handler.connection
            readable, _, _ = select.select([sock], [], [], 0)
            return bool(readable) and sock.recv(1, socket.MSG_PEEK) == b""
        except (OSError, ValueError):
            return True

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
                        result = self.run_route(func, request)
                        if result is not None:
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
        except Cancelled:
            self.close_connection = True   # nobody is waiting for the answer any more
        except Exception as err:  # noqa: BLE001 - report instead of killing the connection silently
            log.error("%s %s failed: %s\n%s", method, path, err, traceback.format_exc())
            self.send_json({"error": f"internal error: {err}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def run_route(self, func, request):
        """Run a route; queries over the recording are limited in number and stop when the client is gone."""
        db = self.ctx.db
        heavy = request.path.startswith(HEAVY_PATHS)
        if heavy:
            while not self.ctx.heavy.acquire(timeout=0.5):
                if request.client_gone():
                    raise Cancelled()
        db.local.cancel = request.client_gone
        try:
            return func(self.ctx, request)
        except sqlite3.OperationalError as err:
            if "interrupted" in str(err) or request.client_gone():
                raise Cancelled()
            raise
        finally:
            db.local.cancel = None
            if heavy:
                self.ctx.heavy.release()

    def send_json(self, obj, status=HTTPStatus.OK):
        data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_stream(self, lines, content_type, filename):
        """Send an iterable of text lines as a download with chunked transfer encoding."""
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        buffer = []
        size = 0

        def flush():
            nonlocal buffer, size
            if size:
                data = "".join(buffer).encode()
                self.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")
                buffer, size = [], 0
        for line in lines:
            buffer.append(line)
            size += len(line)
            if size >= 65536:
                flush()
        flush()
        self.wfile.write(b"0\r\n\r\n")

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
