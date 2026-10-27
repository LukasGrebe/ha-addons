"""Unit tests of the git repository wrapper, deploy and settings of the Workbench."""

import os
import subprocess
import sys
import tempfile
import unittest
import unittest.mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ebusd_workbench"))
from workbench import deploy  # noqa: E402
from workbench.gitrepo import Repo, RepoError, safe_relative  # noqa: E402
from workbench.settings import Settings  # noqa: E402


def git(*args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True,
                          env=dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@x", GIT_COMMITTER_NAME="t",
                                   GIT_COMMITTER_EMAIL="t@x")).stdout


class SafePaths(unittest.TestCase):
    def test_accepts_relative_paths(self):
        self.assertEqual(safe_relative("src/vaillant/08.bai.tsp"), "src/vaillant/08.bai.tsp")
        self.assertEqual(safe_relative("./a//b/"), "a/b")

    def test_rejects_escapes(self):
        for bad in ("", "/etc/passwd", "../x", "a/../../b", "a\\b", "a\x00b", None, 5):
            with self.assertRaises(RepoError):
                safe_relative(bad)


class Repository(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.remote = os.path.join(self.tmp.name, "remote.git")
        git("init", "--bare", "-q", "--initial-branch=main", self.remote, cwd=self.tmp.name)
        seed = os.path.join(self.tmp.name, "seed")
        git("clone", "-q", self.remote, seed, cwd=self.tmp.name)
        os.makedirs(os.path.join(seed, "src", "vaillant"))
        with open(os.path.join(seed, "src", "main.tsp"), "w") as f:
            f.write('import "./vaillant/08.bai.tsp";\n')
        with open(os.path.join(seed, "src", "vaillant", "08.bai.tsp"), "w") as f:
            f.write("model Bai {}\n")
        with open(os.path.join(seed, "src", "de.yaml"), "w") as f:
            f.write("a: b\n")
        os.symlink("08.bai.tsp", os.path.join(seed, "src", "vaillant", "08.copy.tsp"))
        git("add", "-A", cwd=seed)
        git("commit", "-q", "-m", "seed", cwd=seed)
        git("push", "-q", "origin", "HEAD:main", cwd=seed)
        self.env = dict(os.environ, GIT_AUTHOR_NAME="Work Bench", GIT_AUTHOR_EMAIL="wb@example.org",
                        GIT_COMMITTER_NAME="Work Bench", GIT_COMMITTER_EMAIL="wb@example.org")
        self.patch = unittest.mock.patch.dict(os.environ, self.env)
        self.patch.start()
        self.repo = Repo(os.path.join(self.tmp.name, "config", "repo"))

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def test_clone_edit_commit_push(self):
        self.assertFalse(self.repo.exists())
        self.assertEqual(self.repo.status(), {"exists": False, "dir": self.repo.dir, "busy": None})
        self.repo.clone(self.remote)
        status = self.repo.status()
        self.assertTrue(status["exists"])
        self.assertEqual((status["branch"], status["ahead"], status["behind"], status["changes"]), ("main", 0, 0, []))
        self.assertEqual(status["head"]["subject"], "seed")
        self.assertEqual(status["remote"], self.remote)
        with self.assertRaises(RepoError):
            self.repo.clone(self.remote)

        tree = {e["path"]: e for e in self.repo.tree()}
        self.assertEqual(tree["src/vaillant/08.copy.tsp"], {"path": "src/vaillant/08.copy.tsp", "type": "link", "target": "08.bai.tsp", "size": 13})
        self.assertEqual(tree["src"]["type"], "dir")
        self.assertNotIn(".git/HEAD", tree)

        sources = self.repo.sources("src")
        self.assertEqual(set(sources), {"main.tsp", "de.yaml", "vaillant/08.bai.tsp", "vaillant/08.copy.tsp"})
        self.assertEqual(sources["vaillant/08.copy.tsp"], "model Bai {}\n")

        self.assertEqual(self.repo.read_file("src/main.tsp"), 'import "./vaillant/08.bai.tsp";\n')
        self.repo.write_file("src/vaillant/08.bai.tsp", "model Bai { a: UCH }\n")
        self.repo.write_file("src/new/x.tsp", "// new\n")
        changes = {c["path"]: c["status"] for c in self.repo.status()["changes"]}
        self.assertEqual(changes, {"src/vaillant/08.bai.tsp": "M", "src/new/x.tsp": "?"})
        self.assertIn("+model Bai { a: UCH }", self.repo.diff("src/vaillant/08.bai.tsp"))
        self.assertIn("+// new", self.repo.diff("src/new/x.tsp"))
        with self.assertRaises(RepoError):
            self.repo.commit("   ")
        status = self.repo.commit("add field", ["src/vaillant/08.bai.tsp"])
        self.assertEqual((status["ahead"], [c["path"] for c in status["changes"]]), (1, ["src/new/x.tsp"]))
        self.assertEqual(status["head"]["author"], "Work Bench")
        self.repo.discard("src/new/x.tsp")
        self.assertEqual(self.repo.status()["changes"], [])
        self.repo.push()
        self.assertEqual(self.repo.status()["ahead"], 0)
        self.assertEqual(git("log", "-1", "--format=%s", "main", cwd=self.remote).strip(), "add field")
        self.assertEqual([e["subject"] for e in self.repo.log()], ["add field", "seed"])
        self.repo.checkout("feature", create=True)
        self.assertEqual(self.repo.status()["branch"], "feature")
        self.assertEqual(sorted(self.repo.branches()), ["feature", "main"])

    def test_pull_fast_forward_only(self):
        self.repo.clone(self.remote)
        other = os.path.join(self.tmp.name, "other")
        git("clone", "-q", self.remote, other, cwd=self.tmp.name)
        with open(os.path.join(other, "src", "main.tsp"), "a") as f:
            f.write("// upstream\n")
        git("commit", "-q", "-am", "upstream", cwd=other)
        git("push", "-q", cwd=other)
        self.repo.fetch()
        self.assertEqual(self.repo.status()["behind"], 1)
        self.repo.pull()
        self.assertEqual(self.repo.status()["behind"], 0)
        self.assertIn("// upstream", self.repo.read_file("src/main.tsp"))

    def test_paths_stay_inside(self):
        self.repo.clone(self.remote)
        for bad in ("../remote.git/HEAD", "/etc/passwd", ".git/../../x"):
            with self.assertRaises(RepoError):
                self.repo.read_file(bad)
        os.symlink("/", os.path.join(self.repo.dir, "escape"))
        with self.assertRaises(RepoError):
            self.repo.read_file("escape/etc/passwd")
        with self.assertRaises(RepoError):
            self.repo.write_file("escape/tmp/x", "no")
        with self.assertRaises(RepoError):
            self.repo.read_file("src")
        self.repo.delete_file("escape")
        with self.assertRaises(RepoError):
            self.repo.delete_file("src")  # not empty

    def test_init_without_remote(self):
        self.repo.init()
        self.assertTrue(self.repo.exists())
        self.repo.write_file("main.tsp", "model X {}\n")
        self.repo.commit("first")
        self.assertEqual(self.repo.status()["head"]["subject"], "first")
        with self.assertRaises(RepoError):
            self.repo.push()


class Deploy(unittest.TestCase):
    def test_deploy_and_clean(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "share", "ebusd", "config")
            result = deploy.deploy({"vaillant/08.bai.csv": "a\n", "broadcast.csv": "b\n", "vaillant/bai.1.inc": "c\n"}, target)
            self.assertEqual(result["written"], ["broadcast.csv", "vaillant/08.bai.csv", "vaillant/bai.1.inc"])
            with open(os.path.join(target, "vaillant", "08.bai.csv")) as f:
                self.assertEqual(f.read(), "a\n")
            listed = deploy.list_deployed(target)
            self.assertEqual([f["path"] for f in listed["files"]], ["broadcast.csv", "vaillant/08.bai.csv", "vaillant/bai.1.inc"])
            result = deploy.deploy({"vaillant/08.bai.csv": "a2\n"}, target, subdir="", clean=True)
            self.assertEqual(result["removed"], ["broadcast.csv", "vaillant/bai.1.inc"])
            self.assertEqual([f["path"] for f in deploy.list_deployed(target)["files"]], ["vaillant/08.bai.csv"])
            result = deploy.deploy({"x.csv": "x"}, target, subdir="en")
            self.assertEqual(result["dir"], os.path.join(target, "en"))
            for bad in ({"../x.csv": "a"}, {"x.txt": "a"}, {}, {"x.csv": 5}, "x"):
                with self.assertRaises(RepoError):
                    deploy.deploy(bad, target)
            self.assertFalse(deploy.list_deployed(os.path.join(tmp, "missing"))["exists"])


class RepoBusy(unittest.TestCase):
    def test_busy_state_while_working(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Repo(os.path.join(tmp, "repo"))
            self.assertIsNone(repo.status()["busy"])
            with repo.working("cloning https://example.invalid/x.git"):
                busy = repo.status()["busy"]
                self.assertEqual(busy["what"], "cloning https://example.invalid/x.git")
                self.assertGreater(busy["since"], 0)
            self.assertIsNone(repo.status()["busy"])
            # a failing clone clears the state again
            with self.assertRaises(RepoError):
                repo.clone("file:///does/not/exist.git")
            self.assertIsNone(repo.status()["busy"])


class SettingsFile(unittest.TestCase):
    def test_validation_and_persistence(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "data", "settings.json")
            settings = Settings(path)
            self.assertEqual(settings.entities, [])
            self.assertEqual(settings.as_dict()["id_overrides"], {"b509": 3, "b524": 6})
            changed = settings.update({"entities": ["switch.pump ", "bad entity", "light.x"], "id_bytes": 99,
                                       "id_overrides": {"B504": "2", "08b509": 5}, "unknown": 1, "deploy_subdir": "/en/"})
            self.assertTrue(changed)
            self.assertEqual(settings.entities, ["light.x", "switch.pump"])
            self.assertFalse(settings.update({"entities": ["light.x", "switch.pump"]}))
            data = Settings(path).as_dict()
            self.assertEqual((data["id_bytes"], data["id_overrides"], data["deploy_subdir"]), (8, {"b504": 2, "08b509": 5}, "en"))
            self.assertEqual(data["compile"]["entry"], "src/main.tsp")
            for bad in ({"entities": "x"}, {"id_overrides": {"zz": 1}}, {"id_overrides": {"b509": "x"}}, [], {"compile": 1},
                        {"own_address": "3"}, {"own_address": "zz"}):
                with self.assertRaises((ValueError, TypeError)):
                    settings.update(bad)
            # ebusd's own address and the setup (included definitions, chosen candidates, renames) round-trip
            self.assertEqual(settings.as_dict()["own_address"], "31")
            settings.update({"own_address": " F1 "})
            setup = {"included": ["a.csv|c|Name|"], "chosen": {"10→08 b509 0d": "a.csv|c|Name|"},
                     "names": {"a.csv|c|Name|": {"name": "Verbose", "fields": {"temp": "temperature"}}}, "circuits": {"c": "heating"}}
            settings.update({"setup": setup})
            data = Settings(path).as_dict()
            self.assertEqual(data["own_address"], "f1")
            self.assertEqual(data["setup"], setup)


if __name__ == "__main__":
    import unittest.mock  # noqa: F401
    unittest.main()


class Layers(unittest.TestCase):
    """Pull requests of the upstream repository compiled on top of the checkout."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.upstream = os.path.join(self.tmp.name, "upstream.git")
        git("init", "--bare", "-q", "--initial-branch=master", self.upstream, cwd=self.tmp.name)
        work = os.path.join(self.tmp.name, "work")
        git("clone", "-q", self.upstream, work, cwd=self.tmp.name)
        os.makedirs(os.path.join(work, "src", "vaillant"))
        self.padding = "".join(f"// line {i}\n" for i in range(8))  # keeps the changes of the pull requests apart
        with open(os.path.join(work, "src", "vaillant", "08.hmu.tsp"), "w") as f:
            f.write("model Hmu {}\n" + self.padding)
        with open(os.path.join(work, "src", "vaillant", "76.vwz.tsp"), "w") as f:
            f.write("model Vwz {}\n")
        git("add", "-A", cwd=work)
        git("commit", "-q", "-m", "base", cwd=work)
        git("push", "-q", "origin", "HEAD:master", cwd=work)
        # a pull request: changes one file, adds one, deletes one
        git("checkout", "-q", "-b", "pr", cwd=work)
        with open(os.path.join(work, "src", "vaillant", "08.hmu.tsp"), "w") as f:
            f.write("model Hmu { a: UCH }\n" + self.padding)
        with open(os.path.join(work, "src", "vaillant", "b531_inc.tsp"), "w") as f:
            f.write("model Inc {}\n")
        os.remove(os.path.join(work, "src", "vaillant", "76.vwz.tsp"))
        git("add", "-A", cwd=work)
        git("commit", "-q", "-m", "pr 660", cwd=work)
        git("push", "-q", "origin", "HEAD:refs/pull/660/head", cwd=work)
        # the user's fork: a clone of upstream with a local change
        self.fork = os.path.join(self.tmp.name, "fork.git")
        git("clone", "-q", "--bare", self.upstream, self.fork, cwd=self.tmp.name)
        self.patch = unittest.mock.patch.dict(os.environ, {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x",
                                                           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@x"})
        self.patch.start()
        self.repo = Repo(os.path.join(self.tmp.name, "checkout"))
        self.repo.clone(self.fork)

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def test_refs(self):
        self.assertEqual(Repo.layer_ref("660"), "pr/660")
        self.assertEqual(Repo.layer_ref("#660"), "pr/660")
        self.assertEqual(Repo.layer_ref("upstream/master"), "upstream/master")
        for bad in ("", "../x", "pr/x", "refs/heads/x", "origin/a..b", "foo"):
            with self.assertRaises(RepoError):
                Repo.layer_ref(bad)

    def test_fetch_and_apply(self):
        self.assertEqual(self.repo.layer_info("660"), {"ref": "pr/660", "fetched": False})
        layer = self.repo.fetch_layer("660", self.upstream)
        self.assertTrue(layer["fetched"] and layer["common_history"])
        self.assertEqual(layer["head"]["subject"], "pr 660")
        self.assertEqual(sorted((c["status"], c["path"]) for c in layer["changes"]),
                         [("A", "src/vaillant/b531_inc.tsp"), ("D", "src/vaillant/76.vwz.tsp"), ("M", "src/vaillant/08.hmu.tsp")])
        self.assertEqual(self.repo.run("remote", "get-url", "upstream").stdout.strip(), self.upstream)
        merged = self.repo.sources_with_layers("src", ["pr/660"])
        self.assertEqual(merged["files"], {"vaillant/08.hmu.tsp": "model Hmu { a: UCH }\n" + self.padding, "vaillant/b531_inc.tsp": "model Inc {}\n"})
        self.assertEqual(merged["origins"], {"vaillant/08.hmu.tsp": "pr/660", "vaillant/b531_inc.tsp": "pr/660", "vaillant/76.vwz.tsp": "pr/660"})
        self.assertEqual(merged["conflicts"], [])
        # the checkout itself is untouched
        self.assertEqual(self.repo.status()["changes"], [])
        self.assertEqual(self.repo.read_file("src/vaillant/08.hmu.tsp"), "model Hmu {}\n" + self.padding)
        # a layer that is not fetched is skipped; the same change twice merges without conflict
        merged = self.repo.sources_with_layers("src", ["pr/660", "pr/661", "pr/660"])
        self.assertEqual([l["fetched"] for l in merged["layers"]], [True, False, True])
        self.assertEqual(merged["conflicts"], [])
        self.assertEqual(merged["origin_layers"]["vaillant/08.hmu.tsp"], ["pr/660", "pr/660"])
        self.assertEqual(merged["files"]["vaillant/08.hmu.tsp"], "model Hmu { a: UCH }\n" + self.padding)
        self.repo.remove_layer("pr/660")
        self.assertFalse(self.repo.layer_info("pr/660")["fetched"])

    def test_three_way_merge_of_two_layers(self):
        # a second pull request changing another part of the same file as pr 660
        work = os.path.join(self.tmp.name, "work")
        git("checkout", "-q", "master", cwd=work)
        with open(os.path.join(work, "src", "vaillant", "08.hmu.tsp"), "w") as f:
            f.write("model Hmu {}\n" + self.padding + "model Second { b: UCH }\n")
        git("commit", "-q", "-am", "pr 661", cwd=work)
        git("push", "-q", "origin", "HEAD:refs/pull/661/head", cwd=work)
        self.repo.fetch_layer("660", self.upstream)
        self.repo.fetch_layer("661", self.upstream)
        merged = self.repo.sources_with_layers("src", ["pr/660", "pr/661"])
        self.assertEqual(merged["files"]["vaillant/08.hmu.tsp"], "model Hmu { a: UCH }\n" + self.padding + "model Second { b: UCH }\n")
        self.assertEqual(merged["conflicts"], [])
        self.assertEqual(merged["origins"]["vaillant/08.hmu.tsp"], "pr/661")
        # a conflicting change leaves git's conflict markers for the compiler to report
        with open(os.path.join(work, "src", "vaillant", "08.hmu.tsp"), "w") as f:
            f.write("model Hmu { c: UCH }\n" + self.padding)
        git("commit", "-q", "-am", "pr 662", cwd=work)
        git("push", "-q", "origin", "HEAD:refs/pull/662/head", cwd=work)
        self.repo.fetch_layer("662", self.upstream)
        merged = self.repo.sources_with_layers("src", ["pr/660", "pr/662"])
        self.assertIn("<<<<<<<", merged["files"]["vaillant/08.hmu.tsp"])
        self.assertEqual(merged["conflicts"], [{"path": "vaillant/08.hmu.tsp", "layers": ["pr/660", "pr/662"]}])
