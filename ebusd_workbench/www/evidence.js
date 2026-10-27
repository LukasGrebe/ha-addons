// ebus-evidence profiles: run the checks of a profile (https://github.com/MarcelT87/ebus-evidence)
// against the recorded telegrams. The profile's match rules work on frames with source, target,
// pbsb, request (NN + data bytes of the master part) and response (NN + data bytes of the answer).
import { fmt } from "./app.js";

const SIZES = { u8: 1, u16le: 2, s16le: 2, u32le: 4, s32le: 4, float32le: 4 };

export function frameOf(telegram, ownAddress = "31") {
  const master = telegram.master;
  return {
    source: master.slice(0, 2), target: master.slice(2, 4), pbsb: master.slice(4, 8),
    request: master.slice(8), response: telegram.slave || null,
    initiated_by_ebusd: master.slice(0, 2) === ownAddress,
  };
}

export function frameMatches(frame, rule) {
  const norm = (v) => String(v).trim().toLowerCase();
  for (const field of ["source", "target", "pbsb"]) if (field in rule && norm(frame[field]) !== norm(rule[field])) return false;
  if ("initiated_by_ebusd" in rule && frame.initiated_by_ebusd !== Boolean(rule.initiated_by_ebusd)) return false;
  const request = frame.request.toLowerCase();
  if ("request" in rule && request !== norm(rule.request)) return false;
  if ("request_prefix" in rule && !request.startsWith(norm(rule.request_prefix))) return false;
  const response = (frame.response || "").toLowerCase();
  if ("response" in rule && response !== norm(rule.response)) return false;
  if ("response_prefix" in rule && !response.startsWith(norm(rule.response_prefix))) return false;
  return true;
}

export function decodeValue(frame, spec) {
  const source = spec.from || "response";
  const hex = source === "request" ? frame.request : frame.response;
  if (!hex) throw new Error(`frame has no ${source}`);
  const bytes = Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
  const offset = Number(spec.offset || 0);
  const type = String(spec.type || "hex").toLowerCase();
  if (type === "hex") {
    const raw = spec.length === undefined ? bytes.slice(offset) : bytes.slice(offset, offset + Number(spec.length));
    if (!raw.length) throw new Error("hex slice is empty");
    return [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const size = SIZES[type];
  if (!size) throw new Error(`unsupported value type ${type}`);
  const raw = bytes.slice(offset, offset + size);
  if (raw.length !== size) throw new Error("value extends beyond available bytes");
  const view = new DataView(raw.buffer, raw.byteOffset, size);
  switch (type) {
    case "u8": return raw[0];
    case "u16le": return view.getUint16(0, true);
    case "s16le": return view.getInt16(0, true);
    case "u32le": return view.getUint32(0, true);
    case "s32le": return view.getInt32(0, true);
    case "float32le": return Math.round(view.getFloat32(0, true) * 1e6) / 1e6;
    default: throw new Error(`unsupported value type ${type}`);
  }
}

/**
 * @param {object} profile parsed profile YAML ({name, version, checks: [{id, description, match, value}]})
 * @param {Array} telegrams distinct telegrams with master, slave, n, first_ms, last_ms
 */
export function runProfile(profile, telegrams, ownAddress = "31") {
  const checks = Array.isArray(profile?.checks) ? profile.checks : [];
  const frames = telegrams.map((t) => ({ t, frame: frameOf(t, ownAddress) }));
  const results = checks.map((check) => {
    const result = { id: check.id, description: check.description || check.id, match: check.match || {}, distinct: 0, occurrences: 0,
      first_ms: null, last_ms: null, values: new Map(), responses: new Map(), decodeErrors: 0, telegrams: [] };
    for (const { t, frame } of frames) {
      if (!frameMatches(frame, check.match || {})) continue;
      result.distinct++;
      result.occurrences += t.n || 1;
      result.first_ms = result.first_ms === null ? t.first_ms : Math.min(result.first_ms, t.first_ms);
      result.last_ms = result.last_ms === null ? t.last_ms : Math.max(result.last_ms, t.last_ms);
      result.telegrams.push(t);
      if (frame.response) result.responses.set(frame.response, (result.responses.get(frame.response) || 0) + (t.n || 1));
      if (check.value) {
        try {
          const value = decodeValue(frame, check.value);
          result.values.set(String(value), (result.values.get(String(value)) || 0) + (t.n || 1));
        } catch { result.decodeErrors++; }
      }
    }
    return result;
  });
  return { profile: profile?.name || "?", version: profile?.version, checks: results };
}

export function summaryJson(run, windowFrom, windowTo) {
  return {
    format: "ebusd-workbench-evidence-summary-v1",
    note: "Summary of the checks of an ebus-evidence profile over the telegrams recorded by the eBUSd app. "
      + "Not a verified ebus-evidence bundle: produce that with ebus-evidence from the exported raw log.",
    profile: run.profile, profile_version: run.version,
    window: { from: new Date(windowFrom).toISOString(), to: new Date(windowTo).toISOString() },
    checks: run.checks.map((c) => ({
      id: c.id, description: c.description, matches: c.occurrences, distinct_telegrams: c.distinct,
      first_seen: c.first_ms === null ? null : new Date(c.first_ms).toISOString(),
      last_seen: c.last_ms === null ? null : new Date(c.last_ms).toISOString(),
      values: Object.fromEntries([...c.values.entries()].sort((a, b) => b[1] - a[1])),
      responses: Object.fromEntries([...c.responses.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50)),
      decode_errors: c.decodeErrors,
    })),
  };
}

export function describeMatch(match) {
  return Object.entries(match || {}).map(([k, v]) => `${k}=${v}`).join(" ");
}

export const fmtTime = (ms) => (ms === null || ms === undefined ? "–" : fmt.dateTime(ms));
