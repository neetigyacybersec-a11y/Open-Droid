// ISSUE-50: a configurable execution policy enforced at the MCP boundary.
//
// Modes:
//   permissive  run everything, but emit explicit warnings for high-impact work.
//   balanced    allow approval-free tools; gate the rest behind a bound token.
//   restricted  read-only tools plus explicit ANDROID_MCP_ALLOW entries only,
//               with the approval gate still applied to gated tools.
//
// Approval tokens are HMAC-signed, bound to the exact tool, policy key, target
// and canonical arguments, expire quickly and are single-use. The server never
// claims to show a confirmation UI: a human or host must review the preview and
// sign the request out of band with `npm run approve`.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { IMPACT_CLASSES, baseImpact, type ImpactClass, type ToolDefinition } from "./registry.js";
import { sanitizeUntrusted } from "./provenance.js";

export { IMPACT_CLASSES, baseImpact };
export type { ImpactClass };

export const POLICY_MODES = Object.freeze(["permissive", "balanced", "restricted"] as const);

export type PolicyMode = (typeof POLICY_MODES)[number];

export const APPROVAL_TOKEN_FIELD = "approvalToken";
export const DEFAULT_APPROVAL_TTL_MS = 300_000;
const MIN_APPROVAL_TTL_MS = 30_000;
const MAX_APPROVAL_TTL_MS = 3_600_000;
const MIN_APPROVAL_SECRET_LENGTH = 32;
const MAX_LEDGER_ENTRIES = 2048;
const MAX_TOKEN_LENGTH = 8192;
const PREVIEW_MAX_CHARS = 400;

export interface ExecutionPolicy {
  readonly mode: PolicyMode;
  /** Tool names and/or policy keys enabled in restricted mode. */
  readonly allow: readonly string[];
  readonly approvalSecret: string | null;
  readonly approvalTtlMs: number;
  /** Changes every process start so a token cannot be replayed after restart. */
  readonly instanceId: string;
}

export interface ApprovalLedger {
  isConsumed(id: string): boolean;
  consume(id: string, expiresAtMs: number, nowMs: number): void;
  size(): number;
}

export interface ApprovalRequest {
  readonly version: 1;
  readonly id: string;
  readonly instanceId: string;
  readonly tool: string;
  readonly policyKey: string;
  readonly impact: ImpactClass;
  readonly fingerprint: string;
  readonly target: string | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export type PolicyBlockReason =
  | "not-allowlisted"
  | "approval-required"
  | "approval-unconfigured"
  | "approval-invalid"
  | "approval-expired"
  | "approval-replayed"
  | "approval-mismatch";

export interface PolicyDecisionMeta {
  readonly mode: PolicyMode;
  readonly impact: ImpactClass;
  readonly decision: "allowed" | "blocked";
  readonly reason?: PolicyBlockReason;
  readonly target: string | null;
  readonly approvalId?: string;
  readonly approvalRequestId?: string;
  readonly warnings: readonly string[];
}

export interface AllowedToolPolicyDecision {
  readonly allowed: true;
  readonly impact: ImpactClass;
  readonly meta: PolicyDecisionMeta;
}

export interface BlockedToolPolicyDecision {
  readonly allowed: false;
  readonly impact: ImpactClass;
  readonly reason: PolicyBlockReason;
  readonly message: string;
  readonly meta: PolicyDecisionMeta;
  readonly guidance: readonly string[];
  readonly preview?: string;
  readonly approval?: ApprovalRequest;
}

export type ToolPolicyDecision = AllowedToolPolicyDecision | BlockedToolPolicyDecision;

export interface ExecutionPolicyOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam; production uses a random ID per process. */
  instanceId?: string;
}

function invalid(message: string): never {
  throw new Error(message);
}

function parseMode(raw: string | undefined): PolicyMode {
  if (raw === undefined || raw.trim() === "") return "balanced";
  const mode = raw.trim().toLowerCase();
  if (!POLICY_MODES.includes(mode as PolicyMode)) {
    invalid(`invalid ANDROID_MCP_POLICY="${raw}"; expected one of ${POLICY_MODES.join(", ")}`);
  }
  return mode as PolicyMode;
}

