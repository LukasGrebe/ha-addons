"""Unit tests of the definition sources of the Workbench: GitHub tarballs instead of git."""

import io
import json
import os
import sys
import tarfile
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ebusd_workbench"))
from workbench.settings import Settings  # noqa: E402
from workbench.sources import SourceError, Sources, extract, parse_ref, pick_tree  # noqa: E402


def tarball(root, files, links=None):
    """A tar.gz like codeload serves it: every path below a root folder named after the ref; links as symbolic links."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for path, text in files.items():
            data = text.encode("utf-8")
            info = tarfile.TarInfo(f"{root}/{path}")
            info.size = len(data)
            info.mtime = int(time.time())
            tar.addfile(info, io.BytesIO(data))
        for path, target in (links or {}).items():
            info = tarfile.TarInfo(f"{root}/{path}")
            info.type = tarfile.SYMTYPE
            info.linkname = target
            tar.addfile(info)
    return buffer.getvalue()


CDN = tarball("ebus.github.io-main", {
    "README.md": "x",
    "en/vaillant/08.hmu.csv": "type,circuit,name\nr,hmu,Status,\n",
    "en/vaillant/08.hmu.HW5103.csv": "type,circuit,name\nr,hmu,Status5103,\n",
    "en/vaillant/b5_inc.inc": "x,\n",
    "en/_templates.csv": "name,type\n",
    "de/vaillant/08.hmu.csv": "typ,schaltung,name\n",
    "next/en/vaillant/08.hmu.csv": "type,circuit,name\nr,hmu,StatusNext,\n",
    "next/en/vaillant/08.new.csv": "type,circuit,name\nr,new,Thing,\n",
})
PR = tarball("ebusd-configuration-refs-pull-660-head", {
    "README.md": "x",
    "src/main.tsp": 'import "./vaillant/08.hmu.tsp";\nimport "./vaillant/15.720.tsp";\n',
    "src/vaillant/08.hmu.tsp": "model Hmu { a: UCH }\n",
    "src/vaillant/15.700.tsp": "model V700 {}\n",
    "src/de.yaml": "a: b\n",
    "src/shared/x_inc.tsp": "model Inc {}\n",
    "archived/en/vaillant/08.hmu.csv": "old\n",
    "package.json": "{}",
}, links={"src/vaillant/15.720.tsp": "15.700.tsp", "src/vaillant/15.730.tsp": "./15.720.tsp", "src/vaillant/shared": "../shared", "src/vaillant/escape.tsp": "../../../etc/passwd"})
FORK_CSV = tarball("fork-main", {"vaillant/08.hmu.csv": "type,circuit,name\nr,hmu,Fork,\n", "notes.txt": "x"})


class Fetcher:
    """A fake network: URL -> bytes, counting the downloads."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, url, timeout=0):
        self.calls.append(url)
        for prefix, data in self.routes.items():
            if url.startswith(prefix):
                if isinstance(data, Exception):
                    raise data
                return data if isinstance(data, bytes) else json.dumps(data).encode()
        raise SourceError(f"not found on GitHub: {url}")


ROUTES = {
    "https://codeload.github.com/eBUS/ebus.github.io/tar.gz/refs/heads/main": CDN,
    "https://codeload.github.com/john30/ebusd-configuration/tar.gz/refs/pull/660/head": PR,
    "https://codeload.github.com/someone/ebusd-configuration/tar.gz/refs/heads/my-branch": PR,
    "https://codeload.github.com/other/csv-fork/tar.gz/HEAD": FORK_CSV,
    "https://api.github.com/repos/eBUS/ebus.github.io/commits/main": {"sha": "abc123", "html_url": "u", "commit": {"message": "update\n\nmore", "committer": {"date": "2026-06-22T17:53:00Z"}}},
    "https://api.github.com/repos/john30/ebusd-configuration/pulls/660": {"title": "vaillant: consolidate HW5103", "head": {"sha": "b3fd23e"}, "user": {"login": "claus"},
                                                                          "updated_at": "2026-10-02T07:03:34Z", "state": "open", "merged_at": None, "changed_files": 7, "html_url": "pr-url"},
    "https://api.github.com/repos/john30/ebusd-configuration/pulls?state=open": [
        {"number": 702, "title": "vaillant/hmu: add brine test values", "user": {"login": "a"}, "updated_at": "2026-10-23", "head": {"sha": "c93fb06"}, "html_url": "x", "draft": False},
        {"number": 701, "title": "Add Protherm Ray", "user": {"login": "b"}, "updated_at": "2026-10-18", "head": {"sha": "2bad517"}, "html_url": "y", "draft": True},
    ],
}


