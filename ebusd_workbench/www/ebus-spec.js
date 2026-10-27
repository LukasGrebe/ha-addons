// What the eBUS specification says about addresses and commands, for hints next to raw bytes.
//
// Source: "Anhang – Ausgabe 1 – zur eBUS Spezifikation Anwendungsschicht – OSI 7, V 1.6.1, 03.2007"
// (the appendix with the address assignment, manufacturer codes and primary command bytes) and
// "eBUS Specifications Application Layer – OSI 7, Version 1.6.1" (the standard services). Both are
// published by the eBUS Interest Group (www.ebus.de); the German terms are translated here.
// Manufacturer-specific commands (PB 0xB5 for Vaillant) are not in the specification: their meaning
// comes from ebusd's definitions, so only the few that matter for reading a bus are noted below.

/** The 25 master addresses: both nibbles are one of 0, 1, 3, 7, F. The slave address of a master is master + 5 (0xFF → 0x04). */
const MASTER_NIBBLES = new Set([0x0, 0x1, 0x3, 0x7, 0xf]);
export const isMaster = (addr) => MASTER_NIBBLES.has(addr >> 4) && MASTER_NIBBLES.has(addr & 0xf);
export const slaveOf = (master) => (isMaster(master) ? (master + 5) & 0xff : null);
export const masterOf = (slave) => { const m = (slave - 5) & 0xff; return isMaster(m) ? m : null; };
export const SYN = 0xaa;        // the synchronisation symbol, never an address
export const ESCAPE = 0xa9;     // the escape symbol, never an address
export const BROADCAST = 0xfe;

/**
 * The assignment of the master addresses (appendix, chapter 1): address -> {priority, number, role}.
 * The roles are the recommended device types; addresses without one are free for special configurations.
 */
export const MASTERS = {
  0x00: { priority: 0, number: 1, role: "PC / modem" },
  0x10: { priority: 0, number: 2, role: "heating controller" },
  0x30: { priority: 0, number: 3, role: "heating circuit controller 1" },
  0x70: { priority: 0, number: 4, role: "heating circuit controller 2" },
  0xf0: { priority: 0, number: 5, role: "heating circuit controller 3" },
  0x01: { priority: 1, number: 6, role: "hand-held programmer / remote control" },
  0x11: { priority: 1, number: 7, role: "bus interface / climate controller" },
  0x31: { priority: 1, number: 8, role: "bus interface" },
  0x71: { priority: 1, number: 9, role: "heating controller" },
  0xf1: { priority: 1, number: 10, role: "heating controller" },
  0x03: { priority: 2, number: 11, role: "burner control unit 1" },
  0x13: { priority: 2, number: 12, role: "burner control unit 2" },
  0x33: { priority: 2, number: 13, role: "burner control unit 3" },
  0x73: { priority: 2, number: 14, role: "burner control unit 4" },
  0xf3: { priority: 2, number: 15, role: "burner control unit 5" },
  0x07: { priority: 3, number: 16, role: "" },
  0x17: { priority: 3, number: 17, role: "heating controller" },
  0x37: { priority: 3, number: 18, role: "heating controller" },
  0x77: { priority: 3, number: 19, role: "heating controller" },
  0xf7: { priority: 3, number: 20, role: "heating controller" },
  0x0f: { priority: 4, number: 21, role: "clock / radio clock module" },
  0x1f: { priority: 4, number: 22, role: "burner control unit 6" },
  0x3f: { priority: 4, number: 23, role: "burner control unit 7" },
  0x7f: { priority: 4, number: 24, role: "burner control unit 8" },
  0xff: { priority: 4, number: 25, role: "PC" },
};
// "heating circuit controller": a controller of consumer circuits (heating circuit, mixer, set-point controllers);
// "heating controller": a controller of consumer circuits and/or heat generation (main, solar, cascade, system controllers).

/** Named slave addresses of the appendix (chapter 2); the slave of a master is "slave of <master>" instead. */
const SLAVE_RANGES = [
  [0x45, 0x4e, "remote setter"], [0x50, 0x59, "mixer"], [0x5a, 0x5b, "outside temperature sensor"], [0x5c, 0x63, "eBUS display"],
  [0x64, 0x6d, "pump"], [0x90, 0x9f, "room unit / remote setter"], [0xab, 0xb4, "meter"], [0xc0, 0xdf, "ventilation unit"],
];

