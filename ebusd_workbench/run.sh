#!/usr/bin/with-contenv bashio
# shellcheck shell=bash

bashio::log.info "ebusd Config Workbench version $(bashio::app.version)"

export WORKBENCH_DB
export WORKBENCH_DEPLOY_PATH
export WORKBENCH_LANGUAGE
export WORKBENCH_DATA_DIR=/data
export WORKBENCH_WWW=/opt/workbench/www

WORKBENCH_DB=$(bashio::config 'database')
WORKBENCH_DEPLOY_PATH=$(bashio::config 'deploy_path')
WORKBENCH_LANGUAGE=$(bashio::config 'language')

case "$WORKBENCH_DB" in
    /share/*|/config/*) ;;
    *) bashio::log.warning "database=$WORKBENCH_DB is outside /share/ and /config/ — the eBUSd app cannot write there and the file is lost when the container is recreated." ;;
esac
if [ ! -f "$WORKBENCH_DB" ]; then
    bashio::log.notice "No telegram database at $WORKBENCH_DB yet — set 'sqlite_db: $WORKBENCH_DB' in the eBUSd app to record the bus."
fi

mkdir -p "$(dirname "$WORKBENCH_DB")"

bashio::log.info "database: $WORKBENCH_DB, deploy path: $WORKBENCH_DEPLOY_PATH, definitions language: $WORKBENCH_LANGUAGE"
cd /opt/workbench || exit 1
exec python3 -m workbench --port 8099
