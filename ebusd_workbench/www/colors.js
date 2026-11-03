// Colours: a value (what a telegram carried) and a message (circuit and name of a definition) always
// get the same colour everywhere.

function hashHue(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) { hash ^= str.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0) % 360;
}

export function hashColor(str, sat = 55, light = 82) {
  return `hsl(${hashHue(str)} ${sat}% ${light}%)`;
}

/** Fill and border colour of a value as drawn in a chart. */
export function valueColors(value, status = "ok") {
  if (status && status !== "ok") return { fill: "rgba(198,40,40,.22)", stroke: "#c62828" };
  return { fill: hashColor(value, 55, 82), stroke: hashColor(value, 45, 50) };
}

/** Text and background colour of a message name (circuit + name). */
export function messageColors(circuit, name) {
  const key = `${circuit}/${name}`;
  return { text: hashColor(key, 60, 34), background: hashColor(key, 60, 92), border: hashColor(key, 55, 70) };
}
