// ISSUE-102 / ISSUE-106 / ISSUE-50: execution-layer boundary for every MCP tool.
// Path arguments are checked against an immutable workspace policy, then the
// execution policy decides whether the operation may run, needs a bound
// approval, or is refused. Unclassified tools fail closed. Successful payloads
// are tagged with provenance and framed as untrusted data.

import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  checkWorkspacePath,
  validatePathGrant,
  type PathGrant,
  type PathOperation,
  type WorkspacePolicy,
} from "./workspace.js";
import { TOOL_ENTRIES, TOOL_PATH_SPECS, TOOL_SOURCES } from "./registry.js";
import { presentResult, type SourceCategory } from "./provenance.js";
import {
  APPROVAL_TOKEN_FIELD,
  encodeApprovalRequest,
  evaluateToolPolicy,
  type ApprovalLedger,
  type ApprovalRequest,
  type ExecutionPolicy,
  type PolicyDecisionMeta,
} from "./executionPolicy.js";

export interface BoundaryOptions {
  policy: WorkspacePolicy;
  execution: ExecutionPolicy;
  approvals: ApprovalLedger;
  now?: () => Date;
  grants?: readonly PathGrant[];
  requestId?: string;
  maxChars?: number;
}

export interface BoundaryBlock {
  tool: string;
  reason: string;
  field?: string;
  operation?: PathOperation;
  path?: string;
  workspace?: string | null;
}

export interface BlockedResultOptions {
  guidance?: readonly string[];
  policy?: PolicyDecisionMeta;
  approval?: ApprovalRequest;
  preview?: string;
}

function detail(value: unknown): string {
  const text = String(value);
  return /[\s\p{Cc}]/u.test(text) ? JSON.stringify(text) : text;
}

const WORKSPACE_GUIDANCE = [
  "This decision is MCP-owned. Path arguments must resolve inside an approved",
  "workspace root. Set ANDROID_MCP_WORKSPACE to the project root or",
  "ANDROID_MCP_WORKSPACE_ROOTS to approved additional roots. Paths outside the",
  "workspace require a request-scoped grant.",
];

export function blockedResult(
  tool: string,
  reason: string,
  details: Omit<BoundaryBlock, "tool" | "reason">,
  now: Date,
  options: BlockedResultOptions = {},
): CallToolResult {
  const encodedApproval = options.approval ? encodeApprovalRequest(options.approval) : undefined;
  const lines = [
    "status=blocked",
    `tool=${detail(tool)}`,
    `reason=${detail(reason)}`,
    ...(options.policy
      ? [
          `mode=${detail(options.policy.mode)}`,
          `impact=${detail(options.policy.impact)}`,
          ...(options.policy.target ? [`target=${detail(options.policy.target)}`] : []),
        ]
      : []),
    ...(details.field ? [`field=${detail(details.field)}`] : []),
    ...(details.operation ? [`operation=${detail(details.operation)}`] : []),
    ...(details.path ? [`path=${detail(details.path)}`] : []),
    ...(details.workspace !== undefined && details.workspace !== null
      ? [`workspace=${detail(details.workspace)}`]
      : []),
    ...(options.preview ? [`preview=${detail(options.preview)}`] : []),
    ...(options.approval && encodedApproval
      ? [
          `approval-request=${encodedApproval}`,
          `approval-fingerprint=${options.approval.fingerprint}`,
          `approval-expires=${options.approval.expiresAt}`,
        ]
      : []),
    `timestamp=${now.toISOString()}`,
    "",
    ...(options.guidance ?? WORKSPACE_GUIDANCE),
  ];
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    isError: true,
    _meta: {
      provenance: {
        tool,
        source: "mcp" as SourceCategory,
        trust: "mcp-policy",
        untrusted: false,
        reason,
        decisionId: randomUUID(),
        target: details.path ?? options.policy?.target ?? null,
        timestamp: now.toISOString(),
      },
      ...(options.policy ? { policy: options.policy } : {}),
      ...(options.approval && encodedApproval
        ? {
            approval: {
              required: true,
              request: encodedApproval,
              ...options.approval,
              passAs: APPROVAL_TOKEN_FIELD,
              approveCommand: `ANDROID_MCP_APPROVAL_SECRET=<secret> npm run approve -- '${encodedApproval}'`,
            },
          }
        : {}),
    },
  };
}

