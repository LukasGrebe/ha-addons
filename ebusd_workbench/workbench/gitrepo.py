"""The git repository with the message definitions (TypeSpec sources) and safe file access to it."""

import os
import shutil
import subprocess

GIT_TIMEOUT = 60
CLONE_TIMEOUT = 600
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