class Refs(unittest.TestCase):
    def test_specifications(self):
        self.assertEqual(parse_ref("release")["id"], "release")
        self.assertEqual(parse_ref("next"), {"id": "next", "kind": "cdn", "repo": "eBUS/ebus.github.io", "ref": "refs/heads/main"})
        for spec in ("660", "#660", "pr/660", "https://github.com/john30/ebusd-configuration/pull/660", "https://github.com/john30/ebusd-configuration/pull/660/files"):
            self.assertEqual(parse_ref(spec), {"id": "pr/660", "kind": "pr", "repo": "john30/ebusd-configuration", "ref": "refs/pull/660/head", "number": 660}, spec)
        for spec in ("someone/ebusd-configuration#my-branch", "https://github.com/someone/ebusd-configuration.git#my-branch",
                     "https://github.com/someone/ebusd-configuration/tree/my-branch", "gh/someone/ebusd-configuration#my-branch"):
            self.assertEqual(parse_ref(spec), {"id": "gh/someone/ebusd-configuration#my-branch", "kind": "repo", "repo": "someone/ebusd-configuration",
                                               "ref": "refs/heads/my-branch", "branch": "my-branch"}, spec)
        self.assertEqual(parse_ref("other/csv-fork")["ref"], "HEAD")
        self.assertEqual(parse_ref("https://github.com/eBUS/ebus.github.io")["id"], "release")
        for bad in ("", "x", "a/../b", "owner/repo#a..b", "ssh://git@host/x.git", "https://example.com/x/y", "pr/", "1234567"):
            with self.assertRaises(SourceError, msg=bad):
                parse_ref(bad)


class Trees(unittest.TestCase):
    def test_extract_strips_the_root_folder(self):
        files = extract(CDN, lambda p: p.endswith(".csv"))
        self.assertIn("en/vaillant/08.hmu.csv", files)
        self.assertNotIn("README.md", files)

    def test_symbolic_links_get_the_content_of_their_target(self):
        files = extract(PR, lambda p: p.endswith(".tsp"))
        self.assertEqual(files["src/vaillant/15.720.tsp"], "model V700 {}\n")
        self.assertEqual(files["src/vaillant/15.730.tsp"], "model V700 {}\n", "a chain of links")
        self.assertEqual(files["src/vaillant/shared/x_inc.tsp"], "model Inc {}\n", "a link to a folder")
        self.assertNotIn("src/vaillant/escape.tsp", files, "a link out of the tree is ignored")

    def test_pick_tree(self):
        tsp = pick_tree(extract(PR, lambda p: True), "en")
        self.assertEqual(tsp["kind"], "tsp")
        self.assertEqual(sorted(tsp["files"]), ["de.yaml", "main.tsp", "shared/x_inc.tsp", "vaillant/08.hmu.tsp", "vaillant/15.700.tsp", "vaillant/15.720.tsp", "vaillant/15.730.tsp", "vaillant/shared/x_inc.tsp"])
        csv = pick_tree(extract(FORK_CSV, lambda p: True), "en")
        self.assertEqual((csv["kind"], csv["root"], list(csv["files"])), ("csv", "", ["vaillant/08.hmu.csv"]))
        cdn = pick_tree(extract(CDN, lambda p: True), "de")
        self.assertEqual((cdn["kind"], cdn["root"], list(cdn["files"])), ("csv", "de", ["vaillant/08.hmu.csv"]))
        with self.assertRaises(SourceError):
            pick_tree({"notes.txt": "x"}, "en")


