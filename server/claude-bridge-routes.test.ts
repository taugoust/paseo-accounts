import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { FamilyAdapter } from "./adapter";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { isClaudeBridge, Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore } from "./state";

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paseo-accounts-claude-bridge-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

function adapter(family: FamilyAdapter["family"]): FamilyAdapter {
  return {
    family,
    portable: true,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    identity: async () => null,
    usage: async () => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null }),
  } as unknown as FamilyAdapter;
}

async function view(models: Array<[string, string | null]>, withClaudeMain = true) {
  const store = new StateStore(join(root, "state.json"));
  if (withClaudeMain)
    await store.update((draft) => {
      draft.accounts.push({
        id: MAIN_ACCOUNT_ID.claude,
        family: "claude",
        label: "me",
        kind: "main",
        home: null,
        createdAt: "2026-11-11T00:00:00.000Z",
      } as never);
    });
  const agents = models.map(([id, model]) => ({
    id,
    provider: "pi",
    model,
    status: "idle",
    archivedAt: null,
    lastUserMessageAt: "2026-11-11T00:00:00.000Z",
  }));
  const paseo = {
    providers: { listAvailable: async () => ({ providers: [] }) },
    config: { get: async () => ({ config: { providers: {} } }) },
    agents: {
      list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
      ref: (id: string) => ({ refresh: async () => ({ agent: agents.find((agent) => agent.id === id) }) }),
    },
  };
  const families = ["claude", "codex", "kimi", "opencode", "pi", "copilot", "omp"] as const;
  const service = new Service(
    Object.fromEntries(families.map((family) => [family, adapter(family)])) as never,
    store,
    { resolve: async () => ({ pi: "pi" as const }) } as unknown as FamilyResolver,
    { locate: async () => null } as unknown as Reopener,
  );
  return service.view(paseo as never);
}

it("lists Pi agents on claude-bridge under the Claude Code login, display only", async () => {
  const out = await view([
    ["bridge", "claude-bridge/claude-opus-5-5"],
    ["codex", "openai-codex/gpt-6-luna"],
  ]);
  const bridge = out.agents.find((route) => route.agentId === "bridge");
  expect(bridge).toMatchObject({
    family: "claude",
    accountId: MAIN_ACCOUNT_ID.claude,
    provider: "pi",
    pinned: false,
    movable: false,
    canSwitch: false,
  });
  // Other Pi agents are routed by the native Pi view, never to the Claude login.
  expect(out.agents.find((route) => route.agentId === "codex")?.family).not.toBe("claude");
  expect(out.accounts.find((account) => account.id === MAIN_ACCOUNT_ID.claude)?.agentCount).toBe(1);
});

it("skips claude-bridge agents when there is no Claude Code login", async () => {
  const out = await view([["bridge", "claude-bridge/claude-opus-5-5"]], false);
  expect(out.agents.some((route) => route.agentId === "bridge")).toBe(false);
});

it("recognises only claude-bridge models", () => {
  expect(isClaudeBridge("claude-bridge/claude-sonnet-5-5")).toBe(true);
  expect(isClaudeBridge("anthropic/claude-opus-5-5")).toBe(false);
  expect(isClaudeBridge(null)).toBe(false);
});
