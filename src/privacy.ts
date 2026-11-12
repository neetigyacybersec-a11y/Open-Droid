import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

export interface PrivacyScanOptions {
  declarationsPath?: string;
}

export interface SdkFinding {
  artifact: string;
  id: string;
  dataTypes: string[];
  file: string;
}

export interface EndpointFinding {
  host: string;
  file: string;
}

export interface DataStoreFinding {
  kind: string;
  file: string;
}

export interface CodeMatch {
  file: string;
  line: number;
  snippet: string;
}

export interface PiiLogFinding extends CodeMatch {
  identifiers: string[];
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
  sdks: SdkFinding[];
  endpoints: EndpointFinding[];
  dataStores: DataStoreFinding[];
  accountCreation: CodeMatch[];
  accountDeletion: CodeMatch[];
  piiLogs: PiiLogFinding[];
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
  return value.replace(/^android\.permission\./, "");
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

function isRelevantFile(name: string): boolean {
  if (name === "AndroidManifest.xml") return true;
  if (BUILD_FILE_NAMES.has(name)) return true;
  if (name.includes("network_security_config") && name.endsWith(".xml")) return true;
  return /\.(kt|java)$/.test(name);
}

async function collectFiles(
  root: string,
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
      if (!entry.isFile() || !isRelevantFile(entry.name)) continue;
      if (files.length >= MAX_FILES) {
        limitReached = true;
        return;
      }
      files.push(path);
    }
  }

  await walk(root);
  return { files, skipped, limitReached };
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
    findings.push({ file, line, snippet, identifiers });
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

