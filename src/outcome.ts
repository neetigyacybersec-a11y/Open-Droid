// ISSUE-105: one outcome model for every MCP invocation. A handler returning
// normally is not proof of success; explicit error results, policy blocks and
// underlying command failures are classified truthfully. Diagnostics are
// redacted and bounded, and raw arguments are never logged.

import { randomUUID } from "node:crypto";

import { STARTUP_BUILD } from "./buildInfo.js";
import { runWithBoundary, type BoundaryOptions } from "./boundary.js";
import { TOOL_SOURCES } from "./registry.js";
import { sanitizeUntrusted } from "./provenance.js";
import type { ApprovalLedger, ExecutionPolicy } from "./executionPolicy.js";
import type { WorkspacePolicy } from "./workspace.js";

export const OUTCOMES = Object.freeze([
  "success",
  "failed",
  "blocked",
  "unavailable",
  "timeout",
  "partial",
  "cancelled",
] as const);

export type Outcome = (typeof OUTCOMES)[number];

const OUTCOME_SET = new Set<string>(OUTCOMES);

function resultText(result: any, maxChars = 4000): string {
  if (!Array.isArray(result?.content)) return "";
  return result.content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text as string)
    .join("\n")
    .slice(0, maxChars);
}

/**
 * Classify a returned MCP result. Explicit MCP-owned metadata wins over text
 * heuristics; heuristics only refine an already-failed result.
 */
export function classifyResult(result: any): Outcome {
  const explicit = result?._meta?.outcome;
  if (typeof explicit === "string" && OUTCOME_SET.has(explicit) && explicit !== "success") {
    return explicit as Outcome;
  }

  if (result?._meta?.provenance?.trust === "mcp-policy") return "blocked";
  if (result?.isError !== true) return "success";

  const text = resultText(result);
  if (/\bpartial\b|\bmeasured-with-cleanup-failure\b/i.test(text)) return "partial";
  if (/\btimed? ?out\b|\btimeout\b|\bETIMEDOUT\b/i.test(text)) return "timeout";
  if (/\bcancell?ed\b|\binterrupted\b/i.test(text)) return "cancelled";
  if (
    /\b(not found|unavailable|no devices?|device offline|command not found|ENOENT|not installed|missing (?:tool|command|device|emulator)|cannot find|failed to find)\b/i.test(
      text,
    )
  ) {
    return "unavailable";
  }
  return "failed";
}

/** Classify a thrown exception without trusting its message as success. */
export function classifyException(error: any): Outcome {
  const code = String(error?.code ?? "");
  const name = String(error?.name ?? "");
  const message = String(error?.message ?? "");
  if (code === "ETIMEDOUT" || name === "TimeoutError" || /\btimed? ?out\b/i.test(message)) {
    return "timeout";
  }
  if (code === "ABORT_ERR" || /\bcancell?ed\b/i.test(message)) return "cancelled";
  if (
    code === "ENOENT" ||
    /\b(not found|unavailable|no devices?|command not found|not installed)\b/i.test(message)
  ) {
    return "unavailable";
  }
  return "failed";
}

/**
 * Bound a diagnostic to one redacted line. Used for thrown errors and failed
 * result summaries; raw command output, scripts and arguments are not logged.
 */
export function sanitizeDiagnostic(value: unknown, maxChars = 300): string {
  let raw: string;
  if (value instanceof Error) raw = value.message;
  else if (typeof value === "string") raw = value;
  else {
    try {
      raw = JSON.stringify(value) ?? String(value);
    } catch {
      raw = String(value);
    }
  }
  const sanitized = sanitizeUntrusted(raw, {
    maxChars,
    tool: "diagnostic",
    source: "mixed",
  });
  return (
    sanitized.text
      .replace(/\s*\n+\s*/g, " ⏎ ")
      .replace(/\s{2,}/g, " ")
      // A diagnostic must not contain embedded key=value records that a naive
      // log parser could mistake for a second trusted record.
      .replace(/\b(event|outcome|correlation|tool|policy_decision|duration_ms|exit_code)=/gi, "$1:")
      .trim()
  );
}

