// Issue 76: durable, device-bound net_capture sessions. Stubbed adb, ps and
// mitmdump prove the state transitions: exact proxy restore, device binding,
// identity-guarded termination, startup rollback, persisted expiry recovery,
// and per-session serialization. Android's real proxy behavior is not proven
// here; the emulator integration test remains the verification gate.
import { strict as assert } from "node:assert";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const work = mkdtempSync(join(tmpdir(), "android-mcp-netcap-"));
const bin = join(work, "bin");
const stateDir = join(work, "state");
const statePath = join(stateDir, "net-capture.json");
mkdirSync(bin, { recursive: true });
mkdirSync(stateDir, { recursive: true, mode: 0o700 });

const env = {
  ANDROID_MCP_PIDFILE: statePath,
  ANDROID_MCP_STATE_DIR: stateDir,
  ANDROID_MCP_ROOT_WAIT_MS: "0",
  ANDROID_MCP_MITMDUMP: join(bin, "mitmdump"),
  ADB_RECORD: join(work, "adb-record.txt"),
  PROXY_FILE: join(work, "proxy-value.txt"),
  MITM_CMDLINE_FILE: join(work, "mitm-cmdline.txt"),
  MITM_PID_FILE: join(work, "mitm-pid.txt"),
  MITM_KILL_FILE: join(work, "mitm-kills.txt"),
  ADB_SERIAL: "emulator-5554",
};
for (const [key, value] of Object.entries(env)) process.env[key] = value;
process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;

const adbStub = String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$ADB_RECORD"
if [ "$1" = "get-serialno" ]; then printf '%s\n' "$ADB_SERIAL"; exit 0; fi
serial=""
if [ "$1" = "-s" ]; then serial="$2"; shift 2; fi
case "$1" in
  root) exit «ROOT_EXIT:-0» ;;
  remount) exit 1 ;;
  push) exit «PUSH_EXIT:-0» ;;
  shell)
    shift
    case "$1" in
      getprop)
        case "$2" in
          ro.build.type) printf 'userdebug\n' ;;
          ro.product.cpu.abi) printf 'x86_64\n' ;;
          *) printf '\n' ;;
        esac
        exit 0 ;;
      settings)
        case "$2" in
          get)
            if [ -f "$PROXY_FILE" ]; then cat "$PROXY_FILE"; else printf 'null\n'; fi
            exit 0 ;;
          put)
            value="$5"
            case "$value" in
              *"«FAIL_PROXY_SET_MATCH:-__never__»"*) exit "«FAIL_PROXY_SET_EXIT:-1»" ;;
            esac
            printf '%s' "$value" > "$PROXY_FILE"
            exit 0 ;;
          delete)
            rm -f "$PROXY_FILE"
            exit "«FAIL_PROXY_DELETE:-0»" ;;
        esac
        exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
`
  .replaceAll("«", "${")
  .replaceAll("»", "}");

const mitmStub = String.raw`#!/bin/sh
printf '%s %s\n' "$0" "$*" > "$MITM_CMDLINE_FILE"
printf '%s\n' "$$" > "$MITM_PID_FILE"
har=""
for arg in "$@"; do
  case "$arg" in
    hardump=*) har="«arg#hardump=»" ;;
  esac
done
on_term() {
  if [ -n "$har" ]; then printf 'har' > "$har"; fi
  printf '%s\n' "$$" >> "$MITM_KILL_FILE"
  exit 0
}
trap on_term TERM INT
while :; do sleep 1; done
`
  .replaceAll("«", "${")
  .replaceAll("»", "}");

const psStub = String.raw`#!/bin/sh
pid=""
field=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p) pid="$2"; shift 2 ;;
    -o) field="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$PS_FORCE_CMD" ]; then printf '%s\n' "$PS_FORCE_CMD"; exit 0; fi
if [ "$field" = "command=" ]; then
  cat "$MITM_CMDLINE_FILE" 2>/dev/null || printf 'unrelated-process\n'
elif [ "$field" = "lstart=" ]; then
  printf 'Sat Nov 14 00:00:00 2026\n'
