#!/usr/bin/env bash
# Print the Markdown instructions for installing the test channel on BRANCH.
# Usage: repository-hint.sh BRANCH APP_NAME   (needs GITHUB_REPOSITORY)
set -euo pipefail

branch=$1 name=$2
url="https://github.com/${GITHUB_REPOSITORY}#${branch}"
encoded=$(jq -rn --arg url "$url" '$url | @uri')
# Supervisor names the app's folders after the sha1 of the repository URL
prefix=$(printf '%s' "${url,,}" | sha1sum | cut -c1-8)

cat <<EOF
[![Add repository to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=${encoded})

or add \`${url}\` as a repository in the app store (⋮ → Repositories), then install **${name}**.

- Stop your regular eBUSd first: an adapter can only be used by one app at a time.
- The test app is a separate app with its own configuration and config folder
  \`/addon_configs/${prefix}_ebusd\`. Copy \`mqtt-hassio.cfg\` or CSV files there if you use them.
- When done: uninstall the test app, start eBUSd again and remove the repository.
EOF
