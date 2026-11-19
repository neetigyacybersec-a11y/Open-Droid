import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

export interface PrivacyScanOptions {
  declarationsPath?: string;
  /** Test/diagnostic override; production defaults stay at MAX_FILES. */
  maxFiles?: number;
  /** Test/diagnostic override; production defaults stay at MAX_FILE_BYTES. */
  maxFileBytes?: number;
}

/**
 * ISSUE-88: every inventory item records where it came from. A direct build
 * declaration is not the same evidence as a resolved graph or a merged
 * manifest, so the report must not flatten them into one list.
 */
export type PrivacyEvidenceSource =
  | "source-code"
  | "resource-value"
  | "build-config"
  | "manifest-source"
  | "manifest-merged"
  | "network-config"
  | "dependency-declaration"
  | "dependency-resolved"
  | "heuristic";

export interface PermissionFinding {
  permission: string;
  file: string;
  source: PrivacyEvidenceSource;
}

export interface SdkFinding {
  artifact: string;
  id: string;
  dataTypes: string[];
  file: string;
  source: PrivacyEvidenceSource;
}

export interface EndpointFinding {
  host: string;
  file: string;
  source: PrivacyEvidenceSource;
}

export interface DataStoreFinding {
  kind: string;
  file: string;
  source: PrivacyEvidenceSource;
}

export interface CodeMatch {
  file: string;
  line: number;
  snippet: string;
  source: PrivacyEvidenceSource;
}

export interface PiiLogFinding extends CodeMatch {
  identifiers: string[];
}

export interface PrivacyCoverage {
  filesByCategory: Record<string, number>;
  filesSkipped: number;
  oversizedFiles: number;
  limitReached: boolean;
  mergedManifest: "inspected" | "not-found" | "limited";
  dependencyResolution: "not-run";
  transitiveDependencies: "not-assessed";
  unsupportedSources: string[];
}

export interface PrivacyFinding {
  severity: "blocker" | "review";
  rule: string;
  message: string;
  evidence: string | null;
}

export interface PrivacyDeclarations {
  permissions?: string[];
  sdks?: string[];
  endpoints?: string[];
  accountCreation?: boolean;
  accountDeletion?: boolean;
}

export interface DeclarationCheck {
  path: string;
  declared: PrivacyDeclarations;
  missingFields: string[];
  undeclaredPermissions: string[];
  stalePermissions: string[];
  undeclaredSdks: string[];
  staleSdks: string[];
  undeclaredEndpoints: string[];
  staleEndpoints: string[];
  accountCreationObserved: boolean;
  accountDeletionObserved: boolean;
  accountCreationUndeclared: boolean;
  accountCreationStale: boolean;
  accountDeletionUndeclared: boolean;
  accountDeletionStale: boolean;
  accountDeletionGap: boolean;
  ok: boolean;
}

export interface PrivacyScanResult {
  root: string;
  projectName: string;
  filesScanned: number;
  filesSkipped: number;
  limitReached: boolean;
  permissions: string[];
  permissionEvidence: PermissionFinding[];
  sdks: SdkFinding[];
  endpoints: EndpointFinding[];
  dataStores: DataStoreFinding[];
  accountCreation: CodeMatch[];
  accountDeletion: CodeMatch[];
  piiLogs: PiiLogFinding[];
  coverage: PrivacyCoverage;
  declarationsPath: string;
  declarations: PrivacyDeclarations | null;
  declarationsError: string | null;
  declarationsRequired: boolean;
  declarationsCheck: DeclarationCheck | null;
  candidateDataTypes: string[];
  findings: PrivacyFinding[];
  limitations: string[];
}

const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_MATCHES = 20;
const MAX_PII_LOGS = 50;
const MAX_CALL_CHARS = 8_000;

const SKIP_DIRS = new Set([
  ".git",
  ".gradle",
  ".idea",
  ".kotlin",
  ".toolchain",
  "build",
  "dist",
  "generated",
  "intermediates",
  "node_modules",
  "out",
  "target",
]);

const BUILD_FILE_NAMES = new Set([
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "libs.versions.toml",
]);

const PII_IDENTIFIERS = new Set(
  [
    "email",
    "emailaddress",
    "useremail",
    "e-mail",
    "mail",
    "phone",
    "phonenumber",
    "userphone",
    "mobile",
    "msisdn",
    "token",
    "authtoken",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "devicetoken",
    "fcmtoken",
    "pushtoken",
    "authorization",
    "authorizationheader",
    "authheader",
    "cookie",
    "cookies",
    "headers",
    "password",
    "passwd",
    "pwd",
    "secret",
    "apikey",
    "api_key",
    "ssn",
    "socialsecurity",
    "creditcard",
    "cardnumber",
    "cvv",
    "address",
    "latitude",
    "longitude",
    "lat",
    "lng",
    "imei",
    "androidid",
    "advertisingid",
    "deviceid",
    "userid",
    "accountid",
    "customerid",
    "sessionid",
    "sessiontoken",
    "username",
    "user",
  ].map((value) => value.toLowerCase()),
);