function buildFindings(
  result: Omit<PrivacyScanResult, "findings" | "limitations">,
): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  for (const log of result.piiLogs) {
    findings.push({
      severity: "blocker",
      rule: "pii-log",
      message: `PII identifier(s) may be logged: ${log.identifiers.join(", ")}`,
      evidence: `${log.file}:${log.line}`,
    });
  }

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
    const check = result.declarationsCheck;
    if (check.missingFields.length > 0) {
      findings.push({
        severity: "review",
        rule: "declarations-incomplete",
        message: `Declarations are missing fields: ${check.missingFields.join(", ")}`,
        evidence: check.path,
      });
    }
    if (check.undeclaredPermissions.length > 0) {
      findings.push({
        severity: "blocker",
        rule: "permissions-undeclared",
        message: `Observed permissions are not declared: ${check.undeclaredPermissions.join(", ")}`,
        evidence: check.path,
      });
    }
    if (check.stalePermissions.length > 0) {
      findings.push({
        severity: "review",
        rule: "permissions-stale",
        message: `Declared permissions were not observed (check manifest merging): ${check.stalePermissions.join(", ")}`,
        evidence: check.path,
      });
    }
    if (check.undeclaredSdks.length > 0) {
      findings.push({
        severity: "blocker",
        rule: "sdks-undeclared",
        message: `Observed privacy-relevant SDKs are not declared: ${check.undeclaredSdks.join(", ")}`,
        evidence: check.path,
      });
    }
    if (check.staleSdks.length > 0) {
      findings.push({
        severity: "review",
        rule: "sdks-stale",
        message: `Declared SDKs were not observed (check transitive dependencies): ${check.staleSdks.join(", ")}`,
        evidence: check.path,
      });
    }
    if (check.undeclaredEndpoints.length > 0) {
      findings.push({
        severity: "blocker",
        rule: "endpoints-undeclared",
        message: `Observed endpoints are not declared: ${check.undeclaredEndpoints.join(", ")}`,
        evidence: check.path,
      });
    }
    if (check.staleEndpoints.length > 0) {
      findings.push({
        severity: "review",
        rule: "endpoints-stale",
        message: `Declared endpoints were not observed (check backend-only flows): ${check.staleEndpoints.join(", ")}`,
        evidence: check.path,
      });
    }
    if (check.accountCreationUndeclared) {
      findings.push({
        severity: "blocker",
        rule: "account-creation-undeclared",
        message: "Account creation was observed but declarations say it is disabled.",
        evidence: check.path,
      });
    }
    if (check.accountCreationStale) {
      findings.push({
        severity: "review",
        rule: "account-creation-stale",
        message:
          "Declarations say account creation is enabled, but no creation marker was observed.",
        evidence: check.path,
      });
    }
    if (check.accountDeletionUndeclared) {
      findings.push({
        severity: "blocker",
        rule: "account-deletion-undeclared",
        message: "Account deletion was observed but declarations say it is disabled.",
        evidence: check.path,
      });
    }
    if (check.accountDeletionStale) {
      findings.push({
        severity: "review",
        rule: "account-deletion-stale",
        message:
          "Declarations say account deletion is enabled, but no deletion marker was observed.",
        evidence: check.path,
      });
    }
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

  if (result.limitReached) {
    findings.push({
      severity: "review",
      rule: "scan-limit",
      message: `Scan stopped after ${MAX_FILES} files; results may be incomplete.`,
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

export async function scanPrivacyProject(
  projectPath: string,
  options: PrivacyScanOptions = {},
): Promise<PrivacyScanResult> {
  const root = resolve(projectPath);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error(`not a directory: ${root}`);

  const { files, skipped, limitReached } = await collectFiles(root);
  const permissions = new Set<string>();
  const sdks = new Map<string, SdkFinding>();
  const endpoints = new Map<string, EndpointFinding>();
  const dataStores = new Map<string, DataStoreFinding>();
  const accountCreation: CodeMatch[] = [];
  const accountDeletion: CodeMatch[] = [];
  const piiLogs: PiiLogFinding[] = [];
  const limitations: string[] = [];
  let filesScanned = 0;
  let filesSkipped = skipped;

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      filesSkipped++;
      continue;
    }
    if (content.length > MAX_FILE_BYTES) {
      filesSkipped++;
      continue;
    }
    filesScanned++;
    const filePath = toPosix(relative(root, file));
    const name = basename(file);

    if (name === "AndroidManifest.xml") {
      const xml = content.replace(/<!--[\s\S]*?-->/g, "");
      for (const match of xml.matchAll(
        /<uses-permission(?:-sdk-23)?\b[^>]*\bandroid:name\s*=\s*"([^"]+)"/g,
      )) {
        permissions.add(shortPermission(match[1]));
      }
    }

    if (BUILD_FILE_NAMES.has(name)) {
      for (const line of content.split("\n")) {
        if (isCommentLine(line) || line.trimStart().startsWith("#")) continue;
        for (const match of line.matchAll(
          /["']([A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+)(?::[^"'\s]+)?["']/g,
        )) {
          const artifact = match[1];
          const lower = artifact.toLowerCase();
          for (const entry of SDK_CATALOG) {
            if (!lower.includes(entry.artifact.toLowerCase())) continue;
            const key = entry.artifact.toLowerCase();
            if (sdks.has(key)) continue;
            sdks.set(key, {
              artifact: entry.artifact,
              id: entry.id,
              dataTypes: entry.dataTypes,
              file: filePath,
            });
          }
        }
      }
    }

    if (name.includes("network_security_config") && name.endsWith(".xml")) {
      const xml = content.replace(/<!--[\s\S]*?-->/g, "");
      for (const match of xml.matchAll(/<domain[^>]*>([^<]+)<\/domain>/g)) {
        const host = normalizeHost(match[1]);
        if (host && !endpoints.has(host)) endpoints.set(host, { host, file: filePath });
      }
    }

    if (!/\.(kt|java)$/.test(name)) continue;

    const lines = content.split("\n");
    for (const line of lines) {
      if (isCommentLine(line)) continue;
      for (const match of line.matchAll(URL_HOST)) {
        const host = normalizeHost(match[1]);
        if (host && !endpoints.has(host)) endpoints.set(host, { host, file: filePath });
      }
      for (const marker of DATA_STORE_MARKERS) {
        if (!marker.pattern.test(line) || dataStores.has(marker.kind)) continue;
        dataStores.set(marker.kind, { kind: marker.kind, file: filePath });
      }
    }

    accountCreation.push(...findCodeMatches(content, filePath, ACCOUNT_CREATION, limitations));
    accountDeletion.push(...findCodeMatches(content, filePath, ACCOUNT_DELETION, limitations));
    piiLogs.push(...findPiiLogs(content, filePath, limitations));
  }

  const sortedPermissions = [...permissions].sort();
  const sortedSdks = [...sdks.values()].sort((left, right) =>
    left.artifact.localeCompare(right.artifact),
  );
  const sortedEndpoints = [...endpoints.values()].sort((left, right) =>
    left.host.localeCompare(right.host),
  );
  const sortedDataStores = [...dataStores.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind),
  );
  const sortedCreation = accountCreation
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
    .slice(0, MAX_MATCHES);
  const sortedDeletion = accountDeletion
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
    .slice(0, MAX_MATCHES);
  const sortedPiiLogs = piiLogs
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
    .slice(0, MAX_PII_LOGS);

  limitations.push(
    "Backend request and response payloads are not inspected; review API models and backend data flows for every observed endpoint.",
    "Static scanning cannot prove runtime collection or sharing; use net_capture, adb_logcat and SDK documentation to verify.",
    "Candidate data types are derived from permissions and SDKs only; they are not a completed Play Data safety declaration.",
    "Account deletion may live in a backend or web flow; this scan only finds source-code markers.",
  );
  if (limitReached)
    limitations.push(`File limit reached (${MAX_FILES}); results may be incomplete.`);
  if (filesSkipped > 0)
    limitations.push(
      `${filesSkipped} unreadable or oversized file(s), or unreadable directories, were skipped.`,
    );

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
    filesScanned,
    filesSkipped,
    limitReached,
    permissions: sortedPermissions,
    sdks: sortedSdks,
    endpoints: sortedEndpoints,
    dataStores: sortedDataStores,
    accountCreation: sortedCreation,
    accountDeletion: sortedDeletion,
    piiLogs: sortedPiiLogs,
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

