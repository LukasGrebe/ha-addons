#!/usr/bin/env bash
# Turn an app folder into a test channel that Home Assistant can install from a
# branch (repository URL https://github.com/OWNER/REPO#BRANCH).
# Usage: make-channel.sh SRC_APP_DIR OUT_DIR NAME VERSION [IMAGE]
#   OUT_DIR gets repository.yaml and a copy of the app folder with NAME and
#   VERSION set. With IMAGE, Supervisor pulls that image; without it,
#   Supervisor builds the app from its Dockerfile on the device.
# SRC_APP_DIR may come from a fork: it is only copied and edited, never run.
set -euo pipefail

src=$1 out=$2 name=$3 version=$4 image=${5:-}
app=$(basename "$src")

if [ -n "$(find "$src" ! -type f ! -type d)" ]; then
    echo "::error::$src contains symlinks or special files, refusing to publish it"
    exit 1
fi

mkdir -p "$out"
cp -r "$src" "$out/$app"
config="$out/$app/config.yaml"
NAME=$name VERSION=$version yq -i '.name = strenv(NAME) | .version = strenv(VERSION)' "$config"
if [ -n "$image" ]; then
    IMAGE=$image yq -i '.image = strenv(IMAGE)' "$config"
else
    yq -i 'del(.image)' "$config"
fi

NAME=$name URL="https://github.com/${GITHUB_REPOSITORY:-LukasGrebe/ha-addons}" \
    MAINTAINER=$(yq -r .maintainer repository.yaml) yq -n '.name = strenv(NAME) | .url = strenv(URL) | .maintainer = strenv(MAINTAINER)' > "$out/repository.yaml"

# the app's README is its page in the app store
readme="$out/$app/README.md"
{
    printf '> **%s %s is a test version, not a release.** Stop your regular eBUSd before\n' "$name" "$version"
    printf '> starting it: an adapter can only be used by one app at a time.\n\n'
    cat "$readme"
} > "$readme.new"
mv "$readme.new" "$readme"
