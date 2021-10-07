# Home Assistant Add-on: eBUSd

This is to run [ebusd](http://ebusd.eu) as supervisor addon (docker container) in Home Assistant OS.



## How to run ebusd

Deep dive into the [ebusd Wiki](https://github.com/john30/ebusd/wiki).
The steps **Build and Install are handled by this addon**. You'll need to **configure the options in this addon to run** ebusd.

1. Connect a [hardware interface](https://github.com/john30/ebusd/wiki/6.-Hardware) to your raspberryPi runing Home Assistant OS. (_maybe also other settups running supervisor_)
2. Configure [Comandline Options](https://github.com/john30/ebusd/wiki/2.-Run) in the Addon Settings
  <img width="400" alt="Bildschirmfoto 2021-10-07 um 21 54 37" src="https://user-images.githubusercontent.com/1786188/136459269-1976afc2-c572-47cd-84fd-cf002cbc48c5.png">

3. Start the Add-on and check the output logs
  <img width="512" alt="Bildschirmfoto 2021-10-07 um 21 54 10" src="https://user-images.githubusercontent.com/1786188/136459050-16ab7c10-0fe0-40ff-b20d-b6eb1730630d.png">


## How to get data into Home Assistant

There are propably multiple ways using the different [ebusd clients](https://github.com/john30/ebusd/wiki/3.-Clients-and-commands).
see also: [the official Mosquitto Broker](https://github.com/home-assistant/addons/blob/master/mosquitto/DOCS.md) as MQTT middleware