function parseAllowlist(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") return Object.freeze([]);
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.includes("*")) {
    invalid("ANDROID_MCP_ALLOW does not accept wildcards; name tools or policy keys explicitly");
  }
  for (const entry of entries) {
    if (!/^[a-z][a-z0-9_.]*$/.test(entry)) {
      invalid(`invalid ANDROID_MCP_ALLOW entry ${JSON.stringify(entry)}`);
    }
  }
  return Object.freeze([...new Set(entries)]);
}

function parseSecret(raw: string | undefined): string | null {
  const secret = raw?.trim() ?? "";
  if (secret === "") return null;
  if (secret.length < MIN_APPROVAL_SECRET_LENGTH) {
    invalid(
      `ANDROID_MCP_APPROVAL_SECRET must be at least ${MIN_APPROVAL_SECRET_LENGTH} characters`,
    );
  }
  return secret;
}

function parseTtlSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_APPROVAL_TTL_MS;
  const seconds = Number(raw);
  if (
    !Number.isInteger(seconds) ||
    seconds < MIN_APPROVAL_TTL_MS / 1000 ||
    seconds > MAX_APPROVAL_TTL_MS / 1000
  ) {
    invalid("ANDROID_MCP_APPROVAL_TTL_SEC must be an integer between 30 and 3600 seconds");
  }
  return seconds * 1000;
}

export function createExecutionPolicy(options: ExecutionPolicyOptions = {}): ExecutionPolicy {
  const env = options.env ?? {};
  return Object.freeze({
    mode: parseMode(env.ANDROID_MCP_POLICY),
    allow: parseAllowlist(env.ANDROID_MCP_ALLOW),
    approvalSecret: parseSecret(env.ANDROID_MCP_APPROVAL_SECRET),
    approvalTtlMs: parseTtlSeconds(env.ANDROID_MCP_APPROVAL_TTL_SEC),
    instanceId: options.instanceId ?? randomUUID(),
  });
}

/**
 * In-memory single-use ledger. It is bounded, prunes expired entries and keeps
 * the process-local set small enough for long-running development sessions.
 */
export function createApprovalLedger(limit = MAX_LEDGER_ENTRIES): ApprovalLedger {
  if (!Number.isInteger(limit) || limit < 1) {
    invalid("approval ledger limit must be a positive integer");
  }
  const consumed = new Map<string, number>();
  return Object.freeze({
    isConsumed(id: string): boolean {
      return consumed.has(id);
    },
    consume(id: string, expiresAtMs: number, nowMs: number): void {
      for (const [key, expiry] of consumed) {
        if (expiry <= nowMs) consumed.delete(key);
      }
      while (consumed.size >= limit) {
        const oldest = consumed.keys().next().value;
        if (oldest === undefined) break;
        consumed.delete(oldest);
      }
      consumed.set(id, expiresAtMs);
    },
    size(): number {
      return consumed.size;
    },
  });
}

/** Treat untyped MCP arguments as a plain record without an `any` escape. */
function argumentRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

/** Canonical fingerprint over the tool identity and every real argument. */
export function fingerprintRequest(entry: ToolDefinition, args: unknown): string {
  const record = args && typeof args === "object" ? { ...(args as Record<string, unknown>) } : {};
  delete record[APPROVAL_TOKEN_FIELD];
  return createHash("sha256")
    .update(
      canonicalJson({
        tool: entry.name,
        policyKey: entry.policyKey,
        args: record,
      }),
    )
    .digest("hex");
}

/** Argument-dependent impact; only Gradle publish-like tasks elevate today. */
export function resolveImpact(entry: ToolDefinition, args: unknown): ImpactClass {
  if (entry.name === "gradle_task") {
    const record = argumentRecord(args);
    const task = typeof record.task === "string" ? record.task.toLowerCase() : "";
    if (
      /(^|:)(publish|upload|deploy|promote|play|sign|release)/.test(task) &&
      !task.includes("mavenlocal")
    ) {
      return "production";
    }
  }
  return baseImpact(entry);
}

