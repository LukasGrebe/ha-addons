#!/usr/bin/env bash
# Print the CHANGELOG.md section of VERSION (without its heading).
# Usage: changelog-section.sh APP_DIR VERSION
set -euo pipefail

awk -v heading="# $2" '
    index($0, heading " ") == 1 || $0 == heading { found = 1; next }
    found && /^# / { exit }
    found { print }
' "$1/CHANGELOG.md"
