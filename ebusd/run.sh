#!/usr/bin/with-contenv bashio

bashio::log.info "eBUSd addon version $(bashio::addon.version)"

declare -a ebusd_args

ebusd_args+=(
    "--foreground"
    "--updatecheck=off"
)

if bashio::services.available 'mqtt'; then
    ebusd_args+=(
        "--mqtthost=$(bashio::services mqtt 'host')"
        "--mqttport=$(bashio::services mqtt 'port')"
        "--mqttuser=$(bashio::services mqtt 'username')"
        "--mqttpass=$(bashio::services mqtt 'password')"
        "--mqttjson"
        "--mqttint=/config/mqtt-hassio.cfg"
    )
else
    bashio::log.warning "MQTT service not available via Supervisor. MQTT integration disabled. Pass --mqtt* flags manually via commandline_options if using an external broker."
fi

if bashio::config.has_value "network_device"; then
    if bashio::config.has_value "device"; then
        bashio::log.warning "Both 'device' and 'network_device' are set — using network_device."
    fi
    ebusd_args+=("--device=$(bashio::config 'network_device')")
elif bashio::config.has_value "device"; then
    ebusd_args+=("--device=$(bashio::config 'device')")
else
    bashio::log.info "No device configured — ebusd will attempt mDNS auto-discovery."
fi

if [ ! -f /config/mqtt-hassio.cfg ]; then
    bashio::log.info "Seeding default mqtt-hassio.cfg into addon config folder."
    cp /etc/ebusd/mqtt-hassio.cfg /config/mqtt-hassio.cfg
fi

ttyd --port 7681 --writable bash >/dev/null 2>&1 &

# ---------------------------------------------------------------------------
# Deprecated config field detection — old (<=25.1) keys in options.json
# ---------------------------------------------------------------------------
_deprecated_keys=(mode scanconfig readonly http pollinterval latency configpath
    accesslevel mqtttopic mqttint mqttvar mqttlog mqttretain mqtthost mqttport
    mqttuser mqttpass lograwdata lograwdatafile lograwdatasize
    loglevel_all loglevel_main loglevel_bus loglevel_update loglevel_network loglevel_other)
_found=()
for _k in "${_deprecated_keys[@]}"; do
    if jq -e --arg k "$_k" 'has($k)' /data/options.json >/dev/null 2>&1; then
        _found+=("$_k")
    fi
done
if [ ${#_found[@]} -gt 0 ]; then
    bashio::log.warning "================================================"
    bashio::log.warning " DEPRECATED CONFIG FIELDS DETECTED: ${_found[*]}"
    bashio::log.warning " These fields are from the old (<=25.1) schema"
    bashio::log.warning " and are NO LONGER APPLIED by this addon version."
    bashio::log.warning " Move them into the commandline_options list."
    bashio::log.warning " See: https://github.com/LukasGrebe/ha-addons/blob/main/ebusd/DOCS.md"
    bashio::log.warning "================================================"
fi

# ---------------------------------------------------------------------------
# commandline_options — now a list; warn and fall back if old string format
# ---------------------------------------------------------------------------
_opts_type=$(jq -r '.commandline_options | type' /data/options.json 2>/dev/null)

if [ "$_opts_type" = "string" ]; then
    bashio::log.warning "commandline_options is a plain string — please convert it to a list (one flag per entry). Using it as-is for now."
    exec ebusd "${ebusd_args[@]}" $(jq -r '.commandline_options' /data/options.json)
elif [ "$_opts_type" = "array" ]; then
    while IFS= read -r _opt; do
        [ -n "$_opt" ] && ebusd_args+=("$_opt")
    done < <(jq -r '.commandline_options[]?' /data/options.json)
    bashio::log.info "ebusd $(printf '%s ' "${ebusd_args[@]}" | sed 's/--mqttuser=[^ ]*/--mqttuser=<redacted>/g; s/--mqttpass=[^ ]*/--mqttpass=<redacted>/g')"
    exec ebusd "${ebusd_args[@]}"
else
    bashio::log.info "No commandline_options set — running with defaults only."
    bashio::log.info "ebusd $(printf '%s ' "${ebusd_args[@]}" | sed 's/--mqttuser=[^ ]*/--mqttuser=<redacted>/g; s/--mqttpass=[^ ]*/--mqttpass=<redacted>/g')"
    exec ebusd "${ebusd_args[@]}"
fi
