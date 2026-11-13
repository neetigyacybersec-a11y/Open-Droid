// ISSUE #38 slice 1: Google Play policy preflight over a project tree.
//
// Every check is sourced from the current published policy with a source URL
// and a last-verified stamp, so results age visibly instead of silently. The
// preflight is deliberately conservative: a check that cannot be decided from
// source is `not-assessed`, never a silent pass, and the disclaimer separates
// engineering findings from the developer/legal declarations only a human can
// make in Play Console.
//
// Source-scan limits (documented on purpose): Gradle/manifest text matching,
// not a Gradle model evaluation or merged-manifest resolution. Conditional
// features (billing, native code, store listing) are reported when seen, and
// `not-assessed` when absent rather than assumed compliant.
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { auditProjectManifest, type ManifestAuditResult } from "./manifestAudit.js";
import { scanProjectSecrets, type SecretFinding } from "./secretScan.js";
import { scanPrivacyProject, type PrivacyScanResult } from "./privacy.js";

export type PolicyCheckStatus = "passed" | "failed" | "warning" | "not-assessed";

export interface PolicyCheck {
  id: string;
  title: string;
  status: PolicyCheckStatus;
  summary: string;
  evidence: string;
  sourceUrl: string;
  lastVerified: string;
}

export interface PolicyPreflightSummary {
  total: number;
  passed: number;
  failed: number;
  warnings: number;
  notAssessed: number;
}

export interface PolicyPreflightResult {
  projectPath: string;
  checks: PolicyCheck[];
  summary: PolicyPreflightSummary;
  disclaimer: string;
  scannedAt: string;
}

export interface PolicyPreflightOptions {
  projectPath: string;
}

/** Rule freshness: bump when a check's policy interpretation is re-verified. */
const LAST_VERIFIED = "2026-11-13";

/** Play's minimum target API for new apps and updates (Aug 2025 requirement). */
const MIN_TARGET_SDK = 35;

const SOURCES = {
  targetSdk: "https://support.google.com/googleplay/android-developer/answer/11926878",
  dataSafety: "https://support.google.com/googleplay/android-developer/answer/10787469",
  privacyPolicy: "https://support.google.com/googleplay/android-developer/answer/10144311",
  accountDeletion: "https://support.google.com/googleplay/android-developer/answer/13327111",
  advertisingId: "https://support.google.com/googleplay/android-developer/answer/6048248",
  foregroundService: "https://developer.android.com/about/versions/14/changes/fgs-types-required",
  exactAlarm: "https://support.google.com/googleplay/android-developer/answer/10982466",
  billing: "https://support.google.com/googleplay/android-developer/answer/10281818",
  nativeAbi: "https://support.google.com/googleplay/android-developer/answer/9782018",
  debuggable: "https://developer.android.com/privacy-and-security/security-tips#Debuggable",
  cleartext: "https://developer.android.com/privacy-and-security/security-config",
  secrets: "https://developer.android.com/privacy-and-security/security-best-practices",
  storeListing: "https://support.google.com/googleplay/android-developer/answer/9859152",
} as const;

const DISCLAIMER =
  "Engineering preflight only — not legal advice. This scan does not guarantee Play Store " +
  "approval and cannot submit or verify Play Console declarations; confirm every item against " +
  "the linked policy and your own data-safety, content-rating, and account-deletion declarations.";

const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 512_000;

const EXCLUDED_DIRS = new Set([
  ".git",
  ".toolchain",
  ".gradle",
  ".idea",
  "build",
  "node_modules",
  "caches",
  ".cxx",
  "dist",
]);

const TEXT_EXTENSIONS = new Set([
  ".gradle",
  ".kts",
  ".md",
  ".txt",
  ".xml",
  ".json",
  ".properties",
  ".toml",
  ".yml",
  ".yaml",
]);

const GRADLE_FILES = [
  "app/build.gradle.kts",
  "app/build.gradle",
  "build.gradle.kts",
  "build.gradle",
];

interface ProjectFile {
  rel: string;
  abs: string;
}

interface ProjectScan {
  files: ProjectFile[];
  text: Map<string, string>;
  limitReached: boolean;
}

function isTextCandidate(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "readme" || lower.startsWith("readme.")) return true;
  const dot = lower.lastIndexOf(".");
  return dot >= 0 && TEXT_EXTENSIONS.has(lower.slice(dot));
}

