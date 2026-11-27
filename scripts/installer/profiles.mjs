// ISSUE-148: one machine-readable description of what a Core, Full or Custom
// install means. The same catalog drives the install plan, doctor, export and
// uninstall; no capability is implicit.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const MANIFEST_SCHEMA = 1;

/** Tiny parser for the shell-style KEY=VALUE pins shared with Docker. */
export function readPins(root) {
  const text = readFileSync(join(root, "versions.env"), "utf8");
  const pins = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) pins[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return pins;
}

const github = (owner, repo, tag, asset) =>
  `https://github.com/${owner}/${repo}/releases/download/${tag}/${asset}`;

/** Catalog entries: kind=existing reuses a compatible host tool, others are managed. */
export function componentCatalog(pins) {
  return {
    node: {
      label: "Node.js",
      kind: "existing",
      min: pins.NODE_MAJOR ?? "20",
      probe: "node --version",
    },
    java: {
      label: "Java JDK",
      kind: "jdk",
      min: pins.JAVA_MAJOR ?? "21",
      probe: "java -version",
      path: ".toolchain/jdk",
    },
    "android-sdk": {
      label: "Android SDK + build-tools",
      kind: "sdk",
      path: ".toolchain/android-sdk",
      cmdlineToolsVersion: pins.CMDLINE_TOOLS_VERSION,
      platform: pins.ANDROID_PLATFORM,
      buildTools: pins.ANDROID_BUILD_TOOLS,
    },
    mcp: {
      label: "MCP server (dist + node_modules)",
      kind: "builtin",
      // ISSUE-176: own the whole runtime, not just the entrypoint, so a
      // generation can restore node_modules and every compiled module.
      paths: ["dist", "node_modules"],
    },
    gradle: {
      label: "Gradle",
      kind: "download",
      version: pins.GRADLE_VERSION,
      sha256: pins.GRADLE_SHA256,
      url: `https://services.gradle.org/distributions/gradle-${pins.GRADLE_VERSION}-bin.zip`,
      path: ".toolchain/gradle",
      archive: "zip",
      strip: 1,
    },
    jadx: {
      label: "JADX",
      kind: "download",
      version: pins.JADX_VERSION,
      sha256: pins.JADX_SHA256,
      url: github("skylot", "jadx", `v${pins.JADX_VERSION}`, `jadx-${pins.JADX_VERSION}.zip`),
      path: ".toolchain/jadx",
      archive: "zip",
      strip: 0,
    },
    apktool: {
      label: "apktool",
      kind: "download",
      version: pins.APKTOOL_VERSION,
      sha256: pins.APKTOOL_SHA256,
      url: github(
        "iBotPeaches",
        "Apktool",
        `v${pins.APKTOOL_VERSION}`,
        `apktool_${pins.APKTOOL_VERSION}.jar`,
      ),
      path: ".toolchain/apktool/apktool.jar",
      archive: "copy",
    },
    compose_preview: {
      label: "Compose Preview CLI",
      kind: "download",
      version: pins.COMPOSE_PREVIEW_VERSION,
      sha256: pins.COMPOSE_PREVIEW_SHA256,
      url: github(
        "yschimke",
        "compose-ai-tools",
        `v${pins.COMPOSE_PREVIEW_VERSION}`,
        `compose-preview-${pins.COMPOSE_PREVIEW_VERSION}.tar.gz`,
      ),
      path: ".toolchain/compose-preview",
      archive: "tar",
      strip: 0,
    },
    maestro: {
      label: "Maestro CLI",
      kind: "download",
      version: pins.MAESTRO_VERSION,
      sha256: pins.MAESTRO_SHA256,
      url: github("mobile-dev-inc", "maestro", pins.MAESTRO_VERSION, "maestro.zip"),
      path: ".toolchain/maestro",
      archive: "zip",
      strip: 0,
    },
    frida: {
      label: "Frida + mitmproxy (Python venv)",
      kind: "venv",
      version: `${pins.FRIDA_VERSION}/${pins.FRIDA_TOOLS_VERSION}/${pins.MITMPROXY_VERSION}`,
      path: ".toolchain/python-venv",
      packages: [
        `frida==${pins.FRIDA_VERSION}`,
        `frida-tools==${pins.FRIDA_TOOLS_VERSION}`,
        `mitmproxy==${pins.MITMPROXY_VERSION}`,
      ],
    },
    frida_server: {
      label: "frida-server (android x86_64 + arm64)",
      kind: "download-set",
      version: pins.FRIDA_VERSION,
      path: ".toolchain/frida",
      assets: ["x86_64", "arm64"].map((abi) => ({
        abi,
        url: github(
          "frida",
          "frida",
          pins.FRIDA_VERSION,
          `frida-server-${pins.FRIDA_VERSION}-android-${abi}.xz`,
        ),
        sha256: pins[`FRIDA_SERVER_${abi.toUpperCase()}_SHA256`],
      })),
    },
    android_cli: {
      label: "Android CLI (optional)",
      kind: "download",
      version: "latest",
      url: pins.ANDROID_CLI_URL,
      path: ".toolchain/bin/android",
      archive: "copy",
      optional: true,
    },
    rea: {
      label: "REA provider (optional external MCP)",
      kind: "external",
      version: "6.3.0",
      optional: true,
      setup: "npx -y rea-agents@6.3.0 setup --client opencode --yes",
    },
  };
}

