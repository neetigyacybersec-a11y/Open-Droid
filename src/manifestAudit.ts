// ISSUE #37 slice 1: project-level Android security audit (source mode).
//
// Scope of this slice: a pragmatic, line-oriented scan of the source
// AndroidManifest.xml. It reports manifest facts as `confirmed` and
// intent-filter configuration as `heuristic`; compiled-APK inspection and
// Gradle merged-manifest comparison are later slices.
//
// Parser limits (documented on purpose): regex/attribute extraction only, not
// a full XML parse. Attributes are matched namespace-agnostically and must sit
// inside a single element tag; multi-line attribute values are not supported.
// Security settings that need source-code analysis (WebView, PendingIntent,
// logging, signing) are reported through `notAssessed`, never as silent passes.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Classification = "confirmed" | "heuristic" | "not-assessed";

export interface AuditFinding {
  check: string;
  severity: Severity;
  classification: Classification;
  file: string;
  evidence: string;
  rationale: string;
  remediation: string;
}

export interface AcceptedFinding {
  check: string;
  file: string;
  acceptedRationale: string;
}

export interface ManifestAuditResult {
  projectPath: string;
  manifestPath: string;
  findings: AuditFinding[];
  passed: string[];
  notAssessed: string[];
  accepted: AcceptedFinding[];
  scannedAt: string;
}

export interface ManifestAuditOptions {
  projectPath: string;
}

interface BaselineEntry {
  check: string;
  file: string;
  rationale: string;
}

const MANIFEST_REL = "app/src/main/AndroidManifest.xml";

const NOT_ASSESSED = [
  // Require source-code inspection (later slice), not manifest text.
  "webview-settings",
  "pendingintent-mutability",
  "logging",
  "signing-config",
] as const;

