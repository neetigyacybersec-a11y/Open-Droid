// Issue 77: frida-server ensure/reuse semantics. Stubbed adb + frida-ps prove
// that a healthy server is reused, provisioning only runs when needed, managed
// processes are killed by exact PID, unmanaged ones are never touched, and the
// per-serial lock serializes concurrent calls.
import { strict as assert } from "node:assert";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { ensureServer } = await import("../dist/frida.js");

const SERVER = "/data/local/tmp/frida-server";
const VERSION = "17.2.17";

function makeFixture() {
  const work = mkdtempSync(join(tmpdir(), "frida-server-"));
  const root = join(work, "repo");
  mkdirSync(join(root, ".toolchain", "frida"), { recursive: true });
  mkdirSync(join(root, ".toolchain", "python-venv", "bin"), { recursive: true });
  writeFileSync(
    join(root, ".toolchain", "frida", `frida-server-${VERSION}-android-x86_64`),
    "server-binary",
  );
  writeFileSync(join(root, "versions.env"), `FRIDA_VERSION=${VERSION}\n`);

  const bin = join(work, "bin");
  mkdirSync(bin, { recursive: true });
  const record = join(work, "record.txt");

  const adb = String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$RECORD"
if [ "$1" = "get-serialno" ]; then printf '%s\n' "$ADB_DEFAULT_SERIAL"; exit 0; fi
serial=""
if [ "$1" = "-s" ]; then serial="$2"; shift 2; fi
case "$1" in
  root) exit "«ROOT_FAIL:-0}" ;;
  push) exit "«PUSH_FAIL:-0}" ;;
  shell)
    shift
    case "$1" in
      getprop)
        case "$2" in
          ro.product.cpu.abi) printf 'x86_64\n' ;;
          ro.build.type) printf 'userdebug\n' ;;
          *) printf '\n' ;;
        esac
        exit 0 ;;
      pidof)
        if [ -n "$MARKER_DIR" ] && [ -f "$MARKER_DIR/$serial.started" ]; then
          printf '%s\n' "«SERVER_PID:-4242}"
        else
          printf '%s\n' "«SERVER_PID:-}"
        fi
        exit 0 ;;
      cat) printf '%s\n' "«PROC_CMDLINE:-$SERVER}" ; exit 0 ;;
      kill)
        printf 'kill:%s\n' "$2" >> "$KILL_RECORD"
        exit 0 ;;
      chmod) exit 0 ;;
      nohup*)
        printf '%s\n' "«NEW_PID:-5555}"
        [ -n "$MARKER_DIR" ] && : > "$MARKER_DIR/$serial.started"
        exit 0 ;;
      *frida-server*--version*)
        printf '%s\n' "«SERVER_VERSION:-$FRIDA_VERSION}"
        exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
`.replaceAll("«", "${");
  const fridaPs = String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$PS_RECORD"
serial=""
while [ $# -gt 0 ]; do
  case "$1" in
    -D) serial="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ "«PS_ALWAYS_FAIL:-0}" = "1" ]; then exit 1; fi
if [ -n "$MARKER_DIR" ] && [ -f "$MARKER_DIR/$serial.started" ]; then exit 0; fi
exit "«PS_EXIT:-0}"
`.replaceAll("«", "${");
  const frida = "#!/bin/sh\nexit 0\n";
  for (const [name, body] of [
    [join(bin, "adb"), adb],
    [join(bin, "frida-ps"), fridaPs],
    [join(root, ".toolchain", "python-venv", "bin", "frida"), frida],
    [join(root, ".toolchain", "python-venv", "bin", "frida-ps"), fridaPs],
  ]) {
    writeFileSync(name, body);
    chmodSync(name, 0o755);
  }
  return { work, root, bin, record, psRecord: join(work, "ps-record.txt") };
}

async function withFixture(env, fn) {
  const fixture = makeFixture();
  const oldPath = process.env.PATH;
  const previous = {};
  const values = {
    RECORD: fixture.record,
    PS_RECORD: fixture.psRecord,
    KILL_RECORD: join(fixture.work, "kills.txt"),
    MARKER_DIR: join(fixture.work, "markers"),
    ANDROID_MCP_ROOT_WAIT_MS: "0",
    PATH: `${fixture.bin}:${oldPath ?? ""}`,
    ...env,
  };
  mkdirSync(values.MARKER_DIR, { recursive: true });
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await fn(fixture);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.env.PATH = oldPath;
    rmSync(fixture.work, { recursive: true, force: true });
  }
}

const lines = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean);
const indexOf = (list, predicate) => list.findIndex(predicate);