const SDK_CATALOG: Array<{ artifact: string; id: string; dataTypes: string[] }> = [
  {
    artifact: "com.google.firebase:firebase-analytics",
    id: "firebase-analytics",
    dataTypes: ["app activity", "device identifiers"],
  },
  {
    artifact: "com.google.firebase:firebase-crashlytics",
    id: "firebase-crashlytics",
    dataTypes: ["crash logs", "device identifiers"],
  },
  {
    artifact: "com.google.firebase:firebase-messaging",
    id: "firebase-messaging",
    dataTypes: ["device identifiers (push token)"],
  },
  {
    artifact: "com.google.firebase:firebase-auth",
    id: "firebase-auth",
    dataTypes: ["account identifiers"],
  },
  {
    artifact: "com.google.firebase:firebase-firestore",
    id: "firebase-firestore",
    dataTypes: ["app data", "account identifiers"],
  },
  {
    artifact: "com.google.firebase:firebase-database",
    id: "firebase-database",
    dataTypes: ["app data"],
  },
  {
    artifact: "com.google.firebase:firebase-storage",
    id: "firebase-storage",
    dataTypes: ["user content"],
  },
  {
    artifact: "com.google.android.gms:play-services-ads",
    id: "play-services-ads",
    dataTypes: ["advertising ID", "app activity", "device identifiers"],
  },
  {
    artifact: "com.google.android.gms:play-services-location",
    id: "play-services-location",
    dataTypes: ["location"],
  },
  {
    artifact: "com.google.android.gms:play-services-auth",
    id: "play-services-auth",
    dataTypes: ["account identifiers"],
  },
  {
    artifact: "com.facebook.android:facebook-android-sdk",
    id: "facebook-sdk",
    dataTypes: ["account identifiers", "app activity"],
  },
  {
    artifact: "com.amplitude:android-sdk",
    id: "amplitude",
    dataTypes: ["app activity", "device identifiers"],
  },
  {
    artifact: "com.mixpanel.android:mixpanel-android",
    id: "mixpanel",
    dataTypes: ["app activity", "device identifiers"],
  },
  {
    artifact: "io.sentry:sentry-android",
    id: "sentry",
    dataTypes: ["crash logs", "device identifiers"],
  },
  {
    artifact: "com.onesignal:OneSignal",
    id: "onesignal",
    dataTypes: ["device identifiers (push token)"],
  },
  {
    artifact: "com.adjust.sdk:adjust-android",
    id: "adjust",
    dataTypes: ["device identifiers", "attribution"],
  },
  {
    artifact: "com.appsflyer:af-android-sdk",
    id: "appsflyer",
    dataTypes: ["device identifiers", "attribution"],
  },
  {
    artifact: "io.branch.sdk.android:library",
    id: "branch",
    dataTypes: ["device identifiers", "attribution"],
  },
  {
    artifact: "com.squareup.okhttp3:logging-interceptor",
    id: "okhttp-logging",
    dataTypes: ["network request/response data (if enabled)"],
  },
];

const DATA_STORE_MARKERS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "Room database", pattern: /\bRoomDatabase\b|@Entity\b/ },
  { kind: "SharedPreferences", pattern: /\bSharedPreferences\b/ },
  { kind: "DataStore", pattern: /\bDataStore\b/ },
  { kind: "SQLite", pattern: /\bSQLiteOpenHelper\b/ },
  { kind: "Realm", pattern: /\bRealm\b/ },
  { kind: "MMKV", pattern: /\bMMKV\b/ },
  { kind: "Encrypted storage", pattern: /\bEncryptedSharedPreferences\b|\bMasterKey\b/ },
];

const ACCOUNT_CREATION =
  /\b(?:createUserWithEmailAndPassword|signUpWithEmail|createAccount|createUser|registerUser|registerAccount|signUp|signup|sign_up|newUser)\b/;
const ACCOUNT_DELETION =
  /\b(?:deleteAccount|deleteUser|deleteProfile|deleteAccountData|delete_account|delete-account|account\/delete|removeAccount|removeUser)\b|\b(?:user|account|profile)\.delete\s*\(\s*\)/;

const LOG_CALL =
  /\b(?:Log\.(?:d|i|w|e|v|wtf|println)|Timber\.(?:d|i|w|e|v)|logger\.(?:trace|debug|info|warn|error)|Logger\.(?:trace|debug|info|warn|error)|System\.(?:out|err)\.print(?:ln)?|println|print)\s*\(/g;

const URL_HOST = /\bhttps?:\/\/([^\s"'<>)\]]+)/g;

const IGNORED_HOSTS = new Set([
  "developer.android.com",
  "github.com",
  "google.com",
  "json-schema.org",
  "kotlinlang.org",
  "schemas.android.com",
  "w3.org",
  "www.google.com",
  "www.w3.org",
  "xmlns.com",
]);

const UNSUPPORTED_SOURCES = Object.freeze([
  "Resolved Gradle dependency graph (only literal build-file declarations are read)",
  "Transitive dependencies and manifest entries they merge in",
  "Compiled bytecode, DEX files and native libraries",
  "Generated code and build outputs other than an existing merged manifest",
  "Remote configuration, feature flags and backend payloads",
  "Runtime collection and sharing behaviour",
]);

const PERMISSION_DATA_TYPES: Record<string, string[]> = {
  ACCESS_BACKGROUND_LOCATION: ["background location"],
  ACCESS_COARSE_LOCATION: ["approximate location"],
  ACCESS_FINE_LOCATION: ["precise location"],
  BLUETOOTH_CONNECT: ["connected devices"],
  BODY_SENSORS: ["health/fitness"],
  CAMERA: ["photos", "videos"],
  GET_ACCOUNTS: ["account identifiers"],
  READ_CALENDAR: ["calendar"],
  READ_CALL_LOG: ["call logs"],
  READ_CONTACTS: ["contacts"],
  READ_EXTERNAL_STORAGE: ["files/media"],
  READ_MEDIA_AUDIO: ["audio"],
  READ_MEDIA_IMAGES: ["photos"],
  READ_MEDIA_VIDEO: ["videos"],
  READ_PHONE_NUMBERS: ["phone number"],
  READ_PHONE_STATE: ["device identifiers", "phone number"],
  READ_SMS: ["SMS/messages"],
  RECORD_AUDIO: ["audio"],
  SEND_SMS: ["SMS/messages"],
  WRITE_CALENDAR: ["calendar"],
  WRITE_CONTACTS: ["contacts"],
};

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function shortPermission(value: string): string {
  return value.replace(/^.*?\.permission\./, "");
}

function normalizeHost(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (
    !value ||
    value.includes("$") ||
    value.includes("{") ||
    value.includes("<") ||
    value.includes(">")
  ) {
    return null;
  }
  value = value.replace(/^https?:\/\//, "");
  value = value.split("/")[0].split("?")[0].split("#")[0];
  value = value.replace(/^[^@]*@/, "");
  value = value.split(":")[0].replace(/\.$/, "");
  if (!value || IGNORED_HOSTS.has(value)) return null;
  return value;
}

function readArray(value: unknown, key: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function readBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

export function parsePrivacyDeclarations(raw: unknown): PrivacyDeclarations {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("declarations must be a JSON object");
  }
  const object = raw as Record<string, unknown>;
  const permissions = readArray(object.permissions, "permissions");
  const sdks = readArray(object.sdks, "sdks");
  const endpoints = readArray(object.endpoints, "endpoints");
  return {
    permissions: permissions?.map(shortPermission),
    sdks: sdks?.map((value) => value.toLowerCase()),
    endpoints: endpoints
      ?.map((value) => normalizeHost(value))
      .filter((value): value is string => value !== null),
    accountCreation: readBoolean(object.accountCreation, "accountCreation"),
    accountDeletion: readBoolean(object.accountDeletion, "accountDeletion"),
  };
}

function isResourceValueFile(relativePath: string): boolean {
  return /(^|\/)res\/values[^/]*\/[^/]+\.xml$/.test(relativePath);
}

function fileCategory(relativePath: string): string | null {
  const name = basename(relativePath);
  if (name === "AndroidManifest.xml") return "manifest";
  if (name.includes("network_security_config") && name.endsWith(".xml")) {
    return "network-security";
  }
  if (isResourceValueFile(relativePath)) return "resource-xml";
  if (BUILD_FILE_NAMES.has(name)) return "build-config";
  if (/\.(kt|java)$/.test(name)) return "source-code";
  return null;
}

function isRelevantFile(relativePath: string): boolean {
  return fileCategory(relativePath) !== null;
}

async function collectFiles(
  root: string,
  maxFiles: number,
): Promise<{ files: string[]; skipped: number; limitReached: boolean }> {
  const files: string[] = [];
  let skipped = 0;
  let limitReached = false;

  async function walk(dir: string): Promise<void> {
    if (limitReached) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      skipped++;
      return;
    }
    for (const entry of entries) {
      if (limitReached) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path);
        continue;
      }
      if (!entry.isFile() || !isRelevantFile(toPosix(relative(root, path)))) continue;
      if (files.length >= maxFiles) {
        limitReached = true;
        return;
      }
      files.push(path);
    }
  }

  await walk(root);
  return { files, skipped, limitReached };
}

function xmlWithoutComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, "");
}

