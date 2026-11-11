import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createAccountControlsHandlers } from "./pi-native";

const AGENT = "agent-1";
const target = { agentId: AGENT, workspaceId: "w", providerId: "openai-codex" as const };
let root: string;
let previousHome: string | undefined;
let server: Server | undefined;
let frames: Array<{ operation: string; [key: string]: unknown }>;
let snapshotProvider: string;
const descriptor = {
  version: 1,
  socketPath: "",
  capability: "a".repeat(64),
  agentId: AGENT,
  sessionId: "session",
  runtimeEpoch: "11111111-1111-4111-8111-111111111111",
  serviceEpoch: "service",
};
const snapshot = () => ({
  protocol: 1,
  serviceEpoch: "service",
  selectionRevision: 2,
  sessionId: "session",
  accounts: [{ id: "work", label: "Work", authKind: "oauth" }],
  providerId: snapshotProvider,
  currentAccountId: null,
  defaultSelected: true,
  activationStatus: "active",
  busy: false,
  canSwitch: true,
  usage: {
    effectiveCredential: "unknown",
    status: "unknown",
    remoteEntitlement: "not-queried",
    settingsUrl: null,
  },
});
const context = {
  paseo: {
    agents: {
      ref: () => ({
        refresh: async () => ({
          agent: { id: AGENT, workspaceId: "w", provider: "pi", status: "idle" },
        }),
      }),
      list: async () => ({
        entries: [{ agent: { id: AGENT, workspaceId: "w", provider: "pi", status: "idle" } }],
        pageInfo: { hasMore: false },
      }),
    },
  },
} as never;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-controls-"));
  previousHome = process.env.HOME;
  process.env.HOME = root;
  frames = [];
  snapshotProvider = "openai-codex";
  const operators = join(root, ".pi", "paseo-bridge", "operators");
  await mkdir(operators, { recursive: true });
  for (const dir of [".pi", ".pi/paseo-bridge", ".pi/paseo-bridge/operators"])
    await chmod(join(root, dir), 0o700);
  descriptor.socketPath = join(root, "controls.sock");
  server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const frame = JSON.parse(buffer.trim());
      const request = frame.request;
      frames.push(request);
      const data =
        request.operation === "switch"
          ? { ok: true, requestId: request.request.requestId, snapshot: snapshot() }
          : request.operation === "manage"
            ? { ok: true }
            : snapshot();
      socket.end(
        `${JSON.stringify({
          v: 1,
          type: "account_controls",
          id: frame.id,
          success: true,
          agentId: AGENT,
          sessionId: descriptor.sessionId,
          runtimeEpoch: descriptor.runtimeEpoch,
          serviceEpoch: descriptor.serviceEpoch,
          data,
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server!.listen(descriptor.socketPath, resolve));
  await chmod(descriptor.socketPath, 0o600);
  const name = `${createHash("sha256").update(AGENT).digest("hex")}.accounts.json`;
  await writeFile(join(operators, name), JSON.stringify(descriptor), { mode: 0o600 });
});

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve));
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

it("asks for and accepts only Codex snapshots", async () => {
  const controls = createAccountControlsHandlers();
  const status = await controls.status(target, context);
  expect(status).toMatchObject({ available: true, snapshot: { providerId: "openai-codex" } });
  expect(frames).toEqual([
    { operation: "snapshot", sessionId: "session", providerId: "openai-codex" },
  ]);
  snapshotProvider = "openai";
  expect(await controls.status(target, context)).toMatchObject({
    available: false,
    snapshot: null,
  });
});

it("sends account switches and management for the Codex provider", async () => {
  const controls = createAccountControlsHandlers();
  const requestId = randomUUID();
  const result = await controls.switch(
    {
      ...target,
      expectedSessionId: "session",
      expectedRuntimeEpoch: descriptor.runtimeEpoch,
      request: {
        protocol: 1,
        requestId,
        expectedSessionId: "session",
        expectedServiceEpoch: "service",
        expectedSelectionRevision: 2,
        accountId: "work",
        providerId: "openai-codex",
      },
    },
    context,
  );
  expect(result).toMatchObject({ ok: true, requestId });
  await controls.manage({ operation: "default", accountId: "work" }, context);
  expect(frames).toEqual([
    {
      operation: "switch",
      request: expect.objectContaining({ providerId: "openai-codex", accountId: "work" }),
    },
    {
      operation: "manage",
      request: {
        operation: "default",
        accountId: "work",
        providerId: "openai-codex",
        sessionId: "session",
      },
    },
  ]);
});
