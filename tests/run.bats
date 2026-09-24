#!/usr/bin/env bats
#
# Behavioural tests for ebusd/run.sh. Run from repo root with:
#   bats tests/run.bats
# or via `make test` / the "Test add-on" CI workflow.
#
# run.sh is never sourced directly — it always execs into the mock `ebusd`
# on PATH (tests/mocks/bin), so we invoke it as a subprocess and assert on
# stdout/stderr, exactly like the real Supervisor would observe it.

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
    RUN_SH="$REPO_ROOT/ebusd/run.sh"

    TEST_TMP="$(mktemp -d)"
    export OPTIONS_JSON_PATH="$TEST_TMP/options.json"
    export EBUSD_CONFIG_DIR="$TEST_TMP/config"
    export EBUSD_ETC_DIR="$TEST_TMP/etc-ebusd"
    mkdir -p "$EBUSD_CONFIG_DIR" "$EBUSD_ETC_DIR"
    echo "mock upstream mqtt-hassio.cfg" > "$EBUSD_ETC_DIR/mqtt-hassio.cfg"

    export PATH="$BATS_TEST_DIRNAME/mocks/bin:$PATH"
    unset MOCK_MQTT_AVAILABLE MOCK_MQTT_HOST MOCK_MQTT_PORT MOCK_MQTT_USERNAME MOCK_MQTT_PASSWORD

    source "$BATS_TEST_DIRNAME/mocks/bashio.sh"
}

teardown() {
    rm -rf "$TEST_TMP"
}

# Writes options.json with the given commandline_options array entries (one
# per argument) plus any extra top-level JSON fields merged in.
write_options() {
    local seed="$1"; shift
    local extra_json="$1"; shift
    local opts_json
    if [ "$#" -eq 0 ]; then
        opts_json='[]'
    else
        opts_json=$(printf '%s\n' "$@" | jq -R . | jq -s .)
    fi
    jq -n --argjson seed "$seed" --argjson opts "$opts_json" --argjson extra "$extra_json" \
        '{seed_mqtt_cfg: $seed, commandline_options: $opts} + $extra' \
        > "$OPTIONS_JSON_PATH"
}

# --- commandline_options validation -----------------------------------------

@test "warns on duplicate flags with the same name" {
    write_options true '{}' "--latency=0" "--latency=5"
    run bash "$RUN_SH"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Duplicate flag in commandline_options: '--latency' appears more than once."* ]]
}

@test "does not warn when flags differ" {
    write_options true '{}' "--latency=0" "--scanconfig"
    run bash "$RUN_SH"
    [ "$status" -eq 0 ]
    [[ "$output" != *"Duplicate flag"* ]]
}

@test "warns when one entry bundles multiple flags" {
    write_options true '{}' "--mqttjson --scanconfig"
    run bash "$RUN_SH"
    [ "$status" -eq 0 ]
    [[ "$output" == *"looks like multiple flags in one entry"* ]]
}

@test "flags deprecated top-level options.json keys" {
    write_options true '{"mqtttopic": "ebusd", "mode": "listen"}'
    run bash "$RUN_SH"
    [ "$status" -eq 0 ]
    [[ "$output" == *"DEPRECATED CONFIG FIELDS DETECTED"* ]]
    [[ "$output" == *"mqtttopic"* ]]
    [[ "$output" == *"mode"* ]]
}

@test "does not flag deprecated keys when none are present" {
    write_options true '{}'
    run bash "$RUN_SH"
    [ "$status" -eq 0 ]
    [[ "$output" != *"DEPRECATED CONFIG FIELDS DETECTED"* ]]
}

# --- MQTT credentials --------------------------------------------------------

@test "pulls MQTT credentials from Supervisor when the service is available" {
    export MOCK_MQTT_AVAILABLE=true
    export MOCK_MQTT_HOST=broker.local
    export MOCK_MQTT_PORT=1883
    export MOCK_MQTT_USERNAME=hauser
    export MOCK_MQTT_PASSWORD=hapass
    write_options true '{}'
    run bash "$RUN_SH"
    [ "$status" -eq 0 ]
    [[ "$output" == *"MOCK_EBUSD_ARGS:"*"--mqtthost=broker.local"*"--mqttport=1883"*"--mqttuser=hauser"*"--mqttpass=hapass"* ]]
}

@test "skips Supervisor MQTT credentials when --mqtthost is set manually" {
    export MOCK_MQTT_AVAILABLE=true
    write_options true '{}' "--mqtthost=192.168.1.50"
    run bash "$RUN_SH"
    [ "$status" -eq 0 ]
    [[ "$output" == *"skipping Supervisor MQTT credentials"* ]]
    [[ "$output" != *"--mqttuser="* ]]
}

