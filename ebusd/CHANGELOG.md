<!-- https://developers.home-assistant.io/docs/add-ons/presentation#keeping-a-changelog -->
## version: 23.2.3

- fix Healthcheck. This should solve [#61](https://github.com/LukasGrebe/ha-addons/issues/61) thanks @cociweb

## version: 23.2.0

- Change build process to use pre-build containers. This should speed up the install of the addon as the addon does not need to be compiled from Supervisor before beeing run.
- EBUSd 23.2

## 23.1

- EBUSd 23.1

## 22.4.2

- updated documentation to cover custom MQTT config files.

## 22.4.1

- Add raw logging options
- Add write permission to config folder

## 22.4

- EBUSd 22.4

## 22.3.2

- Upgrade to Alpine 3.16

## 22.3.1

- Remove apparmour.txt
- Add build.yaml

## 22.3

- New eBUSd release

## 22.2

- New eBUSd release

## 22.1

**BREAKING CHANGE - MQTT JSON and MQTT Discovery will be enabled after upgrade.  This will break existing MQTT sensors**

- IMPROVE: Enable SSL
- IMPROVE: Include MQTT integration cfg files (/etc/ebusd/mqtt-hassio.cfg)
- IMPROVE: Add mqttint option
- IMPROVE: Add mqtttopic option
- IMPROVE: Add mqttvar option
- IMPROVE: Enable MQTT discovery by default
- IMPROVE: Align version number with eBUSd version

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