export function extractManifestPermissions(content: string): string[] {
  const xml = xmlWithoutComments(content);
  const permissions: string[] = [];
  for (const match of xml.matchAll(
    /<uses-permission(?:-sdk-23)?\b[^>]*\bandroid:name\s*=\s*"([^"]+)"/g,
  )) {
    permissions.push(shortPermission(match[1]));
  }
  return permissions;
}

export function extractNetworkConfigEndpoints(content: string): string[] {
  const hosts: string[] = [];
  const xml = xmlWithoutComments(content);
  for (const match of xml.matchAll(/<domain[^>]*>([^<]+)<\/domain>/g)) {
    const host = normalizeHost(match[1]);
    if (host) hosts.push(host);
  }
  return hosts;
}

export function extractResourceEndpoints(content: string): string[] {
  const xml = xmlWithoutComments(content);
  const hosts: string[] = [];
  for (const match of xml.matchAll(/<(string|item)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const text = match[2].replace(/<[^>]+>/g, " ").replaceAll("&amp;", "&");
    for (const url of text.matchAll(URL_HOST)) {
      const host = normalizeHost(url[1]);
      if (host) hosts.push(host);
    }
  }
  return hosts;
}

export function extractBuildConfigEndpoints(content: string): string[] {
  const hosts: string[] = [];
  for (const line of content.split("\n")) {
    if (isCommentLine(line) || line.trimStart().startsWith("#")) continue;
    if (!/\b(buildConfigField|resValue|manifestPlaceholders?)\b/.test(line)) continue;
    for (const match of line.matchAll(URL_HOST)) {
      const host = normalizeHost(match[1]);
      if (host) hosts.push(host);
    }
  }
  return hosts;
}

function extractManifestEndpoints(content: string): string[] {
  const hosts: string[] = [];
  for (const match of xmlWithoutComments(content).matchAll(URL_HOST)) {
    const host = normalizeHost(match[1]);
    if (host) hosts.push(host);
  }
  return hosts;
}

const MAX_MERGED_MANIFESTS = 20;

/**
 * Inspect only merged manifests that already exist on disk. This never runs
 * Gradle or downloads anything, so a cold/offline project simply reports that
 * merged coverage was not available.
 */
async function findMergedManifests(root: string): Promise<{ files: string[]; limited: boolean }> {
  const files: string[] = [];
  let limited = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (limited || depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (limited) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || entry.name !== "AndroidManifest.xml") continue;
      if (files.length >= MAX_MERGED_MANIFESTS) {
        limited = true;
        return;
      }
      files.push(path);
    }
  }

  async function inspectModule(moduleDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(join(moduleDir, "build", "intermediates"), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("merged_manifest")) continue;
      await walk(join(moduleDir, "build", "intermediates", entry.name), 0);
    }
  }

  async function inspectModules(dir: string, depth: number): Promise<void> {
    if (limited || depth > 3) return;
    await inspectModule(dir);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      await inspectModules(join(dir, entry.name), depth + 1);
    }
  }

  await inspectModules(root, 0);
  return { files, limited };
}

function lineNumber(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("<!--")
  );
}

function linePrefixIsCode(content: string, index: number): boolean {
  const start = content.lastIndexOf("\n", index - 1) + 1;
  const line = content.slice(start, index);
  const trimmed = line.trimStart();
  if (trimmed.startsWith("*") || trimmed.startsWith("/*")) return false;
  let quote: string | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const character = line[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "/" && line[i + 1] === "/") return false;
  }
  return quote === null;
}

function extractCallArguments(
  content: string,
  openIndex: number,
): { text: string; end: number } | null {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  const limit = Math.min(content.length, openIndex + MAX_CALL_CHARS);
  for (let i = openIndex; i < limit; i++) {
    const character = content[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") depth++;
    else if (character === ")") {
      depth--;
      if (depth === 0) return { text: content.slice(openIndex + 1, i), end: i };
    }
  }
  return null;
}

function extractTemplateParts(text: string): { expressions: string[]; remaining: string } {
  const expressions: string[] = [];
  let remaining = "";
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character !== "$") {
      remaining += character;
      continue;
    }
    if (text[i + 1] === "{") {
      let depth = 1;
      let quote: string | null = null;
      let escaped = false;
      let end = i + 2;
      for (; end < text.length; end++) {
        const current = text[end];
        if (quote) {
          if (escaped) escaped = false;
          else if (current === "\\") escaped = true;
          else if (current === quote) quote = null;
          continue;
        }
        if (current === '"' || current === "'") {
          quote = current;
          continue;
        }
        if (current === "{") depth++;
        else if (current === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      if (depth === 0) {
        expressions.push(text.slice(i + 2, end));
        remaining += " ";
        i = end;
        continue;
      }
      remaining += character;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i + 1));
    if (identifier) {
      expressions.push(identifier[0]);
      remaining += " ";
      i += identifier[0].length;
      continue;
    }
    remaining += character;
  }
  return { expressions, remaining };
}

