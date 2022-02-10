<!-- https://developers.home-assistant.io/docs/add-ons/presentation#keeping-a-changelog -->

## 21.3.2

- IMPROVE: Enable SSL

## 21.3.1

- IMPROVE: Include MQTT integration cfg files (/etc/ebusd/mqtt-hassio.cfg)
- IMPROVE: Add mqttint option
- IMPROVE: Add mqtttopic option
- IMPROVE: Add mqttvar option
- IMPROVE: Enable MQTT discovery by default
- IMPROVE: Align version number with eBUSd version
- IMPROVE: Improve eBUSd edge upgrade process

## 0.87

- IMPROVE: Add poll interval option
- IMPROVE: Improve option descriptions
- IMPROVE: Improve logic in run.sh
- IMPROVE: Add apparmour.txt
- FIX: Change MQTT log area to OTHER

## 0.86

- IMPROVE: Add option to manually configure MQTT

## 0.85

- IMPROVE: Automatically configure MQTT
- IMPROVE: Add MQTT log configuration option
- IMPROVE: Use precompiled eBUSd

## 0.84

- IMPROVE: Add Polish translation (@pepsonEL)
- IMPROVE: Improve configuration of network eBUSd adapters.

- BREAKING: Remove foreground option.  eBUSd will now run in foreground by default.
- BREAKING: Network device config has changed.  Custom_device has now changed to wireless_device


## 0.83

- BREAKING: Remove old style loglevel and logareas option
- BREAKING: Remove TCP port option.  Port will default to port 8888 internally.  External port can be configured in network options

- IMPROVE: Add access level config option
- IMPROVE: Enable custom config files (save in config folder)
- IMPROVE: Configure logger for individual areas
- IMPROVE: Add watchdog URL so Home Assistant can restart eBUSd if it crashes
- IMPROVE: Allow  access with HTTP and TCP client
- IMPROVE: Add MQTT retain option
- IMPROVE: Add custom commandline options

- BETA: Allow wireless ebusd adapter

## 0.82

- IMPROVE: Enable custom CSV files (save in /config folder)

## 0.81

- FIX: null values were not accepted for some options
- IMPROVE: better default values for options
- IMPROVE: better logo & icon

## 0.7

- Initial release
