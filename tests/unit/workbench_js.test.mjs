// Node tests of the Workbench's browser modules that need no browser: the setup model's CSV
// renaming, the Home Assistant YAML generator with renamed messages, the evidence address
// mapping and the line reconstruction of timeline runs. Run by test_workbench_js.py (node --test).
import test from "node:test";
import assert from "node:assert/strict";

// app.js touches the DOM on import; the modules under test only need these exports
globalThis.document = { getElementById: (id) => (id === "tabs" ? null : { appendChild() {}, replaceChildren() {} }), createElement: () => ({ style: {}, classList: { toggle() {} }, addEventListener() {}, setAttribute() {}, appendChild() {}, remove() {} }), createTextNode: (t) => t, querySelectorAll: () => [], addEventListener() {} };
globalThis.window = { workbench: null, addEventListener() {} };
globalThis.fetch = async () => ({ ok: true, text: async () => "{}" });
globalThis.location = { hash: "" };
globalThis.history = { replaceState() {} };
globalThis.setInterval = () => 0;

const { setup, splitCsv, joinCsv } = await import("../../ebusd_workbench/www/setup.js");
const { generateHaYaml, generateEbusdOptions } = await import("../../ebusd_workbench/www/hayaml.js");
const { frameMatches, parseAddressMap, runProfile } = await import("../../ebusd_workbench/www/evidence.js");
const { lineOfRun, defKeyOf } = await import("../../ebusd_workbench/www/decoder.js");
const { app } = await import("../../ebusd_workbench/www/app.js");
const { structuralSignature, rowTelegrams, coverage, groupCandidates, summarizeFields, whyNot } = await import("../../ebusd_workbench/www/compare.js");

const roomTemp = { key: "vaillant/15.700.csv|700|Z1RoomTemp|", circuit: "700", name: "Z1RoomTemp", write: false, passive: false, status: "active", source: "base", file: "vaillant/15.700.csv",
  fields: ["temp"], csv: "r,700,Z1RoomTemp,Room temperature,,15,b524,020000000700,temp,s,D2C,,°C,room temperature" };
const dayTempW = { key: "vaillant/15.700.csv|700|Z1DayTemp|w", circuit: "700", name: "Z1DayTemp", write: true, passive: false, status: "companion", source: "pr/660", file: "vaillant/15.700.csv",
  fields: ["temp"], csv: "w,700,Z1DayTemp,Day temperature,,15,b524,020100000700,temp,m,D2C,,°C,day temperature" };
const dayTemp = { ...dayTempW, key: "vaillant/15.700.csv|700|Z1DayTemp|", write: false, status: "active", source: "base", csv: dayTempW.csv.replace(/^w/, "r") };
const hidden = { key: "vaillant/15.700.csv|700|Other|", circuit: "700", name: "Other", write: false, passive: false, status: "hidden", source: "base", file: "vaillant/15.700.csv", fields: ["value"], csv: "r,700,Other,,,15,b524,0200000a0700,value,s,UCH,,," };
const entries = [roomTemp, dayTemp, dayTempW, hidden];

test("csv split and join keep quoted commas", () => {
  const line = 'r,c,n,"a, b",,,b509,01,value,s,UCH,"0=x, y;1=z",,';
  assert.deepEqual(splitCsv(line).slice(3, 4), ["a, b"]);
  assert.equal(joinCsv(splitCsv(line)), line);
});