export function piiIdentifiers(argumentsText: string): string[] {
  const identifiers = new Set<string>();
  const { expressions, remaining } = extractTemplateParts(argumentsText);
  for (const expression of expressions) {
    const cleaned = expression.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, " ");
    for (const identifier of cleaned.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
      identifiers.add(identifier);
  }
  const withoutStrings = remaining.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, " ");
  for (const identifier of withoutStrings.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
    identifiers.add(identifier);
  return [...identifiers]
    .filter((identifier) => PII_IDENTIFIERS.has(identifier.toLowerCase()))
    .sort();
}

function findPiiLogs(content: string, file: string, limitations: string[]): PiiLogFinding[] {
  const findings: PiiLogFinding[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(LOG_CALL)) {
    if (findings.length >= MAX_PII_LOGS) {
      limitations.push(`PII log scan stopped after ${MAX_PII_LOGS} findings in ${file}.`);
      break;
    }
    if (!linePrefixIsCode(content, match.index)) continue;
    const openIndex = match.index + match[0].length - 1;
    const call = extractCallArguments(content, openIndex);
    if (!call) continue;
    const identifiers = piiIdentifiers(call.text);
    if (identifiers.length === 0) continue;
    const line = lineNumber(content, match.index);
    const snippet = content
      .slice(match.index, call.end + 1)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    const key = `${line}:${snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ file, line, snippet, identifiers, source: "heuristic" });
  }
  return findings;
}

function findCodeMatches(
  content: string,
  file: string,
  pattern: RegExp,
  limitations: string[],
): CodeMatch[] {
  const matches: CodeMatch[] = [];
  const seen = new Set<string>();
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (isCommentLine(line)) continue;
    const match = pattern.exec(line);
    if (!match) continue;
    const key = `${index + 1}:${match[0]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({
      file,
      line: index + 1,
      snippet: line.trim().slice(0, 200),
      source: "heuristic",
    });
    if (matches.length >= MAX_MATCHES) {
      limitations.push(`${file}: stopped after ${MAX_MATCHES} account-flow matches.`);
      break;
    }
  }
  return matches;
}

function declarationCheck(
  result: Omit<
    PrivacyScanResult,
    "declarationsCheck" | "candidateDataTypes" | "findings" | "limitations"
  >,
  declared: PrivacyDeclarations,
  path: string,
): DeclarationCheck {
  const missingFields: string[] = [];
  if (declared.permissions === undefined) missingFields.push("permissions");
  if (declared.sdks === undefined) missingFields.push("sdks");
  if (declared.endpoints === undefined) missingFields.push("endpoints");
  if (declared.accountCreation === undefined) missingFields.push("accountCreation");
  if (declared.accountDeletion === undefined) missingFields.push("accountDeletion");

  const observedPermissions = new Set(result.permissions);
  const observedSdks = new Set(result.sdks.map((sdk) => sdk.artifact.toLowerCase()));
  const observedEndpoints = new Set(result.endpoints.map((endpoint) => endpoint.host));

  const declaredPermissions = declared.permissions ? new Set(declared.permissions) : null;
  const declaredSdks = declared.sdks ? new Set(declared.sdks) : null;
  const declaredEndpoints = declared.endpoints ? new Set(declared.endpoints) : null;

  const accountCreationObserved = result.accountCreation.length > 0;
  const accountDeletionObserved = result.accountDeletion.length > 0;
  const accountCreationUndeclared = declared.accountCreation === false && accountCreationObserved;
  const accountCreationStale = declared.accountCreation === true && !accountCreationObserved;
  const accountDeletionUndeclared = declared.accountDeletion === false && accountDeletionObserved;
  const accountDeletionStale = declared.accountDeletion === true && !accountDeletionObserved;
  const accountDeletionGap = accountCreationObserved && !accountDeletionObserved;

  const undeclaredPermissions = declaredPermissions
    ? [...observedPermissions].filter((value) => !declaredPermissions.has(value)).sort()
    : [];
  const stalePermissions = declaredPermissions
    ? [...declaredPermissions].filter((value) => !observedPermissions.has(value)).sort()
    : [];
  const undeclaredSdks = declaredSdks
    ? [...observedSdks].filter((value) => !declaredSdks.has(value)).sort()
    : [];
  const staleSdks = declaredSdks
    ? [...declaredSdks].filter((value) => !observedSdks.has(value)).sort()
    : [];
  const undeclaredEndpoints = declaredEndpoints
    ? [...observedEndpoints].filter((value) => !declaredEndpoints.has(value)).sort()
    : [];
  const staleEndpoints = declaredEndpoints
    ? [...declaredEndpoints].filter((value) => !observedEndpoints.has(value)).sort()
    : [];

  const ok =
    missingFields.length === 0 &&
    undeclaredPermissions.length === 0 &&
    stalePermissions.length === 0 &&
    undeclaredSdks.length === 0 &&
    staleSdks.length === 0 &&
    undeclaredEndpoints.length === 0 &&
    staleEndpoints.length === 0 &&
    !accountCreationUndeclared &&
    !accountCreationStale &&
    !accountDeletionUndeclared &&
    !accountDeletionStale &&
    !accountDeletionGap;

  return {
    path,
    declared,
    missingFields,
    undeclaredPermissions,
    stalePermissions,
    undeclaredSdks,
    staleSdks,
    undeclaredEndpoints,
    staleEndpoints,
    accountCreationObserved,
    accountDeletionObserved,
    accountCreationUndeclared,
    accountCreationStale,
    accountDeletionUndeclared,
    accountDeletionStale,
    accountDeletionGap,
    ok,
  };
}

function declarationFindings(check: DeclarationCheck): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  const add = (severity: PrivacyFinding["severity"], rule: string, message: string): void => {
    findings.push({ severity, rule, message, evidence: check.path });
  };

  if (check.missingFields.length > 0) {
    add(
      "review",
      "declarations-incomplete",
      `Declarations are missing fields: ${check.missingFields.join(", ")}`,
    );
  }
  if (check.undeclaredPermissions.length > 0) {
    add(
      "blocker",
      "permissions-undeclared",
      `Observed permissions are not declared: ${check.undeclaredPermissions.join(", ")}`,
    );
  }
  if (check.stalePermissions.length > 0) {
    add(
      "review",
      "permissions-stale",
      `Declared permissions were not observed (check manifest merging): ${check.stalePermissions.join(", ")}`,
    );
  }
  if (check.undeclaredSdks.length > 0) {
    add(
      "blocker",
      "sdks-undeclared",
      `Observed privacy-relevant SDKs are not declared: ${check.undeclaredSdks.join(", ")}`,
    );
  }
  if (check.staleSdks.length > 0) {
    add(
      "review",
      "sdks-stale",
      `Declared SDKs were not observed (check transitive dependencies): ${check.staleSdks.join(", ")}`,
    );
  }
  if (check.undeclaredEndpoints.length > 0) {
    add(
      "blocker",
      "endpoints-undeclared",
      `Observed endpoints are not declared: ${check.undeclaredEndpoints.join(", ")}`,
    );
  }
  if (check.staleEndpoints.length > 0) {
    add(
      "review",
      "endpoints-stale",
      `Declared endpoints were not observed (check backend-only flows): ${check.staleEndpoints.join(", ")}`,
    );
  }
  return findings;
}

