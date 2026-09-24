# Minimal stand-in for the bashio library (github.com/hassio-addons/bashio),
# which only exists inside a running Home Assistant Supervisor container.
# Sourced by tests before invoking run.sh; every function is exported with
# `export -f` so a child `bash run.sh` process can see it too.
#
# Behaviour driven by env vars the test sets:
#   OPTIONS_JSON_PATH        path to a fake options.json (required)
#   MOCK_MQTT_AVAILABLE      "true" to make bashio::services.available 'mqtt' succeed
#   MOCK_MQTT_HOST/PORT/USERNAME/PASSWORD  values returned by bashio::services mqtt <key>

bashio::log.info() {
    printf 'INFO: %s\n' "$*" >&2
}

bashio::log.warning() {
    printf 'WARNING: %s\n' "$*" >&2
}

bashio::addon.version() {
    printf 'test\n'
}

bashio::services.available() {
    [ "${MOCK_MQTT_AVAILABLE:-false}" = "true" ]
}

bashio::services() {
    # bashio::services mqtt <key>
    local key="$2"
    case "$key" in
        host) printf '%s' "${MOCK_MQTT_HOST:-mock-broker}" ;;
        port) printf '%s' "${MOCK_MQTT_PORT:-1883}" ;;
        username) printf '%s' "${MOCK_MQTT_USERNAME:-mock-user}" ;;
        password) printf '%s' "${MOCK_MQTT_PASSWORD:-mock-pass}" ;;
    esac
}

bashio::config.true() {
    local val
    val=$(jq -r --arg k "$1" '.[$k]' "$OPTIONS_JSON_PATH" 2>/dev/null)
    [ "$val" = "true" ]
}

bashio::config.has_value() {
    local val
    val=$(jq -r --arg k "$1" '.[$k] // empty' "$OPTIONS_JSON_PATH" 2>/dev/null)
    [ -n "$val" ]
}

bashio::config() {
    jq -r --arg k "$1" '.[$k] // empty' "$OPTIONS_JSON_PATH" 2>/dev/null
}

export -f bashio::log.info bashio::log.warning bashio::addon.version \
    bashio::services.available bashio::services \
    bashio::config.true bashio::config.has_value bashio::config
