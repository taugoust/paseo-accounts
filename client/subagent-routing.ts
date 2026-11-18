import type {
	PluginButtonMenuEntry,
	PluginClientContext,
} from "@getpaseo/plugin/client";
import {
	subagentRoutingSetRpc,
	subagentRoutingStatusRpc,
	type SubagentRoutingSnapshot,
	type SubagentRoutingStatus,
} from "../shared/pi-native";

type Agent = { id: string; workspaceId: string; provider: string };
interface Routing {
	agent: Agent;
	status: SubagentRoutingStatus | null;
	busy: boolean;
	fetching: boolean;
	fetchedAt: number;
	generation: number;
	select(selection: SubagentRoutingSnapshot["selection"]): Promise<void>;
}

/** Refresh with the account poller without making status reads trigger another account poll. */
export function createSubagentRouting(client: PluginClientContext, changed: () => void) {
	const sessions = new Map<string, Routing>();
	let stopped = false;
	const current = (routing: Routing) => !stopped && sessions.get(routing.agent.id) === routing;
	async function refresh(routing: Routing) {
		const generation = ++routing.generation;
		const latest = () => current(routing) && generation === routing.generation;
		routing.fetching = true;
		try {
			const status = await client.rpc(subagentRoutingStatusRpc, {
				agentId: routing.agent.id,
				workspaceId: routing.agent.workspaceId,
			});
			if (latest()) routing.status = status;
		} catch {
			if (latest()) routing.status = null;
		} finally {
			if (latest()) {
				routing.fetching = false;
				routing.fetchedAt = Date.now();
				changed();
			}
		}
	}
	return {
		get: (agentId: string) => sessions.get(agentId),
		sync(agents: Iterable<Agent>) {
			const active = new Map([...agents].filter(agent => agent.provider === "pi").map(agent => [agent.id, agent]));
			for (const [id, routing] of sessions) {
				if (active.get(id)?.workspaceId !== routing.agent.workspaceId) sessions.delete(id);
			}
			for (const agent of active.values()) {
				let routing = sessions.get(agent.id);
				if (!routing) {
					const entry: Routing = {
						agent, status: null, busy: false, fetching: false, fetchedAt: 0, generation: 0,
						async select(selection) {
							const status = entry.status;
							if (!current(entry) || entry.busy || !status?.available || !status.snapshot || !status.runtimeEpoch) return;
							entry.busy = true;
							changed();
							try {
								await client.rpc(subagentRoutingSetRpc, {
									agentId: agent.id, workspaceId: agent.workspaceId,
									expectedRuntimeEpoch: status.runtimeEpoch,
									request: {
										expectedSessionId: status.snapshot.sessionId,
										expectedServiceEpoch: status.snapshot.serviceEpoch,
										expectedRevision: status.snapshot.revision, selection,
									},
								});
							} catch {
								throw new Error("Subagent choice could not be saved. Try again.");
							} finally {
								await refresh(entry);
								entry.busy = false;
								if (current(entry)) changed();
							}
						},
					};
					sessions.set(agent.id, entry);
					routing = entry;
				}
				if (!routing.fetching && !routing.busy && Date.now() - routing.fetchedAt >= 15_000) void refresh(routing);
			}
		},
		stop() { stopped = true; sessions.clear(); },
	};
}

/** The pill shows one provider name, or Mixed when subagents run on a different provider than the session. */
export function pillProviderName(sessionName: string, routing?: Routing): string {
	const selection = routing?.status?.snapshot?.selection;
	if (!selection) return sessionName;
	return providerName(selection.providerId) === sessionName ? sessionName : "Mixed";
}

function providerName(providerId: string): string {
	return providerId === "claude-bridge" ? "Claude" : providerId === "openai-codex" ? "Codex" : providerId;
}

export function subagentSuffix(routing?: Routing, compact = false): string {
	const selection = routing?.status?.snapshot?.selection;
	if (!selection) return "";
	const provider = providerName(selection.providerId);
	const account = routing?.status?.codexAccounts.find(account => account.id === selection.accountId);
	return ` · Subagents ${provider}${!compact && selection.accountId ? ` (${account?.label ?? selection.accountId})` : ""}`;
}

/** Names of the accounts each provider's default login uses, when known. */
export interface DefaultLogins { claude?: string; codex?: string }

/** sessionTitle names the account the session runs on, which subagents use when they follow it. */
export function subagentMenu(routing?: Routing, sessionTitle = "Same as session", defaults: DefaultLogins = {}): PluginButtonMenuEntry[] {
	const status = routing?.status;
	if (!routing || !status?.available || !status.snapshot) return [];
	const active = status.snapshot.selection;
	const choices = [
		{ id: "follow", title: sessionTitle, selection: null },
		...(status.providers.includes("claude-bridge") ? [{ id: "claude", title: `Claude (${defaults.claude ?? "default login"})`, selection: { providerId: "claude-bridge", accountId: null } }] : []),
		...(status.providers.includes("openai-codex") ? [
			{ id: "codex", title: `Codex (${defaults.codex ?? "default login"})`, selection: { providerId: "openai-codex", accountId: null } },
			...status.codexAccounts.map(account => ({ id: `codex-${account.id}`, title: `Codex (${account.label})`, selection: { providerId: "openai-codex", accountId: account.id } })),
		] : []),
	];
	// A removed login is still the saved route until the user chooses another one.
	if (active?.providerId === "openai-codex" && active.accountId && !choices.some(choice => choice.selection?.providerId === active.providerId && choice.selection.accountId === active.accountId)) {
		choices.push({ id: "saved", title: `Codex (${active.accountId})`, selection: { providerId: active.providerId, accountId: active.accountId } });
	}
	// Several choices can name the same account, such as a default login and the session's own.
	// Show each name once, keeping the saved choice so its check stays visible.
	const isActive = (choice: typeof choices[number]) =>
		(active?.providerId ?? null) === (choice.selection?.providerId ?? null) && (active?.accountId ?? null) === (choice.selection?.accountId ?? null);
	const shown = choices.filter((choice, index) => {
		const twin = choices.findIndex(other => other.title === choice.title);
		const activeTwin = choices.find(other => other.title === choice.title && isActive(other));
		return activeTwin ? activeTwin === choice : twin === index;
	});
	return [
		{ kind: "separator", id: "subagents-divider" },
		{ kind: "item", id: "subagents-heading", title: "Subagents", disabled: true, behavior: { kind: "action", onPress() {} } },
		...shown.map(choice => {
			const selected = (active?.providerId ?? null) === (choice.selection?.providerId ?? null) && (active?.accountId ?? null) === (choice.selection?.accountId ?? null);
			return {
				kind: "item" as const, id: `subagent-${choice.id}`, title: choice.title,
				icon: selected ? "CircleCheck" : "Circle",
				disabled: routing.busy || selected,
				behavior: { kind: "action" as const, onPress: () => routing.select(choice.selection) },
			};
		}),
	];
}
