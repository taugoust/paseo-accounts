import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type {
	AccountView,
	AgentRoute,
	StateView,
	Usage,
} from "../shared/model";
import { createAccountControlsHandlers } from "./pi-native";
import { fetchPiQuota, readQuotaAuthData } from "./pi-quota";
import type { PiQuotaCredential, QuotaResult } from "./pi-quota";

const PREFIX = "pi-native:";
const accountId = (name: string | null) =>
	name === null
		? `${PREFIX}default`
		: `${PREFIX}profile:${encodeURIComponent(name)}`;
export const isNativePiAccount = (id: string) => id.startsWith(PREFIX);
export function refusePiManagement(id: string) {
	if (isNativePiAccount(id))
		throw new Error(
			"This control isn't supported for Pi accounts; use the Pi account manager for sign-in, rename, removal, defaults and switching.",
		);
}

type StoredProfile = {
	id: string;
	label: string;
	authKind: "oauth" | "api-key";
	isDefault: boolean;
	/** Server-only source for read-only quota queries; never copied into AccountView. */
	quotaCredential?: PiQuotaCredential;
};
type StoredProfiles = {
	profiles: StoredProfile[];
	active: string | null;
	defaultCredential?: PiQuotaCredential;
	companionCredential?: PiQuotaCredential;
	companionUsageEnabled?: boolean;
};
function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Read canonical profiles; OAuth tokens stay server-side and are never serialized to the UI. */
async function readCanonicalProfiles(): Promise<StoredProfiles> {
	const directory =
		process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	try {
		const dir = await lstat(directory);
		if (
			!dir.isDirectory() ||
			dir.isSymbolicLink() ||
			(dir.mode & 0o022) !== 0 ||
			(typeof process.getuid === "function" && dir.uid !== process.getuid())
		)
			return { profiles: [], active: null };
		const quotaAuth = await readQuotaAuthData(directory);
		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await open(
				join(directory, "pi-accounts.json"),
				constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
			);
		} catch {
			return { profiles: [], active: null, ...quotaAuth };
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
					profiles: [],
					active: null,
					...quotaAuth,
				};
			const parsed = JSON.parse(await handle.readFile("utf8"));
			const entries = parsed?.providers?.openai?.accounts;
			if (!entries || typeof entries !== "object" || Array.isArray(entries))
				return {
					profiles: [],
					active: null,
					...quotaAuth,
				};
			const active =
				typeof parsed?.providers?.openai?.active === "string"
					? parsed.providers.openai.active
					: null;
			const profiles = Object.entries(entries)
				.flatMap(([id, credential]) => {
					const value = record(credential);
					const type = value?.type;
					if (
						!/^[A-Za-z0-9._-]{1,64}$/.test(id) ||
						(type !== "oauth" && type !== "api_key")
					)
						return [];
					const storedLabel = value?.label;
					return [
						{
							id,
							label:
								typeof storedLabel === "string" && storedLabel.trim()
									? storedLabel.trim().slice(0, 40)
									: id,
							authKind:
								type === "api_key" ? ("api-key" as const) : ("oauth" as const),
							isDefault: active === id,
							quotaCredential: quotaCredential(value),
						},
					];
				})
				.sort((a, b) => a.id.localeCompare(b.id));
			return {
				profiles,
				active,
				...quotaAuth,
			};
		} finally {
			await handle.close();
		}
	} catch {
		return { profiles: [], active: null };
	}
}

/** Pi account cards are a view of the canonical pi-accounts file, not a second store. */
export class NativePiAccounts {
	private readonly controls = createAccountControlsHandlers();
	private readonly quotaCache = new Map<
		string,
		{ fingerprint: string; at: number; result: QuotaResult }
	>();

