// ISSUE-102 / ISSUE-106: execution-layer boundary for every MCP tool.
// Path arguments are checked against an immutable workspace policy before the
// handler runs; unclassified tools fail closed. Successful tool payloads are
// tagged with provenance and framed as untrusted data.

import { existsSync } from "node:fs";

import {
  TOOL_PATH_SPECS,
  checkWorkspacePath,
  validatePathGrant,
  type PathGrant,
  type PathOperation,
  type WorkspacePolicy,
} from "./workspace.js";
import { presentResult, type SourceCategory } from "./provenance.js";

export interface BoundaryOptions {
  policy: WorkspacePolicy;
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

function detail(value: unknown): string {
  const text = String(value);
  return /[\s\p{Cc}]/u.test(text) ? JSON.stringify(text) : text;
}

export function blockedResult(
  tool: string,
  reason: string,
  details: Omit<BoundaryBlock, "tool" | "reason">,
  now: Date,
): any {
  const lines = [
    "status=blocked",
    `tool=${detail(tool)}`,
    `reason=${detail(reason)}`,
    ...(details.field ? [`field=${detail(details.field)}`] : []),
    ...(details.operation ? [`operation=${detail(details.operation)}`] : []),
    ...(details.path ? [`path=${detail(details.path)}`] : []),
    ...(details.workspace !== undefined && details.workspace !== null
      ? [`workspace=${detail(details.workspace)}`]
      : []),
    `timestamp=${now.toISOString()}`,
    "",
    "This decision is MCP-owned. Path arguments must resolve inside an approved",
    "workspace root. Set ANDROID_MCP_WORKSPACE to the project root or",
    "ANDROID_MCP_WORKSPACE_ROOTS to approved additional roots. Paths outside the",
    "workspace require a request-scoped grant.",
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
        target: details.path ?? null,
        timestamp: now.toISOString(),
      },
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
 * Run a tool handler behind the workspace boundary. Returns an MCP result in
 * every case; an outside path or an unclassified tool never reaches the
 * handler.
 */
export async function runWithBoundary(
  name: string,
  args: any,
  handler: (args: any) => Promise<any>,
  options: BoundaryOptions,
): Promise<any> {
  const specs = TOOL_PATH_SPECS[name];
  const now = options.now?.() ?? new Date();
  const policy = options.policy;

  if (!specs) {
    return blockedResult(name, "unclassified-tool", {}, now);
  }
  if (!policy) {
    return blockedResult(name, "workspace-unconfigured", {}, now);
  }

  const grants = options.grants ?? [];
  const consumed = new Set<string>();
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

    primaryTarget ??= decision.path ?? value;

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

  const result = await handler(args);
  return presentResult(name, result, {
    target: primaryTarget,
    now,
    maxChars: options.maxChars ?? configuredMaxChars(process.env),
  });
}
