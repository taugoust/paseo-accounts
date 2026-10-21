import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { Usage } from "../shared/model";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const MAX_RESPONSE_BYTES = 256 * 1024;

export type PiQuotaCredential =
	| {
			kind: "oauth";
			access: string;
			expires: number;
			accountId?: string;
			clientId?: string;
			scopes?: string[];
	  }
	| { kind: "api-key" };

export type QuotaAuthData = {
	defaultCredential?: PiQuotaCredential;
	companionCredential?: PiQuotaCredential;
	companionUsageEnabled: boolean;
};

export type QuotaResult = { usage: Usage | null; plan: string | null };

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function safeIdentity(value: unknown): string | undefined {
	return typeof value === "string" &&
		value.length > 0 &&
		value.length <= 512 &&
		!/([\p{Cc}\p{Cf}])/u.test(value)
		? value
		: undefined;
}

function accountIdClaim(access: string): string | undefined {
	try {
		const claims = JSON.parse(
			Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8"),
		);
		const value =
			claims?.["https://api.openai.com/auth"]?.chatgpt_account_id ??
			claims?.chatgpt_account_id;
		return safeIdentity(value);
	} catch {
		return undefined;
	}
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
	const storedAccountId = safeIdentity(credential.accountId);
	const claimedAccountId = accountIdClaim(credential.access);
	if (
		storedAccountId &&
		claimedAccountId &&
		storedAccountId !== claimedAccountId
	)
		return undefined;
	const accountId = storedAccountId ?? claimedAccountId;
	const clientId = safeIdentity(credential.clientId);
	const scopes = Array.isArray(credential.scopes)
		? credential.scopes.flatMap((scope) => {
				const valid = safeIdentity(scope);
				return valid ? [valid] : [];
			})
		: undefined;
	return {
		kind: "oauth",
		access: credential.access,
		expires: credential.expires,
		...(accountId ? { accountId } : {}),
		...(clientId ? { clientId } : {}),
		...(scopes ? { scopes } : {}),
	};
}

