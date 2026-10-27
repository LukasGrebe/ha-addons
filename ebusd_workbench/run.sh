#!/usr/bin/with-contenv bashio
# shellcheck shell=bash

bashio::log.info "eBUSd Workbench version $(bashio::app.version)"

export WORKBENCH_DB
export WORKBENCH_DEPLOY_PATH
export WORKBENCH_REPO_DIR=/config/repo
export WORKBENCH_DATA_DIR=/data
export WORKBENCH_WWW=/opt/workbench/www

WORKBENCH_DB=$(bashio::config 'database')
WORKBENCH_DEPLOY_PATH=$(bashio::config 'deploy_path')
if bashio::config.has_value 'repo_url'; then
    export WORKBENCH_REPO_URL
    WORKBENCH_REPO_URL=$(bashio::config 'repo_url')
fi

case "$WORKBENCH_DB" in
    /share/*|/config/*) ;;
    *) bashio::log.warning "database=$WORKBENCH_DB is outside /share/ and /config/ — the eBUSd app cannot write there and the file is lost when the container is recreated." ;;
esac
if [ ! -f "$WORKBENCH_DB" ]; then
    bashio::log.notice "No telegram database at $WORKBENCH_DB yet — set 'sqlite_db: $WORKBENCH_DB' in the eBUSd app to record the bus."
fi

# ---------------------------------------------------------------------------
# git identity and credentials (used for commit, pull and push of the
# definitions repository). The token never ends up in the repository: git asks
# /git-askpass.sh for it on every HTTPS request.
# ---------------------------------------------------------------------------
if bashio::config.has_value 'git_user_name'; then
    export GIT_AUTHOR_NAME GIT_COMMITTER_NAME
    GIT_AUTHOR_NAME=$(bashio::config 'git_user_name')
    GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME
fi
if bashio::config.has_value 'git_user_email'; then
    export GIT_AUTHOR_EMAIL GIT_COMMITTER_EMAIL
    GIT_AUTHOR_EMAIL=$(bashio::config 'git_user_email')
    GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
fi
if bashio::config.has_value 'git_token'; then
    export GIT_TOKEN
    GIT_TOKEN=$(bashio::config 'git_token')
fi
export GIT_ASKPASS=/git-askpass.sh
export GIT_TERMINAL_PROMPT=0
# the repository folder is owned by whoever created it; git refuses to touch it otherwise
git config --global --add safe.directory '*'

mkdir -p "$WORKBENCH_REPO_DIR" "$(dirname "$WORKBENCH_DB")"

bashio::log.info "database: $WORKBENCH_DB, repository: $WORKBENCH_REPO_DIR, deploy path: $WORKBENCH_DEPLOY_PATH"
cd /opt/workbench || exit 1
exec python3 -m workbench --port 8099
