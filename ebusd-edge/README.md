# Home Assistant Add-on: eBUSd Edge

⚠️ This is the Edge version of the eBUSd add-on ⚠️

⚠️ This version pulls latest source from GitHub and builds locally ⚠️

⚠️ Most users should use stable version, edge is for those who want to test unreleased features or bug fixes ⚠️

⚠️ This version is bleeding edge and untested so may be broken ⚠️

This add-on creates a supervisor add-on to run [ebusd](http://ebusd.eu). Configure ebusd comandline arguments using configuration options.

Use ebusd's built-in MQTT client and the [mosquitto](https://github.com/home-assistant/addons/tree/master/mosquitto) add-on to get data from ebusd into Home Assistant core.

See [repository readme](https://github.com/LukasGrebe/ha-addons#how-to-install) on how to install ebusd addon in supervisor.

See [docs](https://github.com/LukasGrebe/ha-addons/blob/main/ebusd-edge/DOCS.md#how-to-run-ebusd) on how to run ebusd in supervisor.

**If you have questions or feedback please**
- via the [Home Assistant Forums Topic](https://community.home-assistant.io/t/an-ebusd-add-on/344852)
- via Issues and pull requests in the Github repository

### Updating the eBUSd Edge add-on:

**To update eBUSd binary to latest sources only:**

- Supervisor → Dashboard → eBUSd Edge → Rebuild

**To fully update the add-on follow the normal add-on update process**


*Not actually tested on any of these architectures*
![Supports aarch64 Architecture][aarch64-shield]
![Supports amd64 Architecture][amd64-shield]
![Supports armhf Architecture][armhf-shield]
![Supports armv7 Architecture][armv7-shield]
![Supports i386 Architecture][i386-shield]

[aarch64-shield]: https://img.shields.io/badge/aarch64-yes-green.svg
[amd64-shield]: https://img.shields.io/badge/amd64-yes-green.svg
[armhf-shield]: https://img.shields.io/badge/armhf-yes-green.svg
[armv7-shield]: https://img.shields.io/badge/armv7-yes-green.svg
[i386-shield]: https://img.shields.io/badge/i386-yes-green.svg