function accountDeclarationFindings(check: DeclarationCheck): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  const add = (severity: PrivacyFinding["severity"], rule: string, message: string): void => {
    findings.push({ severity, rule, message, evidence: check.path });
  };
  if (check.accountCreationUndeclared) {
    add(
      "blocker",
      "account-creation-undeclared",
      "Account creation was observed but declarations say it is disabled.",
    );
  }
  if (check.accountCreationStale) {
    add(
      "review",
      "account-creation-stale",
      "Declarations say account creation is enabled, but no creation marker was observed.",
    );
  }
  if (check.accountDeletionUndeclared) {
    add(
      "blocker",
      "account-deletion-undeclared",
      "Account deletion was observed but declarations say it is disabled.",
    );
  }
  if (check.accountDeletionStale) {
    add(
      "review",
      "account-deletion-stale",
      "Declarations say account deletion is enabled, but no deletion marker was observed.",
    );
  }
  return findings;
}

function buildFindings(
  result: Omit<PrivacyScanResult, "findings" | "limitations">,
): PrivacyFinding[] {
  const findings: PrivacyFinding[] = result.piiLogs.map((log) => ({
    severity: "blocker",
    rule: "pii-log",
    message: `PII identifier(s) may be logged: ${log.identifiers.join(", ")}`,
    evidence: `${log.file}:${log.line}`,
  }));

  if (result.accountCreation.length > 0 && result.accountDeletion.length === 0) {
    findings.push({
      severity: "blocker",
      rule: "account-deletion-gap",
      message:
        "Account creation is present but no account deletion marker was found. Play requires an in-app deletion path when accounts can be created.",
      evidence: `${result.accountCreation[0].file}:${result.accountCreation[0].line}`,
    });
  }

  if (result.declarationsCheck) {
    findings.push(
      ...declarationFindings(result.declarationsCheck),
      ...accountDeclarationFindings(result.declarationsCheck),
    );
  } else if (result.declarationsError) {
    findings.push({
      severity: result.declarationsRequired ? "blocker" : "review",
      rule: "declarations-missing",
      message: result.declarationsRequired
        ? `Declarations could not be read: ${result.declarationsError}`
        : `No machine-readable declarations found: ${result.declarationsError}`,
      evidence: result.declarationsPath,
    });
  }

  if (result.limitReached || result.coverage.oversizedFiles > 0) {
    const parts: string[] = [];
    if (result.limitReached) parts.push("the file limit was reached");
    if (result.coverage.oversizedFiles > 0) {
      parts.push(`${result.coverage.oversizedFiles} file(s) exceeded the size limit`);
    }
    findings.push({
      severity: "review",
      rule: "scan-limit",
      message: `Scan coverage is limited because ${parts.join(" and ")}; results may be incomplete.`,
      evidence: result.root,
    });
  }

  return findings;
}

function candidateDataTypes(permissions: string[], sdks: SdkFinding[]): string[] {
  const types = new Set<string>();
  for (const permission of permissions) {
    for (const type of PERMISSION_DATA_TYPES[permission] ?? []) types.add(type);
  }
  for (const sdk of sdks) {
    for (const type of sdk.dataTypes) types.add(type);
  }
  return [...types].sort();
}

interface ScanState {
  filesByCategory: Record<string, number>;
  permissionEvidence: PermissionFinding[];
  permissionKeys: Set<string>;
  permissions: Set<string>;
  sdks: Map<string, SdkFinding>;
  endpoints: EndpointFinding[];
  endpointKeys: Set<string>;
  dataStores: Map<string, DataStoreFinding>;
  accountCreation: CodeMatch[];
  accountDeletion: CodeMatch[];
  piiLogs: PiiLogFinding[];
  limitations: string[];
  filesScanned: number;
  filesSkipped: number;
  oversizedFiles: number;
}

function createScanState(filesSkipped: number): ScanState {
  return {
    filesByCategory: {},
    permissionEvidence: [],
    permissionKeys: new Set<string>(),
    permissions: new Set<string>(),
    sdks: new Map<string, SdkFinding>(),
    endpoints: [],
    endpointKeys: new Set<string>(),
    dataStores: new Map<string, DataStoreFinding>(),
    accountCreation: [],
    accountDeletion: [],
    piiLogs: [],
    limitations: [],
    filesScanned: 0,
    filesSkipped,
    oversizedFiles: 0,
  };
}

function addPermission(
  state: ScanState,
  permission: string,
  file: string,
  source: PrivacyEvidenceSource,
): void {
  const normalized = shortPermission(permission);
  state.permissions.add(normalized);
  if (
    state.permissionEvidence.some(
      (entry) => entry.permission === normalized && entry.file === file && entry.source === source,
    )
  ) {
    return;
  }
  state.permissionEvidence.push({ permission: normalized, file, source });
}

function addEndpoint(
  state: ScanState,
  host: string,
  file: string,
  source: PrivacyEvidenceSource,
): void {
  if (
    state.endpoints.some(
      (entry) => entry.host === host && entry.file === file && entry.source === source,
    )
  ) {
    return;
  }
  state.endpoints.push({ host, file, source });
}

type FileOutcome =
  { kind: "content"; content: string } | { kind: "oversized" } | { kind: "skipped" };

async function readFileWithinLimit(file: string, maxFileBytes: number): Promise<FileOutcome> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return { kind: "skipped" };
  }
  if (size > maxFileBytes) return { kind: "oversized" };
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch {
    return { kind: "skipped" };
  }
  if (Buffer.byteLength(content, "utf8") > maxFileBytes) return { kind: "oversized" };
  return { kind: "content", content };
}

const SDK_COORDINATE = /["']([A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+)(?::[^"'\s]+)?["']/g;

