import { describe, expect, it, vi } from "vitest";
import { setAgentAccount, setAgentProvider } from "../shared/rpc";
import type { PiNativeSnapshot } from "../shared/pi-native";
import { NativePiAccounts } from "./pi-native-view";

type Provider = "openai" | "openai-codex";
const empty = { reopened: [], deferred: [], failed: [], continuedIn: null };
const canonical = (provider: Provider, name: string | null = null) =>
  `pi-native:${provider === "openai-codex" ? "codex:" : ""}${name === null ? "default" : `profile:${name}`}`;
function fixture(sourceProvider: Provider = "openai", pin: string | null = null) {
  const agents = new Map(["selected", "unselected"].map(id => [id, {
    id, provider: "pi", workspaceId: "workspace", archivedAt: null as string | null,
    status: "idle", model: "openai/stale-alias",
  }]));
  const make = (providerId: Provider): PiNativeSnapshot => ({
    protocol: 1, sessionId: "session", serviceEpoch: "service", providerId,
    guardedDefaultSwitchVersion: 1, selectionRevision: providerId === sourceProvider ? 3 : 8,
    sessionRouting: { version: 1, providerId: sourceProvider, revision: 5 },
    supportedProviders: ["openai", "openai-codex"], accounts: [{ id: "Work", label: "Work", authKind: "oauth" }],
    currentAccountId: providerId === sourceProvider ? pin : "old-destination-pin",
    defaultSelected: providerId === sourceProvider && pin === null,
    activationStatus: "active", busy: false, canSwitch: true,
    usage: { effectiveCredential: "unknown", status: "unknown", remoteEntitlement: "not-queried", settingsUrl: null },
  });
  const states: Record<Provider, PiNativeSnapshot> = { openai: make("openai"), "openai-codex": make("openai-codex") };
  let afterRead = (_provider: Provider, _count: number) => {};
  let beforeSwitch = () => {};
  const runtimeEpoch = "11111111-1111-4111-8111-111111111111";
  const context = { paseo: { agents: {
    list: vi.fn(() => { throw Error("Host-wide discovery forbidden"); }),
    ref: vi.fn((id: string) => ({ refresh: vi.fn(async () => ({ agent: agents.get(id) })) })),
  } } };
  let readCount = 0;
  const status = vi.fn(async ({ agentId, providerId }: { agentId: string; providerId: Provider }, ctx: unknown) => {
    expect(agentId).toBe("selected"); expect(ctx).toBe(context);
    const snapshot = structuredClone(states[providerId]);
    afterRead(providerId, ++readCount);
    return { available: true, sessionId: "session", runtimeEpoch, snapshot, reason: null };
  });
  const switchFn = vi.fn(async (input: any, ctx: unknown) => {
    expect(ctx).toBe(context); expect(input.agentId).toBe("selected");
    expect(input.workspaceId).toBe("workspace");
    beforeSwitch();
    const request = input.request;
    const state = states[request.providerId as Provider];
    const failure = (reason: string) => ({ ok: false, reason, requestId: request.requestId, snapshot: structuredClone(state) });
    if (state.busy) return failure("busy");
    if (state.selectionRevision !== request.expectedSelectionRevision ||
        states[sourceProvider].sessionRouting?.revision !== request.expectedRoutingRevision) return failure("stale-selection");
    state.currentAccountId = null; state.defaultSelected = true; state.selectionRevision++;
    state.sessionRouting = { version: 1, providerId: request.providerId, revision: 6 };
    return { ok: true, requestId: request.requestId, snapshot: structuredClone(state) };
  });
  const native = new NativePiAccounts({ status, switch: switchFn } as never);
  const destination: Provider = sourceProvider === "openai" ? "openai-codex" : "openai";
  return { agents, states, status, switchFn, context, native, destination,
    afterRead: (fn: typeof afterRead) => { afterRead = fn; }, beforeSwitch: (fn: typeof beforeSwitch) => { beforeSwitch = fn; },
    run: (expected = canonical(sourceProvider, pin)) => native.changeProvider("selected", destination, expected, context as never),
  };
}

