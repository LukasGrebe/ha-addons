#!/usr/bin/env bash
# Publish a directory as the only commit of BRANCH (force push), so that
# Supervisor installs exactly this content from https://github.com/REPO#BRANCH.
# Usage: push-channel.sh DIR BRANCH MESSAGE   (needs GH_TOKEN and GITHUB_REPOSITORY)
set -euo pipefail

dir=$1 branch=$2 message=$3
cd "$dir"
git init -q
git checkout -q -b "$branch"
git add -A
git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    commit -q -m "$message"
git push -q --force "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "HEAD:refs/heads/$branch"
