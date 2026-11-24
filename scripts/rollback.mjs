#!/usr/bin/env node
// ISSUE-153: operational CLI for last-known-good generations.
import { resolve } from "node:path";
import { createGeneration, listGenerations, rollbackGeneration, verifyGeneration } from "./generations.mjs";

const argv = process.argv.slice(2);
const root = resolve(argv[argv.indexOf("--root") + 1] ?? ".toolchain");
const command = argv[0] ?? "list";
if (command === "list") {
  console.log(JSON.stringify(listGenerations(root), null, 2));
} else if (command === "snapshot") {
  console.log(JSON.stringify(createGeneration(root, { reason: argv[1] ?? "manual" }), null, 2));
} else if (command === "verify") {
  console.log(JSON.stringify(verifyGeneration(root, argv[1]), null, 2));
} else if (command === "rollback") {
  if (!argv[1]) throw new Error("usage: rollback <generation-id> [--root <dir>]");
  const result = rollbackGeneration(root, { id: argv[1] });
  console.log(JSON.stringify({ id: result.state.id, restored: result.restored, ok: result.doctor?.summary.ok ?? null }, null, 2));
  process.exitCode = result.doctor?.summary.ok === false ? 1 : 0;
} else {
  throw new Error(`unknown rollback command: ${command}`);
}
