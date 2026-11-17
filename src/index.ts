#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { STARTUP_BUILD } from "./buildInfo.js";
import * as H from "./tools.js";
import { TOOL_REGISTRY } from "./registry.js";
import { runInstrumentedTool } from "./outcome.js";
import { createWorkspacePolicy } from "./workspace.js";

const server = new McpServer(
  { name: STARTUP_BUILD.name, version: STARTUP_BUILD.version },
  { capabilities: { tools: {} } },
);

function logged(name: string, fn: (args: any) => Promise<unknown>) {
  return async (args: any) => {
    // ISSUE-102: a fresh immutable workspace policy per request. ISSUE-105:
    // correlation, truthful outcome and sanitized diagnostics per invocation.
    const policy = createWorkspacePolicy({ env: process.env });
    return runInstrumentedTool({ name, args, handler: fn, policy });
  };
}

// ISSUE-104: registration is a loop over the typed registry. A tool cannot be
// registered without its schema, handler, description, risk class, approval
// requirement, path policy, provenance source and test reference.
for (const tool of TOOL_REGISTRY) {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.schema },
    logged(tool.name, tool.handler),
  );
}

async function main() {
  // A persisted capture may have outlived the previous MCP process. Reconcile
  // it in the background: an unexpired session is re-armed, an expired one is
  // stopped and its exact device proxy is restored. Capture starts take the
  // same lock, so they cannot race this.
  void H.recoverCaptureSession()
    .then((result) => {
      if (result.status !== "none") {
        console.error(`[android-mcp] net_capture recovery: ${result.status}`);
      }
    })
    .catch((e) => console.error("[android-mcp] net_capture recovery failed:", e));
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
