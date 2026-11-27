// ISSUE-149: interrupted, corrupt or concurrent installs must never activate
// a partial component. Every download lands in a .part file, is checksummed,
// and is renamed into place only after success; activation keeps a backup.
import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { ownedPath } from "./manifest.mjs";

const LOCK = ".install.lock";
const STAGING = ".install-staging";
const BACKUP = ".install-backup";

export class InstallLock {
  constructor(root) {
    this.root = resolve(root);
    this.path = join(this.root, LOCK);
  }

  acquire() {
    mkdirSync(this.root, { recursive: true });
    try {
      this.fd = openSync(this.path, "wx");
      writeFileSync(this.fd, `${process.pid}\n`);
      return this;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (isAlive(readPid(this.path))) throw new Error(`another installer is running (pid ${readPid(this.path)})`);
      rmSync(this.path, { force: true });
      return this.acquire();
    }
  }

  release() {
    if (this.fd !== undefined) closeSync(this.fd);
    rmSync(this.path, { force: true });
  }
}

function readPid(path) {
  return Number(readFileSync(path, "utf8").trim());
}
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function checkDiskSpace(root, neededBytes) {
  const stats = statfsSync(resolve(root));
  const available = stats.bavail * stats.bsize;
  const headroom = 256 * 1024 * 1024;
  if (available < neededBytes + headroom) {
    throw new Error(
      `insufficient disk space: need ${neededBytes} bytes plus ${headroom} headroom, have ${available}`,
    );
  }
  return available;
}

function resumeState(dest, url, sha256) {
  try {
    const state = JSON.parse(readFileSync(`${dest}.resume`, "utf8"));
    return state.url === url && state.sha256 === sha256 ? state : null;
  } catch {
    return null;
  }
}

/** Download, verify and atomically publish one artifact. Returns its byte count. */
export async function downloadArtifact({
  url,
  sha256,
  dest,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  signal,
} = {}) {
  if (!url || !sha256 || !dest) throw new Error("downloadArtifact needs url, sha256 and dest");
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const statePath = `${dest}.resume`;
  const prior = resumeState(dest, url, sha256);
  let offset = prior && existsSync(part) ? statSync(part).size : 0;
  if (prior && offset > prior.bytes) {
    rmSync(part, { force: true });
    offset = 0;
  }
  if (!prior || !existsSync(part)) {
    rmSync(part, { force: true });
    offset = 0;
  }
  const response = await fetchImpl(url, {
    headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
    signal,
  });
  if (!response.ok && !(offset > 0 && response.status === 416)) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  const resuming = offset > 0 && response.status === 206;
  const hash = createHash("sha256");
  if (resuming) hash.update(readFileSync(part));
  const body = response.status === 416 ? null : response.body;
  if (body) {
    await pipeline(
      body,
      async function* (source) {
        let bytes = offset;
        for await (const chunk of source) {
          hash.update(chunk);
          bytes += chunk.length;
          onProgress(bytes);
          yield chunk;
        }
      },
      createWriteStream(part, { flags: resuming ? "a" : "w" }),
    );
  } else {
    hash.update(readFileSync(part));
  }
  writeFileSync(
    statePath,
    `${JSON.stringify({ url, sha256, bytes: statSync(part).size })}\n`,
  );
  if (hash.digest("hex") !== sha256) {
    const quarantine = `${dest}.quarantine`;
    rmSync(quarantine, { force: true });
    renameSync(part, quarantine);
    rmSync(statePath, { force: true });
    throw new Error(`checksum mismatch for ${url}; corrupt artifact quarantined at ${quarantine}`);
  }
  renameSync(part, dest);
  rmSync(statePath, { force: true });
  return statSync(dest).size;
}

/** Stage a prepared component beside its target, then swap atomically. */
export function activateComponent(root, id, staged, target) {
  const rootPath = resolve(root);
  const destination = resolve(rootPath, target);
  const backup = join(rootPath, BACKUP, id);
  mkdirSync(dirname(destination), { recursive: true });
  const hadPrevious = existsSync(destination);
  if (hadPrevious) {
    rmSync(backup, { recursive: true, force: true });
    mkdirSync(dirname(backup), { recursive: true });
    renameSync(destination, backup);
    writeFileSync(`${backup}.target`, `${relative(rootPath, destination)}\n`);
  }
  try {
    renameSync(staged, destination);
    return { activated: true, backedUp: hadPrevious };
  } catch (error) {
    if (hadPrevious && existsSync(backup)) {
      try {
        const previous = ownedPath(rootPath, readFileSync(`${backup}.target`, "utf8").trim());
        renameSync(backup, previous);
      } catch {
        // A tampered target never becomes a restore destination; keep the
        // backup in place for inspection.
      }
    }
    throw error;
  }
}

/** After a crash or reboot: restore last known-good copies, drop stale locks. */
export function recoverInstallation(root) {
  const rootPath = resolve(root);
  const lock = join(rootPath, LOCK);
  if (existsSync(lock) && !isAlive(readPid(lock))) rmSync(lock, { force: true });
  const backupRoot = join(rootPath, BACKUP);
  const restored = [];
  const skipped = [];
  if (existsSync(backupRoot)) {
    for (const id of readdirSync(backupRoot)) {
      if (id.endsWith(".target")) continue;
      const backup = join(backupRoot, id);
      const targetFile = `${backup}.target`;
      if (!existsSync(targetFile)) continue;
      // ISSUE-177: recovery metadata is mutable local state, not a trusted
      // path. Never restore outside the managed root.
      let target;
      try {
        target = ownedPath(rootPath, readFileSync(targetFile, "utf8").trim());
      } catch (error) {
        skipped.push({ id, reason: error.message });
        continue;
      }
      if (existsSync(target)) continue;
      mkdirSync(dirname(target), { recursive: true });
      cpSync(backup, target, { recursive: true });
      restored.push(id);
    }
  }
  const staging = join(rootPath, STAGING);
  rmSync(staging, { recursive: true, force: true });
  return { restored, skipped, stagingRemoved: !existsSync(staging) };
}

export { STAGING, BACKUP };
