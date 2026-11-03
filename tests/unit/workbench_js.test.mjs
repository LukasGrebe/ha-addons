// Node tests of the Workbench's browser modules that need no browser: the CSV helpers, the pool of
// definition lines (parsing, matching, the trees ebusd decodes with), the core's bookkeeping of
// results and definitions, the setup model's renaming, the Home Assistant YAML generator, the
// judging helpers and the eBUS specification tables. Run by test_workbench_js.py (node --test).
import test from "node:test";
import assert from "node:assert/strict";

// app.js touches the DOM on import; the modules under test only need these exports
globalThis.document = { getElementById: (id) => (id === "tabs" || id === "bus" ? null : { appendChild() {}, replaceChildren() {} }), createElement: () => ({ style: {}, classList: { toggle() {} }, addEventListener() {}, setAttribute() {}, appendChild() {}, remove() {} }), createTextNode: (t) => t, querySelectorAll: () => [], addEventListener() {} };
globalThis.window = { workbench: null, addEventListener() {} };
globalThis.fetch = async () => ({ ok: true, text: async () => "{}" });
globalThis.location = { hash: "" };
globalThis.history = { replaceState() {} };
globalThis.setInterval = () => 0;

const { splitCsv, joinCsv, parseDefinition, buildDefinition, splitType, fnv } = await import("../../ebusd_workbench/www/csv.js");
const { Pool, parseFiles, parseLine, layoutFields, byteLengthOf, candidateKey, layoutOf, dropLevel } = await import("../../ebusd_workbench/www/pool.js");
const { setup } = await import("../../ebusd_workbench/www/setup.js");
const { generateHaYaml, generateEbusdOptions } = await import("../../ebusd_workbench/www/hayaml.js");
const { app } = await import("../../ebusd_workbench/www/app.js");
const { Core, mineFiles } = await import("../../ebusd_workbench/www/core.js");
const { keyOfLine, identityOf } = await import("../../ebusd_workbench/www/mine.js");
const { seriesFields, seriesValues, nearestPoint, seriesQuery } = await import("../../ebusd_workbench/www/chart.js");
const define = await import("../../ebusd_workbench/www/define.js");
const types = await import("../../ebusd_workbench/www/types.js");
const ev = await import("../../ebusd_workbench/www/events.js");
const { rowTelegrams, coverage, summarizeFields, whyNot, accessKind, KIND_CODES, KIND_HELP, describeConditions, kindSuffix } = await import("../../ebusd_workbench/www/compare.js");
const spec = await import("../../ebusd_workbench/www/ebus-spec.js");

const H9 = "# type (r[1-9];w;u),circuit,level,name,comment,QQ,ZZ,PBSB,ID,field1,part (m/s),datatypes/templates,divider/values,unit,comment\n";
const H8 = "type,circuit,name,comment,qq,zz,pbsb,id,*name,part,type,divisor/values,unit,comment\n";

// -- csv -------------------------------------------------------------------------------------------------------

test("csv split and join keep quoted commas", () => {
  const line = 'r,c,n,"a, b",,,b509,01,value,s,UCH,"0=x, y;1=z",,';
  assert.deepEqual(splitCsv(line).slice(3, 4), ["a, b"]);
  assert.equal(joinCsv(splitCsv(line)), line);
});

test("a definition line is split into header and fields and put together again", () => {
  const csv = "r,hmu,DateTime,date/time,,08,b504,00,dcfstate,s,UCH,0=nosignal;1=ok;2=sync;3=valid,,DCF receiver state,btime,s,BTI,,,time";
  const parsed = parseDefinition(csv);
  assert.deepEqual(parsed.header, { condition: "", type: "r", circuit: "hmu", name: "DateTime", comment: "date/time", qq: "", zz: "08", pbsb: "b504", id: "00" });
  assert.equal(parsed.fields.length, 2);
  assert.deepEqual(parsed.fields[0], { name: "dcfstate", part: "s", type: "UCH", divisor: "0=nosignal;1=ok;2=sync;3=valid", unit: "", comment: "DCF receiver state" });
  assert.equal(buildDefinition(parsed), csv, "nothing changes unless the form changes it");
  parsed.fields.splice(0, 1);
  parsed.fields[0].unit = "h";
  assert.equal(buildDefinition(parsed), "r,hmu,DateTime,date/time,,08,b504,00,btime,s,BTI,,h,time");
  const conditional = parseDefinition("[ehp.type=3]r,ehp,Flow,,,08,b509,0d,flow,s,D2C,,°C,");
  assert.equal(conditional.header.condition, "[ehp.type=3]");
  assert.equal(buildDefinition(conditional), "[ehp.type=3]r,ehp,Flow,,,08,b509,0d,flow,s,D2C,,°C,", "the condition stays with the line");
  assert.equal(parseDefinition('r,c,n,"a, b",,08,b504,00').header.comment, "a, b", "a comma in quotes stays in the cell");
  assert.deepEqual(splitType("HEX:4"), { code: "HEX", length: "4" });
  assert.deepEqual(splitType("d2c"), { code: "D2C", length: "" });
  assert.deepEqual(splitType("STR:*"), { code: "STR", length: "*" });
  assert.deepEqual(splitType("1 bad"), { code: "", length: "" });
  assert.match(fnv("abc"), /^[0-9a-f]{8}$/);
  assert.notEqual(fnv("abc"), fnv("abd"));
});

// -- the pool -------------------------------------------------------------------------------------------------