@test "warns when MQTT service is unavailable and no --mqtthost is set" {
    export MOCK_MQTT_AVAILABLE=false
    write_options true '{}'
    run bash "$RUN_SH"
    [ "$status" -eq 0 ]
    [[ "$output" == *"MQTT service not available via Supervisor"* ]]
}

# --- seed_mqtt_cfg / --mqttint -----------------------------------------------

@test "seeds mqtt-hassio.cfg and adds --mqttint/--mqttjson on first start" {
    write_options true '{}'
    run bash "$RUN_SH"
    [ "$status" -eq 0 ]
    [ -f "$EBUSD_CONFIG_DIR/mqtt-hassio.cfg" ]
    [[ "$output" == *"--mqttint=$EBUSD_CONFIG_DIR/mqtt-hassio.cfg"* ]]
    [[ "$output" == *"--mqttjson"* ]]
}

@test "does not overwrite an existing mqtt-hassio.cfg" {
    echo "user customised" > "$EBUSD_CONFIG_DIR/mqtt-hassio.cfg"
    write_options true '{}'
    run bash "$RUN_SH"
    [ "$status" -eq 0 ]
    [ "$(cat "$EBUSD_CONFIG_DIR/mqtt-hassio.cfg")" = "user customised" ]
    [[ "$output" == *"set seed_mqtt_cfg: false"* ]]
}

@test "custom --mqttint skips seeding entirely" {
    write_options true '{}' "--mqttint=/share/my.cfg"
    run bash "$RUN_SH"
    [ "$status" -eq 0 ]
    [ ! -f "$EBUSD_CONFIG_DIR/mqtt-hassio.cfg" ]
    [[ "$output" == *"skipping auto mqtt-hassio.cfg seeding"* ]]
}

@test "seed_mqtt_cfg false skips seeding and does not add --mqttint" {
    write_options false '{}'
    run bash "$RUN_SH"
    [ "$status" -eq 0 ]
    [ ! -f "$EBUSD_CONFIG_DIR/mqtt-hassio.cfg" ]
    [[ "$output" == *"MOCK_EBUSD_ARGS: --foreground --updatecheck=off"* ]]
}

# --- device / network_device --------------------------------------------------

@test "uses --device when only 'device' is set" {
    write_options true '{"device": "/dev/ttyUSB0"}'
    run bash "$RUN_SH"
    [ "$status" -eq 0 ]
    [[ "$output" == *"--device=/dev/ttyUSB0"* ]]
}

@test "prefers network_device over device and warns when both are set" {
    write_options true '{"device": "/dev/ttyUSB0", "network_device": "enh:192.168.1.10:9999"}'
    run bash "$RUN_SH"
    [ "$status" -eq 0 ]
    [[ "$output" == *"--device=enh:192.168.1.10:9999"* ]]
    [[ "$output" == *"Both 'device' and 'network_device' are set"* ]]
}

@test "logs auto-discovery notice when neither device nor network_device is set" {
    write_options true '{}'
    run bash "$RUN_SH"
    [ "$status" -eq 0 ]
    [[ "$output" == *"ebusd will attempt mDNS auto-discovery"* ]]
    [[ "$output" != *"--device="* ]]
}

# --- commandline_options type handling ---------------------------------------

@test "handles commandline_options given as a plain string" {
    jq -n '{seed_mqtt_cfg: false, commandline_options: "--foreground --mqttjson"}' \
        > "$OPTIONS_JSON_PATH"
    run bash "$RUN_SH"
    [ "$status" -eq 0 ]
    [[ "$output" == *"please convert it to a list"* ]]
    [[ "$output" == *"MOCK_EBUSD_ARGS:"*"--mqttjson"* ]]
}

@test "runs with defaults only when commandline_options is absent" {
    jq -n '{seed_mqtt_cfg: false}' > "$OPTIONS_JSON_PATH"
    run bash "$RUN_SH"
    [ "$status" -eq 0 ]
    [[ "$output" == *"No commandline_options set — running with defaults only."* ]]
    [[ "$output" == *"MOCK_EBUSD_ARGS: --foreground --updatecheck=off"* ]]
}

@test "redacts MQTT credentials in the logged command line" {
    export MOCK_MQTT_AVAILABLE=true
    export MOCK_MQTT_USERNAME=hauser
    export MOCK_MQTT_PASSWORD=supersecret
    write_options true '{}'
    run bash "$RUN_SH"
    [ "$status" -eq 0 ]
    # The INFO log line must be redacted...
    [[ "$output" == *"INFO: ebusd "*"--mqttuser=<redacted>"*"--mqttpass=<redacted>"* ]]
    # ...even though the real secret is still passed to the ebusd process itself.
    [[ "$output" == *"MOCK_EBUSD_ARGS:"*"--mqttpass=supersecret"* ]]
}
