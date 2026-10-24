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
describe("provider-aware native Pi accounts", () => {
  it("keeps same-name OpenAI/Codex profiles distinct and represents both defaults", async () => {
    const pi = await fixture();
    await credentials(pi, {
      openai: {
        type: "oauth",
        access: token("personal"),
        expires: Date.now() + 600000,
      },
      "openai-codex": {
        type: "oauth",
        access: token("work"),
        expires: Date.now() + 600000,
      },
    });
    await accounts(pi, {
      providers: {
        openai: {
          active: "work",
          accounts: {
            work: {
              type: "oauth",
              access: token("personal"),
              expires: Date.now() + 600000,
              label: "Personal",
            },
          },
        },
        "openai-codex": {
          active: "work",
          accounts: {
            work: {
              type: "oauth",
              access: token("work"),
              expires: Date.now() + 600000,
              label: "Work",
            },
          },
        },
      },
    });
    const out = await new NativePiAccounts().view(state(), context(), true);
    const rows = out.accounts.filter((a) => a.family === "pi");
    expect(rows.map((a) => a.id)).toContain("pi-native:profile:work");
    expect(rows.map((a) => a.id)).toContain("pi-native:codex:profile:work");
    expect(rows.map((a) => a.id)).toContain("pi-native:default");
    expect(rows.map((a) => a.id)).toContain("pi-native:codex:default");
    expect(rows.find((a) => a.id === "pi-native:profile:work")?.label).toBe(
      "Personal",
    );
    expect(
      rows.find((a) => a.id === "pi-native:codex:profile:work")?.label,
    ).toBe("Work (Codex)");
  });
  it("labels the Codex default and derives its email safely without changing OpenAI identity", async () => {
    const pi = await fixture();
    await credentials(pi, {
      openai: { type: "oauth", access: token("personal", "openai@example.test"), expires: Date.now() + 600000 },
      "openai-codex": { type: "oauth", access: token("work", "codex@example.test"), expires: Date.now() + 600000 },
    });
    const out = await new NativePiAccounts().view(state(), context(), true);
    const codex = out.accounts.find((a) => a.id === "pi-native:codex:default");
    const openai = out.accounts.find((a) => a.id === "pi-native:default");
    expect(out.warnings.some((warning) => warning.includes("Automatic Pi failover is intentionally disabled"))).toBe(false);
    expect(codex).toMatchObject({ label: "Codex", email: "codex@example.test" });
    expect(openai).toMatchObject({ label: "Default Pi login", email: null });

    await credentials(pi, {
      openai: { type: "oauth", access: token("personal"), expires: Date.now() + 600000 },
      "openai-codex": { type: "oauth", access: "malformed", expires: Date.now() + 600000 },
    });
    const withoutEmail = await new NativePiAccounts().view(state(), context(), true);
    expect(withoutEmail.accounts.find((a) => a.id === "pi-native:codex:default"))
      .toMatchObject({ label: "Codex", email: null });
  });
  it("fails closed on Codex management when no provider-aware service exists", async () => {
    const calls: string[] = [];
    const ctx = {
      paseo: {
        agents: {
          list: async () => ({ entries: [], pageInfo: { hasMore: false } }),
        },
      },
    } as never;
    const controls = new NativePiAccounts();
    await expect(
      controls.manage(
        { operation: "default", providerId: "openai-codex" },
        ctx,
      ),
    ).rejects.toThrow(/No live Pi account service/);
    expect(calls).toEqual([]);
  });
  it("routes OpenAI and Codex agents by authoritative model prefix", async () => {
    const calls: string[] = [];
    const contextWithAgents = {
      paseo: {
        agents: {
          list: async () => ({
            entries: [
              {
                agent: {
                  id: "work-agent",
                  provider: "pi",
                  model: "openai-codex/gpt-5",
                  workspaceId: "w",
                  cwd: "/w",
                  title: null,
                  status: "idle",
                  archivedAt: null,
                },
              },
              {
                agent: {
                  id: "personal-agent",
                  provider: "pi",
                  model: "openai/gpt-5",
                  workspaceId: "p",
                  cwd: "/p",
                  title: null,
                  status: "idle",
                  archivedAt: null,
                },
              },
            ],
            pageInfo: { hasMore: false },
          }),
        },
      },
    } as never;
    const controls = {
      status: async (input: { agentId: string; providerId?: string }) => {
        const codex = (input.providerId ?? "openai") === "openai-codex";
        calls.push(`${input.agentId}:${input.providerId ?? "openai"}`);
        return {
          available: true,
          sessionId: "s",
          runtimeEpoch: "e",
          snapshot: {
            sessionId: "s",
            providerId: codex ? "openai-codex" : "openai",
            sessionRouting: { version: 1, providerId: codex ? "openai-codex" : "openai", revision: 1 },
            supportedProviders: ["openai", "openai-codex"],
            accounts: [{ id: "work", label: "Work", authKind: "oauth" }],
            currentAccountId: "work",
            canSwitch: true,
            pendingAccountNames: [],
          },
          reason: null,
        };
      },
    } as never;
    const out = await new NativePiAccounts(controls).view(
      state(),
      contextWithAgents,
      true,
    );
    expect(calls).toContain("work-agent:openai-codex");
    expect(calls).toContain("personal-agent:openai");
    expect(out.agents.find((a) => a.agentId === "work-agent")?.accountId).toBe(
      "pi-native:codex:profile:work",
    );
    expect(
      out.agents.find((a) => a.agentId === "personal-agent")?.accountId,
    ).toBe("pi-native:profile:work");
  });
  it("switches providers with committed routing capability, regardless of model alias", async () => {
    const calls: any[] = [];
    let routing: any = { version: 1, providerId: "openai", revision: 4 };
    const controls = {
      status: async (input: any) => ({ available: true, sessionId: "s", runtimeEpoch: "e", reason: null, snapshot: {
        protocol: 1, sessionId: "s", serviceEpoch: "svc", selectionRevision: 2,
        providerId: input.providerId ?? "openai", sessionRouting: routing,
        supportedProviders: ["openai", "openai-codex"], accounts: input.providerId === "openai-codex" ? [{ id: "work", label: "Work", authKind: "oauth" }] : [{ id: "alpha", label: "Alpha", authKind: "oauth" }],
        currentAccountId: null, defaultSelected: true, activationStatus: "active", busy: false, canSwitch: true,
        usage: { effectiveCredential: "unknown", status: "unknown", remoteEntitlement: "not-queried", settingsUrl: null }, pendingAccountNames: [],
      }}),
      switch: async (input: any) => { calls.push(input.request); routing = { ...routing, providerId: input.request.providerId, revision: routing.revision + 1 }; return { ok: true, snapshot: { providerId: routing.providerId, supportedProviders: ["openai", "openai-codex"] } }; },
    } as never;
    const ctx = { paseo: { agents: { ref: () => ({ refresh: async () => ({ agent: { id: "a", provider: "pi", workspaceId: "w", model: "openai/guard-alias", archivedAt: null } }) }), list: async () => ({ entries: [{ agent: { id: "a", provider: "pi", workspaceId: "w", status: "idle", archivedAt: null } }], pageInfo: { hasMore: false } }) } } } as never;
    const service = new NativePiAccounts(controls);
    await service.switch("a", "pi-native:codex:profile:work", ctx);
    expect(calls[0]).toMatchObject({ providerId: "openai-codex", expectedRoutingRevision: 4 });
    await service.switch("a", "pi-native:profile:alpha", ctx);
    expect(calls[1]).toMatchObject({ providerId: "openai", expectedRoutingRevision: 5 });
  });
  it("refuses cross-provider changes on legacy runtimes and stale/missing identities", async () => {
    const ctx = { paseo: { agents: { ref: () => ({ refresh: async () => ({ agent: { id: "a", provider: "pi", workspaceId: "w", model: "openai/guard", archivedAt: null } }) }) } } } as never;
    const legacy = { status: async () => ({ available: true, sessionId: "s", runtimeEpoch: "e", snapshot: { sessionId: "s", providerId: "openai", accounts: [], canSwitch: true } }), switch: vi.fn() } as never;
    await expect(new NativePiAccounts(legacy).switch("a", "pi-native:codex:default", ctx)).rejects.toThrow(/older Pi account service/);
    const stale = { status: async () => ({ available: true, sessionId: "other", runtimeEpoch: "e", snapshot: { sessionId: "s", providerId: "openai", sessionRouting: { version: 1, providerId: "openai", revision: 1 }, accounts: [], canSwitch: true } }) } as never;
    await expect(new NativePiAccounts(stale).switch("a", "pi-native:default", ctx)).rejects.toThrow(/stale or missing session metadata/);
  });
  it("uses root Codex auth for OpenAI companion independently from named Work Codex quota", async () => {
    const pi = await fixture();
    await credentials(pi, {
      openai: {
        type: "oauth",
        access: token("personal"),
        expires: Date.now() + 600000,
        clientId: "native",
        scopes: ["chatgpt.tokens.use.direct"],
      },
      "openai-codex": {
        type: "oauth",
        access: token("personal"),
        expires: Date.now() + 600000,
      },
    });
    await accounts(pi, {
      providers: {
        "openai-codex": {
          accounts: {
            work: {
              type: "oauth",
              access: token("work"),
              expires: Date.now() + 600000,
            },
          },
        },
      },
    });
    await writeFile(
      join(pi, "pi-usage.json"),
      JSON.stringify({ openaiUseCodexUsage: true }),
      { mode: 0o600 },
    );
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (_url: string, init: { headers: Record<string, string> }) => {
        seen.push(init.headers["ChatGPT-Account-Id"] ?? "");
        return new Response(
          JSON.stringify({
            plan_type: "Plus",
            rate_limit: {
              primary_window: { used_percent: 10, limit_window_seconds: 3600 },
            },
          }),
          { status: 200 },
        );
      },
    );
    const out = await new NativePiAccounts().view(state(), context(), true);
    expect(seen).toContain("personal");
    expect(seen).toContain("work");
    expect(
      out.accounts.find((a) => a.id === "pi-native:codex:profile:work")?.usage,
    ).not.toBeNull();
  });
});
