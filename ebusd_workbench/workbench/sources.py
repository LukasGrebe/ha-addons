"""Where definitions come from: snapshots fetched over HTTPS, no git.

A source is a complete tree of definition files, exactly what ebusd would load with --configpath
pointing at it:

* ``release``: the CSV files ebusd itself loads (https://ebus.github.io, the language folder),
* ``next``: the same for the upcoming release (the ``next/`` folder of the CDN),
* ``pr/660``: the head of a pull request of john30/ebusd-configuration (TypeSpec sources, compiled in
  the browser),
* ``gh/owner/repo#branch``: a branch of another GitHub repository, TypeSpec or CSV.

GitHub serves every ref as a tarball (codeload), so nothing needs git, tokens or a clone with
history: a source is one download of about a megabyte, kept in the data folder as a JSON file.
"""

import hashlib
import io
import json
import logging
import os
import re
import tarfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from .paths import PathError, safe_relative

log = logging.getLogger("sources")

UPSTREAM_REPO = "john30/ebusd-configuration"
CDN_REPO = "eBUS/ebus.github.io"
CDN_BRANCH = "main"
LANGUAGES = ("en", "de")
DEFAULT_SOURCES = ("release", "next")
CODELOAD = "https://codeload.github.com/{repo}/tar.gz/{ref}"
API = "https://api.github.com/repos/{repo}"
USER_AGENT = "ebusd-workbench (+https://github.com/LukasGrebe/ha-addons)"
FETCH_TIMEOUT = 120
MAX_TARBALL = 60 * 1024 * 1024
MAX_FILES = 20000
MAX_FILE = 4 * 1024 * 1024
SUGGEST_MAX_AGE = 3600
CSV_SUFFIXES = (".csv", ".inc")
TSP_SUFFIXES = (".tsp", ".yaml", ".yml")
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$")
BRANCH_RE = re.compile(r"^[A-Za-z0-9_./-]{1,100}$")


class SourceError(Exception):
    pass


def parse_ref(spec):
    """What a source specification means: {id, kind, repo, ref, number?, branch?}.

    Accepted: ``release``, ``next``, a pull request as ``660``, ``#660``, ``pr/660`` or its GitHub
    URL, a repository as ``owner/repo``, ``owner/repo#branch``, ``https://github.com/owner/repo``
    (optionally ``.git``, ``#branch`` or ``/tree/branch``).
    """
    spec = str(spec or "").strip()
    if spec in ("release", "next"):
        return {"id": spec, "kind": "cdn", "repo": CDN_REPO, "ref": f"refs/heads/{CDN_BRANCH}"}
    m = re.fullmatch(r"(?:pr/|#)?([0-9]{1,6})", spec) or re.fullmatch(r"https?://github\.com/" + re.escape(UPSTREAM_REPO) + r"/pull/([0-9]{1,6})(?:/[A-Za-z0-9_.-]*)*(?:[#?].*)?", spec)
    if m:
        number = int(m.group(1))
        return {"id": f"pr/{number}", "kind": "pr", "repo": UPSTREAM_REPO, "ref": f"refs/pull/{number}/head", "number": number}
    m = re.fullmatch(r"(?:gh/)?([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?(?:#(.+))?", spec)
    if not m:
        m = re.fullmatch(r"https?://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?/?(?:/tree/([^#?]+))?(?:#(.+))?", spec)
        if m:
            m = (m.group(1), m.group(3) or m.group(2))
    else:
        m = (m.group(1), m.group(2))
    if m:
        repo, branch = m
        branch = (branch or "").strip().strip("/")
        if not REPO_RE.match(repo) or ".." in repo or (branch and (not BRANCH_RE.match(branch) or ".." in branch)):
            raise SourceError("a repository is owner/name, optionally #branch")
        if repo.lower() == CDN_REPO.lower() and not branch:
            return parse_ref("release")
        return {"id": f"gh/{repo}" + (f"#{branch}" if branch else ""), "kind": "repo", "repo": repo,
                "ref": f"refs/heads/{branch}" if branch else "HEAD", "branch": branch or None}
    raise SourceError("a source is 'release', 'next', a pull request number (660) or a GitHub repository (owner/name, optionally #branch)")


def folder_name(source_id):
    """The cache folder of a source: ``pr/660`` -> ``pr-660``."""
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", source_id).strip("-.")[:150]


def label_of(meta):
    kind = meta.get("kind")
    if kind == "cdn":
        return "ebusd's definitions" if meta["id"] == "release" else "upcoming release"
    if kind == "pr":
        return f"PR {meta['number']}"
    return meta["id"][3:]