async function readPrivateJson(
	directory: string,
	file: "auth.json" | "pi-usage.json",
): Promise<Record<string, unknown> | undefined> {
	try {
		const settings = file === "pi-usage.json";
		const path = settings
			? await realpath(`${directory}/${file}`)
			: `${directory}/${file}`;
		const inNixStore = settings && path.startsWith("/nix/store/");
		const handle = await open(
			path,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		);
		try {
			const stat = await handle.stat();
			if (
				!stat.isFile() ||
				(typeof process.getuid === "function" &&
					stat.uid !== (inNixStore ? 0 : process.getuid())) ||
				(stat.mode & (settings ? 0o022 : 0o077)) !== 0 ||
				stat.size > 1024 * 1024
			)
				return undefined;
			return record(JSON.parse(await handle.readFile("utf8")));
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

export async function readQuotaAuthData(
	directory: string,
): Promise<QuotaAuthData> {
	const [auth, settings] = await Promise.all([
		readPrivateJson(directory, "auth.json"),
		readPrivateJson(directory, "pi-usage.json"),
	]);
	return {
		defaultCredential: quotaCredential(auth?.openai, true),
		companionCredential: quotaCredential(auth?.["openai-codex"], true),
		companionUsageEnabled: settings?.openaiUseCodexUsage === true,
	};
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

function quotaText(value: unknown, fallback: string): string {
	return safeIdentity(value)?.trim() || fallback;
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

async function chatgptJson(
	access: string,
	accountId: string,
	path = "",
): Promise<Record<string, unknown>> {
	const response = await fetch(`${USAGE_URL}${path}`, {
		headers: {
			Authorization: `Bearer ${access}`,
			"ChatGPT-Account-Id": accountId,
			Accept: "application/json",
			"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
		},
		redirect: "error",
		signal: AbortSignal.timeout(8_000),
	});
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new Error(
			response.status === 401 || response.status === 403
				? "auth-rejected"
				: "quota-unavailable",
		);
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("quota-response-missing");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.length;
			if (size > MAX_RESPONSE_BYTES)
				throw new Error("quota-response-too-large");
			chunks.push(chunk.value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const result = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	if (!result) throw new Error("quota-response-invalid");
	return result;
}

function mapQuota(body: Record<string, unknown>): QuotaResult {
	const rate = record(body.rate_limit);
	const windows: Usage["windows"] = [];
	for (const [slot, fallback] of [
		["primary_window", "Primary"],
		["secondary_window", "Secondary"],
	] as const) {
		const source = rate?.[slot];
		const mapped = usageWindow(source, slot, windowLabel(source, fallback));
		if (mapped) windows.push(mapped);
	}
	const additional = Array.isArray(body.additional_rate_limits)
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
			typeof body.plan_type === "string"
				? quotaText(body.plan_type, "ChatGPT")
				: null,
	};
}

async function fetchCompanionQuota(
	native: Extract<PiQuotaCredential, { kind: "oauth" }>,
	companion: Extract<PiQuotaCredential, { kind: "oauth" }>,
	nativeAccountId: string,
): Promise<QuotaResult> {
	const companionClaim = accountIdFromAccess(companion.access);
	if (
		companion.accountId &&
		companionClaim &&
		companion.accountId !== companionClaim
	)
		return {
			usage: usageError(
				"OpenAI and Codex logins do not match; quota was not attributed.",
			),
			plan: null,
		};
	const companionAccountId = companion.accountId ?? companionClaim;
	if (!companionAccountId || companionAccountId !== nativeAccountId)
		return {
			usage: usageError(
				"OpenAI and Codex logins do not match; quota was not attributed.",
			),
			plan: null,
		};
	if (!native.clientId || !native.scopes?.includes("chatgpt.tokens.use.direct"))
		return {
			usage: usageError(
				"This Pi profile has no verified native usage registration.",
			),
			plan: null,
		};
	const apps = await chatgptJson(
		companion.access,
		companionAccountId,
		"/chatpass/apps",
	);
	const items = apps.items;
	if (
		Object.keys(apps).some(
			(key) => !["items", "has_more", "next_cursor"].includes(key),
		) ||
		!Array.isArray(items) ||
		items.length > 128 ||
		(apps.has_more !== undefined && apps.has_more !== false) ||
		(apps.next_cursor !== undefined &&
			apps.next_cursor !== null &&
			apps.next_cursor !== "")
	)
		return {
			usage: usageError("The Codex companion app list is incomplete."),
			plan: null,
		};
	const parsedApps = items.map(record);
	if (
		parsedApps.some(
			(app) => !app || typeof app.id !== "string" || !app.id.trim(),
		)
	)
		return {
			usage: usageError("The Codex companion app list is invalid."),
			plan: null,
		};
	const matching = parsedApps.filter((app) => app?.id === native.clientId);
	if (
		matching.length !== 1 ||
		!Array.isArray(matching[0]?.windows) ||
		matching[0].windows.length === 0 ||
		matching[0].windows.length > 32
	)
		return {
			usage: usageError(
				"The Pi profile was not uniquely matched to a Codex companion app.",
			),
			plan: null,
		};
	return mapQuota(await chatgptJson(companion.access, companionAccountId));
}

function accountIdFromAccess(access: string): string | undefined {
	try {
		const claims = JSON.parse(
			Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8"),
		);
		return safeIdentity(
			claims?.["https://api.openai.com/auth"]?.chatgpt_account_id ??
				claims?.chatgpt_account_id,
		);
	} catch {
		return undefined;
	}
}

export async function fetchPiQuota(
	credential: PiQuotaCredential | undefined,
	companionCredential?: PiQuotaCredential,
	companionUsageEnabled = false,
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
	const accountId =
		credential.accountId ?? accountIdFromAccess(credential.access);
	if (!accountId)
		return {
			usage: usageError(
				"ChatGPT account identity is unavailable for this profile.",
			),
			plan: null,
		};
	try {
		if (
			credential.clientId &&
			credential.scopes?.includes("chatgpt.tokens.use.direct")
		) {
			if (!companionUsageEnabled)
				return {
					usage: usageError("Codex companion usage is disabled in Pi."),
					plan: null,
				};
			if (
				!companionCredential ||
				companionCredential.kind !== "oauth" ||
				companionCredential.expires <= Date.now()
			)
				return {
					usage: usageError(
						"A matching OpenAI Codex companion login is unavailable.",
					),
					plan: null,
				};
			return await fetchCompanionQuota(
				credential,
				companionCredential,
				accountId,
			);
		}
		return mapQuota(await chatgptJson(credential.access, accountId));
	} catch (error) {
		return {
			usage: usageError(
				error instanceof Error && error.message === "auth-rejected"
					? "OpenAI rejected this saved login; sign in again in Pi."
					: "OpenAI quota is temporarily unavailable.",
			),
			plan: null,
		};
	}
}
