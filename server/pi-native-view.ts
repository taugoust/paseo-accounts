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

type PiQuotaCredential =
	| { kind: "oauth"; access: string; expires: number; accountId?: string }
	| { kind: "api-key" };
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
};
type QuotaResult = { usage: Usage | null; plan: string | null };
const MAX_QUOTA_RESPONSE_BYTES = 256 * 1024;
const QUOTA_CACHE_MS = 60_000;

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function accountIdClaim(access: string): string | undefined {
	try {
		const claims = JSON.parse(
			Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8"),
		);
		const value = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof value === "string" &&
			value.length > 0 &&
			value.length <= 256 &&
			!/[\p{Cc}\p{Cf}]/u.test(value)
			? value
			: undefined;
	} catch {
		return undefined;
	}
}

function safeQuotaAccountId(value: unknown): string | undefined {
	return typeof value === "string" &&
		value.length > 0 &&
		value.length <= 256 &&
		!/[\p{Cc}\p{Cf}]/u.test(value)
		? value
		: undefined;
}

function quotaCredential(
	value: unknown,
	allowDefaultAuthTypeOmission = false,
): PiQuotaCredential | undefined {
	const credential = record(value);
	if (credential?.type === "api_key") return { kind: "api-key" };
	if (
		(credential?.type !== "oauth" &&
			!(allowDefaultAuthTypeOmission && credential?.type === undefined)) ||
		typeof credential.access !== "string" ||
		credential.access.length === 0 ||
		credential.access.length > 65_536 ||
		typeof credential.expires !== "number" ||
		!Number.isFinite(credential.expires)
	)
		return undefined;
	const accountId =
		safeQuotaAccountId(credential.accountId) ??
		accountIdClaim(credential.access);
	return {
		kind: "oauth",
		access: credential.access,
		expires: credential.expires,
		...(accountId ? { accountId } : {}),
	};
}

function quotaText(value: unknown, fallback: string): string {
	return typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= 128 &&
		!/[\p{Cc}\p{Cf}]/u.test(value)
		? value.trim()
		: fallback;
}

function usageError(message: string): Usage {
	return {
		fetchedAt: new Date().toISOString(),
		windows: [],
		error: message,
		cached: false,
		resets: null,
	};
}

function usageWindow(
	value: unknown,
	id: string,
	label: string,
): Usage["windows"][number] | null {
	const row = record(value);
	const usedPercent = row?.used_percent;
	const resetAt = row?.reset_at;
	if (
		typeof usedPercent !== "number" ||
		!Number.isFinite(usedPercent) ||
		usedPercent < 0 ||
		usedPercent > 100
	)
		return null;
	return {
		id,
		label,
		usedPercent,
		resetsAt:
			typeof resetAt === "number" &&
			Number.isFinite(resetAt) &&
			resetAt >= 0 &&
			resetAt <= 8_640_000_000_000
				? new Date(resetAt * 1000).toISOString()
				: null,
	};
}

function windowLabel(value: unknown, fallback: string): string {
	const duration = record(value)?.limit_window_seconds;
	if (
		typeof duration !== "number" ||
		!Number.isSafeInteger(duration) ||
		duration <= 0
	)
		return fallback;
	if (duration === 604800) return "7-day";
	if (duration % 86400 === 0) return `${duration / 86400}-day`;
	if (duration % 3600 === 0) return `${duration / 3600}-hour`;
	return fallback;
}