/** A short, sanitized identity string for results and audit records. */
export function describeTarget(entry: ToolDefinition, args: unknown): string | null {
  const a = argumentRecord(args);
  const parts: string[] = [];
  const add = (value: string) => {
    if (!parts.includes(value)) parts.push(value);
  };
  if (typeof a.deviceId === "string" && a.deviceId) add(`device:${a.deviceId}`);
  if (Array.isArray(a.deviceIds)) {
    const ids = a.deviceIds.filter((id: unknown) => typeof id === "string" && id.length > 0);
    if (ids.length > 0) add(`devices:${ids.join(",")}`);
  }
  if (typeof a.avdName === "string" && a.avdName) add(`avd:${a.avdName}`);
  if (typeof a.packageName === "string" && a.packageName) add(`package:${a.packageName}`);
  if (typeof a.projectPath === "string" && a.projectPath) {
    add(`project:${a.projectPath}`);
  }
  if (typeof a.task === "string" && a.task) add(`task:${a.task}`);
  for (const spec of entry.paths) {
    const value = a[spec.field];
    if (typeof value === "string" && value.length > 0) add(`path:${value}`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Best-effort operation preview for the approval step. Never executes anything. */
export function previewOperation(entry: ToolDefinition, args: unknown): string {
  const a = argumentRecord(args);
  const text = (value: unknown): string =>
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  const list = (value: unknown): string =>
    Array.isArray(value) ? value.map((item) => text(item)).join(" ") : text(value);
  const device = a.deviceId ? ` -s ${text(a.deviceId)}` : "";
  const packages = list(a.packages);
  let raw: string;
  switch (entry.name) {
    case "adb_shell":
      raw = `adb${device} shell ${text(a.command)}`;
      break;
    case "adb_parallel":
      raw = `adb${device} shell on ${JSON.stringify(a.deviceIds ?? [])}: ${text(a.command)}`;
      break;
    case "adb_rm":
      raw = `adb${device} shell rm -rf ${text(a.remotePath)}`;
      break;
    case "adb_uninstall":
      raw = `adb${device} uninstall ${text(a.packageName)}`;
      break;
    case "adb_clear_data":
      raw = `adb${device} shell pm clear ${text(a.packageName)}`;
      break;
    case "adb_reboot":
      raw = `adb${device} reboot`;
      break;
    case "adb_launch":
      raw = `adb${device} shell am start ${text(a.packageName)}/${text(a.activity)}`;
      break;
    case "adb_install":
      raw = `adb${device} install ${text(a.apkPath)}`;
      break;
    case "adb_push":
      raw = `adb${device} push ${text(a.localPath)} ${text(a.remotePath)}`;
      break;
    case "adb_force_stop":
      raw = `adb${device} shell am force-stop ${text(a.packageName)}`;
      break;
    case "adb_input": {
      const action = text(a.action);
      if (action === "tap") raw = `adb${device} shell input tap ${text(a.x)} ${text(a.y)}`;
      else if (action === "swipe") {
        raw =
          `adb${device} shell input swipe ${text(a.x)} ${text(a.y)} ` +
          `${text(a.x2)} ${text(a.y2)}`;
      } else if (action === "text") {
        raw = `adb${device} shell input text ${text(a.text)}`;
      } else {
        raw = `adb${device} shell input keyevent ${text(a.keycode) || "KEYCODE_ENTER"}`;
      }
      break;
    }
    case "adb_deep_link":
      raw =
        `adb${device} shell am start -a android.intent.action.VIEW -d ${text(a.uri)}` +
        (a.packageName ? ` -p ${text(a.packageName)}` : "");
      break;
    case "adb_broadcast":
      raw =
        `adb${device} shell am broadcast -a ${text(a.action)}` +
        (a.extras ? ` ${list(a.extras)}` : "");
      break;
    case "adb_service_start":
      raw = `adb${device} shell am startservice -n ${text(a.component)}`;
      break;
    case "adb_wifi": {
      const action = text(a.action);
      const address = `${text(a.host) || "127.0.0.1"}:${text(a.port) || "5555"}`;
      raw =
        action === "tcpip"
          ? `adb${device} tcpip ${text(a.port) || "5555"}`
          : `adb${device} ${action || "connect"} ${address}`;
      break;
    }
    case "adb_logcat":
    case "logcat_filtered": {
      const clear = a.clear !== false ? `adb${device} logcat -c && ` : "";
      const selector = a.tag ? ` ${text(a.tag)}` : "";
      raw = `${clear}adb${device} logcat -d -v time${selector}`;
      break;
    }
    case "crash_summary":
      raw = `adb${device} logcat -c && capture ${text(a.durationSec) || "10"}s of crash logs`;
      break;
    case "emulator_boot":
      raw = `emulator -avd ${text(a.avdName)}${a.headless === false ? "" : " -no-window"}`;
      break;
    case "avd_delete":
      raw = `avdmanager delete avd -n ${text(a.avdName)}`;
      break;
    case "avd_wipe":
      raw = `emulator -avd ${text(a.avdName)} -wipe-data`;
      break;
    case "emulator_snapshot":
      raw = `emulator -avd ${text(a.avdName)} snapshot ${text(a.action)}`;
      break;
    case "sdkmanager_install":
      raw = `sdkmanager ${packages}`;
      break;
    case "gradle_task":
      raw = `gradle ${text(a.task)} in ${text(a.projectPath)}`;
      break;
    case "baseline_profile_generate":
    case "instrumented_test":
    case "macrobenchmark":
      raw = `gradle ${text(a.module) || ":app"}:connectedAndroidTest in ${text(a.projectPath)}`;
      break;
    case "maestro_run":
      raw = `maestro test ${text(a.flowPath)}`;
      break;
    case "net_capture":
      raw = `mitmproxy ${text(a.action)} on port ${text(a.port)}`;
      break;
    case "apk_serve":
      raw = `serve ${text(a.dir)} on port ${text(a.port)}`;
      break;
    case "frida_ps":
      raw = `frida-ps -U${a.deviceId ? ` (device ${text(a.deviceId)})` : ""}`;
      break;
    case "frida_hook":
      raw =
        `frida ${a.spawn ? "spawn" : "attach"} ${text(a.packageName)}` +
        (a.scriptPath
          ? ` with script ${text(a.scriptPath)}`
          : a.script
            ? ` with an inline script (${text(a.script).length} chars)`
            : "");
      break;
    case "frida_trace_methods":
      raw = `frida trace ${text(a.packageName)}`;
      break;
    case "layout_bounds":
      raw = `adb${device} shell setprop debug.layout ${a.enabled === false ? "false" : "true"}`;
      break;
    case "startup_time":
      raw =
        `adb${device} shell am start-activity -W -n ${text(a.packageName)}/` +
        `${text(a.activity) || "<launcher>"} (${text(a.iterations) || "5"} iterations)`;
      break;
    default:
      raw = `${entry.name} with the supplied operation arguments`;
  }
  return sanitizeUntrusted(raw, {
    maxChars: PREVIEW_MAX_CHARS,
    tool: entry.name,
    source: "mixed",
  }).text;
}

export function buildApprovalRequest(
  entry: ToolDefinition,
  args: unknown,
  policy: ExecutionPolicy,
  now: Date,
): ApprovalRequest {
  return Object.freeze({
    version: 1 as const,
    id: randomUUID(),
    instanceId: policy.instanceId,
    tool: entry.name,
    policyKey: entry.policyKey ?? "none",
    impact: resolveImpact(entry, args),
    fingerprint: fingerprintRequest(entry, args),
    target: describeTarget(entry, args),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + policy.approvalTtlMs).toISOString(),
  });
}

export function encodeApprovalRequest(request: ApprovalRequest): string {
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isImpactClass(value: unknown): value is ImpactClass {
  return typeof value === "string" && IMPACT_CLASSES.some((impact) => impact === value);
}

const ApprovalRequestSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  instanceId: z.string().min(1),
  tool: z.string().min(1),
  policyKey: z.string(),
  impact: z.custom<ImpactClass>(isImpactClass),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  target: z.union([z.string(), z.null()]),
  issuedAt: z.string().refine(isIsoDate),
  expiresAt: z.string().refine(isIsoDate),
});

export function decodeApprovalRequest(encoded: string): ApprovalRequest {
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > MAX_TOKEN_LENGTH) {
    invalid("invalid approval request encoding");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    invalid("invalid approval request encoding");
  }
  const parsed = ApprovalRequestSchema.safeParse(value);
  if (!parsed.success) invalid("invalid approval request");
  return Object.freeze({ ...parsed.data });
}

function hmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signApprovalRequest(request: ApprovalRequest, secret: string): string {
  if (typeof secret !== "string" || secret.length < MIN_APPROVAL_SECRET_LENGTH) {
    invalid(`approval secret must be at least ${MIN_APPROVAL_SECRET_LENGTH} characters`);
  }
  const encoded = encodeApprovalRequest(request);
  return `${encoded}.${hmac(secret, encoded)}`;
}

type TokenVerification =
  { ok: true; id: string; expiresAtMs: number } | { ok: false; reason: PolicyBlockReason };

function verifyApprovalToken(
  token: unknown,
  policy: ExecutionPolicy,
  entry: ToolDefinition,
  args: unknown,
  ledger: ApprovalLedger,
  now: Date,
): TokenVerification {
  if (!policy.approvalSecret) return { ok: false, reason: "approval-unconfigured" };
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "approval-invalid" };
  }
  const segments = token.split(".");
  if (segments.length !== 2 || segments[0].length === 0 || segments[1].length === 0) {
    return { ok: false, reason: "approval-invalid" };
  }

  let request: ApprovalRequest;
  try {
    request = decodeApprovalRequest(segments[0]);
  } catch {
    return { ok: false, reason: "approval-invalid" };
  }

  const provided = Buffer.from(segments[1], "base64url");
  const expected = Buffer.from(hmac(policy.approvalSecret, segments[0]), "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "approval-invalid" };
  }

  if (
    request.instanceId !== policy.instanceId ||
    request.tool !== entry.name ||
    request.policyKey !== (entry.policyKey ?? "none") ||
    request.fingerprint !== fingerprintRequest(entry, args) ||
    request.impact !== resolveImpact(entry, args)
  ) {
    return { ok: false, reason: "approval-mismatch" };
  }

  const expiresAtMs = Date.parse(request.expiresAt);
  if (!Number.isFinite(expiresAtMs) || now.getTime() > expiresAtMs) {
    return { ok: false, reason: "approval-expired" };
  }
  if (ledger.isConsumed(request.id)) {
    return { ok: false, reason: "approval-replayed" };
  }
  return { ok: true, id: request.id, expiresAtMs };
}