function resultDiagnostic(result: any): string | undefined {
  if (result?._meta?.provenance?.trust === "mcp-policy") {
    return sanitizeDiagnostic(result._meta.provenance.reason ?? "blocked");
  }
  if (typeof result?._meta?.diagnostic === "string") {
    return sanitizeDiagnostic(result._meta.diagnostic);
  }
  const text = resultText(result, 2000);
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ? sanitizeDiagnostic(firstLine) : undefined;
}

function field(value: unknown): string {
  const text = String(value);
  return /[\s\p{Cc}]/u.test(text) ? JSON.stringify(text) : text;
}

function logLine(event: string, fields: Array<[string, unknown]>): string {
  const parts = [`[android-mcp] event=${field(event)}`];
  for (const [key, value] of fields) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${key}=${field(value)}`);
  }
  return parts.join(" ");
}

export interface InstrumentedToolOptions {
  name: string;
  args: any;
  handler: (args: any) => Promise<any>;
  policy: WorkspacePolicy;
  execution: ExecutionPolicy;
  approvals: ApprovalLedger;
  correlationId?: string;
  logger?: (line: string) => void;
  now?: () => number;
  boundary?: Omit<BoundaryOptions, "policy" | "execution" | "approvals">;
}

/**
 * Execute a tool behind the workspace and execution boundaries and emit stable
 * start/end records. The MCP result is returned with `_meta.correlationId`;
 * correlation IDs are unique per invocation.
 */
export async function runInstrumentedTool(options: InstrumentedToolOptions): Promise<any> {
  const correlationId = options.correlationId ?? randomUUID();
  const log = options.logger ?? ((line: string) => console.error(line));
  const clock = options.now ?? (() => Date.now());
  const started = clock();
  const source = TOOL_SOURCES[options.name] ?? "mixed";

  log(
    logLine("tool.start", [
      ["correlation", correlationId],
      ["tool", options.name],
      ["version", STARTUP_BUILD.version],
      ["source", source],
      ["timestamp", new Date(started).toISOString()],
    ]),
  );

  try {
    const result = await runWithBoundary(options.name, options.args, options.handler, {
      ...options.boundary,
      policy: options.policy,
      execution: options.execution,
      approvals: options.approvals,
    });
    const outcome = classifyResult(result);
    const durationMs = Math.max(0, clock() - started);
    const policyMeta = result?._meta?.policy;
    const meta = {
      ...(result?._meta ?? {}),
      correlationId,
    };
    const enriched = { ...result, _meta: meta };

    log(
      logLine("tool.end", [
        ["correlation", correlationId],
        ["tool", options.name],
        ["outcome", outcome],
        ["duration_ms", durationMs],
        ["source", source],
        ["exit_code", result?._meta?.exitCode],
        ["signal", result?._meta?.signal],
        ["policy", policyMeta?.mode],
        ["impact", policyMeta?.impact],
        ["decision", policyMeta?.decision],
        ["target", policyMeta?.target],
        ["policy_reason", policyMeta?.reason],
        ["approval_id", policyMeta?.approvalId ?? policyMeta?.approvalRequestId],
        ["policy_warnings", policyMeta?.warnings?.length],
        ["policy_decision", result?._meta?.provenance?.decisionId],
        ["diagnostic", outcome === "success" ? undefined : resultDiagnostic(result)],
        ["timestamp", new Date(started + durationMs).toISOString()],
      ]),
    );
    return enriched;
  } catch (error) {
    const outcome = classifyException(error);
    const durationMs = Math.max(0, clock() - started);
    log(
      logLine("tool.end", [
        ["correlation", correlationId],
        ["tool", options.name],
        ["outcome", outcome],
        ["duration_ms", durationMs],
        ["source", source],
        ["diagnostic", sanitizeDiagnostic(error)],
        ["timestamp", new Date(started + durationMs).toISOString()],
      ]),
    );
    throw error;
  }
}