function addDeclaredSdks(state: ScanState, content: string, filePath: string): void {
  for (const line of content.split("\n")) {
    if (isCommentLine(line) || line.trimStart().startsWith("#")) continue;
    for (const match of line.matchAll(SDK_COORDINATE)) {
      const lower = match[1].toLowerCase();
      for (const entry of SDK_CATALOG) {
        const key = entry.artifact.toLowerCase();
        if (!lower.includes(key) || state.sdks.has(key)) continue;
        state.sdks.set(key, {
          artifact: entry.artifact,
          id: entry.id,
          dataTypes: entry.dataTypes,
          file: filePath,
          source: "dependency-declaration",
        });
      }
    }
  }
}

function scanSourceContent(state: ScanState, content: string, filePath: string): void {
  for (const line of content.split("\n")) {
    if (isCommentLine(line)) continue;
    for (const match of line.matchAll(URL_HOST)) {
      const host = normalizeHost(match[1]);
      if (host) addEndpoint(state, host, filePath, "source-code");
    }
    for (const marker of DATA_STORE_MARKERS) {
      if (!marker.pattern.test(line) || state.dataStores.has(marker.kind)) continue;
      state.dataStores.set(marker.kind, {
        kind: marker.kind,
        file: filePath,
        source: "source-code",
      });
    }
  }
  state.accountCreation.push(
    ...findCodeMatches(content, filePath, ACCOUNT_CREATION, state.limitations),
  );
  state.accountDeletion.push(
    ...findCodeMatches(content, filePath, ACCOUNT_DELETION, state.limitations),
  );
  state.piiLogs.push(...findPiiLogs(content, filePath, state.limitations));
}

function scanFileContent(
  state: ScanState,
  content: string,
  filePath: string,
  category: string,
): void {
  switch (category) {
    case "manifest":
      for (const permission of extractManifestPermissions(content)) {
        addPermission(state, permission, filePath, "manifest-source");
      }
      for (const host of extractManifestEndpoints(content)) {
        addEndpoint(state, host, filePath, "manifest-source");
      }
      return;
    case "build-config":
      for (const host of extractBuildConfigEndpoints(content)) {
        addEndpoint(state, host, filePath, "build-config");
      }
      addDeclaredSdks(state, content, filePath);
      return;
    case "network-security":
      for (const host of extractNetworkConfigEndpoints(content)) {
        addEndpoint(state, host, filePath, "network-config");
      }
      return;
    case "resource-xml":
      for (const host of extractResourceEndpoints(content)) {
        addEndpoint(state, host, filePath, "resource-value");
      }
      return;
    case "source-code":
      scanSourceContent(state, content, filePath);
      return;
    default:
      return;
  }
}

async function scanMergedManifestFiles(
  root: string,
  maxFileBytes: number,
  state: ScanState,
): Promise<PrivacyCoverage["mergedManifest"]> {
  const merged = await findMergedManifests(root);
  if (merged.files.length > 0) state.filesByCategory["manifest-merged"] = merged.files.length;
  for (const file of merged.files) {
    const filePath = toPosix(relative(root, file));
    const outcome = await readFileWithinLimit(file, maxFileBytes);
    if (outcome.kind !== "content") {
      state.filesSkipped++;
      if (outcome.kind === "oversized") state.oversizedFiles++;
      continue;
    }
    for (const permission of extractManifestPermissions(outcome.content)) {
      addPermission(state, permission, filePath, "manifest-merged");
    }
    for (const host of extractManifestEndpoints(outcome.content)) {
      addEndpoint(state, host, filePath, "manifest-merged");
    }
  }
  if (merged.limited) {
    state.limitations.push(
      `Only the first ${MAX_MERGED_MANIFESTS} existing merged manifest(s) were inspected.`,
    );
    return "limited";
  }
  return merged.files.length > 0 ? "inspected" : "not-found";
}

const BASE_LIMITATIONS = Object.freeze([
  "Backend request and response payloads are not inspected; review API models and backend data flows for every observed endpoint.",
  "Static scanning cannot prove runtime collection or sharing; use net_capture, adb_logcat and SDK documentation to verify.",
  "Candidate data types are derived from permissions and SDKs only; they are not a completed Play Data safety declaration.",
  "Account deletion may live in a backend or web flow; this scan only finds source-code markers.",
  "Gradle dependency resolution was not run; SDK detection is based on literal build-file declarations, and transitive dependencies are not assessed.",
]);

function buildScanLimitations(
  state: ScanState,
  limitReached: boolean,
  maxFiles: number,
  maxFileBytes: number,
  mergedManifest: PrivacyCoverage["mergedManifest"],
): string[] {
  const limitations = [...state.limitations, ...BASE_LIMITATIONS];
  if (limitReached) {
    limitations.push(`File limit reached (${maxFiles}); results may be incomplete.`);
  }
  if (state.oversizedFiles > 0) {
    limitations.push(
      `${state.oversizedFiles} file(s) exceeded the ${maxFileBytes}-byte limit and were not parsed.`,
    );
  }
  if (state.filesSkipped > 0) {
    limitations.push(
      `${state.filesSkipped} unreadable or oversized file(s), or unreadable directories, were skipped.`,
    );
  }
  if (mergedManifest === "not-found") {
    limitations.push(
      "No existing merged manifest was found; permissions contributed by dependencies are not assessed.",
    );
  }
  return limitations;
}

function buildCoverage(
  state: ScanState,
  limitReached: boolean,
  mergedManifest: PrivacyCoverage["mergedManifest"],
): PrivacyCoverage {
  return {
    filesByCategory: state.filesByCategory,
    filesSkipped: state.filesSkipped,
    oversizedFiles: state.oversizedFiles,
    limitReached,
    mergedManifest,
    dependencyResolution: "not-run",
    transitiveDependencies: "not-assessed",
    unsupportedSources: [...UNSUPPORTED_SOURCES],
  };
}

