// Value history of a candidate definition over the whole recording: one point per telegram
// (timestamp from the database, value decoded with the definition from the browser store).
import { valueColors } from "./colors.js";

const hex2 = (n) => n.toString(16).padStart(2, "0");

/** The query for the series of a timeline row. */
export function seriesQuery(row, fromMs, toMs, max = 20000) {
  const a = (v) => (v === null || v === undefined ? "--" : hex2(v));
  return `api/telegrams/series?from=${Math.floor(fromMs)}&to=${Math.ceil(toMs)}&qq=${a(row.qq)}&zz=${a(row.zz)}&pb=${a(row.pb)}&sb=${a(row.sb)}&id=${encodeURIComponent(row.id || "")}&max=${max}`;
}

/** The field names a definition decoded over a series (the first telegram it decoded tells). */
export function seriesFields(data, decoder, defKey) {
  for (const line of data.lines) {
    const d = decoder.decodesOf(line)?.get(defKey);
    if (d && d.result === "ok" && d.fields) return Object.keys(d.fields);
  }
  return [];
}

/**
 * The values of one field of a definition over a series: [{ms, value}] in time order. Points whose
 * telegram the definition does not decode (another message sharing the row) are left out.
 * numeric: every value is a finite number.
 */
export function seriesValues(data, decoder, defKey, field) {
  const byLine = data.lines.map((line) => {
    const d = decoder.decodesOf(line)?.get(defKey);
    if (!d || d.result !== "ok") return undefined;
    if (field && d.fields && field in d.fields) return d.fields[field];
    return field ? undefined : d.text;
  });
  const points = [];
  let numeric = true;
  for (const [ms, index] of data.points) {
    const value = byLine[index];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) numeric = false;
    points.push({ ms, value });
  }
  return { points, numeric: numeric && points.length > 0, field };
}

/** Nearest point to a time (binary search), or null. */
export function nearestPoint(series, ms) {
  const p = series.points;
  if (!p.length) return null;
  let lo = 0, hi = p.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (p[mid].ms < ms) lo = mid + 1; else hi = mid;
  }
  const a = p[lo], b = p[lo - 1];
  return b && Math.abs(b.ms - ms) < Math.abs(a.ms - ms) ? b : a;
}

