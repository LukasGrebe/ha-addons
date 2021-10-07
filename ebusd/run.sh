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
	optVal=$(bashio::config ${optName})
    if [ -n "$optVal" ]; then
        ebusd_args+=("--${optName}=${optVal}")
    fi
done

if bashio::config.false "foreground"; then
    bashio::config.suggest.true "foreground" "Addon will stop if ebusd is not running in the foreground."
fi

if [ ! bashio::config.equals "loglevel" "error" ]; then
    bashio::config.suggest "loglevel" "Consider reducing the loglevel to 'error' to save disk space."
fi

echo "> ebusd ${ebusd_args[*]}"

ebusd ${ebusd_args[*]}