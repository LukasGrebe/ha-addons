// The scratchpad's lines: your own definitions as ebusd CSV lines, one per message, stored in the
// app's settings so that every browser sees them. They are a source like the others (decoded over
// the whole recording as soon as they change) and never ebusd's choice: you pick them.
import { api, app, toast } from "./app.js";
import { mineKey, splitCsv } from "./setup.js";

/** The key of a definition line (type, circuit, name decide it), or null for comments and junk. */
export function keyOfLine(line) {
  const text = String(line || "").trim();
  if (!text || text.startsWith("#") || /^type\s*,/i.test(text)) return null;
  const cells = splitCsv(text);
  if (cells.length < 3) return null;
  const type = cells[0].replace(/^\[[^\]]*\]/, "");
  return mineKey({ type, circuit: cells[1], name: cells[2] });
}

export const mineText = () => app.settings?.custom || "";

/** The definition lines of the scratchpad: [{key, line, index}]. */
export function mineLines(text = mineText()) {
  return text.split("\n").map((line, index) => ({ key: keyOfLine(line), line: line.trim(), index })).filter((l) => l.key);
}

export async function setMineText(text) {
  const clean = `${String(text || "").trimEnd()}${String(text || "").trim() ? "\n" : ""}`;
  try {
    app.settings = await api.put("api/settings", { custom: clean });
  } catch (err) { toast(`saving your definitions failed: ${err.message}`, "err"); throw err; }
  await app.builder?.setMine(clean);
  return clean;
}

/**
 * Put a definition line into the scratchpad: it replaces the line of oldKey (editing your own
 * definition) or the line of the same message, else it is added. Returns the key the decoder gives it.
 */
export async function upsertMine(csv, oldKey = null) {
  const line = String(csv || "").trim().replace(/\s*\n\s*/g, " ");
  const key = keyOfLine(line);
  if (!key) throw new Error("this is not a definition line (type,circuit,name,…)");
  const lines = mineText().split("\n");
  const at = lines.findIndex((l) => keyOfLine(l) === (oldKey || key));
  if (at >= 0) lines[at] = line; else { while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); lines.push(line); }
  await setMineText(lines.join("\n"));
  return key;
}

export async function removeMine(key) {
  const lines = mineText().split("\n").filter((l) => keyOfLine(l) !== key);
  await setMineText(lines.join("\n"));
}
