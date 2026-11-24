// ISSUE-152: release artifacts are versioned, checksummed and tied to a commit.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  buildReleaseArtifacts,
  channelOf,
  generatePackageManifests,
  MATRIX,
  verifyReleaseArtifacts,
} from "../scripts/release-artifacts.mjs";

const REPO = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "release-artifacts-"));
test.after(() => rmSync(work, { recursive: true, force: true }));

test("artifacts cover the OS/arch matrix with checksums and a source commit", () => {
  const root = join(work, "repo");
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "README.md"), "fixture\n");
  writeFileSync(join(root, "scripts", "install.mjs"), "// installer\n");
  const out = join(work, "out");
  const manifest = buildReleaseArtifacts({ root, out, version: "0.1.0", commit: "abc123" });
  assert.equal(manifest.artifacts.length, MATRIX.length);
  assert.equal(manifest.channel, "stable");
  assert.equal(manifest.sourceCommit, "abc123");
  for (const artifact of manifest.artifacts) {
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    assert.ok(artifact.bytes > 0);
  }
  const sums = readFileSync(join(out, "SHA256SUMS"), "utf8");
  assert.equal(sums.trim().split("\n").length, MATRIX.length);
  assert.equal(verifyReleaseArtifacts(out).version, "0.1.0");
  appendFileSync(join(out, manifest.artifacts[0].name), "tampered");
  assert.throws(() => verifyReleaseArtifacts(out), /checksum mismatch/);
});

test("Preview channels are separated by version", () => {
  assert.equal(channelOf("0.2.0"), "stable");
  assert.equal(channelOf("0.2.0-preview.3"), "preview");
  const root = join(work, "repo");
  const out = join(work, "preview");
  const manifest = buildReleaseArtifacts({ root, out, version: "0.2.0-preview.3" });
  assert.equal(manifest.channel, "preview");
});

test("package-manager manifests pin immutable release assets", () => {
  const root = join(work, "repo");
  const out = join(work, "packaging-out");
  const manifest = buildReleaseArtifacts({ root, out, version: "0.1.0", commit: "abc123" });
  const paths = generatePackageManifests(manifest, join(out, "packaging"));
  const winget = readFileSync(paths.winget, "utf8");
  const brew = readFileSync(paths.homebrew, "utf8");
  const linux = readFileSync(paths.linux, "utf8");
  const win = manifest.artifacts.find((a) => a.os === "windows" && a.arch === "x64");
  const mac = manifest.artifacts.find((a) => a.os === "darwin" && a.arch === "arm64");
  assert.match(winget, new RegExp(`v0\\.1\\.0/${win.name}`));
  assert.match(winget, new RegExp(win.sha256));
  assert.match(brew, new RegExp(mac.sha256));
  assert.match(brew, /version "0\.1\.0"/);
  assert.match(linux, /sha256sum -c/);
  assert.doesNotMatch(winget, /\$\{|latest/i);
});

test("release CI gates every publish job on validation and keeps provenance", () => {
  const release = readFileSync(join(REPO, ".github", "workflows", "release.yml"), "utf8");
  for (const job of ["docker", "npm", "host-artifacts"]) {
    const section = release.slice(release.indexOf(`  ${job}:`));
    assert.match(section, /needs: validate|needs:\s*\n\s*- validate/, `${job} must depend on validate`);
  }
  assert.match(release, /--provenance/);
  assert.match(release, /release-artifacts\.mjs --verify/);
});

test("release documentation covers install, upgrade, rollback and uninstall", () => {
  const doc = readFileSync(join(REPO, "docs", "agent-install.md"), "utf8");
  for (const term of ["WinGet", "Homebrew", "pinned-version", "rollback", "uninstall"]) {
    assert.match(doc, new RegExp(term, "i"), `docs must mention ${term}`);
  }
});
