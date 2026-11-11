// FR-S1 / BACKLOG §3.8: the vendored motion-designer skill is integrated INTO
// android-compose-ui-ux (hub) instead of being added as a new top-level skill.
// The total top-level skill count must not change, and the motion trigger
// vocabulary must live in the hub's description so OpenCode surfaces it
// implicitly whenever motion work appears.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const SKILLS = path.join(REPO, 'skills');
const hub = path.join(SKILLS, 'android-compose-ui-ux');
const hubSkill = readFileSync(path.join(hub, 'SKILL.md'), 'utf8');
const hubDescription = hubSkill.match(/^description:\s*(.+)$/m)?.[1] ?? '';

const motionRefs = [
  'timing-and-easing.md',
  'compose-motion.md',
  'view-system-motion.md',
  'micro-interactions-catalog.md',
  'performance-and-accessibility.md',
  'review-checklist.md',
];

test('top-level skill count is unchanged by the motion integration', () => {
  const dirs = readdirSync(SKILLS).filter((d) => existsSync(path.join(SKILLS, d, 'SKILL.md')));
  assert.equal(dirs.length, 30, `expected 30 skills, found ${dirs.length}: ${dirs.join(', ')}`);
  assert.ok(!existsSync(path.join(SKILLS, 'motion-designer')), 'motion-designer must NOT be a top-level skill');
});

test('motion deep layer lives under the android-compose-ui-ux hub', () => {
  for (const ref of motionRefs) {
    assert.ok(existsSync(path.join(hub, 'references', 'motion', ref)), `missing references/motion/${ref}`);
  }
  assert.ok(existsSync(path.join(hub, 'references', 'motion', 'MotionTokens.kt')), 'MotionTokens.kt template must ship');
  assert.ok(existsSync(path.join(hub, 'references', 'motion', 'evals.json')), 'motion evals must ship');
});

test('hub SKILL.md carries the motion operating system', () => {
  assert.match(hubSkill, /Motion design system \(deep layer\)/);
  for (const phrase of ['Tokens only', 'interruption', 'reduced motion', 'micro-interaction', 'review-checklist']) {
    assert.match(hubSkill.toLowerCase(), new RegExp(phrase.toLowerCase()), `hub must mention "${phrase}"`);
  }
});

test('hub description carries the motion trigger vocabulary (implicit invocation)', () => {
  for (const trigger of [
    'animations', 'transitions', 'spring', 'MotionLayout', 'micro-interaction',
    'bottom sheet', 'press feedback', 'sluggish', 'skeleton', 'predictive back',
    'shared element', 'motion design',
  ]) {
    assert.match(hubDescription, new RegExp(trigger, 'i'), `description must trigger on "${trigger}"`);
  }
});

test('adjacent skills route motion concerns to the hub', () => {
  for (const [skill, phrase] of [
    ['design-tokens', 'motion'],
    ['android-performance', 'motion'],
    ['android-accessibility', 'reduced motion|motion'],
    ['design-critique', 'motion'],
    ['wcag-audit', 'motion'],
  ]) {
    const text = readFileSync(path.join(SKILLS, skill, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(phrase, 'i'), `${skill} must route motion concerns`);
    assert.match(text, /android-compose-ui-ux/, `${skill} must point at the motion hub`);
  }
});
