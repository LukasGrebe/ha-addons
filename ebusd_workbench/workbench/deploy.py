"""Write compiled CSV message definitions to the folder the eBUSd app reads them from."""

import os
import time

from .paths import PathError, safe_relative

MAX_FILES = 1000
MAX_SIZE = 4 * 1024 * 1024  # per file


DEPLOY_SUFFIXES = (".csv", ".inc")  # ebusd loads .csv files; .inc files are pulled in by !load/!include


MANIFEST = "workbench-setup.json"   # what was sourced where; ebusd ignores it


def csv_relative(path):
    rel = safe_relative(path)
    if not rel.endswith(DEPLOY_SUFFIXES) and rel != MANIFEST:
        raise PathError(f"{path}: only .csv and .inc files (and {MANIFEST}) are deployed")
    return rel


def deploy(files, target_dir, subdir="", clean=False):
    """Write files ({relative path: content}) below target_dir/subdir.

    With clean, .csv/.inc files in that folder (recursively) that are not part of files are removed,
    so that ebusd does not pick up stale definitions. Returns the written and removed paths.
    """
    if not isinstance(files, dict) or not files:
        raise PathError("no files to deploy")
    if len(files) > MAX_FILES:
        raise PathError("too many files")
    base = os.path.abspath(target_dir)
    if subdir:
        base = os.path.join(base, safe_relative(subdir))
    written = []
    planned = {}
    for path, content in files.items():
        rel = csv_relative(path)
        if not isinstance(content, str) or len(content) > MAX_SIZE:
            raise PathError(f"{path}: invalid content")
        planned[rel] = content
    os.makedirs(base, exist_ok=True)
    for rel, content in sorted(planned.items()):
        full = os.path.join(base, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        tmp = full + ".tmp~"
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)
        os.replace(tmp, full)
        written.append(rel)
    removed = []
    if clean:
        for current, dirs, names in os.walk(base):
            for name in names:
                if not name.endswith(DEPLOY_SUFFIXES):
                    continue
                rel = os.path.relpath(os.path.join(current, name), base).replace(os.sep, "/")
                if rel not in planned:
                    os.remove(os.path.join(current, name))
                    removed.append(rel)
    return {"dir": base, "written": written, "removed": sorted(removed)}


def list_deployed(target_dir):
    base = os.path.abspath(target_dir)
    result = {"dir": base, "exists": os.path.isdir(base), "files": []}
    if not result["exists"]:
        return result
    for current, dirs, names in os.walk(base):
        dirs.sort()
        for name in sorted(names):
            if not name.endswith(DEPLOY_SUFFIXES):
                continue
            full = os.path.join(current, name)
            try:
                stat = os.stat(full)
            except OSError:
                continue
            result["files"].append({"path": os.path.relpath(full, base).replace(os.sep, "/"), "size": stat.st_size,
                                    "mtime_ms": int(stat.st_mtime * 1000)})
            if len(result["files"]) >= MAX_FILES:
                return result
    result["now_ms"] = int(time.time() * 1000)
    return result