/** Manufacturer codes (appendix, chapter 3), as they appear in the identification (07 04) answer and as primary command bytes. */
export const MANUFACTURERS = {
  0x06: "Karl Dungs", 0x0f: "FH Braunschweig/Wolfenbüttel", 0x10: "TEM", 0x11: "Lamberti Elektronik", 0x14: "CEB", 0x15: "Landis & Staefa",
  0x16: "FERRO Wärmetechnik", 0x17: "MONDIAL electronic", 0x18: "Wikon Kommunikationstechnik", 0x19: "Wolf", 0x20: "RAWE Electronic", 0x30: "Satronic",
  0x40: "ENCON Electronics", 0x50: "Kromschröder", 0x60: "Eberle Controls", 0x65: "EBV Elektronikbau", 0x75: "Grässlin", 0x85: "Motoren Ventilatoren Landshut",
  0x95: "SIG Berger Lahr", 0xa5: "Theben", 0xa7: "Thermowatt", 0xb5: "Vaillant", 0xc0: "Toby", 0xc5: "Weishaupt",
};

/** Primary command bytes (appendix, chapter 4): the communication path or the manufacturer a PB belongs to. */
export const PRIMARY = {
  0x03: "service data of burner control units (operating hours, start counts, fuel)",
  0x05: "burner control unit ↔ heating controller",
  0x07: "system data (date/time, outside temperature, identification, sign of life)",
  0x08: "controller ↔ controller",
  0x09: "memory server (RAM / EEPROM access)",
  0x0f: "test commands",
  0xfe: "broadcast (fax modem ↔ all other components)",
  0xff: "network management",
};
for (const [code, name] of Object.entries(MANUFACTURERS)) PRIMARY[code] ||= `manufacturer-specific: ${name}`;

/** The standard services (application layer, chapter 3): PB SB -> name. */
export const SERVICES = {
  "0304": "start counts", "0305": "operating time, level 1", "0306": "operating time, level 2", "0307": "operating time, level 3", "0308": "fuel quantity counter", "0310": "meter reading",
  "0500": "operational requirements between burner control unit and room controller", "0501": "operational data, room controller → burner control unit", "0502": "operational data, room controller → burner control unit",
  "0503": "operational data, burner control unit → room controller", "0504": "response to “control stop”", "0505": "barred", "0506": "operational data requirement, burner control unit → room controller",
  "0507": "operational data, room controller → burner control unit", "0508": "operational data requirement, room controller → burner control unit", "0509": "operational data, burner control unit → room controller (blocks 1–3)",
  "050a": "configuration data requirement, room controller → burner control unit", "050b": "configuration data, burner control unit → room controller", "050c": "operational requirements, burner control unit → room controller", "050d": "operational data, room controller → burner control unit",
  "0700": "date/time message of a master", "0701": "setting date/time", "0702": "setting the outside temperature", "0703": "query of supported commands", "0704": "identification (manufacturer, device id, software and hardware version)", "0705": "query of supported commands",
  "07fe": "inquiry of existence", "07ff": "sign of life",
  "0800": "target values of the room controller to other controllers", "0801": "operational data of the room controller to other controllers", "0802": "master controller → slave controller", "0803": "boiler parameters", "0804": "system remote control, controller → controller",
  "0900": "read RAM", "0901": "write RAM", "0902": "read EEPROM", "0903": "write EEPROM",
  "0f01": "start of test / ready", "0f02": "test message", "0f03": "end of test",
  "fe01": "error message (broadcast)",
  "ff00": "reset status (network management)", "ff01": "reset target configuration", "ff02": "failure message", "ff03": "interrogation of the net status", "ff04": "interrogation of monitored participants", "ff05": "interrogation of failed nodes", "ff06": "interrogation of required services",
};

/** Vaillant's commands as ebusd's definitions use them (not part of the specification). */
export const VAILLANT = {
  "b504": "operational data (set values from the controller)",
  "b505": "operational data",
  "b509": "register access: 0d read, 0e write, 29 read with index; 24–27 ebusd's scan of the serial number (vaillant/scan.csv)",
  "b510": "operational data from the controller to the heat generator",
  "b511": "status requests (Status01, Status02, …)",
  "b512": "operational data (set values)",
  "b516": "broadcasts of the controller (00 date/time, 01 outside temperature) and energy statistics (10…)",
  "b523": "error memory",
  "b524": "register access with 2-byte addresses (the VRC 7xx controllers)",
};

