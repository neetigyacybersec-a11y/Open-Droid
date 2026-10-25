import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";

const proc = spawn("node", ["dist/index.js"], { stdio: ["pipe", "pipe", "pipe"] });
let out = "";
proc.stdout.on("data", (d) => { out += d.toString(); });

const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
proc.stdin.write(init + "\n");
proc.stdin.write(list + "\n");

setTimeout(() => {
  proc.kill();
  const lines = out.trim().split("\n").map((l) => JSON.parse(l));
  const tools = lines.find((l) => l.id === 2)?.result?.tools;
  assert.ok(Array.isArray(tools) && tools.length >= 10, "expected >=10 tools");
  console.log("smoke test passed:", tools.length, "tools");
}, 2000);
