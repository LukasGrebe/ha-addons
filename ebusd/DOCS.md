# Home Assistant Add-on: eBUSd

This is to run [ebusd](http://ebusd.eu) as supervisor addon (docker container) in Home Assistant OS.

## How to run ebusd

Deep dive into the [ebusd Wiki](https://github.com/john30/ebusd/wiki).
The steps **Build and Install are handled by this addon**. You'll need to **configure the options in this addon to run** ebusd.

1. Connect a [hardware interface](https://github.com/john30/ebusd/wiki/6.-Hardware) to your device runing Home Assistant OS. USB and network devices are supported.
2. Define either a USB or network device.  Seperate configuration entries are available via the UI or can be configured manually using ```device: /dev/ttyAMA0``` or ```network_device: enh:192.158.0.7:9999```
3. MQTT will be configured automatically to use the Home Assitant MQTT Broker.  This can be overridden in the config options if you would prefer to use an external MQTT server.  TCP and HTTP client acces is also available.
4. Start the Add-on and check the output logs
  <img width="512" alt="Bildschirmfoto 2021-10-07 um 21 54 10" src="https://user-images.githubusercontent.com/1786188/136459050-16ab7c10-0fe0-40ff-b20d-b6eb1730630d.png">


## How to get data into Home Assistant

MQTT discovery is now automatically configured.  When you start the add-on the global readings (uptime, signal status etc.) will be added to Home Assistant automatically under a device named ebusd.  After around 5 minutes any readings that are being polled, either via an MQTT request or by editing your config files, will be added to Home Assistant automatically.  The device name will be ebusd {circuit} - e.g. "ebusd bai".

The mqttvar option can be used to inject MQTT variables or the [mqtt-hassio.cfg](https://github.com/john30/ebusd/blob/master/contrib/etc/ebusd/mqtt-hassio.cfg) can be edited and saved in your /config folder.

For more info please see the eBUSd docs:
 - [MQTT Integration](https://github.com/john30/ebusd/wiki/MQTT-integration)
 - [MQTT Discovery](https://github.com/john30/ebusd/discussions/518)

**Top tips:** 

- If you send an MQTT get message with payload "?1" eBUSd will automatically poll that reading every 30 seconds and publish via MQTT. For example: ```mosquitto_pub -t ebusd/bai/FlowTemp/get -m ?1```
- Git clone the ebusd-configuration files to your /config folder and edit the config files for your heating system.  Add a number 1-9 (1 high priority, 9 low prioirty) after the r at the start of each line and eBUSd will poll that reading automatically.
- Once your heating system has been detected change the device name from "ebusd bai" to the name of your boiler e.g. "ecoTEC pro"
- If some polled readings do not show up in Home Assistant it might be because mqtt-hassio.cfg is configured to filter them out.  Try setting to mqttvar to ```"filter-name="``` and this will remove any filters so you can debug the issue.

## Custom CSV or MQTT cfg files:

To use custom config files you can use the configpath option. You can create a local copy of https://github.com/john30/ebusd-configuration in your "/config" folder and change configpath to e.g. "/config/ebusd-configuration/latest/en".  Custom CSV files must be in the /config folder.

Similarly for MQTT create config file in "/config" folder and link it using the --mqttint=/config/YOUR_FILE_PATH option

## HTTP and TCP client Access

To use HTTP and TCP clients enter port numbers into the add-on network settings and activated in the config.
After TCP clients activation you can connect from any system with installed [ebusd clients](https://github.com/john30/ebusd/wiki/3.-Clients-and-commands).

The following example will force a reading of all messages from loaded csv config files and can be included via crontab for regular message updates:

```ebusctl -s X.X.X.X f -l "*" -a|awk '{print $2}' | xargs -L1 -t ebusctl -s X.X.X.X r```
Where ```X.X.X.X``` is the address of the ebusd add-on.


## Custom command line options

You can add any command line options using the custom command line options field.  Check the eBUSd wiki for all available options - https://github.com/john30/ebusd/wiki/2.-Run

For example ``` --initsend --dumpconfig```

## Network eBUS adapter support

This release now fully supports wireless/network [eBUS adapters](https://adapter.ebusd.eu/index.en.html). The configuration options has changed from custom_device to network_device.

For example ```network_device: enh:Y.Y.Y.Y:9999```
Where ```Y.Y.Y.Y``` is the address of the eBUS asapter.