const hex = (n) => n.toString(16).padStart(2, "0");

/** What the specification says about one address: {kind: "master"|"slave"|"broadcast"|"symbol", role, partner}. */
export function addressInfo(addr) {
  if (typeof addr === "string") addr = parseInt(addr, 16);
  if (Number.isNaN(addr)) return null;
  if (addr === BROADCAST) return { kind: "broadcast", role: "broadcast to every participant", partner: null };
  if (addr === SYN || addr === ESCAPE) return { kind: "symbol", role: addr === SYN ? "synchronisation symbol, not an address" : "escape symbol, not an address", partner: null };
  if (isMaster(addr)) { const m = MASTERS[addr]; return { kind: "master", role: m?.role || "", priority: m?.priority, number: m?.number, partner: slaveOf(addr) }; }
  const master = masterOf(addr);
  if (master !== null) return { kind: "slave", role: `slave side of master ${hex(master)}${MASTERS[master]?.role ? ` (${MASTERS[master].role})` : ""}`, partner: master };
  const range = SLAVE_RANGES.find(([lo, hi]) => addr >= lo && addr <= hi);
  return { kind: "slave", role: range ? `${range[2]} ${addr - range[0] + 1}` : "", partner: null };
}

/**
 * A short name for an address on this bus: the device the scan identified (at the address or, for a
 * master, at its slave side), ebusd for its own address, else the specification's role.
 * @param devices zz (hex) -> {ident, manufacturer, sw, hw}, as the decoder's devices()
 */
export function addressName(addr, { devices = {}, own = "31" } = {}) {
  const a = typeof addr === "number" ? addr : parseInt(addr, 16);
  if (Number.isNaN(a)) return "";
  const h = hex(a);
  if (h === own.toLowerCase()) return "ebusd";
  const info = addressInfo(a);
  if (info.kind === "broadcast") return "broadcast";
  const dev = devices[h] || (info.kind === "master" && info.partner !== null ? devices[hex(info.partner)] : null);
  if (dev?.ident) return `${String(dev.ident).replace(/0{1,2}$/, "")}${dev.hw ? ` HW${dev.hw}` : ""}`;   // as the devices line names them (ebusd drops up to two trailing zeros)
  return info.role || (info.kind === "master" ? "master" : "slave");
}

/** The long form for a tooltip. */
export function describeAddress(addr, options = {}) {
  const a = typeof addr === "number" ? addr : parseInt(addr, 16);
  if (Number.isNaN(a)) return "";
  const info = addressInfo(a);
  const lines = [`${hex(a)}: ${addressName(a, options)}`];
  if (info.kind === "master") lines.push(`master ${info.number ?? "?"} of the specification (priority ${info.priority ?? "?"}), slave side ${hex(info.partner)}${info.role ? `; recommended use: ${info.role}` : ""}`);
  else if (info.kind === "slave") lines.push(info.partner !== null ? `slave address of master ${hex(info.partner)}` : info.role ? `specification: ${info.role}` : "a slave-only address");
  else lines.push(info.role);
  return lines.join("\n");
}

/** What the command bytes mean: {primary, service} with texts or null. */
export function commandInfo(pbsb) {
  const key = String(pbsb || "").toLowerCase();
  const pb = parseInt(key.slice(0, 2), 16);
  return { primary: PRIMARY[pb] || (pb >= 0x01 && pb <= 0x04 ? "reserved" : null), service: SERVICES[key] || VAILLANT[key] || null, manufacturer: MANUFACTURERS[pb] || null };
}

/** The tooltip of a PB SB. */
export function describeCommand(pbsb) {
  const { primary, service } = commandInfo(pbsb);
  const key = String(pbsb || "").toLowerCase();
  const lines = [`${key.slice(0, 2)} ${key.slice(2)}: primary and secondary command byte`];
  if (primary) lines.push(`PB ${key.slice(0, 2)}: ${primary}`);
  if (service) lines.push(`${key}: ${service}`);
  return lines.join("\n");
}

export const manufacturerName = (code) => MANUFACTURERS[typeof code === "number" ? code : parseInt(code, 16)] || null;
