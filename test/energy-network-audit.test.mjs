// ISSUE-57: package-scoped energy/battery/network audit via device dumps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditEnergyNetwork } from "../dist/energyNetworkAudit.js";
import { TOOL_REGISTRY } from "../dist/registry.js";
import { ToolSchemas } from "../dist/tools.js";

const PKG = "com.example.notes";

function fakeRunner(routes) {
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    const joined = args.join(" ");
    const entries = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
    for (const [needle, out] of entries) {
      if (joined.includes(needle)) return { code: 0, stdout: out, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unknown command: ${cmd} ${joined}` };
  };
  return { runner, calls };
}

test("battery and jobs parse from dumps output; sections report availability", async () => {
  const { runner, calls } = fakeRunner({
    "dumpsys battery": `level: 92\nstatus: Unplugged\nplugged: 0\nhealth: good\n`,
    [`dumpsys jobstats ${PKG}`]: `Jobstats ${PKG}: run-count=5, time=120ms\n`,
  });
  const report = await auditEnergyNetwork({ packageName: PKG, runner });
  assert.equal(report.packageName, PKG);
  assert.equal(report.battery.available, true);
  assert.equal(report.battery.level, 92);
  assert.equal(report.battery.charging, false);
  assert.equal(report.battery.health, "good");
  assert.equal(report.jobs.available, true, "jobstats available when stdout mentions the package");
  assert.ok(report.jobs.items.some((l) => l.includes(PKG)));
  assert.equal(calls[0].cmd, "adb", "adb used");
  assert.ok(calls.some((c) => c.args.includes("shell") && c.args.includes("dumpsys")));
});

test("alarms and wake locks are included where dumps power exposes them", async () => {
  const { runner } = fakeRunner({
    [`dumpsys jobstats ${PKG}`]: `pkg=${PKG} user@corp.internal 0 errors=10\n`,
    "dumpsys power": "Power Manager State: WAKE_LOCK held by android.net.wifi.pqvw",
    "dumpsys netstats": "rx_bytes=1024 tx_bytes=512\n",
  });
  const report = await auditEnergyNetwork({ packageName: PKG, runner });
  assert.ok(report.alarms.available === false, "no alarm lines matched here (availability is reported, not guessed)");
  assert.ok(report.wakeLocks.available);
  assert.ok(report.wakeLocks.items.some((l) => l.includes("WAKE_LOCK")));
  assert.equal(report.network.packageScoped, false, "netstats is interface-level");
  assert.equal(report.network.available, true);
});

test("unavailable metrics are marked, not guessed", async () => {
  const { runner } = fakeRunner({});
  const report = await auditEnergyNetwork({ packageName: PKG, runner });
  assert.equal(report.status, "ok");
  assert.equal(report.jobs.available, false);
  assert.equal(report.wakeLocks.available, false);
  assert.ok(report.summary.length > 0);
});

test("secrets and PII are redacted in report sections", async () => {
  const { runner } = fakeRunner({
    "dumpsys battery": "token=ghp_abcdefghijklmnopqrstuvwxyz12\nlevel: 1\n",
    [`dumpsys jobstats ${PKG}`]: `pkg=${PKG} password=supersecret1234567890 alarm-session id=123`,
  });
  const report = await auditEnergyNetwork({ packageName: PKG, runner });
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /ghp_[A-Za-z0-9]+/);
  assert.doesNotMatch(text, /supersecret1234567890/);
  assert.doesNotMatch(text, /corp\.internal/);
});

test("invalid package names are rejected before any device call", async () => {
  const report = await auditEnergyNetwork({
    packageName: "not a package",
    runner: async () => {
      throw new Error("must not call");
    },
  });
  assert.equal(report.status, "error");
  assert.ok(report.reason);
});

test("report is deterministic across runs", async () => {
  const { runner } = fakeRunner({
    "dumpsys battery": "level: 92\nplugged: 0\n",
  });
  const a = await auditEnergyNetwork({ packageName: PKG, runner });
  const b = await auditEnergyNetwork({ packageName: PKG, runner });
  assert.deepEqual(a, b);
});

test("registry registers android_energy_network_audit as read-only device tool", () => {
  const entry = TOOL_REGISTRY.find((t) => t.name === "android_energy_network_audit");
  assert.ok(entry, "android_energy_network_audit is registered");
  assert.equal(entry.risk, "read-only");
  assert.equal(entry.approval, "none");
  assert.equal(entry.unattended, true);
  assert.ok(entry.tests.includes("test/energy-network-audit.test.mjs"));
  const schema = ToolSchemas.energyNetworkAudit;
  assert.ok(schema.safeParse({ packageName: PKG }).success);
  assert.ok(!schema.safeParse({}).success, "packageName required");
  assert.ok(!schema.safeParse({ packageName: "not-a-pkg" }).success, "package name format enforced");
});
