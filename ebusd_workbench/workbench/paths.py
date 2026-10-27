"""Relative paths from the UI, checked before they touch the file system."""


class PathError(Exception):
    pass


def safe_relative(path):
    """Normalise a relative path from the UI and refuse anything that could escape a folder."""
    if not isinstance(path, str) or not path or "\x00" in path or "\\" in path:
        raise PathError("invalid path")
    parts = [p for p in path.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts) or path.startswith("/"):
        raise PathError("invalid path")
    return "/".join(parts)