async function walkProject(root: string): Promise<ProjectScan> {
  const files: ProjectFile[] = [];
  const text = new Map<string, string>();
  let limitReached = false;

  const visit = async (dir: string): Promise<void> => {
    if (limitReached) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        limitReached = true;
        return;
      }
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) await visit(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, abs).split(sep).join("/");
      files.push({ rel, abs });
      if (!isTextCandidate(entry.name)) continue;
      try {
        const content = await readFile(abs, "utf8");
        if (content.length <= MAX_FILE_BYTES && !content.includes("\u0000")) {
          text.set(rel, content);
        }
      } catch {
        // Unreadable files are skipped; callers see only what was scanned.
      }
    }
  };

  await visit(root);
  return { files, text, limitReached };
}

function firstLineMatch(content: string, pattern: RegExp): string | null {
  for (const line of content.split("\n")) {
    if (pattern.test(line)) return line.trim();
  }
  return null;
}

function gradleContents(scan: ProjectScan): Array<{ rel: string; content: string }> {
  const out: Array<{ rel: string; content: string }> = [];
  for (const rel of GRADLE_FILES) {
    const content = scan.text.get(rel);
    if (content !== undefined) out.push({ rel, content });
  }
  for (const [rel, content] of scan.text) {
    if (GRADLE_FILES.includes(rel)) continue;
    if (rel.endsWith(".gradle") || rel.endsWith(".gradle.kts")) out.push({ rel, content });
  }
  return out;
}

function check(
  id: string,
  title: string,
  status: PolicyCheckStatus,
  summary: string,
  evidence: string,
  sourceUrl: string,
): PolicyCheck {
  return {
    id,
    title,
    status,
    summary,
    evidence,
    sourceUrl,
    lastVerified: LAST_VERIFIED,
  };
}

function targetSdkCheck(scan: ProjectScan): PolicyCheck {
  const gradles = gradleContents(scan);
  for (const { rel, content } of gradles) {
    for (const line of content.split("\n")) {
      const match = line.match(/targetSdk(?:Version)?\s*(?:=\s*)?"?(\d+)"?/);
      if (!match) continue;
      const value = Number(match[1]);
      const evidence = `${rel}: ${line.trim()}`;
      if (value < MIN_TARGET_SDK) {
        return check(
          "target-sdk",
          "Target SDK level meets Play's current requirement",
          "failed",
          `targetSdk ${value} is below Play's minimum API ${MIN_TARGET_SDK} for new apps and ` +
            "updates; Play Console blocks releases below the requirement.",
          evidence,
          SOURCES.targetSdk,
        );
      }
      return check(
        "target-sdk",
        "Target SDK level meets Play's current requirement",
        "passed",
        `targetSdk ${value} meets the API ${MIN_TARGET_SDK} minimum.`,
        evidence,
        SOURCES.targetSdk,
      );
    }
  }
  return check(
    "target-sdk",
    "Target SDK level meets Play's current requirement",
    "not-assessed",
    "No literal targetSdk value found in the scanned Gradle files; resolve the merged value " +
      "with Gradle and confirm it against Play Console.",
    "",
    SOURCES.targetSdk,
  );
}

function dataSafetyCheck(privacy: PrivacyScanResult): PolicyCheck {
  const evidence = "privacy/data-safety.json";
  if (privacy.declarations && !privacy.declarationsError) {
    return check(
      "data-safety-declaration",
      "Data safety declaration source exists",
      "passed",
      "A privacy/data-safety.json declaration file exists and parses. The Play Console form " +
        "itself still has to match the app's actual data collection.",
      evidence,
      SOURCES.dataSafety,
    );
  }
  return check(
    "data-safety-declaration",
    "Data safety declaration source exists",
    "failed",
    "No parseable privacy/data-safety.json declaration was found, so the data-safety form " +
      "cannot be reconciled with what the app collects." +
      (privacy.declarationsError ? ` Parser error: ${privacy.declarationsError}` : ""),
    evidence,
    SOURCES.dataSafety,
  );
}