const DANGEROUS_PERMISSIONS = [
  "android.permission.CAMERA",
  "android.permission.RECORD_AUDIO",
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.ACCESS_BACKGROUND_LOCATION",
  "android.permission.READ_CONTACTS",
  "android.permission.READ_SMS",
  "android.permission.READ_CALL_LOG",
  "android.permission.QUERY_ALL_PACKAGES",
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.REQUEST_INSTALL_PACKAGES",
  "android.permission.MANAGE_EXTERNAL_STORAGE",
] as const;

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`);
  const m = tag.match(re);
  return m ? m[1] : null;
}

function componentTags(text: string, element: "activity" | "service" | "receiver"): string[] {
  // Match the opening tag only (non-greedy up to the first `>`). Attributes
  // must be single-line — see the parser limit in the module header.
  const re = new RegExp(`<${element}\\b[^>]*>`, "g");
  return [...text.matchAll(re)].map((m) => m[0]);
}

function nameOf(tag: string): string {
  return attr(tag, "android:name") ?? "(unnamed)";
}

async function readBaseline(projectPath: string): Promise<BaselineEntry[]> {
  try {
    const raw = await readFile(join(projectPath, ".securitybaseline.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is BaselineEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as BaselineEntry).check === "string" &&
        typeof (e as BaselineEntry).file === "string" &&
        typeof (e as BaselineEntry).rationale === "string",
    );
  } catch {
    return [];
  }
}

export async function auditProjectManifest(
  opts: ManifestAuditOptions,
): Promise<ManifestAuditResult> {
  const projectPath = opts.projectPath;
  const manifestPath = join(projectPath, MANIFEST_REL);

  let text: string;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch {
    throw new Error(
      `AndroidManifest.xml not found at ${manifestPath} — pass a project root containing ` +
        `${MANIFEST_REL} (compiled-APK inspection is a later slice).`,
    );
  }

  const findings: AuditFinding[] = [];
  const passed: string[] = [];

  const add = (
    check: string,
    severity: Severity,
    classification: Classification,
    evidence: string,
    rationale: string,
    remediation: string,
  ) => {
    findings.push({
      check,
      severity,
      classification,
      file: MANIFEST_REL,
      evidence: evidence.trim(),
      rationale,
      remediation,
    });
  };

  // --- exported components -------------------------------------------------
  let exportedHits = 0;
  for (const element of ["activity", "service", "receiver"] as const) {
    for (const tag of componentTags(text, element)) {
      const exported = attr(tag, "android:exported");
      const permission = attr(tag, "android:permission");
      if (exported === "true" && !permission) {
        exportedHits++;
        add(
          "exported-component-no-permission",
          "high",
          "confirmed",
          tag,
          `${element} ${nameOf(tag)} is exported without an android:permission guard — any app ` +
            "on the device can start/invoke it.",
          'Add an android:permission (signature-level), set android:exported="false" where ' +
            "possible, or protect the entry point explicitly.",
        );
      }
    }
  }
  if (exportedHits === 0) passed.push("exported-component-no-permission");

  let providerHits = 0;
  for (const m of text.matchAll(/<provider\b[^>]*>/g)) {
    const tag = m[0];
    const exported = attr(tag, "android:exported");
    const permission = attr(tag, "android:permission");
    if (exported === "true" && !permission) {
      providerHits++;
      const grants = attr(tag, "android:grantUriPermissions") === "true";
      add(
        "exported-provider-no-permission",
        grants ? "critical" : "high",
        "confirmed",
        tag,
        `Exported content provider ${nameOf(tag)} has no android:permission guard` +
          (grants ? " and grants URI permissions to callers — data exposure risk." : "."),
        'Add a signature-level android:permission, set android:exported="false" where ' +
          "possible, and restrict android:grantUriPermissions.",
      );
    }
  }
  if (providerHits === 0) passed.push("exported-provider-no-permission");

  // --- application-level flags --------------------------------------------
  const applicationTag = text.match(/<application\b[^>]*>/)?.[0] ?? "";

  const allowBackup = attr(applicationTag, "android:allowBackup");
  if (allowBackup === "true") {
    add(
      "allow-backup",
      "medium",
      "confirmed",
      applicationTag,
      "allowBackup=true lets adb backup extract app data (including tokens and cached PII) " +
        "on devices/builds where backup is permitted.",
      'Set android:allowBackup="false", or keep backup and add explicit dataExtractionRules ' +
        "and full-backup-content exclusions.",
    );
  } else if (allowBackup === null) {
    add(
      "allow-backup",
      "info",
      "confirmed",
      applicationTag,
      "allowBackup is not declared; the platform default is true.",
      "Declare android:allowBackup explicitly and add dataExtractionRules exclusions for " +
        "sensitive data.",
    );
  } else {
    passed.push("allow-backup");
  }

  const cleartext = attr(applicationTag, "android:usesCleartextTraffic");
  if (cleartext === "true") {
    add(
      "cleartext-traffic",
      "high",
      "confirmed",
      applicationTag,
      "usesCleartextTraffic=true permits unencrypted HTTP for all traffic.",
      "Remove the flag and add a network security config that sets " +
        "cleartextTrafficPermitted=false.",
    );
  } else {
    passed.push("cleartext-traffic");
  }

  const nsc = attr(applicationTag, "android:networkSecurityConfig");
  if (nsc === null) {
    add(
      "network-security-config",
      "medium",
      "confirmed",
      applicationTag,
      "No android:networkSecurityConfig is declared, so the platform defaults apply with no " +
        "app-level cleartext or trust overrides.",
      "Add android:networkSecurityConfig pointing at a config with explicit " +
        "cleartextTrafficPermitted and trust-anchors.",
    );
  } else {
    passed.push("network-security-config");
  }

  if (attr(applicationTag, "android:debuggable") === "true") {
    add(
      "debuggable",
      "high",
      "confirmed",
      applicationTag,
      "debuggable=true in the main manifest ships a debuggable release build unless a build " +
        "variant overrides it — debuggers can attach and read process memory.",
      "Remove android:debuggable from the main manifest; the debug build variant enables it " +
        "automatically.",
    );
  } else {
    passed.push("debuggable");
  }

  if (attr(applicationTag, "android:testOnly") === "true") {
    add(
      "test-only",
      "info",
      "confirmed",
      applicationTag,
      "testOnly=true blocks installation from stores and should never ship.",
      "Remove android:testOnly from the main manifest.",
    );
  } else {
    passed.push("test-only");
  }

  // --- deep links ----------------------------------------------------------
  const intentFilters = [...text.matchAll(/<intent-filter\b[^>]*>[\s\S]*?<\/intent-filter>/g)];
  let customSchemeHits = 0;
  let autoVerifyHits = 0;
  intentFilters.forEach((m) => {
    const block = m[0];
    const openTag = block.slice(0, block.indexOf(">") + 1);
    for (const dm of block.matchAll(/<data\b[^>]*>/g)) {
      const scheme = attr(dm[0], "android:scheme");
      if (!scheme) continue;
      const evidence = `${openTag} ${dm[0]}`;
      if (scheme === "http" || scheme === "https") {
        if (attr(openTag, "android:autoVerify") !== "true") {
          autoVerifyHits++;
          add(
            "deep-link-autoverify",
            "medium",
            "heuristic",
            evidence,
            `https deep link for host ${attr(dm[0], "android:host") ?? "(any)"} does not set ` +
              "android:autoVerify=true — Android cannot verify domain ownership automatically.",
            'Set android:autoVerify="true" and publish assetlinks.json for the domain.',
          );
        }
      } else {
        customSchemeHits++;
        add(
          "deep-link-custom-scheme",
          "medium",
          "heuristic",
          evidence,
          `Custom scheme "${scheme}" deep link — any app can claim the same scheme; treat ` +
            "parameters as untrusted input.",
          "Prefer verified https App Links; validate and authorize every deep-link parameter.",
        );
      }
    }
  });
  if (customSchemeHits === 0) passed.push("deep-link-custom-scheme");
  if (autoVerifyHits === 0) passed.push("deep-link-autoverify");

  // --- dangerous permission inventory -------------------------------------
  let permissionHits = 0;
  for (const m of text.matchAll(/<uses-permission\b[^>]*>/g)) {
    const tag = m[0];
    const name = attr(tag, "android:name");
    if (!name || !DANGEROUS_PERMISSIONS.includes(name as (typeof DANGEROUS_PERMISSIONS)[number])) {
      continue;
    }
    permissionHits++;
    add(
      "dangerous-permissions",
      "info",
      "confirmed",
      tag,
      `${name} is a runtime (dangerous) permission and a Play data-safety signal.`,
      "Justify the permission in the manifest/data-safety form or drop it.",
    );
  }
  if (permissionHits === 0) passed.push("dangerous-permissions");

  // --- baseline ------------------------------------------------------------
  const baseline = await readBaseline(projectPath);
  const accepted: AcceptedFinding[] = [];
  for (const entry of baseline) {
    const idx = findings.findIndex((f) => f.check === entry.check && f.file === entry.file);
    if (idx >= 0) {
      findings.splice(idx, 1);
      accepted.push({
        check: entry.check,
        file: entry.file,
        acceptedRationale: entry.rationale,
      });
      // A baselined check is accepted, not passed.
      const pIdx = passed.indexOf(entry.check);
      if (pIdx >= 0) passed.splice(pIdx, 1);
    }
  }

  return {
    projectPath,
    manifestPath,
    findings,
    passed,
    notAssessed: [...NOT_ASSESSED],
    accepted,
    scannedAt: new Date().toISOString(),
  };
}
