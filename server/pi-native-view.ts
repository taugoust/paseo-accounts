import { createHash, randomUUID } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AccountView, AgentRoute, StateView } from "../shared/model";
import { createAccountControlsHandlers } from "./pi-native";

const PREFIX = "pi-native:";
export const isNativePiAccount = (id: string) => id.startsWith(PREFIX);
export function refusePiManagement(id: string) {
	if (isNativePiAccount(id))
		throw new Error(
			"Pi account management still uses /accounts in Pi. This first integration supports listing and live session switching only.",
		);
}

/** A projection of live pi-accounts state, never a second account/credential store. */
export class NativePiAccounts {
	private readonly controls = createAccountControlsHandlers();

	private scope(
		agentId: string,
		status: Awaited<ReturnType<typeof this.controls.status>>,
	) {
		const snapshot = status.snapshot!;
		const binding = createHash("sha256")
			.update(
				JSON.stringify([
					status.sessionId,
					status.runtimeEpoch,
					snapshot.serviceEpoch,
					snapshot.selectionRevision,
				]),
			)
			.digest("hex")
			.slice(0, 24);
		return `${PREFIX}${agentId}:${binding}:`;
	}

	async view(
		base: StateView,
		context: PluginHandlerContext,
	): Promise<StateView> {
		const targets: Array<{
			id: string;
			workspaceId: string;
			title: string | null;
			cwd: string;
			status: string;
		}> = [];
		let cursor: string | undefined;
		let complete = false;
		for (let page = 0; page < 10; page++) {
			const result = await context.paseo.agents.list({
				page: { limit: 200, ...(cursor ? { cursor } : {}) },
			});
			for (const { agent } of result.entries) {
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
					});
			}
			if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) {
				complete = true;
				break;
			}
			cursor = result.pageInfo.nextCursor;
		}
		const accounts: AccountView[] = [];
		const agents: AgentRoute[] = [];
		let index = 0;
		let unavailable = 0;
		await Promise.all(
			Array.from({ length: Math.min(6, targets.length) }, async () => {
				while (index < targets.length) {
					const agent = targets[index++];
					let status;
					try {
						status = await this.controls.status(
							{ agentId: agent.id, workspaceId: agent.workspaceId },
							context,
						);
					} catch {
						unavailable++;
						continue;
					}
					if (!status.available || !status.snapshot) {
						unavailable++;
						continue;
					}
					const snapshot = status.snapshot;
					const scope = this.scope(agent.id, status);
					const idFor = (name: string | null) =>
						scope + (name === null ? "~default" : encodeURIComponent(name));
					// Scope cards to the live session: old bridge snapshots do not identify
					// their credential store, so never merge same-named profiles by guesswork.
					const suffix =
						targets.length > 1
							? ` · ${agent.title ?? agent.id.slice(0, 8)}`
							: "";
					const add = (name: string | null, label: string, missing = false) => {
						accounts.push({
							id: idFor(name),
							family: "pi",
							label: label + suffix,
							kind: name === null ? "main" : "managed",
							ownerAgentId: agent.id,
							email: null,
							plan: null,
							organization: null,
							status: missing ? "signed_out" : "ready",
							isDefault: name === null,
							limitedUntil: null,
							usage: null,
							agentCount: snapshot.currentAccountId === name ? 1 : 0,
							home: null,
							priority: "normal",
							forecast: null,
							trend: [],
							folders: [],
						});
					};
					add(null, "Default Pi login");
					for (const account of snapshot.accounts)
						add(account.id, account.label);
					if (
						snapshot.currentAccountId &&
						!snapshot.accounts.some(
							(account) => account.id === snapshot.currentAccountId,
						)
					)
						add(snapshot.currentAccountId, snapshot.currentAccountId, true);
					agents.push({
						agentId: agent.id,
						family: "pi",
						accountId: idFor(snapshot.currentAccountId),
						pinned: snapshot.currentAccountId !== null,
						pendingAccountId: null,
						movable: true,
						canSwitch: snapshot.canSwitch,
						provider: "pi",
						title: agent.title,
						cwd: agent.cwd,
						status: agent.status,
					});
				}
			}),
		);
		accounts.sort((a, b) => a.id.localeCompare(b.id));
		agents.sort((a, b) => a.agentId.localeCompare(b.agentId));
		const warnings = [
			...base.warnings,
			"Pi accounts are read from live Pi sessions. Add, sign in, rename and remove through /accounts in Pi for now; automatic Pi routing and failover are disabled.",
		];
		if (unavailable)
			warnings.push(
				`${unavailable} Pi sessions have no available account bridge; their account is not guessed.`,
			);
		if (!complete)
			warnings.push(
				"Pi session discovery reached its page limit; this is a partial list.",
			);
		return {
			...base,
			accounts: [
				...base.accounts.filter((a) => a.family !== "pi"),
				...accounts,
			],
			agents: [...base.agents.filter((a) => a.family !== "pi"), ...agents],
			installed: base.installed.filter((family) => family !== "pi"),
			fallbacks: base.fallbacks.filter(
				(provider) =>
					provider.id !== "pi" && base.providers[provider.id] !== "pi",
			),
			logins: base.logins.filter((login) => login.family !== "pi"),
			nextUp: Object.fromEntries(
				Object.entries(base.nextUp).filter(
					([provider]) => base.providers[provider] !== "pi",
				),
			),
			warnings,
		};
	}

	async switch(
		agentId: string,
		accountId: string | null,
		context: PluginHandlerContext,
	) {
		const current = (await context.paseo.agents.ref(agentId).refresh())?.agent;
		if (
			!current ||
			current.provider !== "pi" ||
			!current.workspaceId ||
			current.archivedAt
		)
			throw new Error("The selected Pi conversation is no longer available.");
		const status = await this.controls.status(
			{ agentId, workspaceId: current.workspaceId },
			context,
		);
		if (!status.available || !status.snapshot)
			throw new Error(status.reason ?? "Pi account bridge unavailable.");
		const snapshot = status.snapshot;
		const scope = this.scope(agentId, status);
		let name: string | null = null;
		if (accountId !== null) {
			if (!accountId.startsWith(scope))
				throw new Error(
					"Pi session or account selection changed. Refresh before switching.",
				);
			const encoded = accountId.slice(scope.length);
			name = encoded === "~default" ? null : decodeURIComponent(encoded);
			if (
				name !== null &&
				!snapshot.accounts.some((account) => account.id === name)
			)
				throw new Error("That Pi account is no longer available.");
		}
		if (!snapshot.canSwitch)
			throw new Error("Wait until Pi is idle before changing its account.");
		const result = await this.controls.switch(
			{
				agentId,
				workspaceId: current.workspaceId,
				expectedSessionId: status.sessionId!,
				expectedRuntimeEpoch: status.runtimeEpoch!,
				request: {
					protocol: 1,
					requestId: randomUUID(),
					expectedSessionId: snapshot.sessionId,
					expectedServiceEpoch: snapshot.serviceEpoch,
					expectedSelectionRevision: snapshot.selectionRevision,
					accountId: name,
				},
			},
			context,
		);
		if (result.ok !== true)
			throw new Error(
				`Pi account switch did not complete: ${String(result.reason ?? "unavailable")}. Refresh before retrying.`,
			);
		// This field is the upstream UI's applied-switch counter; no reload occurs.
		return { reopened: [agentId], deferred: [], failed: [], continuedIn: null };
	}
}
