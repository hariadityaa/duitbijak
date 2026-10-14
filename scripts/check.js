// Syntax and wiring checks. Run: npm run check
// Every root .js file (bar sw.js), every app/*.js file and styles.css must be
// loaded by index.html and precached by sw.js, so a new file can't be added to
// one list and forgotten in another.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(root, f), "utf8");
const errors = [];

const jsIn = dir => fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith(".js")).map(f => path.posix.join(dir, f).replace(/^\.\//, ""));
const modules = [...jsIn("."), ...jsIn("app")];
for (const f of modules) {
  try { execFileSync(process.execPath, ["--check", path.join(root, f)], { stdio: "pipe" }); }
  catch (e) { errors.push(`${f}: ${String(e.stderr || e.message).trim()}`); }
}

const html = read("index.html");
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
inline.forEach((s, i) => { try { new Function(s); } catch (e) { errors.push(`index.html inline script ${i + 1}: ${e.message}`); } });

try { JSON.parse(read("manifest.json")); } catch (e) { errors.push(`manifest.json: ${e.message}`); }

const sw = read("sw.js");
if (!html.includes('<link rel="stylesheet" href="styles.css">')) errors.push("styles.css: not linked from index.html");
if (!sw.includes('"./styles.css"')) errors.push("styles.css: missing from APP_SHELL in sw.js");
for (const f of modules.filter(f => f !== "sw.js")) {
  if (!html.includes(`<script src="${f}">`)) errors.push(`${f}: no <script src="${f}"> in index.html`);
  if (!sw.includes(`"./${f}"`)) errors.push(`${f}: missing from APP_SHELL in sw.js`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`ok: ${modules.length} scripts, ${inline.length} inline, manifest, wiring`);
