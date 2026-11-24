// ISSUE-151: client registration is explicit, scoped and reversible. Only
// adapters with fixture tests are advertised in SUPPORTED_CLIENTS.
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SUPPORTED_CLIENTS = ["opencode", "claude-code", "cursor"];
const ENTRY = "android-mcp";

export const ADAPTERS = {
  opencode: {
    label: "OpenCode",
    scopes: ["global", "project"],
    config: (ctx) =>
      ctx.scope === "project"
        ? join(ctx.project, ".opencode", "opencode.jsonc")
        : join(ctx.home, ".config", "opencode", "opencode.jsonc"),
    skills: (ctx) =>
      ctx.scope === "project"
        ? join(ctx.project, ".opencode", "skills")
        : join(ctx.home, ".config", "opencode", "skills"),
    jsonc: true,
  },
  "claude-code": {
    label: "Claude Code",
    scopes: ["user"],
    config: (ctx) => join(ctx.home, ".claude.json"),
    skills: (ctx) => join(ctx.home, ".claude", "skills"),
    jsonc: false,
  },
  cursor: {
    label: "Cursor",
    scopes: ["user"],
    config: (ctx) => join(ctx.home, ".cursor", "mcp.json"),
    skills: (ctx) => join(ctx.home, ".cursor", "rules"),
    jsonc: false,
  },
};

function defaultContext(overrides = {}) {
  const home = overrides.home ?? join(process.env.HOME ?? "/tmp", "");
  return {
    home,
    project: overrides.project ?? process.cwd(),
    scope: overrides.scope ?? "global",
    command: overrides.command ?? "node",
    args: overrides.args ?? ["scripts/run-mcp.sh"],
    skillsSource:
      overrides.skillsSource ?? join(fileURLToPath(new URL("..", import.meta.url)), "skills"),
  };
}

function readConfig(path) {
  if (!existsSync(path)) return { text: "", data: {} };
  const text = readFileSync(path, "utf8");
  try {
    return { text, data: JSON.parse(text) };
  } catch {
    return { text, data: null };
  }
}

function hasEntry(text, data) {
  if (data?.mcpServers?.[ENTRY]) return true;
  return new RegExp(`(["']?${ENTRY}["']?\\s*:)`, "m").test(text);
}

/** Insert or replace only our own entry, preserving unrelated text/comments. */
function upsertJsonc(text, entry) {
  const serialized = `    "${ENTRY}": ${JSON.stringify(entry)}`;
  const existing = new RegExp(`^\\s*"${ENTRY}"\\s*:\\s*\\{[\\s\\S]*?\\},?\\s*$`, "m");
  if (existing.test(text)) {
    return text.replace(existing, `${serialized},`);
  }
  const servers = /("mcpServers"\s*:\s*\{)/;
  if (servers.test(text)) return text.replace(servers, `$1\n${serialized},`);
  if (/^\s*\{/m.test(text)) {
    return text.replace(/^(\s*\{)/m, `$1\n  "mcpServers": {\n${serialized}\n  },`);
  }
  return `{\n  "mcpServers": {\n${serialized}\n  }\n}\n`;
}

function upsertJson(data, entry) {
  const next = { ...(data ?? {}) };
  next.mcpServers = { ...(next.mcpServers ?? {}), [ENTRY]: entry };
  return `${JSON.stringify(next, null, 2)}\n`;
}

function removeJsonc(text) {
  return text
    .replace(new RegExp(`^\\s*"${ENTRY}"\\s*:\\s*\\{[\\s\\S]*?\\},?\\s*$`, "m"), "")
    .replace(/,\s*$/m, "");
}

function removeJson(data) {
  const next = { ...(data ?? {}) };
  next.mcpServers = { ...(next.mcpServers ?? {}) };
  delete next.mcpServers[ENTRY];
  return `${JSON.stringify(next, null, 2)}\n`;
}

export function inspectClient(client, overrides = {}) {
  if (!SUPPORTED_CLIENTS.includes(client)) throw new Error(`unsupported client: ${client}`);
  const ctx = defaultContext(overrides);
  const adapter = ADAPTERS[client];
  if (!adapter.scopes.includes(ctx.scope)) {
    return { client, scope: ctx.scope, supported: false, reason: `${client} has no ${ctx.scope} scope` };
  }
  const path = adapter.config(ctx);
  const { text, data } = readConfig(path);
  const registered = hasEntry(text, data);
  const commandValue = data?.mcpServers?.[ENTRY]?.command ?? null;
  const stale =
    registered &&
    typeof commandValue === "string" &&
    !existsSync(resolve(ctx.project, commandValue)) &&
    !commandValue.includes("npx");
  return {
    client,
    scope: ctx.scope,
    supported: true,
    path,
    registered,
    stale,
    skillsPath: adapter.skills(ctx),
    restartRequired: registered,
  };
}

function backup(path) {
  if (!existsSync(path)) return null;
  const target = `${path}.android-mcp-backup`;
  copyFileSync(path, target);
  return target;
}

function syncSkills(ctx, skillsPath) {
  if (!existsSync(ctx.skillsSource)) return 0;
  mkdirSync(skillsPath, { recursive: true });
  let count = 0;
  for (const name of readdirSync(ctx.skillsSource)) {
    const source = join(ctx.skillsSource, name);
    if (!existsSync(join(source, "SKILL.md"))) continue;
    const target = join(skillsPath, name);
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true });
    count += 1;
  }
  writeFileSync(join(skillsPath, ".android-mcp-ownership"), `${count}\n`);
  return count;
}
/** Idempotent register/refresh. Returns a diff-ready result, never a silent skip. */
export function registerClient(client, overrides = {}) {
  const status = inspectClient(client, overrides);
  if (!status.supported) return { ...status, changed: false };
  const ctx = defaultContext(overrides);
  const adapter = ADAPTERS[client];
  const path = adapter.config(ctx);
  const { text, data } = readConfig(path);
  if (data === null && adapter.jsonc === false) {
    throw new Error(`refusing to rewrite ${path}: invalid JSON (preserve it manually)`);
  }
  const entry = { type: "stdio", command: ctx.command, args: ctx.args };
  const updated = adapter.jsonc
    ? upsertJsonc(text, entry)
    : upsertJson(data, entry);
  mkdirSync(dirname(path), { recursive: true });
  const backupPath = backup(path);
  writeFileSync(path, updated);
  const skills = syncSkills(ctx, adapter.skills(ctx));
  const after = inspectClient(client, overrides);
  return { ...after, changed: true, backupPath, skills, restartRequired: true };
}

export function unregisterClient(client, overrides = {}) {
  const status = inspectClient(client, overrides);
  if (!status.supported || !status.registered) return { ...status, changed: false };
  const ctx = defaultContext(overrides);
  const adapter = ADAPTERS[client];
  const path = adapter.config(ctx);
  const { text, data } = readConfig(path);
  const updated = adapter.jsonc ? removeJsonc(text) : removeJson(data);
  const backupPath = backup(path);
  writeFileSync(path, updated);
  return { ...inspectClient(client, overrides), changed: true, backupPath, restartRequired: true };
}
