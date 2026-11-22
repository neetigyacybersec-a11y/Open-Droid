// ISSUE-58: grounded, drafts-only release notes from a Git ref range.
// Every item carries a source commit reference. No file is written, nothing is
// published, and unsupported claims (fixes from a subject alone, translated
// copy, waveform-style proof) are reported as needing review instead.
import { run } from "./services/process-runner.js";
import { errorMessage } from "./util.js";

export type ReleaseNotesAudience = "play" | "qa" | "engineering";

export interface ReleaseNotesInput {
  projectPath: string;
  baseRef: string;
  headRef?: string;
  issueRefs?: string[];
  audience?: ReleaseNotesAudience;
  locales?: string[];
  maxLength?: number;
}

export interface CommitRecord {
  sha: string;
  subject: string;
  body: string;
  files: string[];
}

export type CommitKind = "feature" | "fix" | "refactor" | "revert" | "unknown";
export type CommitEvidence = "body" | "refs" | "diff" | "subject-only";

export interface CommitClassification {
  kind: CommitKind;
  evidence: CommitEvidence;
  claimable: boolean;
  reason?: string;
}

export interface NoteItem {
  text: string;
  refs: string[];
  reason?: string;
}

export interface NoteGroups {
  additions: NoteItem[];
  fixes: NoteItem[];
  engineering: NoteItem[];
  breaking: NoteItem[];
  unclassified: NoteItem[];
}

export interface ReleaseNotesReport {
  status: "ok" | "error";
  range: string;
  audience: ReleaseNotesAudience;
  locales: { locale: string; status: "draft-en" | "needs-translation" }[];
  maxLength: number | null;
  commitCount: number;
  groups: NoteGroups;
  reviewChecklist: string[];
  truncated: boolean;
  omittedItems: number;
  reason?: string;
}

const MAX_COMMITS = 500;
const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED]"],
  [/\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/g, "https://[REDACTED]@"],
  [/\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, "[REDACTED]"],
  [/\b[A-Za-z0-9-]+\.(?:internal|corp|lan|local)\b/gi, "[REDACTED-HOST]"],
  [/\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[REDACTED-HOST]"],
  [/\b192\.168\.\d{1,3}\.\d{1,3}\b/g, "[REDACTED-HOST]"],
  [/\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g, "[REDACTED-HOST]"],
];

/** Remove secrets and internal endpoints before any text reaches a draft. */
export function redactSensitive(text: string): string {
  let safe = text;
  for (const [pattern, replacement] of REDACTIONS) safe = safe.replace(pattern, replacement);
  return safe;
}

/**
 * Classify one commit. A conventional prefix suggests a kind, but a fix or
 * feature claim is only actionable when a body, linked reference or diff is
 * present — the subject alone is never proof.
 */
export function classifyCommit(
  commit: CommitRecord,
  linkedRefs: readonly string[] = [],
): CommitClassification {
  const subject = commit.subject.trim();
  const body = (commit.body ?? "").trim();
  const lower = subject.toLowerCase();
  let kind: CommitKind = "unknown";
  if (/^revert\b/.test(lower)) kind = "revert";
  else if (/^(?:feat|feature)(?:\([^)]*\))?!?:/.test(lower)) kind = "feature";
  else if (/^(?:fix|bugfix)(?:\([^)]*\))?!?:/.test(lower)) kind = "fix";
  else if (/^(?:refactor|chore|docs|test|build|ci|style|perf)(?:\([^)]*\))?!?:/.test(lower))
    kind = "refactor";

  const evidence: CommitEvidence = body
    ? "body"
    : linkedRefs.length > 0
      ? "refs"
      : commit.files.length > 0
        ? "diff"
        : "subject-only";
  const needsEvidence = kind === "fix" || kind === "feature";
  const claimable = !(needsEvidence && evidence === "subject-only");
  return {
    kind,
    evidence,
    claimable,
    ...(claimable
      ? {}
      : {
          reason:
            "Subject alone cannot prove a user-visible fix or feature; needs body, linked ref or diff",
        }),
  };
}

function describe(subject: string): string {
  const clean = subject.trim();
  const match = clean.match(/^[a-z]+(?:\([^)]*\))?!?:\s*(.+)$/i);
  return (match?.[1] ?? clean).trim();
}

