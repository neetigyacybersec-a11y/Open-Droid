// ISSUE #36 slice 1: project-level secret scanning.
//
// Scope of this slice: filesystem scan of a project tree with a curated set of
// well-known public credential formats plus a high-entropy generic-credential
// heuristic. Git history scanning is a later, explicit opt-in slice. The rule
// set is deliberately small and documented — it is not a claim of complete
// coverage.
//
// Redaction is a hard invariant: detected values never leave this module. The
// snippet in every finding has the value replaced with `[REDACTED:<rule>]`, and
// PEM/keystore content is reported by path only.
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SecretSeverity = "critical" | "high" | "medium" | "low";
export type SecretConfidence = "confirmed" | "heuristic";

export interface SecretFinding {
  rule: string;
  provider: string;
  severity: SecretSeverity;
  confidence: SecretConfidence;
  file: string;
  line: number;
  column: number;
  snippet: string;
  remediation: string;
  tracked: boolean | null;
}

export interface AllowlistedFinding {
  rule: string;
  file: string;
  rationale: string;
}

export interface SecretScanResult {
  projectPath: string;
  scannedFiles: number;
  findings: SecretFinding[];
  excludedPaths: string[];
  allowlist: AllowlistedFinding[];
  scannedAt: string;
}

export interface SecretScanOptions {
  projectPath: string;
  severityThreshold?: SecretSeverity;
}

interface Rule {
  id: string;
  provider: string;
  severity: SecretSeverity;
  confidence: SecretConfidence;
  pattern: RegExp;
  remediation: string;
  /** When true the matched value is the whole secret; snippet keeps context only. */
  secretGroup?: number;
}

const RULES: Rule[] = [
  {
    id: "google-api-key",
    provider: "Google",
    severity: "high",
    confidence: "confirmed",
    pattern: /AIza[0-9A-Za-z_-]{35}/g,
    remediation:
      "Revoke the key in Google Cloud Console, restrict it by package/SHA-1 and API, and " +
      "inject it at build time from CI secrets.",
  },
  {
    id: "aws-access-key",
    provider: "AWS",
    severity: "high",
    confidence: "confirmed",
    pattern: /AKIA[0-9A-Z]{16}/g,
    remediation:
      "Deactivate the access key in IAM, rotate credentials, and use short-lived STS " +
      "credentials or CI secret injection instead.",
  },
  {
    id: "github-token",
    provider: "GitHub",
    severity: "high",
    confidence: "confirmed",
    pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g,
    remediation:
      "Revoke the token in GitHub settings, audit its usage, and use GitHub Actions secrets " +
      "or a fine-grained token scoped per repository.",
  },
  {
    id: "slack-token",
    provider: "Slack",
    severity: "high",
    confidence: "confirmed",
    pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    remediation:
      "Revoke the token in the Slack app configuration and rotate the bot/user credentials.",
  },
  {
    id: "openai-key",
    provider: "OpenAI",
    severity: "high",
    confidence: "confirmed",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}/g,
    remediation: "Revoke the API key in the provider dashboard and rotate it via CI secrets.",
  },
];

const GENERIC_CREDENTIAL =
  /\b(password|passwd|secret|token|api[._-]?key|storePassword|keyPassword)\s*[:=]\s*(?:"([^"]{8,})"|'([^']{8,})')/gi;

// Bare `key=value` credentials are only expected in config-style lines. Doing
// this at line start keeps code like `val password = credential.password` out.
const GENERIC_CREDENTIAL_BARE =
  /^\s*(password|passwd|secret|token|api[._-]?key|storePassword|keyPassword)\s*[:=]\s*([^\s"'#]{8,})/i;

// Indirections are not secrets: env lookups, build config, property providers,
// templating, and field references.
const INDIRECTION =
  /getenv|BuildConfig|process\.env|\$\{|providers\.|System\.getenv|getProperty|credential\./i;

const PRIVATE_KEY_BLOCK = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/;

const TEXT_EXTENSIONS = new Set([
  ".env",
  ".kt",
  ".kts",
  ".java",
  ".xml",
  ".json",
  ".yaml",
  ".yml",
  ".properties",
  ".gradle",
  ".toml",
  ".cfg",
  ".ini",
  ".pem",
  ".txt",
  ".md",
]);

const TEXT_FILENAMES = new Set([".env", "local.properties"]);

const EXCLUDED_DIRS = new Set([
  ".git",
  ".toolchain",
  "build",
  ".gradle",
  "node_modules",
  ".idea",
  "caches",
]);

const EXCLUDED_EXTENSIONS = new Set([
  ".jks",
  ".keystore",
  ".apk",
  ".aab",
  ".jar",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".zip",
  ".so",
  ".dex",
  ".class",
]);

const SEVERITY_ORDER: Record<SecretSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function isTextCandidate(name: string): boolean {
  const lower = name.toLowerCase();
  if (TEXT_FILENAMES.has(lower)) return true;
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(lower.slice(dot));
}

function isExcludedName(name: string): boolean {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 && EXCLUDED_EXTENSIONS.has(lower.slice(dot));
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function redact(line: string, secret: string, ruleId: string): string {
  return line.replace(secret, `[REDACTED:${ruleId}]`).trim().slice(0, 140);
}

async function walk(
  root: string,
  dir: string,
  scanFiles: string[],
  excluded: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).split(sep).join("/");
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) {
        excluded.push(rel);
        continue;
      }
      await walk(root, full, scanFiles, excluded);
      continue;
    }
    if (!entry.isFile()) continue;
    if (isExcludedName(entry.name)) {
      excluded.push(rel);
      continue;
    }
    if (!isTextCandidate(entry.name)) continue;
    scanFiles.push(full);
  }
}

