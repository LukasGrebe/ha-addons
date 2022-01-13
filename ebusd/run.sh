#!/usr/bin/with-contenv bashio

declare -a ebusd_args

ebusd_args+=("--foreground")

#boolean options
declare options=( "readonly" "scanconfig" "mqttjson" "mqttlog" "mqttretain")
for optName in "${options[@]}"
do
    if bashio::config.true ${optName}; then
        ebusd_args+=("--$optName")
    fi
done

#string options
declare options=( "configpath" "port" "latency" "mqtthost" "mqttport" "mqttuser" "mqttpass" "accesslevel")

for optName in "${options[@]}"
do
    if ! bashio::config.is_empty ${optName}; then
        ebusd_args+=("--${optName}=$(bashio::config ${optName})")
    fi
done

#device
if bashio::config.has_value "device" && bashio::config.has_value "network_device"; then
    bashio::log.warning "USB and network device defined.  Only one device can be used at a time."
    bashio::log.warning "Ignoring USB device..."
    ebusd_args+=("--device=$(bashio::config network_device)")
elif bashio::config.has_value "device"; then
    ebusd_args+=("--device=$(bashio::config device)")
elif bashio::config.has_value "network_device"; then
    ebusd_args+=("--device=$(bashio::config network_device)")
else
    bashio::log.fatal "No network or USB device defined. Configure a device and restart addon"
    # stop addon, ebusd will not run without defining a device
    bashio::addon.stop
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

echo "> ebusd ${ebusd_args[*]}"

ebusd ${ebusd_args[*]}
