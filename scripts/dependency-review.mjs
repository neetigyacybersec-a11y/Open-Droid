#!/usr/bin/env node
// ISSUE-107: deterministic dependency and build-system change review.
//
// The checker is dependency-free and read-only. It inspects committed changes
// between a base revision and HEAD, classifies npm and Gradle manifest, catalog,
// repository, plugin, wrapper, toolchain and lockfile edits, and renders a
// stable JSON or Markdown report. It never installs or resolves dependencies.
//
// Scope and limits are documented in docs/dependency-review.md. In particular,
// Gradle files are matched line-by-line rather than through a Gradle model,
// license and advisory data are only reported when locally available, and
// CODEOWNERS review is enforced by hosting branch protection, not by this file.
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA_VERSION = 1;
export const DEFAULT_FAIL_ON = "high";

const RISK_ORDER = { info: 0, low: 1, medium: 2, high: 3 };
const MAX_DETAIL_ENTRIES = 200;
const MAX_TEXT_CHARS = 400;
const MAX_LOGIC_LINES = 20;

const LIMITATIONS = [
  "Inspects committed changes between the base revision and HEAD; untracked and unstaged work is not reviewed.",
  "Gradle files are matched line-by-line, not evaluated with a Gradle model, so generated or heavily dynamic build logic can be missed.",
  "License status uses package.json metadata available under node_modules at HEAD; other dependencies are reported as unknown.",
  "Advisory data is unavailable unless --audit succeeds; no network lookup is attempted by default.",
  "Human approval depends on branch protection enforcing CODEOWNERS; this report cannot enforce review by itself.",
];

const KNOWN_REPOSITORY_HOSTS = new Set([
  "repo.maven.apache.org",
  "repo1.maven.org",
  "dl.google.com",
  "maven.google.com",
  "plugins.gradle.org",
  "services.gradle.org",
  "registry.npmjs.org",
]);

const PERMISSIVE_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "Unlicense",
]);

const COPYLEFT_PATTERN = /\b(AGPL|SSPL|BUSL|GPL-3|GPL-2|GPL-3\.0|GPL-2\.0|Commons-Clause)\b/i;

const IGNORED_SEGMENTS = new Set(["node_modules", ".git", ".gradle", "build", "dist", "out"]);

const NPM_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const DEPENDENCY_CONFIGURATION =
  /^(?:implementation|api|compileOnly|compileOnlyApi|runtimeOnly|runtimeOnlyApi|testImplementation|testCompileOnly|testRuntimeOnly|testFixturesApi|testFixturesImplementation|androidTestImplementation|androidTestCompileOnly|androidTestRuntimeOnly|debugImplementation|releaseImplementation|debugApi|releaseApi|ksp|kspTest|kapt|kaptTest|annotationProcessor|testAnnotationProcessor|classpath|coreLibraryDesugaring|lintChecks|lintPragma|detektPlugins|spotless|checkstyle|pmd)$/;

const STRUCTURAL_LINE =
  /^(?:[{}(),;]+|(?:pluginManagement|dependencyResolutionManagement|repositories|pluginManagement\s*\{|dependencyResolutionManagement\s*\{|dependencies|buildscript|allprojects|subprojects|plugins)\s*\{?|(?:google|mavenCentral|gradlePluginPortal|mavenLocal)\(\))$/;

const SUSPICIOUS_BUILD =
  /\b(?:exec|commandLine|ProcessBuilder|Runtime\.getRuntime|curl|wget|download|openStream|new\s+URL|eval|apply\s+from|includeBuild|buildscript|System\.exit)\b|https?:\/\//i;

function git(cwd, args, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd,
    encoding,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function gitText(cwd, args) {
  return git(cwd, args).toString();
}

function tryGit(cwd, args) {
  try {
    return gitText(cwd, args);
  } catch {
    return null;
  }
}

function repoRoot(cwd) {
  const root = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root || !root.trim()) throw new Error("not inside a git worktree");
  return root.trim();
}

function resolveCommit(cwd, revision) {
  if (!revision || revision.startsWith("-")) return null;
  const out = tryGit(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
  return out && out.trim() ? out.trim() : null;
}

function readAt(cwd, revision, path) {
  try {
    return git(cwd, ["show", `${revision}:${path}`]).toString("utf8");
  } catch {
    return null;
  }
}

function readBufferAt(cwd, revision, path) {
  try {
    return git(cwd, ["show", `${revision}:${path}`], "buffer");
  } catch {
    return null;
  }
}

function listChanged(cwd, base, head) {
  const raw = git(cwd, ["diff", "--name-status", "-z", "--find-renames=50%", base, head]).toString(
    "utf8",
  );
  const fields = raw.split("\u0000");
  const changes = [];
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index];
    if (!status) continue;
    const letter = status[0];
    const path = fields[index + 1];
    if (letter === "R" || letter === "C") {
      const next = fields[index + 2];
      changes.push({ status: letter, oldPath: path, path: next });
      index += 2;
    } else {
      changes.push({ status: letter, path });
      index += 1;
    }
  }
  return changes;
}

function listTracked(cwd, revision) {
  const raw = git(cwd, ["ls-tree", "-r", "-z", "--name-only", revision]).toString("utf8");
  return raw.split("\u0000").filter(Boolean);
}

function sanitizeText(value, limit = MAX_TEXT_CHARS) {
  if (value === null || value === undefined) return null;
  let text = String(value)
    // eslint-disable-next-line no-control-regex -- ANSI escape matching needs control ranges
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex -- C0/C1 filtering needs control ranges
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\u202a-\u202e|\u2066-\u2069/g, "")
    .replace(/:\/\/[^/\s@]+@/g, "://[redacted]@")
    .replace(
      /\b(_authToken|_auth|authToken|password|passwd|token|secret)\b\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    );
  if (text.length > limit) text = `${text.slice(0, limit)}...`;
  return text;
}

function sanitizeUrl(value) {
  const text = String(value).trim();
  try {
    const url = new URL(text);
    return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
  } catch {
    return text.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/i, "$1[redacted]@");
  }
}

function pointer(parts) {
  return `#/${parts
    .map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1"))
    .join("/")}`;
}

function maxRisk(findings) {
  let highest = null;
  for (const finding of findings) {
    if (!highest || RISK_ORDER[finding.risk] > RISK_ORDER[highest]) highest = finding.risk;
  }
  return highest;
}

function parseSemver(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) };
}

function updateDetails(oldValue, newValue) {
  const before = parseSemver(oldValue);
  const after = parseSemver(newValue);
  const details = {
    major: Boolean(before && after && before.major !== after.major),
    minor: Boolean(before && after && before.minor !== after.minor),
    patch: Boolean(before && after && before.patch !== after.patch),
  };
  if (before) details.oldVersion = `${before.major}.${before.minor}.${before.patch}`;
  if (after) details.newVersion = `${after.major}.${after.minor}.${after.patch}`;
  return details;
}

function updateRisk(oldValue, newValue) {
  const details = updateDetails(oldValue, newValue);
  if (details.major) return "medium";
  if (!details.oldVersion || !details.newVersion) return "medium";
  return "low";
}

function addedLines(oldText, newText) {
  const remaining = new Map();
  for (const line of (oldText ?? "").split(/\r?\n/)) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }
  const added = [];
  for (const line of (newText ?? "").split(/\r?\n/)) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else added.push(line);
  }
  return added;
}

function basename(path) {
  const parts = String(path).split("/");
  return parts[parts.length - 1];
}

function isIgnored(path) {
  const parts = String(path).split("/");
  if (parts.some((part) => IGNORED_SEGMENTS.has(part))) return true;
  if (parts.some((part) => part === "test-results" || part === "reports")) return true;
  return false;
}

function inGradleDir(path) {
  const parts = String(path).split("/");
  return parts.length >= 2 && parts[parts.length - 2] === "gradle";
}

function fileKind(path) {
  if (isIgnored(path)) return null;
  const name = basename(path);
  if (name === "package.json") return "npm-manifest";
  if (name === "package-lock.json" || name === "npm-shrinkwrap.json") return "npm-lock";
  if (name === "yarn.lock") return "yarn-lock";
  if (name === "pnpm-lock.yaml") return "pnpm-lock";
  if (name === ".npmrc") return "npmrc";
  if (name === ".yarnrc" || name === ".yarnrc.yml") return "yarnrc";
  if (name === "build.gradle" || name === "build.gradle.kts") return "gradle-build";
  if (name === "settings.gradle" || name === "settings.gradle.kts") return "gradle-settings";
  if (name === "gradle.properties") return "gradle-properties";
  if (name === "libs.versions.toml" && inGradleDir(path)) return "catalog";
  if (name.endsWith(".versions.toml") && inGradleDir(path)) return "catalog";
  if (name === "gradle-wrapper.properties") return "wrapper-properties";
  if (name === "gradle-wrapper.jar") return "wrapper-jar";
  if (name === "verification-metadata.xml" && inGradleDir(path)) return "verification-metadata";
  if (name.endsWith(".lockfile") || name === "dependencies.lock") return "gradle-lock";
  if (name === "pom.xml") return "maven-build";
  return null;
}

function makeFinding(input) {
  return {
    id: null,
    file: input.file,
    status: input.status,
    kind: input.kind,
    ecosystem: input.ecosystem,
    changeType: input.changeType,
    section: input.section ?? null,
    coordinate: sanitizeText(input.coordinate, 200),
    oldValue: input.oldValue === undefined ? null : sanitizeText(input.oldValue, 200),
    newValue: input.newValue === undefined ? null : sanitizeText(input.newValue, 200),
    risk: input.risk,
    review: RISK_ORDER[input.risk] >= RISK_ORDER.medium,
    reason: sanitizeText(input.reason),
    evidence: input.evidence ?? {},
    details: input.details ?? {},
    equivalenceCandidates: input.equivalenceCandidates ?? [],
  };
}

