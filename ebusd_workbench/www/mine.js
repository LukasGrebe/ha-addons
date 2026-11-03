// Your own definitions: ebusd CSV lines, one per message, stored in the app's settings so that every
// browser sees them. They are a source of the pool like the others ("my definitions"), checked on the
// messages they fit the moment they are saved, and never ebusd's choice: you pick them.
import { api, app, toast } from "./app.js";
import { parseLine } from "./pool.js";

/** What makes a line "the same message" when it is replaced: destination, circuit, name and direction. */
export const identityOf = (line) => (line ? `${line.zz}|${line.circuit}|${line.name}|${line.write ? "w" : ""}${line.passive ? "u" : ""}` : null);

/** The key of a definition line (its content hash, as the pool keys it), or null for comments and junk. */
export function keyOfLine(text) {
  return parseLine(text, "mine/x.csv")?.hash || null;
}

export const mineText = () => app.settings?.custom || "";

/** The definition lines of your own: [{key, line, index, parsed}]. */
export function mineLines(text = mineText()) {
  return text.split("\n").map((raw, index) => { const parsed = parseLine(raw, "mine/x.csv"); return parsed ? { key: parsed.hash, line: raw.trim(), index, parsed } : null; }).filter(Boolean);
}

export async function setMineText(text) {
  const clean = `${String(text || "").trimEnd()}${String(text || "").trim() ? "\n" : ""}`;
  try {
    app.settings = await api.put("api/settings", { custom: clean });
  } catch (err) { toast(`saving your definitions failed: ${err.message}`, "err"); throw err; }
  await app.decoder?.setMine(clean);   // checked in the background; the page is given back at once
  return clean;
}

/**
 * Put a definition line into your definitions: it replaces the line with oldKey (editing your own
 * definition) or the line of the same message, else it is added. Returns the key (hash) the pool gives it.
 */
export async function upsertMine(csv, oldKey = null) {
  const line = String(csv || "").trim().replace(/\s*\n\s*/g, " ");
  const parsed = parseLine(line, "mine/x.csv");
  if (!parsed) throw new Error("this is not a definition line (type,circuit,name,…)");
  const lines = mineText().split("\n");
  const same = identityOf(parsed);
  const at = lines.findIndex((l) => { const p = parseLine(l, "mine/x.csv"); return p && (p.hash === oldKey || identityOf(p) === same); });
  if (at >= 0) lines[at] = line; else { while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); lines.push(line); }
  await setMineText(lines.join("\n"));
  return parsed.hash;
}

export async function removeMine(key) {
  const lines = mineText().split("\n").filter((l) => keyOfLine(l) !== key);
  await setMineText(lines.join("\n"));
}