describe("selected Pi Change provider", () => {
  it("exports a bounded RPC without changing legacy account input", () => {
    expect(setAgentProvider.name).toBe("paseo-accounts.agents.provider");
    const input = { agentId: "selected", providerId: "openai-codex", expectedAccountId: "pi-native:default" };
    expect(setAgentProvider.input.parse(input)).toEqual(input);
    expect(setAgentProvider.input.safeParse({ ...input, providerId: "claude" }).success).toBe(false);
    expect(setAgentProvider.input.safeParse({ agentId: "selected", providerId: "openai" }).success).toBe(false);
    expect(setAgentAccount.input.parse({ agentId: "a", accountId: "legacy" })).toEqual({ agentId: "a", accountId: "legacy" });
  });
  it.each(["openai", "openai-codex"] as const)("changes a selected %s pin to the other provider's local default", async provider => {
    const h = fixture(provider, "Work");
    const unselected = structuredClone(h.agents.get("unselected"));
    expect(await h.run()).toEqual({ ...empty, reopened: ["selected"] });
    expect(h.switchFn).toHaveBeenCalledOnce();
    const input = h.switchFn.mock.calls[0]![0];
    expect(input).toMatchObject({ agentId: "selected", workspaceId: "workspace", expectedSessionId: "session",
      expectedRuntimeEpoch: "11111111-1111-4111-8111-111111111111", request: { protocol: 1, providerId: h.destination,
        accountId: null, expectedSessionId: "session", expectedServiceEpoch: "service", expectedSelectionRevision: 8, expectedRoutingRevision: 5 } });
    expect(input.request.expectedDefaultSource).toBeUndefined();
    expect(input.request.model).toBeUndefined();
    expect(h.status.mock.calls.map(([input]) => input.providerId)).toEqual([provider, h.destination, h.destination, provider]);
    expect(h.context.paseo.agents.list).not.toHaveBeenCalled();
    expect(h.context.paseo.agents.ref.mock.calls.every(([id]) => id === "selected")).toBe(true);
    expect(h.agents.get("unselected")).toEqual(unselected);
  });
  it("accepts mixed source providers as independent selected RPCs", async () => {
    const openai = fixture("openai", "Work"), codex = fixture("openai-codex", "Work");
    const results = await Promise.all([openai.run(), codex.run()]);
    expect(results.every(result => result.reopened.length === 1)).toBe(true);
    expect(openai.switchFn).toHaveBeenCalledOnce(); expect(codex.switchFn).toHaveBeenCalledOnce();
  });
  it("uses an atomic default source guard only for a default-following source", async () => {
    const h = fixture();
    expect(await h.run()).toEqual({ ...empty, reopened: ["selected"] });
    expect(h.switchFn.mock.calls[0]![0].request.expectedDefaultSource).toEqual({ providerId: "openai", selectionRevision: 3 });
  });
  it("maps a resolved named follow-default binding to canonical default only", async () => {
    const h = fixture("openai", "Work"); h.states.openai.defaultSelected = true;
    expect(await h.run("pi-native:profile:Work")).toEqual(empty);
    expect(h.switchFn).not.toHaveBeenCalled();
    expect(await h.run("pi-native:default")).toEqual({ ...empty, reopened: ["selected"] });
  });
  it("rejects a stale pin that changed to follow-default resolving the same name", async () => {
    const h = fixture("openai", "Work");
    h.afterRead((_provider, count) => { if (count === 2) h.states.openai.defaultSelected = true; });
    expect(await h.run()).toEqual(empty); expect(h.switchFn).not.toHaveBeenCalled();
  });
  it.each(["pi-native:profile:Other", "pi-native:codex:profile:Work", "legacy", "pi-native:profile:%ZZ", "pi-native:profile:%57ork"]) ("skips stale or noncanonical source %s", async expected => {
    const h = fixture("openai", "Work");
    expect(await h.run(expected)).toEqual(empty); expect(h.switchFn).not.toHaveBeenCalled();
  });
  it("does not mistake a pin for a canonical default source", async () => {
    const h = fixture("openai", "Work");
    expect(await h.run("pi-native:default")).toEqual(empty); expect(h.switchFn).not.toHaveBeenCalled();
  });
  it.each(["running", "disconnected", "initializing", "closed"])("skips freshly %s sessions without querying the bridge", async status => {
    const h = fixture(); h.agents.get("selected")!.status = status;
    expect(await h.run()).toEqual(empty); expect(h.status).not.toHaveBeenCalled();
  });
  it.each([
    { busy: true }, { canSwitch: false }, { activationStatus: "activation-pending" }, { activationStatus: "activation-failed" },
    { guardedDefaultSwitchVersion: undefined }, { sessionRouting: undefined }, { supportedProviders: ["openai"] },
    { sessionId: "stale-session" }, { providerId: "openai-codex" },
  ])("fails closed for unavailable admission %j", async patch => {
    const h = fixture(); Object.assign(h.states.openai, patch);
    expect(await h.run()).toEqual(empty); expect(h.switchFn).not.toHaveBeenCalled();
  });
  it("skips an unavailable native service", async () => {
    const h = fixture(); h.status.mockResolvedValue({ available: false, sessionId: null, runtimeEpoch: null, snapshot: null, reason: "offline" } as never);
    expect(await h.run()).toEqual(empty); expect(h.switchFn).not.toHaveBeenCalled();
  });
  it.each(["source", "destination", "session", "service", "route"])("skips a changed %s revision/identity at final preflight", async kind => {
    const h = fixture("openai", "Work");
    h.afterRead((_provider, count) => {
      if (count !== 2) return;
      if (kind === "source") h.states.openai.selectionRevision++;
      if (kind === "destination") h.states["openai-codex"].selectionRevision++;
      if (kind === "session") h.states["openai-codex"].sessionId = "new-session";
      if (kind === "service") h.states["openai-codex"].serviceEpoch = "new-service";
      if (kind === "route") h.states.openai.sessionRouting!.revision++;
    });
    expect(await h.run()).toEqual(empty); expect(h.switchFn).not.toHaveBeenCalled();
  });
  it("rechecks source choice immediately before dispatch even with unchanged revision", async () => {
    const h = fixture("openai", "Work");
    h.afterRead((_provider, count) => { if (count === 2) h.states.openai.currentAccountId = "Other"; });
    expect(await h.run()).toEqual(empty); expect(h.switchFn).not.toHaveBeenCalled();
  });
  it.each(["busy", "source-pin", "destination"])("does not queue or roll back a %s race after all snapshots", async kind => {
    const h = fixture("openai", "Work");
    h.beforeSwitch(() => {
      if (kind === "busy") h.states["openai-codex"].busy = true;
      if (kind === "source-pin") { h.states.openai.currentAccountId = "Other"; h.states.openai.selectionRevision++; h.states.openai.sessionRouting!.revision++; }
      if (kind === "destination") h.states["openai-codex"].selectionRevision++;
    });
    expect(await h.run()).toEqual(empty); expect(h.switchFn).toHaveBeenCalledOnce();
    expect(h.states["openai-codex"].currentAccountId).toBe("old-destination-pin");
    if (kind === "source-pin") expect(h.states.openai.currentAccountId).toBe("Other");
  });
  it.each(["stale-session", "stale-service"])("does not retry or fork a producer %s rejection", async reason => {
    const h = fixture(); h.switchFn.mockImplementation(async input => ({ ok: false, reason, requestId: input.request.requestId, snapshot: h.states["openai-codex"] }));
    expect(await h.run()).toEqual(empty); expect(h.switchFn).toHaveBeenCalledOnce();
  });
  it("sanitizes transport failures and never retries", async () => {
    const h = fixture(); h.switchFn.mockRejectedValue(Error("private capability detail"));
    const result = await h.run(); expect(result.failed).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("private"); expect(result.deferred).toEqual([]); expect(result.continuedIn).toBeNull();
    expect(h.switchFn).toHaveBeenCalledOnce();
  });
  it("replaces a same-provider pin with the local default", async () => {
    const h = fixture("openai", "Work");
    expect(await h.native.changeProvider("selected", "openai", "pi-native:profile:Work", h.context as never)).toEqual({ ...empty, reopened: ["selected"] });
    expect(h.switchFn.mock.calls[0]![0].request).toMatchObject({ providerId: "openai", accountId: null, expectedSelectionRevision: 3 });
    expect(h.states.openai.defaultSelected).toBe(true);
  });
  it("skips an already-current provider following default", async () => {
    const h = fixture();
    expect(await h.native.changeProvider("selected", "openai", "pi-native:default", h.context as never)).toEqual(empty);
    expect(h.switchFn).not.toHaveBeenCalled();
  });
  it("does not block on unrelated pending login names", async () => {
    const h = fixture(); h.states.openai.pendingAccountNames = ["Login"];
    expect(await h.run()).toEqual({ ...empty, reopened: ["selected"] });
  });
  it("counts a confirmed committed switch even if the next turn has made its response busy", async () => {
    const h = fixture();
    const commit = h.switchFn.getMockImplementation()!;
    h.switchFn.mockImplementation(async (...args) => {
      const result = await commit(...args);
      return { ...result, snapshot: { ...result.snapshot, busy: true, canSwitch: false } };
    });
    expect(await h.run()).toEqual({ ...empty, reopened: ["selected"] });
  });
});
