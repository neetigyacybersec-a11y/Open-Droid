#!/usr/bin/env node
// ISSUE-49: CI workflow failure collection and diagnosis. Reads GitHub Actions
// run/job/step evidence through the official gh CLI, or accepts local logs
// for other CI systems. Produces a bounded, redacted failure excerpt, a
// classification with confidence labels, and a repro command.
//
// Usage:
//   node scripts/ci-failures.mjs --run <url>       # GitHub Actions run URL
//   node scripts/ci-failures.mjs --local <dir>     # local CI log directory
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REDACTIONS = [
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[REDACTED-TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED-TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED-TOKEN]"],
  [/\b(?:aws_secret_access_key|password|passwd|secret|token|api[_-]?key|passcode)\s*[:=]\s*\S+/gi, "[REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_.-]{10,}/g, "[REDACTED-JWT]"],
  [/https?:\/\/[^/\s:@]+:[^/\s@]+@/g, "https://[REDACTED]@"],
  [/\b(?:store|storeFile|storePassword|keyAlias|keyPassword|keystore|signingConfig|secureKey)\b[^\n]{0,120}/gi, "[REDACTED-SIGNING]"],
  [/\b(?:ci|artifactory|registry)\.\S+\.\S*\b/gi, "[REDACTED-HOST]"],
  [/\b[a-z-]+\.(?:internal|corp\.example\.com|corp)\b/gi, "[REDACTED-HOST]"],
  [/\b(?:10\.\d{1,3}|192\.168\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g, "[REDACTED-HOST]"],
];

/** Remove secrets, signing material, internal hostnames and private IPs. */
export function redactEvidence(text) {
  let safe = text ?? "";
  for (const [pattern, replacement] of REDACTIONS) safe = safe.replace(pattern, replacement);
  return safe;
}

const SIGNATURES = [
  ["dependency", /could not resolve|dependency resolution failed|could not find .*\.pom|failed to find .*jar/i],
  ["kotlin-compile", /\be: file:|unresolved reference|compilation error|compilation failed|kotlin compilation/i],
  ["lint", /lint found|lint check|ktlint|spotless|detekt/i],
  ["emulator-startup", /failed to start the emulator|emulator .* offline|qemu-system|exited with status|timed out waiting for emulator/i],
  ["instrumentation", /INSTRUMENTATION_STATUS|ClassNotFoundException|InstrumentationTestRunner|Test.*not started/i],
  ["maestro", /maestro|flow .*failed|Assertion failed: \[id=/i],
  ["signing", /signing|keystore|certificate|failed to sign/i],
  ["artifact-upload", /failed to create artifact|failed to upload|artifact.*upload|upload.*artifact/i],
  ["unit-test", /FAILED\s*[>\[]|there were failing tests|test run failed|junit failure/i],
];

const FAILURE_MARKER_RE = /\b(?:FAILED|FAILURE|ERROR|EXCEPTION|failed|failure|error|exception)\b|FAILED\s*[>\[]/i;
function hasFailureMarker(text) {
  return FAILURE_MARKER_RE.test(text ?? "");
}
function excerptTruncated(text, maxLines = 40) {
  return (text ?? "").split(/\r?\n/).filter((line) => line.trim()).length > maxLines;
}
function extractStackLines(log, max = 6) {
  return log
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && /\.(kt|java|scala|ktx):\d+/.test(line))
    .slice(0, max);
}

function extractFailureEvidence(log) {
  const evidence = [];
  const re = /FAILED[^\n]*?([\w.$-]+)\[FAILED\]/g;
  for (const match of log.matchAll(re)) {
    const testId = match[1];
    if (evidence.some((e) => e.testId === testId)) continue;
    evidence.push({ testId, message: match[0], stackLines: extractStackLines(log) });
  }
  if (evidence.length === 0) {
    const first = log.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
    evidence.push({ testId: null, message: first, stackLines: extractStackLines(log) });
  }
  return evidence;
}

/**
 * Classify a failure log into a kind (or "unknown"), a confidence label
 * (confirmed/likely/unknown), the failure evidence (test ids, messages, stack
 * lines) and an explanatory reason. Never invents a cause from nothing.
 */
export function classifyFailure({ log, jobName, stepName } = {}) {
  const text = log ?? "";
  const evidence = extractFailureEvidence(text);
  const entry = SIGNATURES.find(([, re]) => re.test(text));
  if (!entry) {
    return {
      kind: "unknown",
      label: "unknown",
      evidence,
      jobName,
      stepName,
      reason: "No failure signature matched in the provided log excerpt",
    };
  }
  const [kind] = entry;
  return {
    kind,
    label: hasFailureMarker(text) ? "confirmed" : "likely",
    evidence,
    jobName,
    stepName,
    reason: undefined,
  };
}

function parseRunRef(runRef) {
  if (/^[0-9a-f]{6,40}$/i.test(runRef)) return { id: runRef, repo: null };
  try {
    const url = new URL(runRef);
    if (!url.pathname.includes("/actions/runs/")) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const idIdx = parts.indexOf("runs");
    if (idIdx < 0) return null;
    const id = parts[idIdx + 1];
    return { id, repo: parts.slice(0, 2).join("/") };
  } catch {
    return null;
  }
}

function defaultRunFn(args) {
  const res = spawnSync(args[0], args.slice(1), { encoding: "utf8" });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

async function ghApi(runFn, path) {
  const res = await runFn(["api", path]);
  if (res.code !== 0) return { ok: false, stderr: res.stderr, stdout: res.stdout };
  try {
    return { ok: true, data: JSON.parse(res.stdout || "[]") };
  } catch {
    return { ok: false, stderr: "gh api returned non-JSON output", stdout: res.stdout };
  }
}

function failedSteps(job) {
  const steps = (job.steps ?? []).filter((s) => s.conclusion === "failure");
  return steps.map((s) => s.name).filter(Boolean);
}

function reproForKind(kind, projectPathHint) {
  const commands = {
    dependency: "gradle :app:dependencies --configuration debugCompileClasspath",
    "kotlin-compile": "gradle :app:compileDebugKotlin",
    lint: "gradle :app:lintDebug",
    "emulator-startup": "avd_create or emulator_boot via the tooling skill",
    instrumentation: "gradle :app:connectedDebugAndroidTest",
    maestro: "maestro test",
    signing: "gradle :app:assembleDebug",
    "artifact-upload": "gradle :app:uploadDebug --dryRun",
  };
  const command = commands[kind] ?? "gradle test";
  return `cd ${projectPathHint ?? "$PROJECT_ROOT"} && ${command}`;
}

function boundedExcerpt(text, maxLines = 40) {
  const lines = (text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.slice(0, maxLines).join("\n");
}

async function collectFromGithub(runRef, runFn) {
  const parsed = parseRunRef(runRef);
  if (!parsed?.repo) {
    return {
      status: "error",
      collected: false,
      reason: `Unrecognised run reference: ${runRef}. Provide an https://github.com/owner/repo/actions/runs/<id> URL.`,
    };
  }
  const runPath = `repos/${parsed.repo}/actions/runs/${parsed.id}`;
  const runRes = await ghApi(runFn, runPath);
  if (!runRes.ok) {
    return { status: "error", collected: false, reason: (runRes.stderr || "gh api failed").trim().slice(0, 400) };
  }
  const run = runRes.data;
  const jobsRes = await ghApi(runFn, `${runPath}/jobs`);
  const jobs = jobsRes.ok ? jobsRes.data : [];
  const failedJobs = jobs.filter((j) => j.conclusion === "failure");
  const failures = [];
  let anyTruncated = false;
  for (const job of failedJobs) {
    const logRes = await runFn(["api", `repos/${parsed.repo}/actions/jobs/${job.databaseId ?? job.id}/logs`]);
    const log = logRes.code === 0 ? logRes.stdout : `(unable to fetch log for job ${job.name})`;
    anyTruncated ||= excerptTruncated(log);
    const classification = classifyFailure({
      log,
      jobName: job.name,
      stepName: failedSteps(job).join(", ") || "unspecified",
    });
    failures.push({
      kind: classification.kind,
      label: classification.label,
      jobName: job.name,
      excerpt: boundedExcerpt(log),
      evidence: classification.evidence,
    });
  }
  const kinds = new Set(failures.map((f) => f.kind));
  return {
    status: failedJobs.length > 0 ? "failure" : run.conclusion === "failure" ? "failure" : "ok",
    collected: true,
    url: run.htmlUrl ?? runRef,
    runId: run.databaseId ?? run.id,
    commitSha: run.headSha,
    failedJobs: failedJobs.map((j) => j.name),
    failures,
    repro: failures[0] ? reproForKind(failures[0].kind) : null,
    excerpt: boundedExcerpt(
      failures
        .filter((f) => f.excerpt)
        .slice(0, 3)
        .map((f) => `[${f.kind}] ${f.excerpt}`)
        .join("\n"),
      40,
    ),
    kinds: [...kinds].sort(),
    truncated: anyTruncated,
  };
}

async function collectLocal(dir, runFn) {
  const files = readdirSync(dir)
    .filter((f) => /\.(log|txt)$/i.test(f))
    .map((f) => join(dir, f))
    .sort();
  const failures = [];
  let anyTruncated = false;
  for (const file of files) {
    const log = readFileSync(file, "utf8");
    anyTruncated ||= excerptTruncated(log);
    const classification = classifyFailure({ log, jobName: basename(file), stepName: "local log" });
    failures.push({
      kind: classification.kind,
      label: classification.label,
      file,
      excerpt: boundedExcerpt(log),
      evidence: classification.evidence,
    });
  }
  return {
    status: failures.some((f) => f.label === "confirmed") ? "failure" : "ok",
    collected: true,
    localLogs: files,
    failures,
    repro: null,
    excerpt: boundedExcerpt(
      failures
        .filter((f) => f.excerpt)
        .slice(0, 3)
        .map((f) => `[${f.kind}] ${f.excerpt}`)
        .join("\n"),
      40,
    ),
    kinds: [...new Set(failures.map((f) => f.kind))].sort(),
    truncated: anyTruncated,
  };
}

/**
 * Collect CI failure evidence. GitHub mode uses the official gh CLI against
 * the GitHub API; local mode scans a directory of logs from other CI systems.
 */
export async function collectFailures(input) {
  if (input.dir) return collectLocal(input.dir, input.runFn);
  return collectFromGithub(input.runRef, input.runFn ?? defaultRunFn);
}

export function printReport(report) {
  const lines = [`status=${report.status}`];
  if (!report.collected) {
    lines.push(`collected=false`);
    if (report.reason) lines.push(`reason=${redactEvidence(report.reason)}`);
  } else {
    lines.push("collected=true");
    if (report.url) lines.push(`url=${report.url}`);
    if (report.runId) lines.push(`runId=${report.runId}`);
    if (report.commitSha) lines.push(`commit=${report.commitSha}`);
    if (report.failedJobs?.length) lines.push(`failedJobs=${report.failedJobs.join(", ")}`);
    for (const failure of report.failures ?? []) {
      lines.push(`kind=${failure.kind} label=${failure.label}`);
      for (const evidence of failure.evidence?.slice(0, 4) ?? []) {
        lines.push(`  - ${evidence.testId ?? "(no test id)"}: ${(evidence.message ?? "").split(/\r?\n/)[0]}`);
        for (const stack of evidence.stackLines?.slice(0, 3) ?? []) lines.push(`    ${stack}`);
      }
    }
    if (report.kinds?.length) lines.push(`kinds=${report.kinds.join(", ")}`);
    if (report.repro) lines.push(`repro=${report.repro}`);
    if (report.excerpt) lines.push(`excerpt:\n${redactEvidence(report.excerpt)}`);
  }
  if (report.truncated !== undefined) lines.push(`truncated=${report.truncated}`);
  return lines.join("\n");
}

export default printReport;

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const runRef = args.includes("--run") ? args[args.indexOf("--run") + 1] : null;
  const dir = args.includes("--local") ? args[args.indexOf("--local") + 1] : null;
  if (!runRef && !dir) {
    console.error("Usage: node scripts/ci-failures.mjs --run <github-run-url> | --local <log-dir>");
    process.exit(2);
  }
  collectFailures({ runRef, dir })
    .then((report) => {
      console.log(printReport(report));
      process.exit(report.status === "error" ? 1 : 0);
    })
    .catch((error) => {
      console.error(`status=error\nreason=${error.message}`);
      process.exit(1);
    });
}
