import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { accountControlsStatusRpc, PI_PROVIDER, subagentSnapshotSchema, subagentRoutingSetRpc, subagentRoutingStatusRpc } from "../shared/pi-native";
import { createAccountControlsHandlers } from "./pi-native";

interface Descriptor {
  version: 1; socketPath: string; capability: string; agentId: string;
  sessionId: string; runtimeEpoch: string; serviceEpoch: string;
}
const descriptorPath = (agentId: string) => join(homedir(), ".pi", "paseo-bridge", "operators", `${createHash("sha256").update(agentId).digest("hex")}.subagents.json`);
async function readDescriptor(agentId: string): Promise<Descriptor | undefined> {
  try {
    const dir = join(homedir(), ".pi", "paseo-bridge", "operators"), ds = await lstat(dir);
    if (!ds.isDirectory() || ds.isSymbolicLink() || (typeof process.getuid === "function" && ds.uid !== process.getuid()) || (ds.mode & 0o777) !== 0o700) return;
    const handle = await open(descriptorPath(agentId), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const st = await handle.stat();
      if (!st.isFile() || (typeof process.getuid === "function" && st.uid !== process.getuid()) || (st.mode & 0o777) !== 0o600 || st.size > 4096) return;
      const d = JSON.parse(await handle.readFile("utf8"));
      if (!d || typeof d !== "object" || Array.isArray(d) || Object.keys(d).sort().join(",") !== "agentId,capability,runtimeEpoch,serviceEpoch,sessionId,socketPath,version" || d.version !== 1 || d.agentId !== agentId || typeof d.socketPath !== "string" || !d.socketPath.startsWith("/") || d.socketPath.length > 4096 || typeof d.capability !== "string" || !/^[a-f0-9]{64}$/.test(d.capability) || typeof d.sessionId !== "string" || !d.sessionId || d.sessionId.length > 256 || typeof d.runtimeEpoch !== "string" || !/^[a-f0-9-]{36}$/.test(d.runtimeEpoch) || typeof d.serviceEpoch !== "string" || !d.serviceEpoch || d.serviceEpoch.length > 256) return;
      return d as Descriptor;
    } finally { await handle.close(); }
  } catch { return; }
}
function callBridge(d: Descriptor, request: Record<string, unknown>): Promise<unknown> {
  const id = randomUUID(), frame = `${JSON.stringify({ v: 1, type: "subagent_routing", id, capability: d.capability, agentId: d.agentId, sessionId: d.sessionId, runtimeEpoch: d.runtimeEpoch, serviceEpoch: d.serviceEpoch, request })}\n`;
  if (Buffer.byteLength(frame) > 32 * 1024) throw new Error("Request too large");
  return new Promise((resolve, reject) => {
    let socket: ReturnType<typeof connect> | undefined, buffer = "", settled = false;
    const decoder = new StringDecoder("utf8"), timer = setTimeout(() => finish(new Error("Timed out")), 15_000);
    const finish = (error?: Error, data?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); socket?.destroy(); error ? reject(error) : resolve(data); };
    void (async () => {
      try {
        const st = await lstat(d.socketPath);
        if (!st.isSocket() || (typeof process.getuid === "function" && st.uid !== process.getuid()) || (st.mode & 0o777) !== 0o600) throw new Error("Socket is not private");
        socket = connect(d.socketPath); socket.setTimeout(15_000, () => finish(new Error("Timed out")));
        socket.once("error", error => finish(error)); socket.once("connect", () => socket!.write(frame));
        socket.on("data", chunk => {
          buffer += decoder.write(chunk); if (Buffer.byteLength(buffer) > 128 * 1024) return finish(new Error("Response too large"));
          const nl = buffer.indexOf("\n"); if (nl < 0) return;
          try {
            if (nl !== buffer.length - 1) throw new Error("Unexpected framing");
            const reply = JSON.parse(buffer.slice(0, nl));
            if (!reply || reply.v !== 1 || reply.type !== "subagent_routing" || reply.id !== id || typeof reply.success !== "boolean") throw new Error("Invalid response");
            if (!reply.success) throw new Error(typeof reply.error === "string" ? reply.error : "Request failed");
            if (reply.agentId !== d.agentId || reply.sessionId !== d.sessionId || reply.runtimeEpoch !== d.runtimeEpoch || reply.serviceEpoch !== d.serviceEpoch) throw new Error("Identity mismatch");
            finish(undefined, reply.data);
          } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
        });
        socket.once("end", () => { buffer += decoder.end(); if (!settled) finish(new Error("Bridge closed")); });
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    })();
  });
}
const shortError = (error: unknown) => {
  const message = error instanceof Error ? error.message : "Subagent settings unavailable";
  return ["stale-service", "stale-session", "stale-selection"].includes(message) ? "Session changed. Refresh to retry." : "Subagent settings unavailable. Refresh to retry.";
};
async function validate(input: { agentId: string; workspaceId: string }, context: PluginHandlerContext) {
  const current = await context.paseo.agents.ref(input.agentId).refresh();
  if (!current || current.agent.id !== input.agentId || current.agent.workspaceId !== input.workspaceId || current.agent.provider !== "pi") throw new Error("Pi agent changed");
}
function same(a: Descriptor | undefined, d: Descriptor) { return !!a && a.sessionId === d.sessionId && a.runtimeEpoch === d.runtimeEpoch && a.serviceEpoch === d.serviceEpoch; }

