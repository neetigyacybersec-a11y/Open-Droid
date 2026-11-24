#!/usr/bin/env node
// ISSUE-154: remove only resources the install manifest says Open-Droid owns.
// Dry-run by default. Missing/corrupt ownership is conservative, not destructive.
import { lstatSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ADAPTERS, SUPPORTED_CLIENTS, inspectClient, unregisterClient } from "./clients.mjs";
import { ownedPaths, readManifest } from "./installer/manifest.mjs";

const REPO = resolve(new URL("..", import.meta.url).pathname);

function safePath(path) {
  try {
    const info = lstatSync(path);
    return !info.isSymbolicLink();
  } catch {
    return false;
  }
}

export function planUninstall({
  root = join(REPO, ".toolchain"),
  home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
  project = REPO,
  keep = [],
} = {}) {
  const installRoot = resolve(root);
  const manifest = readManifest(installRoot);
  const report = {
    conservative: !manifest,
    installRoot,
    deleted: [],
    retained: [],
    skipped: [],
    failed: [],
    registrations: [],
  };
  if (!manifest) {
    report.skipped.push({ path: installRoot, reason: "missing or corrupt ownership manifest" });
    return report;
  }
  for (const owned of ownedPaths(manifest, resolve(installRoot, ".."))) {
    const rel = relative(installRoot, owned.absolute);
    // Only manifest entries under the managed root are eligible.
    if (rel.startsWith("..") || rel.startsWith(sep)) {
      report.skipped.push({ path: owned.absolute, reason: "outside managed root" });
      continue;
    }
    const category = pathCategory(owned.absolute);
    if (keep.includes(category)) {
      report.retained.push({ path: owned.absolute, reason: `kept: ${category}` });
      continue;
    }
    if (!safePath(owned.absolute)) {
      report.skipped.push({ path: owned.absolute, reason: "missing or symlink; not followed" });
      continue;
    }
    report.deleted.push({ path: owned.absolute, category });
  }
  for (const client of SUPPORTED_CLIENTS) {
    const status = inspectClient(client, { home, project });
    if (!status.supported || !status.registered) continue;
    report.registrations.push({ client, scope: status.scope, path: status.path });
  }
  return report;
}

function pathCategory(path) {
  if (path.includes(`${sep}gradle-home`) || path.includes(`${sep}cache`)) return "cache";
  if (path.endsWith("install-manifest.json") || path.includes(`${sep}generations${sep}`)) return "config";
  return "toolchain";
}

export function executeUninstall(options = {}) {
  const report = planUninstall(options);
  if (options.dryRun !== false) return { ...report, dryRun: true };
  if (!options.yes) throw new Error("uninstall requires --yes (dry run is the default)");
  if (report.conservative) return report;
  for (const entry of report.deleted) {
    try {
      rmSync(entry.path, { recursive: true, force: true });
    } catch (error) {
      report.failed.push({ path: entry.path, reason: error.message });
    }
  }
  for (const registration of report.registrations) {
    try {
      const result = unregisterClient(registration.client, {
        home: options.home,
        project: options.project,
        scope: registration.scope,
      });
      registration.removed = result.changed;
    } catch (error) {
      report.failed.push({ path: registration.path, reason: error.message });
    }
  }
  return { ...report, dryRun: false };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const report = executeUninstall({
    root: value("--root"),
    home: value("--home"),
    project: value("--project"),
    keep: (value("--keep") ?? "").split(",").filter(Boolean),
    dryRun: !argv.includes("--yes"),
    yes: argv.includes("--yes"),
  });
  console.log(JSON.stringify(report, null, 2));
}
