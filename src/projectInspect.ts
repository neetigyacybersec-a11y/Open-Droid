// ISSUE-23: deterministic, read-only project inventory. Values come from
// Gradle files (settings, root and module build files, version catalog) and a
// bounded filesystem fallback for anything static parsing misses. The tool is
// read-only: it never executes a task, never resolves dependencies, and lists
// sensitive file names without ever reading or returning their values.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export type ModuleType =
  "android-application" | "android-library" | "android-dynamic-feature" | "other";

export type ProjectType =
  "android-application" | "android-library" | "android-dynamic-feature" | "non-android" | "unknown";

export interface ModuleSdk {
  compileSdk: string | null;
  minSdk: string | null;
  targetSdk: string | null;
  namespace: string | null;
  applicationId: string | null;
  versionCode: string | null;
  versionName: string | null;
  sourcePath: string;
  unknowns: { field: string; source: string; reason: string }[];
}

export interface ProjectModule {
  path: string;
  type: ModuleType;
  sdk: ModuleSdk;
  sourceSets: Record<string, string[]>;
  buildTypes: string[];
  productFlavors: string[];
  manifests: string[];
  dependencies: { count: number; items: string[] };
}

export interface ProjectInspectReport {
  status: "ok" | "error";
  projectPath: string;
  reason?: string;
  projectType: ProjectType;
  rootProjectName: string;
  modules: ProjectModule[];
  catalogPath: string | null;
  secrets: string[];
  errors: string[];
  unknowns: { field: string; source: string; reason: string }[];
}

export interface ProjectInspectInput {
  projectPath: string;
  maxDepth?: number;
  includeSourceSets?: boolean;
  includeBuildVariants?: boolean;
  includeDependencies?: boolean;
}

const DEFAULT_EXCLUDES = new Set([
  "build",
  "node_modules",
  ".git",
  ".gradle",
  "generated",
  "out",
  "dist",
  "obj",
  "bin",
  "target",
  ".idea",
  ".vscode",
  ".opencode",
  ".toolchain",
  "coverage",
]);
const DEFAULT_MAX_DEPTH = 8;
const MAX_DEPTH_CEILING = 64;
const SENSITIVE_FILE_RE =
  /^(\.env.*|local\.properties|.*\.(key|pem|p12|pfx|jks|keystore)$|signing\..*|credentials\..*)$/i;
