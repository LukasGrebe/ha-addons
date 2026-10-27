"""The git repository with the message definitions (TypeSpec sources) and safe file access to it."""

import io
import os
import re
import shutil
import subprocess
import tarfile
import tempfile

GIT_TIMEOUT = 60
CLONE_TIMEOUT = 600
UPSTREAM_URL = "https://github.com/john30/ebusd-configuration.git"
LAYER_REF = re.compile(r"^(pr/[0-9]{1,6}|upstream/[A-Za-z0-9._/-]{1,100}|origin/[A-Za-z0-9._/-]{1,100})$")
SOURCE_SUFFIXES = (".tsp", ".yaml", ".yml", ".json", ".csv", ".md")
SKIP_DIRS = {".git", "node_modules"}
MAX_TREE_ENTRIES = 5000


class RepoError(Exception):
    pass


def safe_relative(path):
    """Normalise a relative path from the UI and refuse anything that could escape the repository."""
    if not isinstance(path, str) or not path or "\x00" in path or "\\" in path:
        raise RepoError("invalid path")
    parts = [p for p in path.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts) or path.startswith("/"):
        raise RepoError("invalid path")
    return "/".join(parts)


class Repo:
    def __init__(self, directory):
        self.dir = os.path.abspath(directory)

    # -- git --------------------------------------------------------------------

    def exists(self):
        return os.path.isdir(os.path.join(self.dir, ".git"))

    def run(self, *args, timeout=GIT_TIMEOUT, check=True, cwd=None):
        env = dict(os.environ)
        env.setdefault("GIT_TERMINAL_PROMPT", "0")
        env.setdefault("LC_ALL", "C.UTF-8")
        try:
            proc = subprocess.run(["git", *args], cwd=cwd or self.dir, env=env, capture_output=True, text=True,
                                  timeout=timeout)
        except FileNotFoundError:
            raise RepoError("git is not installed")
        except subprocess.TimeoutExpired:
            raise RepoError(f"git {args[0]} timed out after {timeout}s")
        if check and proc.returncode != 0:
            raise RepoError((proc.stderr.strip() or proc.stdout.strip() or f"git {args[0]} failed"))
        return proc

    def clone(self, url, branch=None):
        if not isinstance(url, str) or not url.strip() or url.strip().startswith("-"):
            raise RepoError("invalid repository URL")
        if self.exists():
            raise RepoError("the repository folder is already a git repository")
        if os.path.isdir(self.dir) and os.listdir(self.dir):
            raise RepoError(f"{self.dir} is not empty")
        parent = os.path.dirname(self.dir)
        os.makedirs(parent, exist_ok=True)
        args = ["clone"]
        if branch:
            args += ["--branch", branch]
        args += ["--", url.strip(), self.dir]
        self.run(*args, timeout=CLONE_TIMEOUT, cwd=parent)

    def init(self):
        if self.exists():
            raise RepoError("the repository folder is already a git repository")
        os.makedirs(self.dir, exist_ok=True)
        self.run("init", "-q")

    def status(self):
        if not self.exists():
            return {"exists": False, "dir": self.dir}
        proc = self.run("status", "--porcelain=v2", "--branch", "--untracked-files=all")
        result = {"exists": True, "dir": self.dir, "branch": None, "upstream": None, "ahead": 0, "behind": 0,
                  "changes": [], "remote": None, "head": None}
        for line in proc.stdout.splitlines():
            if line.startswith("# branch.head "):
                result["branch"] = line[14:]
            elif line.startswith("# branch.upstream "):
                result["upstream"] = line[18:]
            elif line.startswith("# branch.ab "):
                ahead, behind = line[12:].split()
                result["ahead"], result["behind"] = int(ahead[1:]), int(behind[1:])
            elif line.startswith("1 ") or line.startswith("2 "):
                fields = line.split(" ", 9 if line.startswith("2 ") else 8)
                xy = fields[1]
                path = fields[-1]
                if line.startswith("2 "):
                    path = path.split("\t")[0]
                result["changes"].append({"path": path, "status": xy.replace(".", ""), "staged": xy[0] != "."})
            elif line.startswith("? "):
                result["changes"].append({"path": line[2:], "status": "?", "staged": False})
        remote = self.run("remote", "get-url", "origin", check=False)
        if remote.returncode == 0:
            result["remote"] = remote.stdout.strip()
        head = self.run("log", "-1", "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s", check=False)
        if head.returncode == 0 and head.stdout.strip():
            result["head"] = self._parse_log_line(head.stdout.strip())
        return result

    @staticmethod
    def _parse_log_line(line):
        parts = line.split("\x1f")
        if len(parts) < 5:
            return None
        return {"hash": parts[0], "short": parts[1], "author": parts[2], "date": parts[3], "subject": parts[4]}

    def log(self, limit=30):
        proc = self.run("log", f"-{max(1, min(500, int(limit)))}", "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s", check=False)
        if proc.returncode != 0:
            return []
        return [entry for entry in (self._parse_log_line(line) for line in proc.stdout.splitlines() if line) if entry]

    def diff(self, path=None, staged=False):
        args = ["diff", "--no-color", "--no-ext-diff"]
        if staged:
            args.append("--cached")
        if path:
            rel = safe_relative(path)
            tracked = self.run("ls-files", "--error-unmatch", "--", rel, check=False).returncode == 0
            if not tracked and not staged:
                full = self.path(rel)
                if os.path.isdir(full):
                    return ""
                proc = self.run("diff", "--no-color", "--no-index", "--", "/dev/null", full, check=False)
                return proc.stdout.replace(full, "/" + rel)
            args += ["--", rel]
        return self.run(*args).stdout

    def commit(self, message, paths=None):
        if not isinstance(message, str) or not message.strip():
            raise RepoError("a commit message is required")
        if paths:
            rels = [safe_relative(p) for p in paths]
            self.run("add", "-A", "--", *rels)
        else:
            self.run("add", "-A")
        if not self.run("status", "--porcelain").stdout.strip():
            raise RepoError("nothing to commit")
        if not self.run("config", "user.name", check=False).stdout.strip() and not os.environ.get("GIT_AUTHOR_NAME"):
            raise RepoError("set 'Git user name' and 'Git user email' in the app configuration first")
        self.run("commit", "-q", "-m", message.strip())
        return self.status()

    def fetch(self):
        self.run("fetch", "--quiet", timeout=CLONE_TIMEOUT)
        return self.status()

    def pull(self):
        proc = self.run("pull", "--ff-only", "--quiet", timeout=CLONE_TIMEOUT, check=False)
        if proc.returncode != 0:
            raise RepoError(proc.stderr.strip() or "pull failed (local commits and remote diverged? commit or discard your changes first)")
        return self.status()

    def push(self):
        branch = self.run("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
        proc = self.run("push", "--quiet", "-u", "origin", branch, timeout=CLONE_TIMEOUT, check=False)
        if proc.returncode != 0:
            raise RepoError(proc.stderr.strip() or "push failed")
        return self.status()

    def discard(self, path):
        rel = safe_relative(path)
        tracked = self.run("ls-files", "--error-unmatch", "--", rel, check=False).returncode == 0
        if tracked:
            self.run("checkout", "--", rel)
        else:
            full = self.path(rel, follow=False)
            if os.path.isdir(full) and not os.path.islink(full):
                shutil.rmtree(full)
            elif os.path.lexists(full):
                os.remove(full)
        return self.status()

    def branches(self):
        proc = self.run("branch", "--format=%(refname:short)", check=False)
        return [b for b in proc.stdout.splitlines() if b] if proc.returncode == 0 else []

    def checkout(self, branch, create=False):
        if not isinstance(branch, str) or not branch or branch.startswith("-") or any(c in branch for c in " ~^:?*[\\"):
            raise RepoError("invalid branch name")
        args = ["checkout", "-q"]
        if create:
            args.append("-b")
        args.append(branch)
        self.run(*args)
        return self.status()

    # -- layers: pull requests and branches compiled on top of the checkout -------------

    @staticmethod
    def layer_ref(spec):
        """Normalise a layer given as "660", "#660", "pr/660", "upstream/master" or "origin/next"."""
        spec = str(spec or "").strip()
        if re.fullmatch(r"#?[0-9]{1,6}", spec):
            spec = "pr/" + spec.lstrip("#")
        if not LAYER_REF.match(spec) or ".." in spec or spec.endswith("/") or spec.endswith(".lock"):
            raise RepoError("a layer is a pull request number (660) or a branch (upstream/master, origin/next)")
        return spec

    def ensure_upstream(self, url=None):
        """Make sure the remote `upstream` (the repository the pull requests belong to) exists."""
        url = url or UPSTREAM_URL
        origin = self.run("remote", "get-url", "origin", check=False)
        if origin.returncode == 0 and origin.stdout.strip().rstrip("/") == url.rstrip("/"):
            return "origin"
        current = self.run("remote", "get-url", "upstream", check=False)
        if current.returncode != 0:
            self.run("remote", "add", "upstream", url)
        elif current.stdout.strip() != url:
            self.run("remote", "set-url", "upstream", url)
        return "upstream"

    def fetch_layer(self, spec, upstream_url=None):
        """Fetch a pull request head or branch into refs/workbench/<layer> and describe it."""
        ref = self.layer_ref(spec)
        kind, _, rest = ref.partition("/")
        if kind == "pr":
            remote = self.ensure_upstream(upstream_url)
            source = f"refs/pull/{rest}/head"
        elif kind == "upstream":
            remote = self.ensure_upstream(upstream_url)
            source = f"refs/heads/{rest}"
        else:
            remote, source = "origin", f"refs/heads/{rest}"
        self.run("fetch", "--quiet", "--force", remote, f"{source}:refs/workbench/{ref}", timeout=CLONE_TIMEOUT)
        return self.layer_info(ref)

    def layer_info(self, ref, subdir=""):
        """Head commit and the files a layer changes against the checkout's history."""
        ref = self.layer_ref(ref)
        full = f"refs/workbench/{ref}"
        head = self.run("log", "-1", "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s", full, check=False)
        if head.returncode != 0:
            return {"ref": ref, "fetched": False}
        base = self.run("merge-base", "HEAD", full, check=False)
        base_rev = base.stdout.strip() if base.returncode == 0 and base.stdout.strip() else "HEAD"
        args = ["diff", "--name-status", "--no-renames", base_rev, full]
        if subdir:
            args += ["--", safe_relative(subdir)]
        changes = []
        for line in self.run(*args).stdout.splitlines():
            status, _, path = line.partition("\t")
            if path:
                changes.append({"status": status[:1], "path": path})
        return {"ref": ref, "fetched": True, "head": self._parse_log_line(head.stdout.strip()), "changes": changes,
                "common_history": base_rev != "HEAD"}

    def remove_layer(self, ref):
        ref = self.layer_ref(ref)
        self.run("update-ref", "-d", f"refs/workbench/{ref}", check=False)

    def layer_files(self, ref, subdir=""):
        """The TypeSpec sources below subdir in a layer, as {relative path: content}."""
        ref = self.layer_ref(ref)
        args = ["archive", "--format=tar", f"refs/workbench/{ref}"]
        if subdir:
            args.append(safe_relative(subdir))
        proc = self.run(*args, timeout=CLONE_TIMEOUT)  # text=True decodes; redo as bytes
        raw = subprocess.run(["git", *args], cwd=self.dir, capture_output=True, timeout=CLONE_TIMEOUT).stdout
        if proc.returncode != 0 or not raw:
            raise RepoError(f"unable to read layer {ref}")
        prefix = (safe_relative(subdir) + "/") if subdir else ""
        result = {}
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as tar:
            for member in tar:
                if not member.isfile() or not member.name.endswith((".tsp", ".yaml", ".yml")):
                    continue
                name = member.name
                if prefix and name.startswith(prefix):
                    name = name[len(prefix):]
                handle = tar.extractfile(member)
                if handle is not None:
                    result[name] = handle.read().decode("utf-8", errors="replace")
        return result

    def show(self, rev, path):
        """The content of a file at a revision, or None if it does not exist there."""
        proc = self.run("show", f"{rev}:{path}", check=False)
        return proc.stdout if proc.returncode == 0 else None

    def merge_file(self, ours, base, theirs, label):
        """Three-way merge of file contents like git does; returns (content, conflicted)."""
        with tempfile.TemporaryDirectory() as tmp:
            paths = []
            for name, content in (("ours", ours), ("base", base), ("theirs", theirs)):
                path = os.path.join(tmp, name)
                with open(path, "w", encoding="utf-8", newline="") as f:
                    f.write(content or "")
                paths.append(path)
            proc = self.run("merge-file", "-p", "-L", "checkout", "-L", "base", "-L", label, *paths, check=False)
            # exit status: number of conflicts, or negative on error
            if proc.returncode < 0:
                raise RepoError(f"merging {label} failed: {proc.stderr.strip()}")
            return proc.stdout, proc.returncode > 0

    def sources_with_layers(self, subdir, layers):
        """The sources of the checkout with the changes of the layers merged in order.

        A file changed by one layer is taken from that layer; a file changed by several layers is
        merged three-way (checkout, the layer's merge base, the layer) like git would, conflict
        markers included. Returns {files, origins, conflicts, layers}: origins maps a file to the
        layers that changed it, conflicts lists files with conflict markers.
        """
        files = self.sources(subdir)
        origins = {}
        conflicts = []
        info = []
        rel = safe_relative(subdir) if subdir else ""
        for spec in layers:
            layer = self.layer_info(spec, subdir)
            info.append(layer)
            if not layer.get("fetched"):
                continue
            contents = None
            full = f"refs/workbench/{layer['ref']}"
            base_rev = self.run("merge-base", "HEAD", full, check=False).stdout.strip() if layer.get("common_history") else "HEAD"
            for change in layer["changes"]:
                path = change["path"]
                if rel:
                    if not path.startswith(rel + "/"):
                        continue
                    path = path[len(rel) + 1:]
                if not path.endswith((".tsp", ".yaml", ".yml")):
                    continue
                if change["status"] == "D":
                    files.pop(path, None)
                else:
                    if contents is None:
                        contents = self.layer_files(layer["ref"], subdir)
                    if path not in contents:
                        continue
                    if path in origins and path in files:
                        merged, conflicted = self.merge_file(files[path], self.show(base_rev, change["path"]), contents[path], layer["ref"])
                        files[path] = merged
                        if conflicted:
                            conflicts.append({"path": path, "layers": origins[path] + [layer["ref"]]})
                    else:
                        files[path] = contents[path]
                origins.setdefault(path, []).append(layer["ref"])
        return {"files": files, "origins": {p: l[-1] for p, l in origins.items()}, "origin_layers": origins,
                "conflicts": conflicts, "layers": info}

    # -- files ------------------------------------------------------------------

    def path(self, rel, follow=True):
        """Absolute path of a relative path inside the repository.

        Symlinks are resolved and must stay inside the repository; with follow=False the last
        component itself may be a symlink pointing anywhere (to delete it, for example).
        """
        rel = safe_relative(rel)
        full = os.path.join(self.dir, rel)
        root = os.path.realpath(self.dir)
        real = os.path.realpath(os.path.dirname(full) if not follow else full)
        if real != root and not real.startswith(root + os.sep):
            raise RepoError("path outside of the repository")
        return full

    def tree(self):
        """All files and folders (without .git), symlinks with their target."""
        entries = []
        root = self.dir
        for current, dirs, files in os.walk(root):
            dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
            rel_dir = os.path.relpath(current, root)
            rel_dir = "" if rel_dir == "." else rel_dir
            for name in dirs:
                entries.append({"path": f"{rel_dir}/{name}" if rel_dir else name, "type": "dir"})
            for name in sorted(files):
                rel = f"{rel_dir}/{name}" if rel_dir else name
                full = os.path.join(current, name)
                entry = {"path": rel, "type": "file"}
                if os.path.islink(full):
                    entry["type"] = "link"
                    entry["target"] = os.readlink(full)
                try:
                    entry["size"] = os.path.getsize(full)
                except OSError:
                    entry["size"] = 0
                entries.append(entry)
            if len(entries) > MAX_TREE_ENTRIES:
                entries.append({"path": "…", "type": "truncated"})
                return entries
        return entries

    def read_file(self, rel):
        full = self.path(rel)
        if not os.path.isfile(full):
            raise RepoError("no such file")
        with open(full, "r", encoding="utf-8", errors="replace") as f:
            return f.read()

    def write_file(self, rel, content):
        full = self.path(rel)
        if os.path.isdir(full):
            raise RepoError("is a folder")
        os.makedirs(os.path.dirname(full), exist_ok=True)
        tmp = full + ".tmp~"
        with open(tmp, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        os.replace(tmp, full)

    def delete_file(self, rel):
        full = self.path(rel, follow=False)
        if os.path.isdir(full) and not os.path.islink(full):
            if os.listdir(full):
                raise RepoError("folder is not empty")
            os.rmdir(full)
        elif os.path.lexists(full):
            os.remove(full)
        else:
            raise RepoError("no such file")

    def sources(self, subdir=""):
        """All TypeSpec sources (and YAML translations) below subdir as {relative path: content}.

        Symlinks are followed (ebusd-configuration shares files between devices that way).
        """
        base = self.path(subdir) if subdir else self.dir
        if not os.path.isdir(base):
            raise RepoError("no such folder")
        result = {}
        for current, dirs, files in os.walk(base, followlinks=True):
            dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
            for name in sorted(files):
                if not name.endswith((".tsp", ".yaml", ".yml")):
                    continue
                full = os.path.join(current, name)
                rel = os.path.relpath(full, base).replace(os.sep, "/")
                try:
                    with open(full, "r", encoding="utf-8", errors="replace") as f:
                        result[rel] = f.read()
                except OSError:
                    continue
            if len(result) > MAX_TREE_ENTRIES:
                break
        return result
