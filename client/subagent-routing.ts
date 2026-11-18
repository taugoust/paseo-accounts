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
type Selection = SubagentRoutingSnapshot["selection"];

interface Routing {
	agent: Agent;
	status: SubagentRoutingStatus | null;
	busy: boolean;
	fetching: boolean;
	fetchedAt: number;
	/** Bumped on every refresh, so a slow older reply can't overwrite a newer one. */
	generation: number;
	select(selection: Selection): Promise<void>;
}

const REFRESH_AFTER_MS = 15_000;
const CLAUDE = "claude-bridge";
const CODEX = "openai-codex";

/**
 * Keeps the subagent routing status of each Pi agent. sync() is called by the
 * account poller, and changed() redraws the pills.
 */
export function createSubagentRouting(
	client: PluginClientContext,
	changed: () => void,
) {
	const sessions = new Map<string, Routing>();
	let stopped = false;
	const current = (routing: Routing) =>
		!stopped && sessions.get(routing.agent.id) === routing;

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

	async function select(routing: Routing, selection: Selection) {
		const status = routing.status;
		const snapshot = status?.snapshot;
		const ready =
			current(routing) &&
			!routing.busy &&
			status?.available &&
			snapshot &&
			status.runtimeEpoch;
		if (!ready) return;

		routing.busy = true;
		changed();
		try {
			await client.rpc(subagentRoutingSetRpc, {
				agentId: routing.agent.id,
				workspaceId: routing.agent.workspaceId,
				expectedRuntimeEpoch: status.runtimeEpoch!,
				request: {
					expectedSessionId: snapshot.sessionId,
					expectedServiceEpoch: snapshot.serviceEpoch,
					expectedRevision: snapshot.revision,
					selection,
				},
			});
		} catch {
			throw new Error("Subagent choice could not be saved. Try again.");
		} finally {
			// Show what Pi actually saved, whether the change went through or not.
			await refresh(routing);
			routing.busy = false;
			if (current(routing)) changed();
		}
	}

	function track(agent: Agent): Routing {
		const routing: Routing = {
			agent,
			status: null,
			busy: false,
			fetching: false,
			fetchedAt: 0,
			generation: 0,
			select: (selection) => select(routing, selection),
		};
		sessions.set(agent.id, routing);
		return routing;
	}

	return {
		get: (agentId: string) => sessions.get(agentId),

		sync(agents: Iterable<Agent>) {
			const piAgents = new Map<string, Agent>();
			for (const agent of agents) {
				if (agent.provider === "pi") piAgents.set(agent.id, agent);
			}
			// Forget agents that are gone or moved to another workspace.
			for (const [id, routing] of sessions) {
				if (piAgents.get(id)?.workspaceId !== routing.agent.workspaceId) {
					sessions.delete(id);
				}
			}
			for (const agent of piAgents.values()) {
				const routing = sessions.get(agent.id) ?? track(agent);
				const stale = Date.now() - routing.fetchedAt >= REFRESH_AFTER_MS;
				if (!routing.fetching && !routing.busy && stale) void refresh(routing);
			}
		},

		stop() {
			stopped = true;
			sessions.clear();
		},
	};
}

function providerName(providerId: string): string {
	if (providerId === CLAUDE) return "Claude";
	if (providerId === CODEX) return "Codex";
	return providerId;
}

/**
 * The provider shown on the pill. It is the session's provider while subagents
 * use it too, and Mixed when they run on another one.
 */
export function pillProviderName(sessionName: string, routing?: Routing): string {
	const selection = routing?.status?.snapshot?.selection;
	if (!selection) return sessionName;
	return providerName(selection.providerId) === sessionName ? sessionName : "Mixed";
}

/** Added to the pill's title, so hovering shows where subagents run. */
export function subagentSuffix(routing?: Routing): string {
	const selection = routing?.status?.snapshot?.selection;
	if (!selection) return "";
	const provider = providerName(selection.providerId);
	if (!selection.accountId) return ` · Subagents ${provider}`;
	const accounts = routing?.status?.codexAccounts ?? [];
	const account = accounts.find((entry) => entry.id === selection.accountId);
	return ` · Subagents ${provider} (${account?.label ?? selection.accountId})`;
}

/** Names of the accounts each provider's default login uses, when known. */
export interface DefaultLogins {
	claude?: string;
	codex?: string;
}

interface Choice {
	id: string;
	title: string;
	selection: Selection;
}

function sameSelection(a: Selection, b: Selection): boolean {
	return (
		(a?.providerId ?? null) === (b?.providerId ?? null) &&
		(a?.accountId ?? null) === (b?.accountId ?? null)
	);
}

function routingChoices(
	status: SubagentRoutingStatus,
	sessionTitle: string,
	defaults: DefaultLogins,
): Choice[] {
	const choices: Choice[] = [{ id: "follow", title: sessionTitle, selection: null }];
	if (status.providers.includes(CLAUDE)) {
		choices.push({
			id: "claude",
			title: `Claude (${defaults.claude ?? "default login"})`,
			selection: { providerId: CLAUDE, accountId: null },
		});
	}
	if (status.providers.includes(CODEX)) {
		choices.push({
			id: "codex",
			title: `Codex (${defaults.codex ?? "default login"})`,
			selection: { providerId: CODEX, accountId: null },
		});
		for (const account of status.codexAccounts) {
			choices.push({
				id: `codex-${account.id}`,
				title: `Codex (${account.label})`,
				selection: { providerId: CODEX, accountId: account.id },
			});
		}
	}

	// A removed login stays the saved choice until the user picks another one.
	const active = status.snapshot?.selection ?? null;
	const listed = choices.some((choice) => sameSelection(choice.selection, active));
	if (active?.providerId === CODEX && active.accountId && !listed) {
		choices.push({ id: "saved", title: `Codex (${active.accountId})`, selection: active });
	}
	return choices;
}

/**
 * Several choices can name the same account, such as a default login and the
 * session's own. Keeps one per name, preferring the saved choice so its check
 * stays visible.
 */
function onePerName(choices: Choice[], active: Selection): Choice[] {
	return choices.filter((choice, index) => {
		const twins = choices.filter((other) => other.title === choice.title);
		const activeTwin = twins.find((other) => sameSelection(other.selection, active));
		if (activeTwin) return activeTwin === choice;
		return choices.indexOf(twins[0]!) === index;
	});
}

/**
 * The Subagents section of the pill menu.
 * sessionTitle names the session's own account, which subagents follow by default.
 */
export function subagentMenu(
	routing?: Routing,
	sessionTitle = "Same as session",
	defaults: DefaultLogins = {},
): PluginButtonMenuEntry[] {
	const status = routing?.status;
	if (!routing || !status?.available || !status.snapshot) return [];
	const active = status.snapshot.selection;
	const choices = onePerName(routingChoices(status, sessionTitle, defaults), active);

	const heading: PluginButtonMenuEntry = {
		kind: "item",
		id: "subagents-heading",
		title: "Subagents",
		disabled: true,
		behavior: { kind: "action", onPress() {} },
	};
	const items = choices.map((choice): PluginButtonMenuEntry => {
		const selected = sameSelection(choice.selection, active);
		return {
			kind: "item",
			id: `subagent-${choice.id}`,
			title: choice.title,
			icon: selected ? "CircleCheck" : "Circle",
			disabled: routing.busy || selected,
			behavior: { kind: "action", onPress: () => routing.select(choice.selection) },
		};
	});
	return [{ kind: "separator", id: "subagents-divider" }, heading, ...items];
}
