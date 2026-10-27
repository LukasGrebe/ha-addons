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
const { lineOfRun, defKeyOf, Decoder } = await import("../../ebusd_workbench/www/decoder.js");
const { idLengthOf, telegramRowKey } = await import("../../ebusd_workbench/www/colors.js");
const { app } = await import("../../ebusd_workbench/www/app.js");
const { seriesFields, seriesValues, nearestPoint, seriesQuery } = await import("../../ebusd_workbench/www/chart.js");
const log = await import("../../ebusd_workbench/www/log.js");
const define = await import("../../ebusd_workbench/www/define.js");
const { structuralSignature, rowTelegrams, coverage, groupCandidates, summarizeFields, whyNot, describeDifference, accessKind, locateSource, KIND_CODES, KIND_HELP, describeConditions, kindSuffix } = await import("../../ebusd_workbench/www/compare.js");

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
  assert.match(whyNot(defOf("a", "b", "a.csv", "hidden"), scan), /finds another definition first/);
  const used = { ...defOf("hmu", "SetMode", "vaillant/08.hmu.HW5103.csv", "active"), passive: true, write: true };
  assert.match(whyNot(defOf("hmu", "SetMode", "vaillant/08.hmu.HW5103.csv", "hidden"), scan, null, used), /finds hmu SetMode \(passive write\) from 08\.hmu\.HW5103\.csv first/);
  assert.match(whyNot(defOf("a", "b", "a.csv", "error"), scan, new Map([["ERR_INVALID_POS", 2]])), /ERR_INVALID_POS ×2/);
});

