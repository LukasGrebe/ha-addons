// Home Assistant MQTT entities (climate, water heater) for the definitions chosen for this
// installation, as YAML to paste into configuration.yaml. ebusd's own MQTT integration config
// (mqtt-hassio.cfg) publishes every field as a sensor, number or select; the composite climate and
// water_heater entities have to be configured by hand, and this is that configuration.

const yamlQuote = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

/**
 * @param {Array} messages included messages: {circuit, name, write, passive, fields: [field names],
 *   role?: the upstream name when the message was renamed, fieldOf?: {upstream field: exported field}}
 *   Roles decide what a message is for (Z1RoomTemp …); names and fields are what ebusd publishes.
 * @param {object} options {deviceId, topic, controller}
 */
export function generateHaYaml(messages, options = {}) {
  const topic = options.topic || "ebusd";
  const roleOf = (m) => m.role || m.name;
  const readable = (circuit, role) => messages.find((m) => m.circuit === circuit && roleOf(m) === role && !m.write);
  const writable = (circuit, role) => messages.find((m) => m.circuit === circuit && roleOf(m) === role && m.write);
  const hasField = (m, name) => (m?.fieldOf ? name in m.fieldOf : !!m?.fields?.includes(name));
  const field = (m, preferred) => (m?.fieldOf?.[preferred]) || (m?.fields?.includes(preferred) ? preferred : m?.fields?.[0] || "value");
  const notes = [];
  const lines = [];
  const circuits = [...new Set(messages.map((m) => m.circuit))];
  const controller = options.controller || circuits.find((c) => messages.some((m) => m.circuit === c && /^Z\d(RoomTemp|DayTemp|OpMode)$/.test(roleOf(m))))
    || circuits.find((c) => messages.some((m) => m.circuit === c && /^Hwc(TempDesired|OpMode)$/.test(roleOf(m))));
  const deviceId = options.deviceId || `ebusd_${(controller || "heating").replace(/[^a-z0-9]/gi, "_")}`;
  const statusMessage = messages.find((m) => roleOf(m) === "RunDataStatuscode" && !m.write);
  const availability = [
    `      availability_topic: ${topic}/global/running`,
    `      payload_available: "true"`,
    `      payload_not_available: "false"`,
  ];
  const zones = [...new Set(messages.filter((m) => m.circuit === controller).map((m) => (roleOf(m).match(/^Z(\d)(RoomTemp|DayTemp|OpMode|NightTemp)$/) || [])[1]).filter(Boolean))].sort();
  if (!controller) notes.push("# no controller circuit with zone (Z1RoomTemp, Z1DayTemp, Z1OpMode) or hot water (HwcTempDesired, HwcOpMode) messages in the setup");

  lines.push("mqtt:");
  if (zones.length) {
    lines.push("  climate:");
    for (const zone of zones) {
      const room = readable(controller, `Z${zone}RoomTemp`), day = readable(controller, `Z${zone}DayTemp`), dayW = writable(controller, `Z${zone}DayTemp`);
      const mode = readable(controller, `Z${zone}OpMode`), modeW = writable(controller, `Z${zone}OpMode`), humidity = readable(controller, "RoomHumidity");
      lines.push(`    - name: ${yamlQuote(`Heizkreis Zone ${zone}`)}`, `      unique_id: ${deviceId}_climate_z${zone}`, `      device:`, `        identifiers: [${yamlQuote(deviceId)}]`, ...availability,
        `      temperature_unit: C`, `      precision: 0.5`, `      temp_step: 0.5`, `      min_temp: 5`, `      max_temp: 30`, `      modes: ["off", "auto", "heat"]`);
      if (room) lines.push(`      # Ist: Raumtemperatur am Regler (${controller} ${room.name})`, `      current_temperature_topic: ${topic}/${controller}/${room.name}`, `      current_temperature_template: "{{ value_json.${field(room, "value")}.value }}"`);
      else notes.push(`# zone ${zone}: no Z${zone}RoomTemp message in the setup, current_temperature omitted`);
      if (humidity) lines.push(`      current_humidity_topic: ${topic}/${controller}/${humidity.name}`, `      current_humidity_template: "{{ value_json.${field(humidity, "value")}.value }}"`);
      if (day) lines.push(`      # Soll: Raum-Solltemperatur Tag (${controller} ${day.name})`, `      temperature_state_topic: ${topic}/${controller}/${day.name}`, `      temperature_state_template: "{{ value_json.${field(day, "value")}.value }}"`);
      else notes.push(`# zone ${zone}: no Z${zone}DayTemp message in the setup, temperature_state omitted`);
      if (dayW) lines.push(`      temperature_command_topic: ${topic}/${controller}/${dayW.name}/set`);
      else if (day) notes.push(`# zone ${zone}: Z${zone}DayTemp is not writable in the setup (include the "w" definition), temperature_command omitted`);
      if (mode) {
        lines.push(`      # Betriebsart Zone ${zone}: off/auto/day/night → HA off/auto/heat (+ Preset "Absenkung" für night)`,
          `      mode_state_topic: ${topic}/${controller}/${mode.name}`, `      mode_state_template: >-`,
          `        {{ {'off':'off','auto':'auto','day':'heat','night':'heat'}.get(value_json.${field(mode, "value")}.value, 'auto') }}`);
        if (modeW) lines.push(`      mode_command_topic: ${topic}/${controller}/${modeW.name}/set`, `      mode_command_template: >-`, `        {{ {'off':'off','auto':'auto','heat':'day'}[value] }}`,
          `      preset_modes: ["Absenkung"]`, `      preset_mode_state_topic: ${topic}/${controller}/${mode.name}`, `      preset_mode_value_template: >-`,
          `        {{ 'Absenkung' if value_json.${field(mode, "value")}.value == 'night' else 'none' }}`,
          `      preset_mode_command_topic: ${topic}/${controller}/${modeW.name}/set`, `      preset_mode_command_template: >-`, `        {{ 'night' if value == 'Absenkung' else 'day' }}`);
        else notes.push(`# zone ${zone}: Z${zone}OpMode is not writable in the setup, mode_command omitted`);
      } else notes.push(`# zone ${zone}: no Z${zone}OpMode message in the setup, mode omitted`);
      if (statusMessage) lines.push(`      # Aktuelle Aktion aus dem Statuscode der Wärmepumpe (${statusMessage.circuit} ${statusMessage.name})`,
        `      action_topic: ${topic}/${statusMessage.circuit}/${statusMessage.name}`, `      action_template: >-`,
        `        {% set s = value_json.${field(statusMessage, "value")}.value | string %}`,
        `        {% if s in ['heat_compressor_active', 'heat_immersion_heater_active'] %}heating`,
        `        {% elif s == 'cool_compressor_active' %}cooling`,
        `        {% elif s in ['heat_prerun', 'cool_prerun'] %}preheating`,
        `        {% else %}idle{% endif %}`);
    }
  }
  const hwcDesired = controller && readable(controller, "HwcTempDesired"), hwcDesiredW = controller && writable(controller, "HwcTempDesired");
  const hwcMode = controller && readable(controller, "HwcOpMode"), hwcModeW = controller && writable(controller, "HwcOpMode");
  if (hwcDesired || hwcMode) {
    const storage = (controller && readable(controller, "HwcStorageTemp")) || messages.find((m) => !m.write && hasField(m, "hwcstoragetemp"))
      || messages.find((m) => !m.write && /^(HwcTemp|HwcStorageTemp|StorageTemp)$/.test(roleOf(m)));
    lines.push("", "  water_heater:", `    - name: "Warmwasser"`, `      unique_id: ${deviceId}_water_heater`, `      device:`, `        identifiers: [${yamlQuote(deviceId)}]`, ...availability,
      `      temperature_unit: C`, `      precision: 1.0`, `      min_temp: 35`, `      max_temp: 65`, `      modes: ["off", "eco", "heat_pump"]`);
    if (storage) lines.push(`      # Ist: Speichertemperatur (${storage.circuit} ${storage.name})`, `      current_temperature_topic: ${topic}/${storage.circuit}/${storage.name}`,
      `      current_temperature_template: "{{ value_json.${hasField(storage, "hwcstoragetemp") ? field(storage, "hwcstoragetemp") : field(storage, "value")}.value }}"`);
    else notes.push("# water heater: no storage temperature message (HwcStorageTemp or a message with field hwcstoragetemp) in the setup, current_temperature omitted");
    if (hwcDesired) lines.push(`      temperature_state_topic: ${topic}/${controller}/${hwcDesired.name}`, `      temperature_state_template: "{{ value_json.${field(hwcDesired, "value")}.value }}"`);
    if (hwcDesiredW) lines.push(`      temperature_command_topic: ${topic}/${controller}/${hwcDesiredW.name}/set`);
    else notes.push("# water heater: HwcTempDesired is not writable in the setup, temperature_command omitted");
    if (hwcMode) {
      lines.push(`      # Betriebsart Warmwasser: off/auto/day/night → HA off/eco(Zeitprogramm)/heat_pump(dauernd)`, `      mode_state_topic: ${topic}/${controller}/${hwcMode.name}`, `      mode_state_template: >-`,
        `        {{ {'off':'off','auto':'eco','day':'heat_pump','night':'off'}.get(value_json.${field(hwcMode, "value")}.value, 'eco') }}`);
      if (hwcModeW) lines.push(`      mode_command_topic: ${topic}/${controller}/${hwcModeW.name}/set`, `      mode_command_template: >-`, `        {{ {'off':'off','eco':'auto','heat_pump':'day'}[value] }}`);
      else notes.push("# water heater: HwcOpMode is not writable in the setup, mode_command omitted");
    }
  } else if (controller) notes.push("# no HwcTempDesired/HwcOpMode messages in the setup, water_heater omitted");
  return (notes.length ? notes.join("\n") + "\n\n" : "") + lines.join("\n") + "\n";
}

/** Suggested eBUSd app options so that MQTT discovery publishes the setup's messages. */
export function generateEbusdOptions(messages, deployDir) {
  const names = [...new Set(messages.map((m) => m.name))].sort();
  const writable = messages.some((m) => m.write);
  const lines = ["# eBUSd app → Additional ebusd options (one entry per line):", `--configpath=${deployDir}`];
  if (names.length) lines.push(`--mqttvar=filter-name=^(${names.join("|")})$`);
  if (writable) lines.push("--mqttvar=filter-direction=r|u|^w");
  lines.push("# filter-seen=1 would publish only messages seen on the bus; the names above are the setup's messages.");
  return lines.join("\n") + "\n";
}
