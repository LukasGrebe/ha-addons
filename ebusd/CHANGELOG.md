# Changelog

# 24.1.1
## Home Assistant Add-on

### Improvements
* Fix semantic versioning: ebusd version is mirrored; Add-on specific iterations are denoted by the patch number. 

### Bug Fixes
* Bump Home Assistant base image version from 2.18 to 3.21

# 24.1 (2024-10-27)
## [ebusd](https://github.com/john30/ebusd/blob/master/ChangeLog.md)
### Bug Fixes
* fix conditional messages not being sent to message definition in MQTT integration and not being used in KNX group association
* fix CSV dump of config files on command line
* fix DTM type with recent dates
* fix for some updated messages not appearing on KNX or MQTT
* fix for parsing certain condition ranges
* fix for "reload" command not starting the scan again
* fix datetime type mapping in MQTT

### Features
* add "inject" command
* add config path to verbose "info" command
* add "answer" command
* add option to inject start-up commands
* add verbose raw data option to "read" and "write" commands
* add option to allow write direction in "read" command when inline defining a new message
* add option to discover device via mDNS
* add dedicated log level for device messages
* add option to extend MQTT variables from env/cmdline
* add date+datetime mapping, better device update check, and remove single-field-message field names in Home Assistant MQTT discovery integration

### Breaking Changes
* change default config path to https://ebus.github.io/ serving files generated from new TypeSpec message definition sources
* change validation of identifiers to no longer accept unusual characters
* change default device connection to be resolved automatically via mDNS


# next (tbd)
## Home Assistant Add-on

### Features
* Add Home Assistant Ingress (Web UI) [#147](https://github.com/LukasGrebe/ha-addons/issues/147)
* Colorize Logo to identify Add-on as running in Home Assistant [#81](https://github.com/LukasGrebe/ha-addons/issues/81)
* Easier custom MQTT device configuration [#162](https://github.com/LukasGrebe/ha-addons/issues/162)
* Include configuration files with Add-on Backups by following [HA Changes](https://developers.home-assistant.io/blog/2023/11/06/public-addon-config/) [#160](https://github.com/LukasGrebe/ha-addons/issues/160)

### Improvements
* Drastically reduce Settings UI [#85](https://github.com/LukasGrebe/ha-addons/issues/85)
* Increase security classification by creating an apparmor profile [#83](https://github.com/LukasGrebe/ha-addons/issues/83)
* Update documentation [#146](https://github.com/LukasGrebe/ha-addons/issues/146)

## [ebusd](https://github.com/john30/ebusd/blob/master/ChangeLog.md)
### Bug Fixes
* fix for device string symlink with colon
* fix "read" and "write" command response
* fix dump of divisor
* fix max value for S3N, S3N, SLG, and SLR types
* fix socket options for KNXnet/IP integration

### Features
* add "-m" option to "encode" and "decode" commands
* add output for commands executed with "--inject=stop"

# Older Releases

## 23.2.6

- Update HEALTHCHECK in Dockerfile to not use DNS [#126](https://github.com/LukasGrebe/ha-addons/issues/126) thanks @StCyr

## 23.2.5

- Revert required mode [#116](https://github.com/LukasGrebe/ha-addons/issues/116) thanks @tjorim

## 23.2.4

- added the option to store rotated logs in /config through s6-log [#102](https://github.com/LukasGrebe/ha-addons/issues/102) thanks @pvyleta

## 23.2.3

- fix Healthcheck. This should solve [#61](https://github.com/LukasGrebe/ha-addons/issues/61) thanks @cociweb

## 23.2.0

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
- IMPROVE: Align umber with eBUSd ## 0.87

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