function configuredMaxChars(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.ANDROID_MCP_MAX_OUTPUT_CHARS;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 200 ? parsed : undefined;
}

/**
 * Run a tool handler behind the workspace and execution boundaries. Returns an
 * MCP result in every case; an outside path, an unclassified tool or a policy
 * refusal never reaches the handler.
 */
// Handlers receive a copy with the approval token removed; path fields are
// replaced with the canonical values the boundary actually checked.
function toolHandlerArgs(args: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...(args ?? {}) };
  delete copy[APPROVAL_TOKEN_FIELD];
  return copy;
}

export async function runWithBoundary(
  name: string,
  args: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>,
  options: BoundaryOptions,
): Promise<CallToolResult> {
  const specs = TOOL_PATH_SPECS[name];
  const now = options.now?.() ?? new Date();
  const policy = options.policy;
  const entry = TOOL_ENTRIES[name];

  if (!specs) {
    return blockedResult(name, "unclassified-tool", {}, now);
  }
  if (!policy) {
    return blockedResult(name, "workspace-unconfigured", {}, now);
  }

  const grants = options.grants ?? [];
  const consumed = new Set<string>();
  const handlerArgs = toolHandlerArgs(args);
  let primaryTarget: string | null = null;

  for (const spec of specs) {
    const value = args?.[spec.field];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") {
      return blockedResult(
        name,
        "invalid-path",
        { field: spec.field, operation: spec.operation },
        now,
      );
    }

    let decision = checkWorkspacePath(policy, value, spec.operation);
    if (!decision.ok) {
      let granted = false;
      for (const grant of grants) {
        if (consumed.has(grant.id)) continue;
        const check = validatePathGrant(policy, grant, value, spec.operation, {
          requestId: options.requestId,
          now,
        });
        if (check.ok) {
          consumed.add(grant.id);
          decision = check;
          granted = true;
          break;
        }
      }
      if (!granted) {
        return blockedResult(
          name,
          decision.reason ?? "outside-workspace",
          {
            field: spec.field,
            operation: spec.operation,
            path: decision.path ?? value,
            workspace: policy.root,
          },
          now,
        );
      }
    }

    const canonical = decision.path ?? value;
    handlerArgs[spec.field] = canonical;
    primaryTarget ??= canonical;

    if (spec.operation === "write" && !args?.overwrite) {
      const target = decision.path ?? value;
      if (existsSync(target)) {
        return blockedResult(
          name,
          "overwrite-denied",
          { field: spec.field, operation: spec.operation, path: target, workspace: policy.root },
          now,
        );
      }
    }
  }
  if (!entry) {
    return blockedResult(name, "unclassified-tool", {}, now);
  }
  const decision = evaluateToolPolicy({
    entry,
    args,
    policy: options.execution,
    ledger: options.approvals,
    now,
  });
  if (!decision.allowed) {
    return blockedResult(name, decision.reason, {}, now, {
      guidance: decision.guidance,
      policy: decision.meta,
      ...(decision.approval ? { approval: decision.approval } : {}),
      ...(decision.preview ? { preview: decision.preview } : {}),
    });
  }

  const result = await handler(handlerArgs);
  const presented = presentResult(name, result, {
    target: primaryTarget,
    source: TOOL_SOURCES[name] ?? "mixed",
    now,
    maxChars: options.maxChars ?? configuredMaxChars(process.env),
  });

  const content =
    decision.meta.warnings.length > 0 && Array.isArray(presented.content)
      ? [
          {
            type: "text" as const,
            text: `[android-mcp:policy] ${decision.meta.warnings.join("; ")}`,
          },
          ...presented.content,
        ]
      : presented.content;

  return {
    ...presented,
    content,
    _meta: {
      ...(presented._meta ?? {}),
      policy: decision.meta,
    },
  };
}
