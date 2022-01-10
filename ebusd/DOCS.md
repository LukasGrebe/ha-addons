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

## Custom CSV files:

To use custom CSV config files you can use the configpath option. You can create a local copy of https://github.com/john30/ebusd-configuration in your "/config" folder and change configpath to e.g. "/config/ebusd-configuration/latest/en".  Custom CSV files must be in the /config folder.

## HTTP and TCP client Access

To use HTTP and TCP clients enter port numbers into the add-on network settings and activated in the config.

## Custom command line options

You can add any command line options using the custom command line options field.  Check the eBUSd wiki for all available options - https://github.com/john30/ebusd/wiki/2.-Run

For example ``` --initsend --dumpconfig```

## BETA - Wireless eBUSd adapter support

This release includes beta support for wireless eBUSd adapters.  This is just a proof of concept at this stage and will be improved in the next release.  To test wireless support enter the IP address into the custom device box. You must select a usb device to validate the config but it will be ignored at runtime

For example ```enh:192.168.0.7:9999```

