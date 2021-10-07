#!/usr/bin/with-contenv bashio

declare -a ebusd_args

#boolean options
declare options=( "readonly" "scanconfig" "foreground" "mqttjson" "mqttlog")
for optName in "${options[@]}"
do
    if bashio::config.true ${optName}; then
        ebusd_args+=("--$optName")
    fi
done

#other options
declare options=( "device" "port" "latency" "logareas" "loglevel" "mqtthost" "mqttport" "mqttuser" "mqttpass")
for optName in "${options[@]}"
do
    if ! bashio::config.is_empty ${optName}; then
        ebusd_args+=("--${optName}=$(bashio::config ${optName})")
    fi
done

if bashio::config.false "foreground" || bashio::config.is_empty "foreground"; then
    bashio::config.suggest.true "foreground" "ebusd add-on will stop if ebusd is not running in the foreground."
fi

if ! (bashio::config.equals "loglevel" "error" || bashio::config.is_empty "foreground"); then
    bashio::config.suggest "loglevel" "Consider setting the loglevel to 'error'."
fi

echo "> ebusd ${ebusd_args[*]}"

ebusd ${ebusd_args[*]}