function privacyPolicyCheck(scan: ProjectScan): PolicyCheck {
  const urlPattern = /https?:\/\/[^\s"'<>)\]]+/;
  for (const [rel, content] of scan.text) {
    for (const line of content.split("\n")) {
      if (!/privacy/i.test(line)) continue;
      const url = line.match(urlPattern)?.[0];
      if (url) {
        return check(
          "privacy-policy",
          "Privacy policy link is present",
          "passed",
          "A privacy policy URL is referenced in project sources; verify it is publicly " +
            "reachable, covers every collected data type, and is also set in Play Console.",
          `${rel}: ${line.trim().slice(0, 160)}`,
          SOURCES.privacyPolicy,
        );
      }
    }
  }
  return check(
    "privacy-policy",
    "Privacy policy link is present",
    "failed",
    "No privacy policy URL was found in project sources. Apps that collect personal data " +
      "must publish a policy and link it in Play Console and in-app.",
    "",
    SOURCES.privacyPolicy,
  );
}

function accountDeletionCheck(privacy: PrivacyScanResult): PolicyCheck {
  const creation = privacy.accountCreation[0];
  const deletion = privacy.accountDeletion[0];
  if (creation && !deletion) {
    return check(
      "account-deletion",
      "Account deletion path exists for account-based apps",
      "failed",
      "Account creation was observed but no account-deletion flow was found. Apps that let " +
        "users create accounts must offer in-app and web deletion paths and declare them in " +
        "Play Console.",
      `${creation.file}:${creation.line}`,
      SOURCES.accountDeletion,
    );
  }
  if (deletion) {
    return check(
      "account-deletion",
      "Account deletion path exists for account-based apps",
      "passed",
      "An account-deletion flow was observed. Confirm the web deletion path and Play Console " +
        "declaration are also in place.",
      `${deletion.file}:${deletion.line}`,
      SOURCES.accountDeletion,
    );
  }
  return check(
    "account-deletion",
    "Account deletion path exists for account-based apps",
    "not-assessed",
    "No account creation or deletion signals were found; this policy applies only if the app " +
      "lets users create accounts.",
    "",
    SOURCES.accountDeletion,
  );
}

function advertisingIdCheck(scan: ProjectScan): PolicyCheck {
  const pattern = /play-services-ads|ads-identifier|com\.google\.android\.gms\.ads|androidx\.ads/i;
  for (const { rel, content } of gradleContents(scan)) {
    const line = firstLineMatch(content, pattern);
    if (line) {
      return check(
        "advertising-id",
        "Advertising ID use is declared",
        "warning",
        "An advertising SDK is present. Declare Advertising ID collection in the data-safety " +
          "form, respect user opt-out, and never use the ID for non-advertising purposes.",
        `${rel}: ${line}`,
        SOURCES.advertisingId,
      );
    }
  }
  return check(
    "advertising-id",
    "Advertising ID use is declared",
    "not-assessed",
    "No advertising SDK dependency was found; the Advertising ID policy applies only if the " +
      "app collects or uses the Advertising ID.",
    "",
    SOURCES.advertisingId,
  );
}

function foregroundServiceCheck(scan: ProjectScan): PolicyCheck {
  const manifest = scan.text.get("app/src/main/AndroidManifest.xml");
  if (manifest === undefined) {
    return check(
      "foreground-service",
      "Foreground services declare a valid type",
      "not-assessed",
      "No app/src/main/AndroidManifest.xml was found in the scanned sources.",
      "",
      SOURCES.foregroundService,
    );
  }
  const services = [...manifest.matchAll(/<service\b[^>]*>/g)].map((m) => m[0]);
  if (services.length === 0) {
    return check(
      "foreground-service",
      "Foreground services declare a valid type",
      "passed",
      "No <service> declarations were found in the manifest.",
      "",
      SOURCES.foregroundService,
    );
  }
  const untyped = services.find((tag) => !/android:foregroundServiceType\s*=/.test(tag));
  if (untyped) {
    return check(
      "foreground-service",
      "Foreground services declare a valid type",
      "failed",
      "A service is declared without android:foregroundServiceType. Android 14+ requires a " +
        "declared type for foreground services; if this service is not a foreground service, " +
        "confirm it never calls startForeground().",
      untyped.trim(),
      SOURCES.foregroundService,
    );
  }
  return check(
    "foreground-service",
    "Foreground services declare a valid type",
    "passed",
    "Every declared service carries an android:foregroundServiceType.",
    services[0]?.trim() ?? "",
    SOURCES.foregroundService,
  );
}

function exactAlarmCheck(scan: ProjectScan): PolicyCheck {
  const manifest = scan.text.get("app/src/main/AndroidManifest.xml");
  if (manifest === undefined) {
    return check(
      "exact-alarm",
      "Exact alarm permissions are justified",
      "not-assessed",
      "No app/src/main/AndroidManifest.xml was found in the scanned sources.",
      "",
      SOURCES.exactAlarm,
    );
  }
  const line = firstLineMatch(manifest, /USE_EXACT_ALARM|SCHEDULE_EXACT_ALARM/);
  if (line) {
    return check(
      "exact-alarm",
      "Exact alarm permissions are justified",
      "warning",
      "An exact-alarm permission is declared. USE_EXACT_ALARM is restricted to alarm/calendar " +
        "core functionality; SCHEDULE_EXACT_ALARM needs a user-facing justification and must " +
        "degrade gracefully when the permission is denied.",
      line,
      SOURCES.exactAlarm,
    );
  }
  return check(
    "exact-alarm",
    "Exact alarm permissions are justified",
    "passed",
    "No exact-alarm permission was declared.",
    "",
    SOURCES.exactAlarm,
  );
}

function billingCheck(scan: ProjectScan): PolicyCheck {
  const pattern = /com\.android\.billingclient|billing-ktx|com\.android\.billing/i;
  for (const { rel, content } of gradleContents(scan)) {
    const line = firstLineMatch(content, pattern);
    if (line) {
      return check(
        "billing",
        "Digital goods use Google Play Billing",
        "warning",
        "Google Play Billing is present. Confirm every digital good and subscription is sold " +
          "through Play Billing and that alternative-payment use is declared where allowed.",
        `${rel}: ${line}`,
        SOURCES.billing,
      );
    }
  }
  return check(
    "billing",
    "Digital goods use Google Play Billing",
    "not-assessed",
    "No Google Play Billing dependency was found; this policy applies only if the app sells " +
      "digital goods or subscriptions.",
    "",
    SOURCES.billing,
  );
}

function nativeAbiCheck(scan: ProjectScan): PolicyCheck {
  const soFile = scan.files.find((f) => f.rel.endsWith(".so"));
  if (soFile) {
    return check(
      "native-abi",
      "Native code ships 64-bit ABIs",
      "warning",
      "Native libraries are present. Play requires a 64-bit ABI alongside any 32-bit ABI; " +
        "verify the packaged splits and ABI filters.",
      soFile.rel,
      SOURCES.nativeAbi,
    );
  }
  for (const { rel, content } of gradleContents(scan)) {
    const line = firstLineMatch(content, /externalNativeBuild|jniLibs|abiFilters|\bndk\s*\{/);
    if (line) {
      return check(
        "native-abi",
        "Native code ships 64-bit ABIs",
        "warning",
        "Native build configuration is present. Play requires a 64-bit ABI alongside any 32-bit " +
          "ABI; verify the packaged splits and ABI filters.",
        `${rel}: ${line}`,
        SOURCES.nativeAbi,
      );
    }
  }
  return check(
    "native-abi",
    "Native code ships 64-bit ABIs",
    "not-assessed",
    "No native libraries or NDK build configuration were found; the 64-bit requirement applies " +
      "only to apps with native code.",
    "",
    SOURCES.nativeAbi,
  );
}

function storeListingCheck(scan: ProjectScan): PolicyCheck {
  const listing = scan.files.find(
    (f) =>
      /(^|\/)(fastlane\/metadata|play-store|store-listing)\//.test(f.rel) ||
      /(short_description|full_description)\.txt$/i.test(f.rel),
  );
  if (listing) {
    return check(
      "store-listing",
      "Store listing metadata exists in the project",
      "warning",
      "Store listing metadata is present. Play listing text, screenshots, and content ratings " +
        "still have to match the shipped app and be submitted in Play Console.",
      listing.rel,
      SOURCES.storeListing,
    );
  }
  return check(
    "store-listing",
    "Store listing metadata exists in the project",
    "not-assessed",
    "No store-listing metadata was found in the project; listing preparation happens in Play " +
      "Console and cannot be verified from source.",
    "",
    SOURCES.storeListing,
  );
}

function manifestChecks(manifestAudit: ManifestAuditResult | null): PolicyCheck[] {
  const has = (id: string) => manifestAudit?.findings.some((f) => f.check === id) ?? false;
  const evidenceFor = (id: string) =>
    manifestAudit?.findings.find((f) => f.check === id)?.evidence.trim() ?? "";

  const debuggable = manifestAudit
    ? has("debuggable")
      ? check(
          "release-debuggable",
          "Release builds are not debuggable",
          "failed",
          "android:debuggable=true is set in the main manifest; debuggers can attach to release " +
            "builds and read process memory.",
          evidenceFor("debuggable"),
          SOURCES.debuggable,
        )
      : check(
          "release-debuggable",
          "Release builds are not debuggable",
          "passed",
          "The main manifest does not enable android:debuggable.",
          "",
          SOURCES.debuggable,
        )
    : check(
        "release-debuggable",
        "Release builds are not debuggable",
        "not-assessed",
        "No app/src/main/AndroidManifest.xml was found in the scanned sources.",
        "",
        SOURCES.debuggable,
      );

  const cleartext = manifestAudit
    ? has("cleartext-traffic")
      ? check(
          "cleartext-traffic",
          "Cleartext traffic is disabled",
          "failed",
          "android:usesCleartextTraffic=true permits unencrypted HTTP for all traffic.",
          evidenceFor("cleartext-traffic"),
          SOURCES.cleartext,
        )
      : check(
          "cleartext-traffic",
          "Cleartext traffic is disabled",
          "passed",
          "The manifest does not enable usesCleartextTraffic; confirm the network security config " +
            "keeps cleartextTrafficPermitted=false.",
          "",
          SOURCES.cleartext,
        )
    : check(
        "cleartext-traffic",
        "Cleartext traffic is disabled",
        "not-assessed",
        "No app/src/main/AndroidManifest.xml was found in the scanned sources.",
        "",
        SOURCES.cleartext,
      );

  return [debuggable, cleartext];
}

function secretsCheck(findings: SecretFinding[]): PolicyCheck {
  if (findings.length === 0) {
    return check(
      "secrets",
      "No credentials are committed to the project",
      "passed",
      "The project secret scan found no credential patterns in the scanned text files.",
      "",
      SOURCES.secrets,
    );
  }
  const evidence = findings
    .slice(0, 5)
    .map((f) => `${f.file}:${f.line} (${f.rule})`)
    .join("\n");
  return check(
    "secrets",
    "No credentials are committed to the project",
    "failed",
    `${findings.length} potential secret(s) were found. Values are redacted here; rotate every ` +
      "exposed credential and move it to CI secrets or a secret manager.",
    evidence,
    SOURCES.secrets,
  );
}

export async function runPolicyPreflight(
  opts: PolicyPreflightOptions,
): Promise<PolicyPreflightResult> {
  const projectPath = opts.projectPath;
  const scan = await walkProject(projectPath);

  let manifestAudit: ManifestAuditResult | null = null;
  try {
    manifestAudit = await auditProjectManifest({ projectPath });
  } catch {
    manifestAudit = null;
  }

  const privacy = await scanPrivacyProject(projectPath);
  const secrets = await scanProjectSecrets({ projectPath });

  const checks: PolicyCheck[] = [
    targetSdkCheck(scan),
    dataSafetyCheck(privacy),
    privacyPolicyCheck(scan),
    accountDeletionCheck(privacy),
    advertisingIdCheck(scan),
    foregroundServiceCheck(scan),
    exactAlarmCheck(scan),
    billingCheck(scan),
    nativeAbiCheck(scan),
    ...manifestChecks(manifestAudit),
    secretsCheck(secrets.findings),
    storeListingCheck(scan),
  ];

  const summary: PolicyPreflightSummary = {
    total: checks.length,
    passed: checks.filter((c) => c.status === "passed").length,
    failed: checks.filter((c) => c.status === "failed").length,
    warnings: checks.filter((c) => c.status === "warning").length,
    notAssessed: checks.filter((c) => c.status === "not-assessed").length,
  };

  return {
    projectPath,
    checks,
    summary,
    disclaimer: DISCLAIMER,
    scannedAt: new Date().toISOString(),
  };
}

export function renderPolicyPreflight(result: PolicyPreflightResult): string {
  const lines: string[] = [
    "# Play policy preflight",
    "",
    `Project: ${result.projectPath}`,
    `Summary: ${result.summary.total} check(s) — ${result.summary.passed} passed, ` +
      `${result.summary.failed} failed, ${result.summary.warnings} warning(s), ` +
      `${result.summary.notAssessed} not assessed.`,
    "",
  ];
  for (const c of result.checks) {
    lines.push(`## [${c.status}] ${c.title} (${c.id})`, "");
    lines.push(c.summary, "");
    if (c.evidence) lines.push("Evidence:", "```", c.evidence, "```", "");
    lines.push(`Policy: ${c.sourceUrl} (verified ${c.lastVerified})`, "");
  }
  lines.push("> " + result.disclaimer);
  return lines.join("\n");
}
