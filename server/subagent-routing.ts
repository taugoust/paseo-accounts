// Reads and changes a Pi session's subagent provider through the bridge relay.
// Uses the same private descriptor and socket client as account controls.
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  PI_PROVIDER,
  subagentSnapshotSchema,
  type SubagentRoutingSnapshot,
  type SubagentRoutingStatus,
} from "../shared/pi-native";
import {
  bridgeDir,
  callBridge,
  createAccountControlsHandlers,
  readDescriptor,
  validDescriptor,
  type Descriptor,
} from "./pi-native";

const SESSION_CHANGED = "Session changed. Refresh to retry.";
const UNAVAILABLE = "Subagent settings unavailable. Refresh to retry.";

type Target = { agentId: string; workspaceId: string };
type SetInput = Target & {
  expectedRuntimeEpoch: string;
  request: {
    expectedSessionId: string;
    expectedServiceEpoch: string;
    expectedRevision: number;
    selection: SubagentRoutingSnapshot["selection"];
  };
};

async function readSubagentDescriptor(agentId: string): Promise<Descriptor | undefined> {
  const value = await readDescriptor(agentId, join(bridgeDir(), "subagents"));
  return validDescriptor(value, agentId) ? value : undefined;
}

function call(d: Descriptor, operation: string, extra: Record<string, unknown> = {}) {
  const request = { operation, sessionId: d.sessionId, serviceEpoch: d.serviceEpoch, ...extra };
  return callBridge(d, request, 15_000, "subagent_routing");
}

/** Throws unless the bridge still publishes the same session and runtime. */
async function assertSameSession(agentId: string, d: Descriptor) {
  const latest = await readSubagentDescriptor(agentId);
  const same = latest?.sessionId === d.sessionId
    && latest.runtimeEpoch === d.runtimeEpoch
    && latest.serviceEpoch === d.serviceEpoch;
  if (!same) throw new Error(SESSION_CHANGED);
}

/** Throws unless the agent is still the same Pi agent in the same workspace. */
async function assertSamePiAgent(input: Target, context: PluginHandlerContext) {
  const current = await context.paseo.agents.ref(input.agentId).refresh();
  const same = current?.agent.id === input.agentId
    && current.agent.workspaceId === input.workspaceId
    && current.agent.provider === "pi";
  if (!same) throw new Error("Pi agent changed");
}

/** A sorted list of distinct provider IDs, as the bridge sends it. */
function isProviderList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  return value.every((provider, index) =>
    typeof provider === "string"
    && provider.length > 0
    && provider.length <= 128
    && (index === 0 || value[index - 1] < provider));
}

function parseSnapshot(value: unknown, d: Descriptor): SubagentRoutingSnapshot {
  const snapshot = subagentSnapshotSchema.parse(value);
  if (snapshot.sessionId !== d.sessionId || snapshot.serviceEpoch !== d.serviceEpoch) {
    throw new Error(SESSION_CHANGED);
  }
  return snapshot;
}

function unavailable(d: Descriptor | undefined, reason: string): SubagentRoutingStatus {
  return {
    available: false,
    sessionId: d?.sessionId ?? null,
    runtimeEpoch: d?.runtimeEpoch ?? null,
    snapshot: null,
    providers: [],
    codexAccounts: [],
    reason,
  };
}

export function createSubagentRoutingHandlers() {
  const accounts = createAccountControlsHandlers();

  /** Named Codex logins, from the same session's account controls. */
  async function codexAccounts(input: Target, context: PluginHandlerContext, d: Descriptor) {
    const status = await accounts.status({ ...input, providerId: PI_PROVIDER }, context);
    if (!status.available) return [];
    const sameRuntime = status.snapshot
      && status.sessionId === d.sessionId
      && status.runtimeEpoch === d.runtimeEpoch
      && status.snapshot.sessionId === d.sessionId;
    if (!sameRuntime) throw new Error(SESSION_CHANGED);
    return status.snapshot!.accounts.map((account) => ({ id: account.id, label: account.label }));
  }

  async function status(
    input: Target,
    context: PluginHandlerContext,
  ): Promise<SubagentRoutingStatus> {
    await assertSamePiAgent(input, context);
    const d = await readSubagentDescriptor(input.agentId);
    if (!d) return unavailable(undefined, "Subagent routing unavailable");
    try {
      const [rawSnapshot, providers] = await Promise.all([
        call(d, "snapshot"),
        call(d, "providers"),
      ]);
      const snapshot = parseSnapshot(rawSnapshot, d);
      if (!isProviderList(providers)) throw new Error(UNAVAILABLE);
      const named = providers.includes(PI_PROVIDER) ? await codexAccounts(input, context, d) : [];

      // Make sure nothing changed while the requests were in flight.
      await assertSameSession(input.agentId, d);
      await assertSamePiAgent(input, context);
      return {
        available: true,
        sessionId: d.sessionId,
        runtimeEpoch: d.runtimeEpoch,
        snapshot,
        providers,
        codexAccounts: named,
        reason: null,
      };
    } catch (error) {
      const changed = error instanceof Error && error.message === SESSION_CHANGED;
      return unavailable(d, changed ? SESSION_CHANGED : UNAVAILABLE);
    }
  }

  async function set(input: SetInput, context: PluginHandlerContext) {
    await assertSamePiAgent(input, context);
    const d = await readSubagentDescriptor(input.agentId);
    const expected = d
      && d.sessionId === input.request.expectedSessionId
      && d.runtimeEpoch === input.expectedRuntimeEpoch
      && d.serviceEpoch === input.request.expectedServiceEpoch;
    if (!expected) throw new Error(SESSION_CHANGED);

    const raw = await call(d!, "set", {
      expectedRevision: input.request.expectedRevision,
      selection: input.request.selection,
    });
    const snapshot = parseSnapshot(raw, d!);
    await assertSameSession(input.agentId, d!);
    await assertSamePiAgent(input, context);
    return snapshot;
  }

  return { status, set };
}
