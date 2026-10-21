#!/usr/bin/env bash
# Print the version the next release of the app gets: the version in
# config.yaml if it is not released (tagged) yet, else its next patch version.
# Usage: next-version.sh [APP_DIR]   (run inside a checkout with remote origin)
set -euo pipefail

app=${1:-ebusd}
version=$(yq -r .version "$app/config.yaml")
if git ls-remote --exit-code --tags origin "refs/tags/$version" >/dev/null; then
    IFS=. read -r major minor patch <<< "$version"
    version="$major.$minor.$((patch + 1))"
fi
echo "$version"