const SET_NAMES = ["main", "test", "androidTest", "debug", "release", "staging", "benchmark"];
const ANDROID_PLUGIN_RE = /id\("(com\.android\.[a-z-]+)"\)/;
const ANDROID_PLUGIN_GROOVY_RE = /apply\s+plugin:\s*["'](com\.android\.[a-z-]+)["']/;
const DEP_LINE_RE =
  /^\s*(?:api|implementation|compileOnly|testImplementation|debugImplementation|releaseImplementation|annotationProcessor|kapt|ksp)\b/;
const DEP_GAV_RE = /["']([\w.-]+:[\w.-]+:[\w.-]+)["']/;

function readProjectFile(projectPath: string, relPath: string): string | null {
  try {
    return readFileSync(join(projectPath, relPath), "utf8");
  } catch {
    return null;
  }
}

function blockRange(text: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return text.slice(openIndex + 1);
}

/** Inner text of the first block whose opening line matches `pattern`. */
function blockContents(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  if (!match) return null;
  return blockRange(text, text.indexOf("{", match.index ?? 0));
}

function identifiersInBlock(block: string): string[] {
  const found: string[] = [];
  for (const match of block.matchAll(/^[ \t]*([a-z][A-Za-z0-9_]*)\s*\{/gm))
    if (!found.includes(match[1])) found.push(match[1]);
  return found;
}

function quotedAfter(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  if (!match) return null;
  const rest = text.slice((match.index ?? 0) + match[0].length);
  return /["']([^"']+)["']/.exec(rest)?.[1] ?? null;
}

function sdkNumber(text: string, base: string): string | null {
  return (
    text.match(new RegExp(`\\b${base}(?:Version)?\\s*(?:=|:)?\\s*\\(?\\s*(\\d+)`))?.[1] ?? null
  );
}

function flavorNames(text: string): string[] {
  return [
    ...new Set(identifiersInBlock(blockContents(text, /\bproductFlavors\s*\{/) ?? "")),
  ].sort();
}

function buildTypeNames(text: string): string[] {
  const inner = blockContents(text, /\bbuildTypes\s*\{/) ?? "";
  const names = new Set(identifiersInBlock(inner));
  for (const match of text.matchAll(/\b(?:type|create)\s*\(\s*["']([a-z][A-Za-z0-9_]*)["']\s*\)/g))
    names.add(match[1]);
  return [...names].sort();
}

function customSourceSets(text: string): string[] {
  return identifiersInBlock(blockContents(text, /\bsourceSets\s*\{/) ?? "");
}

function detectSourceSets(
  projectPath: string,
  modulePath: string,
  moduleText: string,
  files: readonly string[],
): Record<string, string[]> {
  const names = new Set([...SET_NAMES, ...customSourceSets(moduleText)]);
  const sourceSets: Record<string, string[]> = {};
  const marker = modulePath === "." ? "" : `${modulePath}/`;
  const moduleDir = join(projectPath, marker === "" ? "." : modulePath);
  for (const name of [...names].sort()) {
    const dirs = new Set<string>();
    for (const sub of ["java", "kotlin"]) {
      if (existsSync(join(moduleDir, "src", name, sub))) dirs.add(`${marker}src/${name}/${sub}`);
    }
    for (const file of files) {
      const remainder = file.startsWith(marker) ? file.slice(marker.length) : null;
      if (!remainder) continue;
      const match = remainder.match(/^(src\/[a-z][A-Za-z0-9_-]*\/(?:java|kotlin))\//);
      if (match) dirs.add(`${marker}${match[1]}`);
    }
    if (dirs.size > 0) sourceSets[name] = [...dirs].sort();
  }
  return sourceSets;
}

function detectDependencies(moduleText: string): ProjectModule["dependencies"] {
  const lines = moduleText.split(/\r?\n/).filter((line) => DEP_LINE_RE.test(line));
  const items: string[] = [];
  for (const line of lines) {
    const gav = DEP_GAV_RE.exec(line);
    if (gav && !items.includes(gav[1])) items.push(gav[1]);
  }
  return { count: lines.length, items: items.slice(0, 5) };
}

function readModuleText(projectPath: string, modulePath: string): string {
  const sourcePath = modulePath === "." ? "build.gradle.kts" : `${modulePath}/build.gradle.kts`;
  const groovyPath = modulePath === "." ? "build.gradle" : `${modulePath}/build.gradle`;
  return readProjectFile(projectPath, sourcePath) ?? readProjectFile(projectPath, groovyPath) ?? "";
}

function moduleType(moduleText: string): ModuleType {
  const plugin =
    ANDROID_PLUGIN_RE.exec(moduleText)?.[1] ?? ANDROID_PLUGIN_GROOVY_RE.exec(moduleText)?.[1];
  if (plugin === "com.android.application") return "android-application";
  if (plugin === "com.android.library") return "android-library";
  if (plugin === "com.android.dynamic-feature") return "android-dynamic-feature";
  return "other";
}

function sdkUnknowns(sdk: ModuleSdk, sourcePath: string): ModuleSdk["unknowns"] {
  const unknowns: ModuleSdk["unknowns"] = [];
  for (const field of ["compileSdk", "minSdk", "targetSdk"] as const)
    if (sdk[field] === null)
      unknowns.push({
        field,
        source: sourcePath,
        reason: "no statically parseable SDK value in module build file",
      });
  return unknowns;
}

function moduleManifests(files: readonly string[], modulePath: string): string[] {
  const prefix = modulePath === "." ? "" : `${modulePath}/`;
  return files.filter((f) => f.endsWith("AndroidManifest.xml") && f.startsWith(prefix)).sort();
}

function buildModule(
  projectPath: string,
  modulePath: string,
  files: readonly string[],
  input: ProjectInspectInput,
): ProjectModule {
  const moduleText = readModuleText(projectPath, modulePath);
  const sourcePath = modulePath === "." ? "build.gradle.kts" : `${modulePath}/build.gradle.kts`;
  const sdk: ModuleSdk = {
    compileSdk: sdkNumber(moduleText, "compileSdk"),
    minSdk: sdkNumber(moduleText, "minSdk"),
    targetSdk: sdkNumber(moduleText, "targetSdk"),
    namespace: quotedAfter(moduleText, /\bnamespace\b/),
    applicationId: quotedAfter(moduleText, /\bapplicationId\b/),
    versionCode: sdkNumber(moduleText, "versionCode"),
    versionName: quotedAfter(moduleText, /\bversionName\b/),
    sourcePath,
    unknowns: [],
  };
  sdk.unknowns.push(...sdkUnknowns(sdk, sourcePath));
  const type = moduleType(moduleText);
  return {
    path: modulePath,
    type,
    sdk,
    sourceSets:
      input.includeSourceSets === false
        ? {}
        : detectSourceSets(projectPath, modulePath, moduleText, files),
    buildTypes: input.includeBuildVariants === false ? [] : buildTypeNames(moduleText),
    productFlavors: flavorNames(moduleText),
    manifests: moduleManifests(files, modulePath),
    dependencies:
      input.includeDependencies === false
        ? { count: 0, items: [] }
        : detectDependencies(moduleText),
  };
}

function readSettingsFile(projectPath: string): { file: string; text: string | null } {
  const file = ["settings.gradle", "settings.gradle.kts"].find((name) =>
    existsSync(join(projectPath, name)),
  );
  return { file: file ?? "", text: file ? readProjectFile(projectPath, file) : null };
}

function readGitignoreBasenames(projectPath: string): string[] {
  return (
    readProjectFile(projectPath, ".gitignore")
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.replace(/^!/, "").replace(/\/+$/, "").split("/").pop() ?? line) ?? []
  );
}

function walkProjectFiles(
  projectPath: string,
  depth: number,
  gitignore: readonly string[],
): string[] {
  const files: string[] = [];
  const walk = (dir: string, relPath: string, d: number): void => {
    if (d > depth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = relPath ? `${relPath}/${entry.name}` : entry.name;
      if (
        entry.isDirectory() &&
        (DEFAULT_EXCLUDES.has(entry.name) || gitignore.includes(entry.name))
      )
        continue;
      if (entry.isDirectory()) walk(join(dir, entry.name), child, d + 1);
      else if (entry.isFile()) files.push(child);
    }
  };
  walk(projectPath, "", 0);
  files.sort();
  return files;
}

function modulePathsFromSettings(settingsText: string | null): string[] {
  if (!settingsText) return [];
  const includes = [...settingsText.matchAll(/include\s*\(([^)]*)\)/g)].flatMap((match) =>
    [...match[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1].replace(/^:/, "")),
  );
  return [...new Set(includes)].sort();
}

function rootProjectErrors(
  settingsFile: string,
  settingsText: string | null,
  files: readonly string[],
): string[] {
  const errors: string[] = [];
  if (settingsText === null && !files.some((f) => f === "build.gradle" || f === "build.gradle.kts"))
    errors.push("no settings.gradle(.kts) or root build file found");
  if (settingsText && quotedAfter(settingsText, /\brootProject\.name\b/) === null)
    errors.push(`${settingsFile}: no parseable rootProject.name`);
  return errors;
}

function aggregateProjectType(modules: readonly ProjectModule[]): ProjectType {
  if (modules.some((m) => m.type === "android-application")) return "android-application";
  if (modules.some((m) => m.type === "android-library")) return "android-library";
  if (modules.some((m) => m.type === "android-dynamic-feature")) return "android-dynamic-feature";
  return modules.length > 0 ? "non-android" : "unknown";
}

export function inspectProject(input: ProjectInspectInput): ProjectInspectReport {
  const projectPath = input.projectPath;
  if (!existsSync(projectPath))
    return {
      status: "error",
      projectPath,
      reason: "project path does not exist",
      projectType: "unknown",
      rootProjectName: basename(projectPath),
      modules: [],
      catalogPath: null,
      secrets: [],
      errors: [],
      unknowns: [],
    };

  const depth = Math.min(
    Math.max(Math.floor(input.maxDepth ?? DEFAULT_MAX_DEPTH), 1),
    MAX_DEPTH_CEILING,
  );
  const { file: settingsFile, text: settingsText } = readSettingsFile(projectPath);
  const gitignore = readGitignoreBasenames(projectPath);
  const files = walkProjectFiles(projectPath, depth, gitignore);
  const secrets = [
    ...new Set(files.filter((f) => SENSITIVE_FILE_RE.test(f.split("/").pop() ?? f))),
  ].sort();
  const catalogFile = files.find((f) => f.endsWith("libs.versions.toml"));
  const catalogPath = catalogFile ? join(projectPath, catalogFile) : null;

  const errors = rootProjectErrors(settingsFile, settingsText, files);
  const rootName = settingsText
    ? (quotedAfter(settingsText, /\brootProject\.name\b/) ?? basename(projectPath))
    : basename(projectPath);
  const modules = modulePathsFromSettings(settingsText).map((modulePath) =>
    buildModule(projectPath, modulePath, files, input),
  );
  const unknowns: ProjectInspectReport["unknowns"] = [];
  for (const module of modules)
    for (const entry of module.sdk.unknowns)
      if (!unknowns.some((u) => u.field === entry.field && u.source === entry.source))
        unknowns.push(entry);
  unknowns.sort((a, b) => `${a.field}|${a.source}`.localeCompare(`${b.field}|${b.source}`));
  return {
    status: "ok",
    projectPath,
    projectType: aggregateProjectType(modules),
    rootProjectName: rootName,
    modules,
    catalogPath,
    secrets,
    errors: [...new Set(errors)].sort(),
    unknowns,
  };
}
