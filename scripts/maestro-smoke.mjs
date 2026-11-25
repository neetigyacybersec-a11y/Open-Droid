#!/usr/bin/env node
// ISSUE-161: one bounded Maestro retry with both attempts visible. The core is
// injected so pass / retry-pass / retry-fail are testable without an emulator.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FLOW = "templates/compose-starter/maestro/smoke.yaml";

const MAX_CHARS = 8_000;
const clamp = (text) => String(text ?? "").slice(-MAX_CHARS);

/**
 * Run at most two attempts, record each result separately, and report a
 * retry-pass as flaky. Diagnostics are best-effort and never change the exit
 * code derived from the attempts.
 */
export function runFlow({
  argv,
  env = {},
  execute,
  now = Date.now,
  artifactsDir,
  collectDiagnostics = () => undefined,
  summaryPath,
  log = console.log,
}) {
  const attempts = [];
  for (let number = 1; number <= 2; number += 1) {
    const started = now();
    const result = execute(argv, env);
    const finished = now();
    attempts.push({
      number,
      code: result.status ?? 1,
      durationMs: Math.max(0, finished - started),
      stdout: clamp(result.stdout),
      stderr: clamp(result.stderr),
    });
    if (attempts[attempts.length - 1].code === 0) break;
  }

  const first = attempts[0];
  const last = attempts[attempts.length - 1];
  const failed = last.code !== 0;
  const flaky = !failed && first.code !== 0;

  mkdirSync(artifactsDir, { recursive: true });
  for (const attempt of attempts) {
    const text =
      `exit=${attempt.code}\ndurationMs=${attempt.durationMs}\n` +
      `--- stdout ---\n${attempt.stdout}\n--- stderr ---\n${attempt.stderr}\n`;
    writeFileSync(join(artifactsDir, `maestro-attempt-${attempt.number}.log`), text);
  }
  const metadata = {
    attempts: attempts.map(({ number, code, durationMs }) => ({ number, code, durationMs })),
    flaky,
    failed,
  };
  writeFileSync(join(artifactsDir, "maestro-attempts.json"), JSON.stringify(metadata, null, 2));

  const lines = [
    `maestro attempt 1: exit=${first.code} duration=${first.durationMs}ms`,
    ...(attempts[1]
      ? [`maestro attempt 2: exit=${last.code} duration=${last.durationMs}ms`]
      : []),
    failed
      ? "maestro: FAILED after retry"
      : flaky
        ? "maestro: FLAKY (first attempt failed, retry passed)"
        : "maestro: PASSED first attempt",
  ];
  const summary = lines.join("\n");
  if (summaryPath) appendFileSync(summaryPath, `### Maestro smoke\n${summary}\n`);
  if (failed || flaky) {
    try {
      collectDiagnostics(artifactsDir, attempts);
    } catch (error) {
      log(`maestro diagnostics unavailable: ${error instanceof Error ? error.message : error}`);
    }
  }
  log(summary);
  return { attempts, failed, flaky, exitCode: failed ? 1 : 0, summary };
}

/** Bounded logcat tails; written only for flaky or failed runs. */
function collectLogcat(artifactsDir) {
  for (const [name, args] of [
    ["events", ["logcat", "-d", "-b", "events"]],
    ["crash", ["logcat", "-d", "-b", "crash"]],
    ["testrunner", ["logcat", "-d"]],
  ]) {
    const result = spawnSync("adb", args, { encoding: "utf8", timeout: 30_000 });
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").slice(-80).join("\n");
    writeFileSync(join(artifactsDir, `logcat-${name}.txt`), text);
  }
}

function main() {
  const maestroBin = join(process.env.HOME ?? "", ".maestro", "bin");
  const env = {
    ...process.env,
    PATH: `${maestroBin}:${process.env.PATH ?? ""}`,
    // Parsed as milliseconds; a small value starves awaitLaunch (run 43162090162).
    MAESTRO_DRIVER_STARTUP_TIMEOUT: "180000",
  };
  const result = runFlow({
    // Upstream maestro #3684: pin a driver port below the device's ephemeral
    // range so the host-chosen port cannot collide on the device.
    argv: ["maestro", "test", "--driver-host-port", "7001", FLOW],
    env,
    execute: (argv, runEnv) => {
      const child = spawnSync(argv[0], argv.slice(1), {
        cwd: ROOT,
        env: runEnv,
        encoding: "utf8",
        timeout: 900_000,
      });
      return { status: child.status ?? 1, stdout: child.stdout, stderr: child.stderr };
    },
    artifactsDir: join(ROOT, "maestro-artifacts"),
    summaryPath: process.env.GITHUB_STEP_SUMMARY,
    collectDiagnostics: collectLogcat,
  });
  process.exit(result.exitCode);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