const FILES = {
  "vaillant/08.hmu.csv": H9 + "r,,,Status00,,,,b511,00,temp,s,D2C,,°C,,pressure,s,UCH,10,bar,\nr,,,YieldTotal,,,,b516,1801,ign,,IGN:1,,,,value,,UIN,,kWh,\nw,,,SetMode,,,,b510,00,mode,,UCH,,,,temp,,D2C,,,\n[id_08_sw>=413]r,,,Flow,,,,b511,02,flow,s,D2C,,°C,\n",
  "vaillant/76.vwz.csv": H9 + "r,,,Status00,,,,b511,00,temp,s,D2C,,°C,,pressure,s,UCH,10,bar,\n",
  "broadcast.csv": H9 + "u,broadcast,,datetime,Date/Time,,fe,0700,,outsidetemp,,D2B,,°C,,time,,HTI,,,,date,,HDA:3,,,\n",
  "scan.csv": H9 + "r,scan,,,,,,0704,,mf,,manufacturer,,,,id,,STR:5,,,,sw,,PIN,,,,hw,,PIN,,,\n",
  "vaillant/_templates.csv": "ignored,,\n",
  "vaillant/bai.0010002315.inc": H9 + "r,,,Status00,,,,b511,00,temp,s,D2C,,°C,,pressure,s,UCH,10,bar,\n",
  "vaillant/08.bai.csv": H9 + "!load,bai.0010002315.inc,,,\n",
};

test("ebusd's files are parsed with their level column; zz, circuit and parts are made explicit", () => {
  assert.deepEqual(layoutOf(H9), { level: true });
  assert.deepEqual(layoutOf(H8), { level: false });
  assert.equal(dropLevel("r,,,Status00,,,,b511,00,temp,s,D2C"), "r,,Status00,,,,b511,00,temp,s,D2C");
  const hmu = parseLine("r,,,Status00,,,,b511,00,temp,s,D2C,,°C,,pressure,s,UCH,10,bar,", "vaillant/08.hmu.csv", { level: true });
  assert.deepEqual([hmu.circuit, hmu.name, hmu.zz, hmu.pbsb, hmu.id, hmu.idlen, hmu.write, hmu.passive], ["hmu", "Status00", "08", "b511", "00", 1, false, false]);
  assert.equal(hmu.csv, "r,hmu,Status00,,,08,b511,00,temp,s,D2C,,°C,,pressure,s,UCH,10,bar,", "the line with zz and circuit from the file name");
  assert.deepEqual([hmu.m, hmu.s], [{ bytes: 0, fixed: true }, { bytes: 3, fixed: true }]);
  const write = parseLine("w,,,SetMode,,,,b510,00,mode,,UCH,,,,temp,,D2C,,,", "vaillant/08.hmu.csv", { level: true });
  assert.equal(write.csv, "w,hmu,SetMode,,,08,b510,00,mode,m,UCH,,,,temp,m,D2C,,,", "a write's fields are in the message itself");
  const broadcast = parseLine("u,broadcast,,datetime,Date/Time,,fe,0700,,outsidetemp,,D2B,,°C,,time,,HTI,,,,date,,HDA:3,,,", "broadcast.csv", { level: true });
  assert.equal(broadcast.m.bytes, 8, "a broadcast's fields are in the message itself");
  const mine = parseLine("r,hmu,Mine,,,08,b511,01,answer,s,HEX:9,,,", "mine/1.csv");
  assert.deepEqual([mine.zz, mine.s], ["08", { bytes: 9, fixed: true }]);
  const rest = parseLine("r,hmu,Rest,,,08,b511,01,head,s,UCH,,,,rest,s,HEX:*,,,", "mine/1.csv");
  assert.deepEqual(rest.s, { bytes: 1, fixed: false });
  const chained = parseLine("r,Scan,,Id,Scan ID,,,b509,24;25;26;27,ign,,IGN,,,,prefix,,STR:2,,,", "vaillant/scan.csv", { level: true });
  assert.deepEqual([chained.id, chained.chained], ["24", true]);
  const conditional = parseLine("[id_08_sw>=413]r,,,Flow,,,,b511,02,flow,s,D2C,,°C,", "vaillant/08.hmu.csv", { level: true });
  assert.equal(conditional.condition, "[id_08_sw>=413]");
  assert.equal(parseLine("# a comment", "x.csv"), null);
  assert.equal(parseLine("*r,,,,,,,", "x.csv"), null, "defaults are not lines");
  assert.equal(parseLine(H9.trim(), "x.csv"), null, "the header is not a line");
  assert.deepEqual(layoutFields(parseDefinition("r,c,n,,,08,b511,00,a,s,UCH,,,,b,s,BI0:2,,,,c,s,BI2,,,,d,s,D2C,,,").fields).map((f) => [f.byte, f.len, f.bit, f.bits]), [[0, 1, null, null], [1, 1, 0, 2], [1, 1, 2, 1], [2, 2, null, null]]);
  assert.deepEqual([byteLengthOf("D2C"), byteLengthOf("HEX:5"), byteLengthOf("BI3"), byteLengthOf("STR:*"), byteLengthOf("temp")], [2, 5, 0, null, null]);
});

