// ISSUE-105: one outcome model for every MCP invocation. A handler returning
// normally is not proof of success; explicit error results, policy blocks and
// underlying command failures are classified truthfully. Diagnostics are
// redacted and bounded, and raw arguments are never logged.

import { randomUUID } from "node:crypto";

import type { CallToolResult, TextContent } from "@modelcontextprotocol/sdk/types.js";

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

/** Normalize an untyped metadata or thrown-value object without leaking `any`. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function isOutcome(value: unknown): value is Outcome {
  return typeof value === "string" && OUTCOME_SET.has(value);
}

function resultText(result: CallToolResult, maxChars = 4000): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter(
      (block): block is TextContent => block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .slice(0, maxChars);
}

/**
 * Classify a returned MCP result. Explicit MCP-owned metadata wins over text
 * heuristics; heuristics only refine an already-failed result.
 */
export function classifyResult(result: CallToolResult): Outcome {
  const meta = asRecord(result._meta);
  const explicit = meta.outcome;
  if (isOutcome(explicit) && explicit !== "success") {
    return explicit;
  }

  if (asRecord(meta.provenance).trust === "mcp-policy") return "blocked";
  if (result.isError !== true) return "success";

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
export function classifyException(error: unknown): Outcome {
  const record = asRecord(error);
  const code = String(record.code ?? "");
  const name = String(record.name ?? "");
  const message = String(record.message ?? "");
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

function resultDiagnostic(result: CallToolResult): string | undefined {
  const meta = asRecord(result._meta);
  const provenance = asRecord(meta.provenance);
  if (provenance.trust === "mcp-policy") {
    return sanitizeDiagnostic(provenance.reason ?? "blocked");
  }
  if (typeof meta.diagnostic === "string") {
    return sanitizeDiagnostic(meta.diagnostic);
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
  args: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
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
export async function runInstrumentedTool(
  options: InstrumentedToolOptions,
): Promise<CallToolResult> {
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
    const metaRecord = asRecord(result._meta);
    const policyMeta = asRecord(metaRecord.policy);
    const provenanceMeta = asRecord(metaRecord.provenance);
    const meta = {
      ...metaRecord,
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
        ["exit_code", metaRecord.exitCode],
        ["signal", metaRecord.signal],
        ["policy", policyMeta.mode],
        ["impact", policyMeta.impact],
        ["decision", policyMeta.decision],
        ["target", policyMeta.target],
        ["policy_reason", policyMeta.reason],
        ["approval_id", policyMeta.approvalId ?? policyMeta.approvalRequestId],
        [
          "policy_warnings",
          Array.isArray(policyMeta.warnings) ? policyMeta.warnings.length : undefined,
        ],
        ["policy_decision", provenanceMeta.decisionId],
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
