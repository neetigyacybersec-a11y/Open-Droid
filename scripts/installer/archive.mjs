// ISSUE-148: extract into a staging directory using only platform-provided
// tools, so the installer needs no extra npm dependency on a clean machine.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result;
}

/** Flatten a single-archive root when strip=1 (Gradle's top-level folder). */
function stripRoot(dir, strip) {
  if (!strip) return;
  const entries = readdirSync(dir).filter((name) => !name.startsWith("."));
  if (entries.length !== 1) return;
  const only = join(dir, entries[0]);
  if (!statSync(only).isDirectory()) return;
  for (const name of readdirSync(only)) {
    renameSync(join(only, name), join(dir, name));
  }
  rmSync(only, { recursive: true, force: true });
}

/** Extract archive into a fresh staging path and return that path. */
export function extractArchive({ archive, dest, strip = 0, runner = run, platform = process.platform } = {}) {
  mkdirSync(dest, { recursive: true });
  const name = basename(archive);
  if (/\.tar\.gz$|\.tgz$/.test(name)) {
    runner("tar", ["-xzf", archive, "-C", dest]);
  } else if (/\.zip$/.test(name)) {
    if (platform === "win32") {
      runner("powershell", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`,
      ]);
    } else {
      runner("unzip", ["-q", "-o", archive, "-d", dest]);
    }
  } else if (/\.(jar|bin|exe)$/.test(name)) {
    copyFileSync(archive, join(dest, name));
  } else {
    throw new Error(`unsupported archive type: ${name}`);
  }
  stripRoot(dest, strip);
  return dest;
}

/** Decompress an .xz asset without a shell, preserving binary bytes. */
export function extractXz({ archive, dest }) {
  const result = spawnSync("xz", ["-dc", archive], { encoding: "buffer" });
  if (result.status !== 0) throw new Error(`xz -dc ${archive} failed`);
  writeFileSync(dest, result.stdout);
  return dest;
}

/** Local helper so tests can stub process execution without touching the host. */
export const defaultRunner = run;