class Fetching(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.settings = Settings(os.path.join(self.tmp.name, "settings.json"))
        self.fetch = Fetcher(ROUTES)
        self.sources = Sources(self.tmp.name, self.settings, fetch=self.fetch)

    def tearDown(self):
        self.tmp.cleanup()

    def test_release_and_next_from_one_tarball(self):
        meta = self.sources.add("release", background=False)
        self.assertEqual((meta["state"], meta["tree"], meta["files"], meta["head"], meta["label"]), ("ready", "csv", 4, "abc123", "ebusd's definitions"))
        files = self.sources.files("release")
        self.assertEqual(sorted(files["files"]), ["_templates.csv", "vaillant/08.hmu.HW5103.csv", "vaillant/08.hmu.csv", "vaillant/b5_inc.inc"])
        self.assertEqual(files["kind"], "csv")
        nxt = self.sources.add("next", background=False)
        self.assertEqual(sorted(self.sources.files("next")["files"]), ["vaillant/08.hmu.csv", "vaillant/08.new.csv"])
        self.assertEqual(nxt["label"], "upcoming release")
        self.assertEqual([s["id"] for s in self.settings.as_dict()["sources"]], ["release", "next"])
        # the cache survives a restart and the settings know the sources
        again = Sources(self.tmp.name, self.settings, fetch=Fetcher({}))
        self.assertEqual([s["state"] for s in again.list()], ["ready", "ready"])
        self.assertEqual(again.files("release")["files"]["vaillant/08.hmu.csv"], "type,circuit,name\nr,hmu,Status,\n")

    def test_language(self):
        sources = Sources(self.tmp.name, self.settings, fetch=self.fetch, language="de")
        sources.add("release", background=False)
        self.assertEqual(list(sources.files("release")["files"]), ["vaillant/08.hmu.csv"])
        self.assertEqual(sources.files("release")["files"]["vaillant/08.hmu.csv"], "typ,schaltung,name\n")

    def test_pull_request_is_typespec_with_its_title(self):
        meta = self.sources.add("660", background=False)
        self.assertEqual((meta["id"], meta["tree"], meta["title"], meta["head"], meta["author"], meta["changed_files"]), ("pr/660", "tsp", "vaillant: consolidate HW5103", "b3fd23e", "claus", 7))
        files = self.sources.files("pr/660")
        self.assertEqual(files["kind"], "tsp")
        self.assertEqual(sorted(files["files"]), ["de.yaml", "main.tsp", "shared/x_inc.tsp", "vaillant/08.hmu.tsp", "vaillant/15.700.tsp", "vaillant/15.720.tsp", "vaillant/15.730.tsp", "vaillant/shared/x_inc.tsp"])
        self.assertNotIn("archived/en/vaillant/08.hmu.csv", files["files"])

    def test_other_repositories(self):
        self.assertEqual(self.sources.add("someone/ebusd-configuration#my-branch", background=False)["tree"], "tsp")
        meta = self.sources.add("other/csv-fork", background=False)
        self.assertEqual((meta["tree"], meta["files"]), ("csv", 1))
        self.assertEqual(self.sources.files("gh/other/csv-fork")["files"], {"vaillant/08.hmu.csv": "type,circuit,name\nr,hmu,Fork,\n"})

    def test_errors_are_reported_not_raised_in_the_background(self):
        with self.assertRaises(SourceError):
            self.sources.add("999", background=False)
        summary = self.sources.summary("pr/999")
        self.assertEqual(summary["state"], "error")
        self.assertIn("not found", summary["error"])
        self.assertEqual([s["id"] for s in self.sources.list()], ["pr/999"])   # configured, so that it can be retried or removed
        self.sources.remove("pr/999")
        self.assertEqual(self.sources.list(), [])

    def test_background_fetch_and_refresh(self):
        thread = self.sources._start("release")
        thread.join(10)
        self.assertEqual(self.sources.summary("release")["state"], "ready")   # cached, but not configured yet
        self.assertEqual(self.sources.list(), [])
        self.sources.add("release")
        for _ in range(100):
            if self.sources.summary("release")["state"] == "ready":
                break
            time.sleep(0.05)
        self.assertEqual(self.sources.summary("release")["state"], "ready")
        downloads = len([u for u in self.fetch.calls if "codeload" in u])
        self.sources.refresh("release", background=False)
        self.assertEqual(len([u for u in self.fetch.calls if "codeload" in u]), downloads + 1)
        with self.assertRaises(SourceError):
            self.sources.refresh("pr/660")

    def test_enable_and_disable(self):
        self.sources.add("release", background=False)
        self.assertFalse(self.sources.set_enabled("release", False)["enabled"])
        self.assertEqual(self.settings.as_dict()["sources"], [{"id": "release", "enabled": False}])
        with self.assertRaises(SourceError):
            self.sources.set_enabled("pr/1", True)

    def test_defaults_on_first_start(self):
        self.sources.ensure_defaults(background=False)
        self.assertEqual([s["id"] for s in self.sources.list()], ["release", "next"])
        self.sources.ensure_defaults(background=False)   # not twice
        self.assertEqual(len(self.sources.list()), 2)

    def test_prefetch_takes_titles_from_the_list_and_spends_no_api_call(self):
        self.fetch.routes["https://codeload.github.com/john30/ebusd-configuration/tar.gz/refs/pull/702/head"] = PR
        before = len(self.fetch.calls)
        summaries = self.sources.prefetch([702, 660])
        self.assertEqual([s["id"] for s in summaries], ["pr/702", "pr/660"])
        for _ in range(100):
            if self.sources.summary("pr/702")["state"] == "ready" and self.sources.summary("pr/660")["state"] == "ready":
                break
            time.sleep(0.05)
        meta = self.sources.summary("pr/702")
        self.assertEqual((meta["state"], meta["title"], meta["head"]), ("ready", "vaillant/hmu: add brine test values", "c93fb06"))
        self.assertEqual(self.sources.list(), [], "prefetched pull requests are not configured")
        self.assertEqual(self.sources.files("pr/702")["kind"], "tsp")
        api_calls = [u for u in self.fetch.calls[before:] if "api.github.com/repos/john30/ebusd-configuration/pulls/" in u]
        self.assertEqual(api_calls, [])
        downloads = len([u for u in self.fetch.calls if "codeload" in u])
        self.sources.prefetch([702])   # cached at the same head: nothing to fetch
        self.assertEqual(len([u for u in self.fetch.calls if "codeload" in u]), downloads)

    def test_suggested_pull_requests_are_cached(self):
        pulls = self.sources.suggest()
        self.assertEqual([p["number"] for p in pulls["pulls"]], [702, 701])
        self.assertTrue(pulls["pulls"][1]["draft"])
        calls = len(self.fetch.calls)
        self.sources.suggest()
        self.assertEqual(len(self.fetch.calls), calls)   # from the cache
        again = Sources(self.tmp.name, self.settings, fetch=Fetcher({}))
        self.assertEqual(len(again.suggest()["pulls"]), 2)   # from the cache file
        self.assertIn("stale", again.suggest(max_age=0))   # the API is down: the cached list, marked stale


class SettingsSources(unittest.TestCase):
    def test_sources_are_normalised(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings(os.path.join(tmp, "settings.json"))
            settings.update({"sources": [{"id": "660"}, "release", {"id": "pr/660", "enabled": False}, {"id": "next", "enabled": False}]})
            self.assertEqual(settings.as_dict()["sources"], [{"id": "pr/660", "enabled": True}, {"id": "release", "enabled": True}, {"id": "next", "enabled": False}])
            with self.assertRaises(ValueError):
                settings.update({"sources": [{"id": "ssh://x"}]})
            # settings of earlier versions are ignored
            settings.update({"layers": [{"ref": "pr/1"}], "compile": {"entry": "x"}, "upstream_url": "u"})
            self.assertNotIn("layers", settings.as_dict())


if __name__ == "__main__":
    unittest.main()