test("two groups that decode the same values are told apart by access kind and structure", () => {
  const passive = { circuit: "hmu", name: "SetMode", passive: true, write: true, csv: "uw,hmu,SetMode,Operation mode,,08,b510,00,hcmode,m,UCH,0=auto;1=off,,mode,flow,m,D1C,,°C," };
  const active = { circuit: "hmu", name: "SetMode", passive: false, write: true, csv: "w,hmu,SetMode,Operation mode,,08,b510,00,hcmode,m,UCH,0=auto;1=off,,mode,flow,m,D1C,,°C," };
  assert.deepEqual([accessKind(passive), accessKind(active)], ["passive write", "active write"]);
  assert.notEqual(structuralSignature(passive.csv), structuralSignature(active.csv));
  const diff = describeDifference(passive, active);
  assert.equal(diff.length, 1);
  assert.match(diff[0], /^passive write \(ebusd only listens.*\) instead of active write \(ebusd sends this value/);
  const retyped = { ...active, csv: active.csv.replace("D1C", "D2C") };
  assert.deepEqual(describeDifference(active, retyped), ["field flow: D1C °C instead of D2C °C"]);
  assert.deepEqual(describeDifference(active, { ...active }), []);
});

test("prefix rules decide the message ID length of a telegram, the longest prefix wins", () => {
  const settings = { id_bytes: 1, id_overrides: { b509: 3 }, id_rules: { "08b51a:05ff3221": 4, "08b51a:05": 2, "08b509:0d0f": 2 } };
  const m = (zz, cmd, data) => `31${zz}${cmd}${(data.length / 2).toString(16).padStart(2, "0")}${data}`;
  assert.equal(idLengthOf(m("08", "b51a", "05ff32210000"), settings), 4);
  assert.equal(idLengthOf(m("08", "b51a", "05ff32300000"), settings), 2);
  assert.equal(idLengthOf(m("08", "b51a", "04003400"), settings), 1, "no rule: the default");
  assert.equal(idLengthOf(m("08", "b509", "0d0f0000"), settings), 2, "a rule beats the command's length");
  assert.equal(idLengthOf(m("08", "b509", "0d020000"), settings), 3, "other telegrams of the command keep it");
  assert.equal(idLengthOf(m("15", "b51a", "05ff32210000"), settings), 1, "rules are per destination");
  assert.equal(telegramRowKey(m("08", "b51a", "05ff32210000"), settings), "3108b51a05ff3221");
});

test("rows follow the definitions: rules only where the grouping differs", () => {
  const decoder = new Decoder();
  const line = (data) => `3108b51a${(data.length / 2).toString(16).padStart(2, "0")}${data}/0100`;
  const known = line("05ff32210000"), unknown = line("04003400");
  decoder.telegrams = new Map([known, unknown].map((l) => [l, { line: l, master: l.split("/")[0] }]));
  const def = { key: "08.hmu.csv|hmu|Yield|", idlen: 4 };
  decoder.defs = new Map([[def.key, def]]);
  decoder.decodes = new Map([[known, new Map([[def.key, { defKey: def.key, result: "ok", used: true }]])], [unknown, new Map()]]);
  const settings = { id_bytes: 1, id_overrides: {}, id_rules: {} };
  assert.deepEqual([...decoder.idRules(settings)], [["08b51a:05ff3221", 4]]);
  assert.deepEqual([...decoder.idRules({ ...settings, id_rules: { "08b51a:05ff3221": 4 } })], [], "already grouped like the definition");
  assert.deepEqual([...decoder.idRulesFor([...decoder.telegrams.values()], settings)], [["08b51a:05ff3221", 4]]);
});

test("value history: points of a row get the values a definition decoded", () => {
  const data = { lines: ["a", "b", "c"], points: [[1000, 0], [2000, 1], [3000, 0], [4000, 2]], total: 4, stride: 1 };
  const ok = (value) => ({ result: "ok", fields: { temp: value }, text: `temp=${value}` });
  const decoder = { decodesOf: (line) => ({ a: new Map([["k", ok(10)]]), b: new Map([["k", ok(12.5)]]), c: new Map([["k", { result: "ERR_INVALID_POS" }]]) })[line] };
  assert.deepEqual(seriesFields(data, decoder, "k"), ["temp"]);
  const series = seriesValues(data, decoder, "k", "temp");
  assert.equal(series.numeric, true);
  assert.deepEqual(series.points, [{ ms: 1000, value: 10 }, { ms: 2000, value: 12.5 }, { ms: 3000, value: 10 }], "telegrams the definition does not decode are left out");
  assert.equal(nearestPoint(series, 2400).value, 12.5);
  assert.equal(nearestPoint(series, 2600).ms, 3000);
  const words = { decodesOf: () => new Map([["k", { result: "ok", fields: { mode: "auto" }, text: "mode=auto" }]]) };
  assert.equal(seriesValues({ lines: ["a"], points: [[1, 0]] }, words, "k", "mode").numeric, false);
  assert.equal(seriesQuery({ qq: 0x10, zz: 0xfe, pb: 0xb5, sb: 0x16, id: "00" }, 1000.4, 2000.2), "api/telegrams/series?from=1000&to=2001&qq=10&zz=fe&pb=b5&sb=16&id=00&max=20000");
  assert.match(seriesQuery({ qq: null, zz: null, pb: null, sb: null, id: "" }, 1, 2), /qq=--&zz=--&pb=--&sb=--&id=&/);
});

// -- defining a message from the recording -------------------------------------------------------------

test("a definition is prefilled from the row and the telegrams", () => {
  const row = { qq: 0x10, zz: 0x08, pb: 0xb5, sb: 0x11, id: "01" };
  const telegram = (answer, ms) => ({ line: `1008b5110101/${answer}`, master: "1008b5110101", slave: answer, n: 5, first_ms: ms, last_ms: ms + 100 });
  const samples = define.samplesOf([telegram("04380200", 1000), telegram("04380300", 2000)], 1);
  assert.deepEqual([...samples[0].s], [0x38, 0x02, 0x00], "the length byte of the answer is not data");
  assert.equal(samples[0].m.length, 0, "the ID is not part of the request data");
  const header = define.defaultHeader(row, samples, { scan: { "08": { ident: "HMU00" } }, own: "31" });
  assert.deepEqual([header.type, header.circuit, header.zz, header.pbsb, header.id], ["u", "hmu", "08", "b511", "01"], "answered, polled by someone else: passive");
  assert.equal(define.defaultHeader({ ...row, qq: 0x31 }, samples, { own: "31" }).type, "r", "polled by ebusd itself: a read");
  assert.equal(define.defaultHeader({ ...row, qq: 0x31 }, [{ s: null }], { own: "31" }).type, "w");
  assert.equal(define.defaultHeader(row, [{ s: null }], { own: "31" }).type, "uw");
  const broadcast = { qq: 0x10, zz: 0xfe, pb: 0xb5, sb: 0x16, id: "00" };
  assert.equal(define.defaultHeader(broadcast, [{ s: null }], {}).type, "u", "broadcast: passive");
  assert.equal(define.defaultHeader(broadcast, [{ s: null }], {}).circuit, "broadcast");
  assert.equal(define.defaultHeader({ qq: 0x10, zz: 0x15, pb: 0xb5, sb: 0x24, id: "" }, [{ s: [1] }], {}).circuit, "dev15");
  assert.equal(define.isMasterAddress(0x31), true);
  assert.equal(define.isMasterAddress(0x08), false);
});

test("bytes are analysed and interpreted over the history", () => {
  const sample = (hex, ms) => ({ m: new Uint8Array(0), s: define.hexToBytes(hex), n: 1, last_ms: ms });
  const samples = [sample("01a001", 1), sample("01b001", 2), sample("01c801", 3)];   // flag, temperature (2 bytes), flag
  const a = define.analyzeBytes(samples, "s");
  assert.equal(a.length, 3);
  assert.deepEqual(a.bytes.map((b) => b.distinct), [1, 3, 1]);
  assert.equal(a.latest.last_ms, 3);
  const d2c = define.interpretations(samples, "s", 1).find((i) => i.type === "D2C");
  assert.equal(d2c.latest, 0x01c8 / 16);
  assert.equal(d2c.name, "16 bit divided by 16", "the plain name travels with the interpretation");
  assert.deepEqual([d2c.min, d2c.max], [0x01a0 / 16, 0x01c8 / 16]);
  assert.equal(define.interpretations(samples, "s", 1).find((i) => i.type === "ULG"), undefined, "a type that needs more bytes than there are does not fit");
  assert.equal(define.interpretations([sample("ff", 1)], "s", 0).find((i) => i.type === "D1C").validRatio, 0, "0xff is the replacement value of D1C");
});

test("segments tile the bytes; interpreting a byte splits the raw field; the CSV follows", () => {
  const shape = (segs) => segs.map((s) => [s.offset, s.len, s.type]);
  let segs = define.initialSegments(5);
  assert.deepEqual(shape(segs), [[0, 5, "HEX"]]);
  segs = define.applyType(segs, 5, 1, "D2C");
  assert.deepEqual(shape(segs), [[0, 1, "HEX"], [1, 2, "D2C"], [3, 2, "HEX"]]);
  segs = define.applyType(segs, 5, 2, "UCH");                // overlaps the D2C field: what is left of it becomes raw again
  assert.deepEqual(shape(segs), [[0, 2, "HEX"], [2, 1, "UCH"], [3, 2, "HEX"]]);
  segs = define.applyType(segs, 5, 3, "IGN", 2);
  assert.deepEqual(shape(segs), [[0, 2, "HEX"], [2, 1, "UCH"], [3, 2, "IGN"]]);
  assert.equal(segs.reduce((n, s) => n + s.len, 0), 5, "the segments always cover every byte");
  const named = define.nameSegments(define.applyType(define.applyType(define.initialSegments(4), 4, 0, "D2C"), 4, 2, "D2C"), "s");
  assert.deepEqual(named.map((s) => s.name), ["value", "value2"], "unnamed fields get valid unique names");
  const header = { type: "r", circuit: "hmu", name: "Test", comment: "c, d", qq: "", zz: "08", pbsb: "b511", id: "01" };
  const csv = define.buildCsv(header, { m: [], s: define.applyType(define.initialSegments(3), 3, 1, "D2C") });
  assert.equal(csv, 'r,hmu,Test,"c, d",,08,b511,01,answer,s,HEX:1,,,,value1,s,D2C,,,');
  assert.equal(define.customKey({ circuit: "hmu", name: "Test", type: "uw" }), "custom.csv|hmu|Test|wu");
});

test("a compiled definition is traced back to the line of its TypeSpec model", () => {
  const files = {
    "vaillant/08.hmu.tsp": "import x;\n\nnamespace Hmu {\n  /** comment */\n  model SetMode {\n  }\n  model TotalEnergyUsage {\n  }\n}\n",
    "vaillant/08.bai.tsp": "namespace Bai {\n  model SetMode {\n  }\n}\n",
    "vaillant/_templates.tsp": "alias Common = 1;\n",
  };
  assert.deepEqual(locateSource(files, { file: "vaillant/08.hmu.csv", name: "TotalEnergyUsage" }), { path: "vaillant/08.hmu.tsp", line: 7 });
  assert.deepEqual(locateSource(files, { file: "vaillant/08.bai.csv", name: "SetMode" }), { path: "vaillant/08.bai.tsp", line: 2 }, "the file named like the CSV wins");
  assert.deepEqual(locateSource(files, { file: "vaillant/08.ehp.csv", name: "SetMode" }), { path: "vaillant/08.hmu.tsp", line: 5 }, "else a neighbour that has the model");
  assert.equal(locateSource(files, { file: "vaillant/08.hmu.csv", name: "Missing" }), null);
});

// -- noting events like the terminal's log command ------------------------------------------------------------

test("the form turns into the terminal's log command", () => {
  const today = new Date(2026, 9, 27, 12, 0, 0);
  const at = (h, m, s = 0, ms = 0, d = 27) => new Date(2026, 9, d, h, m, s, ms).getTime();
  assert.equal(log.durationText(500), "500ms");
  assert.equal(log.durationText(2000), "2s");
  assert.equal(log.durationText(600_000), "10m");
  assert.equal(log.durationText(3600_000), "1h");
  assert.equal(log.durationText(90_000), "90s");
  assert.deepEqual([log.fromMs(600_000), log.fromMs(500), log.fromMs(7200_000)], [{ value: 10, unit: "min" }, { value: 500, unit: "ms" }, { value: 2, unit: "h" }]);
  assert.equal(log.toMs(10, "min"), 600_000);
  const base = { today, beforeMs: 500, afterMs: 500 };
  assert.equal(log.logCommand({ ...base, message: "Modus auf Einschaltempfehlung geändert", now: true }), "log Modus auf Einschaltempfehlung geändert");
  assert.equal(log.logCommand({ ...base, message: "Modus geändert", ms: at(8, 52, 23), beforeMs: 2000, afterMs: 2000 }), "log 8:52:23 ~2s Modus geändert");
  assert.equal(log.logCommand({ ...base, message: "Dampf vom Abtauen", ms: at(8, 50), beforeMs: 600_000, afterMs: 0 }), "log 8:50:00 -10m Dampf vom Abtauen");
  assert.equal(log.logCommand({ ...base, message: "x", ms: at(8, 50), beforeMs: 600_000, afterMs: 30_000 }), "log 8:50:00 -10m+30s x");
  assert.equal(log.logCommand({ ...base, message: "Warmwasser auf 50 °C", ms: at(22, 15, 0, 0, 26), whole: true }), "log 2026-10-26 22:15 Warmwasser auf 50 °C", "another day: with the date; only the minute known");
  assert.equal(log.logCommand({ ...base, message: "8:30 ist es passiert", now: true }), "log -- 8:30 ist es passiert", "a message that looks like a time needs --");
  assert.equal(log.logCommand({ ...base, message: "", now: true }), "log", "only the time");
  assert.equal(log.logCommand({ ...base, message: "x", ms: at(8, 52, 23, 500) }), "log 8:52:23.5 x");
  assert.deepEqual(log.eventRange({ ms: at(8, 52, 23), beforeMs: 2000, afterMs: 2000, whole: false }), { ms: at(8, 52, 23), min: at(8, 52, 21), max: at(8, 52, 25) });
  assert.deepEqual(log.eventRange({ ms: at(8, 52, 23), beforeMs: 0, afterMs: 0, whole: true }), { ms: at(8, 52), min: at(8, 52), max: at(8, 53) }, "8:52 is 8:52:00 to 8:53:00");
});

test("dropdown texts: plain name, explanation, then the CSV shorthand", () => {
  assert.equal(define.typeOption("UCH"), "unsigned byte · whole number 0 to 255 · UCH");
  assert.match(define.typeOption("D2C"), /^16 bit divided by 16 · two bytes in 1\/16 steps, e\.g\. a temperature.* · D2C$/);
  assert.equal(define.typeOption("IGN"), "ignored bytes · skipped, not decoded · IGN");
  assert.deepEqual(Object.keys(define.TYPES).filter((t) => !define.TYPES[t].name || !define.TYPES[t].label), [], "every type has a name and an explanation");
  const names = Object.values(define.TYPES).map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "the plain names tell the types apart");
  const kinds = Object.entries(KIND_CODES).map(([k, code]) => `${k} · ${KIND_HELP[k]} · ${code}`);
  assert.equal(kinds[0], "active read · ebusd polls this value from the device · r");
  assert.equal(kinds[3], "passive write · ebusd only listens: it decodes a command another device sends, e.g. the controller setting a mode · uw");
});

