// ISSUE-111: interaction evidence for motion, haptics and optional sound,
// reusing the capture archive/baselines rather than adding a second store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { TOOL_NAMES } from "../dist/registry.js";

const REPO = path.resolve(import.meta.dirname, "..");
const SKILLS = path.join(REPO, "skills");
const HUB = path.join(SKILLS, "android-compose-ui-ux");
const EVIDENCE = path.join(HUB, "references", "interaction-evidence");
const hubSkill = readFileSync(path.join(HUB, "SKILL.md"), "utf8");
const skillText = (name) => readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf8");

const evidenceRefs = [
  "evidence-record.md",
  "deterministic-scenarios.md",
  "verification-discipline.md",
];
const readEvidence = (name) =>
  existsSync(path.join(EVIDENCE, name)) ? readFileSync(path.join(EVIDENCE, name), "utf8") : "";

test("interaction evidence adds no top-level skill or MCP tool", () => {
  const dirs = readdirSync(SKILLS).filter((d) => existsSync(path.join(SKILLS, d, "SKILL.md")));
  assert.equal(dirs.length, 30, `expected 30 skills, found ${dirs.length}`);
  assert.equal(TOOL_NAMES.length, 70, "no new MCP tool");
  assert.ok(
    !TOOL_NAMES.some((name) => /evidence|waveform|audio/i.test(name)),
    "no audio/evidence MCP tool",
  );
});

test("interaction evidence references exist and are linked from the hub", () => {
  for (const ref of evidenceRefs) {
    const file = path.join(EVIDENCE, ref);
    assert.ok(existsSync(file), `missing references/interaction-evidence/${ref}`);
    assert.ok(statSync(file).size > 300, `${ref} is too thin to be useful`);
    assert.match(hubSkill, new RegExp(`references/interaction-evidence/${ref.replace(".", "\\.")}`));
  }
});

test("evidence record schema captures environment, artifacts and feedback policies", () => {
  const text = readEvidence("evidence-record.md");
  for (const field of [
    "package",
    "variant",
    "commit",
    "deviceId",
    "apiLevel",
    "resolution",
    "density",
    "flow",
    "actions",
    "recording",
    "screenshot",
    "baseline",
    "reducedMotion",
    "audioPreference",
    "hapticPreference",
    "motionChecks",
    "soundPolicy",
    "cueIds",
    "hapticPolicy",
    "eventIds",
    "defects",
    "severity",
    "timestamp",
    "frame",
    "skipped",
  ]) {
    assert.ok(text.includes(field), `evidence schema must carry ${field}`);
  }
  for (const status of ["verified", "failed", "skipped", "unavailable", "not-applicable"]) {
    assert.match(text, new RegExp(status), `status vocabulary needs ${status}`);
  }
  assert.match(text, /screenshot_baseline|baselines/i, "must reference the existing baseline store");
});

test("deterministic scenarios cover interruption, rapid input and feedback settings", () => {
  const text = readEvidence("deterministic-scenarios.md");
  for (const scenario of [
    /double tap|rapid/i,
    /cancel|retarget/i,
    /predictive back|forward\/back/i,
    /sheet/i,
    /loading (success|failure)|success\/failure/i,
    /reduced motion/i,
    /sound preference/i,
    /lifecycle|background\/resume/i,
  ]) {
    assert.match(text, scenario, `missing scenario: ${scenario}`);
  }
  assert.match(text, /state transition/i, "test state transitions, not exact audio output");
  assert.match(text, /loopback|audio hardware/i, "device audio capability must be detected/reported");
});

test("verification discipline separates evidence types and refuses false claims", () => {
  const text = readEvidence("verification-discipline.md");
  for (const kind of ["visual", "motion", "haptic", "audio"]) {
    assert.match(text, new RegExp(kind, "i"), `must distinguish ${kind} evidence`);
  }
  assert.match(text, /build pass|does not prove|do not claim/i);
  assert.match(text, /waveform/i, "must address the missing automated waveform claim");
  assert.match(text, /unavailable/i);
  assert.match(text, /not (a )?second baseline store|reuse/i);
});

test("hub definition of done includes feedback policy and the evidence record", () => {
  assert.match(hubSkill, /full-motion pass/i);
  assert.match(hubSkill, /interaction evidence|evidence record/i);
  assert.match(hubSkill, /audio\/haptic policy|sound\/haptic policy/i);
  const checklist = readFileSync(
    path.join(HUB, "references", "motion", "review-checklist.md"),
    "utf8",
  );
  for (const phrase of [
    /single haptic/i,
    /scrolling|continuous/i,
    /recomposition/i,
    /system (haptic|feedback) settings|user\/system/i,
  ]) {
    assert.match(checklist, phrase, `motion checklist needs haptic check: ${phrase}`);
  }
});

test("adjacent skills inspect motion and conditional feedback, never claim audio proof", () => {
  const critique = skillText("design-critique");
  assert.match(critique, /motion/i);
  assert.match(critique, /haptic/i);
  assert.match(critique, /only when|when present/i);

  const a11y = skillText("android-accessibility");
  assert.match(a11y, /non-audio|visual feedback|semantic/i);
  assert.match(a11y, /haptic|user control/i);
  assert.match(a11y, /android-compose-ui-ux/);

  const start = skillText("start-here");
  assert.match(start, /evidence/i);
  assert.match(start, /android-compose-ui-ux/);
});
