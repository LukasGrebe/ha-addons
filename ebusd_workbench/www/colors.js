// Colours shared by the timeline and the definitions tab: a value (what a telegram carried) and a
// message (circuit and name of a definition) always get the same colour everywhere.
import { fmt } from "./app.js";

export function hashHue(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) { hash ^= str.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0) % 360;
}

export function hashColor(str, sat = 55, light = 82) {
  return `hsl(${hashHue(str)} ${sat}% ${light}%)`;
}

/** Fill and border colour of a value as drawn in the timeline. */
export function valueColors(value, status = "ok") {
  if (status && status !== "ok") return { fill: "rgba(198,40,40,.22)", stroke: "#c62828" };
  return { fill: hashColor(value, 55, 82), stroke: hashColor(value, 45, 50) };
}

/** Text and background colour of a message name (circuit + name). */
export function messageColors(circuit, name) {
  const key = `${circuit}/${name}`;
  return { text: hashColor(key, 60, 34), background: hashColor(key, 60, 92), border: hashColor(key, 55, 70) };
}

/** Message ID length (data bytes after PBSB) of a telegram according to the settings. */
export function idLength(zz, pb, sb, settings) {
  const overrides = settings?.id_overrides || {};
  const specific = fmt.hex(zz) + fmt.hex(pb) + fmt.hex(sb);
  if (specific in overrides) return overrides[specific];
  const command = fmt.hex(pb) + fmt.hex(sb);
  if (command in overrides) return overrides[command];
  return settings?.id_bytes ?? 1;
}

const ruleIndexes = new WeakMap();

/** The prefix rules of the settings by command, longest prefix first: {"zzpbsb:prefix": length} -> Map(zzpbsb -> [{prefix, length}]). */
function ruleIndex(rules) {
  let index = ruleIndexes.get(rules);
  if (!index) {
    index = new Map();
    for (const [key, length] of Object.entries(rules)) {
      const [command, prefix = ""] = key.split(":");
      if (!index.has(command)) index.set(command, []);
      index.get(command).push({ prefix, length });
    }
    for (const list of index.values()) list.sort((a, b) => b.prefix.length - a.prefix.length);
    ruleIndexes.set(rules, index);
  }
  return index;
}

/**
 * Message ID length (data bytes) of a telegram: the longest matching prefix rule (what splitting or
 * combining a row stores), else the command's length, else the default.
 */
export function idLengthOf(master, settings) {
  const zz = parseInt(master.slice(2, 4), 16), pb = parseInt(master.slice(4, 6), 16), sb = parseInt(master.slice(6, 8), 16);
  const rules = settings?.id_rules;
  if (rules) {
    const list = ruleIndex(rules).get(master.slice(2, 8));
    if (list) {
      const data = master.slice(10);
      for (const rule of list) if (data.startsWith(rule.prefix)) return rule.length;
    }
  }
  return idLength(zz, pb, sb, settings);
}

/** The value string of a telegram as the timeline groups it: payload/slave answer/status. */
export function telegramValue(master, slave, status, settings) {
  const len = idLengthOf(master, settings);
  const payload = master.slice(10 + len * 2);
  return `${payload}/${slave ? slave.slice(2) : ""}/${status || "ok"}`;
}

/** Row key of a telegram in the timeline: QQ ZZ PB SB + message ID. */
export function telegramRowKey(master, settings) {
  const len = idLengthOf(master, settings);
  return master.slice(0, 8) + master.slice(10, 10 + len * 2);
}
