# Home Assistant Add-on: eBUSd

This is to run [ebusd](http://ebusd.eu) as supervisor addon (docker container) in Home Assistant OS.



## How to run ebusd

Deep dive into the [ebusd Wiki](https://github.com/john30/ebusd/wiki).
The steps **Build and Install are handled by this addon**. You'll need to **configure the options in this addon to run** ebusd.

1. Connect a [hardware interface](https://github.com/john30/ebusd/wiki/6.-Hardware) to your device runing Home Assistant OS. USB and network devices are supported.
2. Define either a USB or network device.  Seperate configuration entries are available via the UI or can be configured manually using ```device: /dev/ttyAMA0``` or ```network_device: enh:192.158.0.7:9999```
3. It is recommended to configure MQTT but TCP and HTTP client acces is also available.
4. Start the Add-on and check the output logs
  <img width="512" alt="Bildschirmfoto 2021-10-07 um 21 54 10" src="https://user-images.githubusercontent.com/1786188/136459050-16ab7c10-0fe0-40ff-b20d-b6eb1730630d.png">


## How to get data into Home Assistant

You can communicate with eBUSd using either MQTT, TCP or HTTP clients.  To use TCP or HTTP clients you will need to configure external port numbers in the network config section.  For a list of clients and commands see the [eBUSd wiki](https://github.com/john30/ebusd/wiki/3.-Clients-and-commands).

**Top tip:** If you send an MQTT get message with payload "?1" eBUSd will automatically poll that reading every 30 seconds and publish via MQTT 

For example: ```mosquitto_pub -t ebusd/bai/FlowTemp/get -m ?1```

## Custom CSV files:

To use custom CSV config files you can use the configpath option. You can create a local copy of https://github.com/john30/ebusd-configuration in your "/config" folder and change configpath to e.g. "/config/ebusd-configuration/latest/en".  Custom CSV files must be in the /config folder.

## HTTP and TCP client Access

To use HTTP and TCP clients enter port numbers into the add-on network settings and activated in the config.

## Custom command line options

You can add any command line options using the custom command line options field.  Check the eBUSd wiki for all available options - https://github.com/john30/ebusd/wiki/2.-Run

For example ``` --initsend --dumpconfig```

## Network eBUSd adapter support

This release now fully supports wireless/network eBUSd adapters.  The configuration options has changed from custom_device to network_device.

For example ```network_device: enh:192.168.0.7:9999```

