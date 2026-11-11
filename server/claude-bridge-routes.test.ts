import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { FamilyAdapter } from "./adapter";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { isClaudeBridge, Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore } from "./state";

const MAIN = MAIN_ACCOUNT_ID.claude;
const WORK = "claude-work";

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

function adapter(family: FamilyAdapter["family"], missing = false): FamilyAdapter {
  return {
    family,
    portable: true,
    usageSpacingMs: 0,
    available: async () =>
      missing ? { ok: false, detail: `spawn ${family} ENOENT` } : { ok: true, detail: null },
    identity: async () => null,
    prepareHome: async () => undefined,
    env: async (home: string | null) => ({
      CLAUDE_CONFIG_DIR: home,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: home,
    }),
    usage: async () => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null }),
  } as unknown as FamilyAdapter;
}

const claudeAccount = (id: string, kind: "main" | "managed") =>
  ({
    id,
    family: "claude",
    label: id,
    kind,
    home: kind === "main" ? null : join(tmpdir(), id),
    createdAt: "2026-11-11T00:00:00.000Z",
  }) as never;

async function setUp(
  models: Array<[string, string | null]>,
  options: { accounts?: string[]; missing?: readonly string[] } = {},
) {
  const store = new StateStore(join(root, "state.json"));
  const accounts = options.accounts ?? [MAIN];
  await store.update((draft) => {
    for (const id of accounts) draft.accounts.push(claudeAccount(id, id === MAIN ? "main" : "managed"));
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
      ref: (id: string) => ({
        refresh: async () => ({ agent: agents.find((agent) => agent.id === id) }),
        timeline: { append: async () => undefined, refetch: async () => ({ entries: [] }) },
      }),
    },
  };
  const context = { paseo } as never;
  const reopened: string[] = [];
  const families = ["claude", "codex", "kimi", "opencode", "pi", "copilot", "omp"] as const;
  const service: Service = new Service(
    Object.fromEntries(
      families.map((family) => [family, adapter(family, options.missing?.includes(family))]),
    ) as never,
    store,
    { resolve: async () => ({ pi: "pi" as const }) } as unknown as FamilyResolver,
    {
      locate: async () => "/usr/local/bin/paseo",
      reopen: async (id: string) => {
        reopened.push(id);
        await open(id, "refresh");
        return { ok: true as const };
      },
    } as unknown as Reopener,
  );
  const open = (agentId: string, reason: "create" | "resume" | "refresh" = "resume") =>
    service.onSessionOpen(
      { agentId, provider: "pi", cwd: "/w", reason, purpose: "interactive", env: { KEEP: "1" } } as never,
      context,
    );
  return { service, store, paseo, open, reopened };
}

async function view(models: Array<[string, string | null]>, options: { accounts?: string[]; missing?: readonly string[] } = {}) {
  const { service, paseo } = await setUp(models, options);
  // Starting checks which CLIs are installed; only needed when a test makes some missing.
  if (options.missing) await service.start();
  try {
    return await service.view(paseo as never);
  } finally {
    if (options.missing) await service.stop();
  }
}

it("lists Pi agents on claude-bridge under Claude, where they can change accounts", async () => {
  const out = await view([
    ["bridge", "claude-bridge/claude-opus-5-5"],
    ["codex", "openai-codex/gpt-6-luna"],
  ]);
  expect(out.agents.find((route) => route.agentId === "bridge")).toMatchObject({
    family: "claude",
    accountId: MAIN,
    provider: "pi",
    pinned: false,
    movable: true,
    canSwitch: true,
  });
  // Other Pi agents are routed by the native Pi view, never to a Claude account.
  expect(out.agents.find((route) => route.agentId === "codex")?.family).not.toBe("claude");
  expect(out.accounts.find((account) => account.id === MAIN)?.agentCount).toBe(1);
});

it("skips claude-bridge agents when there is no Claude account", async () => {
  const out = await view([["bridge", "claude-bridge/claude-opus-5-5"]], { accounts: [] });
  expect(out.agents.some((route) => route.agentId === "bridge")).toBe(false);
});

it("gives Pi sessions the routed Claude account's config directory and nothing else", async () => {
  const { store, open } = await setUp([["bridge", "claude-bridge/claude-opus-5-5"]], {
    accounts: [MAIN, WORK],
  });
  // On the CLI login, the Claude variables are cleared so Claude Code uses ~/.claude.
  expect((await open("bridge"))?.env).toEqual({ KEEP: "1" });
  await store.update((draft) => {
    draft.bindings.bridge = { accountId: WORK, source: "user", at: new Date().toISOString() };
  });
  const home = join(tmpdir(), WORK);
  expect((await open("bridge"))?.env).toEqual({
    KEEP: "1",
    CLAUDE_CONFIG_DIR: home,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: home,
  });
});

it("moves a claude-bridge agent to another Claude account by reloading it", async () => {
  const { service, store, paseo, open, reopened } = await setUp(
    [["bridge", "claude-bridge/claude-opus-5-5"]],
    { accounts: [MAIN, WORK] },
  );
  await open("bridge");
  await service.setAgentAccount(paseo as never, "bridge", WORK);
  expect(reopened).toEqual(["bridge"]);
  const state = await store.read();
  expect(state.bindings.bridge).toMatchObject({ accountId: WORK, source: "user" });
  expect(state.sessions.bridge).toMatchObject({ accountId: WORK, family: "claude" });
});

it("leaves account changes for other Pi agents to the Pi bridge", async () => {
  const { service, paseo } = await setUp([["codex", "openai-codex/gpt-6-luna"]], { accounts: [MAIN, WORK] });
  await expect(service.setAgentAccount(paseo as never, "codex", WORK)).rejects.toThrow(/live Pi account bridge/);
});

it("recognises only claude-bridge models", () => {
  expect(isClaudeBridge("claude-bridge/claude-sonnet-5-5")).toBe(true);
  expect(isClaudeBridge("anthropic/claude-opus-5-5")).toBe(false);
  expect(isClaudeBridge(null)).toBe(false);
});

it("doesn't ask for the Codex CLI, which Pi replaces here, but still asks for Claude Code", async () => {
  const codexOnly = await view([], { accounts: [], missing: ["codex"] });
  expect(codexOnly.warnings.some((warning) => warning.includes("Codex"))).toBe(false);
  const both = await view([], { accounts: [], missing: ["claude", "codex"] });
  expect(both.warnings.filter((warning) => warning.includes("isn't installed"))).toEqual([
    "Claude Code isn't installed where the daemon can run it (spawn claude ENOENT). Install it to add Claude accounts.",
  ]);
});
