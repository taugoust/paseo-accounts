import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, chmod, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NativePiAccounts } from "./pi-native-view";
function token(accountId: string, email?: string) {
  const payload = Buffer.from(
    JSON.stringify({
      ...(email ? { email } : {}),
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `x.${payload}.x`;
}
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const r of roots.splice(0))
    await rm(r, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-provider-fixture-"));
  roots.push(root);
  const pi = join(root, "agent");
  await mkdir(pi);
  await chmod(pi, 0o700);
  process.env.PI_CODING_AGENT_DIR = pi;
  return pi;
}
async function credentials(pi: string, data: unknown) {
  await writeFile(join(pi, "auth.json"), JSON.stringify(data), { mode: 0o600 });
}
async function accounts(pi: string, data: unknown) {
  await writeFile(join(pi, "pi-accounts.json"), JSON.stringify(data), {
    mode: 0o600,
  });
}
const oauth = (accountId: string, email?: string) => ({
  type: "oauth",
  access: token(accountId, email),
  expires: Date.now() + 600000,
});
const state = () =>
  ({
    accounts: [],
    warnings: [],
    nextUp: {},
    agents: [],
    installed: [],
    logins: [],
    fallbacks: [],
    providers: {},
  }) as never;
const context = () =>
  ({
    paseo: {
      agents: {
        list: async () => ({ entries: [], pageInfo: { hasMore: false } }),
      },
    },
  }) as never;
const agent = (id: string, model: string) => ({
  agent: {
    id,
    provider: "pi",
    model,
    status: "idle",
    workspaceId: "w",
    cwd: "/w",
    title: null,
    archivedAt: null,
  },
});
const withAgents = (...entries: ReturnType<typeof agent>[]) =>
  ({
    paseo: {
      agents: { list: async () => ({ entries, pageInfo: { hasMore: false } }) },
    },
  }) as never;
const NOT_CONNECTED = "Pi sessions are not connected to the live account switcher";
describe("Codex-only native Pi accounts", () => {
  it("leaves claude-bridge and openai/ agents alone: no route and no warning", async () => {
    await fixture();
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    const status = vi.fn(async () => ({ available: false }));
    const out = await new NativePiAccounts({ status } as never).view(
      state(),
      withAgents(
        agent("bridge", "claude-bridge/claude-opus-5-5"),
        agent("plain", "openai/gpt-5"),
        agent("other", "local/llama"),
      ),
      true,
    );
    expect(status).not.toHaveBeenCalled();
    expect(out.agents).toEqual([]);
    // Only the local model counts as not connected.
    expect(out.warnings.filter((warning) => warning.includes(NOT_CONNECTED))).toEqual([
      `1 ${NOT_CONNECTED}; their current selection is left unknown.`,
    ]);
  });
  it("gives openai/ agents no route and no warning next to a connected Codex agent", async () => {
    await fixture();
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    const calls: unknown[] = [];
    const controls = {
      status: async (input: unknown) => {
        calls.push(input);
        return {
          available: true,
          sessionId: "s",
          runtimeEpoch: "e",
          reason: null,
          snapshot: {
            sessionId: "s",
            providerId: "openai-codex",
            accounts: [],
            currentAccountId: null,
            canSwitch: true,
          },
        };
      },
    } as never;
    const out = await new NativePiAccounts(controls).view(
      state(),
      withAgents(agent("codex", "openai-codex/gpt-5"), agent("plain", "openai/gpt-5")),
      true,
    );
    expect(calls).toEqual([{ agentId: "codex", workspaceId: "w", providerId: "openai-codex" }]);
    expect(out.agents.map((route) => route.agentId)).toEqual(["codex"]);
    expect(out.agents[0]?.accountId).toBe("pi-native:codex:default");
    expect(out.warnings.some((warning) => warning.includes(NOT_CONNECTED))).toBe(false);
  });
  it("shows only the Codex default login and Codex profiles, with their own usage", async () => {
    const pi = await fixture();
    await credentials(pi, { openai: oauth("personal"), "openai-codex": oauth("codex-default") });
    await accounts(pi, {
      providers: {
        openai: {
          active: "work",
          accounts: { work: { ...oauth("personal"), label: "Personal" } },
        },
        "openai-codex": {
          active: "work",
          accounts: { work: { ...oauth("work"), label: "Work" } },
        },
      },
    });
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (_url: string, init: { headers: Record<string, string> }) => {
        seen.push(init.headers["ChatGPT-Account-Id"] ?? "");
        return Response.json({
          plan_type: "plus",
          rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 3600 } },
        });
      },
    );
    const out = await new NativePiAccounts().view(state(), context(), true);
    const rows = out.accounts.filter((a) => a.family === "pi");
    expect(rows.map((a) => a.id)).toEqual([
      "pi-native:codex:default",
      "pi-native:codex:profile:work",
    ]);
    expect(rows.map((a) => a.label)).toEqual(["Codex", "Work"]);
    expect(rows.find((a) => a.id === "pi-native:codex:profile:work")).toMatchObject({
      isDefault: true,
      plan: "Codex · plus",
    });
    expect(rows.every((a) => a.usage?.windows.length === 1)).toBe(true);
    expect(seen.sort()).toEqual(["codex-default", "work"]);
    expect(out.nextUp.pi).toBe("pi-native:codex:profile:work");
  });
  it("labels the Codex default and derives its email safely", async () => {
    const pi = await fixture();
    await credentials(pi, {
      openai: oauth("personal", "openai@example.test"),
      "openai-codex": oauth("work", "codex@example.test"),
    });
    const out = await new NativePiAccounts().view(state(), context(), true);
    expect(out.accounts.filter((a) => a.family === "pi")).toEqual([
      expect.objectContaining({
        id: "pi-native:codex:default",
        label: "Codex",
        email: "codex@example.test",
        isDefault: true,
      }),
    ]);
    expect(out.nextUp.pi).toBe("pi-native:codex:default");

    await credentials(pi, {
      "openai-codex": { type: "oauth", access: "malformed", expires: Date.now() + 600000 },
    });
    const withoutEmail = await new NativePiAccounts().view(state(), context(), true);
    expect(withoutEmail.accounts.find((a) => a.id === "pi-native:codex:default"))
      .toMatchObject({ label: "Codex", email: null });
  });
  it("needs an idle Pi session to manage accounts", async () => {
    await expect(
      new NativePiAccounts().manage({ operation: "default" }, context()),
    ).rejects.toThrow(/No idle Pi session/);
  });
  it("sends management to the Codex provider", async () => {
    const manage = vi.fn(async () => ({ ok: true }));
    await new NativePiAccounts({ manage } as never).manage(
      { operation: "default", accountId: "work" },
      context(),
    );
    expect(manage).toHaveBeenCalledWith(
      { operation: "default", accountId: "work", providerId: "openai-codex" },
      expect.anything(),
    );
  });
  it("only checks Codex agents before removing an account", async () => {
    const status = vi.fn(async () => ({
      available: true,
      snapshot: { providerId: "openai-codex", currentAccountId: "work" },
    }));
    const manage = vi.fn(async () => ({ ok: true }));
    const native = new NativePiAccounts({ status, manage } as never);
    await native.manage(
      { operation: "remove", accountId: "work" },
      withAgents(agent("plain", "openai/gpt-5")),
    );
    expect(status).not.toHaveBeenCalled();
    await expect(
      native.manage(
        { operation: "remove", accountId: "work" },
        withAgents(agent("codex", "openai-codex/gpt-5")),
      ),
    ).rejects.toThrow(/Switch every live Pi session/);
  });
});