// --- Healthy server: reuse without root/push/kill/start --------------------
await withFixture(
  {
    PS_EXIT: "0",
    SERVER_PID: "4242",
    PROC_CMDLINE: SERVER,
    SERVER_VERSION: VERSION,
  },
  async (fixture) => {
    const result = await ensureServer("emulator-5554", fixture.root);
    assert.equal(result.reused, true);
    assert.equal(result.serial, "emulator-5554");
    assert.equal(result.abi, "x86_64");
    assert.equal(result.version, VERSION);
    const calls = lines(fixture.record);
    assert.equal(
      indexOf(calls, (l) => l.includes(" root")),
      -1,
      "reuse must not run adb root",
    );
    assert.equal(
      indexOf(calls, (l) => l.includes(" push ")),
      -1,
      "reuse must not push the server",
    );
    assert.equal(
      indexOf(calls, (l) => l.includes("nohup")),
      -1,
      "reuse must not start a server",
    );
    assert.equal(
      indexOf(calls, (l) => l.includes("kill")),
      -1,
      "reuse must not kill anything",
    );
    assert.equal(
      indexOf(calls, (l) => l.includes("pkill") || l.includes("killall")),
      -1,
      "the ensure path must never use a broad process-name kill",
    );
  },
);

// --- Missing server: ordered provisioning ----------------------------------
await withFixture(
  {
    PS_EXIT: "1",
    SERVER_PID: "",
    SERVER_VERSION: VERSION,
  },
  async (fixture) => {
    const result = await ensureServer("emulator-5554", fixture.root);
    assert.equal(result.reused, false);
    assert.equal(result.serial, "emulator-5554");
    const calls = lines(fixture.record);
    const rootAt = indexOf(calls, (l) => l.endsWith("-s emulator-5554 root"));
    const pushAt = indexOf(calls, (l) => l.includes("-s emulator-5554 push "));
    const startAt = indexOf(calls, (l) => l.includes("nohup"));
    assert.ok(rootAt >= 0, "missing server must run adb root");
    assert.ok(pushAt > rootAt, "push must follow root");
    assert.ok(startAt > pushAt, "start must follow push");
    assert.equal(
      indexOf(calls, (l) => l.includes("pkill")),
      -1,
      "provisioning must not use pkill",
    );
    assert.ok(
      lines(fixture.psRecord).length >= 2,
      "readiness must be polled through frida-ps after starting",
    );
  },
);

// --- Version mismatch on a managed server: exact-PID replacement -----------
await withFixture(
  {
    PS_EXIT: "1",
    PS_ALWAYS_FAIL: "0",
    SERVER_PID: "4242",
    PROC_CMDLINE: SERVER,
    SERVER_VERSION: "16.0.0",
  },
  async (fixture) => {
    // The fixture's PS stub only succeeds when a marker exists; seed it so the
    // probe reports the old managed server as healthy before the version check.
    writeFileSync(join(process.env.MARKER_DIR, "emulator-5554.started"), "");
    const result = await ensureServer("emulator-5554", fixture.root);
    assert.equal(result.reused, false, "an incompatible version must be replaced");
    assert.equal(result.version, VERSION);
    const kills = lines(join(fixture.work, "kills.txt"));
    assert.deepEqual(kills, ["kill:4242"], "only the exact managed PID may be killed");
    assert.equal(
      lines(fixture.record).some((l) => l.includes("pkill")),
      false,
      "replacement must not use a broad process-name kill",
    );
  },
);

// --- Unresponsive unmanaged server: refuse, do not kill --------------------
await withFixture(
  {
    PS_EXIT: "1",
    SERVER_PID: "9999",
    PROC_CMDLINE: "/data/local/tmp/other-frida",
  },
  async (fixture) => {
    await assert.rejects(
      ensureServer("emulator-5554", fixture.root),
      /unmanaged|not owned|refusing/i,
    );
    assert.equal(
      lines(fixture.record).some((l) => l.includes("push") || l.includes("nohup")),
      false,
      "an unmanaged process must not be replaced",
    );
    assert.equal(existsSync(join(fixture.work, "kills.txt")), false);
  },
);

// --- Concurrent calls for the same serial provision once -------------------
await withFixture(
  {
    PS_EXIT: "1",
    SERVER_PID: "",
  },
  async (fixture) => {
    const [a, b] = await Promise.all([
      ensureServer("emulator-5554", fixture.root),
      ensureServer("emulator-5554", fixture.root),
    ]);
    assert.equal(a.serial, "emulator-5554");
    assert.equal(b.serial, "emulator-5554");
    const pushes = lines(fixture.record).filter((l) => l.includes("push "));
    assert.equal(pushes.length, 1, "the per-serial lock must allow one provisioning sequence");
    assert.equal([a.reused, b.reused].filter(Boolean).length, 1, "one call must reuse the server");
  },
);

// --- Different serials provision independently -----------------------------
await withFixture(
  {
    PS_EXIT: "1",
    SERVER_PID: "",
  },
  async (fixture) => {
    const [a, b] = await Promise.all([
      ensureServer("emulator-5554", fixture.root),
      ensureServer("emulator-5556", fixture.root),
    ]);
    assert.equal(a.serial, "emulator-5554");
    assert.equal(b.serial, "emulator-5556");
    const calls = lines(fixture.record);
    assert.ok(calls.some((l) => l.includes("-s emulator-5554 push ")));
    assert.ok(calls.some((l) => l.includes("-s emulator-5556 push ")));
    assert.equal(a.reused, false);
    assert.equal(b.reused, false);
  },
);

console.log("frida server ensure/reuse tests passed");
