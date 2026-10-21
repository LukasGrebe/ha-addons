#!/usr/bin/env bash
# Check that every option of the app's config.yaml schema has a name and a
# description in every translation file. Usage: tests/check_translations.sh [APP_DIR]
set -euo pipefail

app=${1:-ebusd}
options=$(yq -r '.schema | keys | .[]' "$app/config.yaml")
failed=0
for file in "$app"/translations/*.yaml; do
    for option in $options; do
        for field in name description; do
            if [ -z "$(yq -r ".configuration.\"$option\".$field // \"\"" "$file")" ]; then
                echo "::error file=$file::option '$option' has no $field"
                failed=1
            fi
        done
    done
done
exit $failed