function matchedRefs(commit: CommitRecord, input: ReleaseNotesInput): string[] {
  const short = commit.sha.slice(0, 7);
  const haystack = `${commit.subject}\n${commit.body ?? ""}`;
  const linked = (input.issueRefs ?? []).filter((ref) => ref && haystack.includes(ref));
  return [short, ...linked];
}

function makeItem(commit: CommitRecord, input: ReleaseNotesInput, reason?: string): NoteItem {
  return {
    text: redactSensitive(describe(commit.subject)),
    refs: matchedRefs(commit, input),
    ...(reason ? { reason: redactSensitive(reason) } : {}),
  };
}

function localize(locales: readonly string[]): ReleaseNotesReport["locales"] {
  return locales.map((locale) => ({
    locale,
    status: /^en(?:[-_]|$)/i.test(locale) ? "draft-en" : "needs-translation",
  }));
}

function checklist(input: ReleaseNotesInput, report: ReleaseNotesReport): string[] {
  const lines = [
    "- [ ] Confirm every draft item links to a commit or PR reference",
    "- [ ] Verify no secrets, tokens or internal hostnames remain in the draft",
  ];
  if (report.commitCount === 0)
    lines.push("- [ ] Empty range: confirm base and head refs are correct");
  if (report.groups.unclassified.length > 0)
    lines.push(
      `- [ ] Review ${report.groups.unclassified.length} unclassified commit(s) before publishing`,
    );
  if (report.groups.breaking.length > 0)
    lines.push("- [ ] Confirm breaking changes and migration steps for reverted commits");
  if (report.truncated)
    lines.push(
      `- [ ] ${report.omittedItems} item(s) omitted to meet maxLength; review before publishing`,
    );
  for (const locale of report.locales) {
    if (locale.status === "needs-translation")
      lines.push(
        `- [ ] Translate notes for ${locale.locale} before publishing (draft is English only)`,
      );
  }
  if (input.issueRefs?.length)
    lines.push("- [ ] Confirm supplied issue/PR references match the selected ref range");
  return lines;
}

function limitAdditions(
  items: NoteItem[],
  maxLength: number | null,
): [NoteItem[], boolean, number] {
  if (maxLength === null) return [items, false, 0];
  const kept: NoteItem[] = [];
  let used = 0;
  for (const item of items) {
    const line = `- ${item.text} [${item.refs.join(", ")}]\n`.length;
    if (used + line > maxLength) return [kept, true, items.length - kept.length];
    kept.push(item);
    used += line;
  }
  return [kept, false, 0];
}

function groupKey(classification: CommitClassification): keyof NoteGroups {
  if (!classification.claimable) return "unclassified";
  switch (classification.kind) {
    case "feature":
      return "additions";
    case "fix":
      return "fixes";
    case "refactor":
      return "engineering";
    case "revert":
      return "breaking";
    default:
      return "unclassified";
  }
}

/** Build a deterministic report from commit records. Pure: no git, no I/O. */
export function buildReleaseNotes(
  input: ReleaseNotesInput,
  commits: readonly CommitRecord[],
): ReleaseNotesReport {
  const groups: NoteGroups = {
    additions: [],
    fixes: [],
    engineering: [],
    breaking: [],
    unclassified: [],
  };
  for (const commit of commits) {
    const classification = classifyCommit(commit, input.issueRefs ?? []);
    const item = makeItem(commit, input, classification.reason);
    const key = groupKey(classification);
    if (key === "unclassified" && !item.reason) item.reason = "Conventional kind is unknown";
    if (key === "breaking") item.text = `Reverted: ${item.text}`;
    groups[key].push(item);
  }

  const [additions, truncated, omittedItems] = limitAdditions(
    groups.additions,
    input.maxLength ?? null,
  );
  const report: ReleaseNotesReport = {
    status: "ok",
    range: `${input.baseRef}..${input.headRef ?? "HEAD"}`,
    audience: input.audience ?? "play",
    locales: localize(input.locales ?? ["en-US"]),
    maxLength: input.maxLength ?? null,
    commitCount: commits.length,
    groups: { ...groups, additions },
    reviewChecklist: [],
    truncated,
    omittedItems,
  };
  report.reviewChecklist = checklist(input, report);
  return report;
}

function section(title: string, items: readonly NoteItem[], always = false): string[] {
  if (items.length === 0 && !always) return [];
  const lines = [`## ${title}`, ""];
  for (const item of items) {
    lines.push(`- ${item.text} [${item.refs.join(", ")}]`);
    if (item.reason) lines.push(`  - needs review: ${item.reason}`);
  }
  lines.push("");
  return lines;
}

