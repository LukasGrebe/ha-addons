#!/usr/bin/env bash
# Add an upstream ebusd release to CHANGELOG.md: a line in the "# Unreleased"
# section (created if missing) and the upstream notes as their own section
# right below it, like the earlier "# 26.1 (...)" entry.
# Usage: changelog-upstream.sh APP_DIR VERSION UPSTREAM_NOTES_FILE
set -euo pipefail

changelog="$1/CHANGELOG.md" version=$2 notes=$3
if ! grep -q '^# Unreleased' "$changelog"; then
    { printf '# Unreleased\n\n## App Changes\n'; cat "$changelog"; } > "$changelog.new"
    mv "$changelog.new" "$changelog"
fi
awk -v version="$version" -v notes="$notes" '
    function insert() {
        print "* Update ebusd to [" version "](https://github.com/john30/ebusd/releases/tag/" version ")"
        print ""
        while ((getline line < notes) > 0) print line
        print ""
        done = 1
    }
    !done && /^# / && !/^# Unreleased/ { insert() }
    { print }
    END { if (!done) insert() }
' "$changelog" > "$changelog.new"
mv "$changelog.new" "$changelog"