	private async quotaFor(
		id: string,
		credential: PiQuotaCredential | undefined,
		companion: PiQuotaCredential | undefined,
		companionUsageEnabled: boolean,
		refresh: boolean,
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
				]),
			)
			.digest("hex");
		const cached = this.quotaCache.get(id);
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
			companion,
			companionUsageEnabled,
		);
		this.quotaCache.set(id, { fingerprint, at: Date.now(), result });
		return result;
	}

	async view(
		base: StateView,
		context: PluginHandlerContext,
		refreshUsage = false,
	): Promise<StateView> {
		const stored = await readCanonicalProfiles();
		const canonical = stored.profiles;
		const targets: Array<{
			id: string;
			workspaceId: string;
			title: string | null;
			cwd: string;
			status: string;
		}> = [];
		let cursor: string | undefined,
			complete = false;
		for (let page = 0; page < 10; page++) {
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
					});
			if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) {
				complete = true;
				break;
			}
			cursor = result.pageInfo.nextCursor;
		}
		const routes: AgentRoute[] = [];
		const piLogins: StateView["logins"] = [];
		let cursorIndex = 0,
			unavailable = 0;
		await Promise.all(
			Array.from({ length: Math.min(6, targets.length) }, async () => {
				while (cursorIndex < targets.length) {
					const agent = targets[cursorIndex++];
					try {
						const status = await this.controls.status(
							{ agentId: agent.id, workspaceId: agent.workspaceId },
							context,
						);
						if (!status.available || !status.snapshot) {
							unavailable++;
							continue;
						}
						const snapshot = status.snapshot;
						for (const name of snapshot.pendingAccountNames ?? [])
							piLogins.push({
								id: `pi-login:${agent.id}:${name}`,
								family: "pi",
								method: "code",
								accountId: accountId(name),
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
							accountId: accountId(selected),
							pinned: selected !== null,
							pendingAccountId: null,
							movable: true,
							canSwitch: snapshot.canSwitch,
							provider: "pi",
							title: agent.title,
							cwd: agent.cwd,
							status: agent.status,
						});
						// Preserve a removed profile as a signed-out row, never as another login.
						for (const row of snapshot.accounts)
							if (row.id && !canonical.some((profile) => profile.id === row.id))
								canonical.push({
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
		canonical.sort((a, b) => a.id.localeCompare(b.id));
		const quotaById = new Map<string, QuotaResult>();
		let quotaIndex = 0;
		await Promise.all(
			Array.from({ length: Math.min(3, canonical.length) }, async () => {
				while (quotaIndex < canonical.length) {
					const profile = canonical[quotaIndex++];
					quotaById.set(
						profile.id,
						await this.quotaFor(
							profile.id,
							profile.quotaCredential,
							stored.companionCredential,
							stored.companionUsageEnabled === true,
							refreshUsage,
						),
					);
				}
			}),
		);
		const defaultQuota = await this.quotaFor(
			"pi-native:default",
			stored.defaultCredential,
			stored.companionCredential,
			stored.companionUsageEnabled === true,
			refreshUsage,
		);
		const counts = new Map<string, number>();
		for (const route of routes)
			counts.set(route.accountId, (counts.get(route.accountId) ?? 0) + 1);
		const accounts: AccountView[] = [
			{
				id: accountId(null),
				family: "pi",
				label: "Default Pi login",
				kind: "main",
				email: null,
				plan: defaultQuota.plan,
				organization: null,
				status: "ready",
				isDefault: stored.active === null,
				limitedUntil: null,
				usage: defaultQuota.usage,
				agentCount: counts.get(accountId(null)) ?? 0,
				home: null,
				priority: "normal",
				forecast: null,
				trend: [],
				folders: [],
			},
			...canonical.map((profile) => ({
				id: accountId(profile.id),
				family: "pi" as const,
				label: profile.label,
				kind: "managed" as const,
				email: null,
				plan: quotaById.get(profile.id)?.plan ?? null,
				organization: null,
				status: "ready" as const,
				isDefault: profile.isDefault,
				limitedUntil: null,
				usage: quotaById.get(profile.id)?.usage ?? null,
				agentCount: counts.get(accountId(profile.id)) ?? 0,
				home: null,
				priority: "normal" as const,
				forecast: null,
				trend: [],
				folders: [],
			})),
		];
		const warnings = [
			...base.warnings,
			"Pi account list, sign-in, rename, removal, defaults and idle-session switching use pi-accounts. Automatic Pi failover is intentionally disabled.",
		];
		if (unavailable)
			warnings.push(
				`${unavailable} Pi sessions are not connected to the live account switcher; their current selection is left unknown.`,
			);
		if (!complete)
			warnings.push(
				"Pi session discovery reached its page limit; the conversation list may be incomplete.",
			);
		return {
			...base,
			accounts: [
				...base.accounts.filter((item) => item.family !== "pi"),
				...accounts,
			],
			nextUp: {
				...base.nextUp,
				pi: stored.active ? accountId(stored.active) : accountId(null),
			},
			agents: [
				...base.agents.filter((item) => item.family !== "pi"),
				...routes,
			],
			installed: [
				...new Set([
					...base.installed.filter((family) => family !== "pi"),
					"pi" as const,
				]),
			],
			logins: [
				...base.logins.filter((login) => login.family !== "pi"),
				...piLogins,
			],
			fallbacks: base.fallbacks.filter(
				(fallback) => base.providers[fallback.id] !== "pi",
			),
			warnings,
		};
	}

	async manage(
		request: {
			operation: "add" | "cancel-login" | "rename" | "remove" | "default";
			accountId?: string;
			accountName?: string;
			label?: string;
			method?: "oauth" | "api_key";
		},
		context: PluginHandlerContext,
	) {
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
					{ agentId: agent.id, workspaceId: agent.workspaceId },
					context,
				);
				// A live session must not be using the profile. Unavailable/archived-session
				// bindings are an explicit user-confirmed risk; Pi's auth gate fails closed if stale.
				if (
					status.available &&
					status.snapshot?.currentAccountId === request.accountId
				)
					throw new Error(
						"Switch every live Pi session away from this account before removing it.",
					);
			}
		}
		return this.controls.manage(
			request as unknown as Record<string, unknown>,
			context,
		);
	}

	async switch(
		agentId: string,
		id: string | null,
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
			throw new Error(
				status.reason ?? "The selected Pi session has no live account bridge.",
			);
		let name: string | null = null;
		if (id !== null) {
			if (id === accountId(null)) name = null;
			else if (id.startsWith(`${PREFIX}profile:`))
				name = decodeURIComponent(id.slice(`${PREFIX}profile:`.length));
			else throw new Error("Choose a Pi account from the canonical list.");
			if (
				name &&
				!status.snapshot.accounts.some((account) => account.id === name)
			)
				throw new Error(
					"That Pi account is not available in the live Pi session. Refresh its account manager and retry.",
				);
		}
		const snapshot = status.snapshot;
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
				`Pi account switch failed (${result.reason}); refresh before retrying.`,
			);
		return { reopened: [agentId], deferred: [], failed: [], continuedIn: null };
	}
}
