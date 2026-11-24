// ISSUE-151: isolated client adapters, scoped registration and safe rewrites.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  ADAPTERS,
  inspectClient,
  registerClient,
  SUPPORTED_CLIENTS,
  unregisterClient,
} from "../scripts/clients.mjs";
import { collectDoctor } from "../scripts/installer/doctor.mjs";

const REPO = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "clients-"));
test.after(() => rmSync(work, { recursive: true, force: true }));

function ctx(name, scope = "global") {
  const home = join(work, name, "home");
  const project = join(work, name, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  return {
    home,
    project,
    scope,
    skillsSource: join(REPO, "skills"),
    command: "node",
    args: [join(REPO, "scripts", "run-mcp.sh")],
  };
}

test("OpenCode global JSONC keeps comments and unrelated servers", () => {
  const options = ctx("opencode-global");
  const path = ADAPTERS.opencode.config(options);
  mkdirSync(join(options.home, ".config", "opencode"), { recursive: true });
  const original = `// my config\n{\n  "mcpServers": {\n    "other": { "command": "echo" }\n  },\n  "theme": "dark"\n}\n`;
  writeFileSync(path, original);
  const result = registerClient("opencode", options);
  assert.equal(result.registered, true);
  assert.equal(result.restartRequired, true);
  const updated = readFileSync(path, "utf8");
  assert.match(updated, /\/\/ my config/);
  assert.match(updated, /"other"/);
  assert.match(updated, /"theme": "dark"/);
  assert.match(updated, /"android-mcp"/);
  assert.ok(existsSync(result.backupPath));
  registerClient("opencode", options);
  assert.equal(readFileSync(path, "utf8"), updated, "repeated registration is idempotent");
  unregisterClient("opencode", options);
  const removed = readFileSync(path, "utf8");
  assert.doesNotMatch(removed, /"android-mcp"/);
  assert.match(removed, /"other"/);
  assert.match(removed, /"theme": "dark"/);
});

test("project-local OpenCode registration never touches the global config", () => {
  const options = ctx("opencode-project", "project");
  const global = ctx("opencode-project", "global");
  const globalPath = ADAPTERS.opencode.config(global);
  mkdirSync(join(global.home, ".config", "opencode"), { recursive: true });
  writeFileSync(globalPath, '{"mcpServers":{}}\n');
  const before = readFileSync(globalPath, "utf8");
  registerClient("opencode", options);
  assert.equal(readFileSync(globalPath, "utf8"), before);
  assert.equal(inspectClient("opencode", options).registered, true);
  assert.equal(inspectClient("opencode", global).registered, false);
  assert.equal(existsSync(join(options.project, ".opencode", "skills", ".android-mcp-ownership")), true);
});

test("Claude and Cursor adapters preserve unrelated JSON entries", () => {
  for (const client of ["claude-code", "cursor"]) {
    const options = ctx(client, "user");
    const path = ADAPTERS[client].config(options);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ theme: "light", mcpServers: { keep: { command: "echo" } } }, null, 2)}\n`);
    registerClient(client, options);
    const data = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(data.theme, "light");
    assert.equal(data.mcpServers.keep.command, "echo");
    assert.ok(data.mcpServers["android-mcp"]);
    unregisterClient(client, options);
    const after = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(after.mcpServers.keep.command, "echo");
    assert.equal(after.mcpServers["android-mcp"], undefined);
  }
});

test("invalid JSON and unsupported scopes refuse mutation", () => {
  const options = ctx("invalid", "user");
  const path = ADAPTERS["claude-code"].config(options);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "{ broken");
  assert.throws(() => registerClient("claude-code", options), /invalid JSON/);
  assert.equal(readFileSync(path, "utf8"), "{ broken");
  assert.deepEqual(inspectClient("opencode", ctx("scope", "user")), {
    client: "opencode",
    scope: "user",
    supported: false,
    reason: "opencode has no user scope",
  });
});

test("stale paths are detected and doctor reports restart requirements", () => {
  const options = ctx("stale");
  registerClient("opencode", options);
  writeFileSync(
    ADAPTERS.opencode.config(options),
    `${JSON.stringify({ mcpServers: { "android-mcp": { command: "/gone/run-mcp.sh", args: [] } } })}\n`,
  );
  assert.equal(inspectClient("opencode", options).stale, true);
  const report = collectDoctor({
    root: REPO,
    env: { HOME: options.home, PATH: process.env.PATH ?? "" },
    platform: "linux",
  });
  assert.equal(report.registration.status, "drift");
  assert.equal(report.registration.restartRequired, true);
});

test("only tested adapters are advertised", () => {
  assert.deepEqual(SUPPORTED_CLIENTS, ["opencode", "claude-code", "cursor"]);
  for (const client of SUPPORTED_CLIENTS) assert.ok(ADAPTERS[client], `${client} has no adapter`);
});