export function createSubagentRoutingHandlers() {
  const accounts = createAccountControlsHandlers();
  return {
    status: async (input: { agentId: string; workspaceId: string }, context: PluginHandlerContext) => {
      await validate(input, context);
      const d = await readDescriptor(input.agentId);
      if (!d) return { available: false, sessionId: null, runtimeEpoch: null, snapshot: null, providers: [], codexAccounts: [], reason: "Subagent routing unavailable" };
      try {
        const [snapshot, providers] = await Promise.all([
          callBridge(d, { operation: "snapshot", sessionId: d.sessionId }),
          callBridge(d, { operation: "providers", sessionId: d.sessionId }),
        ]);
        const latest = await readDescriptor(input.agentId);
        const parsedSnapshot = subagentSnapshotSchema.parse(snapshot);
        if (!same(latest, d) || !Array.isArray(providers) || !providers.every(p => typeof p === "string" && p.length > 0 && p.length <= 128) || new Set(providers).size !== providers.length || providers.some((provider, index) => index > 0 && providers[index - 1]! >= provider) || parsedSnapshot.sessionId !== d.sessionId || parsedSnapshot.serviceEpoch !== d.serviceEpoch) throw new Error("invalid-response");
        let codexAccounts: { id: string; label: string }[] = [];
        if ((providers as string[]).includes(PI_PROVIDER)) {
          const accountStatus = await accounts.status({ ...input, providerId: PI_PROVIDER }, context);
          if (accountStatus.available && accountStatus.snapshot && accountStatus.sessionId === d.sessionId && accountStatus.runtimeEpoch === d.runtimeEpoch && accountStatus.snapshot.sessionId === d.sessionId) codexAccounts = accountStatus.snapshot.accounts.map(account => ({ id: account.id, label: account.label }));
          else if (accountStatus.available) throw new Error("stale-session");
        }
        const finalDescriptor = await readDescriptor(input.agentId);
        if (!same(finalDescriptor, d)) throw new Error("stale-session");
        await validate(input, context);
        return { available: true, sessionId: d.sessionId, runtimeEpoch: d.runtimeEpoch, snapshot: parsedSnapshot, providers: providers as string[], codexAccounts, reason: null };
      } catch (error) {
        return { available: false, sessionId: d.sessionId, runtimeEpoch: d.runtimeEpoch, snapshot: null, providers: [], codexAccounts: [], reason: shortError(error) };
      }
    },
    set: async (input: { agentId: string; workspaceId: string; expectedRuntimeEpoch: string; request: { expectedSessionId: string; expectedServiceEpoch: string; expectedRevision: number; selection: { providerId: string; accountId: string | null } | null } }, context: PluginHandlerContext) => {
      await validate(input, context);
      const d = await readDescriptor(input.agentId);
      if (!d || d.sessionId !== input.request.expectedSessionId || d.runtimeEpoch !== input.expectedRuntimeEpoch || d.serviceEpoch !== input.request.expectedServiceEpoch) throw new Error("Session changed. Refresh to retry.");
      const snapshot = await callBridge(d, { operation: "set", request: input.request });
      const latest = await readDescriptor(input.agentId);
      const parsedSnapshot = subagentSnapshotSchema.parse(snapshot);
      if (!same(latest, d) || parsedSnapshot.sessionId !== d.sessionId || parsedSnapshot.serviceEpoch !== d.serviceEpoch) throw new Error("Session changed. Refresh to retry.");
      await validate(input, context);
      return parsedSnapshot;
    },
  };
}