async function readDefaultQuotaCredential(
	directory: string,
): Promise<PiQuotaCredential | undefined> {
	try {
		const handle = await open(
			join(directory, "auth.json"),
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		);
		try {
			const stat = await handle.stat();
			if (
				!stat.isFile() ||
				(typeof process.getuid === "function" &&
					stat.uid !== process.getuid()) ||
				(stat.mode & 0o777) !== 0o600 ||
				stat.size > 2 * 1024 * 1024
			)
				return undefined;
			const parsed = JSON.parse(await handle.readFile("utf8"));
			return quotaCredential(record(parsed)?.openai, true);
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

async function fetchPiQuota(
	credential: PiQuotaCredential | undefined,
): Promise<QuotaResult> {
	if (!credential) return { usage: null, plan: null };
	if (credential.kind === "api-key")
		return {
			usage: usageError(
				"OpenAI does not expose ChatGPT quota windows for API-key profiles.",
			),
			plan: null,
		};
	if (credential.expires <= Date.now())
		return {
			usage: usageError(
				"ChatGPT login expired; sign in again in Pi to refresh quota.",
			),
			plan: null,
		};
	if (!credential.accountId)
		return {
			usage: usageError(
				"ChatGPT account identity is unavailable for this profile.",
			),
			plan: null,
		};
	try {
		const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
			headers: {
				Authorization: `Bearer ${credential.access}`,
				"ChatGPT-Account-Id": credential.accountId,
				Accept: "application/json",
				"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
			},
			redirect: "error",
			signal: AbortSignal.timeout(8_000),
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			return {
				usage: usageError(
					response.status === 401 || response.status === 403
						? "ChatGPT rejected this saved login; sign in again in Pi."
						: "OpenAI quota is temporarily unavailable.",
				),
				plan: null,
			};
		}
		const reader = response.body?.getReader();
		if (!reader)
			return {
				usage: usageError("OpenAI returned no quota data."),
				plan: null,
			};
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				size += chunk.value.length;
				if (size > MAX_QUOTA_RESPONSE_BYTES)
					throw new Error("quota response too large");
				chunks.push(chunk.value);
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
		const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
		const rate = record(body?.rate_limit);
		const windows: Usage["windows"] = [];
		for (const [slot, fallback] of [
			["primary_window", "Primary"],
			["secondary_window", "Secondary"],
		] as const) {
			const source = rate?.[slot];
			const mapped = usageWindow(source, slot, windowLabel(source, fallback));
			if (mapped) windows.push(mapped);
		}
		const additional = Array.isArray(body?.additional_rate_limits)
			? body.additional_rate_limits.slice(0, 100)
			: [];
		for (const [index, item] of additional.entries()) {
			const row = record(item);
			const identity = quotaText(
				row?.limit_name ?? row?.metered_feature,
				`Additional ${index + 1}`,
			);
			const limits = record(row?.rate_limit);
			for (const [slot, fallback] of [
				["primary_window", "Primary"],
				["secondary_window", "Secondary"],
			] as const) {
				const source = limits?.[slot];
				const mapped = usageWindow(
					source,
					`additional:${index}:${slot}`,
					`${identity} · ${windowLabel(source, fallback)}`,
				);
				if (mapped) windows.push(mapped);
			}
		}
		if (!windows.length)
			return {
				usage: usageError(
					"The selected ChatGPT profile returned no quota windows.",
				),
				plan: null,
			};
		return {
			usage: {
				fetchedAt: new Date().toISOString(),
				windows,
				error: null,
				cached: false,
				resets: null,
			},
			plan:
				typeof body?.plan_type === "string"
					? quotaText(body.plan_type, "ChatGPT")
					: null,
		};
	} catch {
		return {
			usage: usageError("OpenAI quota is temporarily unavailable."),
			plan: null,
		};
	}
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
		const defaultCredential = await readDefaultQuotaCredential(directory);
		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await open(
				join(directory, "pi-accounts.json"),
				constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
			);
		} catch {
			return {
				profiles: [],
				active: null,
				...(defaultCredential ? { defaultCredential } : {}),
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
					profiles: [],
					active: null,
					...(defaultCredential ? { defaultCredential } : {}),
				};
			const parsed = JSON.parse(await handle.readFile("utf8"));
			const entries = parsed?.providers?.openai?.accounts;
			if (!entries || typeof entries !== "object" || Array.isArray(entries))
				return {
					profiles: [],
					active: null,
					...(defaultCredential ? { defaultCredential } : {}),
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
				...(defaultCredential ? { defaultCredential } : {}),
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
		refresh: boolean,
	): Promise<QuotaResult> {
		if (!credential) return { usage: null, plan: null };
		const fingerprint =
			credential.kind === "oauth"
				? createHash("sha256")
						.update(credential.access)
						.update("\\0")
						.update(credential.accountId ?? "")
						.digest("hex")
				: "api-key";
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
		const result = await fetchPiQuota(credential);
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
							refreshUsage,
						),
					);
				}
			}),
		);
		const defaultQuota = await this.quotaFor(
			"pi-native:default",
			stored.defaultCredential,
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