const pad = (n) => String(n).padStart(2, "0");
const stamp = (ms) => { const d = new Date(ms); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/**
 * Draw the series: numbers as a line through the mean of every pixel column with the min–max band
 * behind it, other values as dots on one lane per distinct value (most frequent first).
 * Returns the geometry for hit testing: {xOf, tOf}.
 */
export function drawChart(canvas, series, { t0, t1, width, height, band = null, hoverMs = null }) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const L = 46, R = 8, T = 8, B = 18;
  const w = width - L - R, h = height - T - B;
  const xOf = (ms) => L + ((ms - t0) / (t1 - t0)) * w;
  const tOf = (x) => t0 + ((x - L) / w) * (t1 - t0);
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillStyle = "#6b7a8a";
  ctx.strokeStyle = "#eef1f4";
  for (let i = 0; i <= 5; i++) {
    const x = L + (w * i) / 5;
    ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, T); ctx.lineTo(Math.round(x) + 0.5, T + h); ctx.stroke();
    const label = stamp(t0 + ((t1 - t0) * i) / 5);
    ctx.fillText(label, Math.min(Math.max(2, x - ctx.measureText(label).width / 2), width - ctx.measureText(label).width - 2), height - 5);
  }
  if (band && band.to > t0 && band.from < t1) {
    ctx.fillStyle = "rgba(11,125,218,.12)";
    const x0 = Math.max(L, xOf(band.from)), x1 = Math.min(L + w, xOf(band.to));
    ctx.fillRect(x0, T, Math.max(2, x1 - x0), h);
  }
  const points = series.points.filter((p) => p.ms >= t0 && p.ms <= t1);
  ctx.fillStyle = "#6b7a8a";
  if (!points.length) { ctx.fillText("no values", L + 4, T + 14); return { xOf, tOf, L, w }; }
  if (series.numeric) {
    let min = Infinity, max = -Infinity;
    for (const p of points) { min = Math.min(min, p.value); max = Math.max(max, p.value); }
    if (min === max) { min -= 1; max += 1; }
    const padding = (max - min) * 0.05;
    min -= padding; max += padding;
    const yOf = (v) => T + h - ((v - min) / (max - min)) * h;
    ctx.strokeStyle = "#eef1f4";
    for (let i = 0; i <= 3; i++) {
      const v = min + ((max - min) * i) / 3, y = Math.round(yOf(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + w, y); ctx.stroke();
      ctx.fillStyle = "#6b7a8a"; ctx.fillText(Number(v.toPrecision(4)).toString(), 2, y + 3);
    }
    const columns = Math.max(1, Math.floor(w));
    const lo = new Array(columns).fill(Infinity), hi = new Array(columns).fill(-Infinity), sum = new Array(columns).fill(0), count = new Array(columns).fill(0);
    for (const p of points) {
      const c = Math.min(columns - 1, Math.max(0, Math.floor(((p.ms - t0) / (t1 - t0)) * columns)));
      lo[c] = Math.min(lo[c], p.value); hi[c] = Math.max(hi[c], p.value); sum[c] += p.value; count[c]++;
    }
    ctx.strokeStyle = "rgba(11,125,218,.30)";
    for (let c = 0; c < columns; c++) {
      if (!count[c]) continue;
      const x = L + c + 0.5;
      ctx.beginPath(); ctx.moveTo(x, yOf(hi[c])); ctx.lineTo(x, yOf(lo[c]) + 1); ctx.stroke();
    }
    ctx.strokeStyle = "#0b7dda"; ctx.lineWidth = 1.2; ctx.beginPath();
    let started = false, previous = -2;
    for (let c = 0; c < columns; c++) {
      if (!count[c]) continue;
      const x = L + c + 0.5, y = yOf(sum[c] / count[c]);
      // a gap of recorded nothing (the app was off) interrupts the line
      if (!started || c - previous > Math.max(8, columns / 20)) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      started = true; previous = c;
    }
    ctx.stroke(); ctx.lineWidth = 1;
    series.yOf = yOf;
  } else {
    const counts = new Map();
    for (const p of points) counts.set(String(p.value), (counts.get(String(p.value)) || 0) + 1);
    const lanes = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([v]) => v);
    const laneH = h / lanes.length;
    lanes.forEach((v, i) => {
      const y = T + laneH * i + laneH / 2;
      ctx.fillStyle = "#6b7a8a";
      ctx.fillText(v.length > 7 ? `${v.slice(0, 6)}…` : v, 2, y + 3);
      ctx.strokeStyle = "#eef1f4"; ctx.beginPath(); ctx.moveTo(L, Math.round(y) + 0.5); ctx.lineTo(L + w, Math.round(y) + 0.5); ctx.stroke();
    });
    for (const p of points) {
      const lane = lanes.indexOf(String(p.value));
      if (lane < 0) continue;
      ctx.fillStyle = valueColors(String(p.value)).stroke;
      ctx.fillRect(Math.round(xOf(p.ms)) - 1, T + laneH * lane + laneH / 2 - 2, 2, 4);
    }
    series.lanes = lanes;
  }
  if (hoverMs !== null && hoverMs >= t0 && hoverMs <= t1) {
    ctx.strokeStyle = "rgba(31,45,61,.4)";
    ctx.beginPath(); ctx.moveTo(Math.round(xOf(hoverMs)) + 0.5, T); ctx.lineTo(Math.round(xOf(hoverMs)) + 0.5, T + h); ctx.stroke();
  }
  return { xOf, tOf, L, w };
}
