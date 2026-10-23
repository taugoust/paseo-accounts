import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AccountView, AgentRoute, StateView } from "../shared/model";
import { createAccountControlsHandlers } from "./pi-native";
import { fetchPiQuota, quotaCredential, readQuotaAuthData } from "./pi-quota";
import type { PiQuotaCredential, QuotaResult } from "./pi-quota";

const PREFIX = "pi-native:";
const QUOTA_CACHE_MS = 60_000;
type NativeProvider = "openai" | "openai-codex";
const accountId = (name: string | null, provider: NativeProvider = "openai") =>
  provider === "openai"
    ? name === null
      ? `${PREFIX}default`
      : `${PREFIX}profile:${encodeURIComponent(name)}`
    : name === null
      ? `${PREFIX}codex:default`
      : `${PREFIX}codex:profile:${encodeURIComponent(name)}`;
export const isNativePiAccount = (id: string) => id.startsWith(PREFIX);
export function refusePiManagement(id: string) {
  if (isNativePiAccount(id))
    throw new Error(
      "This control isn't supported for Pi accounts; use the Pi account manager for sign-in, rename, removal, defaults and switching.",
    );
}
type StoredProfile = {
  provider: NativeProvider;
  id: string;
  label: string;
  authKind: "oauth" | "api-key";
  isDefault: boolean;
  quotaCredential?: PiQuotaCredential;
};
type StoredProfiles = {
  profiles: StoredProfile[];
  active: string | null;
  codexActive: string | null;
  defaultCredential?: PiQuotaCredential;
  codexDefaultCredential?: PiQuotaCredential;
  codexDefaultEmail?: string | null;
  companionCredential?: PiQuotaCredential;
  companionUsageEnabled?: boolean;
};
function quotaPlanLabel(result: QuotaResult): string | null {
  if (!result.plan) return null;
  if (result.source === "codex") return `Codex · ${result.plan}`;
  if (result.source !== "codex-companion") return result.plan;
  return result.identityVerified === false
    ? `Codex companion (identity unverified) · ${result.plan}`
    : `Codex companion · ${result.plan}`;
}
function oauthEmail(value: unknown): string | null {
  const credential = record(value);
  if (credential?.type !== "oauth" && credential?.kind !== "oauth") return null;
  const identity = record(credential.account);
  const direct = identity?.email;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const access = credential.access;
  if (typeof access !== "string") return null;
  try {
    const parts = access.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    const claims = record(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
    const auth = record(claims?.["https://api.openai.com/auth"]);
    const email = claims?.email ?? auth?.email;
    return typeof email === "string" && email.trim() ? email.trim() : null;
  } catch {
    return null;
  }
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
async function readCanonicalProfiles(): Promise<StoredProfiles> {
  const directory =
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const empty = (): StoredProfiles => ({
    profiles: [],
    active: null,
    codexActive: null,
  });
  try {
    const dir = await lstat(directory);
    if (
      !dir.isDirectory() ||
      dir.isSymbolicLink() ||
      (dir.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" && dir.uid !== process.getuid())
    )
      return empty();
    const quotaAuth = await readQuotaAuthData(directory);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(
        join(directory, "pi-accounts.json"),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
    } catch {
      return {
        ...empty(),
        ...quotaAuth,
        codexDefaultEmail: oauthEmail(quotaAuth.codexDefaultCredential),
      };
    }
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        (typeof process.getuid === "function" &&
          stat.uid !== process.getuid()) ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size > 2 * 1024 * 1024
      )
        return {
          ...empty(),
          ...quotaAuth,
          codexDefaultEmail: oauthEmail(quotaAuth.codexDefaultCredential),
        };
      const parsed = JSON.parse(await handle.readFile("utf8"));
      const entries = parsed?.providers?.openai?.accounts;
      const codexEntries = parsed?.providers?.["openai-codex"]?.accounts;
      const active =
        typeof parsed?.providers?.openai?.active === "string"
          ? parsed.providers.openai.active
          : null;
      const codexActive =
        typeof parsed?.providers?.["openai-codex"]?.active === "string"
          ? parsed.providers["openai-codex"].active
          : null;
      const list = (
        provider: NativeProvider,
        data: unknown,
        selected: string | null,
      ): StoredProfile[] => {
        if (!data || typeof data !== "object" || Array.isArray(data)) return [];
        return Object.entries(data).flatMap(([id, credential]) => {
          const value = record(credential),
            type = value?.type;
          if (
            !/^[A-Za-z0-9._-]{1,64}$/.test(id) ||
            (type !== "oauth" && type !== "api_key")
          )
            return [];
          const label =
            typeof value?.label === "string" && value.label.trim()
              ? value.label.trim().slice(0, 40)
              : id;
          return [
            {
              provider,
              id,
              label: provider === "openai-codex" ? `${label} (Codex)` : label,
              authKind:
                type === "api_key" ? ("api-key" as const) : ("oauth" as const),
              isDefault: selected === id,
              quotaCredential: quotaCredential(value),
            },
          ];
        });
      };
      return {
        profiles: [
          ...list("openai", entries, active),
          ...list("openai-codex", codexEntries, codexActive),
        ],
        active,
        codexActive,
        ...quotaAuth,
        codexDefaultEmail: oauthEmail(quotaAuth.codexDefaultCredential),
      };
    } finally {
      await handle.close();
    }
  } catch {
    return empty();
  }
}
export class NativePiAccounts {
  private readonly controls: ReturnType<typeof createAccountControlsHandlers>;
  constructor(controls = createAccountControlsHandlers()) {
    this.controls = controls;
  }
  private readonly quotaCache = new Map<
    string,
    { fingerprint: string; at: number; result: QuotaResult }
  >();
  private async quotaFor(
    key: string,
    credential: PiQuotaCredential | undefined,
    companion: PiQuotaCredential | undefined,
    companionUsageEnabled: boolean,
    refresh: boolean,
    provider: NativeProvider,
  ): Promise<QuotaResult> {
    if (!credential) return { usage: null, plan: null };
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          credential.kind === "oauth"
            ? [
                credential.access,
                credential.accountId,
                credential.clientId,
                credential.scopes,
              ]
            : credential.kind,
          companion?.kind === "oauth"
            ? [companion.access, companion.accountId]
            : companion?.kind,
          companionUsageEnabled,
          key === accountId(null, provider),
        ]),
      )
      .digest("hex");
    const cached = this.quotaCache.get(key);
    if (
      !refresh &&
      cached?.fingerprint === fingerprint &&
      Date.now() - cached.at < QUOTA_CACHE_MS
    )
      return {
        ...cached.result,
        usage: cached.result.usage
          ? { ...cached.result.usage, cached: true }
          : null,
      };
    const result = await fetchPiQuota(
      credential,
      provider === "openai" ? companion : undefined,
      provider === "openai" && companionUsageEnabled,
      key === accountId(null, provider),
      provider,
    );
    this.quotaCache.set(key, { fingerprint, at: Date.now(), result });
    return result;
  }
  async view(
    base: StateView,
    context: PluginHandlerContext,
    refreshUsage = false,
  ): Promise<StateView> {
    const stored = await readCanonicalProfiles(),
      canonical = stored.profiles;
    const targets: Array<{
      id: string;
      workspaceId: string;
      title: string | null;
      cwd: string;
      status: string;
      model: string | null;
    }> = [];
    let cursor: string | undefined,
      complete = false,
      discoveryUnavailable = false;
    for (let page = 0; page < 10; page++) {
      try {
        const result = await context.paseo.agents.list({
          page: { limit: 200, ...(cursor ? { cursor } : {}) },
        });
        for (const { agent } of result.entries)
          if (
            agent.provider === "pi" &&
            !agent.archivedAt &&
            agent.status !== "closed" &&
            agent.workspaceId
          )
            targets.push({
              id: agent.id,
              workspaceId: agent.workspaceId,
              title: agent.title ?? null,
              cwd: agent.cwd,
              status: agent.status,
              model: typeof agent.model === "string" ? agent.model : null,
            });
        if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) {
          complete = true;
          break;
        }
        cursor = result.pageInfo.nextCursor;
      } catch {
        discoveryUnavailable = true;
        break;
      }
    }
    const routes: AgentRoute[] = [],
      piLogins: StateView["logins"] = [];
    let cursorIndex = 0,
      unavailable = 0;
    await Promise.all(
      Array.from({ length: Math.min(6, targets.length) }, async () => {
        while (cursorIndex < targets.length) {
          const agent = targets[cursorIndex++];
          if (!agent) continue;
          try {
            const provider = agent.model?.startsWith("openai-codex/")
              ? "openai-codex"
              : agent.model?.startsWith("openai/")
                ? "openai"
                : null;
            if (!provider) {
              unavailable++;
              continue;
            }
            const status = await this.controls.status(
              {
                agentId: agent.id,
                workspaceId: agent.workspaceId,
                ...(provider === "openai-codex"
                  ? { providerId: provider }
                  : {}),
              },
              context,
            );
            if (!status.available || !status.snapshot) {
              unavailable++;
              continue;
            }
            const snapshot = status.snapshot;
            if (
              (snapshot.providerId ?? "openai") !== provider ||
              (provider === "openai-codex" &&
                !snapshot.supportedProviders?.includes(provider))
            ) {
              unavailable++;
              continue;
            }
            for (const name of snapshot.pendingAccountNames ?? [])
              piLogins.push({
                id: `pi-login:${agent.id}:${name}`,
                family: "pi",
                method: "code",
                accountId: accountId(name, provider),
                step: "waiting",
                url: null,
                codeUrl: null,
                userCode: null,
                message:
                  "Complete the Pi sign-in prompt; this view refreshes automatically.",
                startedAt: new Date().toISOString(),
              });
            const selected = snapshot.currentAccountId;
            routes.push({
              agentId: agent.id,
              family: "pi",
              accountId: accountId(selected, provider),
              pinned: selected !== null,
              pendingAccountId: null,
              movable: true,
              canSwitch: snapshot.canSwitch,
              provider: "pi",
              title: agent.title,
              cwd: agent.cwd,
              status: agent.status,
            });
            for (const row of snapshot.accounts)
              if (
                row.id &&
                !canonical.some(
                  (p) => p.id === row.id && p.provider === provider,
                )
              )
                canonical.push({
                  provider,
                  id: row.id,
                  label: row.label,
                  authKind: row.authKind,
                  isDefault: false,
                });
          } catch {
            unavailable++;
          }
        }
      }),
    );
    canonical.sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
    );
    const quotaById = new Map<string, QuotaResult>();
    let quotaIndex = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, canonical.length) }, async () => {
        while (quotaIndex < canonical.length) {
          const p = canonical[quotaIndex++];
          if (!p) continue;
          const key = accountId(p.id, p.provider);
          quotaById.set(
            key,
            await this.quotaFor(
              key,
              p.quotaCredential,
              stored.companionCredential,
              stored.companionUsageEnabled === true,
              refreshUsage,
              p.provider,
            ),
          );
        }
      }),
    );
    const openDefault = await this.quotaFor(
      accountId(null),
      stored.defaultCredential,
      stored.companionCredential,
      stored.companionUsageEnabled === true,
      refreshUsage,
      "openai",
    );
    const codexDefault = await this.quotaFor(
      accountId(null, "openai-codex"),
      stored.codexDefaultCredential,
      undefined,
      false,
      refreshUsage,
      "openai-codex",
    );
    const counts = new Map<string, number>();
    for (const route of routes)
      counts.set(route.accountId, (counts.get(route.accountId) ?? 0) + 1);
    const makeAccount = (
      id: string,
      label: string,
      quota: QuotaResult,
      isDefault: boolean,
      kind: "main" | "managed",
    ): AccountView => ({
      id,
      family: "pi",
      label,
      kind,
      email: null,
      plan: quotaPlanLabel(quota),
      organization: null,
      status: "ready",
      isDefault,
      limitedUntil: null,
      usage: quota.usage,
      agentCount: counts.get(id) ?? 0,
      home: null,
      priority: "normal",
      forecast: null,
      trend: [],
      folders: [],
    });
    const accounts: AccountView[] = [
      makeAccount(
        accountId(null),
        "Default Pi login",
        openDefault,
        stored.active === null,
        "main",
      ),
      {
        ...makeAccount(
          accountId(null, "openai-codex"),
          "Codex",
          codexDefault,
          stored.codexActive === null,
          "main",
        ),
        email: stored.codexDefaultEmail ?? null,
      },
      ...canonical.map((p) =>
        makeAccount(
          accountId(p.id, p.provider),
          p.label,
          quotaById.get(accountId(p.id, p.provider)) ?? {
            usage: null,
            plan: null,
          },
          p.isDefault,
          "managed",
        ),
      ),
    ];
    const warnings = [...base.warnings];
    if (unavailable)
      warnings.push(
        `${unavailable} Pi sessions are not connected to the live account switcher; their current selection is left unknown.`,
      );
    if (discoveryUnavailable)
      warnings.push(
        "Pi session discovery is temporarily unavailable. Stored account data is still shown.",
      );
    if (!complete && !discoveryUnavailable)
      warnings.push(
        "Pi session discovery reached its page limit; the conversation list may be incomplete.",
      );
    return {
      ...base,
      accounts: [
        ...base.accounts.filter((i) => i.family !== "pi"),
        ...accounts,
      ],
      nextUp: {
        ...base.nextUp,
        pi: stored.active ? accountId(stored.active) : accountId(null),
      },
      agents: [...base.agents.filter((i) => i.family !== "pi"), ...routes],
      installed: [
        ...new Set([
          ...base.installed.filter((f) => f !== "pi"),
          "pi" as const,
        ]),
      ],
      logins: [...base.logins.filter((l) => l.family !== "pi"), ...piLogins],
      fallbacks: base.fallbacks.filter((f) => base.providers[f.id] !== "pi"),
      warnings,
    };
  }
  async manage(
    request: {
      operation: "add" | "cancel-login" | "rename" | "remove" | "default";
      accountId?: string | null;
      accountName?: string;
      label?: string;
      method?: "oauth" | "api_key";
      providerId?: NativeProvider;
    },
    context: PluginHandlerContext,
  ) {
    const provider = request.providerId ?? "openai";
    if (provider === "openai-codex")
      await this.requireProviderSupport(provider, context);
    if (request.operation === "remove") {
      const agents = await context.paseo.agents.list({ page: { limit: 200 } });
      if (agents.pageInfo.hasMore)
        throw new Error(
          "Cannot safely remove a Pi account until the full Pi session list is available.",
        );
      for (const { agent } of agents.entries) {
        if (
          agent.provider !== "pi" ||
          agent.archivedAt ||
          agent.status === "closed" ||
          !agent.workspaceId
        )
          continue;
        const status = await this.controls.status(
          {
            agentId: agent.id,
            workspaceId: agent.workspaceId,
            providerId: provider,
          },
          context,
        );
        if (
          status.available &&
          !!status.snapshot &&
          (status.snapshot.providerId ?? "openai") === provider &&
          status.snapshot.currentAccountId === request.accountId
        )
          throw new Error(
            "Switch every live Pi session away from this account before removing it.",
          );
      }
    }
    return this.controls.manage({ ...request, providerId: provider }, context);
  }
  private async requireProviderSupport(
    provider: NativeProvider,
    context: PluginHandlerContext,
  ) {
    const agents = await context.paseo.agents.list({ page: { limit: 200 } });
    for (const { agent } of agents.entries) {
      if (
        agent.provider !== "pi" ||
        agent.archivedAt ||
        agent.status === "closed" ||
        !agent.workspaceId
      )
        continue;
      const status = await this.controls.status(
        {
          agentId: agent.id,
          workspaceId: agent.workspaceId,
          providerId: provider,
        },
        context,
      );
      if (
        !status.available ||
        !status.snapshot ||
        (status.snapshot.providerId ?? "openai") !== provider ||
        (provider === "openai-codex" &&
          !status.snapshot.supportedProviders?.includes(provider))
      )
        throw new Error(
          "This Pi account service does not support Codex profiles; refresh Pi to a provider-aware version.",
        );
      return;
    }
    throw new Error(
      "No live Pi account service can verify Codex provider support.",
    );
  }
  async switch(
    agentId: string,
    id: string | null,
    context: PluginHandlerContext,
  ) {
    const parsed =
      id === null
        ? { provider: "openai" as NativeProvider, name: null }
        : id === accountId(null, "openai-codex")
          ? { provider: "openai-codex" as NativeProvider, name: null }
          : id.startsWith(`${PREFIX}codex:profile:`)
            ? {
                provider: "openai-codex" as NativeProvider,
                name: decodeURIComponent(
                  id.slice(`${PREFIX}codex:profile:`.length),
                ),
              }
            : id === accountId(null)
              ? { provider: "openai" as NativeProvider, name: null }
              : id.startsWith(`${PREFIX}profile:`)
                ? {
                    provider: "openai" as NativeProvider,
                    name: decodeURIComponent(
                      id.slice(`${PREFIX}profile:`.length),
                    ),
                  }
                : null;
    if (!parsed)
      throw new Error("Choose a Pi account from the canonical list.");
    const { provider, name } = parsed;
    const current = (await context.paseo.agents.ref(agentId).refresh())?.agent;
    if (
      !current ||
      current.provider !== "pi" ||
      !current.workspaceId ||
      current.archivedAt
    )
      throw new Error("The selected Pi conversation is no longer available.");
    const modelProvider =
      typeof current.model === "string" &&
      current.model.startsWith("openai-codex/")
        ? "openai-codex"
        : typeof current.model === "string" &&
            current.model.startsWith("openai/")
          ? "openai"
          : null;
    if (!modelProvider || modelProvider !== provider)
      throw new Error(
        `Choose a matching ${provider === "openai-codex" ? "Codex" : "OpenAI"} model first; account selection does not change the model provider.`,
      );
    const status = await this.controls.status(
      {
        agentId,
        workspaceId: current.workspaceId,
        ...(provider === "openai-codex" ? { providerId: provider } : {}),
      },
      context,
    );
    if (!status.available || !status.snapshot)
      throw new Error(
        status.reason ?? "The selected Pi session has no live account bridge.",
      );
    if (
      (status.snapshot.providerId ?? "openai") !== provider ||
      (provider === "openai-codex" &&
        !status.snapshot.supportedProviders?.includes(provider))
    )
      throw new Error(
        "This Pi account service does not support the requested provider; no switch was sent.",
      );
    if (name && !status.snapshot.accounts.some((a) => a.id === name))
      throw new Error(
        "That Pi account is not available in the live Pi session. Refresh its account manager and retry.",
      );
    if (!status.snapshot.canSwitch)
      throw new Error("Wait until Pi is idle before changing its account.");
    if (provider === "openai-codex")
      await this.requireProviderSupport(provider, context);
    const result = await this.controls.switch(
      {
        agentId,
        workspaceId: current.workspaceId,
        expectedSessionId: status.sessionId!,
        expectedRuntimeEpoch: status.runtimeEpoch!,
        request: {
          protocol: 1,
          requestId: randomUUID(),
          expectedSessionId: status.snapshot.sessionId,
          expectedServiceEpoch: status.snapshot.serviceEpoch,
          expectedSelectionRevision: status.snapshot.selectionRevision,
          accountId: name,
          providerId: provider,
        },
      },
      context,
    );
    if (result.ok !== true)
      throw new Error(
        `Pi account switch failed (${result.reason}); refresh before retrying.`,
      );
    if (
      (result.snapshot.providerId ?? "openai") !== provider ||
      (provider === "openai-codex" &&
        !result.snapshot.supportedProviders?.includes(provider))
    )
      throw new Error(
        "Pi service returned a mismatched provider after switching.",
      );
    return { reopened: [agentId], deferred: [], failed: [], continuedIn: null };
  }
}
