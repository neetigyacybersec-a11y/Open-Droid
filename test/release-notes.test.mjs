// ISSUE-58: release notes grounded in a real Git ref range, drafted only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../dist/services/process-runner.js";
import {
  buildReleaseNotes,
  classifyCommit,
  generateReleaseNotes,
  redactSensitive,
  renderReleaseNotes,
} from "../dist/releaseNotes.js";
import { TOOL_REGISTRY } from "../dist/registry.js";
import { ToolSchemas } from "../dist/tools.js";

const sha = (c) => c.repeat(40);
const commit = (overrides) => ({
  sha: sha("a"),
  subject: "feat(save): add offline notes",
  body: "Notes are saved locally and retried when the network returns.",
  files: ["src/save.ts"],
  ...overrides,
});

const baseInput = {
  projectPath: process.cwd(),
  baseRef: "v1.0.0",
  headRef: "HEAD",
  audience: "play",
  locales: ["en-US"],
};

test("commit classification distinguishes feature, fix, refactor, revert and unknown", () => {
  assert.equal(classifyCommit(commit()).kind, "feature");
  assert.equal(classifyCommit(commit({ subject: "fix(save): stop duplicate writes", sha: sha("b") })).kind, "fix");
  assert.equal(classifyCommit(commit({ subject: "refactor(store): split repository", sha: sha("c") })).kind, "refactor");
  assert.equal(classifyCommit(commit({ subject: 'Revert "feat(save): add offline notes"', sha: sha("d") })).kind, "revert");
  assert.equal(classifyCommit(commit({ subject: "tidy imports", sha: sha("e") })).kind, "unknown");

  const subjectOnlyFix = classifyCommit(
    commit({ subject: "fix: crash", body: "", files: [], sha: sha("f") }),
  );
  assert.equal(subjectOnlyFix.kind, "fix");
  assert.equal(subjectOnlyFix.evidence, "subject-only");
  assert.equal(subjectOnlyFix.claimable, false, "a subject alone cannot prove a fix");
});