test("the pool matches telegrams by destination, command, ID and lengths, and knows where a line comes from", () => {
  const parsed = parseFiles(FILES);
  assert.equal(parsed.lines.size, 8);
  const inc = [...parsed.lines.values()].find((l) => l.circuit === "bai");
  assert.deepEqual([inc.zz, inc.name], ["08", "Status00"], "an included file takes destination and circuit from the device file it is named after");
  assert.ok(parsed.scan[""], "scan.csv is kept for the trees, by directory");
  const pool = new Pool();
  pool.setSource("release", "s1", parsed, 0);
  const names = (hashes) => hashes.map((h) => `${pool.lines.get(h).circuit} ${pool.lines.get(h).name}`).sort();
  assert.deepEqual(names(pool.matches("1008b5110100", "039b0115")), ["bai Status00", "hmu Status00"]);
  assert.deepEqual(names(pool.matches("1076b5110100", "039b0115")), ["vwz Status00"]);
  assert.deepEqual(pool.matches("1008b5110100", "029b01"), [], "a shorter answer than the fields need");
  assert.deepEqual(names(pool.matches("1008b5110100", "049b011500")), ["bai Status00", "hmu Status00"], "a longer answer decodes: ebusd reads what the fields need and ignores the rest");
  assert.deepEqual(names(pool.matches("1008b5110102", "029b01")), ["hmu Flow"], "a conditional line is a candidate too");
  assert.deepEqual(names(pool.matches("3108b516021801", "03000a00")), ["hmu YieldTotal"]);
  assert.equal(pool.idLengthOf("3108b516021801", "03000a00"), 2);
  assert.equal(pool.idLengthOf("3108b516021802", "03000a00"), 0, "nothing fits: the default applies");
  assert.deepEqual(names(pool.matches("10fe0700080080051027100811", null)), ["broadcast datetime"]);
  assert.deepEqual(names(pool.matches("1008b51004000100ff", "00")), ["hmu SetMode"]);
  assert.deepEqual(names(pool.matches("3108070400", "0ab5484d55303006055103")), ["scan "]);
  // the same line in two sources is one line with two references
  const pr = parseFiles({ "vaillant/08.hmu.csv": H9 + "r,,,Status00,,,,b511,00,temp,s,D2C,,°C,,pressure,s,UCH,10,bar,\nr,,,Status01,,,,b511,01,temp,s,D2C,,°C,\n" });
  pool.setSource("pr/660", "p1", pr, 10);
  const status00 = pool.matches("1008b5110100", "039b0115").find((h) => pool.lines.get(h).circuit === "hmu");
  assert.deepEqual(pool.refs.get(status00).map((r) => r.source), ["release", "pr/660"]);
  assert.equal(pool.preferredRef(status00).source, "release");
  assert.deepEqual(names(pool.matches("1008b5110101", "029b01")), ["hmu Status01"]);
  const tree = pool.treeFor([status00, pool.matches("1008b5110101", "029b01")[0]]);
  assert.deepEqual(Object.keys(tree.files).sort(), ["pr_660/vaillant/line__08.hmu__2.csv", "release/vaillant/_templates.csv", "release/vaillant/line__08.hmu__1.csv", "scan.csv"], "one file per line, in its source's folder under its directory, with the templates that apply there");
  assert.match(tree.files["release/vaillant/line__08.hmu__1.csv"], /^type,circuit,name,comment,qq,zz,pbsb,id,\*name.*\nr,hmu,Status00,,,08,b511,00,temp,s,D2C,,°C,,pressure,s,UCH,10,bar,\n$/);
  assert.equal(tree.files["release/vaillant/_templates.csv"], "ignored,,\n");
  assert.equal(tree.keys.get("release/vaillant/line__08.hmu__1.csv|hmu|Status00|"), status00);
  assert.equal(candidateKey({ file: "release/vaillant/line__08.hmu__1.csv", circuit: "hmu", name: "Status00", write: false, passive: false }), "release/vaillant/line__08.hmu__1.csv|hmu|Status00|");
  // an old layout (the whole repository in versions): the templates of the directory and of those above it, combined
  const old = parseFiles({ "latest/en/_templates.csv": "temp1,s,D1C,,°C,\n", "latest/en/vaillant/_templates.csv": "hwcmode,s,UCH,0=off;1=on,,\n", "latest/en/vaillant/08.bai.csv": H9 + "r,,,StatusTHER,,,,b511,00,t,s,temp1,,,,m,s,hwcmode,,,\n" });
  pool.setSource("pr/411", "p4", old, 20);
  const oldTree = pool.treeFor([[...old.lines.keys()][0]]);
  assert.deepEqual(Object.keys(oldTree.files).sort(), ["pr_411/latest/en/vaillant/_templates.csv", "pr_411/latest/en/vaillant/line__08.bai__1.csv", "scan.csv"], "the release's scan serves a tree of another source");
  assert.equal(oldTree.files["pr_411/latest/en/vaillant/_templates.csv"], "temp1,s,D1C,,°C,\nhwcmode,s,UCH,0=off;1=on,,\n");
  // compiled sources keep their identification in the manufacturer's folder
  const compiled = parseFiles({ "vaillant/scan.csv": "r,scan,,id,,,,b509,24,id,s,STR:9,,,\n", "vaillant/_templates.csv": "ignored,,\n", "vaillant/08.hmu.csv": H9 + "r,,,Status00,,,,b511,00,temp,s,D2C,,°C,\n" });
  const pool2 = new Pool();
  pool2.setSource("release", "s2", compiled, 0);
  const hmu = [...compiled.lines.values()].find((l) => l.circuit === "hmu").hash, scanLine = [...compiled.lines.values()].find((l) => l.circuit === "scan").hash;
  assert.deepEqual(Object.keys(pool2.treeFor([hmu]).files).sort(), ["release/vaillant/_templates.csv", "release/vaillant/line__08.hmu__1.csv", "release/vaillant/scan.csv"]);
  assert.deepEqual(Object.keys(pool2.treeFor([scanLine]).files).sort(), ["release/vaillant/_templates.csv", "release/vaillant/line__scan__1.csv"], "a scan line of its own is not doubled by its file");
  // an old pull request with the repository in several versions: only the scan next to the line, not every version's
  const versions = parseFiles({ "latest/en/vaillant/scan.csv": "r,scan,,id,,,,b509,24,id,s,STR:9,,,\n", "ebusd-2.x.x/en/vaillant/scan.csv": "r,scan,,id,,,,b509,24,id,s,STR:9,,,\n", "ebusd-2.x.x/en/vaillant/08.bai.csv": H9 + "r,,,Status02,,,,b511,02,t,s,D2C,,,\n" });
  pool2.setSource("pr/328", "p5", versions, 30);
  const bai = [...versions.lines.values()].find((l) => l.circuit === "bai").hash;
  assert.deepEqual(Object.keys(pool2.treeFor([bai]).files).sort(), ["pr_328/ebusd-2.x.x/en/vaillant/line__08.bai__1.csv", "pr_328/ebusd-2.x.x/en/vaillant/scan.csv"]);
  pool.removeSource("pr/660");
  assert.deepEqual(pool.refs.get(status00).map((r) => r.source), ["release"]);
  assert.deepEqual(pool.matches("1008b5110101", "029b01"), []);
  assert.equal(parseFiles({ "vaillant/bai.0010002315.inc": H9 + "r,,,X,,,,b511,00,temp,s,D2C,,°C,\n" }).lines.values().next().value.circuit, "bai.0010002315", "an included file without its device file keeps its own name");
});

