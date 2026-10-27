# ha-addons
Addons for http://home-assistant.io

Created by @LukasGrebe.  Improved and maintained by @tim-devel

## How to Install
1. In Supervisor go to the Add-on Store,
2. In the overflow menu click "Repositories"
3. Add `https://github.com/LukasGrebe/ha-addons/`
4. Wait for the ebusd Add-on to show up or click reload in the same overflow menu
5. Install eBUSd.
6. Follow Documentation, Setup and Install of the Add-on

Want to try what's coming next? See [Testing upcoming versions](ebusd/DOCS.md#testing-upcoming-versions).
Contributions are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md).


## [ebusd](https://github.com/LukasGrebe/ha-addons/tree/main/ebusd) 

This Add-on runs [ebusd](http://ebusd.eu), a daemon for handling communication with eBUS devices connected to a 2-wire bus system (“energy bus” used by numerous heating systems), in [Home Assistant OS](https://www.home-assistant.io/installation/raspberrypi). You can simply plugin a ebus hardware interface into your RaspberryPi, and install the addon to run ebusd.

## [ebusd Workbench](https://github.com/LukasGrebe/ha-addons/tree/main/ebusd_workbench)

A companion app for working on eBUS message definitions: a timeline of the telegrams recorded by the eBUSd app next to Home Assistant entity changes, a git-backed editor for the TypeSpec sources, compiling to CSV and testing against the recorded telegrams in the browser, and deploying the result for ebusd. See its [documentation](ebusd_workbench/DOCS.md).


# Thanks ...

Thank you to

- https://github.com/m-reuter
- https://github.com/john30
- https://github.com/ludeeus
- Https://github.com/tim-devel

And thanks to you for your interest in this project! If it is of any use to you, you can buy me a coffee:
https://www.paypal.com/paypalme/lukasgrebe
