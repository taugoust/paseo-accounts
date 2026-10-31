import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAgentAccount } from "../shared/rpc";
import type { PiNativeSnapshot } from "../shared/pi-native";
import type { FamilyAdapter } from "./adapter";
import type { FamilyResolver } from "./families";
import { NativePiAccounts } from "./pi-native-view";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, StoredAccountSchema } from "./state";
const empty = { reopened: [], deferred: [], failed: [], continuedIn: null };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function legacy() {
  const root = await mkdtemp(join(tmpdir(), "accounts-idle-switch-")); roots.push(root);
  const store = new StateStore(join(root, "state.json")); const main = MAIN_ACCOUNT_ID.claude;
  await store.update((draft) => {
    draft.accounts = [main, "target", "user-choice"].map((id) => StoredAccountSchema.parse({
      id, family: "claude", label: id, kind: id === main ? "main" : "managed", home: null, createdAt: "2026-01-01T00:00:00.000Z",
    }));
    draft.defaults.claude = main;
    draft.sessions.a = { accountId: main, family: "claude", openedAt: "2026-01-01T00:00:00.000Z" };
  });
  const agent = { id: "a", provider: "claude", status: "idle", archivedAt: null, lastUserMessageAt: "2026-01-01T00:00:00.000Z" };
  const refresh = vi.fn(async () => ({ agent }));
  const paseo = { agents: { ref: () => ({ refresh }), list: vi.fn(async () => ({ entries: [{ agent }], pageInfo: { hasMore: false } })) } };
  const reopen = vi.fn(async () => ({ ok: true as const }));
  const service = new Service({ claude: { portable: true } as FamilyAdapter } as never,
    store, { resolve: async () => ({ claude: "claude" }) } as unknown as FamilyResolver, { reopen } as unknown as Reopener);
  return { store, service, agent, paseo: paseo as never, refresh, reopen };
}
function native(patch: Partial<PiNativeSnapshot> = {}) {
  const agent = { id: "a", provider: "pi", workspaceId: "workspace", status: "idle", archivedAt: null as string | null, model: "openai/model" };
  let current: PiNativeSnapshot = {
    protocol: 1, sessionId: "session", serviceEpoch: "service", selectionRevision: 3, providerId: "openai", guardedDefaultSwitchVersion: 1,
    sessionRouting: { version: 1, providerId: "openai", revision: 5 }, supportedProviders: ["openai", "openai-codex"],
    accounts: [{ id: "target", label: "Target", authKind: "oauth" }], currentAccountId: null, defaultSelected: true,
    activationStatus: "active", busy: false, canSwitch: true,
    usage: { effectiveCredential: "unknown", status: "unknown", remoteEntitlement: "not-queried", settingsUrl: null }, ...patch,
  };
  let afterSnapshot = () => {};
  const refresh = vi.fn(async () => ({ agent }));
  const status = vi.fn(async () => { const snapshot = structuredClone(current); afterSnapshot(); return { available: true, reason: null, sessionId: "session", runtimeEpoch: "11111111-1111-4111-8111-111111111111", snapshot }; });
  const switchFn = vi.fn(async ({ request }: { request: { requestId: string; expectedSelectionRevision: number; accountId: string | null } }) => {
    if (current.busy) return { ok: false, reason: "busy", requestId: request.requestId, snapshot: current };
    if (current.selectionRevision !== request.expectedSelectionRevision) return { ok: false, reason: "stale-selection", requestId: request.requestId, snapshot: current };
    current = { ...current, currentAccountId: request.accountId, defaultSelected: request.accountId === null, selectionRevision: current.selectionRevision + 1 };
    return { ok: true, requestId: request.requestId, snapshot: current };
  });
  const service = new NativePiAccounts({ status, switch: switchFn } as never);
  const context = { paseo: { agents: { ref: () => ({ refresh }) } } } as never;
  return { service, context, agent, refresh, status, switchFn, state: () => current, afterSnapshot: (fn: () => void) => { afterSnapshot = fn; } };
}
describe("onlyIfIdle legacy exclusion", () => {
  it("preserves legacy inputs and retains the optional RPC guard", () => {
    expect(setAgentAccount.name).toBe("paseo-accounts.agents.account");
    const legacy = { agentId: "a", accountId: "target" };
    expect(setAgentAccount.input.parse(legacy)).toEqual(legacy);
    expect(setAgentAccount.input.parse({ ...legacy, onlyIfIdle: true })).toEqual({ ...legacy, onlyIfIdle: true });
  });
  it.each(["idle", "running", "initializing", "closed", "disconnected"])("does not persist or queue a guarded %s legacy session", async (status) => {
    const h = await legacy(); h.agent.status = status; const before = await h.store.read(); const update = vi.spyOn(h.store, "update");
    expect(await h.service.setAgentAccount(h.paseo, "a", "target", true)).toEqual(empty);
    expect(await h.store.read()).toEqual(before); expect(update).not.toHaveBeenCalled(); expect(h.refresh).not.toHaveBeenCalled(); expect(h.reopen).not.toHaveBeenCalled();
    expect((h.service as unknown as { deferred: Map<string, unknown> }).deferred.size).toBe(0);
  });
  it("never rolls back a concurrent explicit user choice when session becomes busy", async () => {
    const h = await legacy(); const explicit = h.service.setAgentAccount(h.paseo, "a", "user-choice"); h.agent.status = "running";
    expect(await h.service.setAgentAccount(h.paseo, "a", "target", true)).toEqual(empty);
    expect(await explicit).toMatchObject({ deferred: ["a"] });
    expect((await h.store.read()).bindings.a).toMatchObject({ accountId: "user-choice", source: "user" }); expect(h.reopen).not.toHaveBeenCalled();
  });
  it("preserves existing pending bindings and thread pins without forking", async () => {
    const h = await legacy(); await h.store.update((draft) => { draft.bindings.a = { accountId: "user-choice", source: "thread", at: "existing-pin" }; });
    const before = await h.store.read(); expect(await h.service.setAgentAccount(h.paseo, "a", null, true)).toEqual(empty);
    expect(await h.store.read()).toEqual(before); expect(h.refresh).not.toHaveBeenCalled();
  });
  it.each([undefined, false])("keeps legacy busy queuing when onlyIfIdle is %s", async (guard) => {
    const h = await legacy(); h.agent.status = "running";
    expect(await h.service.setAgentAccount(h.paseo, "a", "target", guard)).toMatchObject({ deferred: ["a"] });
    expect((await h.store.read()).bindings.a).toMatchObject({ accountId: "target", source: "user" });
    expect((h.service as unknown as { deferred: Map<string, unknown> }).deferred.has("a")).toBe(true);
  });
});
describe("onlyIfIdle native Pi admission", () => {
  it.each(["idle", "error"])("retains explicit %s in-place switches (including selected pins)", async (status) => {
    const h = native({ currentAccountId: "old-pin", defaultSelected: false }); h.agent.status = status;
    expect(await h.service.switch("a", "pi-native:profile:target", h.context, true)).toMatchObject({ reopened: ["a"], deferred: [] });
    expect(h.state().currentAccountId).toBe("target"); expect(h.switchFn).toHaveBeenCalledOnce();
  });
  it.each(["running", "initializing", "closed", "disconnected"])("rechecks fresh Pi %s status", async (status) => {
    const h = native(); h.agent.status = status;
    expect(await h.service.switch("a", "pi-native:profile:target", h.context, true)).toEqual(empty); expect(h.status).not.toHaveBeenCalled(); expect(h.switchFn).not.toHaveBeenCalled();
  });
  it.each([{ busy: true }, { canSwitch: false }, { activationStatus: "activation-pending" as const }, { activationStatus: "activation-failed" as const },
    { guardedDefaultSwitchVersion: undefined }, { sessionRouting: undefined }, { sessionRouting: { version: 1 as const, providerId: "openai-codex" as const, revision: 5 } }])
    ("skips busy, pending, old-capability, or wrong namespace snapshots: %j", async (patch) => {
      const h = native(patch); expect(await h.service.switch("a", "pi-native:profile:target", h.context, true)).toEqual(empty);
      expect(h.switchFn).not.toHaveBeenCalled(); expect(h.state().currentAccountId).toBeNull();
    });
  it("allows inactive default activation when live bridge can switch", async () => {
    const h = native({ activationStatus: "inactive" });
    expect(await h.service.switch("a", "pi-native:profile:target", h.context, true)).toMatchObject({ reopened: ["a"] });
    expect(h.state().currentAccountId).toBe("target"); expect(h.switchFn).toHaveBeenCalledOnce();
  });
  it("skips disconnected bridge", async () => {
    const h = native(); h.status.mockResolvedValue({ available: false, reason: "disconnected", sessionId: "session", runtimeEpoch: "11111111-1111-4111-8111-111111111111", snapshot: null } as never);
    expect(await h.service.switch("a", "pi-native:profile:target", h.context, true)).toEqual(empty); expect(h.switchFn).not.toHaveBeenCalled();
  });
  it("leaves no selection or pending activation when Pi becomes busy after snapshot", async () => {
    const h = native(); h.afterSnapshot(() => { h.state().busy = true; });
    expect(await h.service.switch("a", "pi-native:profile:target", h.context, true)).toEqual(empty);
    expect(h.switchFn).toHaveBeenCalledOnce(); expect(h.state()).toMatchObject({ currentAccountId: null, selectionRevision: 3, activationStatus: "active" });
  });
  it("never rolls back a concurrent Pi user selection after stale rejection", async () => {
    const h = native(); h.afterSnapshot(() => { Object.assign(h.state(), { currentAccountId: "user-choice", selectionRevision: 4, defaultSelected: false }); });
    expect(await h.service.switch("a", "pi-native:profile:target", h.context, true)).toEqual(empty);
    expect(h.switchFn).toHaveBeenCalledOnce(); expect(h.state()).toMatchObject({ currentAccountId: "user-choice", selectionRevision: 4, activationStatus: "active" });
  });
  it("still throws on a legacy Pi busy race", async () => {
    const h = native(); h.afterSnapshot(() => { h.state().busy = true; });
    await expect(h.service.switch("a", "pi-native:profile:target", h.context)).rejects.toThrow(/busy/); expect(h.state().currentAccountId).toBeNull();
  });
  it("does not apply the capability exclusion to legacy Pi callers", async () => {
    const h = native({ guardedDefaultSwitchVersion: undefined });
    expect(await h.service.switch("a", "pi-native:profile:target", h.context)).toMatchObject({ reopened: ["a"] });
  });
});
