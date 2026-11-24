// ISSUE-152: versioned host-install artifacts. Every tarball is tied to one
// source commit and has a SHA-256 in both SHA256SUMS and release-manifest.json.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MATRIX = [
  { os: "windows", arch: "x64" },
  { os: "windows", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "arm64" },
];
const EXCLUDES = [".git", ".toolchain", "node_modules", "dist", "build", "screenshots", ".gradle"];

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function channelOf(version) {
  return /-preview\./.test(version) ? "preview" : "stable";
}

export function buildReleaseArtifacts({
  root = process.cwd(),
  out = join(root, "dist", "release"),
  version,
  channel = channelOf(version ?? ""),
  commit = null,
  exec = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
    if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
  },
} = {}) {
  if (!version) throw new Error("release artifacts need --version");
  const target = resolve(out);
  mkdirSync(target, { recursive: true });
  const artifacts = [];
  for (const { os, arch } of MATRIX) {
    const name = `open-droid-${version}-${os}-${arch}.tar.gz`;
    const path = join(target, name);
    const args = ["-czf", path];
    for (const exclude of EXCLUDES) args.push(`--exclude=./${exclude}`);
    args.push(".");
    exec("tar", args);
    artifacts.push({ os, arch, name, sha256: digest(path), bytes: readFileSync(path).length });
  }
  const manifest = {
    schema: 1,
    version,
    channel,
    sourceCommit: commit,
    createdAt: new Date().toISOString(),
    artifacts,
  };
  writeFileSync(join(target, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(target, "SHA256SUMS"),
    `${artifacts.map((entry) => `${entry.sha256}  ${entry.name}`).join("\n")}\n`,
  );
  return manifest;
}

const REPO_URL = "https://github.com/neetigyacybersec-a11y/Open-Droid";

/** Package-manager definitions generated from the verified artifact checksums. */
export function generatePackageManifests(manifest, out) {
  const target = resolve(out);
  mkdirSync(target, { recursive: true });
  const find = (os, arch) => manifest.artifacts.find((entry) => entry.os === os && entry.arch === arch);
  const asset = (entry) => `${REPO_URL}/releases/download/v${manifest.version}/${entry.name}`;
  const win = find("windows", "x64");
  const mac = find("darwin", "arm64");
  const linux = find("linux", "x64");
  const winget = `# Generated from release-manifest.json — do not edit by hand.
PackageIdentifier: Neetigyacybersec.OpenDroid
PackageVersion: ${manifest.version}
PackageLocale: en-US
Publisher: neetigyacybersec-a11y
PackageName: Open-Droid
ShortDescription: Android MCP toolchain and skills
ManifestType: singleton
ManifestVersion: 1.6.0
Installers:
  - Architecture: x64
    InstallerType: archive
    InstallerUrl: ${asset(win)}
    InstallerSha256: ${win.sha256}
    NestedInstallerType: portable
`;
  const brew = `# Generated from release-manifest.json — do not edit by hand.
class OpenDroid < Formula
  desc "Android MCP toolchain and skills"
  homepage "${REPO_URL}"
  version "${manifest.version}"
  url "${asset(mac)}"
  sha256 "${mac.sha256}"
  def install
    bin.install "scripts/install.sh" => "open-droid-install"
    libexec.install Dir["*"]
  end
end
`;
  const linuxInstall = `#!/usr/bin/env bash
# Pinned Linux install path. The checksum protects against a changed asset.
set -euo pipefail
VERSION="${manifest.version}"
URL="${asset(linux)}"
EXPECTED="${linux.sha256}"
DEST="\${OPEN_DROID_INSTALL_DIR:-\$HOME/.local/opt/open-droid}"
TMP="\$(mktemp -d)"
trap 'rm -rf "\$TMP"' EXIT
curl -fsSL "\$URL" -o "\$TMP/open-droid.tar.gz"
echo "\$EXPECTED  \$TMP/open-droid.tar.gz" | sha256sum -c -
mkdir -p "\$DEST"
tar -xzf "\$TMP/open-droid.tar.gz" -C "\$DEST" --strip-components=1
echo "installed Open-Droid \$VERSION into \$DEST"
`;
  mkdirSync(join(target, "winget"), { recursive: true });
  writeFileSync(join(target, "winget", "OpenDroid.installer.yaml"), winget);
  mkdirSync(join(target, "homebrew"), { recursive: true });
  writeFileSync(join(target, "homebrew", "open-droid.rb"), brew);
  mkdirSync(join(target, "linux"), { recursive: true });
  writeFileSync(join(target, "linux", "install.sh"), linuxInstall);
  return {
    winget: join(target, "winget", "OpenDroid.installer.yaml"),
    homebrew: join(target, "homebrew", "open-droid.rb"),
    linux: join(target, "linux", "install.sh"),
  };
}

export function verifyReleaseArtifacts(out) {
  const target = resolve(out);
  const manifest = JSON.parse(readFileSync(join(target, "release-manifest.json"), "utf8"));
  const checksums = readFileSync(join(target, "SHA256SUMS"), "utf8").trim().split("\n");
  for (const artifact of manifest.artifacts) {
    if (!existsSync(join(target, artifact.name))) throw new Error(`missing artifact: ${artifact.name}`);
    const actual = digest(join(target, artifact.name));
    if (actual !== artifact.sha256) throw new Error(`checksum mismatch: ${artifact.name}`);
    if (!checksums.includes(`${actual}  ${artifact.name}`)) {
      throw new Error(`SHA256SUMS mismatch: ${artifact.name}`);
    }
  }
  return manifest;
}
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  if (argv.includes("--verify")) {
    const manifest = verifyReleaseArtifacts(value("--out") ?? "dist/release");
    console.log(`verified ${manifest.version} (${manifest.channel}) with ${manifest.artifacts.length} artifacts`);
  } else {
    const manifest = buildReleaseArtifacts({
      version: value("--version"),
      channel: value("--channel"),
      commit: value("--commit") ?? null,
      out: value("--out"),
    });
    if (argv.includes("--packaging")) {
      const paths = generatePackageManifests(manifest, join(value("--out") ?? "dist/release", "packaging"));
      console.log(`package manifests: ${paths.winget}, ${paths.homebrew}, ${paths.linux}`);
    }
    console.log(`built ${manifest.version} (${manifest.channel}) with ${manifest.artifacts.length} artifacts`);
  }
}
