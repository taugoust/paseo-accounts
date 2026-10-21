import type { LoginMethod } from "../shared/model";
import type {
	EnvPatch,
	FamilyAdapter,
	Identity,
	LoginHandle,
	RedeemReply,
	UsageRead,
} from "./adapter";
import {
	detectApiStyleLimit,
	detectClaudeLimit,
	detectKimiSignOut,
} from "./limits";

const unsupportedManagement =
	"Pi account creation and credential management are not supported here. Use /accounts in the Pi terminal.";

export class PiAdapter implements FamilyAdapter {
	readonly family = "pi" as const;
	/** Pi sessions can switch only when its live account-controls snapshot says so. */
	readonly portable = true;
	readonly usageSpacingMs = 60_000;

	async env(_home: string | null): Promise<EnvPatch> {
		// Pi's native account manager owns provider credentials and active selection.
		return {};
	}

	async available(): Promise<{ ok: boolean; detail: string | null }> {
		// Exclude Pi from the legacy registry/routing path; native per-agent controls are separate.
		return {
			ok: false,
			detail: "Pi accounts are managed in the Pi terminal with /accounts.",
		};
	}

	async prepareHome(_home: string): Promise<void> {
		throw new Error(unsupportedManagement);
	}

	async identity(_home: string | null): Promise<Identity> {
		return {
			signedIn: false,
			email: null,
			plan: null,
			organization: null,
			identity: null,
		};
	}

	async usage(): Promise<UsageRead> {
		return {
			fetchedAt: new Date().toISOString(),
			windows: [],
			error:
				"Pi usage is available through the existing context usage integration, not this legacy adapter.",
			cached: false,
			resets: null,
		};
	}

	async redeemReset(): Promise<RedeemReply> {
		return { outcome: "none", message: "Pi has no banked resets.", left: null };
	}

	async login(
		_home: string | null,
		_method: LoginMethod,
	): Promise<LoginHandle> {
		throw new Error(unsupportedManagement);
	}
	async logout(_home: string | null): Promise<void> {
		throw new Error(unsupportedManagement);
	}

	detectLimit = (event: Parameters<FamilyAdapter["detectLimit"]>[0]) =>
		detectClaudeLimit(event) ?? detectApiStyleLimit(event);
	detectSignOut = detectKimiSignOut;
}
