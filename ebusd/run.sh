#!/usr/bin/with-contenv bashio

declare -a ebusd_args

#boolean options
declare options=( "readonly" "scanconfig" "foreground" "mqttjson" "mqttlog" "mqttretain")
for optName in "${options[@]}"
do
    if bashio::config.true ${optName}; then
        ebusd_args+=("--$optName")
    fi
done

#string options
declare options=( "port" "latency" "mqtthost" "mqttport" "mqttuser" "mqttpass" "accesslevel")
for optName in "${options[@]}"
do
    if ! bashio::config.is_empty ${optName}; then
        ebusd_args+=("--${optName}=$(bashio::config ${optName})")
    fi
done

#device
if ! bashio::config.is_empty custom_device; then
    ebusd_args+=("--device=$(bashio::config custom_device)")
else
    ebusd_args+=("--device=$(bashio::config device)")
fi


#logging
declare options=( "loglevel_all" "loglevel_main" "loglevel_bus" "loglevel_update" "loglevel_network")
for optName in "${options[@]}"
do
    if ! bashio::config.is_empty ${optName}; then
        ebusd_args+=("--log=$(echo $optName | sed 's/loglevel_//g'):$(bashio::config ${optName})")
    fi
done


#add additional options
if ! bashio::config.is_empty commandline_options; then
    ebusd_args+=("$(bashio::config commandline_options)")
fi

#activate http
if ! bashio::config.is_empty http; then
    ebusd_args+=" --httpport=8889"
fi


if bashio::config.false "foreground" || bashio::config.is_empty "foreground"; then
    bashio::config.suggest.true "foreground" "ebusd add-on will stop if ebusd is not running in the foreground."
fi

echo "> ebusd ${ebusd_args[*]}"

ebusd ${ebusd_args[*]}
