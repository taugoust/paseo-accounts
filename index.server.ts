import { randomUUID } from "node:crypto";
import type {
  PluginServerContext,
  PluginSettingsState,
} from "@getpaseo/plugin/server";
import { sendAlert } from "./server/alerts";
import { ClaudeAdapter } from "./server/claude";
import { CodexAdapter } from "./server/codex";
import { CopilotAdapter } from "./server/copilot";
import { KimiAdapter } from "./server/kimi";
import { OmpAdapter } from "./server/omp";
import { OpenCodeAdapter } from "./server/opencode";
import { PiAdapter } from "./server/pi";
import {
  isNativePiAccount,
  NativePiAccounts,
  refusePiManagement,
} from "./server/pi-native-view";
import { piAccountManageRpc } from "./shared/pi-native";
function nativePiIdentity(id: string) {
  if (id === "pi-native:default")
    return { providerId: "openai" as const, accountId: null };
  if (id === "pi-native:codex:default")
    return { providerId: "openai-codex" as const, accountId: null };
  const codex = id.startsWith("pi-native:codex:profile:");
  const prefix = codex ? "pi-native:codex:profile:" : "pi-native:profile:";
  if (!id.startsWith(prefix)) throw new Error("Invalid native Pi account ID.");
  return {
    providerId: codex ? ("openai-codex" as const) : ("openai" as const),
    accountId: decodeURIComponent(id.slice(prefix.length)),
  };
}
import { Service, describe } from "./server/service";
import { preferences } from "./shared/preferences";
import {
  cancelLogin,
  clearAccountLimit,
  getState,
  redeemReset,
  removeAccount,
  signOutAccount,
  renameAccount,
  setAgentAccount,
  setDefaultAccount,
  setAccountEnabled,
  setAccountFolders,
  testAlert,
  setAccountPriority,
  forkAgent,
  startLogin,
  submitLoginCode,
} from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const service = new Service({
    claude: new ClaudeAdapter(),
    codex: new CodexAdapter(),
    copilot: new CopilotAdapter(),
    kimi: new KimiAdapter(),
    opencode: new OpenCodeAdapter(),
    pi: new PiAdapter(),
    omp: new OmpAdapter(),
  });
  const nativePi = new NativePiAccounts();
  const settings = server.registerSettings(preferences);
  const applySettings = (
    state: PluginSettingsState<typeof preferences.schema>,
  ) => {
    if (state.status === "ready") service.setPreferences(state.values);
  };
  void settings
    .read()
    .then(applySettings, (error: unknown) =>
      console.error(
        "[paseo-accounts] could not read preferences",
        describe(error),
      ),
    );
  const stopSettings = settings.subscribe(applySettings);
  void service
    .start()
    .catch((error: unknown) =>
      console.error("[paseo-accounts] startup failed", describe(error)),
    );

  server.before("agent.session_open", async ({ request }, context) => {
    // Pi owns its credentials and persisted session selection. Never overwrite
    // its environment or silently fall back to a different account.
    if (request.provider === "pi") return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        service.onSessionOpen(request, context),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            console.error("[paseo-accounts] account routing timed out");
            resolve(undefined);
          }, 15_000);
        }),
      ]);
    } catch (error) {
      console.error("[paseo-accounts] routing failed", describe(error));
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  });
  server.on("agent.turn_started", (event, context) => {
    if (event.agent.provider !== "pi")
      void service.onTurnStarted(event.agent, context).catch(() => undefined);
  });
  server.on("agent.turn_ended", (event, context) => {
    if (event.agent.provider !== "pi")
      void service
        .onTurnEnded(event, context)
        .catch((error: unknown) =>
          console.error("[paseo-accounts] failover failed", describe(error)),
        );
  });
  server.on("agent.archived", (event) => {
    void service.onAgentArchived(event.agent.id).catch(() => undefined);
  });

  server.handle(getState, async ({ refreshUsage }, context) => {
    const view = await service.view(context.paseo, refreshUsage);
    try {
      return await nativePi.view(view, context, refreshUsage);
    } catch (error) {
      const diagnostic = describe(error)
        .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
        .replace(/\beyJ[\w-]*\.[\w-]*\.[\w-]*/g, "[JWT redacted]")
        .replace(/\b(?:sk|rk)-[\w-]{8,}\b/gi, "[API key redacted]")
        .replace(
          /((?:access|refresh|api[_-]?key|capability)["']?\s*[:=]\s*["']?)[^,\s"'}]+/gi,
          "$1[redacted]",
        )
        .replace(/[\r\n\t]+/g, " ")
        .slice(0, 300);
      console.error(`[paseo-accounts] Pi account view failed: ${diagnostic}`);
      return {
        ...view,
        accounts: view.accounts.filter((a) => a.family !== "pi"),
        agents: view.agents.filter((a) => a.family !== "pi"),
        installed: view.installed.filter((f) => f !== "pi"),
        logins: view.logins.filter((l) => l.family !== "pi"),
        warnings: [...view.warnings, "Pi account bridge unavailable."],
      };
    }
  });
  server.handle(piAccountManageRpc, async (input, context) => {
    const result = await nativePi.manage(input, context);
    return {
      ok: true as const,
      ...(typeof result?.accountId === "string"
        ? { accountId: result.accountId }
        : {}),
    };
  });
  server.handle(
    startLogin,
    async ({ family, method, accountId, providerId }, context) => {
      if (providerId && family !== "pi") throw new Error("providerId is only valid for native Pi account setup.");
      if (family === "pi") {
        const codex =
          accountId?.startsWith("pi-native:codex:") ||
          providerId === "openai-codex";
        const prefix = accountId?.startsWith("pi-native:codex:profile:")
          ? "pi-native:codex:profile:"
          : "pi-native:profile:";
        const name = accountId?.startsWith(prefix)
          ? decodeURIComponent(accountId.slice(prefix.length))
          : undefined;
        const result = await nativePi.manage(
          {
            operation: "add",
            ...(name ? { accountName: name } : {}),
            method: "oauth",
            providerId: codex ? "openai-codex" : "openai",
          },

          context,
        );
        return {
          id: randomUUID(),
          family: "pi",
          method,
          accountId:
            typeof result?.accountId === "string"
              ? `pi-native:${codex ? "codex:" : ""}profile:${encodeURIComponent(result.accountId)}`
              : null,
          step: "done",
          url: null,
          codeUrl: null,
          userCode: null,
          message: null,
          startedAt: new Date().toISOString(),
        };
      }
      if (accountId) refusePiManagement(accountId);
      return service.startLogin(family, method, accountId);
    },
  );
  server.handle(submitLoginCode, ({ loginId, code }) =>
    service.submitCode(loginId, code),
  );
  server.handle(cancelLogin, ({ loginId }) => service.cancelLogin(loginId));
  server.handle(renameAccount, async ({ accountId, label }, context) => {
    if (isNativePiAccount(accountId)) {
      const identity = nativePiIdentity(accountId);
      await nativePi.manage(
        {
          operation: "rename",
          ...identity,
          accountId: identity.accountId ?? undefined,
          label,
        },
        context,
      );
      return { ok: true as const };
    }
    await service.rename(accountId, label);
    return { ok: true as const };
  });
  server.handle(removeAccount, async ({ accountId }, context) => {
    if (isNativePiAccount(accountId)) {
      const identity = nativePiIdentity(accountId);
      await nativePi.manage(
        {
          operation: "remove",
          ...identity,
          accountId: identity.accountId ?? undefined,
        },
        context,
      );
      return { ok: true as const, movedAgents: 0 };
    }
    const { paseo } = context;
    return {
      ok: true as const,
      movedAgents: await service.remove(paseo, accountId),
    };
  });
  server.handle(signOutAccount, async ({ accountId }, { paseo }) => {
    refusePiManagement(accountId);
    return {
      ok: true as const,
      movedAgents: await service.signOut(paseo, accountId),
    };
  });
  server.handle(setDefaultAccount, async ({ accountId }, context) => {
    if (isNativePiAccount(accountId)) {
      const identity = nativePiIdentity(accountId);
      await nativePi.manage(
        {
          operation: "default",
          providerId: identity.providerId,
          accountId: identity.accountId,
        },
        context,
      );
      return { reopened: [], deferred: [], failed: [], continuedIn: null };
    }
    return service.setDefault(context.paseo, accountId);
  });
  server.handle(clearAccountLimit, async ({ accountId }) => {
    refusePiManagement(accountId);
    await service.clearLimit(accountId);
    return { ok: true as const };
  });
  server.handle(redeemReset, ({ accountId, agentId }, { paseo }) => {
    refusePiManagement(accountId);
    return service.redeem(paseo, accountId, agentId);
  });
  server.handle(setAgentAccount, async ({ agentId, accountId }, context) => {
    const agent = (await context.paseo.agents.ref(agentId).refresh())?.agent;
    if (!agent) throw new Error("Conversation is no longer available.");
    if (agent.provider === "pi")
      return nativePi.switch(agentId, accountId, context);
    if (accountId) refusePiManagement(accountId);
    return service.setAgentAccount(context.paseo, agentId, accountId);
  });
  server.handle(forkAgent, async ({ agentId, to }, { paseo }) => {
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (agent?.provider === "pi" || to === "pi")
      throw new Error(
        "Pi accounts are switched explicitly in place, not by provider forks.",
      );
    return service.forkAgent(paseo, agentId, to);
  });
  server.handle(setAccountPriority, async ({ accountId, priority }) => {
    refusePiManagement(accountId);
    await service.setPriority(accountId, priority);
    return { ok: true as const };
  });
  server.handle(testAlert, async ({ url }) => {
    await sendAlert(
      url,
      "Test alert",
      "Alerts from paseo-accounts arrive here.",
    );
    return { ok: true as const };
  });
  server.handle(setAccountFolders, ({ accountId, paths }, { paseo }) => {
    refusePiManagement(accountId);
    return service.setFolders(paseo, accountId, paths);
  });
  server.handle(setAccountEnabled, ({ accountId, enabled }, { paseo }) => {
    refusePiManagement(accountId);
    return service.setAccountEnabled(paseo, accountId, enabled);
  });
  return async () => {
    stopSettings();
    await service.stop();
  };
}
