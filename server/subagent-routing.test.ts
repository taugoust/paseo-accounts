import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createSubagentRoutingHandlers } from "./subagent-routing";

const agentId = "pi-agent";
const runtimeEpoch = randomUUID();
const identity = {
  agentId,
  sessionId: "session",
  runtimeEpoch,
  serviceEpoch: "service",
};
const target = { agentId, workspaceId: "workspace" };

let root: string;
let previousHome: string | undefined;
let server: Server | undefined;
let requests: any[];

function contextFor(agents: () => { id: string }) {
  const refresh = async () => ({
    agent: { ...agents(), workspaceId: "workspace", provider: "pi" },
  });
  return { paseo: { agents: { ref: () => ({ refresh }) } } } as never;
}
const context = contextFor(() => ({ id: agentId }));

/** What the fake bridge answers for each operation. */
function reply(request: any) {
  const snapshot = { protocol: 1, sessionId: "session", serviceEpoch: "service" };
  switch (request.operation) {
    case "providers":
      return ["openai", "openai-codex"];
    case "set":
      return { ...snapshot, revision: 3, selection: request.selection };
    default:
      return { ...snapshot, revision: 2, selection: null };
  }
}

/** A private descriptor in the subagents directory, as the bridge writes it. */
async function writeDescriptor(socketPath: string) {
  const bridge = join(root, ".pi", "paseo-bridge");
  const operators = join(bridge, "subagents", "operators");
  await mkdir(operators, { recursive: true });
  for (const dir of [join(root, ".pi"), bridge, join(bridge, "subagents"), operators]) {
    await chmod(dir, 0o700);
  }
  const name = `${createHash("sha256").update(agentId).digest("hex")}.accounts.json`;
  const descriptor = { version: 1, socketPath, capability: "a".repeat(64), ...identity };
  await writeFile(join(operators, name), JSON.stringify(descriptor), { mode: 0o600 });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "subagent-routing-"));
  previousHome = process.env.HOME;
  process.env.HOME = root;
  requests = [];

  const socketPath = join(root, "routing.sock");
  server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const frame = JSON.parse(buffer.trim());
      requests.push(frame);
      const response = {
        v: 1,
        type: "subagent_routing",
        id: frame.id,
        success: true,
        ...identity,
        data: reply(frame.request),
      };
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
  await chmod(socketPath, 0o600);
  await writeDescriptor(socketPath);
});

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve));
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

it("reads the snapshot and providers over the subagent routing socket", async () => {
  const result = await createSubagentRoutingHandlers().status(target, context);

  expect(result).toMatchObject({
    available: true,
    providers: ["openai", "openai-codex"],
    snapshot: { sessionId: "session", selection: null },
  });
  expect(requests.every((frame) => frame.type === "subagent_routing")).toBe(true);
  const operations = requests.map((frame) => frame.request.operation).sort();
  expect(operations).toEqual(["providers", "snapshot"]);
});

it("reports unavailable when the agent changes while loading", async () => {
  let refreshes = 0;
  const changing = contextFor(() => ({ id: ++refreshes === 1 ? agentId : "other-agent" }));

  const result = await createSubagentRoutingHandlers().status(target, changing);

  expect(result.available).toBe(false);
});

it("sets the selection for the checked session", async () => {
  const selection = { providerId: "openai", accountId: null };
  const result = await createSubagentRoutingHandlers().set({
    ...target,
    expectedRuntimeEpoch: runtimeEpoch,
    request: {
      expectedSessionId: "session",
      expectedServiceEpoch: "service",
      expectedRevision: 2,
      selection,
    },
  }, context);

  expect(result).toMatchObject({ revision: 3, selection });
  expect(requests[0]?.request).toMatchObject({
    operation: "set",
    sessionId: "session",
    serviceEpoch: "service",
    expectedRevision: 2,
    selection,
  });
});

it("refuses a set for a session that has changed", async () => {
  const handlers = createSubagentRoutingHandlers();
  const request = {
    expectedSessionId: "old-session",
    expectedServiceEpoch: "service",
    expectedRevision: 2,
    selection: null,
  };

  await expect(handlers.set({ ...target, expectedRuntimeEpoch: runtimeEpoch, request }, context))
    .rejects.toThrow();
  expect(requests).toHaveLength(0);
});
