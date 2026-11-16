#!/usr/bin/env node
// ISSUE-79: pack IDs and the repository root are data, never JavaScript source.
// This helper is a fixed program; callers pass values as argv.
//
//   pack-ids.mjs list  <root>          print every declared pack id
//   pack-ids.mjs check <root> <id...>  reject ids that are malformed or unknown
import { readFileSync } from "node:fs";
import path from "node:path";

const [mode, root, ...ids] = process.argv.slice(2);
const usage = "usage: pack-ids.mjs <list|check> <root> [id...]";
if (!mode || !root) {
  console.error(usage);
  process.exit(2);
}

let packs;
try {
  const manifest = JSON.parse(readFileSync(path.join(root, "manifest", "packs.json"), "utf8"));
  packs = manifest.packs;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[pack-warm] ERROR: cannot read manifest: ${message}`);
  process.exit(1);
}
if (!packs || typeof packs !== "object") {
  console.error("[pack-warm] ERROR: manifest has no packs object");
  process.exit(1);
}

if (mode === "list") {
  for (const id of Object.keys(packs)) console.log(id);
  process.exit(0);
}
if (mode !== "check") {
  console.error(usage);
  process.exit(2);
}

// Deliberately stricter than the manifest keys: an id is a lowercase
// identifier, so no quoting, whitespace or shell/JS punctuation can reach a
// generated project or a command line.
const ID_RE = /^[a-z][a-z0-9-]*$/;
for (const id of ids) {
  if (!ID_RE.test(id) || !Object.hasOwn(packs, id)) {
    console.error(`[pack-warm] ERROR: unknown pack '${id}'`);
    process.exit(1);
  }
}
