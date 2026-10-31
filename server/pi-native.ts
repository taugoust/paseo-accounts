// Private transport adapted from paseo-bridge-pi/plugin/server/account-controls-transport.ts.
// Server-side only: capability values and credential data never reach client views.
import { createHash, randomUUID } from "node:crypto";
import { constants, lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { validateDefaultProviderSwitch } from "./pi-provider-guard";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  accountControlsStatusRpc,
  accountControlsSwitchRpc,
  piSnapshotSchema,
  piSwitchResultSchema,
} from "../shared/pi-native";

interface Descriptor {
  version: 1;
  socketPath: string;
  capability: string;
  agentId: string;
  sessionId: string;
  runtimeEpoch: string;
  serviceEpoch: string;
}
function descriptorPath(agentId: string): string {
  return join(
    homedir(),
    ".pi",
    "paseo-bridge",
    "operators",
    `${createHash("sha256").update(agentId).digest("hex")}.accounts.json`,
  );
}
async function readDescriptor(agentId: string): Promise<unknown> {
  try {
    const dir = join(homedir(), ".pi", "paseo-bridge", "operators");
    const ds = await lstat(dir);
    if (
      !ds.isDirectory() ||
      ds.isSymbolicLink() ||
      (typeof process.getuid === "function" && ds.uid !== process.getuid()) ||
      (ds.mode & 0o777) !== 0o700
    )
      return undefined;
    const handle = await open(
      descriptorPath(agentId),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const st = await handle.stat();
      if (
        !st.isFile() ||
        (typeof process.getuid === "function" && st.uid !== process.getuid()) ||
        (st.mode & 0o777) !== 0o600 ||
        st.size > 4096
      )
        return undefined;
      return JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}
function validDescriptor(value: unknown, agentId: string): value is Descriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  return (
    Object.keys(d).sort().join(",") ===
      "agentId,capability,runtimeEpoch,serviceEpoch,sessionId,socketPath,version" &&
    d.version === 1 &&
    d.agentId === agentId &&
    typeof d.socketPath === "string" &&
    d.socketPath.startsWith("/") &&
    d.socketPath.length <= 4096 &&
    typeof d.capability === "string" &&
    /^[a-f0-9]{64}$/.test(d.capability) &&
    typeof d.sessionId === "string" &&
    d.sessionId.length > 0 &&
    d.sessionId.length <= 256 &&
    typeof d.runtimeEpoch === "string" &&
    /^[a-f0-9-]{36}$/.test(d.runtimeEpoch) &&
    typeof d.serviceEpoch === "string" &&
    d.serviceEpoch.length > 0 &&
    d.serviceEpoch.length <= 256
  );
}
function callBridge(
  d: Descriptor,
  body: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<unknown> {
  const id = randomUUID();
  const frame = `${JSON.stringify({ v: 1, type: "account_controls", id, capability: d.capability, agentId: d.agentId, sessionId: d.sessionId, runtimeEpoch: d.runtimeEpoch, serviceEpoch: d.serviceEpoch, request: body })}\n`;
  if (Buffer.byteLength(frame) > 32 * 1024)
    throw new Error("Oversized account-controls request");
  return new Promise((resolve, reject) => {
    let socket: ReturnType<typeof connect> | undefined,
      settled = false,
      buffer = "";
    const decoder = new StringDecoder("utf8");
    const timer = setTimeout(
      () => finish(new Error("Account-controls request timed out")),
      timeoutMs,
    );
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      error ? reject(error) : resolve(value);
    };
    void (async () => {
      try {
        const st = await lstat(d.socketPath);
        if (
          !st.isSocket() ||
          (typeof process.getuid === "function" &&
            st.uid !== process.getuid()) ||
          (st.mode & 0o777) !== 0o600
        )
          throw new Error("Account-controls socket is not private");
        socket = connect(d.socketPath);
        socket.setTimeout(timeoutMs, () =>
          finish(new Error("Account-controls request timed out")),
        );
        socket.once("error", (error) => finish(error));
        socket.once("connect", () => socket!.write(frame));
        socket.on("data", (chunk) => {
          buffer += decoder.write(chunk);
          if (Buffer.byteLength(buffer) > 128 * 1024)
            return finish(new Error("Oversized account-controls response"));
          const nl = buffer.indexOf("\n");
          if (nl < 0) return;
          try {
            if (nl !== buffer.length - 1)
              throw new Error("Unexpected account-controls framing");
            const reply = JSON.parse(buffer.slice(0, nl));
            if (
              !reply ||
              reply.v !== 1 ||
              reply.type !== "account_controls" ||
              reply.id !== id ||
              typeof reply.success !== "boolean"
            )
              throw new Error("Invalid account-controls response");
            if (!reply.success)
              throw new Error(
                typeof reply.error === "string"
                  ? reply.error
                  : "Account-controls request failed",
              );
            if (
              reply.agentId !== d.agentId ||
              reply.sessionId !== d.sessionId ||
              reply.runtimeEpoch !== d.runtimeEpoch ||
              reply.serviceEpoch !== d.serviceEpoch
            )
              throw new Error("Account-controls identity mismatch");
            finish(undefined, reply.data);
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        });
        socket.once("end", () => {
          buffer += decoder.end();
          if (!settled)
            finish(
              new Error("Account-controls bridge closed without response"),
            );
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

export function createAccountControlsHandlers() {
  async function validate(
    input: { agentId: string; workspaceId: string },
    context: PluginHandlerContext,
  ) {
    const current = await context.paseo.agents.ref(input.agentId).refresh();
    if (
      !current ||
      current.agent.id !== input.agentId ||
      current.agent.workspaceId !== input.workspaceId ||
      current.agent.provider !== "pi"
    )
      throw new Error(
        "Account-controls request does not match current Pi agent workspace.",
      );
  }
  return {
    manage: async (
      request: Record<string, unknown>,
      context: PluginHandlerContext,
    ) => {
      const agents = await context.paseo.agents.list({ page: { limit: 200 } });
      const candidates = agents.entries
        .map(({ agent }) => agent)
        .filter(
          (agent) =>
            agent.provider === "pi" &&
            !agent.archivedAt &&
            !(["running", "initializing", "closed"] as string[]).includes(
              agent.status,
            ) &&
            !!agent.workspaceId,
        );
      let lastError = "No idle Pi session is available to manage accounts.";
      for (const agent of candidates) {
        await validate(
          { agentId: agent.id, workspaceId: agent.workspaceId! },
          context,
        );
        const d = await readDescriptor(agent.id);
        if (!validDescriptor(d, agent.id)) continue;
        try {
          if (request.providerId === "openai-codex") {
            const preflight = piSnapshotSchema.parse(
              await callBridge(d, {
                operation: "snapshot",
                sessionId: d.sessionId,
                providerId: "openai-codex",
              }),
            );
            if (
              preflight.providerId !== "openai-codex" ||
              !preflight.supportedProviders?.includes("openai-codex")
            )
              throw new Error(
                "Pi service does not support Codex management; no mutation was sent.",
              );
            await validate(
              { agentId: agent.id, workspaceId: agent.workspaceId! },
              context,
            );
            const latest = await readDescriptor(agent.id);
            if (
              !validDescriptor(latest, agent.id) ||
              latest.sessionId !== d.sessionId ||
              latest.runtimeEpoch !== d.runtimeEpoch ||
              latest.serviceEpoch !== d.serviceEpoch
            )
              throw new Error(
                "Pi session changed during Codex preflight; no management request was sent.",
              );
          }
          const result = await callBridge(
            d,
            {
              operation: "manage",
              request: { ...request, sessionId: d.sessionId },
            },
            15 * 60_000,
          );
          await validate(
            { agentId: agent.id, workspaceId: agent.workspaceId! },
            context,
          );
          const latest = await readDescriptor(agent.id);
          if (
            !validDescriptor(latest, agent.id) ||
            latest.sessionId !== d.sessionId ||
            latest.runtimeEpoch !== d.runtimeEpoch ||
            latest.serviceEpoch !== d.serviceEpoch
          )
            throw new Error("Pi account service changed during management.");
          return result;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      throw new Error(lastError);
    },
    status: async (
      input: RpcInput<typeof accountControlsStatusRpc>,
      context: PluginHandlerContext,
    ) => {
      await validate(input, context);
      const d = await readDescriptor(input.agentId);
      if (!validDescriptor(d, input.agentId))
        return {
          available: false,
          sessionId: null,
          runtimeEpoch: null,
          snapshot: null,
          reason:
            "Native Pi account controls are unavailable. Use /accounts in the Pi terminal for unsupported account management.",
        };
      try {
        const requestedProvider = input.providerId ?? "openai";
        const snapshot = piSnapshotSchema.parse(
          await callBridge(d, {
            operation: "snapshot",
            sessionId: d.sessionId,
            ...(input.providerId ? { providerId: input.providerId } : {}),
          }),
        );
        const returnedProvider = snapshot.providerId ?? "openai";
        if (returnedProvider !== requestedProvider)
          throw new Error("Pi service returned a mismatched provider.");
        if (
          requestedProvider === "openai-codex" &&
          !snapshot.supportedProviders?.includes(requestedProvider)
        )
          throw new Error(
            "Pi service does not support Codex provider queries.",
          );
        await validate(input, context);
        const latest = await readDescriptor(input.agentId);
        if (
          !validDescriptor(latest, input.agentId) ||
          latest.sessionId !== d.sessionId ||
          latest.runtimeEpoch !== d.runtimeEpoch ||
          latest.serviceEpoch !== d.serviceEpoch ||
          snapshot.sessionId !== d.sessionId ||
          snapshot.serviceEpoch !== d.serviceEpoch
        )
          throw new Error("Stale native account-controls identity");
        return {
          available: true,
          sessionId: d.sessionId,
          runtimeEpoch: d.runtimeEpoch,
          snapshot,
          reason: null,
        };
      } catch {
        return {
          available: false,
          sessionId: d.sessionId,
          runtimeEpoch: d.runtimeEpoch,
          snapshot: null,
          reason:
            "Native Pi account controls are unavailable. Refresh to retry.",
        };
      }
    },
    switch: async (
      input: RpcInput<typeof accountControlsSwitchRpc>,
      context: PluginHandlerContext,
    ) => {
      await validate(input, context);
      const d = await readDescriptor(input.agentId);
      if (
        !validDescriptor(d, input.agentId) ||
        d.sessionId !== input.expectedSessionId ||
        d.runtimeEpoch !== input.expectedRuntimeEpoch ||
        d.serviceEpoch !== input.request.expectedServiceEpoch
      )
        throw new Error(
          "The active Pi session changed. Refresh before switching accounts.",
        );
      const requestedProvider = input.request.providerId ?? "openai";
      if (requestedProvider === "openai-codex" && !input.request.providerId)
        throw new Error("Codex provider identity is required.");
      if (requestedProvider === "openai-codex") {
        const preflight = piSnapshotSchema.parse(
          await callBridge(d, {
            operation: "snapshot",
            sessionId: d.sessionId,
            providerId: "openai-codex",
          }),
        );
        if (
          preflight.providerId !== "openai-codex" ||
          !preflight.supportedProviders?.includes("openai-codex") ||
          preflight.serviceEpoch !== input.request.expectedServiceEpoch ||
          preflight.selectionRevision !==
            input.request.expectedSelectionRevision
        )
          throw new Error(
            "Codex provider support or selection changed; no switch was sent.",
          );
        await validate(input, context);
        const latest = await readDescriptor(input.agentId);
        if (
          !validDescriptor(latest, input.agentId) ||
          latest.sessionId !== d.sessionId ||
          latest.runtimeEpoch !== d.runtimeEpoch ||
          latest.serviceEpoch !== d.serviceEpoch
        )
          throw new Error(
            "Pi session changed during Codex preflight; no switch was sent.",
          );
      }
      if (input.request.expectedDefaultSource) {
        await validateDefaultProviderSwitch(input, async (providerId) =>
          piSnapshotSchema.parse(await callBridge(d, {
            operation: "snapshot", sessionId: d.sessionId, providerId,
          })),
        );
        await validate(input, context);
        const latest = await readDescriptor(input.agentId);
        if (!validDescriptor(latest, input.agentId) ||
            latest.sessionId !== d.sessionId ||
            latest.runtimeEpoch !== d.runtimeEpoch ||
            latest.serviceEpoch !== d.serviceEpoch)
          throw new Error("Pi service changed during default-only provider preflight; no switch was sent.");
      }
      const parsed = piSwitchResultSchema.parse(
        await callBridge(d, { operation: "switch", request: input.request }),
      );
      if (
        (parsed.snapshot.providerId ?? "openai") !== requestedProvider ||
        (requestedProvider === "openai-codex" &&
          !parsed.snapshot.supportedProviders?.includes(requestedProvider))
      )
        throw new Error(
          "Pi service returned a mismatched provider after switch.",
        );
      if (
        parsed.requestId !== input.request.requestId ||
        parsed.snapshot.sessionId !== d.sessionId ||
        parsed.snapshot.serviceEpoch !== d.serviceEpoch
      )
        throw new Error("Account-controls service identity mismatch.");
      await validate(input, context);
      const latest = await readDescriptor(input.agentId);
      if (
        !validDescriptor(latest, input.agentId) ||
        latest.sessionId !== d.sessionId ||
        latest.runtimeEpoch !== d.runtimeEpoch ||
        latest.serviceEpoch !== d.serviceEpoch
      )
        throw new Error(
          "The active Pi or account-controls service changed during the request.",
        );
      return parsed;
    },
  };
}
