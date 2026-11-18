import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createSubagentRoutingHandlers } from "./subagent-routing";

const agentId = "pi-agent";
const runtimeEpoch = randomUUID();
const descriptor = { version: 1, socketPath: "", capability: "a".repeat(64), agentId, sessionId: "session", runtimeEpoch, serviceEpoch: "service" };
let root: string, home: string | undefined, server: Server | undefined, requests: any[];
const context = { paseo: { agents: { ref: () => ({ refresh: async () => ({ agent: { id: agentId, workspaceId: "workspace", provider: "pi" } }) }) } } } as never;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "subagent-routing-")); home = process.env.HOME; process.env.HOME = root; requests = [];
  const operators = join(root, ".pi", "paseo-bridge", "operators"); await mkdir(operators, { recursive: true });
  for (const path of [".pi", ".pi/paseo-bridge", ".pi/paseo-bridge/operators"]) await chmod(join(root, path), 0o700);
  descriptor.socketPath = join(root, "routing.sock");
  server = createServer(socket => { let buffer = ""; socket.setEncoding("utf8"); socket.on("data", chunk => {
    buffer += chunk; if (!buffer.includes("\n")) return;
    const frame = JSON.parse(buffer.trim()); requests.push(frame);
    const data = frame.request.operation === "providers" ? ["openai", "openai-codex"] : frame.request.operation === "set" ? { protocol: 1, sessionId: "session", serviceEpoch: "service", revision: 3, selection: frame.request.request.selection } : { protocol: 1, sessionId: "session", serviceEpoch: "service", revision: 2, selection: null };
    socket.end(`${JSON.stringify({ v: 1, type: "subagent_routing", id: frame.id, success: true, agentId, sessionId: "session", runtimeEpoch, serviceEpoch: "service", data })}\n`);
  }); });
  await new Promise<void>(resolve => server!.listen(descriptor.socketPath, resolve)); await chmod(descriptor.socketPath, 0o600);
  const name = `${createHash("sha256").update(agentId).digest("hex")}.subagents.json`;
  await writeFile(join(operators, name), JSON.stringify(descriptor), { mode: 0o600 });
});
afterEach(async () => { await new Promise(resolve => server?.close(resolve)); if (home === undefined) delete process.env.HOME; else process.env.HOME = home; await rm(root, { recursive: true, force: true }); });

it("reads session snapshot and physical provider catalogue over independent routing frames", async () => {
  const result = await createSubagentRoutingHandlers().status({ agentId, workspaceId: "workspace" }, context);
  expect(result).toMatchObject({ available: true, providers: ["openai", "openai-codex"], snapshot: { sessionId: "session", selection: null } });
  expect(requests.map(frame => frame.type)).toEqual(["subagent_routing", "subagent_routing"]);
  expect(requests.map(frame => frame.request.operation).sort()).toEqual(["providers", "snapshot"]);
});
it("sets selection with the checked session routing identity", async () => {
  const result = await createSubagentRoutingHandlers().set({ agentId, workspaceId: "workspace", expectedRuntimeEpoch: runtimeEpoch, request: { expectedSessionId: "session", expectedServiceEpoch: "service", expectedRevision: 2, selection: { providerId: "openai", accountId: null } } }, context);
  expect(result).toMatchObject({ revision: 3, selection: { providerId: "openai", accountId: null } });
  expect(requests[0]?.request).toMatchObject({ operation: "set", request: { expectedSessionId: "session", expectedServiceEpoch: "service", expectedRevision: 2 } });
});
