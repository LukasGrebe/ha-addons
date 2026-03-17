#!/usr/bin/with-contenv bashio

declare -a ebusd_args

ebusd_args+=(
    "--foreground"
    "--updatecheck=off"
    "--mqtthost=$(bashio::services mqtt 'host')"
    "--mqttport=$(bashio::services mqtt 'port')"
    "--mqttuser=$(bashio::services mqtt 'username')"
    "--mqttpass=$(bashio::services mqtt 'password')"
    "--mqttjson"
    "--mqttint=/config/mqtt-hassio.cfg"
)

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

if bashio::config.has_value "commandline_options"; then
    ebusd_args+=("$(bashio::config 'commandline_options')")
fi

if [ ! -f /config/mqtt-hassio.cfg ]; then
    bashio::log.info "Seeding default mqtt-hassio.cfg into addon config folder."
    cp /etc/ebusd/mqtt-hassio.cfg /config/mqtt-hassio.cfg
fi

ttyd --port 7681 --writable bash &

bashio::log.info "ebusd $(printf '%s ' "${ebusd_args[@]}" | sed 's/--mqttuser=[^ ]*/--mqttuser=<redacted>/g; s/--mqttpass=[^ ]*/--mqttpass=<redacted>/g')"
exec ebusd "${ebusd_args[@]}"
