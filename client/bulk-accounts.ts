import type { AccountView, AgentRoute, StateView } from "../shared/model";
import { setAgentAccount, setAgentProvider, type ReopenSummary } from "../shared/rpc";
import type { AccountsStore } from "./store";

/** Native account IDs encode a provider namespace, not merely an account label. */
function piProvider(id: string): "openai" | "openai-codex" | null {
  for (const [prefix, provider] of [
    ["pi-native:", "openai"],
    ["pi-native:codex:", "openai-codex"],
  ] as const) {
    if (id === `${prefix}default`) return provider;
    if (!id.startsWith(`${prefix}profile:`)) continue;
    const name = id.slice(`${prefix}profile:`.length);
    try {
      if (name && encodeURIComponent(decodeURIComponent(name)) === name) return provider;
    } catch {
      // Malformed/noncanonical IDs are not safe bulk targets.
    }
  }
  return null;
}

/** Null means that this route has no known, unambiguous source account. */
export function bulkGroup(agent: AgentRoute, state: StateView): string | null {
  const source = state.accounts.find((account) => account.id === agent.accountId);
  if (!source || source.family !== agent.family || !agent.provider) return null;
  if (agent.family === "pi") {
    const provider = piProvider(source.id);
    return provider ? JSON.stringify([agent.family, agent.provider, provider]) : null;
  }
  return JSON.stringify([agent.family, agent.provider]);
}

/** Only native Pi has an atomic idle guard; explicit pins are intentionally replaced. */
export function eligible(agent: AgentRoute, state: StateView): boolean {
  return (
    agent.family === "pi" &&
    (agent.status === "idle" || agent.status === "error") &&
    agent.pendingAccountId === null &&
    agent.movable &&
    agent.canSwitch !== false &&
    bulkGroup(agent, state) !== null
  );
}

/** Ready host-local accounts only, never Pi OpenAI/Codex cross-provider targets. */
export function compatibleAccounts(agent: AgentRoute, state: StateView): AccountView[] {
  if (bulkGroup(agent, state) === null) return [];
  return state.accounts.filter((account) =>
    account.family === agent.family && account.status === "ready" &&
    (agent.family !== "pi" || piProvider(account.id) === piProvider(agent.accountId)),
  );
}

export interface BulkAgentResult {
  agentId: string;
  outcome: "changed" | "skipped" | "failed";
  reason: string;
  /** Preserve queued/forked/failed server outcomes instead of claiming an in-place move. */
  summary?: ReopenSummary;
}

export interface BulkChangeResult {
  changed: number;
  skipped: number;
  failed: number;
  results: BulkAgentResult[];
}

type BulkStore = Pick<AccountsStore, "current" | "refresh" | "rpc">;

function fingerprint(agent: AgentRoute): string {
  return JSON.stringify([
    agent.agentId, agent.family, agent.provider, agent.accountId,
    agent.pinned, agent.pendingAccountId, agent.cwd,
  ]);
}

function currentSource(check: () => boolean | void): boolean {
  try {
    return check() !== false;
  } catch {
    return false;
  }
}

/** Account moves must stay within one source provider namespace. */
export function bulkChangeAccounts(
  store: BulkStore,
  selected: readonly AgentRoute[],
  targetId: string,
  isCurrentSource: () => boolean | void,
): Promise<BulkChangeResult> {
  return bulkChange(store, selected, { kind: "account", accountId: targetId }, isCurrentSource);
}

/**
 * Provider moves allow mixed native Pi namespaces and replace explicit selected
 * pins. The server resolves the target provider's default, never a copied account.
 */
export function bulkChangeProvider(
  store: BulkStore,
  selected: readonly AgentRoute[],
  providerId: "openai" | "openai-codex",
  isCurrentSource: () => boolean | void,
): Promise<BulkChangeResult> {
  return bulkChange(store, selected, { kind: "provider", providerId }, isCurrentSource);
}

type BulkTarget =
  | { kind: "account"; accountId: string }
  | { kind: "provider"; providerId: "openai" | "openai-codex" };

/**
 * One captured store, exact local IDs, sequential fresh preflights. The caller must
 * fence its captured host/selection lifetime, including disconnect/reconnect.
 * Only Pi execution is eligible: its native switch supports an atomic idle guard.
 * Other providers cannot guarantee skip-not-queue and must not dispatch here.
 */