const CORE_REQUIRED = ["node", "java", "android-sdk", "mcp"];
const FULL_OPTIONAL = [
  "gradle",
  "jadx",
  "apktool",
  "compose_preview",
  "maestro",
  "frida",
  "frida_server",
  "android_cli",
];

export const PROFILES = ["core", "full", "custom"];

/**
 * Resolve a profile into an explicit plan. Unknown capabilities are reported,
 * never silently dropped. `unavailable` is used for optional components the
 * current platform cannot support.
 */
export function resolvePlan({ profile = "core", capabilities = [], root = process.cwd(), pins, platform = process.platform } = {}) {
  if (!PROFILES.includes(profile)) throw new Error(`unknown profile: ${profile}`);
  const catalog = componentCatalog(pins ?? readPins(resolve(root)));
  const required = [...CORE_REQUIRED];
  let optional = [];
  if (profile === "full") optional = [...FULL_OPTIONAL];
  if (profile === "custom") optional = [...new Set(capabilities)];
  const unknown = optional.filter((id) => id !== "no-core" && !catalog[id]);
  if (unknown.length > 0) throw new Error(`unknown capabilities: ${unknown.join(", ")}`);
  const requiredForCustom = capabilities.includes("no-core") ? [] : required;
  const selected = new Set([...requiredForCustom, ...optional]);
  const components = Object.entries(catalog)
    .filter(([id]) => selected.has(id))
    .map(([id, spec]) => {
      const isRequired = requiredForCustom.includes(id);
      const unsupported =
        id === "android_cli" && platform === "win32"
          ? "Android CLI installer is Linux/macOS only"
          : null;
      return {
        id,
        ...spec,
        required: isRequired,
        status: unsupported ? "unavailable" : "available",
        reason: unsupported ?? (spec.optional ? "optional capability" : "profile dependency"),
      };
    });
  return { schema: MANIFEST_SCHEMA, profile, components, unavailable: components.filter((c) => c.status === "unavailable") };
}

/** Human-readable pre-install plan. */
export function formatPlan(plan) {
  const lines = [`install profile: ${plan.profile}`, "planned components:"];
  for (const c of plan.components) {
    lines.push(
      `  ${c.required ? "required " : "optional "} ${c.id}${c.version ? `@${c.version}` : ""} [${c.status}] ${c.reason}`,
    );
  }
  for (const c of plan.unavailable) lines.push(`  UNAVAILABLE: ${c.id} — ${c.reason}`);
  return lines.join("\n");
}
