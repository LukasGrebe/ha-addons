<!-- https://developers.home-assistant.io/docs/add-ons/presentation#keeping-a-changelog -->

## Next release

- IMPROVE: Automatically configure MQTT
- IMPROVE: Add MQTT log configuration option

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
