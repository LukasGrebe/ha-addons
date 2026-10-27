// Tiny POSIX `path` subset for browser bundles (used by the eBUS TypeSpec emitter).
export const sep = "/";
export function basename(p, ext) {
  let b = p.replace(/\/+$/, "");
  b = b.slice(b.lastIndexOf("/") + 1);
  if (ext && b.endsWith(ext) && b !== ext) b = b.slice(0, -ext.length);
  return b;
}
export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i);
}
export function dirname(p) {
  const s = p.replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i === -1 ? "." : i === 0 ? "/" : s.slice(0, i);
}
export function isAbsolute(p) { return p.startsWith("/"); }
export function normalize(p) {
  const abs = isAbsolute(p);
  const out = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else if (!abs) out.push(".."); }
    else out.push(part);
  }
  return (abs ? "/" : "") + out.join("/") || (abs ? "/" : ".");
}
export function join(...parts) { return normalize(parts.filter(Boolean).join("/")); }
export function resolve(...parts) {
  let r = "";
  for (const part of parts) r = isAbsolute(part) ? part : r ? r + "/" + part : part;
  return normalize(isAbsolute(r) ? r : "/" + r);
}
export function relative(from, to) {
  const f = normalize(from).split("/").filter(Boolean), t = normalize(to).split("/").filter(Boolean);
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  return [...Array(f.length - i).fill(".."), ...t.slice(i)].join("/");
}
export default { sep, basename, extname, dirname, isAbsolute, normalize, join, resolve, relative };