// -- the core's bookkeeping ------------------------------------------------------------------------------------

test("the core keys results by the line's content and tells the views what fits, decodes and is ebusd's choice", () => {
  const core = new Core();
  core.sourceInfo.set("release", { id: "release", label: "ebusd's definitions", kind: "cdn", stamp: "s1", enabled: true, files: { "scan.csv": "x" } });
  core.sourceInfo.set("mine", { id: "mine", label: "my definitions", kind: "mine", stamp: "m1", enabled: true });
  core.pool.setSource("release", "s1", parseFiles(FILES), 0);
  core.pool.setSource("mine", "m1", parseFiles(mineFiles("r,hmu,Mine,,,08,b511,00,temp,s,D2C,,°C,,rest,s,HEX:1,,,\n")), 90);
  core.meta.scans[core.scanKeyOf(core.sourceInfo.get("release"))] = { "08": { manufacturer: "Vaillant", ident: "HMU00", sw: "0605", hw: "5103", file: "vaillant/08.hmu.csv" } };
  const line = "1008b5110100/039b0115";
  const release = core.pool.matches("1008b5110100", "039b0115").find((h) => core.pool.refs.get(h)[0].source === "release" && core.pool.lines.get(h).circuit === "hmu");
  const bai = core.pool.matches("1008b5110100", "039b0115").find((h) => core.pool.lines.get(h).circuit === "bai");
  const mine = core.pool.matches("1008b5110100", "039b0115").find((h) => core.pool.refs.get(h)[0].source === "mine");
  const t = { line, master: "1008b5110100", slave: "039b0115", n: 12, first_ms: 1000, last_ms: 9000, primary: { stamp: "s1", hash: release } };
  core.telegrams.set(line, t);
  core.results.set(line, new Map([[release, { result: "ok", text: "temp=25.69 °C;pressure=1.5 bar", fields: { temp: 25.69, pressure: 1.5 } }]]));
  assert.equal(core.primary, "release");
  assert.equal(core.rowKeyOf(t), "08b511:00");
  assert.equal(core.rowKeyOf({ master: "3108b509030d0f00", slave: "02aabb" }), "08b509:0d0f00", "Vaillant registers have 3 ID bytes even without a definition");
  const candidates = core.candidatesOf([line]);
  assert.deepEqual([...candidates.keys()].sort(), [release, bai, mine].sort());
  assert.deepEqual([candidates.get(release).ok, candidates.get(release).used, candidates.get(release).pending], [1, 1, 0]);
  assert.deepEqual([candidates.get(mine).ok, candidates.get(mine).pending], [0, 1], "a line of your own not checked yet is pending");
  assert.equal(candidates.get(release).usedIn, 1, "the release would use it: the file is the one the scan chose");
  const decoded = core.decodesOf(line);
  assert.equal(decoded.get(release).used, true);
  assert.equal(decoded.has(mine), false);
  assert.equal(core.usedDecode(line).text, "temp=25.69 °C;pressure=1.5 bar");
  core.rebuildEntries();
  const active = core.entries.find((e) => e.key === release), own = core.entries.find((e) => e.key === mine);
  assert.deepEqual([active.status, active.occurrences, active.ok, active.sources], ["active", 12, 1, ["release"]]);
  assert.deepEqual([own.status, own.pending, own.mine], ["custom", 1, true]);
  const flow = core.pool.matches("1008b5110102", "029b01")[0];
  core.telegrams.set("1008b5110102/029b01", { line: "1008b5110102/029b01", master: "1008b5110102", slave: "029b01", n: 1, first_ms: 1, last_ms: 2, primary: { stamp: "s1", hash: null } });
  core.results.set("1008b5110102/029b01", new Map([[flow, { result: "ok", text: "flow=25.69", fields: { flow: 25.69 } }]]));
  core.flags.set(flow, { available: false });
  core.rebuildEntries();
  assert.equal(core.entries.find((e) => e.key === flow).status, "conditional", "decodes, but its condition was not met");
  assert.ok(core.entries.some((e) => e.companion && e.name === "SetMode") === false, "a write with other fields is no counterpart");
  assert.deepEqual(Object.keys(mineFiles("r,a,b,,,08,b511,00\n\n# c\nr,a,c,,,08,b511,01\n")), ["mine/1.csv", "mine/2.csv"]);
  assert.equal(core.ensureDecoded("08b511:00", [line], "now"), true);
  assert.equal(core.queue[0].key, "08b511:00");
  assert.equal(core.keysOf("release").get("vaillant/08.hmu.csv|hmu|Status00|"), release, "ebusd's report of the full tree joins the pool by file, circuit and name");
});

