// ISSUE #37 slice 1: source-project AndroidManifest.xml security audit.
// Fixtures are checked-in mini-projects under test/fixtures/manifest-audit/;
// the module is dependency-free logic (no MCP registration — that is slice 3).
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auditProjectManifest } from "../dist/manifestAudit.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "manifest-audit");
const MANIFEST = "app/src/main/AndroidManifest.xml";
const NOT_ASSESSED_IDS = [
  "webview-settings",
  "pendingintent-mutability",
  "logging",
  "signing-config",
];

function findingsFor(result, check) {
  return result.findings.filter((f) => f.check === check);
}

test("exported activity without permission is a confirmed high finding", async () => {
  const result = await auditProjectManifest({ projectPath: join(FIXTURES, "risky") });
  const hits = findingsFor(result, "exported-component-no-permission");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, "high");
  assert.equal(hits[0].classification, "confirmed");
  assert.equal(hits[0].file, MANIFEST);
  assert.match(hits[0].evidence, /exported="true"/);
  assert.match(hits[0].evidence, /MainActivity/);
  assert.ok(hits[0].rationale.length > 0);
  assert.ok(hits[0].remediation.length > 0);
});

test("exported provider with grantUriPermissions and no permission is critical", async () => {
  const result = await auditProjectManifest({ projectPath: join(FIXTURES, "risky") });
  const hits = findingsFor(result, "exported-provider-no-permission");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, "critical");
  assert.equal(hits[0].classification, "confirmed");
  assert.match(hits[0].evidence, /grantUriPermissions="true"/);
  assert.match(hits[0].evidence, /ExportedProvider/);
});

test("allowBackup=true is flagged; a manifest without the attribute gets the default-true info finding", async () => {
  const risky = await auditProjectManifest({ projectPath: join(FIXTURES, "risky") });
  const explicit = findingsFor(risky, "allow-backup");
  assert.equal(explicit.length, 1);
  assert.equal(explicit[0].severity, "medium");
  assert.equal(explicit[0].classification, "confirmed");
  assert.match(explicit[0].evidence, /allowBackup="true"/);

  const defaults = await auditProjectManifest({ projectPath: join(FIXTURES, "defaults") });
  const implicit = findingsFor(defaults, "allow-backup");
  assert.equal(implicit.length, 1);
  assert.equal(implicit[0].severity, "info");
  assert.match(implicit[0].rationale, /default/i);
  assert.match(implicit[0].remediation, /dataExtractionRules|data extraction rules/i);
});

test("cleartext traffic is high and missing networkSecurityConfig is medium", async () => {
  const result = await auditProjectManifest({ projectPath: join(FIXTURES, "risky") });
  const cleartext = findingsFor(result, "cleartext-traffic");
  assert.equal(cleartext.length, 1);
  assert.equal(cleartext[0].severity, "high");
  assert.equal(cleartext[0].classification, "confirmed");
  assert.match(cleartext[0].evidence, /usesCleartextTraffic="true"/);

  const nsc = findingsFor(result, "network-security-config");
  assert.equal(nsc.length, 1);
  assert.equal(nsc[0].severity, "medium");
  assert.match(nsc[0].remediation, /networkSecurityConfig/i);
});

test("debuggable=true in the main manifest is a confirmed high finding", async () => {
  const result = await auditProjectManifest({ projectPath: join(FIXTURES, "risky") });
  const hits = findingsFor(result, "debuggable");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, "high");
  assert.equal(hits[0].classification, "confirmed");
  assert.match(hits[0].evidence, /debuggable="true"/);
  assert.match(hits[0].rationale, /debug variant|build variant/i);
});

test("testOnly=true is an info-level finding", async () => {
  const result = await auditProjectManifest({ projectPath: join(FIXTURES, "risky") });
  const hits = findingsFor(result, "test-only");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, "info");
  assert.match(hits[0].evidence, /testOnly="true"/);
});

test("custom scheme deep links are heuristic medium; https without autoVerify is flagged too", async () => {
  const result = await auditProjectManifest({ projectPath: join(FIXTURES, "risky") });
  const custom = findingsFor(result, "deep-link-custom-scheme");
  assert.ok(custom.length >= 1);
  assert.equal(custom[0].classification, "heuristic");
  assert.equal(custom[0].severity, "medium");
  assert.match(custom[0].evidence, /myapp/);

  const autoVerify = findingsFor(result, "deep-link-autoverify");
  assert.equal(autoVerify.length, 1);
  assert.equal(autoVerify[0].classification, "heuristic");
  assert.equal(autoVerify[0].severity, "medium");
  assert.match(autoVerify[0].evidence, /https/);
});

test("dangerous permissions produce info-level inventory entries", async () => {
  const result = await auditProjectManifest({ projectPath: join(FIXTURES, "risky") });
  const hits = findingsFor(result, "dangerous-permissions");
  assert.ok(hits.some((f) => /RECORD_AUDIO/.test(f.evidence)));
  assert.equal(hits[0].severity, "info");
  assert.equal(hits[0].classification, "confirmed");
  assert.match(hits[0].remediation, /justify|drop/i);
});

test("security baseline moves a matching finding to accepted with its rationale", async () => {
  const result = await auditProjectManifest({ projectPath: join(FIXTURES, "baseline") });
  assert.equal(findingsFor(result, "exported-component-no-permission").length, 0);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].check, "exported-component-no-permission");
  assert.match(result.accepted[0].acceptedRationale, /launcher entry/i);
  // unrelated findings are unaffected
  assert.ok(findingsFor(result, "dangerous-permissions").length > 0);
});

test("clean manifest reports zero findings, passed check ids, and the deferred not-assessed set", async () => {
  const result = await auditProjectManifest({ projectPath: join(FIXTURES, "clean") });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.accepted, []);
  for (const id of [
    "exported-component-no-permission",
    "exported-provider-no-permission",
    "allow-backup",
    "cleartext-traffic",
    "network-security-config",
    "debuggable",
    "test-only",
    "deep-link-custom-scheme",
    "deep-link-autoverify",
    "dangerous-permissions",
  ]) {
    assert.ok(result.passed.includes(id), `passed must contain ${id}`);
  }
  for (const id of NOT_ASSESSED_IDS) {
    assert.ok(result.notAssessed.includes(id), `notAssessed must contain ${id}`);
  }
  assert.ok(result.scannedAt.length > 0);
  assert.ok(result.manifestPath.replaceAll("\\", "/").endsWith(MANIFEST));
});

test("a project without a manifest throws a clear error", async () => {
  const empty = await mkdtemp(join(tmpdir(), "manifest-audit-empty-"));
  try {
    await assert.rejects(
      () => auditProjectManifest({ projectPath: empty }),
      (error) => error instanceof Error && /AndroidManifest\.xml/.test(error.message),
    );
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});