test("secret, token, internal hostname and private address redaction", () => {
  const raw = [
    "token=ghp_abcdefghijklmnopqrstuvwxyz123456",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturevalue123",
    "internal host build.corp.internal and 10.1.2.3 plus 192.168.0.9",
    "deploy from https://user:pass@ci.example.invalid/repo",
  ].join("\n");
  const safe = redactSensitive(raw);
  assert.doesNotMatch(safe, /ghp_[A-Za-z0-9]+/);
  assert.doesNotMatch(safe, /eyJ[A-Za-z0-9_.-]+/);
  assert.doesNotMatch(safe, /corp\.internal/);
  assert.doesNotMatch(safe, /10\.1\.2\.3|192\.168\.0\.9/);
  assert.doesNotMatch(safe, /user:pass@/);
  assert.match(safe, /\[REDACTED/);
});

test("issue references are redacted like item text before rendering", () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const report = buildReleaseNotes(
    { ...baseInput, issueRefs: [secret] },
    [commit({ body: `linked ${secret}` })],
  );
  const draft = renderReleaseNotes(report);
  assert.doesNotMatch(draft, /ghp_[A-Za-z0-9]+/);
  assert.match(draft, /\[REDACTED/);
});

test("release notes group commits and every item links to its source commit", () => {
  const report = buildReleaseNotes(baseInput, [
    commit({ sha: sha("a"), subject: "feat(save): add offline notes" }),
    commit({ sha: sha("b"), subject: "fix(save): stop duplicate writes" }),
    commit({ sha: sha("c"), subject: "refactor(store): split repository" }),
    commit({ sha: sha("d"), subject: 'Revert "feat(save): add offline notes"' }),
    commit({ sha: sha("e"), subject: "tidy imports", body: "", files: [] }),
  ]);
  assert.equal(report.commitCount, 5);
  assert.equal(report.groups.additions.length, 1);
  assert.equal(report.groups.fixes.length, 1);
  assert.equal(report.groups.engineering.length, 1);
  assert.equal(report.groups.breaking.length, 1);
  assert.equal(report.groups.unclassified.length, 1);
  for (const group of Object.values(report.groups)) {
    for (const item of group) {
      assert.ok(item.refs.length > 0, "every generated item needs a source reference");
      assert.match(item.refs[0], /^[0-9a-f]{7,40}$/);
    }
  }
  assert.match(report.groups.additions[0].text, /offline notes/);
  assert.match(report.groups.unclassified[0].text, /tidy imports/);
});

test("subject-only fix is flagged for review, never stated as fixed", () => {
  const report = buildReleaseNotes(baseInput, [
    commit({ sha: sha("f"), subject: "fix: crash", body: "", files: [] }),
  ]);
  assert.equal(report.groups.fixes.length, 0);
  assert.equal(report.groups.unclassified.length, 1);
  assert.match(report.groups.unclassified[0].reason, /evidence|linked/i);
  const text = renderReleaseNotes(report);
  assert.doesNotMatch(text, /\bfixed\b/i);
  assert.match(text, /Needs maintainer review/);
});

test("empty ref range is reported explicitly, not filled with guesses", () => {
  const report = buildReleaseNotes(baseInput, []);
  assert.equal(report.commitCount, 0);
  for (const group of Object.values(report.groups)) assert.equal(group.length, 0);
  assert.match(renderReleaseNotes(report), /no commits|commitCount=0/i);
  assert.ok(report.reviewChecklist.some((line) => /empty range/i.test(line)));
});

test("audience filters internal engineering notes from user-facing output", () => {
  const commits = [
    commit({ sha: sha("a") }),
    commit({ sha: sha("c"), subject: "refactor(store): split repository" }),
  ];
  const play = renderReleaseNotes(buildReleaseNotes({ ...baseInput, audience: "play" }, commits));
  const qa = renderReleaseNotes(buildReleaseNotes({ ...baseInput, audience: "qa" }, commits));
  const engineering = renderReleaseNotes(
    buildReleaseNotes({ ...baseInput, audience: "engineering" }, commits),
  );
  assert.match(play, /## User-facing/);
  assert.doesNotMatch(play, /## Engineering/);
  assert.match(qa, /## Fixes and known limitations/);
  assert.doesNotMatch(qa, /## Engineering/);
  assert.match(engineering, /## Engineering/);
  assert.match(engineering, /## Review checklist/);
});

test("maxLength truncates whole items and reports omissions", () => {
  const commits = Array.from({ length: 5 }, (_, i) =>
    commit({ sha: sha(String(i + 1)[0]), subject: `feat: add numbered feature ${i + 1}` }),
  );
  const report = buildReleaseNotes(
    { ...baseInput, maxLength: 90, audience: "engineering" },
    commits,
  );
  assert.equal(report.truncated, true);
  assert.ok(report.omittedItems > 0);
  assert.ok(report.groups.additions.length < commits.length);
  assert.match(renderReleaseNotes(report), /omittedItems=[1-9]/);
});

test("locale list records translation debt instead of claiming translation", () => {
  const report = buildReleaseNotes(
    { ...baseInput, locales: ["en-US", "fr-FR"] },
    [commit()],
  );
  assert.deepEqual(report.locales, [
    { locale: "en-US", status: "draft-en" },
    { locale: "fr-FR", status: "needs-translation" },
  ]);
  const text = renderReleaseNotes(report);
  assert.match(text, /locales=en-US:draft-en,fr-FR:needs-translation/);
  assert.match(text, /Translate.*fr-FR/i);
});

test("generated report redacts sensitive text before rendering", () => {
  const report = buildReleaseNotes(baseInput, [
    commit({
      subject: "feat(auth): add login",
      body: "Uses token=ghp_abcdefghijklmnopqrstuvwxyz123456 for the demo service.",
    }),
  ]);
  assert.doesNotMatch(renderReleaseNotes(report), /ghp_[A-Za-z0-9]+/);
});

test("generateReleaseNotes reads a real ref range without modifying the repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "od-relnotes-"));
  try {
    const git = (args) => run("git", ["-C", dir, ...args]);
    assert.equal((await git(["init", "-q"])).code, 0);
    assert.equal((await git(["config", "user.email", "test@example.invalid"])).code, 0);
    assert.equal((await git(["config", "user.name", "Test"])).code, 0);
    writeFileSync(join(dir, "base.txt"), "base\n");
    assert.equal((await git(["add", "base.txt"])).code, 0);
    assert.equal((await git(["commit", "-q", "-m", "chore: base"])).code, 0);
    assert.equal((await git(["tag", "v1.0.0"])).code, 0);
    writeFileSync(join(dir, "feature.txt"), "feature\n");
    assert.equal((await git(["add", "feature.txt"])).code, 0);
    assert.equal(
      (await git(["commit", "-q", "-m", "feat(save): add offline notes\n\nSaves locally with retry."])).code,
      0,
    );

    const before = (await git(["status", "--porcelain"])).stdout;
    const report = await generateReleaseNotes({ ...baseInput, projectPath: dir });
    const after = (await git(["status", "--porcelain"])).stdout;
    assert.equal(after, before, "release notes must not modify project files");
    assert.equal(report.commitCount, 1);
    assert.equal(report.groups.additions.length, 1);
    assert.match(report.groups.additions[0].refs[0], /^[0-9a-f]{7,40}$/);
    assert.match(renderReleaseNotes(report), /## User-facing/);

    const missing = await generateReleaseNotes({
      ...baseInput,
      projectPath: join(dir, "does-not-exist"),
    });
    assert.equal(missing.status, "error");
    assert.ok(missing.reason, "a bad project path must report a reason");
    assert.ok(!existsSync(join(dir, "RELEASE_NOTES.md")), "no artifact written by default");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry registers a read-only drafts-only release notes tool", () => {
  const entry = TOOL_REGISTRY.find((tool) => tool.name === "android_release_notes_generate");
  assert.ok(entry, "android_release_notes_generate must be registered");
  assert.equal(entry.risk, "read-only");
  assert.equal(entry.approval, "none");
  assert.equal(entry.unattended, true);
  assert.equal(entry.source, "mcp");
  assert.ok(entry.sideEffects.includes("host-read"));
  assert.ok(!entry.sideEffects.includes("host-write"));
  assert.ok(entry.tests.includes("test/release-notes.test.mjs"));
  assert.match(entry.description, /draft|git/i);

  const schema = ToolSchemas.releaseNotesGenerate;
  assert.equal(schema.safeParse(baseInput).success, true);
  assert.equal(schema.safeParse({ baseRef: "v1" }).success, false, "baseRef is required");
  assert.equal(schema.safeParse({ ...baseInput, audience: "youtube" }).success, false);
  assert.equal(schema.safeParse({ ...baseInput, maxLength: -1 }).success, false);
});