test("lines of your own are keyed by content and replaced by message", () => {
  const a = "r,hmu,Mine,,,08,b511,00,temp,s,D2C,,°C,";
  const b = "r,hmu,Mine,,,08,b511,00,temp,s,UCH,,,";
  assert.match(keyOfLine(a), /^[0-9a-f]{8}$/);
  assert.notEqual(keyOfLine(a), keyOfLine(b));
  assert.equal(identityOf(parseLine(a, "mine/1.csv")), identityOf(parseLine(b, "mine/1.csv")), "the same message");
  assert.equal(keyOfLine("# not a line"), null);
});

// -- the setup --------------------------------------------------------------------------------------------------

const roomTemp = { key: "0a0a0a01", circuit: "700", name: "Z1RoomTemp", write: false, passive: false, status: "active", source: "release", sources: ["release"], sourceLabel: "ebusd's definitions", file: "vaillant/15.700.csv",
  fields: ["temp"], csv: "r,700,Z1RoomTemp,Room temperature,,15,b524,020000000700,temp,s,D2C,,°C,room temperature" };
const dayTempW = { key: "0a0a0a02", circuit: "700", name: "Z1DayTemp", write: true, passive: false, status: "companion", source: "pr/660", sources: ["pr/660"], sourceLabel: "PR 660", file: "vaillant/15.700.csv",
  fields: ["temp"], csv: "w,700,Z1DayTemp,Day temperature,,15,b524,020100000700,temp,m,D2C,,°C,day temperature" };
const dayTemp = { ...dayTempW, key: "0a0a0a03", write: false, status: "active", source: "release", sources: ["release"], sourceLabel: "ebusd's definitions", csv: dayTempW.csv.replace(/^w/, "r") };
const hidden = { key: "0a0a0a04", circuit: "700", name: "Other", write: false, passive: false, status: "hidden", source: "release", sources: ["release"], sourceLabel: "ebusd's definitions", file: "vaillant/15.700.csv", fields: ["value"], csv: "[id_15_sw>=1]r,700,Other,,,15,b524,0200000a0700,value,s,UCH,,," };
const entries = [roomTemp, dayTemp, dayTempW, hidden];

