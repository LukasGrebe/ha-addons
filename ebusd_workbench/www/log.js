// Noting events like the `log` command of the eBUSd app's terminal does: what you did or saw, when it
// happened and how exactly you know that time, stored in the telegram database to find the telegrams
// of that moment. These helpers turn the form into the terminal's command line (for reference) and back.
const UNITS = [["h", 3600_000], ["m", 60_000], ["s", 1000], ["ms", 1]];

/** 500 -> "500ms", 120000 -> "2m": the largest unit that divides evenly, as `log` reads it. */
export function durationText(ms) {
  for (const [unit, size] of UNITS) if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  return `${ms}ms`;
}

export const toMs = (value, unit) => Math.round(Number(value || 0) * ({ ms: 1, s: 1000, min: 60_000, h: 3600_000 }[unit] || 1));

/** {value, unit} of a duration, for the form. */
export function fromMs(ms) {
  for (const [unit, size] of [["h", 3600_000], ["min", 60_000], ["s", 1000]]) if (ms >= size && ms % size === 0) return { value: ms / size, unit };
  return { value: ms, unit: "ms" };
}

const pad = (n) => String(n).padStart(2, "0");

/** The time as `log` takes it: H:MM:SS(.f), with the date unless it is today. */
export function timeText(ms, today = new Date()) {
  const d = new Date(ms);
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  const fraction = d.getMilliseconds() ? `.${String(d.getMilliseconds()).padStart(3, "0").replace(/0+$/, "")}` : "";
  return `${sameDay ? "" : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `}${d.getHours()}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${fraction}`;
}

/** The terminal command that notes the same event. whole: only the minute is known (8:52 is 8:52:00 to 8:53:00). */
export function logCommand({ message = "", now = false, ms, beforeMs = 500, afterMs = 500, whole = false, today = new Date() }) {
  const parts = ["log"];
  if (!now) {
    const text = timeText(ms, today);
    parts.push(whole ? text.replace(/:\d{2}(\.\d+)?$/, "") : text);
  }
  if (!whole) {
    if (beforeMs === afterMs) { if (beforeMs !== 500) parts.push(`~${durationText(beforeMs)}`); }
    else parts.push(`${beforeMs ? `-${durationText(beforeMs)}` : ""}${afterMs ? `+${durationText(afterMs)}` : ""}` || "~0ms");
  }
  const text = message.trim();
  if (text) parts.push(/^(\d{1,2}:\d{2}|\d{4}-\d|\d{1,2}\.\d{1,2}\.|[~±+-])/.test(text) ? `-- ${text}` : text);
  return parts.join(" ");
}

/** The range an event may have happened in. */
export function eventRange({ ms, beforeMs, afterMs, whole }) {
  if (whole) { const start = Math.floor(ms / 60_000) * 60_000; return { ms: start, min: start, max: start + 60_000 }; }
  return { ms, min: ms - beforeMs, max: ms + afterMs };
}

export const PRESETS = [
  ["±500 ms", { beforeMs: 500, afterMs: 500, whole: false }],
  ["±2 s", { beforeMs: 2000, afterMs: 2000, whole: false }],
  ["±10 s", { beforeMs: 10_000, afterMs: 10_000, whole: false }],
  ["the whole minute", { beforeMs: 0, afterMs: 0, whole: true }],
  ["up to 10 min before", { beforeMs: 600_000, afterMs: 0, whole: false }],
  ["up to 1 h before", { beforeMs: 3600_000, afterMs: 0, whole: false }],
];