function approvalGuidance(request: ApprovalRequest): readonly string[] {
  const encoded = encodeApprovalRequest(request);
  return Object.freeze([
    "No operation ran. This server does not provide a confirmation UI.",
    "A human or host must review the preview, then sign this exact request:",
    `  ANDROID_MCP_APPROVAL_SECRET=<secret> npm run approve -- '${encoded}'`,
    "Pass the printed token as the top-level `approvalToken` argument on the retry.",
    "The token is bound to this tool, target and arguments, expires, and can be used once.",
  ]);
}

export interface EvaluatePolicyOptions {
  entry: ToolDefinition;
  args: unknown;
  policy: ExecutionPolicy;
  ledger: ApprovalLedger;
  now?: Date;
}

function isAllowlisted(policy: ExecutionPolicy, entry: ToolDefinition): boolean {
  return (
    policy.allow.includes(entry.name) ||
    (entry.policyKey !== null && policy.allow.includes(entry.policyKey))
  );
}

export function evaluateToolPolicy(options: EvaluatePolicyOptions): ToolPolicyDecision {
  const { entry, args, policy, ledger } = options;
  const now = options.now ?? new Date();
  const impact = resolveImpact(entry, args);
  const target = describeTarget(entry, args);
  const warnings: string[] =
    policy.mode === "permissive" && (entry.approval !== "none" || impact === "production")
      ? [
          `permissive mode: ${entry.name} (impact=${impact}) ran without a bound approval; ` +
            "switch to balanced or restricted to enforce confirmation",
        ]
      : [];

  const blocked = (
    reason: PolicyBlockReason,
    message: string,
    extra: {
      approval?: ApprovalRequest;
      guidance?: readonly string[];
      preview?: string;
    } = {},
  ): BlockedToolPolicyDecision => ({
    allowed: false,
    impact,
    reason,
    message,
    meta: Object.freeze({
      mode: policy.mode,
      impact,
      decision: "blocked",
      reason,
      target,
      approvalRequestId: extra.approval?.id,
      warnings: Object.freeze([...warnings]),
    }),
    guidance: Object.freeze([...(extra.guidance ?? [])]),
    ...(extra.preview !== undefined ? { preview: extra.preview } : {}),
    ...(extra.approval !== undefined ? { approval: extra.approval } : {}),
  });

  if (
    policy.mode === "restricted" &&
    (entry.risk !== "read-only" || impact === "production") &&
    !isAllowlisted(policy, entry)
  ) {
    return blocked("not-allowlisted", `not-allowlisted: ${entry.name}`, {
      guidance: Object.freeze([
        "Restricted mode permits read-only tools and explicit allowlist entries only.",
        `Add ${entry.policyKey ?? entry.name} to ANDROID_MCP_ALLOW and restart the server,`,
        "or choose a different execution policy deliberately.",
      ]),
    });
  }

  const requiresApproval =
    policy.mode !== "permissive" && (entry.approval !== "none" || impact === "production");
  if (!requiresApproval) {
    return {
      allowed: true,
      impact,
      meta: Object.freeze({
        mode: policy.mode,
        impact,
        decision: "allowed",
        target,
        warnings: Object.freeze([...warnings]),
      }),
    };
  }

  if (!policy.approvalSecret) {
    return blocked(
      "approval-unconfigured",
      "approval-unconfigured: no ANDROID_MCP_APPROVAL_SECRET is configured",
      {
        guidance: Object.freeze([
          "Gated operations cannot be approved until the server has a shared secret.",
          "Set ANDROID_MCP_APPROVAL_SECRET to at least 32 characters on the server",
          "and on the host that runs `npm run approve`.",
          "Alternatively set ANDROID_MCP_POLICY=permissive deliberately to disable gating.",
        ]),
      },
    );
  }

  const preview = previewOperation(entry, args);
  const token = argumentRecord(args)[APPROVAL_TOKEN_FIELD];
  if (token === undefined || token === null || token === "") {
    const request = buildApprovalRequest(entry, args, policy, now);
    return blocked("approval-required", "approval-required: this operation needs a bound token", {
      approval: request,
      preview,
      guidance: approvalGuidance(request),
    });
  }

  const verified = verifyApprovalToken(token, policy, entry, args, ledger, now);
  if (!verified.ok) {
    const request =
      verified.reason === "approval-unconfigured"
        ? undefined
        : buildApprovalRequest(entry, args, policy, now);
    return blocked(verified.reason, `${verified.reason}: the presented approval is not usable`, {
      ...(request ? { approval: request } : {}),
      preview,
      guidance: request
        ? approvalGuidance(request)
        : Object.freeze([
            "Set ANDROID_MCP_APPROVAL_SECRET on the server before requesting approval.",
          ]),
    });
  }

  ledger.consume(verified.id, verified.expiresAtMs, now.getTime());
  return {
    allowed: true,
    impact,
    meta: Object.freeze({
      mode: policy.mode,
      impact,
      decision: "allowed",
      target,
      approvalId: verified.id,
      warnings: Object.freeze([...warnings]),
    }),
  };
}

