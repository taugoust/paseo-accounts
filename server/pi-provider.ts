import { randomUUID } from "node:crypto";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { piSnapshotSchema } from "../shared/pi-native";
import type { piApplyProviderRpc } from "../shared/pi-native";
import type { createAccountControlsHandlers } from "./pi-native";

type Controls = ReturnType<typeof createAccountControlsHandlers>;
type Provider = "openai" | "openai-codex";
type Target = { agentId: string; workspaceId: string; providerId: Provider };
class SkipAgent extends Error {}
function skip(reason: string): never { throw new SkipAgent(reason); }

async function status(controls: Controls, target: Target, context: PluginHandlerContext) {
  let result: Awaited<ReturnType<Controls["status"]>>;
  try { result = await controls.status(target, context); }
  catch { skip("Pi session unavailable; skipped."); }
  if (!result.available || !result.snapshot || !result.sessionId || !result.runtimeEpoch)
    skip("Pi session unavailable; skipped.");
  const snapshot = piSnapshotSchema.parse(result.snapshot);
  if (snapshot.sessionId !== result.sessionId ||
      (snapshot.providerId ?? "openai") !== target.providerId || snapshot.sessionRouting?.version !== 1)
    skip("Pi session identity stale or unsupported; skipped.");
  return { sessionId: result.sessionId, runtimeEpoch: result.runtimeEpoch, snapshot };
}
type Status = Awaited<ReturnType<typeof status>>;
function sameIdentity(a: Status, b: Status) {
  if (a.sessionId !== b.sessionId || a.runtimeEpoch !== b.runtimeEpoch || a.snapshot.serviceEpoch !== b.snapshot.serviceEpoch ||
      a.snapshot.sessionRouting!.providerId !== b.snapshot.sessionRouting!.providerId || a.snapshot.sessionRouting!.revision !== b.snapshot.sessionRouting!.revision)
    skip("Pi session or routing changed; skipped.");
}
function sameSelection(a: Status, b: Status) {
  sameIdentity(a, b);
  if (a.snapshot.selectionRevision !== b.snapshot.selectionRevision) skip("Pi account selection changed; skipped.");
}
function switchable(value: Status, provider: Provider) {
  if (value.snapshot.sessionRouting!.providerId !== provider && value.snapshot.guardedDefaultSwitchVersion !== 1)
    skip("Pi producer lacks the atomic default guard; skipped.");
  if (!value.snapshot.supportedProviders?.includes(provider)) skip("Provider unsupported on this Pi session; skipped.");
  if (!value.snapshot.canSwitch || value.snapshot.busy) skip("Pi session busy or not switchable; skipped.");
}
function addSkipped(summary: RpcOutput<typeof piApplyProviderRpc>, agentId: string, reason: string) {
  summary.skipped!.push({ agentId, reason });
}
function addFailed(summary: RpcOutput<typeof piApplyProviderRpc>, agentId: string, error: string) {
  summary.failed.push({ agentId, error });
}
/** Discover and mutate only host-local Pi chats following their provider default. */
export async function applyPiProvider(
  input: RpcInput<typeof piApplyProviderRpc>, context: PluginHandlerContext, controls: Controls,
): Promise<RpcOutput<typeof piApplyProviderRpc>> {
  const summary: RpcOutput<typeof piApplyProviderRpc> = {
    ...input, eligibleCount: 0, defaultAccountCount: 0, currentProvider: null, applied: [], skipped: [], failed: [],
    pinnedCount: 0, alreadySelectedCount: 0, discoveryComplete: false,
  };
  const agents = new Map<string, { agentId: string; workspaceId: string; providerId: Provider }>();
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  // A capped, missing-cursor, or cyclic traversal is incomplete: never write a partial population.
  for (let page = 0; page < 10; page++) {
    let result: Awaited<ReturnType<PluginHandlerContext["paseo"]["agents"]["list"]>>;
    try { result = await context.paseo.agents.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } }); }
    catch { return summary; }
    for (const { agent } of result.entries) {
      if (agent.provider !== "pi" || agent.archivedAt || agent.status === "closed" || !agent.workspaceId) continue;
      agents.set(agent.id, { agentId: agent.id, workspaceId: agent.workspaceId,
        providerId: typeof agent.model === "string" && agent.model.startsWith("openai-codex/") ? "openai-codex" : "openai" });
    }
    if (!result.pageInfo.hasMore) { summary.discoveryComplete = true; break; }
    const next = result.pageInfo.nextCursor;
    if (!next || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }
  if (!summary.discoveryComplete) return summary;
  const providers = new Set<Provider>();
  const plans: Array<{ target: Target; current: Status; destination: Status }> = [];
  for (const candidate of agents.values()) {
    try {
      let current = await status(controls, candidate, context);
      const providerId = current.snapshot.sessionRouting!.providerId;
      const target = { ...candidate, providerId };
      if (providerId !== candidate.providerId) {
        const authoritative = await status(controls, target, context);
        sameIdentity(current, authoritative);
        current = authoritative;
      }
      if (!current.snapshot.defaultSelected) { summary.pinnedCount++; continue; }
      summary.defaultAccountCount++;
      providers.add(providerId);
      switchable(current, input.providerId);
      const destination = providerId === input.providerId ? current : await status(controls, { ...target, providerId: input.providerId }, context);
      sameIdentity(current, destination);
      switchable(destination, input.providerId);
      summary.eligibleCount++;
      if (providerId === input.providerId) summary.alreadySelectedCount++;
      else plans.push({ target, current, destination });
    } catch (error) {
      if (error instanceof SkipAgent) addSkipped(summary, candidate.agentId, error.message);
      else addFailed(summary, candidate.agentId, "Could not safely verify this Pi session; refresh and retry.");
    }
  }
  summary.currentProvider = providers.size > 1 ? "mixed" : providers.values().next().value ?? null;
  if (!input.apply || !summary.discoveryComplete) return summary;
  for (const plan of plans) {
    const { target } = plan;
    try {
      let agent: Awaited<ReturnType<ReturnType<PluginHandlerContext["paseo"]["agents"]["ref"]>["refresh"]>>["agent"];
      try { agent = (await context.paseo.agents.ref(target.agentId).refresh())?.agent; }
      catch { skip("Pi conversation unavailable; skipped."); }
      if (!agent || agent.id !== target.agentId || agent.provider !== "pi" || agent.workspaceId !== target.workspaceId || agent.archivedAt || agent.status === "closed")
        skip("Pi conversation changed or is unavailable; skipped.");
      const current = await status(controls, target, context);
      sameSelection(plan.current, current);
      if (!current.snapshot.defaultSelected) skip("Pi account became pinned; skipped.");
      switchable(current, input.providerId);
      const destination = await status(controls, { ...target, providerId: input.providerId }, context);
      sameSelection(plan.destination, destination);
      sameIdentity(current, destination);
      switchable(destination, input.providerId);
      const result = await controls.switch({
        agentId: target.agentId, workspaceId: target.workspaceId, expectedSessionId: current.sessionId, expectedRuntimeEpoch: current.runtimeEpoch,
        request: { protocol: 1, requestId: randomUUID(), providerId: input.providerId, accountId: null,
          expectedDefaultSource: { providerId: target.providerId, selectionRevision: current.snapshot.selectionRevision },
          expectedSessionId: current.sessionId, expectedServiceEpoch: current.snapshot.serviceEpoch,
          expectedSelectionRevision: destination.snapshot.selectionRevision, expectedRoutingRevision: current.snapshot.sessionRouting!.revision },
      }, context);
      if (!result.ok) {
        if (["busy", "stale-session", "stale-service", "stale-selection"].includes(result.reason))
          skip(`Pi session changed or became busy (${result.reason}); skipped.`);
        addFailed(summary, target.agentId, `Pi provider change was rejected (${result.reason}); refresh before retrying.`);
        continue;
      }
      if (result.snapshot.sessionId !== current.sessionId || result.snapshot.serviceEpoch !== current.snapshot.serviceEpoch ||
          result.snapshot.providerId !== input.providerId || result.snapshot.sessionRouting?.providerId !== input.providerId || !result.snapshot.defaultSelected)
        throw new Error("Pi provider switch was not confirmed.");
      summary.applied.push(target.agentId);
    } catch (error) {
      if (error instanceof SkipAgent) addSkipped(summary, target.agentId, error.message);
      else addFailed(summary, target.agentId, "Pi provider change was not confirmed; outcome may be unavailable. Refresh before retrying.");
    }
  }
  return summary;
}
