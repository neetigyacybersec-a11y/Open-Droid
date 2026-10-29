// Contract test for the shipped Frida script library (frida-scripts/).
// Run from the repo root: node test/frida-scripts.test.mjs
//
// Every script must be a standalone Frida agent: a `CONFIG` guard first,
// `[open-droid]`-prefixed logging, and syntactically valid JS (parsed here,
// never executed — the scripts assume Frida's Java/Interceptor globals).
import { readFileSync, readdirSync } from "node:fs";
import { strict as assert } from "node:assert";
import { Script } from "node:vm";

const EXPECTED = [
  "api-trace.js",
  "class-dump.js",
  "crypto-trace.js",
  "hook-method.js",
  "root-bypass.js",
  "ssl-unpin.js",
];

const files = readdirSync("frida-scripts").filter((f) => f.endsWith(".js"));
assert.deepEqual(files.length, 6, `expected 6 scripts, got ${files.length}`);
assert.deepEqual(files.slice().sort(), EXPECTED, "unexpected frida-scripts/ contents");

for (const f of files) {
  const src = readFileSync(`frida-scripts/${f}`, "utf8");
  assert.ok(src.includes("var CONFIG = CONFIG || {};"), `${f} missing CONFIG guard`);
  assert.ok(src.includes("[open-droid]"), `${f} missing [open-droid] prefix`);
  assert.ok(
    src.split("\n").length <= 120,
    `${f} exceeds the 120-line budget (${src.split("\n").length})`,
  );
  // Parse check: catches syntax errors that would only surface at attach time.
  new Script(src, { filename: f });
}

console.log("frida-scripts test passed:", files.length);