/** Render a bounded, audience-filtered draft. Never publishes or writes files. */
export function renderReleaseNotes(report: ReleaseNotesReport): string {
  if (report.status === "error") return `status=error\nreason=${report.reason ?? "unknown error"}`;
  const lines = [
    "status=ok",
    `range=${report.range}`,
    `commits=${report.commitCount}`,
    `audience=${report.audience}`,
    `locales=${report.locales.map((l) => `${l.locale}:${l.status}`).join(",")}`,
    `maxLength=${report.maxLength ?? "none"}`,
    `truncated=${report.truncated}`,
    `omittedItems=${report.omittedItems}`,
    "",
  ];
  if (report.commitCount === 0) lines.push("No commits in the selected range.", "");
  lines.push(...section("User-facing", report.groups.additions, true));
  lines.push(...section("Fixes and known limitations", report.groups.fixes, true));
  lines.push(...section("Breaking changes / migration", report.groups.breaking, true));
  if (report.audience === "engineering")
    lines.push(...section("Engineering", report.groups.engineering));
  if (report.groups.unclassified.length > 0)
    lines.push(...section("Needs maintainer review", report.groups.unclassified));
  lines.push("## Review checklist", "", ...report.reviewChecklist, "");
  return lines.join("\n");
}

function errorReport(input: ReleaseNotesInput, reason: string): ReleaseNotesReport {
  const empty: NoteGroups = {
    additions: [],
    fixes: [],
    engineering: [],
    breaking: [],
    unclassified: [],
  };
  return {
    status: "error",
    range: `${input.baseRef}..${input.headRef ?? "HEAD"}`,
    audience: input.audience ?? "play",
    locales: localize(input.locales ?? ["en-US"]),
    maxLength: input.maxLength ?? null,
    commitCount: 0,
    groups: empty,
    reviewChecklist: [],
    truncated: false,
    omittedItems: 0,
    reason: redactSensitive(reason),
  };
}

function validRef(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/^~-]*$/.test(ref);
}

async function assertWorkTree(projectPath: string): Promise<void> {
  const inside = await run("git", ["-C", projectPath, "rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") throw new Error("not a Git work tree");
}

async function assertRefs(projectPath: string, base: string, head: string): Promise<void> {
  for (const ref of [base, head]) {
    if (!validRef(ref)) throw new Error(`invalid git ref: ${ref}`);
    const check = await run("git", ["-C", projectPath, "rev-parse", "--verify", ref]);
    if (check.code !== 0) throw new Error(`git ref not found: ${ref}`);
  }
}

async function readFiles(projectPath: string, shaValue: string): Promise<string[]> {
  const show = await run("git", [
    "-C",
    projectPath,
    "show",
    "--pretty=format:",
    "--name-only",
    "--no-renames",
    shaValue,
  ]);
  return show.code === 0 ? show.stdout.split(/\r?\n/).filter(Boolean) : [];
}

async function collectCommits(projectPath: string, stdout: string): Promise<CommitRecord[]> {
  const fields = stdout.split("\0");
  const records: CommitRecord[] = [];
  for (let i = 0; i + 2 < fields.length && records.length < MAX_COMMITS; i += 3) {
    const shaValue = fields[i].trim();
    if (!/^[0-9a-f]{40}$/.test(shaValue)) continue;
    records.push({
      sha: shaValue,
      subject: fields[i + 1].trim(),
      body: fields[i + 2].trim(),
      files: await readFiles(projectPath, shaValue),
    });
  }
  return records;
}

async function readCommits(input: ReleaseNotesInput): Promise<CommitRecord[]> {
  const base = input.baseRef;
  const head = input.headRef ?? "HEAD";
  await assertWorkTree(input.projectPath);
  await assertRefs(input.projectPath, base, head);
  const log = await run("git", [
    "-C",
    input.projectPath,
    "log",
    `--format=%H%x00%s%x00%b%x00`,
    `${base}..${head}`,
  ]);
  if (log.code !== 0) throw new Error(log.stderr || "git log failed");
  return collectCommits(input.projectPath, log.stdout);
}

/** Read-only generator. Uses argv-array git commands through the approved runner. */
export async function generateReleaseNotes(input: ReleaseNotesInput): Promise<ReleaseNotesReport> {
  try {
    const commits = await readCommits(input);
    return buildReleaseNotes(input, commits);
  } catch (error) {
    return errorReport(input, errorMessage(error));
  }
}