test("setup: ebusd's choice until customized, then choose, include and rename", () => {
  app.settings = { setup: { added: ["release|old|key"], chosen: { row: "release|old|key" } } };
  setup.load();
  assert.equal(setup.customized, false, "keys of an earlier version are dropped");
  assert.deepEqual(setup.includedKeys(entries), [roomTemp.key, dayTemp.key]);
  // choosing a candidate for a row includes it and drops the row's other candidates
  setup.choose("15b524:0200000a0700", hidden.key, [hidden.key, roomTemp.key], entries);
  assert.equal(setup.customized, true);
  assert.deepEqual(setup.includedKeys(entries).sort(), [hidden.key, dayTemp.key].sort());
  assert.equal(setup.chosenFor("15b524:0200000a0700"), hidden.key);
  setup.include(roomTemp.key, true, entries);
  setup.include(dayTempW.key, true, entries);
  // renaming message, field and circuit flows into the CSV, upstream names stay in the data
  setup.rename(roomTemp, "Zone 1 Room Temperature");
  setup.renameField(roomTemp, "temp", "temperature");
  setup.renameCircuit("700", "heating");
  assert.equal(setup.exportName(roomTemp), "Zone_1_Room_Temperature");
  assert.deepEqual(setup.fieldMap(roomTemp), { temp: "temperature" });
  assert.equal(setup.csvOf(roomTemp), "r,heating,Zone_1_Room_Temperature,Room temperature,,15,b524,020000000700,temperature,s,D2C,,°C,room temperature");
  assert.equal(setup.csvOf(hidden), "r,heating,Other,,,15,b524,0200000a0700,value,s,UCH,,,", "the condition is dropped: the line is chosen for this installation");
  const { files } = setup.files(entries, { "pr/660": "PR 660 (HMU HW5103)" });
  assert.deepEqual(Object.keys(files), ["heating.csv"]);
  assert.match(files["heating.csv"], /^# upstream name: 700 Z1RoomTemp \(fields temp→temperature\)\nr,heating,Zone_1_Room_Temperature/m);
  assert.match(files["heating.csv"], /# from ebusd's definitions \(release\)\nr,heating,Other/);
  assert.match(files["heating.csv"], /# from PR 660 \(HMU HW5103\) \(pr\/660\)\nw,heating,Z1DayTemp/);
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

// -- judging candidates over the whole recording -------------------------------------------------------------

const fake = (telegrams, decodes, matches = {}) => ({ telegrams: new Map(telegrams.map((t) => [t.line, t])), decodesOf: (line) => decodes[line], matchesOf: (t) => matches[t.line] || [] });

test("coverage of a definition over the telegrams of a message, with what is still to check", () => {
  const telegrams = [{ line: "a", master: "3115b52406060009010700", n: 100, first_ms: 1, last_ms: 5 }, { line: "b", master: "3115b52406060009010700", n: 50, first_ms: 2, last_ms: 9 }, { line: "c", master: "3115b52406060009010700", n: 1, first_ms: 3, last_ms: 4 }];
  const ok = (text, fields) => ({ result: "ok", text, fields });
  const core = fake(telegrams, { a: new Map([["k", ok("v=7", { v: 7 })]]), b: new Map([["k", ok("v=9", { v: 9 })], ["x", { result: "ERR_INVALID_POS" }]]) }, { c: ["k"] });
  const cov = coverage(core, telegrams, "k");
  assert.deepEqual([cov.ok, cov.errors, cov.pending, cov.occurrences, cov.okOccurrences], [2, 0, 1, 150, 150]);
  assert.equal(cov.latest.text, "v=9");
  assert.deepEqual([...cov.values.keys()], ["v=7", "v=9"]);
  assert.deepEqual(summarizeFields(cov), [{ name: "v", kind: "range", min: 7, max: 9, distinct: 2 }]);
  const bad = coverage(core, telegrams, "x");
  assert.deepEqual([bad.ok, bad.errors, [...bad.errorKinds]], [0, 1, [["ERR_INVALID_POS", 1]]]);
  assert.equal(rowTelegrams(core, { qq: null, zz: 0x15, pb: 0xb5, sb: 0x24, id: "060009", anyQq: true }).length, 3);
  assert.equal(rowTelegrams(core, { qq: null, zz: 0x15, pb: 0xb5, sb: 0x24, id: "0601", anyQq: true }).length, 0);
});

test("why a candidate is not what ebusd uses", () => {
  const scan = { 15: { manufacturer: "Vaillant", ident: "70000", sw: "0413", hw: "6903", file: "vaillant/15.700.csv" } };
  assert.match(whyNot({ status: "variant", zz: "15", file: "vaillant/15.720.csv" }, scan), /15\.720\.csv is only loaded for another device variant.*identifies as Vaillant 70000.*loads 15\.700\.csv/);
  assert.match(whyNot({ status: "variant", zz: "26", file: "vaillant/26.vr_70.csv" }, scan), /No identification of device 26/);
  assert.match(whyNot({ status: "conditional", condition: "[id_sw>=413]", conditions: [{ circuit: "scan", message: "scan", field: "SW", value: [413, 4294967295] }], file: "x.csv" }, scan), /condition \[id_sw>=413\] was not met.*SW ≥ 413/);
  assert.match(whyNot({ status: "hidden", file: "x.csv" }, scan, null, { circuit: "700", name: "Z1RoomTemp", file: "vaillant/15.700.csv", write: false, passive: false }), /finds 700 Z1RoomTemp \(active read\) from 15\.700\.csv first/);
  assert.match(whyNot({ status: "error", file: "x.csv" }, scan, new Map([["ERR_INVALID_POS", 3]])), /does not decode.*ERR_INVALID_POS ×3/);
  assert.match(whyNot({ status: "error", file: "x.csv", error: "element not found, field type UNI in field 0" }, scan), /rejects this line: element not found/);
  assert.equal(whyNot({ status: "active", file: "x.csv" }, scan), "ebusd uses this definition.");
  assert.match(whyNot({ status: "pending", file: "x.csv" }, scan), /Not checked/);
});

test("conditions and kinds are put in words", () => {
  const def = { conditions: [{ name: "Ehp_heatpumptype", circuit: "ehp", message: "HeatPumpType", field: "type", value: [3] }, { name: "id_sw", circuit: "scan", message: "scan", field: "SW", value: [413, 4294967295] }] };
  assert.equal(describeConditions(def), "ehp HeatPumpType type = 3 and the device identification SW ≥ 413");
  assert.equal(describeConditions({}), "");
  assert.equal(kindSuffix({ passive: false, write: false }), "");
  assert.equal(kindSuffix({ passive: true, write: true }), " · passive write");
  assert.equal(accessKind({ passive: true, write: false }), "passive read");
  const kinds = Object.entries(KIND_CODES).map(([k, code]) => `${k} · ${KIND_HELP[k]} · ${code}`);
  assert.equal(kinds[0], "active read · ebusd polls this value from the device · r");
});

// -- the value history ---------------------------------------------------------------------------------------

test("value history: points of a message get the values a definition decoded", () => {
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

test("a definition is prefilled from the message and the telegrams", () => {
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
  assert.equal(define.isMasterAddress(0x31), true);
  assert.equal(define.isMasterAddress(0x08), false);
  const csv = define.buildCsv({ type: "r", circuit: "hmu", name: "Test", comment: "c, d", qq: "", zz: "08", pbsb: "b511", id: "01" }, { m: [], s: define.initialSegments(3) });
  assert.equal(csv, 'r,hmu,Test,"c, d",,08,b511,01,answer,s,HEX:3,,,');
});

test("bytes are analysed and interpreted over the history", () => {
  const sample = (hex, ms) => ({ m: new Uint8Array(0), s: define.hexToBytes(hex), n: 1, last_ms: ms });
  const samples = [sample("01a001", 1), sample("01b001", 2), sample("01c801", 3)];   // flag, temperature (2 bytes), flag
  const a = define.analyzeBytes(samples, "s");
  assert.equal(a.length, 3);
  assert.deepEqual(a.bytes.map((b) => b.distinct), [1, 3, 1]);
  const d2c = define.interpretations(samples, "s", 1).find((i) => i.type === "D2C");
  assert.equal(d2c.latest, 0x01c8 / 16);
  assert.equal(d2c.name, "sixteenths, two bytes", "the plain name travels with the interpretation");
  assert.deepEqual([d2c.min, d2c.max], [0x01a0 / 16, 0x01c8 / 16]);
  assert.equal(define.interpretations(samples, "s", 1).find((i) => i.type === "ULG"), undefined, "a type that needs more bytes than there are does not fit");
  assert.deepEqual(Object.keys(define.TYPES).filter((t) => !define.TYPES[t].name || !define.TYPES[t].label), [], "every type has a name and an explanation");
});

test("the types of ebusd read the bytes as ebusd does, in plain words", () => {
  const d = (code, hex) => types.TYPE_BY_CODE[code].decode(hex.match(/../g).map((x) => parseInt(x, 16)));
  assert.deepEqual([d("UCH", "41"), d("UCH", "ff"), d("SCH", "ff"), d("SCH", "80"), d("D1B", "81")], [65, null, -1, null, -127]);
  assert.deepEqual([d("D1C", "64"), d("D1C", "ff"), d("D1C", "d0")], [50, null, undefined], "D1C: half steps up to 100, more cannot be read");
  assert.deepEqual([d("D2C", "9001"), d("D2C", "0080"), d("D2C", "f0ff"), d("D2B", "8001"), d("FLT", "e803"), d("FLR", "03e8")], [25, null, -1, 1.5, 1, 1]);
  assert.deepEqual([d("UIN", "41ff"), d("UIR", "ff41"), d("SIN", "ffff"), d("SIN", "0080"), d("SIR", "8000")], [65345, 65345, -1, null, null]);
  assert.deepEqual([d("U3N", "010000"), d("U3R", "000001"), d("S3N", "ffffff"), d("U3N", "ffffff")], [1, 1, -1, null]);
  assert.deepEqual([d("ULG", "01000000"), d("ULG", "ffffffff"), d("SLG", "ffffffff"), d("SLR", "ffffffff")], [1, null, -1, -1]);
  assert.deepEqual([d("EXP", "0000803f"), d("EXR", "3f800000"), d("EXP", "0000c07f")], [1, 1, null], "floating point, both byte orders, NaN is no value");
  assert.deepEqual([d("BCD", "42"), d("BCD", "4a"), d("BCD", "ff"), d("PIN", "1234"), d("HCD", "78563412")], [42, undefined, null, 1234, 12345678]);
  assert.deepEqual([d("BI0", "01"), d("BI3", "08"), d("BI7", "7f"), d("BI7", "80")], [1, 1, 0, 1]);
  assert.deepEqual([d("HTI", "173b05"), d("BTI", "053917"), d("VTI", "053b17"), d("HTI", "ff0000"), d("HTI", "180000")], ["23:59:05", "17:39:05", "23:59:05", null, undefined]);
  assert.deepEqual([d("HTM", "0c1e"), d("BTM", "3012"), d("VTM", "1e0c"), d("MIN", "5a00"), d("MIN", "ffff"), d("TTM", "8a"), d("TTM", "90")], ["12:30", "12:30", "12:30", "01:30", null, "23:00", null]);
  assert.deepEqual([d("TTH", "03"), d("TTQ", "05")], ["01:30", "01:15"]);
  assert.deepEqual([d("BDA", "27100126"), d("HDA", "1b0a011a"), d("BDA", "ff000000"), d("DAY", "0100"), d("DTM", "3c000000")], ["27.10.2026", "27.10.2026", null, "02.01.1900", "01.01.2009 01:00"]);
  assert.deepEqual([d("BDY", "00"), d("BDY", "07"), d("HDY", "07"), d("HDY", "00")], ["Mon", null, "Sun", null]);
  assert.deepEqual([d("STR", "4142"), d("NTS", "410042"), d("HEX", "0a1b"), d("IGN", "0a")], ["AB", "A", "0a 1b", ""]);
  for (const t of types.TYPES) {
    assert.ok(t.name && t.meaning && t.uses && t.none, `${t.code} is explained`);
    assert.equal(byteLengthOf(t.code), t.bytes, `${t.code}: the pool and the table agree on the length`);
  }
  assert.deepEqual(Object.keys(define.TYPES).slice(0, 3), ["UCH", "SCH", "D1B"], "define.js keeps the number types");
});

test("the picker ranks the types by what the bytes look like, and prefills an enumeration and the bits", () => {
  const s = (bytes, ms, n = 1) => ({ n, last_ms: ms, m: [], s: bytes });
  // 20.0 .. 22.75 °C as D2C (320 + 4 i sixteenths), the high byte constant
  const temps = [...Array(12).keys()].map((i) => s([(320 + 4 * i) & 0xff, (320 + 4 * i) >> 8], 1000 * i));
  const ranked = types.interpretations(temps, "s", 0, { available: 2 });
  assert.equal(ranked[0].code, "D2C");
  assert.match(ranked[0].hint, /temperature/);
  assert.deepEqual([ranked[0].min, ranked[0].max, ranked[0].distinct], [20, 22.75, 12]);
  assert.equal(ranked.find((i) => i.code === "ULG"), undefined, "a type that needs more bytes than are available is not offered");
  assert.equal(ranked.find((i) => i.code === "HEX"), undefined, "raw types are picked with a length, not ranked");
  const latest = types.interpretations(temps, "s", 0, { available: 2, latestBytes: [0x50, 0x01] }).find((i) => i.code === "D2C");
  assert.equal(latest.value, 21, "the value column reads the telegram shown, the range the recording");
  // a counter in four bytes
  const counter = [...Array(6).keys()].map((i) => s([7 * i, 0, 0, 0], 1000 * i));
  assert.match(types.interpretations(counter, "s", 0, { available: 4 }).find((i) => i.code === "ULG").hint, /grows/);
  // a state: two values, mostly off
  const states = [s([0], 1, 5), s([1], 2, 2)];
  assert.deepEqual(types.enumValues(states, "s", 0), [{ raw: 0, n: 5 }, { raw: 1, n: 2 }]);
  assert.equal(types.enumList(types.enumNames(types.enumValues(states, "s", 0))), "0=off;1=on");
  assert.equal(types.enumList({ 3: "heat pump", 0: "idle" }), "0=idle;3=heat_pump", "keys ascending, names safe for the CSV");
  assert.match(types.interpretations(states, "s", 0, { available: 1 }).find((i) => i.code === "UCH").hint, /enumeration/);
  assert.deepEqual(types.bitStats(states, "s", 0), { total: 7, on: [2, 0, 0, 0, 0, 0, 0, 0] });
  // mostly no value: not plausible
  const none = [s([0xff], 1, 9), s([3], 2, 1)];
  assert.equal(types.interpretations(none, "s", 0, { available: 1 }).find((i) => i.code === "UCH").score, 0);
});

test("events next to the telegrams: active stretches, the chronological list, the words", () => {
  const pump = { kind: "interval", entity: "switch.pump", label: "pump", color: "#1976d2", start_ms: 2000, end_ms: 5000 };
  const open = { kind: "interval", entity: "switch.pump", label: "pump", color: "#1976d2", start_ms: 7000, end_ms: null };
  const point = { kind: "point", entity: "sensor.out", label: "outside", start_ms: 2500, end_ms: null, value: "7.5" };
  const note = { kind: "note", entity: "", label: "tap opened", start_ms: 4000, end_ms: null, min_ms: 3000, max_ms: 4000 };
  const intervals = ev.intervalsOf([pump, point, note, open]);
  assert.deepEqual([...intervals.keys()], ["switch.pump"]);
  assert.deepEqual(ev.activeIntervals(intervals, 3000).map((e) => e.start_ms), [2000]);
  assert.deepEqual(ev.activeIntervals(intervals, 5000), [], "the end is not inside");
  assert.deepEqual(ev.activeIntervals(intervals, 99999).map((e) => e.start_ms), [7000], "an open stretch runs on");
  const rows = [{ key: "a", latest: { last_ms: 4500 } }, { key: "b", latest: { last_ms: 1000 } }];
  const items = ev.mergeTimeline(rows, [pump, point, note, open]).map((it) => (it.kind === "row" ? `row ${it.row.key}` : `${it.edge} ${it.ms}`));
  assert.deepEqual(items, ["start 7000", "end 5000", "row a", "note 4000", "point 2500", "start 2000", "row b"], "the newest first, an interval as its start and its end");
  assert.deepEqual([ev.describeEvent(pump, "start"), ev.describeEvent(pump, "end"), ev.describeEvent(point, "point"), ev.describeEvent(note, "note")], ["pump on", "pump off", "outside = 7.5", "note: tap opened"]);
  assert.deepEqual([ev.defaultMode("switch.pump"), ev.defaultMode("sensor.out")], ["interval", "value"]);
  assert.match(ev.defaultColor("switch.pump"), /^#[0-9a-f]{6}$/);
});

// -- the eBUS specification ------------------------------------------------------------------------------------

test("addresses and commands are named from the specification and the scan", () => {
  assert.equal(spec.isMaster(0x10), true);
  assert.equal(spec.isMaster(0x08), false);
  assert.equal(spec.slaveOf(0x03), 0x08);
  assert.equal(spec.slaveOf(0xff), 0x04);
  assert.equal(spec.masterOf(0x15), 0x10);
  const devices = { "08": { ident: "HMU00", hw: "5103" }, 15: { ident: "70000", hw: "6903" } };
  assert.equal(spec.addressName("08", { devices }), "HMU HW5103");
  assert.equal(spec.addressName("10", { devices }), "700 HW6903", "a master is named after its slave side");
  assert.equal(spec.addressName("31", { devices, own: "31" }), "ebusd");
  assert.equal(spec.addressName("03", {}), "burner control unit 1");
  assert.equal(spec.addressName("fe", {}), "broadcast");
  assert.equal(spec.addressName("52", {}), "mixer 3");
  assert.match(spec.describeAddress("10", { devices }), /master 2 of the specification/);
  assert.equal(spec.commandInfo("0704").service, "identification (manufacturer, device id, software and hardware version)");
  assert.match(spec.commandInfo("b509").primary, /Vaillant/);
  assert.equal(spec.manufacturerName(0xb5), "Vaillant");
});