export function renderPrivacyReport(result: PrivacyScanResult): string {
  const blockers = result.findings.filter((finding) => finding.severity === "blocker");
  const reviews = result.findings.filter((finding) => finding.severity === "review");
  const lines: string[] = [
    `# Privacy inventory — ${result.projectName}`,
    "",
    `Scanned ${result.filesScanned} relevant file(s) under ${renderCode(result.root)}.`,
  ];
  if (result.filesSkipped > 0)
    lines.push(`Skipped ${result.filesSkipped} unreadable or oversized file(s).`);
  if (result.limitReached) lines.push("The file limit was reached; results may be incomplete.");
  lines.push(
    "",
    `Verdict: **${blockers.length} blocker(s), ${reviews.length} review item(s)**.`,
    "",
  );

  lines.push("## Observed signals", "", "### Permissions", "");
  if (result.permissions.length === 0) lines.push("No permissions observed.");
  else for (const permission of result.permissions) lines.push(`- ${renderCode(permission)}`);
  lines.push("");

  lines.push("### Privacy-relevant SDKs", "");
  if (result.sdks.length === 0) lines.push("No known privacy-relevant SDK artifacts observed.");
  else {
    for (const sdk of result.sdks) {
      lines.push(
        `- ${renderCode(sdk.artifact)} — ${sdk.id}; candidate data: ${sdk.dataTypes.join(", ")} — ${renderCode(sdk.file)}`,
      );
    }
  }
  lines.push("");

  lines.push("### Network endpoints", "");
  if (result.endpoints.length === 0)
    lines.push("No network endpoints observed in source or network-security configuration.");
  else {
    for (const endpoint of result.endpoints)
      lines.push(`- ${renderCode(endpoint.host)} — ${renderCode(endpoint.file)}`);
    lines.push("", "Endpoints are observed; request and response payloads are not inspected.");
  }
  lines.push("");

  lines.push("### On-device storage", "");
  if (result.dataStores.length === 0) lines.push("No known on-device storage markers observed.");
  else
    for (const store of result.dataStores)
      lines.push(`- ${store.kind} — ${renderCode(store.file)}`);
  lines.push("");

  lines.push("### Account flows", "");
  lines.push(`- Account creation markers: ${result.accountCreation.length}`);
  for (const match of result.accountCreation)
    lines.push(`  - ${renderCode(`${match.file}:${match.line}`)} — ${renderCode(match.snippet)}`);
  lines.push(`- Account deletion markers: ${result.accountDeletion.length}`);
  for (const match of result.accountDeletion)
    lines.push(`  - ${renderCode(`${match.file}:${match.line}`)} — ${renderCode(match.snippet)}`);
  if (result.accountCreation.length > 0 && result.accountDeletion.length === 0) {
    lines.push(
      "",
      "Account creation is present without a deletion marker. Play requires an in-app deletion path when account creation is enabled.",
    );
  }
  lines.push("");

  lines.push("### PII in logs", "");
  if (result.piiLogs.length === 0) lines.push("No PII identifiers found in log calls.");
  else {
    for (const log of result.piiLogs) {
      lines.push(
        `- ${renderCode(`${log.file}:${log.line}`)} — identifiers: ${log.identifiers.join(", ")} — ${renderCode(log.snippet)}`,
      );
    }
  }
  lines.push("");

  lines.push("### Candidate data types (verify, do not paste blindly)", "");
  if (result.candidateDataTypes.length === 0)
    lines.push("No data types derived from permissions or SDKs.");
  else for (const type of result.candidateDataTypes) lines.push(`- ${type}`);
  lines.push("");

  lines.push("## Declaration check", "");
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

  lines.push("## Findings", "");
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

  lines.push("## Manual evidence still required", "");
  lines.push(
    "- Review every observed endpoint's request and response models, and the backend data flows that are not in this repository.",
  );
  lines.push(
    "- Verify runtime collection and sharing with `net_capture`, `adb_logcat`, and SDK documentation; a static scan cannot prove behavior.",
  );
  lines.push(
    "- Complete the Play Data safety form from the reviewed inventory, not from permissions and SDKs alone.",
  );
  lines.push(
    "- Determine applicable consent and disclosure flows from the data types, user age, and jurisdictions in scope.",
  );
  lines.push(
    "- If account creation is enabled, provide an in-app deletion path and a public web deletion URL, then test both.",
  );
  lines.push(
    "- Host the privacy policy at a public, stable URL and link it in the app and the Play listing.",
  );
  lines.push("- This scan is a review aid, not legal advice.");
  for (const limitation of result.limitations) lines.push(`- ${limitation}`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}
