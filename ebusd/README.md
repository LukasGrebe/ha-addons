# Home Assistant Add-on: ebusd

This add-on creates a supervisor add-on to run [ebusd](http://ebusd.eu). Configure ebusd comandline arguments using configuration options.

Use ebusd's built-in MQTT client and the [mosquitto](https://github.com/home-assistant/addons/tree/master/mosquitto) add-on to get data from ebusd into Home Assistant core.

See [repository readme](https://github.com/LukasGrebe/ha-addons#how-to-install) on how to install ebusd addon in supervisor.

See [docs](https://github.com/LukasGrebe/ha-addons/blob/main/ebusd/DOCS.md#how-to-run-ebusd) on how to run ebusd in supervisor.

## Support

**Issues in Configuration and Usage**
Many issues result from incomplete [ebusd configuration](https://github.com/john30/ebusd/wiki/4.-Configuration) files. This project only runs ebusd, configurationfiles are **not** managed by this project. Please see the offical [ebusd project](https://ebusd.eu) and [community](https://github.com/john30/ebusd/discussions) for more information. 

**If you have questions or feedback on running ebusd via supervisor**
- use [Issues](https://github.com/LukasGrebe/ha-addons/issues) and [pull requests](https://github.com/LukasGrebe/ha-addons/pulls) in the Github repository
- alternativly - but not checked as often - the [Home Assistant Forums Topic](https://community.home-assistant.io/t/an-ebusd-add-on/344852)

## Versioning Scheme

This add-on is versioned in a way that [mirrors the `ebusd` version](https://github.com/john30/ebusd/releases).
Addon specific iterations are denoted by the patch number.

- **<ebusd Major>.<ebusd Minor>.<Addon-specific Iteration> **: Mirrors the [corresponding `ebusd` version](https://github.com/john30/ebusd/releases). while the `Addon-specific Iteration` denote add-on-specific iterations.

**Example**: `24.1.1`