fi
`
  .replaceAll("«", "${")
  .replaceAll("»", "}");

for (const [name, body] of [
  [join(bin, "adb"), adbStub],
  [join(bin, "mitmdump"), mitmStub],
  [join(bin, "ps"), psStub],
]) {
  writeFileSync(name, body);
  chmodSync(name, 0o755);
}

const { test, skip } = await import("node:test");
const posixTest = process.platform === "win32" ? (name, fn) => skip(name, fn) : test;

const { handleNetCapture, recoverCaptureSession } = await import("../dist/tools.js");

const adbCalls = () => {
  try {
    return readFileSync(env.ADB_RECORD, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const readState = () => {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
};
const readProxy = () => {
  try {
    return readFileSync(env.PROXY_FILE, "utf8");
  } catch {
    return null;
  }
};
const writeProxy = (value) => writeFileSync(env.PROXY_FILE, value);
const clearProxy = () => rmSync(env.PROXY_FILE, { force: true });
const clearCalls = () => rmSync(env.ADB_RECORD, { force: true });
const mitmPid = () => Number(readFileSync(env.MITM_PID_FILE, "utf8"));
const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const stopIfActive = async () => {
  const s = readState();
  if (!s) return;
  try {
    await handleNetCapture({ action: "stop" });
  } catch {
    /* best effort */
  }
  if (s.pid && processAlive(s.pid)) {
    try {
      process.kill(s.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
};

posixTest("net_capture durable session semantics (issue 76)", async () => {
  // --- Start on A with a pre-existing proxy; stop restores it exactly ---------
  await stopIfActive();
  clearCalls();
  writeProxy("127.0.0.1:8888");
  {
    const started = await handleNetCapture({
      action: "start",
      deviceId: "emulator-5554",
      port: 8080,
      durationSec: 30,
    });
    assert.match(started.content[0].text, /capture started/);
    const state = readState();
    assert.equal(state.version, 1);
    assert.ok(state.sessionId, "a unique session id is persisted");
    assert.equal(state.serial, "emulator-5554");
    assert.deepEqual(state.originalProxy, { kind: "set", value: "127.0.0.1:8888" });
    assert.equal(state.appliedProxy, "10.0.2.2:8080");
    assert.equal(state.port, 8080);
    assert.ok(state.har.endsWith(".har"));
    assert.ok(Date.parse(state.expiresAt) > Date.parse(state.startedAt));
    assert.equal(readProxy(), "10.0.2.2:8080");
    if (process.platform !== "win32") {
      assert.equal(statSync(statePath).mode & 0o777, 0o600, "state file is private");
      assert.equal(statSync(stateDir).mode & 0o777, 0o700, "state dir is private");
    }

    const stopped = await handleNetCapture({ action: "stop", deviceId: "emulator-5554" });
    assert.match(stopped.content[0].text, /capture stopped/);
    assert.equal(readProxy(), "127.0.0.1:8888", "the exact prior proxy is restored");
    assert.equal(readState(), null, "state is removed after a clean stop");
    assert.equal(processAlive(state.pid), false, "mitmdump exited");
  }

  // --- Stop with a different device is rejected without mutating anything -----
  await stopIfActive();
  clearCalls();
  writeProxy("127.0.0.1:8888");
  {
    await handleNetCapture({
      action: "start",
      deviceId: "emulator-5554",
      port: 8080,
      durationSec: 30,
    });
    const before = adbCalls().length;
    await assert.rejects(
      handleNetCapture({ action: "stop", deviceId: "emulator-5556" }),
      /emulator-5556.*emulator-5554|different device|refusing/i,
    );
    assert.equal(readProxy(), "10.0.2.2:8080", "device A keeps its capture proxy");
    assert.ok(readState(), "state is retained for the correct device");
    assert.deepEqual(adbCalls().slice(before), [], "a rejected stop makes no adb calls");
    await handleNetCapture({ action: "stop" });
    assert.equal(readProxy(), "127.0.0.1:8888");
  }

  // --- Start without deviceId persists the resolved serial --------------------
  await stopIfActive();
  clearCalls();
  clearProxy();
  {
    await handleNetCapture({ action: "start", port: 9090, durationSec: 30 });
    const state = readState();
    assert.equal(state.serial, "emulator-5554", "the resolved serial is persisted");
    assert.deepEqual(state.originalProxy, { kind: "unset" });
    assert.ok(adbCalls().some((l) => l === "get-serialno"));
    await handleNetCapture({ action: "stop" });
    assert.equal(readProxy(), null, "an unset proxy is restored by deleting it");
    assert.ok(
      adbCalls().some((l) => l.includes("settings delete global http_proxy")),
      "unset is not rewritten as :0",
    );
    assert.equal(readState(), null);
  }

  // --- Failed proxy set rolls back the child and the prior proxy --------------
  await stopIfActive();
  clearCalls();
  writeProxy("127.0.0.1:8888");
  process.env.FAIL_PROXY_SET_MATCH = "10.0.2.2";
  {
    await assert.rejects(
      handleNetCapture({
        action: "start",
        deviceId: "emulator-5554",
        port: 8080,
        durationSec: 30,
      }),
      /failed to set device HTTP proxy/,
    );
    assert.equal(readProxy(), "127.0.0.1:8888", "the prior proxy survives a failed start");
    assert.equal(readState(), null, "no state remains after rollback");
    const pid = Number(readFileSync(env.MITM_PID_FILE, "utf8"));
    assert.equal(processAlive(pid), false, "the new mitmdump was stopped");
  }
  delete process.env.FAIL_PROXY_SET_MATCH;

  // --- Failed restore keeps a recovery record with manual instructions --------
  await stopIfActive();
  clearCalls();
  writeProxy("127.0.0.1:8888");
  {
    await handleNetCapture({
      action: "start",
      deviceId: "emulator-5554",
      port: 8080,
      durationSec: 30,
    });
    process.env.FAIL_PROXY_SET_MATCH = "127.0.0.1:8888";
    const stopped = await handleNetCapture({ action: "stop" });
    const text = stopped.content[0].text;
    assert.match(text, /recovery-required|restore failed|manual/i);
    assert.match(text, /emulator-5554/);
    assert.match(
      text,
      /adb -s emulator-5554 shell settings put global http_proxy 127\.0\.0\.1:8888/,
    );
    assert.ok(readState(), "the only record of the old proxy is retained");
    assert.equal(readProxy(), "10.0.2.2:8080");
    delete process.env.FAIL_PROXY_SET_MATCH;
    await handleNetCapture({ action: "stop" });
    assert.equal(readProxy(), "127.0.0.1:8888");
    assert.equal(readState(), null);
  }

  // --- Persisted expiry drives recovery after an MCP restart ------------------
  await stopIfActive();
  clearCalls();
  writeProxy("127.0.0.1:8888");
  {
    await handleNetCapture({
      action: "start",
      deviceId: "emulator-5554",
      port: 8080,
      durationSec: 30,
    });
    const state = readState();
    state.expiresAt = new Date(Date.now() - 1000).toISOString();
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const recovered = await recoverCaptureSession();
    assert.equal(recovered.status, "stopped");
    assert.equal(readProxy(), "127.0.0.1:8888");
    assert.equal(readState(), null);
    assert.equal(processAlive(state.pid), false);
  }

  // --- A PID whose command identity does not match is never signalled ---------
  await stopIfActive();
  clearCalls();
  writeProxy("127.0.0.1:8888");
  {
    await handleNetCapture({
      action: "start",
      deviceId: "emulator-5554",
      port: 8080,
      durationSec: 30,
    });
    const state = readState();
    const { spawn } = await import("node:child_process");
    const decoy = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      state.pid = decoy.pid;
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
      process.env.PS_FORCE_CMD = "/usr/bin/sleep 30";
      const stopped = await handleNetCapture({ action: "stop" });
      assert.match(stopped.content[0].text, /not signall|identity|refus/i);
      assert.equal(processAlive(decoy.pid), true, "the unrelated process is untouched");
      assert.equal(readProxy(), "127.0.0.1:8888", "the session proxy is still restored");
      delete process.env.PS_FORCE_CMD;
    } finally {
      try {
        decoy.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
  }

  // --- Concurrent starts cannot overwrite the active session ------------------
  await stopIfActive();
  clearCalls();
  writeProxy("127.0.0.1:8888");
  {
    const results = await Promise.allSettled([
      handleNetCapture({ action: "start", deviceId: "emulator-5554", port: 8080, durationSec: 30 }),
      handleNetCapture({ action: "start", deviceId: "emulator-5554", port: 8081, durationSec: 30 }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.find((r) => r.status === "rejected");
    assert.match(String(rejected.reason), /net_capture busy/);
    const applied = adbCalls().filter((l) => l.includes("settings put global http_proxy 10.0.2.2"));
    assert.equal(applied.length, 1, "only one session applied a proxy");
    const state = readState();
    assert.ok(state);
    assert.ok([8080, 8081].includes(state.port));
    await handleNetCapture({ action: "stop" });
    assert.equal(readProxy(), "127.0.0.1:8888");
  }

  // --- A late timer from session A cannot stop session B ----------------------
  await stopIfActive();
  clearCalls();
  writeProxy("127.0.0.1:8888");
  {
    await handleNetCapture({
      action: "start",
      deviceId: "emulator-5554",
      port: 8080,
      durationSec: 1,
    });
    await handleNetCapture({ action: "stop" });
    await handleNetCapture({
      action: "start",
      deviceId: "emulator-5554",
      port: 8080,
      durationSec: 30,
    });
    const sessionB = readState();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    assert.ok(readState(), "session B is still active after session A's timer would fire");
    assert.equal(readState().sessionId, sessionB.sessionId);
    assert.equal(processAlive(sessionB.pid), true);
    await handleNetCapture({ action: "stop" });
  }

  rmSync(work, { recursive: true, force: true });
  console.log("net_capture session tests passed");
});
