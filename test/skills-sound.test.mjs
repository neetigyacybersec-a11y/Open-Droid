// ISSUE-110: sound design lives inside the existing android-compose-ui-ux hub.
// No second top-level skill, MCP tool, or third-party audio asset is added.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { TOOL_NAMES } from "../dist/registry.js";

const REPO = path.resolve(import.meta.dirname, "..");
const SKILLS = path.join(REPO, "skills");
const HUB = path.join(SKILLS, "android-compose-ui-ux");
const SOUND = path.join(HUB, "references", "sound");
const hubSkill = readFileSync(path.join(HUB, "SKILL.md"), "utf8");
const description = hubSkill.match(/^description:\s*(.+)$/m)?.[1] ?? "";

const soundRefs = [
  "sound-design-system.md",
  "sound-tokens.md",
  "android-audio-implementation.md",
  "sound-accessibility-and-settings.md",
  "sound-review-checklist.md",
  "sound-catalog-template.md",
];

const readSound = (name) => readFileSync(path.join(SOUND, name), "utf8");
const soundText = () =>
  soundRefs
    .filter((name) => existsSync(path.join(SOUND, name)))
    .map((name) => readSound(name))
    .join("\n");

test("sound design does not add a skill or an MCP tool", () => {
  const dirs = readdirSync(SKILLS).filter((d) => existsSync(path.join(SKILLS, d, "SKILL.md")));
  assert.equal(dirs.length, 30, `expected 30 skills, found ${dirs.length}`);
  assert.ok(!existsSync(path.join(SKILLS, "sound-design")), "no top-level sound skill");
  assert.equal(TOOL_NAMES.length, 71, "registry count changed deliberately");
  assert.ok(!TOOL_NAMES.some((name) => /sound|audio|sfx/i.test(name)), "no audio MCP tool");
});

test("sound reference subtree is complete and linked from the hub", () => {
  for (const ref of soundRefs) {
    const file = path.join(SOUND, ref);
    assert.ok(existsSync(file), `missing references/sound/${ref}`);
    assert.ok(statSync(file).size > 200, `references/sound/${ref} is too thin to be useful`);
    assert.match(hubSkill, new RegExp(`references/sound/${ref.replace(".", "\\.")}`));
  }
  assert.match(hubSkill, /Sound design system \(deep layer\)/);
});

test("hub description triggers implicitly for sound work", () => {
  for (const trigger of ["sound", "audio", "SFX", "sound effect", "confirmation"]) {
    assert.match(description, new RegExp(trigger, "i"), `description must trigger on "${trigger}"`);
  }
});

test("sound system defaults to silence and uses a four-way decision matrix", () => {
  const system = existsSync(path.join(SOUND, "sound-design-system.md"))
    ? readSound("sound-design-system.md")
    : "";
  assert.match(system, /default to silence|defaults to silence/i);
  for (const option of ["Sound", "Haptic", "Both", "Neither"]) {
    assert.match(system, new RegExp(`\\b${option}\\b`, "i"), `decision matrix must include ${option}`);
  }
  assert.match(system, /recomposition|frame callback/i, "sound must never follow recomposition");
  assert.match(system, /restraint|frequency/i);
});

test("native Android implementation guidance keeps advanced audio non-default", () => {
  const impl = existsSync(path.join(SOUND, "android-audio-implementation.md"))
    ? readSound("android-audio-implementation.md")
    : "";
  assert.match(impl, /SoundPool/);
  assert.match(impl, /preload/i, "SFX must be decoded before the interaction path");
  assert.match(impl, /Oboe/i);
  assert.match(impl, /not (the )?default|non-default|only when/i, "Oboe is explicitly non-default");
  assert.match(impl, /MediaPlayer|Media3/i);
  assert.match(impl, /lifecycle|release/i);
  assert.match(impl, /third-party|dependency/i);
});

test("sound guidance covers user control, accessibility and provenance", () => {
  const text = soundText();
  assert.match(text, /mute|preference/i, "a persistent user preference is required");
  assert.match(text, /silent|DND|audio focus/i, "system audio behavior is documented");
  assert.match(text, /not the only|never.*only.*(carrier|feedback)|visual/i, "audio is not the only feedback path");
  assert.match(text, /license|provenance|attribution/i, "vendored audio needs provenance metadata");
  const catalog = existsSync(path.join(SOUND, "sound-catalog-template.md"))
    ? readSound("sound-catalog-template.md")
    : "";
  assert.match(catalog, /source|license/i);
});

test("sound timing is reviewed against the visual state transition", () => {
  const review = existsSync(path.join(SOUND, "sound-review-checklist.md"))
    ? readSound("sound-review-checklist.md")
    : "";
  assert.match(review, /state (change|completion|transition)/i);
  assert.match(review, /haptic/i);
  assert.match(review, /duplicate|overlap|stack/i);
  const motionChecklist = readFileSync(
    path.join(HUB, "references", "motion", "review-checklist.md"),
    "utf8",
  );
  assert.match(motionChecklist, /sound/i, "motion review checklist must carry a sound item");
  const micro = readFileSync(
    path.join(HUB, "references", "motion", "micro-interactions-catalog.md"),
    "utf8",
  );
  assert.match(micro, /sound/i, "micro-interaction catalog must cross-reference sound");
});

test("adjacent skills route sound concerns to the hub conditionally", () => {
  const critique = readFileSync(path.join(SKILLS, "design-critique", "SKILL.md"), "utf8");
  assert.match(critique, /sound|audio/i);
  assert.match(critique, /only (when|if)/i, "audio review is conditional on the feature having sound");
  assert.match(critique, /android-compose-ui-ux/);

  const a11y = readFileSync(path.join(SKILLS, "android-accessibility", "SKILL.md"), "utf8");
  assert.match(a11y, /sound|audio/i);
  assert.match(a11y, /android-compose-ui-ux/);

  const start = readFileSync(path.join(SKILLS, "start-here", "SKILL.md"), "utf8");
  assert.match(start, /interaction/i);
  assert.match(start, /android-compose-ui-ux/);
});

test("no audio binary assets are vendored by this change", () => {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(file) : [file];
    });
  const audio = walk(HUB).filter((file) => /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(file));
  assert.deepEqual(audio, [], "audio assets require a verified redistribution right");
});