def default_fetch(url, timeout=FETCH_TIMEOUT):
    """Download a URL (bytes); errors are raised as SourceError with a readable message."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json, */*"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = b""
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    return data
                data += chunk
                if len(data) > MAX_TARBALL:
                    raise SourceError(f"{url}: larger than {MAX_TARBALL // 1024 // 1024} MB")
    except urllib.error.HTTPError as err:
        if err.code == 404:
            raise SourceError(f"not found on GitHub: {url}")
        if err.code in (403, 429):
            raise SourceError("GitHub refused the request (rate limit?), try again later")
        raise SourceError(f"{url}: HTTP {err.code}")
    except (urllib.error.URLError, OSError, ValueError) as err:
        raise SourceError(f"{url}: {getattr(err, 'reason', err)}")


def _resolve(path, target):
    """The path a symbolic link at ``path`` points to (relative links only), or None if it leaves the tree."""
    if target.startswith("/"):
        return None
    parts = path.split("/")[:-1]
    for part in target.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if not parts:
                return None
            parts.pop()
        else:
            parts.append(part)
    return "/".join(parts)


def extract(data, select):
    """The files of a tarball (first path component stripped) that ``select(path)`` accepts: {path: text}.

    ebusd-configuration shares definitions between devices with symbolic links; a link gets the
    content of its target (also when the target is a link itself, or a folder of files).
    """
    files = {}
    links = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
            for member in tar:
                parts = member.name.split("/")
                if len(parts) < 2 or ".." in parts:
                    continue
                path = "/".join(parts[1:])
                if member.issym():
                    target = _resolve(path, member.linkname)
                    if target:
                        links[path] = target
                    continue
                if not member.isfile() or member.size > MAX_FILE or not select(path):
                    continue
                handle = tar.extractfile(member)
                if handle is None:
                    continue
                files[path] = handle.read().decode("utf-8", errors="replace")
                if len(files) > MAX_FILES:
                    raise SourceError("too many files in the archive")
    except tarfile.TarError as err:
        raise SourceError(f"not a tar.gz archive: {err}")
    # links to files, and links to folders (every file below the target appears below the link)
    for _ in range(8):   # chains of links
        added = 0
        for path, target in links.items():
            if path in files:
                continue
            if target in files:
                if select(path):
                    files[path] = files[target]
                    added += 1
                continue
            prefix = target + "/"
            for other in [f for f in files if f.startswith(prefix)]:
                linked = path + other[len(target):]
                if linked not in files and select(linked):
                    files[linked] = files[other]
                    added += 1
        if not added:
            break
    return files


def pick_tree(all_files, language):
    """Which part of a repository tree is the definitions: {kind: 'csv'|'tsp', root, files}.

    CSV trees: ``<language>/`` (the CDN), else CSV files at the root. TypeSpec trees: ``src/``.
    """
    def below(root):
        prefix = f"{root}/" if root else ""
        return {p[len(prefix):]: t for p, t in all_files.items() if p.startswith(prefix)}

    tsp = {p: t for p, t in all_files.items() if p.endswith(TSP_SUFFIXES)}
    if any(p == "src/main.tsp" or (p.startswith("src/") and p.endswith(".tsp")) for p in tsp):
        return {"kind": "tsp", "root": "src", "files": {p: t for p, t in below("src").items() if p.endswith(TSP_SUFFIXES)}}
    for root in (language, "en", ""):
        files = {p: t for p, t in below(root).items() if p.endswith(CSV_SUFFIXES) and (root or "/" not in p or p.split("/")[0] not in LANGUAGES + ("next",))}
        if any(p.endswith(".csv") for p in files):
            return {"kind": "csv", "root": root, "files": files}
    if tsp:
        return {"kind": "tsp", "root": "", "files": tsp}
    raise SourceError("no definition files found (neither src/*.tsp nor *.csv)")


class Sources:
    """The configured sources with their cached trees; fetching runs in background threads."""

    def __init__(self, data_dir, settings, fetch=None, language="en"):
        self.dir = os.path.join(os.path.abspath(data_dir), "sources")
        self.settings = settings
        self.fetch = fetch or default_fetch
        self.language = language if language in LANGUAGES else "en"
        self.busy = {}      # id -> {"what", "since"}
        self.errors = {}    # id -> message of the last failed fetch
        self._lock = threading.Lock()
        self._suggest = None

    # -- configuration ------------------------------------------------------------------------

    def configured(self):
        return [dict(s) for s in self.settings.as_dict().get("sources", [])]

    def _set_configured(self, items):
        self.settings.update({"sources": items})

    def ensure_defaults(self, background=True):
        """The first start: the release and the upcoming release, fetched in the background."""
        if self.configured():
            return
        for spec in DEFAULT_SOURCES:
            self.add(spec, background=background)

    # -- cache --------------------------------------------------------------------------------

    def folder(self, source_id):
        return os.path.join(self.dir, folder_name(source_id))

    def meta(self, source_id):
        try:
            with open(os.path.join(self.folder(source_id), "meta.json"), "r", encoding="utf-8") as f:
                meta = json.load(f)
            return meta if isinstance(meta, dict) and meta.get("id") == source_id else None
        except (OSError, ValueError):
            return None

    def files(self, source_id):
        """{kind, root, files} of a fetched source."""
        meta = self.meta(source_id)
        if not meta:
            raise SourceError(f"{source_id} is not fetched")
        try:
            with open(os.path.join(self.folder(source_id), "files.json"), "r", encoding="utf-8") as f:
                files = json.load(f)
        except (OSError, ValueError) as err:
            raise SourceError(f"{source_id}: cached files unreadable ({err})")
        return {"id": source_id, "kind": meta["tree"], "root": meta.get("root", ""), "files": files}

    def _save(self, meta, files):
        folder = self.folder(meta["id"])
        os.makedirs(folder, exist_ok=True)
        for name, data in (("files.json", files), ("meta.json", meta)):
            tmp = os.path.join(folder, name + ".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            os.replace(tmp, os.path.join(folder, name))

    # -- fetching -----------------------------------------------------------------------------

    def fetch_now(self, spec):
        """Download a source and cache it; returns its meta."""
        ref = parse_ref(spec)
        source_id = ref["id"]
        with self._lock:
            if source_id in self.busy:
                raise SourceError(f"{source_id}: {self.busy[source_id]['what']}")
            self.busy[source_id] = {"what": f"fetching {label_of(ref)}", "since": time.time()}
            self.errors.pop(source_id, None)
        try:
            meta = self._download(ref)
            return meta
        except SourceError as err:
            self.errors[source_id] = str(err)
            raise
        finally:
            with self._lock:
                self.busy.pop(source_id, None)

    def prefetch(self, numbers, max_workers=4):
        """Fetch pull requests into the cache without configuring them (for a search over all open ones).

        The title and head come from the cached list of open pull requests, so no API call is spent
        per pull request. Returns the summaries; fetching happens in a few threads, missing ones are
        reported as fetching and can be asked for again.
        """
        pulls = {}
        try:
            pulls = {p["number"]: p for p in self.suggest().get("pulls", [])}
        except SourceError:
            pass
        todo = []
        for number in numbers:
            ref = parse_ref(str(number))
            if ref["kind"] != "pr":
                raise SourceError(f"{number} is not a pull request")
            meta = self.meta(ref["id"])
            head = (pulls.get(ref["number"]) or {}).get("head")
            if meta and (not head or meta.get("head") == head):
                continue
            todo.append((ref, pulls.get(ref["number"])))
        if todo:
            lock = threading.Lock()
            queue = list(todo)

            def work():
                while True:
                    with lock:
                        if not queue:
                            return
                        ref, pull = queue.pop(0)
                    with self._lock:
                        if ref["id"] in self.busy:
                            continue
                        self.busy[ref["id"]] = {"what": f"fetching {label_of(ref)}", "since": time.time()}
                        self.errors.pop(ref["id"], None)
                    try:
                        self._download(ref, describe=False, pull=pull)
                    except SourceError as err:
                        self.errors[ref["id"]] = str(err)
                        log.warning("fetching %s failed: %s", ref["id"], err)
                    finally:
                        with self._lock:
                            self.busy.pop(ref["id"], None)

            for _ in range(max(1, min(max_workers, len(todo)))):
                threading.Thread(target=work, name="prefetch", daemon=True).start()
        return [self.summary(parse_ref(str(n))["id"]) for n in numbers]

    def _download(self, ref, describe=True, pull=None):
        data = self.fetch(CODELOAD.format(repo=ref["repo"], ref=urllib.parse.quote(ref["ref"], safe="/")))
        wanted = TSP_SUFFIXES + CSV_SUFFIXES
        if ref["kind"] == "cdn":
            root = self.language if ref["id"] == "release" else f"next/{self.language}"
            raw = extract(data, lambda p: p.startswith(root + "/") and p.endswith(CSV_SUFFIXES))
            tree = {"kind": "csv", "root": root, "files": {p[len(root) + 1:]: t for p, t in raw.items()}}
        else:
            raw = extract(data, lambda p: p.endswith(wanted) and not p.startswith(("archived/", "node_modules/")))
            tree = pick_tree(raw, self.language)
        if not tree["files"]:
            raise SourceError(f"{ref['id']}: no definition files in the archive")
        digest = hashlib.sha1("\n".join(f"{path}\t{len(text)}" for path, text in sorted(tree["files"].items())).encode("utf-8")).hexdigest()[:12]
        meta = {"id": ref["id"], "kind": ref["kind"], "repo": ref["repo"], "ref": ref["ref"], "tree": tree["kind"], "root": tree["root"],
                "files": len(tree["files"]), "digest": digest, "fetched_at": time.time(), "label": label_of(ref), "language": self.language}
        if "number" in ref:
            meta["number"] = ref["number"]
        if ref.get("branch"):
            meta["branch"] = ref["branch"]
        if pull:
            meta.update(title=pull.get("title"), head=pull.get("head"), author=pull.get("author"), updated_at=pull.get("updated_at"), url=pull.get("url"))
        if describe:
            meta.update(self._describe(ref))
        self._save(meta, tree["files"])
        return meta

    def _api(self, url):
        try:
            return json.loads(self.fetch(url, timeout=30).decode("utf-8"))
        except (SourceError, ValueError) as err:
            log.warning("%s: %s", url, err)
            return None

    def _describe(self, ref):
        """Head commit and title from the GitHub API (best effort: the tree is fine without)."""
        api = API.format(repo=ref["repo"])
        out = {}
        if ref["kind"] == "pr":
            pr = self._api(f"{api}/pulls/{ref['number']}")
            if pr:
                out.update(title=pr.get("title"), head=(pr.get("head") or {}).get("sha"), author=(pr.get("user") or {}).get("login"),
                           updated_at=pr.get("updated_at"), state=pr.get("state"), merged=bool(pr.get("merged_at")),
                           changed_files=pr.get("changed_files"), url=pr.get("html_url"))
        else:
            branch = ref.get("branch") or (CDN_BRANCH if ref["kind"] == "cdn" else "HEAD")
            commit = self._api(f"{api}/commits/{urllib.parse.quote(branch, safe='')}")
            if commit:
                c = commit.get("commit") or {}
                out.update(head=commit.get("sha"), title=(c.get("message") or "").split("\n")[0][:120],
                           updated_at=(c.get("committer") or c.get("author") or {}).get("date"), url=commit.get("html_url"))
        return out

    def add(self, spec, background=True):
        """Configure a source (enabled) and fetch it; returns its summary."""
        ref = parse_ref(spec)
        items = self.configured()
        if not any(s.get("id") == ref["id"] for s in items):
            items.append({"id": ref["id"], "enabled": True})
            self._set_configured(items)
        if background:
            self._start(ref["id"])
        else:
            self.fetch_now(ref["id"])
        return self.summary(ref["id"])

    def refresh(self, source_id, background=True):
        source_id = parse_ref(source_id)["id"]
        if not any(s.get("id") == source_id for s in self.configured()):
            raise SourceError(f"{source_id} is not a configured source")
        if background:
            self._start(source_id)
        else:
            self.fetch_now(source_id)
        return self.summary(source_id)

    def _start(self, source_id):
        with self._lock:
            if source_id in self.busy:
                return
        thread = threading.Thread(target=self._work, args=(source_id,), name=f"fetch {source_id}", daemon=True)
        thread.start()
        return thread

    def _work(self, source_id):
        try:
            self.fetch_now(source_id)
            log.info("fetched %s", source_id)
        except SourceError as err:
            log.error("fetching %s failed: %s", source_id, err)

    def set_enabled(self, source_id, enabled):
        items = self.configured()
        for item in items:
            if item.get("id") == source_id:
                item["enabled"] = bool(enabled)
                break
        else:
            raise SourceError(f"{source_id} is not a configured source")
        self._set_configured(items)
        return self.summary(source_id)

    def remove(self, source_id):
        source_id = parse_ref(source_id)["id"]
        self._set_configured([s for s in self.configured() if s.get("id") != source_id])
        folder = self.folder(source_id)
        for name in ("files.json", "meta.json", "files.json.tmp", "meta.json.tmp"):
            try:
                os.remove(os.path.join(folder, name))
            except OSError:
                pass
        try:
            os.rmdir(folder)
        except OSError:
            pass

    def changes(self, source_id):
        """The files a pull request changes (from the GitHub API, once; kept in its meta).

        For a pull request whose whole tree no longer compiles with today's TypeSpec library (an old
        base), the browser compiles only these files and what they import.
        """
        ref = parse_ref(source_id)
        if ref["kind"] != "pr":
            raise SourceError("only a pull request has a list of changed files")
        meta = self.meta(ref["id"])
        if not meta:
            raise SourceError(f"{ref['id']} is not fetched")
        if "changed" in meta:
            return {"id": ref["id"], "files": meta["changed"], "cached": True}
        files = []
        page = 1
        while page <= 5:
            data = self._api(f"{API.format(repo=ref['repo'])}/pulls/{ref['number']}/files?per_page=100&page={page}")
            if not isinstance(data, list):
                raise SourceError("the list of changed files is not available (GitHub API, rate limit?)")
            files += [{"path": f.get("filename"), "status": f.get("status")} for f in data if isinstance(f, dict) and f.get("filename")]
            if len(data) < 100:
                break
            page += 1
        meta["changed"] = files
        try:
            with open(os.path.join(self.folder(ref["id"]), "files.json"), "r", encoding="utf-8") as f:
                tree = json.load(f)
            self._save(meta, tree)
        except (OSError, ValueError) as err:
            log.warning("unable to keep the changed files of %s: %s", ref["id"], err)
        return {"id": ref["id"], "files": files, "cached": False}

    # -- state for the UI ---------------------------------------------------------------------

    def summary(self, source_id, configured=None):
        meta = self.meta(source_id) or {}
        item = next((s for s in (configured if configured is not None else self.configured()) if s.get("id") == source_id), {})
        ref = parse_ref(source_id)
        busy = self.busy.get(source_id)
        state = "fetching" if busy else "error" if source_id in self.errors and not meta else "ready" if meta else "missing"
        out = {"id": source_id, "kind": ref["kind"], "label": label_of(ref), "enabled": item.get("enabled", True) is not False, "state": state,
               "busy": busy, "error": self.errors.get(source_id)}
        for key in ("tree", "root", "files", "digest", "fetched_at", "head", "title", "author", "updated_at", "merged", "changed_files", "url", "number", "branch", "language"):
            if key in meta:
                out[key] = meta[key]
        if "state" in meta:
            out["pr_state"] = meta["state"]
        return out

    def list(self):
        configured = self.configured()
        return [self.summary(s["id"], configured) for s in configured if s.get("id")]

    def status(self):
        return {"dir": self.dir, "language": self.language, "sources": self.list(), "busy": dict(self.busy)}

    # -- open pull requests of the upstream repository, to pick from ---------------------------

    def suggest(self, max_age=SUGGEST_MAX_AGE):
        """The open pull requests of john30/ebusd-configuration (cached for an hour)."""
        path = os.path.join(self.dir, "suggest.json")
        cached = self._suggest
        if cached is None:
            try:
                with open(path, "r", encoding="utf-8") as f:
                    cached = json.load(f)
            except (OSError, ValueError):
                cached = None
        if cached and time.time() - cached.get("fetched_at", 0) < max_age:
            self._suggest = cached
            return cached
        data = self._api(f"{API.format(repo=UPSTREAM_REPO)}/pulls?state=open&per_page=100&sort=updated&direction=desc")
        if not isinstance(data, list):
            if cached:
                return dict(cached, stale=True)
            raise SourceError("the list of pull requests is not available (GitHub API)")
        pulls = [{"number": p.get("number"), "title": p.get("title") or "", "author": (p.get("user") or {}).get("login"),
                  "updated_at": p.get("updated_at"), "head": (p.get("head") or {}).get("sha"), "url": p.get("html_url"), "draft": bool(p.get("draft"))}
                 for p in data if isinstance(p, dict) and p.get("number")]
        result = {"repo": UPSTREAM_REPO, "fetched_at": time.time(), "pulls": pulls}
        os.makedirs(self.dir, exist_ok=True)
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(result, f)
        except OSError as err:
            log.warning("unable to cache the pull requests: %s", err)
        self._suggest = result
        return result


__all__ = ["Sources", "SourceError", "PathError", "parse_ref", "pick_tree", "extract", "safe_relative", "DEFAULT_SOURCES"]
