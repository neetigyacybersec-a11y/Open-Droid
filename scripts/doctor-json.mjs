#!/usr/bin/env node
// ISSUE-150: machine-readable doctor output. The same collector renders the
// human output in scripts/doctor.mjs.
import { collectDoctor, DOCTOR_SCHEMA, formatDoctor } from "./installer/doctor.mjs";

const args = new Set(process.argv.slice(2));
const report = collectDoctor();
if (args.has("--schema")) {
  console.log(JSON.stringify({ schema: DOCTOR_SCHEMA, path: "install/doctor.schema.json" }));
} else if (args.has("--human")) {
  console.log(formatDoctor(report));
} else {
  console.log(JSON.stringify(report, null, 2));
}
process.exitCode = report.summary.ok ? 0 : 1;
