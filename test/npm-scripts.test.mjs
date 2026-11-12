// Issue 70: `npm test` must build dist before running compiled-output tests,
// so that `npm ci && npm test` works from a clean checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

test("test script builds dist before running compiled-output tests", () => {
  const pkg = JSON.parse(readFileSync(`${REPO}package.json`, "utf8"));
  const testScript = pkg.scripts?.test;
  const pretest = pkg.scripts?.pretest;
  const builds = [pretest, testScript].filter(Boolean).some((s) =>
    /(^|\s|&&|&&\s)npx?\s+run\s+build\b|npm\s+run\s+build\b/.test(s),
  );
  assert.ok(
    builds,
    'expected a "pretest" or "test" script that runs "npm run build" first',
  );
});