async function bulkChange(
  store: BulkStore,
  selected: readonly AgentRoute[],
  target: BulkTarget,
  isCurrentSource: () => boolean | void,
): Promise<BulkChangeResult> {
  const initial = store.current;
  const selections = selected.map((agent) => ({
    agentId: agent.agentId,
    accountId: agent.accountId,
    fingerprint: fingerprint(agent),
    group: initial.state ? bulkGroup(agent, initial.state) : null,
    matchesSource: initial.state?.agents.some((row) => fingerprint(row) === fingerprint(agent)) ?? false,
  }));
  const groups = new Set(selections.map((selection) => selection.group));
  const mixed = target.kind === "account" && groups.size > 1;
  const results: BulkAgentResult[] = [];
  const seen = new Set<string>();
  const add = (agentId: string, outcome: BulkAgentResult["outcome"], reason: string, summary?: ReopenSummary) => {
    results.push({ agentId, outcome, reason, ...(summary ? { summary } : {}) });
  };

  for (const selection of selections) {
    const { agentId } = selection;
    if (seen.has(agentId)) {
      add(agentId, "skipped", "Duplicate selection.");
      continue;
    }
    seen.add(agentId);
    if (mixed) {
      add(agentId, "skipped", "Mixed incompatible selections; choose one provider group.");
      continue;
    }
    if (!initial.state || initial.error || !selection.group || !selection.matchesSource) {
      add(agentId, "skipped", "Source state, selection or account unavailable; refresh and retry.");
      continue;
    }
    if (!currentSource(isCurrentSource)) {
      add(agentId, "skipped", "Source host or selection changed; refresh and retry.");
      continue;
    }
    try {
      await store.refresh({ fresh: true });
    } catch {
      add(agentId, "skipped", "Fresh source state unavailable; refresh and retry.");
      continue;
    }
    if (!currentSource(isCurrentSource)) {
      add(agentId, "skipped", "Source host or selection changed; refresh and retry.");
      continue;
    }
    const { state, error } = store.current;
    if (!state || error) {
      add(agentId, "skipped", "Fresh source state unavailable; refresh and retry.");
      continue;
    }
    const agent = state.agents.find((row) => row.agentId === agentId);
    if (!agent) {
      add(agentId, "skipped", "Agent no longer available.");
      continue;
    }
    if (fingerprint(agent) !== selection.fingerprint || bulkGroup(agent, state) !== selection.group) {
      add(agentId, "skipped", "Agent account, pin or provider changed since selection.");
      continue;
    }
    if (!eligible(agent, state)) {
      add(agentId, "skipped", "Agent lacks guarded bulk switching, is busy, pending or requires a new conversation.");
      continue;
    }
    if (target.kind === "account") {
      if (!compatibleAccounts(agent, state).some((account) => account.id === target.accountId)) {
        add(agentId, "skipped", "Target account is unavailable or incompatible.");
        continue;
      }
      if (agent.accountId === target.accountId) {
        add(agentId, "skipped", "Already using that account.");
        continue;
      }
    } else if (target.providerId !== "openai" && target.providerId !== "openai-codex") {
      add(agentId, "skipped", "Target provider is unavailable or incompatible.");
      continue;
    }
    if (!currentSource(isCurrentSource)) {
      add(agentId, "skipped", "Source host or selection changed; refresh and retry.");
      continue;
    }
    try {
      const summary = target.kind === "account"
        ? await store.rpc(setAgentAccount, { agentId, accountId: target.accountId, onlyIfIdle: true })
        : await store.rpc(setAgentProvider, {
          agentId, providerId: target.providerId, expectedAccountId: selection.accountId,
        });
      const failure = summary.failed.find((row) => row.agentId === agentId);
      if (failure) {
        add(agentId, "failed", failure.error, summary);
      } else if (summary.continuedIn) {
        add(agentId, "skipped", "Server continued in a new agent, not an in-place change.", summary);
      } else if (summary.deferred.includes(agentId)) {
        add(agentId, "skipped", "Server deferred the change after preflight; it has not moved yet.", summary);
      } else if (summary.reopened.includes(agentId)) {
        add(agentId, "changed", target.kind === "account"
          ? "Reopened on the selected account."
          : "Reopened on the selected provider's default account.", summary);
      } else {
        add(agentId, "skipped", "Server did not confirm an in-place change.", summary);
      }
    } catch (error) {
      add(agentId, "failed", error instanceof Error ? error.message : String(error));
    }
  }
  return {
    changed: results.filter((row) => row.outcome === "changed").length,
    skipped: results.filter((row) => row.outcome === "skipped").length,
    failed: results.filter((row) => row.outcome === "failed").length,
    results,
  };
}
