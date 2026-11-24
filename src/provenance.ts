// ISSUE-106: tool output that originates from projects, devices, build
// subprocesses, APKs or captured traffic is untrusted data. This module keeps
// MCP-owned policy/status metadata separate from that payload, strips terminal
// controls, redacts obvious credentials and marks truncation explicitly.
//
// A text label cannot defeat prompt injection on its own. This is one defense
// layer; execution policy and workspace boundaries remain the authorization
// boundary.

import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_SOURCES } from "./registry.js";

export type SourceCategory =
  "project" | "build" | "device" | "static" | "network" | "mixed" | "mcp";

export const UNTRUSTED_BEGIN = "[android-mcp:untrusted-data";
export const UNTRUSTED_END = "[/android-mcp:untrusted-data]";
export const DEFAULT_MAX_CHARS = 200_000;

export interface SanitizedText {
  text: string;
  truncated: boolean;
  redacted: number;
}

type RedactionRule = {
  name: string;
  pattern: RegExp;
  replace: string | ((substring: string, ...groups: string[]) => string);
};

const REDACTION_RULES: RedactionRule[] = [
  {
    name: "private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: "[REDACTED:private-key]",
  },
  {
    name: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: "[REDACTED:aws-access-key]",
  },
  {
    name: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replace: "[REDACTED:github-token]",
  },
  {
    name: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: "[REDACTED:slack-token]",
  },
  {
    name: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    replace: "[REDACTED:bearer-token]",
  },
  {
    name: "credential-assignment",
    pattern:
      /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b(\s*[:=]\s*)(["']?)(?!\[REDACTED:)[^\s"',;]{8,}\3/gi,
    replace: (_match, key: string, separator: string, quote: string) =>
      `${key}${separator}${quote}[REDACTED:credential]${quote}`,
  },
];

/* eslint-disable no-control-regex -- filtering ANSI/C0/C1 controls requires matching them */
function stripTerminalControls(text: string): string {
  return (
    text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\u001B[@-_]/g, "")
      .replace(/\u001B./g, "")
      // C0 controls except tab and newline, DEL and C1 controls.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
      // Bidirectional overrides can visually reorder forged status lines.
      .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
  );
}
/* eslint-enable no-control-regex */

function escapeProvenanceMarkers(text: string): string {
  return text
    .replace(/\[\/android-mcp:untrusted-data\]/g, "[escaped:/android-mcp:untrusted-data]")
    .replace(/\[android-mcp:untrusted-data/g, "[escaped:android-mcp:untrusted-data");
}

export function redactSecrets(text: string): { text: string; redacted: number } {
  let redacted = 0;
  let out = text;
  for (const rule of REDACTION_RULES) {
    out = out.replace(rule.pattern, (match: string, ...groups: string[]) => {
      redacted += 1;
      if (typeof rule.replace === "function") {
        return rule.replace(match, ...groups);
      }
      return rule.replace;
    });
  }
  return { text: out, redacted };
}

/**
 * Normalize untrusted payload for presentation. Raw evidence is preserved as
 * far as the configured bound allows; truncation and redaction are explicit.
 */
export function sanitizeUntrusted(
  text: string,
  opts: { maxChars?: number; tool?: string; source?: SourceCategory } = {},
): SanitizedText {
  const maxChars = Math.max(200, opts.maxChars ?? DEFAULT_MAX_CHARS);
  const normalized = escapeProvenanceMarkers(stripTerminalControls(text));
  const { text: safe, redacted } = redactSecrets(normalized);
  if (safe.length <= maxChars) return { text: safe, truncated: false, redacted };
  const removed = safe.length - maxChars;
  const marker = `\n…[truncated ${removed} chars; tool=${opts.tool ?? "unknown"} source=${
    opts.source ?? "mixed"
  }]`;
  return { text: `${safe.slice(0, maxChars)}${marker}`, truncated: true, redacted };
}

export function frameUntrusted(
  text: string,
  opts: { tool: string; source: SourceCategory; target?: string | null },
): string {
  // Targets come from caller-supplied arguments, so apply the same marker and
  // control filtering as the payload before placing them in the trusted header.
  const target = opts.target
    ? ` target=${JSON.stringify(escapeProvenanceMarkers(stripTerminalControls(opts.target)))}`
    : "";
  return `${UNTRUSTED_BEGIN} tool=${JSON.stringify(opts.tool)} source=${JSON.stringify(
    opts.source,
  )}${target} trust=untrusted]\n${text}\n${UNTRUSTED_END}`;
}

export interface ResultOptions {
  target?: string | null;
  source?: SourceCategory;
  now?: Date;
  maxChars?: number;
}

/**
 * Attach provenance to a tool result. MCP-owned results (source "mcp") stay
 * trusted and unframed; everything project/device/subprocess-derived is
 * sanitized and framed as data.
 */
export function presentResult(
  tool: string,
  result: CallToolResult,
  opts: ResultOptions = {},
): CallToolResult {
  const source = opts.source ?? TOOL_SOURCES[tool] ?? "mixed";
  const now = opts.now ?? new Date();
  const trusted = source === "mcp";
  let truncated = false;
  let redacted = 0;

  const content = Array.isArray(result.content)
    ? result.content.map((block: ContentBlock) => {
        if (block?.type !== "text" || typeof block.text !== "string") return block;
        if (trusted) return block;
        const sanitized = sanitizeUntrusted(block.text, {
          maxChars: opts.maxChars,
          tool,
          source,
        });
        truncated = truncated || sanitized.truncated;
        redacted += sanitized.redacted;
        return {
          ...block,
          text: frameUntrusted(sanitized.text, { tool, source, target: opts.target }),
        };
      })
    : result.content;

  return {
    ...result,
    content,
    isError: result?.isError === true,
    _meta: {
      ...(result?._meta ?? {}),
      provenance: {
        tool,
        source,
        trust: trusted ? "mcp" : "untrusted-data",
        untrusted: !trusted,
        target: opts.target ?? null,
        timestamp: now.toISOString(),
        truncated,
        redactions: redacted,
      },
    },
  };
}
