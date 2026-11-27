#!/usr/bin/env node
// ISSUE-143: a first-class update command that refuses to touch a dirty,
// detached or diverged checkout. Fast-forward only; never reset, force or
// rebase. Install/build/verify failures stop at the failing stage.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGeneration, rollbackGeneration, verifyGeneration } from "./generations.mjs";
import { runtimeReady } from "./build-state.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function output(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function abort(message, code = 1) {
  console.error(`update aborted: ${message}`);
  process.exit(code);
}

let savedGeneration = null;

function stage(label, command, args, cwd) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    // ISSUE-153/176: a failed stage never leaves the active runtime
    // half-updated, and success is not claimed until health checks pass.
    if (savedGeneration) {
      try {
        const restored = rollbackGeneration(join(cwd, ".toolchain"), { id: savedGeneration.id });
        if (restored.doctor?.summary.ok && runtimeReady(cwd)) {
          console.error(`restored verified last-known-good generation ${restored.state.id}`);
        } else {
          console.error(
            `manual recovery required: rollback verification failed for ${restored.state.id}`,
          );
        }
      } catch (error) {
        console.error(`manual recovery required: rollback failed: ${error.message}`);
      }
    }
    abort(`${label} failed (exit ${result.status ?? "unknown"}). Nothing later was run.`);
  }
}

const rootIndex = process.argv.indexOf("--root");
const root = rootIndex > 0 ? resolve(process.argv[rootIndex + 1]) : REPO;
const noRegister = process.argv.includes("--no-register");

const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
if (inside.status !== 0 || output(inside) !== "true") {
  abort(`${root} is not a git working tree`);
}

const status = git(root, ["status", "--porcelain=v1"]);
if (status.status !== 0) abort(`git status failed: ${output(status)}`);
if ((status.stdout ?? "").trim() !== "") {
  const paths = (status.stdout ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
  abort(
    "working tree is dirty; commit or stash these paths, then retry:\n  " +
      paths.join("\n  ") +
      "\nSafe options: `git stash push -u -m pre-update`, or commit on a branch.",
  );
}

const branchResult = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
if (branchResult.status !== 0) abort("detached HEAD; check out a branch first");
const branch = output(branchResult);
const upstreamResult = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
if (upstreamResult.status !== 0) {
  abort(`branch ${branch} has no configured upstream; set one with git branch --set-upstream-to`);
}
const upstream = output(upstreamResult);

console.log(`updating ${branch} from ${upstream} (fast-forward only)`);
const fetch = git(root, ["fetch"]);
if (fetch.status !== 0) abort(`git fetch failed: ${output(fetch)}`);

const counts = git(root, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
if (counts.status !== 0) abort(`divergence check failed: ${output(counts)}`);
const [ahead, behind] = output(counts)
  .split(/\s+/)
  .map((value) => Number(value));
if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
  abort(`could not read ahead/behind counts: ${output(counts)}`);
}
if (ahead > 0 && behind > 0) {
  abort(
    `branch has diverged (${ahead} local, ${behind} upstream). ` +
      "Rebase or merge deliberately; update will not rewrite history.",
  );
}
if (ahead > 0) {
  abort(`branch has ${ahead} commit(s) not on ${upstream}; push or rebase them first`);
}
if (behind === 0) {
  console.log("already up to date");
  console.log(
    "Docker installs: rebuild the image (`docker build -t open-droid .`) instead of " +
      "expecting a running container to update itself.",
  );
  process.exit(0);
}

// ISSUE-153: snapshot the healthy runtime before touching the checkout. A
// source-checkout generation performs no destructive Git operations during rollback.
try {
  savedGeneration = createGeneration(join(root, ".toolchain"), {
    mode: "source",
    reason: "pre-update",
    sourceCommit: output(git(root, ["rev-parse", "HEAD"])),
  });
  console.log(`last-known-good generation: ${savedGeneration.id}`);
} catch (error) {
  abort(
    `no last-known-good runtime snapshot: ${error.message}. ` +
      "Install the runtime first (npm run install:core) before updating; " +
      "an update without a rollback snapshot is not allowed.",
  );
}

const merge = git(root, ["merge", "--ff-only", "@{u}"]);
if (merge.status !== 0) abort(`fast-forward merge failed: ${output(merge)}`);

stage("install", NPM, ["ci"], root);
stage("build", NPM, ["run", "build"], root);
stage("verify", NPM, ["run", "verify"], root);

if (
  !noRegister &&
  process.platform !== "win32" &&
  existsSync(join(root, "scripts", "register.sh"))
) {
  stage("register", "bash", [join(root, "scripts", "register.sh")], root);
}
if (savedGeneration) {
  const verified = verifyGeneration(join(root, ".toolchain"), savedGeneration.id);
  console.log(`generation verification: ${verified.verified ? "OK" : "incomplete"}`);
}
console.log(
  "\nupdate complete. Restart the MCP client (or reload the server) so clients pick up " +
    "the new tools/list.",
);
console.log(
  "Docker installs: rebuild the image (`docker build -t open-droid .`) instead of " +
    "expecting a running container to update itself.",
);