test("conditions and kinds are put in words", () => {
  const def = { conditions: [{ name: "Ehp_heatpumptype", circuit: "ehp", message: "HeatPumpType", field: "type", value: [3] }, { name: "id_sw", circuit: "scan", message: "scan", field: "SW", value: [413, 4294967295] }] };
  assert.equal(describeConditions(def), "ehp HeatPumpType type = 3 and the device identification SW ≥ 413");
  assert.equal(describeConditions({}), "");
  assert.equal(kindSuffix({ passive: false, write: false }), "");
  assert.equal(kindSuffix({ passive: true, write: true }), " · passive write");
});

test("a definition line is split into header and fields and put together again", async () => {
  const { parseDefinition, buildDefinition, splitType } = await import("../../ebusd_workbench/www/definition-edit.js");
  const csv = "r,hmu,DateTime,date/time,,08,b504,00,dcfstate,s,UCH,0=nosignal;1=ok;2=sync;3=valid,,DCF receiver state,btime,s,BTI,,,time";
  const parsed = parseDefinition(csv);
  assert.deepEqual(parsed.header, { condition: "", type: "r", circuit: "hmu", name: "DateTime", comment: "date/time", qq: "", zz: "08", pbsb: "b504", id: "00" });
  assert.equal(parsed.fields.length, 2);
  assert.deepEqual(parsed.fields[0], { name: "dcfstate", part: "s", type: "UCH", divisor: "0=nosignal;1=ok;2=sync;3=valid", unit: "", comment: "DCF receiver state" });
  assert.equal(buildDefinition(parsed), csv, "nothing changes unless the form changes it");
  parsed.fields.splice(0, 1);
  parsed.fields[0].unit = "h";
  assert.equal(buildDefinition(parsed), "r,hmu,DateTime,date/time,,08,b504,00,btime,s,BTI,,h,time");
  // a condition belongs to the source: a version of your own applies whenever it matches
  assert.equal(buildDefinition(parseDefinition("[ehp.type=3]r,ehp,Flow,,,08,b509,0d,flow,s,D2C,,°C,")), "r,ehp,Flow,,,08,b509,0d,flow,s,D2C,,°C,");
  assert.equal(parseDefinition('r,c,n,"a, b",,08,b504,00').header.comment, "a, b", "a comma in quotes stays in the cell");
  assert.deepEqual(splitType("HEX:4"), { code: "HEX", length: "4" });
  assert.deepEqual(splitType("d2c"), { code: "D2C", length: "" });
  assert.deepEqual(splitType("1 bad"), { code: "", length: "" });
});
