# Home Assistant Add-on: Example add-on

This is to run [ebusd](http://ebusd.eu) as supervisor addon (docker container) in Home Assistant OS.

## How to run ebusd

Deep dive into the [ebusd Wiki](https://github.com/john30/ebusd/wiki).
The steps **Build and Install are handled by this addon**. You'll need to **configure the options in this addon to run** ebusd.

1. Connect a [hardware interface](https://github.com/john30/ebusd/wiki/6.-Hardware) to your raspberryPi runing Home Assistant OS. (_maybe also other settups running supervisor_)
2. Configure [Comandline Options](https://github.com/john30/ebusd/wiki/2.-Run) in the Addon Settings
3. Start the Add-on and check the output logs

## How to get data into Home Assistant

There are propably multiple ways using the different [ebusd clients](https://github.com/john30/ebusd/wiki/3.-Clients-and-commands).
see also: [the official Mosquitto Broker](https://github.com/home-assistant/addons/blob/master/mosquitto/DOCS.md) as MQTT middleware