async function trackedStatus(root: string, relPath: string): Promise<boolean | null> {
  try {
    await execFileAsync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"]);
  } catch {
    return null;
  }
  try {
    await execFileAsync("git", ["-C", root, "ls-files", "--error-unmatch", relPath]);
    return true;
  } catch {
    return false;
  }
}

async function readAllowlist(root: string): Promise<AllowlistedFinding[]> {
  try {
    const raw = await readFile(join(root, ".secretallowlist.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is AllowlistedFinding =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as AllowlistedFinding).rule === "string" &&
        typeof (e as AllowlistedFinding).file === "string" &&
        typeof (e as AllowlistedFinding).rationale === "string",
    );
  } catch {
    return [];
  }
}

export async function scanProjectSecrets(opts: SecretScanOptions): Promise<SecretScanResult> {
  const projectPath = opts.projectPath;
  const threshold = opts.severityThreshold ?? "low";
  const scanFiles: string[] = [];
  const excludedPaths: string[] = [];
  await walk(projectPath, projectPath, scanFiles, excludedPaths);

  const findings: SecretFinding[] = [];

  for (const full of scanFiles) {
    const relPath = relative(projectPath, full).split(sep).join("/");
    let content: string;
    try {
      content = await readFile(full, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\u0000")) {
      excludedPaths.push(relPath);
      continue;
    }
    const lines = content.split("\n");

    if (PRIVATE_KEY_BLOCK.test(content)) {
      const idx = content.search(PRIVATE_KEY_BLOCK);
      const line = content.slice(0, idx).split("\n").length;
      const lineText = lines[line - 1] ?? "";
      findings.push({
        rule: "private-key-block",
        provider: "PEM",
        severity: "critical",
        confidence: "confirmed",
        file: relPath,
        line,
        column: Math.max(1, lineText.indexOf("-----BEGIN") + 1),
        snippet: "[REDACTED PRIVATE KEY BLOCK]",
        remediation:
          "Remove the key from the repository and history, rotate it, and store it in a " +
          "secret manager or CI secret — never in the project tree.",
        tracked: await trackedStatus(projectPath, relPath),
      });
    }

    lines.forEach((lineText, index) => {
      for (const rule of RULES) {
        rule.pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = rule.pattern.exec(lineText)) !== null) {
          const secret = match[0];
          if (shannonEntropy(secret) < 2.5) continue;
          findings.push({
            rule: rule.id,
            provider: rule.provider,
            severity: rule.severity,
            confidence: rule.confidence,
            file: relPath,
            line: index + 1,
            column: match.index + 1,
            snippet: redact(lineText, secret, rule.id),
            remediation: rule.remediation,
            tracked: null, // filled in after allowlist filtering (async)
          });
        }
      }

      GENERIC_CREDENTIAL.lastIndex = 0;
      let gm: RegExpExecArray | null;
      while ((gm = GENERIC_CREDENTIAL.exec(lineText)) !== null) {
        const value = gm[2] ?? gm[3];
        if (!value) continue;
        if (INDIRECTION.test(lineText)) continue;
        if (shannonEntropy(value) < 2.5) continue;
        const isKeystore = /storePassword|keyPassword/i.test(gm[1]);
        findings.push({
          rule: "generic-credential",
          provider: isKeystore ? "Gradle keystore" : "generic",
          severity: "medium",
          confidence: "heuristic",
          file: relPath,
          line: index + 1,
          column: gm.index + gm[0].indexOf(value) + 1,
          snippet: redact(lineText, value, "generic-credential"),
          remediation:
            "Move the value to local.properties/CI secrets, load it via an environment or " +
            "Gradle property, and rotate the credential if it was committed.",
          tracked: null,
        });
      }

      const bare = lineText.match(GENERIC_CREDENTIAL_BARE);
      if (bare) {
        const value = bare[2];
        if (!INDIRECTION.test(lineText) && value && shannonEntropy(value) >= 2.5) {
          const isKeystore = /storePassword|keyPassword/i.test(bare[1]);
          findings.push({
            rule: "generic-credential",
            provider: isKeystore ? "Gradle keystore" : "generic",
            severity: "medium",
            confidence: "heuristic",
            file: relPath,
            line: index + 1,
            column: bare[0].indexOf(value) + 1,
            snippet: redact(lineText, value, "generic-credential"),
            remediation:
              "Move the value to local.properties/CI secrets, load it via an environment or " +
              "Gradle property, and rotate the credential if it was committed.",
            tracked: null,
          });
        }
      }
    });
  }

  // Redaction invariant: findings above were built from redacted snippets only.
  const allowlistEntries = await readAllowlist(projectPath);
  const filtered: SecretFinding[] = [];
  const allowlisted: AllowlistedFinding[] = [];
  for (const finding of findings) {
    const allow = allowlistEntries.find((a) => a.rule === finding.rule && a.file === finding.file);
    if (allow) {
      allowlisted.push(allow);
      continue;
    }
    if (SEVERITY_ORDER[finding.severity] < SEVERITY_ORDER[threshold]) continue;
    finding.tracked = await trackedStatus(projectPath, finding.file);
    filtered.push(finding);
  }

  return {
    projectPath,
    scannedFiles: scanFiles.length,
    findings: filtered,
    excludedPaths,
    allowlist: allowlisted,
    scannedAt: new Date().toISOString(),
  };
}
