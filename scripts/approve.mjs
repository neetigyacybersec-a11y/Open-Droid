#!/usr/bin/env node
// ISSUE-50: sign one exact approval request out of band. The MCP server has no
// confirmation UI; a human or host reviews the blocked result's preview and
// runs this command on the server host with the shared secret.
//
// Usage:
//   ANDROID_MCP_APPROVAL_SECRET=... npm run approve -- '<approval-request>'
//   ANDROID_MCP_APPROVAL_SECRET=... node scripts/approve.mjs --json '<request>'
//
// The printed token is single-use, expires, and only authorizes the tool,
// target and arguments recorded in the request.
import { decodeApprovalRequest, signApprovalRequest } from "../dist/executionPolicy.js";

function usage(stream = process.stderr) {
  stream.write(
    [
      "usage: ANDROID_MCP_APPROVAL_SECRET=<32+ chars> npm run approve -- '<approval-request>'",
      "",
      "The request string is printed as approval-request=... in a blocked tool result.",
      "Pass the printed token to the retried tool call as `approvalToken`.",
      "",
    ].join("\n"),
  );
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
  usage(argv.length === 0 ? process.stderr : process.stdout);
  process.exit(argv.length === 0 ? 2 : 0);
}
if (argv.includes("--version")) {
  process.stdout.write("android-mcp approval signer\n");
  process.exit(0);
}

const json = argv.includes("--json");
const requestArg = argv.find((arg) => !arg.startsWith("--"));
if (!requestArg) {
  process.stderr.write("approve: missing approval request\n");
  usage();
  process.exit(2);
}

const secret = process.env.ANDROID_MCP_APPROVAL_SECRET ?? "";
if (!secret) {
  process.stderr.write(
    "approve: ANDROID_MCP_APPROVAL_SECRET is not set; use the same secret as the server\n",
  );
  process.exit(2);
}

try {
  const request = decodeApprovalRequest(requestArg);
  const token = signApprovalRequest(request, secret);
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          token,
          request,
          passAs: "approvalToken",
          singleUse: true,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${token}\n`);
  }
} catch (error) {
  process.stderr.write(`approve: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