function parseJson(text) {
  try {
    return { value: JSON.parse(text), error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function npmDeclarations(json) {
  const declarations = [];
  if (!json || typeof json !== "object") return declarations;
  const names = new Set();
  for (const section of NPM_SECTIONS) {
    const values = json[section];
    if (!values || typeof values !== "object") continue;
    for (const [name, value] of Object.entries(values)) {
      declarations.push({ section, name, value: String(value) });
      names.add(`${section}\u0000${name}`);
    }
  }
  return { declarations, names };
}

function flattenOverrides(value, prefix = "") {
  const entries = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return entries;
  for (const [key, child] of Object.entries(value)) {
    const coordinate = prefix ? `${prefix}>${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      entries.push(...flattenOverrides(child, coordinate));
    } else {
      entries.push({ coordinate, value: String(child) });
    }
  }
  return entries;
}

function npmLockModel(text) {
  const parsed = parseJson(text);
  if (parsed.error) return { entries: new Map(), error: parsed.error };
  const json = parsed.value ?? {};
  const entries = new Map();
  const packages = json.packages && typeof json.packages === "object" ? json.packages : null;
  if (packages) {
    for (const [path, entry] of Object.entries(packages)) {
      if (!path || !entry || typeof entry !== "object") continue;
      const name =
        typeof entry.name === "string" && entry.name
          ? entry.name
          : path.includes("node_modules/")
            ? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length)
            : path;
      if (name.includes("node_modules/")) continue;
      entries.set(path, {
        name,
        version: entry.version === undefined ? null : String(entry.version),
        resolved: entry.resolved === undefined ? null : String(entry.resolved),
        integrity: entry.integrity === undefined ? null : String(entry.integrity),
      });
    }
  }
  const walk = (dependencies, prefix) => {
    if (!dependencies || typeof dependencies !== "object") return;
    for (const [name, entry] of Object.entries(dependencies)) {
      if (!entry || typeof entry !== "object") continue;
      const path = `${prefix}${name}`;
      entries.set(path, {
        name,
        version: entry.version === undefined ? null : String(entry.version),
        resolved: entry.resolved === undefined ? null : String(entry.resolved),
        integrity: entry.integrity === undefined ? null : String(entry.integrity),
      });
      if (entry.dependencies) walk(entry.dependencies, `${path}/`);
    }
  };
  if (!packages) walk(json.dependencies, "");
  return { entries, error: null };
}

function gradleLockModel(text) {
  const entries = new Map();
  let valid = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("empty=")) continue;
    const coordinate = line.split("=")[0].trim();
    const parts = coordinate.split(":");
    if (parts.length < 3) continue;
    const version = parts.pop();
    const name = parts.join(":");
    if (!name || !version) continue;
    valid += 1;
    entries.set(name, { name, version });
  }
  return { entries, error: valid === 0 && text.trim() ? "no Gradle lock entries found" : null };
}

function yarnLockModel(text) {
  const entries = new Map();
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const header = raw.match(/^"?([^"\s@][^"\s]*(?:@[^"\s]+)?)"?:\s*$/);
    if (header) {
      current = header[1];
      continue;
    }
    const version = raw.match(/^\s+version:?\s+"?([^"\s]+)"?\s*$/);
    if (version && current) {
      const name = current.startsWith("@")
        ? `@${current.slice(1).split("@")[0]}`
        : current.split("@")[0];
      entries.set(current, { name, version: version[1] });
    }
  }
  return { entries, error: entries.size === 0 && text.trim() ? "no yarn entries found" : null };
}

function pnpmLockModel(text) {
  const entries = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.match(/^\s{2}(\/?@?[^:\s]+)\/(\d[^:\s]+):\s*$/);
    if (!match) continue;
    const name = match[1].replace(/^\//, "");
    entries.set(match[1], { name, version: match[2] });
  }
  return { entries, error: entries.size === 0 && text.trim() ? "no pnpm entries found" : null };
}

function tomlValue(raw) {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseCatalog(text) {
  const model = {
    versions: new Map(),
    libraries: [],
    plugins: [],
    referencedVersions: new Set(),
    error: null,
  };
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line
      .slice(0, separator)
      .trim()
      .replace(/^["']|["']$/g, "");
    const value = line.slice(separator + 1).trim();
    if (section === "versions") {
      model.versions.set(key, tomlValue(value));
      continue;
    }
    if (section !== "libraries" && section !== "plugins") continue;
    const module = value.match(/\bmodule\s*=\s*"([^"]+)"/)?.[1] ?? null;
    const group = value.match(/\bgroup\s*=\s*"([^"]+)"/)?.[1] ?? null;
    const name = value.match(/\bname\s*=\s*"([^"]+)"/)?.[1] ?? null;
    const literalVersion = value.match(/\bversion\s*=\s*"([^"]+)"/)?.[1] ?? null;
    const versionObject = value.match(/\bversion\s*=\s*\{\s*ref\s*=\s*"([^"]+)"/)?.[1] ?? null;
    const versionRef = value.match(/\bversion\.ref\s*=\s*"([^"]+)"/)?.[1] ?? versionObject;
    const id = value.match(/\bid\s*=\s*"([^"]+)"/)?.[1] ?? null;
    const record = {
      key,
      module,
      group,
      name,
      id,
      version: literalVersion,
      versionRef,
    };
    if (section === "libraries") model.libraries.push(record);
    else model.plugins.push(record);
    if (versionRef) model.referencedVersions.add(versionRef);
  }
  for (const record of model.libraries) {
    record.coordinate =
      record.module ?? (record.group && record.name ? `${record.group}:${record.name}` : null);
  }
  for (const record of model.plugins) record.coordinate = record.id;
  return model;
}

function catalogResolvedVersion(record, versions) {
  if (record.version) return record.version;
  if (record.versionRef) return versions.get(record.versionRef) ?? null;
  return null;
}

function findCatalogRecord(catalog, alias) {
  if (!catalog) return null;
  const key = alias.replace(/^libs\./, "");
  const candidates = [key, key.replace(/\./g, "-"), key.replace(/\./g, "")];
  return (
    catalog.libraries.find((record) => candidates.includes(record.key)) ??
    catalog.plugins.find((record) => candidates.includes(record.key)) ??
    null
  );
}

function findCatalogPlugin(catalog, accessor) {
  if (!catalog) return null;
  const key = accessor.replace(/^libs\.plugins\./, "");
  const candidates = [key, key.replace(/\./g, "-"), key.replace(/\./g, "")];
  return catalog.plugins.find((record) => candidates.includes(record.key)) ?? null;
}

function repositorySecurity(rawUrl) {
  const raw = String(rawUrl).trim();
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = null;
  }
  const host = parsed?.hostname ?? raw.replace(/^[a-z]+:\/\//i, "").split("/")[0];
  const secure = parsed ? parsed.protocol === "https:" : !/^http:/i.test(raw);
  const credentials = /^[a-z]+:\/\/[^/\s@]+@/i.test(raw);
  const custom = !KNOWN_REPOSITORY_HOSTS.has(host);
  const coordinate = sanitizeUrl(raw);
  const reasons = [];
  if (!secure) reasons.push("Repository uses insecure HTTP and can be tampered with.");
  if (credentials)
    reasons.push("Repository URL embeds credentials and must not be stored in the build.");
  if (custom) {
    reasons.push(
      `Custom repository ${coordinate} is not a known default; unrestricted use can substitute dependencies.`,
    );
  }
  const risk = !secure || credentials || custom ? "high" : "low";
  return {
    coordinate,
    risk,
    reason: reasons.join(" ") || `Standard Maven repository ${coordinate} added.`,
    details: { secure, credentials, custom, scope: "unrestricted", host },
  };
}

function stripLineComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "/" && line[index + 1] === "/") {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseGradle(text, catalog) {
  const model = {
    repositories: new Map(),
    plugins: new Map(),
    dependencies: new Map(),
    toolchains: new Map(),
    consumed: new Set(),
  };
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = stripLineComment(raw).trim();
    if (!line) continue;

    for (const [token, coordinate] of [
      ["mavenCentral()", "mavenCentral()"],
      ["google()", "google()"],
      ["gradlePluginPortal()", "gradlePluginPortal()"],
      ["mavenLocal()", "mavenLocal()"],
    ]) {
      if (line.includes(token)) {
        model.consumed.add(line);
        if (token === "mavenLocal()") {
          model.repositories.set(coordinate, {
            coordinate,
            risk: "high",
            reason: "Local Maven repository can supply unverified artifacts.",
            details: {
              secure: false,
              credentials: false,
              custom: true,
              scope: "local",
              host: "local",
            },
          });
        } else {
          model.repositories.set(coordinate, {
            coordinate,
            risk: "low",
            reason: `Standard Maven repository ${coordinate} added.`,
            details: {
              secure: true,
              credentials: false,
              custom: false,
              scope: "standard",
              host: token,
            },
          });
        }
      }
    }

    const inlineMaven =
      line.match(/\bmaven\s*\(\s*["']([^"']+)["']\s*\)/) ??
      line.match(/\burl\s*=\s*(?:uri\s*\(\s*)?["']([^"']+)["']/);
    if (inlineMaven && /(?:maven|url)/.test(line)) {
      const repository = repositorySecurity(inlineMaven[1]);
      model.repositories.set(repository.coordinate, repository);
      model.consumed.add(line);
    }

    const flatDir = line.match(/\bflatDir\s*\{?\s*dirs?\s*\(?\s*["']?([^"')]*)/);
    if (flatDir) {
      const coordinate = `flatDir(${sanitizeText(flatDir[1] || "directory", 120)})`;
      model.repositories.set(coordinate, {
        coordinate,
        risk: "high",
        reason: "Flat-directory dependency source bypasses repository verification.",
        details: { secure: false, credentials: false, custom: true, scope: "local", host: "local" },
      });
      model.consumed.add(line);
    }

    const pluginPatterns = [
      /\bid\s*\(\s*["']([^"']+)["']\s*\)(?:\s*version\s*["']([^"']+)["'])?/g,
      /\bid\s+["']([^"']+)["'](?:\s+version\s+["']([^"']+)["'])?/g,
    ];
    for (const pattern of pluginPatterns) {
      for (const match of line.matchAll(pattern)) {
        model.plugins.set(match[1], { coordinate: match[1], version: match[2] ?? null });
        model.consumed.add(line);
      }
    }
    for (const match of line.matchAll(/\balias\s*\(\s*(libs\.plugins\.[A-Za-z0-9_.]+)\s*\)/g)) {
      const record = findCatalogPlugin(catalog, match[1]);
      const coordinate = record?.coordinate ?? match[1];
      const version = record ? catalogResolvedVersion(record, catalog.versions) : null;
      model.plugins.set(coordinate, { coordinate, version });
      model.consumed.add(line);
    }

    const toolchainPatterns = [
      [/\bjvmToolchain\s*\(\s*(\d+)\s*\)/g, "jvmToolchain"],
      [
        /\b(?:sourceCompatibility|targetCompatibility)\s*=\s*(?:JavaVersion\.VERSION_)?["']?([\d._]+)["']?/g,
        null,
      ],
      [/\bJavaLanguageVersion\.of\s*\(\s*(\d+)\s*\)/g, "JavaLanguageVersion.of"],
      [/\bjvmTarget\s*=\s*["']([\d._]+)["']/g, "jvmTarget"],
      [/\bcompileSdk(?:Version)?\s*=?\s*(\d+)/g, "compileSdk"],
      [/\btargetSdk(?:Version)?\s*=?\s*(\d+)/g, "targetSdk"],
      [/\bminSdk(?:Version)?\s*=?\s*(\d+)/g, "minSdk"],
      [
        /\bkotlinCompilerExtensionVersion\s*=\s*["']([^"']+)["']/g,
        "kotlinCompilerExtensionVersion",
      ],
      [/\bndkVersion\s*=\s*["']([^"']+)["']/g, "ndkVersion"],
      [/\bbuildToolsVersion\s*=\s*["']([^"']+)["']/g, "buildToolsVersion"],
    ];
    for (const [pattern, fixed] of toolchainPatterns) {
      for (const match of line.matchAll(pattern)) {
        let coordinate = fixed;
        if (!coordinate) {
          if (/sourceCompatibility/.test(match[0])) coordinate = "sourceCompatibility";
          else if (/targetCompatibility/.test(match[0])) coordinate = "targetCompatibility";
          else coordinate = "toolchain";
        }
        model.toolchains.set(coordinate, { coordinate, value: match[1] });
        model.consumed.add(line);
      }
    }

    const dependencyPatterns = [
      [/([A-Za-z][A-Za-z0-9_]*)\s*\(\s*platform\s*\(\s*["']([^"']+)["']\s*\)\s*\)/g, "platform"],
      [/([A-Za-z][A-Za-z0-9_]*)\s*\(\s*platform\s*\(\s*(libs\.[A-Za-z0-9_.]+)\s*\)\s*\)/g, "alias"],
      [/([A-Za-z][A-Za-z0-9_]*)\s*\(\s*files?\s*\(\s*["']([^"']+)["']\s*\)\s*\)/g, "local"],
      [/([A-Za-z][A-Za-z0-9_]*)\s*\(\s*fileTree\s*\(([^)]*)\)\s*\)/g, "filetree"],
      [
        /([A-Za-z][A-Za-z0-9_]*)\s*\(\s*project\s*\(\s*(?:path\s*=\s*)?["']([^"']+)["']\s*\)\s*\)/g,
        "project",
      ],
      [/([A-Za-z][A-Za-z0-9_]*)\s*\(\s*(libs\.[A-Za-z0-9_.]+)\s*\)/g, "alias"],
      [/([A-Za-z][A-Za-z0-9_]*)\s*\(\s*["']([^"']+)["']\s*\)/g, "string"],
    ];
    for (const [pattern, mode] of dependencyPatterns) {
      for (const match of line.matchAll(pattern)) {
        const configuration = match[1];
        if (!DEPENDENCY_CONFIGURATION.test(configuration)) continue;
        const value = match[2];
        let coordinate = value;
        let version = null;
        let local = false;
        let project = false;
        if (mode === "local" || mode === "filetree") {
          local = true;
          coordinate = mode === "local" ? value : `fileTree(${sanitizeText(value, 120)})`;
        } else if (mode === "project") {
          project = true;
          coordinate = `project(${value})`;
        } else if (mode === "alias" || (mode === "string" && value.startsWith("libs."))) {
          const record = findCatalogRecord(catalog, value);
          if (record?.coordinate) {
            coordinate = record.coordinate;
            version = catalogResolvedVersion(record, catalog.versions);
          } else {
            coordinate = value;
          }
        } else if (mode !== "platform" && mode !== "string") {
          coordinate = value;
        } else {
          const parts = value.split(":");
          if (parts.length >= 3) {
            version = parts.pop();
            coordinate = parts.join(":");
          }
        }
        model.dependencies.set(`${configuration}\u0000${coordinate}`, {
          configuration,
          section: configuration,
          coordinate,
          version,
          local,
          project,
        });
        model.consumed.add(line);
      }
    }

    const groovyDependency = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s+["']([^"']+)["']$/);
    if (groovyDependency && DEPENDENCY_CONFIGURATION.test(groovyDependency[1])) {
      const parts = groovyDependency[2].split(":");
      let coordinate = groovyDependency[2];
      let version = null;
      if (parts.length >= 3) {
        version = parts.pop();
        coordinate = parts.join(":");
      }
      model.dependencies.set(`${groovyDependency[1]}\u0000${coordinate}`, {
        configuration: groovyDependency[1],
        section: groovyDependency[1],
        coordinate,
        version,
        local: false,
        project: false,
      });
      model.consumed.add(line);
    }

    const groovyAlias = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s+(libs\.[A-Za-z0-9_.]+)$/);
    if (groovyAlias && DEPENDENCY_CONFIGURATION.test(groovyAlias[1])) {
      const record = findCatalogRecord(catalog, groovyAlias[2]);
      const coordinate = record?.coordinate ?? groovyAlias[2];
      const version = record ? catalogResolvedVersion(record, catalog.versions) : null;
      model.dependencies.set(`${groovyAlias[1]}\u0000${coordinate}`, {
        configuration: groovyAlias[1],
        section: groovyAlias[1],
        coordinate,
        version,
        local: false,
        project: false,
      });
      model.consumed.add(line);
    }
  }
  return model;
}

function dependencyFinding(options) {
  let risk = options.risk;
  let reason = options.reason;
  if (options.local && options.changeType !== "dependency-removed") {
    risk = "high";
    reason =
      "Local file dependency can change without repository review or integrity verification.";
  }
  if (options.buildTime && options.changeType !== "dependency-removed") {
    risk = "high";
    reason = "Buildscript classpath dependency executes during the build and must be reviewed.";
  }
  return makeFinding({
    file: options.file,
    status: options.status,
    kind: options.kind,
    ecosystem: options.ecosystem,
    changeType: options.changeType,
    section: options.section,
    coordinate: options.coordinate,
    oldValue: options.oldValue,
    newValue: options.newValue,
    risk,
    reason,
    evidence: options.evidence,
    details: options.details,
  });
}

function analyzeNpmManifest(path, status, oldText, newText, findings) {
  const oldParsed = oldText === null ? { value: {}, error: null } : parseJson(oldText);
  const newParsed = newText === null ? { value: {}, error: null } : parseJson(newText);
  if (oldText !== null && oldParsed.error) {
    findings.push(
      makeFinding({
        file: path,
        status,
        kind: "npm-manifest",
        ecosystem: "npm",
        changeType: "manifest-unreadable",
        coordinate: path,
        risk: "high",
        reason: `Base package manifest could not be parsed: ${oldParsed.error}`,
        details: { phase: "base" },
      }),
    );
    return;
  }
  if (newText !== null && newParsed.error) {
    findings.push(
      makeFinding({
        file: path,
        status,
        kind: "npm-manifest",
        ecosystem: "npm",
        changeType: "manifest-unreadable",
        coordinate: path,
        risk: "high",
        reason: `Package manifest could not be parsed: ${newParsed.error}`,
        details: { phase: "head" },
      }),
    );
    return;
  }

  const oldDeclarations = npmDeclarations(oldParsed.value);
  const newDeclarations = npmDeclarations(newParsed.value);
  const oldMap = new Map(
    oldDeclarations.declarations.map((entry) => [`${entry.section}\u0000${entry.name}`, entry]),
  );
  const newMap = new Map(
    newDeclarations.declarations.map((entry) => [`${entry.section}\u0000${entry.name}`, entry]),
  );

  for (const [key, entry] of newMap) {
    const before = oldMap.get(key);
    if (!before) {
      findings.push(
        dependencyFinding({
          file: path,
          status,
          kind: "npm-manifest",
          ecosystem: "npm",
          changeType: "dependency-added",
          section: entry.section,
          coordinate: entry.name,
          oldValue: null,
          newValue: entry.value,
          risk: "medium",
          reason:
            "New direct npm dependency; state why it is needed and prefer an existing dependency where possible.",
          evidence: { pointer: pointer([entry.section, entry.name]) },
          details: { direct: true },
        }),
      );
    } else if (before.value !== entry.value) {
      findings.push(
        dependencyFinding({
          file: path,
          status,
          kind: "npm-manifest",
          ecosystem: "npm",
          changeType: "dependency-updated",
          section: entry.section,
          coordinate: entry.name,
          oldValue: before.value,
          newValue: entry.value,
          risk: updateRisk(before.value, entry.value),
          reason: `Dependency range changed from ${before.value} to ${entry.value}.`,
          evidence: { pointer: pointer([entry.section, entry.name]) },
          details: { direct: true, ...updateDetails(before.value, entry.value) },
        }),
      );
    }
  }
  for (const [key, entry] of oldMap) {
    if (newMap.has(key)) continue;
    findings.push(
      dependencyFinding({
        file: path,
        status,
        kind: "npm-manifest",
        ecosystem: "npm",
        changeType: "dependency-removed",
        section: entry.section,
        coordinate: entry.name,
        oldValue: entry.value,
        newValue: null,
        risk: "low",
        reason: "Dependency declaration removed.",
        evidence: { pointer: pointer([entry.section, entry.name]) },
        details: { direct: true },
      }),
    );
  }

  const handled = new Set([...NPM_SECTIONS, "overrides", "resolutions"]);
  const oldScriptMap = oldParsed.value?.scripts ?? {};
  const newScriptMap = newParsed.value?.scripts ?? {};
  const oldScripts = JSON.stringify(oldParsed.value?.scripts ?? null);
  const newScripts = JSON.stringify(newParsed.value?.scripts ?? null);
  if (oldText !== null && newText !== null && oldScripts !== newScripts) {
    // Root cause of a false positive: every scripts-object edit was labelled a
    // lifecycle hook. Only npm lifecycle hooks run automatically on install or
    // publish; a changed test list or explicit developer command does not.
    const lifecycle = new Set([
      "preinstall", "install", "postinstall",
      "preuninstall", "uninstall", "postuninstall",
      "prepublish", "prepublishOnly", "publish", "postpublish",
      "prepack", "pack", "postpack", "prepare",
    ]);
    const changedKeys = new Set([
      ...Object.keys(oldScriptMap),
      ...Object.keys(newScriptMap),
    ].filter((key) => JSON.stringify(oldScriptMap[key]) !== JSON.stringify(newScriptMap[key])));
    const hooks = [...changedKeys].filter((key) => lifecycle.has(key));
    findings.push(
      makeFinding({
        file: path,
        status,
        kind: "npm-manifest",
        ecosystem: "npm",
        changeType: "npm-manifest-hook-change",
        section: "scripts",
        coordinate: "scripts",
        oldValue: oldScripts,
        newValue: newScripts,
        risk: hooks.length > 0 ? "high" : "low",
        reason: hooks.length > 0
          ? `npm lifecycle scripts (${hooks.join(", ")}) execute automatically and must be reviewed.`
          : `Explicit scripts changed (${[...changedKeys].join(", ") || "entries"}); no install/publish lifecycle hook was modified.`,
        evidence: { pointer: pointer(["scripts"]) },
        details: { hooks },
      }),
    );
  }
  if (oldText !== null && newText !== null) {
    for (const key of Object.keys(newParsed.value ?? {})) {
      if (handled.has(key) || key === "scripts") continue;
      if (JSON.stringify(newParsed.value[key]) === JSON.stringify(oldParsed.value?.[key])) continue;
      findings.push(
        makeFinding({
          file: path,
          status,
          kind: "npm-manifest",
          ecosystem: "npm",
          changeType: "npm-manifest-section-change",
          section: key,
          coordinate: key,
          oldValue: JSON.stringify(oldParsed.value?.[key] ?? null),
          newValue: JSON.stringify(newParsed.value[key]),
          risk: "medium",
          reason: `Unreviewed package.json section "${key}" changed; verify it has no build-system impact.`,
          evidence: { pointer: pointer([key]) },
          details: {},
        }),
      );
    }
  }
  const overrideSections = ["overrides", "resolutions"];
  for (const section of overrideSections) {
    const before = flattenOverrides(oldParsed.value?.[section]);
    const after = flattenOverrides(newParsed.value?.[section]);
    const oldOverrides = new Map(before.map((entry) => [entry.coordinate, entry.value]));
    const newOverrides = new Map(after.map((entry) => [entry.coordinate, entry.value]));
    for (const [coordinate, value] of newOverrides) {
      const previous = oldOverrides.get(coordinate);
      if (previous === undefined) {
        findings.push(
          makeFinding({
            file: path,
            status,
            kind: "npm-manifest",
            ecosystem: "npm",
            changeType: "override-added",
            section,
            coordinate,
            oldValue: null,
            newValue: value,
            risk: "high",
            reason: "Dependency override redirects transitive versions and must be reviewed.",
            evidence: { pointer: pointer([section, coordinate]) },
            details: { override: true },
          }),
        );
      } else if (previous !== value) {
        findings.push(
          makeFinding({
            file: path,
            status,
            kind: "npm-manifest",
            ecosystem: "npm",
            changeType: "override-updated",
            section,
            coordinate,
            oldValue: previous,
            newValue: value,
            risk: "high",
            reason: "Dependency override changed and can redirect transitive versions.",
            evidence: { pointer: pointer([section, coordinate]) },
            details: { override: true, ...updateDetails(previous, value) },
          }),
        );
      }
    }
    for (const [coordinate, value] of oldOverrides) {
      if (newOverrides.has(coordinate)) continue;
      findings.push(
        makeFinding({
          file: path,
          status,
          kind: "npm-manifest",
          ecosystem: "npm",
          changeType: "override-removed",
          section,
          coordinate,
          oldValue: value,
          newValue: null,
          risk: "low",
          reason: "Dependency override removed.",
          evidence: { pointer: pointer([section, coordinate]) },
          details: { override: true },
        }),
      );
    }
  }
}

function analyzeCatalog(path, status, oldText, newText, findings) {
  const before = parseCatalog(oldText ?? "");
  const after = parseCatalog(newText ?? "");
  const oldLibraries = new Map(
    before.libraries
      .filter((record) => record.coordinate)
      .map((record) => [record.coordinate, record]),
  );
  const newLibraries = new Map(
    after.libraries
      .filter((record) => record.coordinate)
      .map((record) => [record.coordinate, record]),
  );
  for (const [coordinate, record] of newLibraries) {
    const previous = oldLibraries.get(coordinate);
    const version = catalogResolvedVersion(record, after.versions);
    if (!previous) {
      findings.push(
        dependencyFinding({
          file: path,
          status,
          kind: "catalog",
          ecosystem: "gradle",
          changeType: "dependency-added",
          section: "libraries",
          coordinate,
          oldValue: null,
          newValue: version,
          risk: "medium",
          reason:
            "New dependency declared in the version catalog; state why it is needed and prefer an existing declaration.",
          evidence: { pointer: pointer(["libraries", record.key]) },
          details: { direct: false, catalog: true },
        }),
      );
      continue;
    }
    const previousVersion = catalogResolvedVersion(previous, before.versions);
    if (version !== null && previousVersion !== null && version !== previousVersion) {
      findings.push(
        dependencyFinding({
          file: path,
          status,
          kind: "catalog",
          ecosystem: "gradle",
          changeType: "dependency-updated",
          section: "libraries",
          coordinate,
          oldValue: previousVersion,
          newValue: version,
          risk: updateRisk(previousVersion, version),
          reason: `Catalog version changed from ${previousVersion} to ${version}.`,
          evidence: { pointer: pointer(["libraries", record.key]) },
          details: { direct: false, catalog: true, ...updateDetails(previousVersion, version) },
        }),
      );
    }
  }
  for (const [coordinate, record] of oldLibraries) {
    if (newLibraries.has(coordinate)) continue;
    findings.push(
      dependencyFinding({
        file: path,
        status,
        kind: "catalog",
        ecosystem: "gradle",
        changeType: "dependency-removed",
        section: "libraries",
        coordinate,
        oldValue: catalogResolvedVersion(record, before.versions),
        newValue: null,
        risk: "low",
        reason: "Dependency declaration removed from the version catalog.",
        evidence: { pointer: pointer(["libraries", record.key]) },
        details: { catalog: true },
      }),
    );
  }

  const oldPlugins = new Map(
    before.plugins
      .filter((record) => record.coordinate)
      .map((record) => [record.coordinate, record]),
  );
  const newPlugins = new Map(
    after.plugins
      .filter((record) => record.coordinate)
      .map((record) => [record.coordinate, record]),
  );
  for (const [coordinate, record] of newPlugins) {
    const previous = oldPlugins.get(coordinate);
    const version = catalogResolvedVersion(record, after.versions);
    if (!previous) {
      findings.push(
        makeFinding({
          file: path,
          status,
          kind: "catalog",
          ecosystem: "gradle",
          changeType: "plugin-added",
          section: "plugins",
          coordinate,
          oldValue: null,
          newValue: version,
          risk: "high",
          reason:
            "New build plugin can execute arbitrary code during the build and must be reviewed.",
          evidence: { pointer: pointer(["plugins", record.key]) },
          details: { plugin: true },
        }),
      );
      continue;
    }
    const previousVersion = catalogResolvedVersion(previous, before.versions);
    if (version !== null && previousVersion !== null && version !== previousVersion) {
      findings.push(
        makeFinding({
          file: path,
          status,
          kind: "catalog",
          ecosystem: "gradle",
          changeType: "plugin-updated",
          section: "plugins",
          coordinate,
          oldValue: previousVersion,
          newValue: version,
          risk: "high",
          reason: "Build plugin version changed and must be reviewed.",
          evidence: { pointer: pointer(["plugins", record.key]) },
          details: { plugin: true, ...updateDetails(previousVersion, version) },
        }),
      );
    }
  }
  for (const [coordinate, record] of oldPlugins) {
    if (newPlugins.has(coordinate)) continue;
    findings.push(
      makeFinding({
        file: path,
        status,
        kind: "catalog",
        ecosystem: "gradle",
        changeType: "plugin-removed",
        section: "plugins",
        coordinate,
        oldValue: catalogResolvedVersion(record, before.versions),
        newValue: null,
        risk: "low",
        reason: "Build plugin removed from the version catalog.",
        evidence: { pointer: pointer(["plugins", record.key]) },
        details: { plugin: true },
      }),
    );
  }

  const beforeReferenced = new Set();
  const afterReferenced = new Set();
  for (const record of [...before.libraries, ...before.plugins]) {
    if (record.versionRef) beforeReferenced.add(record.versionRef);
  }
  for (const record of [...after.libraries, ...after.plugins]) {
    if (record.versionRef) afterReferenced.add(record.versionRef);
  }
  for (const [key, value] of after.versions) {
    const previous = before.versions.get(key);
    if (previous === undefined || previous === value) continue;
    if (afterReferenced.has(key) || beforeReferenced.has(key)) continue;
    findings.push(
      makeFinding({
        file: path,
        status,
        kind: "catalog",
        ecosystem: "gradle",
        changeType: "catalog-version-changed",
        section: "versions",
        coordinate: key,
        oldValue: previous,
        newValue: value,
        risk: "low",
        reason: "Unreferenced catalog version changed.",
        evidence: { pointer: pointer(["versions", key]) },
        details: {},
      }),
    );
  }
}

function analyzeGradleFile(path, status, oldText, newText, oldCatalog, newCatalog, findings) {
  const before = parseGradle(oldText ?? "", oldCatalog);
  const after = parseGradle(newText ?? "", newCatalog);

  for (const [coordinate, repository] of after.repositories) {
    if (before.repositories.has(coordinate)) continue;
    findings.push(
      makeFinding({
        file: path,
        status,
        kind: fileKind(path),
        ecosystem: "gradle",
        changeType: "repository-added",
        section: "repositories",
        coordinate: repository.coordinate,
        oldValue: null,
        newValue: repository.coordinate,
        risk: repository.risk,
        reason: repository.reason,
        evidence: { pointer: "#/repositories" },
        details: repository.details,
      }),
    );
  }
  for (const [coordinate] of before.repositories) {
    if (after.repositories.has(coordinate)) continue;
    findings.push(
      makeFinding({
        file: path,
        status,
        kind: fileKind(path),
        ecosystem: "gradle",
        changeType: "repository-removed",
        section: "repositories",
        coordinate,
        oldValue: coordinate,
        newValue: null,
        risk: "info",
        reason: "Repository removed.",
        evidence: { pointer: "#/repositories" },
        details: {},
      }),
    );
  }

  for (const [coordinate, plugin] of after.plugins) {
    const previous = before.plugins.get(coordinate);
    if (!previous) {
      findings.push(
        makeFinding({
          file: path,
          status,
          kind: fileKind(path),
          ecosystem: "gradle",
          changeType: "plugin-added",
          section: "plugins",
          coordinate,
          oldValue: null,
          newValue: plugin.version,
          risk: "high",
          reason:
            "New build plugin can execute arbitrary code during the build and must be reviewed.",
          evidence: { pointer: "#/plugins" },
          details: { plugin: true },
        }),
      );
    } else if ((plugin.version ?? null) !== (previous.version ?? null)) {
      findings.push(
        makeFinding({
          file: path,
          status,
          kind: fileKind(path),
          ecosystem: "gradle",
          changeType: "plugin-updated",
          section: "plugins",
          coordinate,
          oldValue: previous.version,
          newValue: plugin.version,
          risk: "high",
          reason: "Build plugin version changed and must be reviewed.",
          evidence: { pointer: "#/plugins" },
          details: { plugin: true },
        }),
      );
    }
  }
  for (const [coordinate, plugin] of before.plugins) {
    if (after.plugins.has(coordinate)) continue;
    findings.push(
      makeFinding({
        file: path,
        status,
        kind: fileKind(path),
        ecosystem: "gradle",
        changeType: "plugin-removed",
        section: "plugins",
        coordinate,
        oldValue: plugin.version,
        newValue: null,
        risk: "low",
        reason: "Build plugin removed.",
        evidence: { pointer: "#/plugins" },
        details: { plugin: true },
      }),
    );
  }

  for (const [key, dependency] of after.dependencies) {
    const previous = before.dependencies.get(key);
    const buildTime = dependency.section === "classpath";
    if (!previous) {
      findings.push(
        dependencyFinding({
          file: path,
          status,
          kind: fileKind(path),
          ecosystem: "gradle",
          changeType: "dependency-added",
          section: dependency.section,
          coordinate: dependency.coordinate,
          oldValue: null,
          newValue: dependency.version,
          risk: dependency.project ? "low" : "medium",
          reason: dependency.project
            ? "Project module dependency added; review the module boundary."
            : "New direct Gradle dependency; state why it is needed and prefer an existing declaration.",
          evidence: { pointer: "#/dependencies" },
          details: {
            direct: !dependency.local && !dependency.project,
            local: dependency.local,
            project: dependency.project,
            configuration: dependency.configuration,
          },
          local: dependency.local,
          buildTime,
        }),
      );
    } else if (
      (dependency.version ?? null) !== (previous.version ?? null) ||
      dependency.local !== previous.local
    ) {
      findings.push(
        dependencyFinding({
          file: path,
          status,
          kind: fileKind(path),
          ecosystem: "gradle",
          changeType: "dependency-updated",
          section: dependency.section,
          coordinate: dependency.coordinate,
          oldValue: previous.version,
          newValue: dependency.version,
          risk: dependency.local ? "high" : updateRisk(previous.version, dependency.version),
          reason: `Dependency version changed from ${previous.version ?? "none"} to ${dependency.version ?? "none"}.`,
          evidence: { pointer: "#/dependencies" },
          details: {
            direct: !dependency.local && !dependency.project,
            local: dependency.local,
            project: dependency.project,
            configuration: dependency.configuration,
            ...updateDetails(previous.version, dependency.version),
          },
          local: dependency.local,
          buildTime,
        }),
      );
    }
  }
  for (const [key, dependency] of before.dependencies) {
    if (after.dependencies.has(key)) continue;
    findings.push(
      dependencyFinding({
        file: path,
        status,
        kind: fileKind(path),
        ecosystem: "gradle",
        changeType: "dependency-removed",
        section: dependency.section,
        coordinate: dependency.coordinate,
        oldValue: dependency.version,
        newValue: null,
        risk: "low",
        reason: "Dependency declaration removed.",
        evidence: { pointer: "#/dependencies" },
        details: { local: dependency.local, project: dependency.project },
      }),
    );
  }

  for (const [coordinate, toolchain] of after.toolchains) {
    const previous = before.toolchains.get(coordinate);
    if (!previous) {
      findings.push(
        makeFinding({
          file: path,
          status,
          kind: fileKind(path),
          ecosystem: "gradle",
          changeType: "toolchain-added",
          section: "toolchain",
          coordinate,
          oldValue: null,
          newValue: toolchain.value,
          risk: "high",
          reason: "Java toolchain pinned; confirm the version is supported by the project.",
          evidence: { pointer: "#/toolchain" },
          details: {},
        }),
      );
    } else if (previous.value !== toolchain.value) {
      findings.push(
        makeFinding({
          file: path,
          status,
          kind: fileKind(path),
          ecosystem: "gradle",
          changeType: "toolchain-updated",
          section: "toolchain",
          coordinate,
          oldValue: previous.value,
          newValue: toolchain.value,
          risk: "high",
          reason: `Java toolchain changed from ${previous.value} to ${toolchain.value}.`,
          evidence: { pointer: "#/toolchain" },
          details: {},
        }),
      );
    }
  }

  const residual = addedLines(oldText, newText)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !after.consumed.has(line) && !before.consumed.has(line))
    .filter((line) => !STRUCTURAL_LINE.test(line))
    .filter((line) => !/^(?:\/\/|\/\*|\*|\*\/)/.test(line));
  if (residual.length > 0) {
    const suspicious = residual.some((line) => SUSPICIOUS_BUILD.test(line));
    findings.push(
      makeFinding({
        file: path,
        status,
        kind: fileKind(path),
        ecosystem: "gradle",
        changeType: "build-logic-change",
        section: "build-logic",
        coordinate: residual[0],
        oldValue: null,
        newValue: null,
        risk: suspicious ? "high" : "medium",
        reason: suspicious
          ? "Unrecognized build logic may download or execute code and requires review."
          : "Unrecognized build logic changed and requires review.",
        evidence: { pointer: "#/build-logic" },
        details: {
          lines: residual.slice(0, MAX_LOGIC_LINES).map((line) => sanitizeText(line, 200)),
        },
      }),
    );
  }
}

function lockDetails(before, after, keyedByName) {
  const added = [];
  const updated = [];
  const removed = [];
  for (const [key, entry] of after) {
    const previous = before.get(key);
    const provenance = {
      resolved: entry.resolved ? sanitizeUrl(entry.resolved) : null,
      integrity: entry.integrity ?? null,
    };
    if (!previous) {
      added.push({ name: entry.name, version: entry.version, ...provenance });
    } else if (
      previous.version !== entry.version ||
      previous.resolved !== entry.resolved ||
      previous.integrity !== entry.integrity
    ) {
      updated.push({
        name: entry.name,
        oldVersion: previous.version,
        newVersion: entry.version,
        ...provenance,
      });
    }
  }
  for (const [key, entry] of before) {
    if (!after.has(key)) removed.push({ name: entry.name, version: entry.version });
  }
  const trim = (entries) => entries.slice(0, MAX_DETAIL_ENTRIES);
  return { added: trim(added), updated: trim(updated), removed: trim(removed), keyedByName };
}

function analyzeLockfile(options) {
  const { file, status, kind, ecosystem, before, after, counterpart, error, keyedByName } = options;
  const findings = options.findings;
  if (error) {
    findings.push(
      makeFinding({
        file,
        status,
        kind,
        ecosystem,
        changeType: "lockfile-unreadable",
        coordinate: file,
        risk: "high",
        reason: `Lockfile could not be interpreted: ${error}`,
        details: {},
      }),
    );
    return;
  }
  const details = lockDetails(before, after, keyedByName);
  const changed =
    details.added.length > 0 || details.updated.length > 0 || details.removed.length > 0;
  if (!counterpart) {
    findings.push(
      makeFinding({
        file,
        status,
        kind,
        ecosystem,
        changeType: "lockfile-only",
        section: "lockfile",
        coordinate: file,
        oldValue: null,
        newValue: null,
        risk: "medium",
        reason:
          "Lockfile changed without a corresponding manifest change; resolved versions can change without review.",
        evidence: { pointer: "#/lockfile" },
        details: { ...details, lockfileOnly: true },
      }),
    );
    return;
  }
  findings.push(
    makeFinding({
      file,
      status,
      kind,
      ecosystem,
      changeType: "lockfile-changed",
      section: "lockfile",
      coordinate: file,
      oldValue: null,
      newValue: null,
      risk: changed ? "low" : "info",
      reason: "Lockfile updated alongside a manifest change.",
      evidence: { pointer: "#/lockfile" },
      details,
    }),
  );
}

function analyzeTextConfig(path, status, oldText, newText, findings) {
  if (
    basename(path) === ".npmrc" ||
    basename(path) === ".yarnrc" ||
    basename(path) === ".yarnrc.yml"
  ) {
    const changedKeys = new Set();
    const collect = (text) => {
      const map = new Map();
      for (const raw of (text ?? "").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#") || line.startsWith(";")) continue;
        const separator = line.indexOf("=");
        const key = separator < 0 ? line : line.slice(0, separator).trim();
        const value = separator < 0 ? "" : line.slice(separator + 1).trim();
        map.set(key, value);
      }
      return map;
    };
    const before = collect(oldText);
    const after = collect(newText);
    for (const [key, value] of after) {
      if (before.get(key) !== value) changedKeys.add(key);
    }
    for (const key of before.keys()) if (!after.has(key)) changedKeys.add(key);
    const text = newText ?? "";
    const insecure = /\bregistry\s*=\s*http:\/\//i.test(text);
    // Scoped registry entries start with `//registry/…:_authToken=…`, so the
    // credential key is not at line start.
    const credentials = /(?:_auth(?:Token)?|_password|password|token)\s*[:=]/i.test(text);
    const risk = insecure || credentials ? "high" : "medium";
    const reasons = [];
    if (insecure)
      reasons.push("npm registry is configured over insecure HTTP and can be tampered with.");
    if (credentials) {
      reasons.push(
        "npm configuration contains a credential-bearing field and must not be committed.",
      );
    }
    if (!reasons.length)
      reasons.push("npm configuration changed; verify registry and authentication settings.");
    const coordinate =
      (insecure && "registry") ||
      (credentials && [...changedKeys].find((key) => /auth|token|password/i.test(key))) ||
      [...changedKeys][0] ||
      basename(path);
    findings.push(
      makeFinding({
        file: path,
        status,
        kind: fileKind(path),
        ecosystem: "npm",
        changeType: basename(path) === ".npmrc" ? "npmrc-changed" : "yarnrc-changed",
        section: "registry",
        coordinate,
        oldValue: before.get(coordinate) === undefined ? null : "[redacted]",
        newValue: after.get(coordinate) === undefined ? null : "[redacted]",
        risk,
        reason: reasons.join(" "),
        evidence: { pointer: "#/registry" },
        details: {
          keys: [...changedKeys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 40),
          insecure,
          credentials,
        },
      }),
    );
  }
}

function analyzeWrapperProperties(path, status, oldText, newText, findings) {
  const extract = (text) => {
    const map = new Map();
    for (const raw of (text ?? "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator < 0) continue;
      map.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
    return map;
  };
  const before = extract(oldText);
  const after = extract(newText);
  const oldUrl = before.get("distributionUrl") ?? null;
  const newUrl = after.get("distributionUrl") ?? null;
  findings.push(
    makeFinding({
      file: path,
      status,
      kind: "wrapper-properties",
      ecosystem: "gradle",
      changeType: "wrapper-changed",
      section: "wrapper",
      coordinate: "distributionUrl",
      oldValue: oldUrl === null ? null : sanitizeUrl(oldUrl),
      newValue: newUrl === null ? null : sanitizeUrl(newUrl),
      risk: "high",
      reason:
        "Gradle wrapper distribution download settings changed; the wrapper can download and execute a different Gradle distribution.",
      evidence: { pointer: "#/wrapper" },
      details: {
        oldDistributionUrl: oldUrl === null ? null : sanitizeUrl(oldUrl),
        newDistributionUrl: newUrl === null ? null : sanitizeUrl(newUrl),
        checksumChanged: before.get("distributionSha256Sum") !== after.get("distributionSha256Sum"),
      },
    }),
  );
}

function analyzeWrapperJar(path, status, oldBuffer, newBuffer, findings) {
  findings.push(
    makeFinding({
      file: path,
      status,
      kind: "wrapper-jar",
      ecosystem: "gradle",
      changeType: "wrapper-jar-changed",
      section: "wrapper",
      coordinate: "gradle-wrapper.jar",
      oldValue: oldBuffer ? `${oldBuffer.length} bytes` : null,
      newValue: newBuffer ? `${newBuffer.length} bytes` : null,
      risk: "high",
      reason:
        "Gradle wrapper JAR changed; wrapper JARs execute before the build and must be reviewed.",
      evidence: { pointer: "#/wrapper" },
      details: { oldBytes: oldBuffer?.length ?? null, newBytes: newBuffer?.length ?? null },
    }),
  );
}

function analyzeVerificationMetadata(path, status, findings) {
  findings.push(
    makeFinding({
      file: path,
      status,
      kind: "verification-metadata",
      ecosystem: "gradle",
      changeType: "verification-metadata-changed",
      section: "verification",
      coordinate: "verification-metadata.xml",
      risk: "high",
      reason:
        "Gradle dependency verification metadata changed and can weaken artifact verification.",
      evidence: { pointer: "#/verification" },
      details: {},
    }),
  );
}

function analyzeGradleProperties(path, status, newText, findings) {
  const text = newText ?? "";
  const risky = /https?:\/\/|password|token|_auth|proxy/i.test(text);
  findings.push(
    makeFinding({
      file: path,
      status,
      kind: "gradle-properties",
      ecosystem: "gradle",
      changeType: "build-property-changed",
      section: "properties",
      coordinate: "gradle.properties",
      risk: risky ? "high" : "medium",
      reason: risky
        ? "Gradle properties include network, credential or proxy settings that require review."
        : "Gradle properties changed; confirm the build behavior change is intended.",
      evidence: { pointer: "#/properties" },
      details: { risky },
    }),
  );
}

function analyzeMavenBuild(path, status, findings) {
  findings.push(
    makeFinding({
      file: path,
      status,
      kind: "maven-build",
      ecosystem: "maven",
      changeType: "build-file-changed",
      section: "build",
      coordinate: "pom.xml",
      risk: "medium",
      reason: "Maven build file changed; dependency and plugin declarations require review.",
      evidence: { pointer: "#/build" },
      details: {},
    }),
  );
}

function loadCatalogs(cwd, revision) {
  const catalogs = new Map();
  for (const path of listTracked(cwd, revision)) {
    if (fileKind(path) !== "catalog") continue;
    const text = readAt(cwd, revision, path);
    if (text !== null) catalogs.set(path, parseCatalog(text));
  }
  return catalogs;
}

function catalogFor(path, catalogs) {
  const directory = dirname(path);
  const candidates = [];
  if (directory !== ".") candidates.push(`${directory}/gradle/libs.versions.toml`);
  candidates.push("gradle/libs.versions.toml");
  for (const candidate of candidates) {
    if (catalogs.has(candidate)) return catalogs.get(candidate);
  }
  const sorted = [...catalogs.keys()].sort();
  for (const candidate of sorted) {
    if (candidate.endsWith(".versions.toml")) return catalogs.get(candidate);
  }
  return null;
}

function compareText(left, right) {
  const a = left ?? "";
  const b = right ?? "";
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function analyzeRepository(cwd, base, head, options) {
  const changes = listChanged(cwd, base, head);
  const baseCatalogs = loadCatalogs(cwd, base);
  const headCatalogs = loadCatalogs(cwd, head);
  const entries = [];

  for (const change of changes) {
    const kind = fileKind(change.path) ?? fileKind(change.oldPath ?? "");
    if (!kind) continue;
    const oldPath = change.oldPath ?? change.path;
    const oldText =
      change.status === "A" || change.oldPath === null ? null : readAt(cwd, base, oldPath);
    const newText = change.status === "D" ? null : readAt(cwd, head, change.path);
    entries.push({
      status: change.status,
      path: change.path,
      oldPath,
      kind,
      oldText,
      newText,
    });
  }

  const findings = [];
  const npmManifestDirs = new Set();
  for (const entry of entries) {
    if (entry.kind === "npm-manifest") npmManifestDirs.add(dirname(entry.path));
  }
  const gradleManifestChanged = entries.some((entry) =>
    ["gradle-build", "gradle-settings", "catalog"].includes(entry.kind),
  );

  // Removing a manifest must not turn every dependency removal into low-risk
  // noise. Deletions of the primary declaration files fail closed.
  for (const entry of entries) {
    if (entry.status !== "D") continue;
    if (entry.kind === "npm-manifest") {
      findings.push(
        makeFinding({
          file: entry.path,
          status: entry.status,
          kind: entry.kind,
          ecosystem: "npm",
          changeType: "manifest-removed",
          section: "manifest",
          coordinate: entry.path,
          risk: "high",
          reason: "Package manifest removed; dependency removals must not bypass review.",
          details: {},
        }),
      );
    } else if (entry.kind === "catalog") {
      findings.push(
        makeFinding({
          file: entry.path,
          status: entry.status,
          kind: entry.kind,
          ecosystem: "gradle",
          changeType: "catalog-removed",
          section: "catalog",
          coordinate: entry.path,
          risk: "high",
          reason:
            "Gradle version catalog removed; dependency and plugin declarations must not disappear without review.",
          details: {},
        }),
      );
    } else if (entry.kind === "gradle-build" || entry.kind === "gradle-settings") {
      findings.push(
        makeFinding({
          file: entry.path,
          status: entry.status,
          kind: entry.kind,
          ecosystem: "gradle",
          changeType: "build-file-removed",
          section: "build",
          coordinate: entry.path,
          risk: "high",
          reason:
            "Gradle build or settings file removed; repository, plugin and dependency behavior must be reviewed.",
          details: {},
        }),
      );
    }
  }

  for (const entry of entries) {
    switch (entry.kind) {
      case "npm-manifest":
        analyzeNpmManifest(entry.path, entry.status, entry.oldText, entry.newText, findings);
        break;
      case "catalog":
        analyzeCatalog(entry.path, entry.status, entry.oldText, entry.newText, findings);
        break;
      case "gradle-build":
      case "gradle-settings":
        analyzeGradleFile(
          entry.path,
          entry.status,
          entry.oldText,
          entry.newText,
          catalogFor(entry.oldPath, baseCatalogs),
          catalogFor(entry.path, headCatalogs),
          findings,
        );
        break;
      case "npm-lock": {
        const before = npmLockModel(entry.oldText ?? "");
        const after = npmLockModel(entry.newText ?? "");
        analyzeLockfile({
          file: entry.path,
          status: entry.status,
          kind: entry.kind,
          ecosystem: "npm",
          before: before.entries,
          after: after.entries,
          counterpart: npmManifestDirs.has(dirname(entry.path)),
          error: before.error ?? after.error,
          keyedByName: false,
          findings,
        });
        break;
      }
      case "yarn-lock": {
        const before = yarnLockModel(entry.oldText ?? "");
        const after = yarnLockModel(entry.newText ?? "");
        analyzeLockfile({
          file: entry.path,
          status: entry.status,
          kind: entry.kind,
          ecosystem: "npm",
          before: before.entries,
          after: after.entries,
          counterpart: npmManifestDirs.has(dirname(entry.path)),
          error: before.error ?? after.error,
          keyedByName: true,
          findings,
        });
        break;
      }
      case "pnpm-lock": {
        const before = pnpmLockModel(entry.oldText ?? "");
        const after = pnpmLockModel(entry.newText ?? "");
        analyzeLockfile({
          file: entry.path,
          status: entry.status,
          kind: entry.kind,
          ecosystem: "npm",
          before: before.entries,
          after: after.entries,
          counterpart: npmManifestDirs.has(dirname(entry.path)),
          error: before.error ?? after.error,
          keyedByName: true,
          findings,
        });
        break;
      }
      case "gradle-lock": {
        const before = gradleLockModel(entry.oldText ?? "");
        const after = gradleLockModel(entry.newText ?? "");
        analyzeLockfile({
          file: entry.path,
          status: entry.status,
          kind: entry.kind,
          ecosystem: "gradle",
          before: before.entries,
          after: after.entries,
          counterpart: gradleManifestChanged,
          error: before.error ?? after.error,
          keyedByName: true,
          findings,
        });
        break;
      }
      case "npmrc":
      case "yarnrc":
        analyzeTextConfig(entry.path, entry.status, entry.oldText, entry.newText, findings);
        break;
      case "wrapper-properties":
        analyzeWrapperProperties(entry.path, entry.status, entry.oldText, entry.newText, findings);
        break;
      case "wrapper-jar":
        analyzeWrapperJar(
          entry.path,
          entry.status,
          readBufferAt(cwd, base, entry.oldPath),
          readBufferAt(cwd, head, entry.path),
          findings,
        );
        break;
      case "verification-metadata":
        analyzeVerificationMetadata(entry.path, entry.status, findings);
        break;
      case "gradle-properties":
        analyzeGradleProperties(entry.path, entry.status, entry.newText, findings);
        break;
      case "maven-build":
        analyzeMavenBuild(entry.path, entry.status, findings);
        break;
      default:
        break;
    }
  }

  const state = loadProjectState(cwd, head, headCatalogs);
  attachReuseCandidates(findings, state);
  const license = summarizeLicenses(cwd, head, state);
  const advisories = summarizeAdvisories(cwd, head, options, findings);
  const sbom = summarizeSbom(options, state);

  findings.sort(
    (left, right) =>
      compareText(left.file, right.file) ||
      compareText(left.changeType, right.changeType) ||
      compareText(left.coordinate, right.coordinate) ||
      compareText(left.oldValue, right.oldValue) ||
      compareText(left.newValue, right.newValue),
  );
  findings.forEach((entry, index) => {
    entry.id = `dep-${String(index + 1).padStart(4, "0")}`;
  });

  const byRisk = { info: 0, low: 0, medium: 0, high: 0 };
  for (const finding of findings) byRisk[finding.risk] += 1;
  const highestRisk = maxRisk(findings) ?? "none";
  const files = entries
    .map((entry) => ({ file: entry.path, status: entry.status, kind: entry.kind }))
    .sort((left, right) => compareText(left.file, right.file));

  return {
    schemaVersion: SCHEMA_VERSION,
    base: { requested: options.base, resolved: base },
    head: { resolved: head },
    summary: {
      filesChanged: files.length,
      findingsTotal: findings.length,
      byRisk,
      highestRisk,
      reviewRequired: findings.some((finding) => finding.review),
      lockfileOnly: findings.some((finding) => finding.changeType === "lockfile-only"),
      reuse: reuseSummary(findings),
      license,
      advisories,
      sbom,
    },
    files,
    findings,
    limitations: LIMITATIONS,
  };
}

function loadProjectState(cwd, revision, catalogs) {
  const npm = [];
  const gradle = [];
  const tracked = listTracked(cwd, revision).filter((path) => fileKind(path));
  for (const path of tracked) {
    const kind = fileKind(path);
    const text = readAt(cwd, revision, path);
    if (text === null) continue;
    if (kind === "npm-manifest") {
      const parsed = parseJson(text);
      if (parsed.error) continue;
      const declarations = npmDeclarations(parsed.value);
      for (const entry of declarations.declarations) {
        npm.push({
          name: entry.name,
          version: entry.value,
          section: entry.section,
          file: path,
        });
      }
    } else if (kind === "catalog") {
      const catalog = catalogs.get(path) ?? parseCatalog(text);
      for (const record of catalog.libraries) {
        if (!record.coordinate) continue;
        gradle.push({
          coordinate: record.coordinate,
          version: catalogResolvedVersion(record, catalog.versions),
          file: path,
          section: "libraries",
        });
      }
    } else if (kind === "gradle-build" || kind === "gradle-settings") {
      const model = parseGradle(text, catalogFor(path, catalogs));
      for (const dependency of model.dependencies.values()) {
        if (dependency.local || dependency.project) continue;
        gradle.push({
          coordinate: dependency.coordinate,
          version: dependency.version,
          file: path,
          section: dependency.section,
        });
      }
    }
  }
  return { npm, gradle, catalogs };
}

function attachReuseCandidates(findings, state) {
  const index = new Map();
  const add = (coordinate, candidate) => {
    if (!coordinate) return;
    const list = index.get(coordinate) ?? [];
    if (!list.some((entry) => entry.file === candidate.file && entry.kind === candidate.kind)) {
      list.push(candidate);
    }
    index.set(coordinate, list);
  };
  for (const entry of state.npm) {
    add(entry.name, {
      file: entry.file,
      kind: "same-package",
      coordinate: entry.name,
      version: entry.version,
      section: entry.section,
    });
  }
  for (const entry of state.gradle) {
    add(entry.coordinate, {
      file: entry.file,
      kind: "exact-module",
      coordinate: entry.coordinate,
      version: entry.version,
      section: entry.section,
    });
  }
  for (const finding of findings) {
    if (finding.changeType !== "dependency-added") continue;
    if (finding.details.local || finding.details.project) continue;
    const candidates = (index.get(finding.coordinate) ?? [])
      .filter((candidate) => candidate.file !== finding.file)
      .sort(
        (left, right) => compareText(left.file, right.file) || compareText(left.kind, right.kind),
      )
      .slice(0, 10);
    finding.equivalenceCandidates = candidates;
  }
}

function reuseSummary(findings) {
  const addedDirect = findings.filter(
    (finding) =>
      finding.changeType === "dependency-added" &&
      finding.details.direct === true &&
      !finding.details.local &&
      !finding.details.project,
  ).length;
  const candidates = findings.reduce(
    (total, finding) => total + finding.equivalenceCandidates.length,
    0,
  );
  return {
    addedDirect,
    candidates,
    message:
      "State why each new direct dependency is needed and reuse an existing project declaration where possible.",
  };
}

function summarizeLicenses(cwd, revision, state) {
  const pass = [];
  const fail = [];
  const unknown = [];
  const seen = new Set();
  for (const entry of state.npm) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    const text = readAt(cwd, revision, `node_modules/${entry.name}/package.json`);
    if (text === null) {
      unknown.push({
        name: entry.name,
        reason: "License metadata is not present under node_modules at HEAD.",
      });
      continue;
    }
    const parsed = parseJson(text);
    if (parsed.error || !parsed.value) {
      unknown.push({ name: entry.name, reason: "Installed package metadata could not be parsed." });
      continue;
    }
    const raw = parsed.value.license;
    const license =
      typeof raw === "string"
        ? raw
        : raw && typeof raw === "object" && typeof raw.type === "string"
          ? raw.type
          : null;
    if (!license) {
      unknown.push({ name: entry.name, reason: "No license field was declared." });
    } else if (PERMISSIVE_LICENSES.has(license.trim())) {
      pass.push({ name: entry.name, license });
    } else if (COPYLEFT_PATTERN.test(license)) {
      fail.push({ name: entry.name, license });
    } else {
      unknown.push({
        name: entry.name,
        license,
        reason: "License expression is not on the permissive allowlist.",
      });
    }
  }
  for (const entry of state.gradle) {
    if (!entry.coordinate) continue;
    if (seen.has(entry.coordinate)) continue;
    seen.add(entry.coordinate);
    unknown.push({
      name: entry.coordinate,
      reason: "Gradle license metadata is unavailable without dependency resolution.",
    });
  }
  const sortByName = (entries) => entries.sort((left, right) => compareText(left.name, right.name));
  sortByName(pass);
  sortByName(fail);
  sortByName(unknown);
  const status = fail.length > 0 ? "fail" : unknown.length > 0 ? "unknown" : "pass";
  return {
    status,
    pass,
    fail,
    unknown,
    note: "License status is best-effort from local metadata only; unknown is not a pass.",
  };
}

function summarizeAdvisories(cwd, revision, options, findings) {
  if (!options.audit) {
    return {
      status: "unavailable",
      reason: "Advisory audit was not requested; no vulnerability lookup was performed.",
      vulnerabilities: null,
    };
  }
  const lockfile = readAt(cwd, revision, "package-lock.json");
  if (lockfile === null) {
    return {
      status: "unavailable",
      reason: "No package-lock.json exists at HEAD, so npm audit cannot be scoped.",
      vulnerabilities: null,
    };
  }
  const result = spawnSync("npm", ["audit", "--json", "--package-lock-only", "--ignore-scripts"], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const parsed = parseJson(result.stdout ?? "");
  if (parsed.error || !parsed.value) {
    return {
      status: "unavailable",
      reason: sanitizeText(
        `npm audit did not return usable data: ${(result.stderr || result.stdout || "no output").trim().slice(0, 300)}`,
      ),
      vulnerabilities: null,
    };
  }
  const counts = parsed.value.metadata?.vulnerabilities;
  if (!counts) {
    return {
      status: "unavailable",
      reason: "npm audit response did not include vulnerability counts.",
      vulnerabilities: null,
    };
  }
  const high = Number(counts.high ?? 0) + Number(counts.critical ?? 0);
  if (high > 0) {
    findings.push(
      makeFinding({
        file: "package-lock.json",
        status: "M",
        kind: "npm-lock",
        ecosystem: "npm",
        changeType: "advisory-vulnerabilities",
        section: "advisories",
        coordinate: "npm",
        risk: "high",
        reason: "npm audit reported high or critical advisories for the resolved dependency graph.",
        details: { high, critical: Number(counts.critical ?? 0) },
      }),
    );
  }
  return {
    status: "available",
    reason: "npm audit completed against the HEAD package lock.",
    vulnerabilities: {
      info: Number(counts.info ?? 0),
      low: Number(counts.low ?? 0),
      moderate: Number(counts.moderate ?? 0),
      high: Number(counts.high ?? 0),
      critical: Number(counts.critical ?? 0),
    },
  };
}

function sbomComponents(state) {
  const seen = new Set();
  const components = [];
  const add = (name, version, ecosystem) => {
    const key = `${ecosystem}\u0000${name}\u0000${version ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    const purl =
      ecosystem === "npm"
        ? `pkg:npm/${name}${version ? `@${version}` : ""}`
        : `pkg:maven/${name.replace(":", "/")}${version ? `@${version}` : ""}`;
    components.push({
      type: "library",
      name,
      version: version ?? null,
      purl,
      properties: [{ name: "ecosystem", value: ecosystem }],
    });
  };
  for (const entry of state.npm) add(entry.name, entry.version, "npm");
  for (const entry of state.gradle) add(entry.coordinate, entry.version, "maven");
  components.sort(
    (left, right) =>
      left.name.localeCompare(right.name) || compareText(left.version, right.version),
  );
  return components;
}

function summarizeSbom(options, state) {
  const components = sbomComponents(state);
  if (!options.sbom) {
    return {
      status: "unavailable",
      reason: "SBOM generation was not requested.",
      components: components.length,
    };
  }
  const document = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      tools: [{ name: "android-mcp-dependency-review", version: String(SCHEMA_VERSION) }],
    },
    components,
  };
  writeFileSync(options.sbom, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return {
    status: "written",
    path: options.sbom,
    components: components.length,
  };
}

function markdownCell(value) {
  return sanitizeText(value ?? "", 240)
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function renderMarkdown(report) {
  const riskLabel = { info: "Info", low: "Low", medium: "Medium", high: "High" };
  const lines = [];
  lines.push("# Dependency and build-system review", "");
  lines.push(`- Base: \`${report.base.resolved}\``);
  lines.push(`- Head: \`${report.head.resolved}\``);
  lines.push(
    `- Monitored files changed: ${report.summary.filesChanged} · Findings: ${report.summary.findingsTotal} · Highest risk: ${riskLabel[report.summary.highestRisk] ?? "None"}`,
  );
  lines.push(
    `- Human review required: ${report.summary.reviewRequired ? "yes" : "no"} · Lockfile-only change: ${report.summary.lockfileOnly ? "yes" : "no"}`,
  );
  lines.push("");
  if (report.findings.length === 0) {
    lines.push("No monitored dependency or build-system changes were found.", "");
  } else {
    lines.push("## Findings", "");
    lines.push("| Risk | Change | File | Coordinate | Reason |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const finding of report.findings) {
      lines.push(
        `| ${riskLabel[finding.risk] ?? finding.risk} | ${markdownCell(finding.changeType)} | ${markdownCell(finding.file)} | ${markdownCell(finding.coordinate)} | ${markdownCell(finding.reason)} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Supply-chain status", "");
  lines.push(
    `- License: ${report.summary.license.status} (${report.summary.license.fail.length} failed, ${report.summary.license.unknown.length} unknown)`,
  );
  lines.push(
    `- Advisories: ${report.summary.advisories.status} — ${report.summary.advisories.reason}`,
  );
  lines.push(
    `- SBOM: ${report.summary.sbom.status}${report.summary.sbom.path ? ` — ${report.summary.sbom.path}` : ""}`,
  );
  lines.push(
    `- Reuse: ${report.summary.reuse.addedDirect} direct dependencies added; ${report.summary.reuse.message}`,
  );
  lines.push("");
  lines.push("## Limitations", "");
  for (const limitation of report.limitations) lines.push(`- ${limitation}`);
  lines.push("");
  return lines.join("\n");
}

function usage() {
  return [
    "Usage: node scripts/dependency-review.mjs --base <revision> [options]",
    "",
    "Options:",
    "  --base <revision>     Required base revision to compare with HEAD",
    "  --format <format>     json or markdown (default: markdown)",
    "  --fail-on <risk>      high, medium, low or none (default: high)",
    "  --sbom <path>         Write a deterministic CycloneDX 1.5 SBOM",
    "  --audit               Run npm audit for the HEAD package lock",
    "  --help                Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    base: null,
    format: "markdown",
    failOn: DEFAULT_FAIL_ON,
    sbom: null,
    audit: false,
    help: false,
  };
  const args = [...argv];
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "--base") {
      options.base = args.shift() ?? null;
    } else if (argument.startsWith("--base=")) {
      options.base = argument.slice("--base=".length);
    } else if (argument === "--format") {
      options.format = args.shift() ?? "";
    } else if (argument.startsWith("--format=")) {
      options.format = argument.slice("--format=".length);
    } else if (argument === "--fail-on") {
      options.failOn = args.shift() ?? "";
    } else if (argument.startsWith("--fail-on=")) {
      options.failOn = argument.slice("--fail-on=".length);
    } else if (argument === "--sbom") {
      options.sbom = args.shift() ?? null;
    } else if (argument.startsWith("--sbom=")) {
      options.sbom = argument.slice("--sbom=".length);
    } else if (argument === "--audit") {
      options.audit = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (options.help) return options;
  if (!options.base) throw new Error("--base is required");
  if (!["json", "markdown"].includes(options.format)) {
    throw new Error(`--format must be json or markdown, got "${options.format}"`);
  }
  if (!["high", "medium", "low", "none"].includes(options.failOn)) {
    throw new Error(`--fail-on must be high, medium, low or none, got "${options.failOn}"`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const cwd = repoRoot(process.cwd());
  const head = resolveCommit(cwd, "HEAD");
  if (!head) throw new Error("cannot resolve HEAD");
  const base = resolveCommit(cwd, options.base);
  if (!base) {
    process.stderr.write(
      `base-unavailable: cannot resolve base "${sanitizeText(options.base, 120)}" to a commit\n`,
    );
    process.exitCode = 2;
    return;
  }
  const report = analyzeRepository(cwd, base, head, options);
  const output =
    options.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report);
  process.stdout.write(output);
  if (options.failOn === "none") {
    process.exitCode = 0;
    return;
  }
  const highest = report.summary.highestRisk;
  process.exitCode =
    highest !== "none" && RISK_ORDER[highest] >= RISK_ORDER[options.failOn] ? 1 : 0;
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`dependency-review: ${sanitizeText(message)}\n`);
  process.exitCode = 2;
}
