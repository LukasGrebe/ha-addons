#!/usr/bin/env bash
# Create or update the preview comment on a PR (one comment per PR).
# Usage: sticky-comment.sh PR BODY_FILE   (needs GH_TOKEN and GITHUB_REPOSITORY)
set -euo pipefail

pr=$1 file=$2
marker="<!-- ebusd-preview -->"
body="$marker
$(cat "$file")"
id=$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$pr/comments" \
    --jq ".[] | select(.body | startswith(\"$marker\")) | .id" | head -n1)
if [ -n "$id" ]; then
    gh api -X PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$id" -f body="$body" >/dev/null
else
    gh api "repos/$GITHUB_REPOSITORY/issues/$pr/comments" -f body="$body" >/dev/null
fi