test("setup: ebusd's choice until customized, then choose, include and rename", () => {
  app.settings = { setup: {} };
  setup.load();
  assert.equal(setup.customized, false);
  assert.deepEqual(setup.includedKeys(entries), [roomTemp.key, dayTemp.key]);
  // choosing a candidate for a row includes it and drops the row's other candidates
  setup.choose("10→15 b524 0200000a0700", hidden.key, [hidden.key, roomTemp.key], entries);
  assert.equal(setup.customized, true);
  assert.deepEqual(setup.includedKeys(entries).sort(), [hidden.key, dayTemp.key].sort());
  assert.equal(setup.chosenFor("10→15 b524 0200000a0700"), hidden.key);
  setup.include(roomTemp.key, true, entries);
  setup.include(dayTempW.key, true, entries);
  // renaming message, field and circuit flows into the CSV, upstream names stay in the data
  setup.rename(roomTemp, "Zone 1 Room Temperature");
  setup.renameField(roomTemp, "temp", "temperature");
  setup.renameCircuit("700", "heating");
  assert.equal(setup.exportName(roomTemp), "Zone_1_Room_Temperature");
  assert.deepEqual(setup.fieldMap(roomTemp), { temp: "temperature" });
  assert.equal(setup.csvOf(roomTemp), "r,heating,Zone_1_Room_Temperature,Room temperature,,15,b524,020000000700,temperature,s,D2C,,°C,room temperature");
  assert.equal(setup.csvOf(dayTemp), "r,heating,Z1DayTemp,Day temperature,,15,b524,020100000700,temp,m,D2C,,°C,day temperature");
  const { files } = setup.files(entries, [{ ref: "pr/660", head: { subject: "HMU HW5103" } }]);
  assert.deepEqual(Object.keys(files), ["heating.csv"]);
  assert.match(files["heating.csv"], /^# upstream name: 700 Z1RoomTemp \(fields temp→temperature\)\nr,heating,Zone_1_Room_Temperature/m);
  assert.match(files["heating.csv"], /# from layer pr\/660 \(HMU HW5103\)\nw,heating,Z1DayTemp/);
  assert.ok(!files["heating.csv"].includes("["), "conditions are removed");
});

test("home assistant yaml follows the renamed topics and fields but keeps the roles", () => {
  const messages = setup.haMessages(entries);
  const room = messages.find((m) => m.role === "Z1RoomTemp");
  assert.equal(room.name, "Zone_1_Room_Temperature");
  assert.deepEqual(room.fieldOf, { temp: "temperature" });
  const yaml = generateHaYaml(messages);
  assert.match(yaml, /current_temperature_topic: ebusd\/heating\/Zone_1_Room_Temperature\n\s+current_temperature_template: "\{\{ value_json.temperature.value \}\}"/);
  assert.match(yaml, /temperature_command_topic: ebusd\/heating\/Z1DayTemp\/set/);
  assert.match(yaml, /^# zone 1: no Z1OpMode message in the setup, mode omitted/m);
  const options = generateEbusdOptions(messages, "/share/ebusd/config");
  assert.match(options, /--mqttvar=filter-name=\^\(Other\|Z1DayTemp\|Zone_1_Room_Temperature\)\$/);
  assert.match(options, /filter-direction=r\|u\|\^w/);
});

test("evidence: profile addresses map to this installation", () => {
  assert.deepEqual(parseAddressMap(" F1=31, 08=18 bad f=1"), { f1: "31", "08": "18" });
  const frame = { source: "31", target: "08", pbsb: "b509", request: "05540200a80e", response: "0a0102030405060708090a", initiated_by_ebusd: true };
  const rule = { source: "f1", target: "08", pbsb: "b509", request: "05540200a80e" };
  assert.equal(frameMatches(frame, rule), false);
  assert.equal(frameMatches(frame, rule, { f1: "31" }), true);
  const telegrams = [{ master: "3108b50905540200a80e", slave: "0a0102030405060708090a", n: 3, first_ms: 1000, last_ms: 5000, status: "ok" }];
  const run = runProfile({ name: "p", version: 1, checks: [{ id: "c", match: rule, value: { from: "response", type: "float32le", offset: 5 } }] }, telegrams, "31", { f1: "31" });
  assert.equal(run.checks[0].occurrences, 3);
  assert.equal(run.checks[0].values.size, 1);
});

test("timeline runs map back to ebusd's hex notation", () => {
  const row = { qq: 0x10, zz: 0x08, pb: 0xb5, sb: 0x11, id: "01" };
  assert.equal(lineOfRun(row, { payload: "", slave: "38000000ff00000000", status: "ok" }), "1008b5110101/0938000000ff00000000");
  assert.equal(lineOfRun({ ...row, id: "0d2800" }, { payload: "", slave: "", status: "ok" }), "1008b511030d2800");
  assert.equal(lineOfRun({ ...row, zz: null }, { payload: "", slave: "", status: "ok" }), null);
  assert.equal(lineOfRun(row, { payload: "", slave: "", status: "timeout" }), null);
  assert.equal(defKeyOf({ file: "a.csv", circuit: "c", name: "n", write: true, passive: true }), "a.csv|c|n|wu");
});

// -- comparing candidates over the whole recording ---------------------------------------------------

const defOf = (circuit, name, file, status, csvFieldName = "temp", extra = {}) => ({ key: `${file}|${circuit}|${name}|`, circuit, name, file, status, write: false, passive: false, zz: "15", pbsb: "b524",
  csv: `r,${circuit},${name},comment ${name},,15,b524,020002000700,${csvFieldName},s,EXP,,°C,comment`, fields: [csvFieldName], source: "base", condition: "", conditions: [], ...extra });
const ok = (line, key, text, fields) => ({ id: `${line}|${key}`, line, defKey: key, result: "ok", text, fields, used: false });
const fake = (telegrams, decodes) => ({ telegrams: new Map(telegrams.map((t) => [t.line, t])), decodesOf: (line) => decodes[line] });

test("structural signature ignores names, comments and circuits but not types", () => {
  const a = "r,700,Hc1ActualFlowTempDesired,flow,,15,b524,020002000700,ign,s,IGN:4,,,,value,s,EXP,,°C,x";
  const b = "r,720,Hc1FlowTempDesired,other comment,,15,b524,020002000700,ign,s,IGN:4,,,,flow,s,EXP,,°C,y";
  const c = "r,720,Hc1FlowTempDesired,other,,15,b524,020002000700,ign,s,IGN:4,,,,value,s,D2C,,°C,y";
  assert.equal(structuralSignature(a), structuralSignature(b));
  assert.notEqual(structuralSignature(a), structuralSignature(c));
  assert.equal(structuralSignature(`[id_sw>=413]${a}`), structuralSignature(a), "conditions are not part of what a definition is");
});

test("candidates over the whole recording are grouped by structure and decoded values", () => {
  const lines = [["3115b52406060009010700", "0102070000000000", 100], ["3115b52406060009010700", "0102070000005041", 50], ["3115b52406060009010701", "0102070000000000", 10]];
  const telegrams = lines.map(([m, sl, n], i) => ({ line: `${m}/${sl}`, master: m, slave: sl, n, first_ms: 1000 * (i + 1), last_ms: 2000 * (i + 1) }));
  const other = { line: "3115b524030d2800/0000", master: "3115b524030d2800", slave: "0000", n: 5, first_ms: 1, last_ms: 2 };   // another row
  const d700 = defOf("700", "Hc1ActualFlowTempDesired", "vaillant/15.700.csv", "active");
  const d720 = defOf("720", "Hc1FlowTempDesired", "vaillant/15.720.csv", "variant", "flow");
  const dBad = defOf("ehp", "Other", "vaillant/08.ehp.csv", "error", "temp", { csv: "r,ehp,Other,,,15,b524,020002000700,temp,s,UCH,,," });
  const dDiff = defOf("hmu", "Scaled", "vaillant/08.hmu.csv", "hidden", "temp", { csv: "r,hmu,Scaled,,,15,b524,020002000700,temp,s,D2C,,°C," });
  const decodes = {};
  for (const t of telegrams) {
    const n = t.master.endsWith("01") ? "0.0 °C" : t.slave.endsWith("5041") ? "13.0 °C" : "0.0 °C";
    decodes[t.line] = new Map([
      [d700.key, ok(t.line, d700.key, `value=${n}`, { value: parseFloat(n) })],
      [d720.key, ok(t.line, d720.key, `flow=${n}`, { flow: parseFloat(n) })],
      [dDiff.key, ok(t.line, dDiff.key, `temp=${n}`, { temp: parseFloat(n) * 2 })],
      [dBad.key, { id: "x", line: t.line, defKey: dBad.key, result: "ERR_INVALID_POS", text: "", fields: null, used: false }],
    ]);
  }
  const decoder = fake([...telegrams, other], decodes);
  const row = { qq: 0x31, zz: 0x15, pb: 0xb5, sb: 0x24, id: "060009010700" };
  assert.deepEqual(rowTelegrams(decoder, row).map((t) => t.line), [telegrams[0].line, telegrams[1].line]);
  assert.equal(rowTelegrams(decoder, { ...row, id: "" }).length, 4, "without an ID the whole command belongs to the row");
  const rowLines = rowTelegrams(decoder, row);
  const cov = coverage(decoder, rowLines, d700.key);
  assert.deepEqual([cov.distinct, cov.ok, cov.errors, cov.occurrences, cov.first_ms, cov.last_ms], [2, 2, 0, 150, 1000, 4000]);
  assert.equal(cov.fields.get("value").max, 13);
  assert.deepEqual(summarizeFields(cov), [{ name: "value", kind: "range", min: 0, max: 13, distinct: 2 }]);
  const { groups, total } = groupCandidates(decoder, [d700, d720, dDiff, dBad].map((def) => ({ def })), rowLines, { chosenKey: d700.key, usedKey: d700.key });
  assert.equal(total, 4);
  // 700 and 720 are the same definition (names differ) and decode the same values; the scaled one differs; the failing one is last
  assert.deepEqual(groups.map((g) => g.members.map((m) => m.def.circuit)), [["700", "720"], ["hmu"], ["ehp"]]);
  assert.equal(groups[0].hasChosen, true);
  assert.deepEqual(groups[0].names, ["700 Hc1ActualFlowTempDesired", "720 Hc1FlowTempDesired"]);
  assert.deepEqual(groups[0].fieldNames, ["temp", "flow"], "differently named fields are shown");
  assert.equal(groups[1].fieldNames, null);
  assert.equal(groups[2].failed, true);
  assert.equal(groups[2].coverage.errorKinds.get("ERR_INVALID_POS"), 2);
});

test("why a candidate is not what ebusd uses", () => {
  const scan = { "15": { manufacturer: "Vaillant", ident: "BASV2", sw: "0507", hw: "1704", file: "vaillant/15.700.csv" } };
  assert.match(whyNot({ ...defOf("720", "X", "vaillant/15.720.csv", "variant"), zz: "15" }, scan), /only loaded for another device variant.*BASV2.*SW 0507.*loads 15\.700\.csv/);
  assert.match(whyNot(defOf("720", "X", "vaillant/15.720.csv", "variant"), {}), /No identification of device 15 was recorded/);
  const conditional = defOf("ehp", "X", "vaillant/50.ehp.csv", "conditional", "temp", { condition: "[Ehp_heatpumptype=3]",
    conditions: [{ name: "Ehp_heatpumptype", circuit: "ehp", message: "HeatPumpType", field: "type", value: [3] }, { name: "id_sw", circuit: "scan", message: "scan", field: "SW", value: [413, 4294967295] }] });
  assert.match(whyNot(conditional, scan), /\[Ehp_heatpumptype=3\].*ehp HeatPumpType type = 3 and the device identification SW ≥ 413/);
  assert.match(whyNot(defOf("a", "b", "a.csv", "hidden"), scan), /takes precedence/);
  assert.match(whyNot(defOf("a", "b", "a.csv", "error"), scan, new Map([["ERR_INVALID_POS", 2]])), /ERR_INVALID_POS ×2/);
});