export async function scanPrivacyProject(
  projectPath: string,
  options: PrivacyScanOptions = {},
): Promise<PrivacyScanResult> {
  const root = resolve(projectPath);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error(`not a directory: ${root}`);

  const maxFiles = options.maxFiles ?? MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const discovery = await collectFiles(root, MAX_FILES);
  const limitReached = discovery.limitReached || discovery.files.length > maxFiles;
  const state = createScanState(discovery.skipped);

  for (const file of discovery.files) {
    const filePath = toPosix(relative(root, file));
    const category = fileCategory(filePath);
    if (!category) continue;
    state.filesByCategory[category] = (state.filesByCategory[category] ?? 0) + 1;

    const outcome = await readFileWithinLimit(file, maxFileBytes);
    if (outcome.kind === "skipped") {
      state.filesSkipped++;
      continue;
    }
    if (outcome.kind === "oversized") {
      state.filesSkipped++;
      state.oversizedFiles++;
      continue;
    }
    if (state.filesScanned >= maxFiles) continue;
    state.filesScanned++;
    scanFileContent(state, outcome.content, filePath, category);
  }

  const mergedManifest = await scanMergedManifestFiles(root, maxFileBytes, state);
  const coverage = buildCoverage(state, limitReached, mergedManifest);
  const limitations = buildScanLimitations(
    state,
    limitReached,
    maxFiles,
    maxFileBytes,
    mergedManifest,
  );

  const sortedPermissions = [...state.permissions].sort();
  const sortedPermissionEvidence = state.permissionEvidence.sort(
    (left, right) =>
      left.permission.localeCompare(right.permission) ||
      left.source.localeCompare(right.source) ||
      left.file.localeCompare(right.file),
  );
  const sortedSdks = [...state.sdks.values()].sort((left, right) =>
    left.artifact.localeCompare(right.artifact),
  );
  const sortedEndpoints = state.endpoints.sort(
    (left, right) =>
      left.host.localeCompare(right.host) ||
      left.source.localeCompare(right.source) ||
      left.file.localeCompare(right.file),
  );
  const sortedDataStores = [...state.dataStores.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind),
  );
  const sortedCreation = state.accountCreation
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
    .slice(0, MAX_MATCHES);
  const sortedDeletion = state.accountDeletion
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
    .slice(0, MAX_MATCHES);
  const sortedPiiLogs = state.piiLogs
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
    .slice(0, MAX_PII_LOGS);

  const defaultDeclarationsPath = join(root, "privacy", "data-safety.json");
  const declarationsPath = options.declarationsPath
    ? resolve(root, options.declarationsPath)
    : defaultDeclarationsPath;
  const declarationsRequired = Boolean(options.declarationsPath);
  let declarations: PrivacyDeclarations | null = null;
  let declarationsError: string | null = null;
  try {
    declarations = parsePrivacyDeclarations(JSON.parse(await readFile(declarationsPath, "utf8")));
  } catch (error) {
    declarationsError = error instanceof Error ? error.message : String(error);
  }

  const baseResult: Omit<
    PrivacyScanResult,
    "declarationsCheck" | "candidateDataTypes" | "findings" | "limitations"
  > = {
    root,
    projectName: basename(root),
    filesScanned: state.filesScanned,
    filesSkipped: state.filesSkipped,
    limitReached,
    permissions: sortedPermissions,
    permissionEvidence: sortedPermissionEvidence,
    sdks: sortedSdks,
    endpoints: sortedEndpoints,
    dataStores: sortedDataStores,
    accountCreation: sortedCreation,
    accountDeletion: sortedDeletion,
    piiLogs: sortedPiiLogs,
    coverage,
    declarationsPath,
    declarations,
    declarationsError,
    declarationsRequired,
  };

  const declarationsCheck = declarations
    ? declarationCheck(baseResult, declarations, declarationsPath)
    : null;
  const result: PrivacyScanResult = {
    ...baseResult,
    declarationsCheck,
    candidateDataTypes: candidateDataTypes(sortedPermissions, sortedSdks),
    findings: [],
    limitations,
  };
  result.findings = buildFindings(result);
  return result;
}

function renderList(values: string[]): string {
  return values.length > 0
    ? values.map((value) => `\`${value.replaceAll("`", "'")}\``).join(", ")
    : "none";
}

function renderCode(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
}

function renderCoverage(result: PrivacyScanResult): string[] {
  const categories = Object.entries(result.coverage.filesByCategory)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, count]) => `${category}=${count}`)
    .join(", ");
  const lines = [
    "## Scan coverage",
    "",
    `- Files scanned: ${result.filesScanned}`,
    `- Files by category: ${categories}`,
    `- Oversized files: ${result.coverage.oversizedFiles}`,
    `- File limit reached: ${result.coverage.limitReached ? "yes" : "no"}`,
    `- Merged manifest: ${result.coverage.mergedManifest}`,
    `- Gradle dependency resolution: ${result.coverage.dependencyResolution.replaceAll("-", " ")}`,
    `- Transitive dependencies: ${result.coverage.transitiveDependencies.replaceAll("-", " ")}`,
    "",
    "Not inspected by this static scan:",
  ];
  for (const source of result.coverage.unsupportedSources) lines.push(`- ${source}`);
  lines.push(
    "",
    "This scan is an inventory and review aid. It is **not a compliance certificate**; absence of a signal only means that signal was not found in the inspected sources.",
    "",
  );
  return lines;
}

function renderPermissionsAndSdks(result: PrivacyScanResult): string[] {
  const lines = ["### Permissions", ""];
  if (result.permissions.length === 0) lines.push("No permissions observed.");
  else for (const permission of result.permissions) lines.push(`- ${renderCode(permission)}`);
  lines.push("", "### Privacy-relevant SDKs", "");
  if (result.sdks.length === 0) lines.push("No known privacy-relevant SDK artifacts observed.");
  else {
    for (const sdk of result.sdks) {
      lines.push(
        `- ${renderCode(sdk.artifact)} — ${sdk.id}; candidate data: ${sdk.dataTypes.join(", ")} — ${renderCode(sdk.file)} (${sdk.source})`,
      );
    }
  }
  lines.push("");
  return lines;
}

function renderEndpointSection(result: PrivacyScanResult): string[] {
  const lines = ["### Network endpoints", ""];
  if (result.endpoints.length === 0) {
    lines.push(
      "No network endpoints detected in inspected sources. This does not prove that none exist in resolved dependencies, generated code, remote configuration or backend flows.",
    );
  } else {
    for (const endpoint of result.endpoints) {
      lines.push(
        `- ${renderCode(endpoint.host)} — ${renderCode(endpoint.file)} (${endpoint.source})`,
      );
    }
    lines.push("", "Endpoints are observed; request and response payloads are not inspected.");
  }
  lines.push("");
  return lines;
}

function renderStorageSection(result: PrivacyScanResult): string[] {
  const lines = ["### On-device storage", ""];
  if (result.dataStores.length === 0) lines.push("No known on-device storage markers observed.");
  else {
    for (const store of result.dataStores) {
      lines.push(`- ${store.kind} — ${renderCode(store.file)}`);
    }
  }
  lines.push("");
  return lines;
}