/**
 * Add the optional approval token to a published tool schema. The token is a
 * normal argument so every MCP client can supply it, and the boundary strips it
 * before the handler runs.
 */
type ExtendableSchema = {
  extend(shape: z.ZodRawShape): z.ZodTypeAny;
};

export function extendSchemaWithApprovalToken(schema: z.ZodTypeAny): z.ZodTypeAny {
  const extendable = schema as unknown as Partial<ExtendableSchema>;
  if (typeof extendable.extend !== "function") {
    throw new Error("tool schema must be an object schema to accept an approval token");
  }
  return extendable.extend({
    [APPROVAL_TOKEN_FIELD]: z
      .string()
      .min(1)
      .max(MAX_TOKEN_LENGTH)
      .optional()
      .describe("Single-use approval token from `npm run approve` for policy-gated operations."),
  });
}

/** Merge a token supplied through MCP request metadata into normal arguments. */
export function withApprovalToken(
  args: Record<string, unknown>,
  meta?: unknown,
): Record<string, unknown> {
  if (typeof args[APPROVAL_TOKEN_FIELD] === "string") return args;
  const token = argumentRecord(meta)[APPROVAL_TOKEN_FIELD];
  if (typeof token === "string" && token.length > 0) {
    return { ...args, [APPROVAL_TOKEN_FIELD]: token };
  }
  return args;
}