function renderAccountFlows(result: PrivacyScanResult): string[] {
  const lines = ["### Account flows", ""];
  lines.push(`- Account creation markers: ${result.accountCreation.length}`);
  for (const match of result.accountCreation) {
    lines.push(`  - ${renderCode(`${match.file}:${match.line}`)} — ${renderCode(match.snippet)}`);
  }
  lines.push(`- Account deletion markers: ${result.accountDeletion.length}`);
  for (const match of result.accountDeletion) {
    lines.push(`  - ${renderCode(`${match.file}:${match.line}`)} — ${renderCode(match.snippet)}`);
  }
  if (result.accountCreation.length > 0 && result.accountDeletion.length === 0) {
    lines.push(
      "",
      "Account creation is present without a deletion marker. Play requires an in-app deletion path when account creation is enabled.",
    );
  }
  lines.push("");
  return lines;
}

function renderPiiSection(result: PrivacyScanResult): string[] {
  const lines = ["### PII in logs", ""];
  if (result.piiLogs.length === 0) lines.push("No PII identifiers found in log calls.");
  else {
    for (const log of result.piiLogs) {
      lines.push(
        `- ${renderCode(`${log.file}:${log.line}`)} — identifiers: ${log.identifiers.join(", ")} — ${renderCode(log.snippet)}`,
      );
    }
  }
  lines.push("");
  return lines;
}

function renderCandidateDataTypes(result: PrivacyScanResult): string[] {
  const lines = ["### Candidate data types (verify, do not paste blindly)", ""];
  if (result.candidateDataTypes.length === 0) {
    lines.push("No data types derived from permissions or SDKs.");
  } else {
    for (const type of result.candidateDataTypes) lines.push(`- ${type}`);
  }
  lines.push("");
  return lines;
}

function renderDeclarationSection(result: PrivacyScanResult): string[] {
  const lines = ["## Declaration check", ""];
  if (!result.declarations) {
    lines.push(
      `No machine-readable declarations loaded from ${renderCode(result.declarationsPath)}.`,
    );
    if (result.declarationsError) lines.push("", `Reason: ${result.declarationsError}`);
  } else if (result.declarationsCheck) {
    const check = result.declarationsCheck;
    lines.push(`- File: ${renderCode(check.path)}`);
    lines.push(`- Result: **${check.ok ? "PASS" : "FAIL"}**`);
    lines.push(`- Missing fields: ${renderList(check.missingFields)}`);
    lines.push(
      `- Observed but not declared permissions: ${renderList(check.undeclaredPermissions)}`,
    );
    lines.push(`- Declared but not observed permissions: ${renderList(check.stalePermissions)}`);
    lines.push(`- Observed but not declared SDKs: ${renderList(check.undeclaredSdks)}`);
    lines.push(`- Declared but not observed SDKs: ${renderList(check.staleSdks)}`);
    lines.push(`- Observed but not declared endpoints: ${renderList(check.undeclaredEndpoints)}`);
    lines.push(`- Declared but not observed endpoints: ${renderList(check.staleEndpoints)}`);
    lines.push(
      `- Account creation observed: ${check.accountCreationObserved ? "yes" : "no"}; declared: ${check.declared.accountCreation === undefined ? "unset" : check.declared.accountCreation ? "yes" : "no"}`,
    );
    lines.push(
      `- Account deletion observed: ${check.accountDeletionObserved ? "yes" : "no"}; declared: ${check.declared.accountDeletion === undefined ? "unset" : check.declared.accountDeletion ? "yes" : "no"}`,
    );
    lines.push(`- Account deletion gap: ${check.accountDeletionGap ? "yes" : "no"}`);
  }
  lines.push("");
  return lines;
}

function renderFindingsSection(result: PrivacyScanResult): string[] {
  const lines = ["## Findings", ""];
  if (result.findings.length === 0) {
    lines.push(
      "No blockers or review items from the static scan. Manual evidence is still required.",
    );
  } else {
    for (const finding of result.findings) {
      const evidence = finding.evidence ? ` (${finding.evidence})` : "";
      lines.push(
        `- **${finding.severity}** ${renderCode(finding.rule)} — ${finding.message}${evidence}`,
      );
    }
  }
  lines.push("");
  return lines;
}

function renderManualEvidence(result: PrivacyScanResult): string[] {
  const lines = [
    "## Manual evidence still required",
    "",
    "- Review every observed endpoint's request and response models, and the backend data flows that are not in this repository.",
    "- Verify runtime collection and sharing with `net_capture`, `adb_logcat`, and SDK documentation; a static scan cannot prove behavior.",
    "- Complete the Play Data safety form from the reviewed inventory, not from permissions and SDKs alone.",
    "- Determine applicable consent and disclosure flows from the data types, user age, and jurisdictions in scope.",
    "- If account creation is enabled, provide an in-app deletion path and a public web deletion URL, then test both.",
    "- Host the privacy policy at a public, stable URL and link it in the app and the Play listing.",
    "- This scan is a review aid, not legal advice.",
  ];
  for (const limitation of result.limitations) lines.push(`- ${limitation}`);
  lines.push("");
  return lines;
}

export function renderPrivacyReport(result: PrivacyScanResult): string {
  const blockers = result.findings.filter((finding) => finding.severity === "blocker");
  const reviews = result.findings.filter((finding) => finding.severity === "review");
  const lines: string[] = [
    `# Privacy inventory — ${result.projectName}`,
    "",
    `Scanned ${result.filesScanned} relevant file(s) under ${renderCode(result.root)}.`,
  ];
  if (result.filesSkipped > 0) {
    lines.push(`Skipped ${result.filesSkipped} unreadable or oversized file(s).`);
  }
  if (result.limitReached) lines.push("The file limit was reached; results may be incomplete.");
  lines.push(
    "",
    `Verdict: **${blockers.length} blocker(s), ${reviews.length} review item(s)**.`,
    "",
    ...renderCoverage(result),
    "## Observed signals",
    "",
    ...renderPermissionsAndSdks(result),
    ...renderEndpointSection(result),
    ...renderStorageSection(result),
    ...renderAccountFlows(result),
    ...renderPiiSection(result),
    ...renderCandidateDataTypes(result),
    ...renderDeclarationSection(result),
    ...renderFindingsSection(result),
    ...renderManualEvidence(result),
  );
  return `${lines.join("\n")}\n`;
}
